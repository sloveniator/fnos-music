package com.gusi.music

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 「本地文件当音源」用的回环 HTTP 服务。
 *
 * 为什么非要起个 HTTP 服务，而不是直接给 WebView 一个 `file://` 地址：
 *  1. 页面本身来自 `http(s)://NAS`，`file://` 是另一个源，音频会被当跨域资源拦掉；
 *  2. 浏览器的媒体栈要**按 Range 分段拉流**（拖动进度条、边下边播），`file://` 在 WebView 里
 *     的 Range 行为不可控；
 *  3. 同一个 loopback 端口既能给 `<audio>` 用，也能给未来的播放列表/预览复用。
 *
 * 安全边界（这是个真的监听 socket，不能马虎）：
 *  - 只绑 `127.0.0.1`，不接受局域网连接；
 *  - 路径里必须带一次性随机 token（4100 万分之一量级的猜测成本，足够挡住同机其它 App 的顺手试探）；
 *  - **只服务索引里的 id**，不接任意路径 —— 没有目录穿越的可能（路径由 [resolve] 给，不来自请求）。
 */
class LocalMediaServer(
    private val resolve: (String) -> String?,
    private val source: MediaSource,
    private val token: String,
    private val pathPrefix: String = "/m"
) {

    private val socket = AtomicBoolean(false)
    private var server: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(POOL_SIZE) { r ->
        Thread(r, "gusi-local-media").apply { isDaemon = true }
    }

    /** 监听端口；未启动为 0。 */
    @Volatile
    var port: Int = 0
        private set

    val running: Boolean get() = server != null

    /** 启动并返回端口；重复调用返回已有端口。 */
    @Synchronized
    fun start(): Int {
        if (server != null) return port
        val s = ServerSocket(0, BACKLOG, InetAddress.getByName("127.0.0.1"))
        server = s
        port = s.localPort
        socket.set(true)
        Thread({
            while (socket.get()) {
                val c = try {
                    s.accept()
                } catch (_: Throwable) {
                    break       // stop() 关掉了 socket
                }
                try {
                    pool.execute { handleQuietly(c) }
                } catch (_: Throwable) {
                    try {
                        c.close()
                    } catch (_: Throwable) {
                    }
                }
            }
        }, "gusi-local-accept").apply {
            isDaemon = true
            start()
        }
        return port
    }

    @Synchronized
    fun stop() {
        socket.set(false)
        try {
            server?.close()
        } catch (_: Throwable) {
        }
        server = null
        port = 0
        pool.shutdownNow()
    }

    fun urlFor(id: String): String = "http://127.0.0.1:$port$pathPrefix/$token/$id"

    // ---------------------------------------------------------------- 请求处理

    private fun handleQuietly(c: Socket) {
        try {
            c.use { handle(it) }
        } catch (_: Throwable) {
            // 单个请求出错不该影响服务
        }
    }

    private fun handle(c: Socket) {
        c.soTimeout = SOCKET_TIMEOUT_MS
        val ins = BufferedInputStream(c.getInputStream())
        val out = BufferedOutputStream(c.getOutputStream())

        val requestLine = readLine(ins) ?: return
        val parts = requestLine.split(' ')
        if (parts.size < 2) return
        val method = parts[0].uppercase()
        val target = parts[1]

        // 头部只读到空行为止；顺手限制总长度，避免有人往这里灌垃圾
        var rangeHeader: String? = null
        var seen = 0
        while (true) {
            val h = readLine(ins) ?: break
            if (h.isEmpty()) break
            seen += h.length
            if (seen > MAX_HEADER_BYTES) return
            val colon = h.indexOf(':')
            if (colon > 0 && h.substring(0, colon).trim().equals("Range", ignoreCase = true)) {
                rangeHeader = h.substring(colon + 1).trim()
            }
        }

        if (method != "GET" && method != "HEAD") {
            respondError(out, 405, "Method Not Allowed")
            return
        }

        val seg = target.substringBefore('?').split('/')
        if (seg.size < 4 || seg[1] != pathPrefix.trimStart('/') || seg[2] != token) {
            // token 不对与 id 不存在回同一句：不告诉试探者「差在哪」
            respondError(out, 404, "Not Found")
            return
        }
        val id = seg[3]
        val path = resolve(id)
        if (path == null || !source.exists(path)) {
            respondError(out, 404, "Not Found")
            return
        }

        val size = source.size(path)
        val wantRange = rangeHeader?.let { parseRange(it, size) }
        if (rangeHeader != null && size >= 0 && wantRange == null) {
            // 语法合法但范围越界（或 size 为 0）→ 416，并告诉对方真实长度
            val head = buildString {
                append("HTTP/1.1 416 Range Not Satisfiable\r\n")
                append("Content-Range: bytes */").append(size).append("\r\n")
                append("Content-Length: 0\r\n")
                append("Connection: close\r\n\r\n")
            }
            out.write(head.toByteArray(Charsets.ISO_8859_1))
            out.flush()
            return
        }

        val start = wantRange?.first ?: 0L
        val end = when {
            wantRange != null -> wantRange.last
            size >= 0 -> size - 1
            else -> -1L                       // 长度未知：整段流，不带 Content-Length
        }
        val length = if (end >= start) end - start + 1 else -1L
        val partial = wantRange != null

        val head = buildString {
            append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
            append("Content-Type: ").append(contentTypeFor(path)).append("\r\n")
            append("Accept-Ranges: bytes\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n")
            if (length >= 0) append("Content-Length: ").append(length).append("\r\n")
            if (partial && size >= 0) {
                append("Content-Range: bytes ").append(start).append('-').append(end)
                    .append('/').append(size).append("\r\n")
            }
            append("\r\n")
        }
        out.write(head.toByteArray(Charsets.ISO_8859_1))
        if (method == "HEAD") {
            out.flush()
            return
        }

        val stream: InputStream? = source.open(path, start)
        if (stream == null) {
            out.flush()
            return
        }
        stream.use {
            val buf = ByteArray(COPY_BUFFER)
            var left = length
            while (true) {
                val max = if (left >= 0) minOf(buf.size.toLong(), left).toInt() else buf.size
                if (max <= 0) break
                val n = it.read(buf, 0, max)
                if (n <= 0) break
                out.write(buf, 0, n)
                if (left > 0) left -= n
            }
        }
        out.flush()
    }

    /**
     * 先看扩展名，认不出再读 16 个字节看文件头。
     * 给错 Content-Type 的后果是「浏览器不播、当普通文件处理」，而这在设备上表现为
     * 「点了没反应」，极难定位 —— 多读 16 字节换确定性很划算。
     */
    private fun contentTypeFor(path: String): String {
        val byExt = mimeOf(path)
        if (byExt != "application/octet-stream") return byExt
        val head = try {
            source.open(path, 0)?.use { ins ->
                val buf = ByteArray(16)
                var n = 0
                while (n < buf.size) {
                    val r = ins.read(buf, n, buf.size - n)
                    if (r <= 0) break
                    n += r
                }
                buf.copyOf(n)
            }
        } catch (_: Throwable) {
            null
        }
        return if (head == null) byExt else (AudioSniff.mimeOf(head) ?: byExt)
    }

    private fun respondError(out: OutputStream, code: Int, text: String) {        val body = "$code $text".toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $code $text\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.ISO_8859_1))
        out.write(body)
        out.flush()
    }

    private fun readLine(ins: InputStream): String? {
        val sb = StringBuilder(64)
        while (true) {
            val b = ins.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString()
            if (b != '\r'.code) sb.append(b.toChar())
            if (sb.length > MAX_LINE_CHARS) return null
        }
    }

    /** 支持 `bytes=a-b` / `bytes=a-` / `bytes=-n`，越界返回 null。 */
    private fun parseRange(value: String, size: Long): LongRange? {
        val v = value.trim()
        if (!v.startsWith("bytes=", ignoreCase = true)) return null
        val spec = v.substring(6).substringBefore(',').trim()
        val dash = spec.indexOf('-')
        if (dash < 0) return null
        val aTxt = spec.substring(0, dash).trim()
        val bTxt = spec.substring(dash + 1).trim()
        val start: Long
        val end: Long
        if (aTxt.isEmpty()) {
            // 末尾 n 字节
            val n = bTxt.toLongOrNull() ?: return null
            if (n <= 0 || size <= 0) return null
            start = (size - n).coerceAtLeast(0)
            end = size - 1
        } else {
            start = aTxt.toLongOrNull() ?: return null
            end = if (bTxt.isEmpty()) (if (size >= 0) size - 1 else -1L) else (bTxt.toLongOrNull() ?: return null)
            if (start < 0) return null
            if (size >= 0 && start >= size) return null
            if (end >= 0 && end < start) return null
        }
        return start..end
    }

    companion object {
        private const val POOL_SIZE = 4
        private const val BACKLOG = 16
        private const val MAX_HEADER_BYTES = 16 * 1024
        private const val MAX_LINE_CHARS = 8 * 1024
        private const val SOCKET_TIMEOUT_MS = 15_000
        private const val COPY_BUFFER = 64 * 1024

        /** 按扩展名给 Content-Type（浏览器只把 audio 前缀的类型当媒体流，给错了会当普通文件下载）。 */
        fun mimeOf(path: String): String =
            when (path.substringAfterLast('.', "").lowercase()) {
                "mp3" -> "audio/mpeg"
                "m4a", "aac", "mp4" -> "audio/mp4"
                "flac" -> "audio/flac"
                "wav" -> "audio/wav"
                "ogg", "oga" -> "audio/ogg"
                "opus" -> "audio/ogg"
                "wma" -> "audio/x-ms-wma"
                "ape" -> "audio/x-ape"
                "m4b" -> "audio/mp4"
                else -> "application/octet-stream"
            }
    }
}
