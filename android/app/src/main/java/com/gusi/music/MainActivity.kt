package com.gusi.music

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * 主界面：一个装 Web 应用的 WebView 壳。
 *
 * 壳只负责 WebView 给不了的东西：服务器地址配置、系统下载、返回键语义、
 * 后台播放保活与通知栏控制（转发给 PlaybackService）；界面本身一行都不重画 ——
 * 手机上的 UI 就是 Web 端那套 UI，改 Web 端即改 App。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var container: FrameLayout
    private lateinit var loading: View
    private lateinit var errorBox: View
    private lateinit var errorDesc: TextView
    private lateinit var web: WebView

    private var lastBackAt = 0L
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    /** 最近一次拿到的安全区（CSS px）；页面加载完/安全区变化时推给页面。 */
    private var safeInsets: Insets.Box = Insets.ZERO

    /** `document.documentElement` 是否已经存在（能受得住 evaluateJavascript）。 */
    private var pageReady = false

    private val setupLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (prefs.configured) loadPage() else showError(getString(R.string.setup_no_server))
        }

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                Toast.makeText(this, R.string.notif_no_permission, Toast.LENGTH_LONG).show()
            }
        }

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileChooserCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
            fileChooserCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 沉浸式：让页面自己画到状态栏/导航栏底下。
        // Web 端整篇布局早就按安全区排好了版（顶栏、底栏胶囊、歌词全屏都留了位置），
        // 但壳一直没开 edge-to-edge —— 那些安全区恒为 0，等于白设计。这里把它接上。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        applyEdgeToEdgeBars()

        setContentView(R.layout.activity_main)
        attachInsetsListener(findViewById(R.id.root))

        prefs = Prefs(this)
        container = findViewById(R.id.web_container)
        loading = findViewById(R.id.loading)
        errorBox = findViewById(R.id.error_box)
        errorDesc = findViewById(R.id.error_desc)

        findViewById<Button>(R.id.btn_retry).setOnClickListener { loadPage() }
        findViewById<Button>(R.id.btn_change).setOnClickListener { openSetup() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBackKey()
        })

        buildWebView()
        askNotificationPermission()
        // 离线播放：索引本地已下载曲目并起回环服务（没索引到东西就不起服务）
        LocalPlayback.start(this)

        if (prefs.configured) {
            loadPage()
        } else {
            openSetup()
        }
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView() {
        val view = WebView(this)
        view.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        )
        view.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        view.settings.applyWebDefaults(allowMixedContent = prefs.baseUrl.startsWith("https://"))
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        view.webViewClient = appClient
        view.webChromeClient = appChromeClient
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            DownloadHelper.enqueue(this, url, userAgent, contentDisposition, mimeType)
        }
        view.addJavascriptInterface(
            JsBridge(
                onState = { json ->
                    // 注意：回调在 WebView 的 JS 线程上
                    runOnUiThread { onPlaybackState(json) }
                },
                resolveLocal = { url -> LocalPlayback.localUrlFor(url) }
            ),
            BRIDGE_NAME
        )
        web = view
        container.addView(view)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    private val appClient = object : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            val scheme = url.scheme?.lowercase() ?: return false
            // 应用只连自己的 NAS：http/https 一律留在壳内（分享页 /s/xxx 也是同源）
            if (scheme == "http" || scheme == "https") return false
            return openExternally(url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            hideLoading()
            view.evaluateJavascript(BridgeScript.JS, null)
            // 安全区在 onCreate 之后就回调过一次了（那时页面还不存在），这里补推；
            // 渲染进程重建后同样靠这一句接上。
            pageReady = true
            pushInsets()
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError
        ) {
            if (!request.isForMainFrame) return          // 单张图片 404 不该整屏报错
            // minSdk 24 → WebResourceError#getDescription 必然可用（API 23+），无需再判版本
            val desc = error.description?.toString()
            showError(desc ?: getString(R.string.err_desc))
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // 自签证书的 NAS 很常见：把选择权交给用户，绝不静默放行
            AlertDialog.Builder(this@MainActivity)
                .setTitle(R.string.ssl_title)
                .setMessage(getString(R.string.ssl_msg, error.url ?: ""))
                .setPositiveButton(R.string.ssl_continue) { _, _ -> handler.proceed() }
                .setNegativeButton(R.string.ssl_cancel) { _, _ -> handler.cancel() }
                .setCancelable(false)
                .show()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // 返回 true = 我们自己处理；此时这个 WebView 已不可用，必须销毁重建
            Log.w(TAG, "渲染进程没了，重建 WebView")
            showError(getString(R.string.err_renderer))
            pageReady = false          // 新页面加载完之前，安全区注入没有落点
            container.removeAllViews()
            try {
                view.destroy()
            } catch (t: Throwable) {
                Log.w(TAG, "销毁旧 WebView 失败", t)
            }
            buildWebView()
            return true
        }
    }

    private val appChromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback
            return try {
                fileChooserLauncher.launch(
                    Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                )
                true
            } catch (t: Throwable) {
                fileChooserCallback = null
                false
            }
        }
    }

    // ---------------------------------------------------------------- 播放桥

    private fun onPlaybackState(json: String) {
        PlaybackService.setBaseUrl(prefs.baseUrl)
        PlaybackService.pushState(this, json)
    }

    private fun sendToWeb(cmd: String, arg: String?) {
        val js = if (arg == null) {
            "window.__gusiCmd && window.__gusiCmd('$cmd')"
        } else {
            "window.__gusiCmd && window.__gusiCmd('$cmd', $arg)"
        }
        web.evaluateJavascript(js, null)
    }

    // ---------------------------------------------------------------- 导航

    private fun handleBackKey() {
        // 先问页面：有没有开着浮层/全屏页？有就关掉，而不是退页面
        web.evaluateJavascript("(window.__gusiEscape && window.__gusiEscape()) ? 1 : 0") { result ->
            if (result == "1") return@evaluateJavascript
            if (web.canGoBack()) {
                web.goBack()
                return@evaluateJavascript
            }
            val now = System.currentTimeMillis()
            if (now - lastBackAt < 2000) {
                finish()
            } else {
                lastBackAt = now
                Toast.makeText(this, R.string.exit_hint, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun openExternally(uri: Uri): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        true
    }

    private fun openSetup() {
        setupLauncher.launch(Intent(this, SetupActivity::class.java))
    }

    private fun loadPage() {
        if (!prefs.configured) {
            showError(getString(R.string.setup_no_server))
            openSetup()
            return
        }
        showLoading()
        errorBox.visibility = View.GONE
        web.loadUrl(prefs.baseUrl + "/")
    }

    private fun showLoading() {
        loading.visibility = View.VISIBLE
        errorBox.visibility = View.GONE
    }

    private fun hideLoading() {
        loading.visibility = View.GONE
        errorBox.visibility = View.GONE
    }

    private fun showError(desc: String) {
        loading.visibility = View.GONE
        errorBox.visibility = View.VISIBLE
        errorDesc.text = getString(R.string.err_detail, desc)
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // ---------------------------------------------------------------- 生命周期

    override fun onStart() {
        super.onStart()
        // 指令入口登记在 onStart；刻意不在 onStop 摘掉 ——
        // 锁屏/切后台时通知栏按钮还得能把指令送进这个仍在跑的 WebView。
        BridgeHolder.attach { cmd, arg -> sendToWeb(cmd, arg) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    /**
     * 系统栏透明 + 图标保持浅色（深色跟随系统的壳侧一半）。
     *
     * 页面是深色的（Web 端只有深色一套主题，`GusiApp` 也把夜间模式钉死在深色），
     * 所以状态栏/导航栏图标必须浅色；再关掉系统给透明导航栏垫的那层对比底
     * （API 29+ 默认开），否则底栏胶囊下面会多一条灰边。
     */
    @Suppress("DEPRECATION")
    private fun applyEdgeToEdgeBars() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.isAppearanceLightStatusBars = false
        c.isAppearanceLightNavigationBars = false
    }

    /**
     * 安全区与键盘。
     *
     * 两件事分开处理，别混：
     *  - **安全区（状态栏/刘海/手势条）**：换算成 CSS px 注入页面（[Insets]），由 Web 端
     *    的 `--safe-*` 变量消费。为什么不指望 WebView 自己的 `env(safe-area-inset-*)`：
     *    Chromium 到 M144 才在所有 WebView 里上报，更老的恒为 0（页面就顶到时钟底下了）。
     *  - **键盘**：把根容器底边垫高。edge-to-edge 之后 `adjustResize` 不再自动改窗口高度，
     *    不自己垫的话输入框和底栏会被 IME 盖住。
     *
     * 最后返回 `CONSUMED`：inset 由壳统一分发，不再往 WebView 里传第二份。
     * 这一条有实际后果 —— M139+ 的 WebView 会自己按 ime inset 缩视觉视口，
     * 若我们同时垫高容器，键盘弹起时底栏会被顶高**两倍**键盘高度。
     */
    private fun attachInsetsListener(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val density = v.resources.displayMetrics.density
            val box = Insets.of(bars.top, bars.bottom, bars.left, bars.right, density)
            if (!box.sameAs(safeInsets)) {
                safeInsets = box
                pushInsets()
            }
            v.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
            WindowInsetsCompat.CONSUMED
        }
        // 光挂监听还不够：如果 insets 在本行之前就已经分发过一次，监听器会错过那一趟，
        // 页面就一直拿不到 safe-top（表现为顶栏被状态栏压住）。手动再要一次分发。
        ViewCompat.requestApplyInsets(root)
    }

    /**
     * 把安全区写进页面。页面还没到（首帧、渲染进程重建后）就只记着，
     * 等 `onPageFinished` 再推一次 —— 顺序反过来就丢值了。
     */
    private fun pushInsets() {
        if (!pageReady || !::web.isInitialized) return
        web.evaluateJavascript(Insets.js(safeInsets), null)
    }

    override fun onDestroy() {
        BridgeHolder.attach(null)
        LocalPlayback.stop(this)
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        container.removeAllViews()
        try {
            web.destroy()
        } catch (t: Throwable) {
            Log.w(TAG, "销毁 WebView 失败", t)
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "GusiMain"
        private const val BRIDGE_NAME = "GusiBridge"
    }
}

/** WebView 的统一设置（两处创建点共用：首次创建、渲染进程崩溃后重建）。 */
@SuppressLint("SetJavaScriptEnabled")
private fun WebSettings.applyWebDefaults(allowMixedContent: Boolean) {
    javaScriptEnabled = true
    domStorageEnabled = true          // Web 端登录态存在 localStorage
    databaseEnabled = true
    mediaPlaybackRequiresUserGesture = false   // 允许自动连播（FM 场景），否则每次都要用户点一下
    useWideViewPort = true
    loadWithOverviewMode = false
    setSupportZoom(false)
    builtInZoomControls = false
    displayZoomControls = false
    allowFileAccess = false
    allowContentAccess = false
    // 离线播放要用 http://127.0.0.1 喂音频；页面若是 https，Chromium 会把这段明文媒体当混合内容。
    // 只在「页面本身是 https」时放宽（那时才可能被拦），且服务端只绑回环地址、只能取已下载文件。
    mixedContentMode = if (allowMixedContent) {
        WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    } else {
        WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    }
    cacheMode = WebSettings.LOAD_DEFAULT
    // 让服务端有机会识别「这是安卓客户端」（Web 端目前不依赖它，留着做埋点/分流）
    userAgentString = userAgentString + " GusiMusicApp/${BuildConfig.VERSION_NAME}"
    // 页面本身已经是深色，禁止系统再叠一层「强制深色」把颜色搞坏
    try {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(this, false)
        }
    } catch (t: Throwable) {
        Log.i("GusiMain", "WebView 不支持 algorithmicDarkening: ${t.message}")
    }
}
