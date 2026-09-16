package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 归一化错了 = 把别的歌当成本地已下载（用户听到的是错歌），所以这里把 Web 端真实拼出来的
 * URL 形状逐条钉住（对照 ui/app/assets/app.js 的 mediaUrl / downloadUrl）。
 */
class MediaKeyTest {

    @Test
    fun `播放地址与下载地址指向同一首歌`() {
        val stream = "http://192.168.1.10:20059/web/media/stream/9f3a-1b?k=abc123"
        val download = "http://192.168.1.10:20059/web/media/download/9f3a-1b"
        assertEquals("track:9f3a-1b", MediaKey.of(stream))
        assertEquals(MediaKey.of(stream), MediaKey.of(download))
    }

    @Test
    fun `在线曲目用 source 与 rid 做键，dl 参数不影响`() {
        val stream = "http://nas:20059/web/media/online/netease/33894312?k=tok"
        val download = "http://nas:20059/web/media/online/netease/33894312?dl=1&name=%E6%AD%8C" +
            "&title=x&singer=y&album=z&dur=200&k=tok&pic=http%3A%2F%2Fa%2Fb.jpg"
        assertEquals("online:netease/33894312", MediaKey.of(stream))
        assertEquals(MediaKey.of(stream), MediaKey.of(download))
    }

    @Test
    fun `网关前缀与端口不计入键`() {
        val a = "http://192.168.1.10:20059/app/gusi-music/web/media/stream/x1?k=1"
        val b = "https://music.example.com/web/media/download/x1"
        assertEquals("track:x1", MediaKey.of(a))
        assertEquals(MediaKey.of(a), MediaKey.of(b))
    }

    @Test
    fun `相对路径也能归一化`() {
        assertEquals("track:q7", MediaKey.of("/web/media/stream/q7?k=zzz"))
        assertEquals("track:q7", MediaKey.of("/app/gusi-music/web/media/download/q7"))
    }

    @Test
    fun `id 先解码再比较，编码差异不算不同曲目`() {
        assertEquals("track:a b", MediaKey.of("/web/media/stream/a%20b?k=1"))
        assertEquals("track:a/b", MediaKey.of("/web/media/stream/a%2Fb"))
        // 路径里的 + 是字面量，不是空格
        assertEquals("track:a+b", MediaKey.of("/web/media/stream/a+b"))
    }

    @Test
    fun `图片与歌词不接管`() {
        assertNull(MediaKey.of("/web/media/cover/abc?k=1"))
        assertNull(MediaKey.of("/web/media/pic?u=http%3A%2F%2Fx"))
        assertNull(MediaKey.of("/web/media/lyric/abc"))
    }

    @Test
    fun `非媒体路径一律不接管`() {
        assertNull(MediaKey.of(""))
        assertNull(MediaKey.of("http://nas:20059/api/tracks"))
        assertNull(MediaKey.of("http://nas:20059/"))
        assertNull(MediaKey.of("/web/media/stream"))          // 缺 id
        assertNull(MediaKey.of("/web/media/online/netease"))  // 缺 rid
        assertNull(MediaKey.of("http://nas:20059"))           // 没有路径
    }

    @Test
    fun `尾部斜杠与 fragment 不影响`() {
        assertEquals("track:z9", MediaKey.of("/web/media/stream/z9/?k=1"))
        assertEquals("track:z9", MediaKey.of("/web/media/stream/z9#t=10"))
    }
}
