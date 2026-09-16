package com.gusi.music

import android.content.Context
import android.content.SharedPreferences

/**
 * 极简持久化：只存服务器地址。
 *
 * 登录态不在这里 —— 那是 Web 应用的 localStorage（WebView 自己管），
 * 壳不做第二份真相，否则改密码/退出登录会两边不同步。
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** 规范化后的服务器地址，形如 http://192.168.1.10:20059（可能带 /app 前缀）。未配置时为空串。 */
    var baseUrl: String
        get() = sp.getString(KEY_BASE_URL, "").orEmpty()
        set(value) = sp.edit().putString(KEY_BASE_URL, value).apply()

    val configured: Boolean get() = baseUrl.isNotEmpty()

    companion object {
        private const val NAME = "gusi-android"
        private const val KEY_BASE_URL = "base_url"
    }
}
