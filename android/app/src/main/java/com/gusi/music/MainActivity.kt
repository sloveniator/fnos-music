package com.gusi.music

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
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
        setContentView(R.layout.activity_main)

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
        view.settings.applyWebDefaults()
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        view.webViewClient = appClient
        view.webChromeClient = appChromeClient
        view.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            DownloadHelper.enqueue(this, url, userAgent, contentDisposition, mimeType)
        }
        view.addJavascriptInterface(
            JsBridge { json ->
                // 注意：回调在 WebView 的 JS 线程上
                runOnUiThread { onPlaybackState(json) }
            },
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

    override fun onDestroy() {
        BridgeHolder.attach(null)
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
private fun WebSettings.applyWebDefaults() {
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
    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
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
