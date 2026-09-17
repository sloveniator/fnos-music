package com.gusi.music

/**
 * WebView 里那份登录令牌（`localStorage` 的 `gusi-web-token`）。
 *
 * 车机侧取曲库（`/web/api/tracks` 等）要带 `X-Web-Token`，而这个令牌只存在于 Web 端 ——
 * 所以壳**不另存密码、不另开登录通道**，只由 [BridgeScript] 在它变化时推一份过来
 * （登录成功、切换账号、令牌刷新、登出都会触发）。
 *
 * 令牌失效/被清除时这里跟着变空：服务端会回 401，车机侧就显示
 * 「请先在手机上打开古四音乐」，而不是显示一个「空的曲库」误导人。
 */
object WebSession {

    /** 当前令牌；没有（未登录/已登出）为 null。 */
    @Volatile
    var token: String? = null
        private set

    /** BridgeScript 推来的原始值；空白串（登出会推空串）视作没有令牌。 */
    fun update(raw: String?) {
        val t = raw?.trim().orEmpty()
        token = t.ifEmpty { null }
    }

    val loggedIn: Boolean get() = !token.isNullOrBlank()
}
