package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 车机曲库（C5）的纯逻辑测试。
 *
 * 夹具用**真实抓下来的接口响应**（`/web/api/tracks`、`/web/api/albums` 各一份 verbatim），
 * 免得测试里的字段名和字段形状是我一厢情愿猜的；`/web/api/album` 那份没抓到原始报文，
 * 是按 `server/src/web/api.ts` 里该分支的返回结构（`{ singer, album, tracks }`）拼的，
 * 曲目对象与上面那份同源。
 */
class CarLibraryTest {

    /** `/web/api/tracks?size=200` 的真实响应（逐字，测试库 3 首）。 */
    private val tracksJson = """
{"code": 0, "data": {"total": 3, "page": 1, "size": 50, "tracks": [{"id": "2b197f30ea6b59a4", "relPath": "周杰伦/范特西/00 长轨静音.wav", "ext": "wav", "size": 1440044, "mtime": 1789571971125, "name": "00 长轨静音", "singer": "周杰伦", "album": "范特西", "trackNum": null, "year": null, "interval": null, "hasCover": false}, {"id": "5650fa25d7f94e79", "relPath": "周杰伦/范特西/01 可爱女人.mp3", "ext": "mp3", "size": 4243, "mtime": 1789571971126, "name": "01 可爱女人", "singer": "周杰伦", "album": "范特西", "trackNum": null, "year": null, "interval": null, "hasCover": false}, {"id": "34f3ae0831f1fb61", "relPath": "周杰伦/范特西/02 完美主义.mp3", "ext": "mp3", "size": 4243, "mtime": 1789571971126, "name": "02 完美主义", "singer": "周杰伦", "album": "范特西", "trackNum": null, "year": null, "interval": null, "hasCover": false}]}}
""".trim()

    /** `/web/api/albums?size=200` 的真实响应（逐字，测试库 1 张专辑）。 */
    private val albumsJson = """
{"code": 0, "data": {"total": 1, "page": 1, "size": 50, "albums": [{"key": "周杰伦||范特西", "name": "范特西", "singer": "周杰伦", "year": null, "count": 3, "size": 1448530, "coverTrackId": null}]}}
""".trim()

    private fun albumJson(vararg extra: String): String {
        val three = """{"id": "2b197f30ea6b59a4", "name": "00 长轨静音", "singer": "周杰伦", "album": "范特西"},""" +
            """{"id": "5650fa25d7f94e79", "name": "01 可爱女人", "singer": "周杰伦", "album": "范特西"},""" +
            """{"id": "34f3ae0831f1fb61", "name": "02 完美主义", "singer": "周杰伦", "album": "范特西"}"""
        val rest = if (extra.isEmpty()) "" else "," + extra.joinToString(",")
        return """{"code": 0, "data": {"singer": "周杰伦", "album": "范特西", "tracks": [$three$rest]}}"""
    }

    // ------------------------------------------------------------ 树

    @Test
    fun `根节点：全部歌曲可播，专辑可进`() {
        val root = CarLibrary.rootChildren()
        assertEquals(2, root.size)
        assertEquals(CarLibrary.GROUP_TRACKS, root[0].mediaId)
        assertTrue(root[0].playable)
        assertFalse(root[0].browsable)          // 「全部歌曲」是「点了就放」，不是文件夹
        assertEquals(CarLibrary.GROUP_ALBUMS, root[1].mediaId)
        assertTrue(root[1].browsable)
        assertFalse(root[1].playable)
    }

    @Test
    fun `全部歌曲：用真实响应解析出 3 首`() {
        val items = CarLibrary.tracksChildren(tracksJson)
        assertEquals(3, items.size)
        assertEquals("t:2b197f30ea6b59a4", items[0].mediaId)
        assertEquals("00 长轨静音", items[0].title)
        assertEquals("周杰伦 · 范特西", items[0].subtitle)   // 副标题＝歌手 · 专辑，同名歌也能分开
        assertTrue(items[0].playable)
        assertFalse(items[0].browsable)
    }

    @Test
    fun `专辑：可进去，副标题带歌手与首数`() {
        val items = CarLibrary.albumsChildren(albumsJson)
        assertEquals(1, items.size)
        assertEquals("范特西", items[0].title)
        assertEquals("周杰伦 · 3 首", items[0].subtitle)
        assertTrue(items[0].browsable)
        assertFalse(items[0].playable)
        assertEquals("周杰伦" to "范特西", CarLibrary.albumOf(items[0].mediaId))
    }

    @Test
    fun `专辑 id 用不可见分隔符：歌手名里带竖线也不会串味`() {
        // 服务端的专辑 key 是 `歌手||专辑`，但歌手名本身可能出现 `|`；
        // 用可见字符做分隔再 split，会把「A|B」的歌手切错
        val id = CarLibrary.albumMediaId("A|B", "C")
        assertEquals("A|B" to "C", CarLibrary.albumOf(id))
    }

    @Test
    fun `不是专辑 id 的输入一律返回 null`() {
        assertNull(CarLibrary.albumOf("root"))
        assertNull(CarLibrary.albumOf(CarLibrary.trackMediaId("x")))
        assertNull(CarLibrary.albumOf(CarLibrary.ALBUM_PREFIX + "没有分隔符的专辑"))
    }

    @Test
    fun `专辑曲目：混进别的专辑的歌会被滤掉`() {
        val mixed = albumJson("""{"id": "other", "name": "别人的歌", "singer": "别人", "album": "别的专辑"}""")
        val items = CarLibrary.albumTracksChildren(mixed, "周杰伦", "范特西")
        assertEquals(3, items.size)
        assertTrue(items.none { it.mediaId == "t:other" })
    }

    @Test
    fun `缺字段不崩：名字兜底，没有 id 的曲目直接不列`() {
        val json = """{"data": {"tracks": [
            {"id": "a", "singer": "", "album": ""},
            {"name": "没 id 的歌"},
            {"id": "b", "name": "有名字", "singer": "甲", "album": ""}
        ]}}"""
        val items = CarLibrary.tracksChildren(json)
        assertEquals(2, items.size)
        assertEquals("（未命名）", items[0].title)
        assertEquals("未知歌手", items[0].subtitle)          // 专辑为空时不留一个「 · 」尾巴
        assertEquals("甲", items[1].subtitle)
    }

    @Test
    fun `坏 JSON 与空数据都退化成空树，不抛异常`() {
        for (bad in listOf("", "不是 JSON", "{}", """{"data": {}}""", """{"data": {"tracks": "不是数组"}}""")) {
            assertTrue("应退化成空：$bad", CarLibrary.tracksChildren(bad).isEmpty())
            assertTrue("应退化成空：$bad", CarLibrary.albumsChildren(bad).isEmpty())
            assertNull("应退化成空：$bad", CarLibrary.playAll(bad))
        }
    }

    @Test
    fun `超过单页上限时截断到 200`() {
        val many = (1..250).joinToString(",") { """{"id":"id$it","name":"n$it","singer":"s","album":"a"}""" }
        val json = """{"data": {"tracks": [$many]}}"""
        assertEquals(CarLibrary.MAX_CHILDREN, CarLibrary.tracksChildren(json).size)
    }

    // ------------------------------------------------------------ 播放计划

    @Test
    fun `全部歌曲：从头放，队列是整库`() {
        val plan = CarLibrary.playAll(tracksJson)!!
        assertEquals(3, plan.count)
        assertEquals(0, plan.index)
        assertTrue(plan.jsArg.contains(""""i":0"""))
        assertTrue(plan.jsArg.contains(""""id":"2b197f30ea6b59a4""""))
    }

    @Test
    fun `单曲：队列是它所在的那张专辑，下标定位到这首`() {
        val plan = CarLibrary.playTrack(albumJson(), "5650fa25d7f94e79")!!
        assertEquals(3, plan.count)
        assertEquals(1, plan.index)                    // 专辑里第 2 首
        assertTrue(plan.jsArg.contains(""""i":1"""))
        assertFalse(plan.jsArg.contains(""""i":2"""))   // 别把「最后出现的位置」当起始位置
    }

    @Test
    fun `单曲：列表里没有这首歌时返回 null（不假装能从别处开始）`() {
        assertNull(CarLibrary.playTrack(tracksJson, "不存在的 id"))
    }

    @Test
    fun `专辑：从第一首开始放`() {
        val plan = CarLibrary.playAlbum(albumJson(), "周杰伦", "范特西")!!
        assertEquals(3, plan.count)
        assertEquals(0, plan.index)
    }

    @Test
    fun `空库不假装在播`() {
        assertNull(CarLibrary.playAll("""{"data": {"tracks": []}}"""))
        assertNull(CarLibrary.playAlbum("""{"data": {"tracks": []}}""", "周杰伦", "范特西"))
        assertNull(CarLibrary.playTrack("""{"data": {"tracks": []}}""", "x"))
    }

    @Test
    fun `交给 Web 播放器的曲目对象原样透传`() {
        // 播放器靠这些字段取流/显示，壳自己另拼一套迟早会和服务端漂开：
        // 只要求「服务端给了什么就带着什么」，不要求壳补字段
        val plan = CarLibrary.playAll(tracksJson)!!
        assertTrue(plan.jsArg.contains(""""relPath":"周杰伦/范特西/01 可爱女人.mp3""""))
        assertTrue(plan.jsArg.contains(""""interval":null"""))
        // 也不该把 filePath 这种本就不在响应里的字段凭空造出来
        assertFalse(plan.jsArg.contains("filePath"))
    }
}
