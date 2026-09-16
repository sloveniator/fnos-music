package com.gusi.music

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface

/** Web → 原生：把播放状态推过来。方法运行在 WebView 的 JS 线程，不是主线程。 */
class JsBridge(private val onState: (String) -> Unit) {

    @JavascriptInterface
    fun setState(json: String) {
        try {
            onState(json)
        } catch (t: Throwable) {
            Log.w(TAG, "setState 处理失败", t)
        }
    }

    @JavascriptInterface
    fun log(msg: String) {
        Log.i(TAG, "js: $msg")
    }

    companion object {
        private const val TAG = "GusiBridge"
    }
}

/**
 * 原生 → Web：谁能把指令送进 WebView。
 *
 * 通知栏按钮点下去时 Activity 可能已经不可见（正在后台播放），所以这里不硬绑
 * Activity 实例，而是由 MainActivity 在 onStart/onStop 之外的生命期里登记一个
 * 发送器；WebView 被销毁时必须摘掉，否则会往死对象上 evaluateJavascript。
 */
object BridgeHolder {

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var sink: ((String, String?) -> Unit)? = null

    fun attach(s: ((String, String?) -> Unit)?) {
        sink = s
    }

    /** 返回 false 表示当前没有可用的 WebView（例如进程刚被重建、页面还没起来）。 */
    fun send(cmd: String, arg: String? = null): Boolean {
        val s = sink ?: return false
        main.post { s(cmd, arg) }
        return true
    }
}
