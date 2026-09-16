package com.gusi.music

import android.util.Log
import android.webkit.CookieManager

/**
 * 拉服务端资源时复用 WebView 的 cookie。
 *
 * 为什么需要：Web 端的封面/媒体地址带 `?k=<token>`，多数情况不带 cookie 也能取；
 * 但一旦服务端将来把鉴权收紧到 cookie，原生侧（通知栏封面）就会掉图。
 * 所以能带的都带上，成本只是一次 getCookie。
 */
object CookieStore {

    private const val TAG = "GusiCookie"

    fun cookieFor(url: String): String? = try {
        CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotEmpty() }
    } catch (t: Throwable) {
        Log.i(TAG, "读取 cookie 失败：${t.message}")
        null
    }
}
