package com.gusi.music

import java.net.URLDecoder

/**
 * 「同一个音频，不同 URL」的归一化。
 *
 * 离线播放要解决的核心问题：Web 端**播放**用的 URL 和**下载**用的 URL 不是同一个字符串
 * （`/web/media/stream/<id>?k=token` vs `/web/media/download/<id>`；在线曲目则是
 * `.../online/<source>/<rid>?k=` vs `...?dl=1&name=...&title=...`）。壳只在下发下载任务时
 * 见到过前者的兄弟、在播放时见到另一个，中间靠这张键对上号。
 *
 * 归一化规则（宁可漏认，不可错认）：
 *  - 丢掉 scheme / host / 网关前缀（`/app/gusi-music`）—— 同一个 NAS 用 IP 还是域名访问都算同一首；
 *  - 丢掉整个 query（token、dl=1、name=…、pic=… 全是易变参数）；
 *  - `stream` 与 `download` 视为同一键；`online` 用 `source/rid` 做键（和曲库 id 同一个来源）；
 *  - `cover` / `pic` / `lyric` 等非音频一律不接管（返回 null）。
 */
object MediaKey {

    private const val MARKER = "/web/media/"

    /** 返回形如 `track:<id>` / `online:<source>/<rid>` 的键；不是音频媒体则 null。 */
    fun of(url: String): String? {
        if (url.isEmpty()) return null

        var s = url
        // 1) 去 scheme://host（相对 URL 原样保留）
        val schemeAt = s.indexOf("://")
        if (schemeAt >= 0) {
            val slash = s.indexOf('/', schemeAt + 3)
            if (slash < 0) return null
            s = s.substring(slash)
        }
        // 2) 去 query / fragment
        s = s.substringBefore('?').substringBefore('#')

        // 3) 只看 /web/media/ 之后的部分；前面的网关前缀一律忽略
        val at = s.indexOf(MARKER)
        if (at < 0) return null
        val seg = s.substring(at + MARKER.length).trimEnd('/').split('/')
        if (seg.size < 2) return null

        return when (seg[0]) {
            "stream", "download" -> "track:" + decode(seg[1])
            "online" -> if (seg.size < 3) null else "online:" + decode(seg[1]) + "/" + decode(seg[2])
            // cover / pic / lyric：图片和歌词不做本地接管（体积小、离线价值低，接管反而多一处错认风险）
            else -> null
        }
    }

    /** 路径段解码：先保护 `+`，否则 URLDecoder 会把它当空格（路径里 `+` 是字面量）。 */
    private fun decode(s: String): String = try {
        URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    } catch (_: Throwable) {
        s
    }
}
