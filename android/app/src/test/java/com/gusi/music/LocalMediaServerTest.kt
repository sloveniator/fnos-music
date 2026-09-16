package com.gusi.music

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files

/**
 * 真起 socket、真发 HTTP 请求（不是 mock 网络层）。
 *
 * 浏览器媒体栈靠 Range 拖动进度条，所以「片段取对了没有」是这一层最要紧的正确性 ——
 * 取错一个字节，用户听到的是杂音，而这类 bug 在设备上极难定位。
 */
class LocalMediaServerTest {

    private lateinit var dir: File
    private lateinit var server: LocalMediaServer
    private lateinit var payload: ByteArray
    private val token = "tok-1234abcd"

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("gusi-local-test").toFile()
        payload = ByteArray(1000) { (it % 251).toByte() }
        File(dir, "a.mp3").writeBytes(payload)
        File(dir, "b.flac").writeBytes(ByteArray(10))
        server = LocalMediaServer(
            resolve = { id ->
                when (id) {
                    "id-a" -> File(dir, "a.mp3").absolutePath
                    "id-b" -> File(dir, "b.flac").absolutePath
                    else -> null
                }
            },
            source = FileMediaSource(),
            token = token
        )
        server.start()
    }

    @After
    fun tearDown() {
        server.stop()
        dir.deleteRecursively()
    }

    private fun conn(path: String, range: String? = null, method: String = "GET"): HttpURLConnection {
        val c = URL("http://127.0.0.1:${server.port}$path").openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 5000
        c.readTimeout = 5000
        c.instanceFollowRedirects = false
        range?.let { c.setRequestProperty("Range", it) }
        return c
    }

    @Test
    fun `整段拉取拿到完整字节与音频类型`() {
        val c = conn("/m/$token/id-a")
        assertEquals(200, c.responseCode)
        assertEquals("audio/mpeg", c.getHeaderField("Content-Type"))
        assertEquals("bytes", c.getHeaderField("Accept-Ranges"))
        assertEquals("1000", c.getHeaderField("Content-Length"))
        assertArrayEquals(payload, c.inputStream.readBytes())
    }

    @Test
    fun `Range 中段精确切片`() {
        val c = conn("/m/$token/id-a", range = "bytes=100-199")
        assertEquals(206, c.responseCode)
        assertEquals("bytes 100-199/1000", c.getHeaderField("Content-Range"))
        assertEquals("100", c.getHeaderField("Content-Length"))
        assertArrayEquals(payload.copyOfRange(100, 200), c.inputStream.readBytes())
    }

    @Test
    fun `Range 开区间到文件结尾`() {
        val c = conn("/m/$token/id-a", range = "bytes=990-")
        assertEquals(206, c.responseCode)
        assertEquals("bytes 990-999/1000", c.getHeaderField("Content-Range"))
        assertArrayEquals(payload.copyOfRange(990, 1000), c.inputStream.readBytes())
    }

    @Test
    fun `Range 末尾 N 字节`() {
        val c = conn("/m/$token/id-a", range = "bytes=-10")
        assertEquals(206, c.responseCode)
        assertEquals("bytes 990-999/1000", c.getHeaderField("Content-Range"))
        assertArrayEquals(payload.copyOfRange(990, 1000), c.inputStream.readBytes())
    }

    @Test
    fun `越界 Range 回 416 并报真实长度`() {
        val c = conn("/m/$token/id-a", range = "bytes=1000-1200")
        assertEquals(416, c.responseCode)
        assertEquals("bytes */1000", c.getHeaderField("Content-Range"))
    }

    @Test
    fun `token 不对与 id 不存在都回 404`() {
        assertEquals(404, conn("/m/wrong-token/id-a").responseCode)
        assertEquals(404, conn("/m/$token/no-such-id").responseCode)
        // 就算知道 id，也拿不到 resolve 之外的东西
        assertEquals(404, conn("/m/$token/..%2F..%2Fetc%2Fpasswd").responseCode)
    }

    @Test
    fun `HEAD 只回头不带体`() {
        val c = conn("/m/$token/id-a", method = "HEAD")
        assertEquals(200, c.responseCode)
        assertEquals("1000", c.getHeaderField("Content-Length"))
        // HttpURLConnection 对 HEAD 给的是空流（不是 null）——这里只断言「没有实体字节」
        assertEquals(0, c.inputStream.readBytes().size)
    }

    @Test
    fun `非 GET 方法被拒`() {
        assertEquals(405, conn("/m/$token/id-a", method = "POST").responseCode)
    }

    @Test
    fun `文件被删掉后回 404`() {
        File(dir, "a.mp3").delete()
        assertEquals(404, conn("/m/$token/id-a").responseCode)
    }

    @Test
    fun `扩展名决定 Content-Type`() {
        assertEquals("audio/flac", conn("/m/$token/id-b").getHeaderField("Content-Type"))
        assertEquals("audio/mpeg", LocalMediaServer.mimeOf("/x/y.mp3"))
        assertEquals("audio/mp4", LocalMediaServer.mimeOf("C:\\d\\e.m4a"))
        assertEquals("application/octet-stream", LocalMediaServer.mimeOf("/x/无扩展名"))
    }

    @Test
    fun `没有扩展名时按文件头嗅探，避免当成普通文件`() {
        // 下载时被人手动改名成「歌名」没有后缀 —— 按内容认出来仍然是 mp3
        val bare = File(dir, "无后缀曲目")
        bare.writeBytes(ByteArray(64).also { it[0] = 0x49; it[1] = 0x44; it[2] = 0x33 })
        val srv = LocalMediaServer(
            resolve = { id -> if (id == "bare") bare.absolutePath else null },
            source = FileMediaSource(),
            token = token
        )
        srv.start()
        try {
            val c = URL("http://127.0.0.1:${srv.port}/m/$token/bare").openConnection() as HttpURLConnection
            assertEquals("audio/mpeg", c.getHeaderField("Content-Type"))
            assertEquals(64, c.inputStream.readBytes().size)
        } finally {
            srv.stop()
        }
    }

    @Test
    fun `只绑回环地址，端口随机且复用同一个实例不重开`() {
        assertTrue(server.port > 0)
        val p = server.port
        assertEquals(p, server.start())   // 幂等
        val u = URL("http://127.0.0.1:$p/m/$token/id-b")
        assertTrue((u.openConnection() as HttpURLConnection).responseCode == 200)
    }

    @Test
    fun `停服后端口不再监听`() {
        val p = server.port
        server.stop()
        val failed = try {
            val c = URL("http://127.0.0.1:$p/m/$token/id-a").openConnection() as HttpURLConnection
            c.connectTimeout = 1000
            c.readTimeout = 1000
            c.responseCode
            false
        } catch (_: Throwable) {
            true
        }
        assertTrue("停服后还能连上，说明 socket 没关掉", failed)
    }
}
