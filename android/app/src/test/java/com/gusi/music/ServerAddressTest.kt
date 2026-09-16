package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 服务器地址解析是全应用唯一处理用户输入的地方，边界必须钉死在这里。
 * 纯 JVM 测试，`./gradlew test` 就能跑，不需要设备/模拟器。
 */
class ServerAddressTest {

    @Test
    fun `补全协议与默认端口`() {
        assertEquals("http://192.168.1.10:20059", ServerAddress.normalize("192.168.1.10"))
        assertEquals("http://192.168.1.10:20059", ServerAddress.normalize("192.168.1.10:20059"))
        assertEquals("http://nas.local:20059", ServerAddress.normalize("nas.local"))
    }

    @Test
    fun `保留显式端口与协议`() {
        assertEquals("http://10.0.0.2:8080", ServerAddress.normalize("http://10.0.0.2:8080"))
        // https 不补默认端口：对端很可能是反代，硬塞 20059 反而连不上
        assertEquals("https://music.example.com", ServerAddress.normalize("https://music.example.com"))
        assertEquals("https://music.example.com:8443", ServerAddress.normalize("https://music.example.com:8443"))
    }

    @Test
    fun `保留 fnOS 网关前缀路径`() {
        assertEquals(
            "http://192.168.1.10:20059/app/gusi-music",
            ServerAddress.normalize("192.168.1.10:20059/app/gusi-music/")
        )
    }

    @Test
    fun `去掉首尾空白与全角空格`() {
        assertEquals("http://192.168.1.10:20059", ServerAddress.normalize("  192.168.1.10\u3000"))
    }

    @Test
    fun `拒绝非法输入`() {
        assertNull(ServerAddress.normalize(""))
        assertNull(ServerAddress.normalize("   "))
        assertNull(ServerAddress.normalize("ftp://192.168.1.10"))
        assertNull(ServerAddress.normalize("javascript:alert(1)"))
        assertNull(ServerAddress.normalize("file:///etc/passwd"))
        assertNull(ServerAddress.normalize("http://:20059"))
    }

    @Test
    fun `相对封面地址解析`() {
        assertEquals(
            "http://nas:20059/assets/icon.png",
            ServerAddress.resolveUrl("http://nas:20059", "assets/icon.png")
        )
        // 以 / 开头 = 从站点根算起，替换掉基地址的路径（基地址可能带网关前缀）
        assertEquals(
            "http://nas:20059/web/media/pic?u=x",
            ServerAddress.resolveUrl("http://nas:20059/app/gusi-music/", "/web/media/pic?u=x")
        )
        // 不带 / 的相对路径才是拼接
        assertEquals(
            "http://nas:20059/app/gusi-music/assets/icon.png",
            ServerAddress.resolveUrl("http://nas:20059/app/gusi-music/", "assets/icon.png")
        )
        // 绝对地址只放行 http/https
        assertEquals(
            "https://cdn.example.com/a.jpg",
            ServerAddress.resolveUrl("http://nas:20059", "https://cdn.example.com/a.jpg")
        )
        assertNull(ServerAddress.resolveUrl("http://nas:20059", "file:///etc/passwd"))
        assertNull(ServerAddress.resolveUrl("http://nas:20059", "content://media/1"))
        assertNull(ServerAddress.resolveUrl("http://nas:20059", "data:image/png;base64,AAAA"))
        assertNull(ServerAddress.resolveUrl("http://nas:20059", ""))
    }

    @Test
    fun `主机名白名单`() {
        assertTrue(ServerAddress.isValidHost("192.168.1.10"))
        assertTrue(ServerAddress.isValidHost("nas-01.local"))
        assertTrue(ServerAddress.isValidHost("::1"))
        assertFalse(ServerAddress.isValidHost(""))
        assertFalse(ServerAddress.isValidHost("a b"))
        assertFalse(ServerAddress.isValidHost("evil/x"))
    }

    @Test
    fun `pretty 只去掉协议`() {
        assertEquals("192.168.1.10:20059", ServerAddress.pretty("http://192.168.1.10:20059"))
        assertEquals("music.example.com:443", ServerAddress.pretty("https://music.example.com:443"))
    }
}
