package com.gusi.music

import java.net.URI

/**
 * 服务器地址的解析与规范化。
 *
 * 刻意**不依赖 android.net.Uri** —— 纯 JDK 逻辑才能在 `src/test` 里跑单元测试
 * （见 ServerAddressTest）。这里是全应用唯一一处「用户输入 → 真实 URL」的转换点，
 * 所以规则集中写在这里，别处不许再拼字符串。
 *
 * 规则：
 *  - 省略协议 → 补 http://（NAS 局域网基本都是明文）
 *  - 省略端口 → 补 20059（本项目的默认端口）
 *  - 允许保留一段前缀路径（fnOS 应用中心的网关前缀形如 /app/gusi-music）
 *  - 只认 http / https，其它协议（ftp、file、javascript…）一律拒绝
 */
object ServerAddress {

    const val DEFAULT_PORT = 20059

    /** 返回规范化地址；非法输入返回 null。 */
    fun normalize(raw: String): String? {
        var s = raw.trim().replace('\u3000', ' ').trim()
        if (s.isEmpty()) return null

        // 用户常常直接粘 "192.168.1.10:20059" 或 "nas.local"
        if (!s.contains("://")) s = "http://$s"

        val uri = try {
            URI(s)
        } catch (_: Exception) {
            return null
        }

        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null

        val host = uri.host ?: return null
        if (host.isBlank() || !isValidHost(host)) return null

        // 端口缺省规则：http 用本项目默认的 20059（局域网 NAS 就是这个端口）；
        // https 不补端口，交给系统走 443 —— 极可能对端是反代，硬塞 20059 反而连不上。
        val port = when {
            uri.port != -1 -> uri.port
            scheme == "http" -> DEFAULT_PORT
            else -> -1
        }
        if (port != -1 && port !in 1..65535) return null

        val path = (uri.path ?: "").trimEnd('/')
        if (path.isNotEmpty() && !path.startsWith("/")) return null

        return if (port == -1) "$scheme://$host$path" else "$scheme://$host:$port$path"
    }

    /** 主机名/IP 白名单式校验：字母数字、点、短横线、下划线，以及 IPv6 的 [ ] : */
    fun isValidHost(host: String): Boolean {
        if (host.isEmpty() || host.length > 255) return false
        return host.all { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' || it == '[' || it == ']' || it == ':' }
    }

    /**
     * 把页面里的相对地址（封面、图标）解析成绝对地址。
     * 只允许 http/https 与相对路径，其它（file:、content:、data:）返回 null ——
     * 这些地址会被拿去做网络请求，不能放行本地协议。
     *
     * 以 `/` 开头的路径按 URL 语义**替换**基地址的路径（不是拼接），
     * 因为基地址可能带 fnOS 网关前缀 /app/gusi-music，而页面里的绝对路径
     * 已经是从站点根算起的（服务端也是这么发的）。
     */
    fun resolveUrl(base: String, url: String): String? {
        if (url.isEmpty()) return null
        if (url.startsWith("data:") || url.startsWith("blob:")) return null
        return try {
            val u = URI(url)
            when {
                u.isAbsolute -> if (u.scheme == "http" || u.scheme == "https") url else null
                url.startsWith("//") -> (URI(base).scheme ?: "http") + ":" + url
                url.startsWith("/") -> originOf(base)?.let { it + url }
                else -> base.trimEnd('/') + "/" + url.trimStart('/')
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 取 `scheme://host[:port]`，去掉路径前缀。 */
    private fun originOf(base: String): String? {
        return try {
            val b = URI(base)
            val scheme = b.scheme ?: return null
            val host = b.host ?: return null
            if (b.port == -1) "$scheme://$host" else "$scheme://$host:${b.port}"
        } catch (_: Exception) {
            null
        }
    }

    /** 给用户看的简短形式（去掉协议与默认端口之外的噪声）。 */
    fun pretty(base: String): String = base.removePrefix("http://").removePrefix("https://").trimEnd('/')
}
