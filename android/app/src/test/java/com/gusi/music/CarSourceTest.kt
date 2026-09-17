package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 车机数据层（C5）测试：缓存策略、专辑页取数、点单曲时队列该是哪张专辑、失败怎么退化。
 *
 * 这里不连网 —— [CarSource] 的 `fetch` 是一个函数参数，测试里换成夹具，
 * 于是「到底请求了哪个 URL、请求了几次」也都能断言。
 */
class CarSourceTest {

    private val tracksPath = "/web/api/tracks?size=200"
    private val albumsPath = "/web/api/albums?size=200"

    /** 「歌手甲 / 专辑一」经过 URL 编码后的专辑接口路径。 */
    private val albumPath =
        "/web/api/album?singer=%E6%AD%8C%E6%89%8B%E7%94%B2&album=%E4%B8%93%E8%BE%91%E4%B8%80"

    private val tracksBody = """
{"data": {"tracks": [
    {"id": "a1", "name": "第一首", "singer": "歌手甲", "album": "专辑一"},
    {"id": "a2", "name": "第二首", "singer": "歌手甲", "album": "专辑一"},
    {"id": "b1", "name": "别的", "singer": "歌手乙", "album": "专辑二"}
]}}
""".trim()

    private val albumsBody = """
{"data": {"albums": [{"key": "歌手甲||专辑一", "name": "专辑一", "singer": "歌手甲", "count": 2}]}}
""".trim()

    private val albumBody = """
{"data": {"singer": "歌手甲", "album": "专辑一", "tracks": [
    {"id": "a1", "name": "第一首", "singer": "歌手甲", "album": "专辑一"},
    {"id": "a2", "name": "第二首", "singer": "歌手甲", "album": "专辑一"}
]}}
""".trim()

    private val albumId = CarLibrary.albumMediaId("歌手甲", "专辑一")

    /** 默认夹具：三个接口各给一份像样的响应。 */
    private fun defaultHandler(p: String): String = when {
        p.startsWith("/web/api/tracks") -> tracksBody
        p.startsWith("/web/api/albums") -> albumsBody
        p.startsWith("/web/api/album?") -> albumBody
        else -> ""
    }

    /** 造一个数据源，并保留「请求过哪些路径」的记录（比 mock 框架直白）。 */
    private fun makeSource(
        loggedIn: Boolean = true,
        handler: (String) -> String = ::defaultHandler
    ): Pair<CarSource, MutableList<String>> {
        val paths = ArrayList<String>()
        val src = CarSource(fetch = { p -> paths.add(p); handler(p) }, loggedIn = { loggedIn })
        return src to paths
    }

    // ------------------------------------------------------------ 浏览

    @Test
    fun `根节点不需要联网`() {
        val (src, paths) = makeSource { "" }
        assertEquals(2, src.children(CarLibrary.ROOT_ID).size)
        assertTrue(paths.isEmpty())
    }

    @Test
    fun `全部歌曲取一页，第二次走缓存`() {
        val (src, paths) = makeSource()
        assertEquals(3, src.children(CarLibrary.GROUP_TRACKS).size)
        src.children(CarLibrary.GROUP_TRACKS)
        assertEquals(listOf(tracksPath), paths)
    }

    @Test
    fun `专辑列表取一页`() {
        val (src, paths) = makeSource()
        val albums = src.children(CarLibrary.GROUP_ALBUMS)
        assertEquals(1, albums.size)
        assertEquals("专辑一", albums[0].title)
        assertEquals(listOf(albumsPath), paths)
    }

    @Test
    fun `专辑曲目走专辑接口，歌手与专辑名经过 URL 编码`() {
        val (src, paths) = makeSource()
        assertEquals(2, src.children(albumId).size)
        assertEquals(listOf(albumPath), paths)
    }

    @Test
    fun `没登录给一行提示，而不是假装曲库是空的`() {
        val (src, paths) = makeSource(loggedIn = false) { "" }
        val items = src.children(CarLibrary.GROUP_TRACKS)
        assertEquals(1, items.size)
        assertEquals("请先在手机上打开古四音乐", items[0].title)
        assertFalse(items[0].browsable)
        assertFalse(items[0].playable)
        assertTrue(paths.isEmpty())          // 没令牌就不该去打服务端
    }

    @Test
    fun `取数失败时说「读不出来」并带上原因`() {
        val (src, _) = makeSource { "" }     // 空响应＝失败
        val items = src.children(CarLibrary.GROUP_TRACKS)
        assertEquals("曲库读不出来", items[0].title)
    }

    @Test
    fun `失败的结果不进缓存，下一次还会重试`() {
        var n = 0
        val (src, paths) = makeSource { p ->
            n++
            if (n == 1) "" else defaultHandler(p)
        }
        assertEquals("曲库读不出来", src.children(CarLibrary.GROUP_TRACKS)[0].title)
        // 第二次必须真的再请求一次：把一次网络抖动缓存成「空曲库」，用户得重启 App 才好
        assertEquals(3, src.children(CarLibrary.GROUP_TRACKS).size)
        assertEquals(2, paths.size)
    }

    @Test
    fun `空的专辑说「这张专辑里没有曲目」`() {
        val (src, _) = makeSource { p ->
            if (p.startsWith("/web/api/album?")) """{"data": {"tracks": []}}""" else defaultHandler(p)
        }
        assertEquals("这张专辑里没有曲目", src.children(albumId)[0].title)
    }

    @Test
    fun `取数抛异常也算失败，不崩`() {
        val (src, _) = makeSource { throw IllegalStateException("HTTP 500") }
        val items = src.children(CarLibrary.GROUP_TRACKS)
        assertEquals("曲库读不出来", items[0].title)
        assertEquals("HTTP 500", items[0].subtitle)
    }

    // ------------------------------------------------------------ 点播

    @Test
    fun `全部歌曲：从第一首开始，队列是整库`() {
        val (src, _) = makeSource()
        val plan = src.plan(CarLibrary.GROUP_TRACKS)!!
        assertEquals(3, plan.count)
        assertEquals(0, plan.index)
    }

    @Test
    fun `在专辑页点一首：队列是那张专辑，不是全部歌曲`() {
        val (src, _) = makeSource()
        src.children(albumId)                        // 先浏览过，才知道 a2 属于这张专辑
        val plan = src.plan(CarLibrary.trackMediaId("a2"))!!
        assertEquals(2, plan.count)                  // 专辑里 2 首，而不是全库的 3 首
        assertEquals(1, plan.index)
        assertFalse(plan.jsArg.contains(""""id":"b1""""))    // 别的专辑的歌不进队列
    }

    @Test
    fun `没在专辑页见过它时，退回全库定位`() {
        val (src, _) = makeSource()
        val plan = src.plan(CarLibrary.trackMediaId("b1"))!!
        assertEquals(3, plan.count)
        assertEquals(2, plan.index)
    }

    @Test
    fun `专辑本身可播：从第一首开始`() {
        val (src, _) = makeSource()
        val plan = src.plan(albumId)!!
        assertEquals(2, plan.count)
        assertEquals(0, plan.index)
    }

    @Test
    fun `认不出的 id 不放（不假装在播）`() {
        val (src, _) = makeSource()
        assertNull(src.plan("root/不存在的层"))
        assertNull(src.plan(CarLibrary.trackMediaId("不存在")))
        assertNull(src.plan("hint:曲库是空的"))
    }
}
