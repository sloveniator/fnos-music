package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalIndexTest {

    private var text: String? = null

    private fun newIndex(max: Int = 200) = LocalIndex(read = { text }, write = { text = it }, maxEntries = max)

    @Test
    fun `写入后能读回，并跨实例持久化`() {
        val idx = newIndex()
        idx.put("track:a1", "file:///sdcard/Download/晴天 - 周杰伦.mp3", "晴天 - 周杰伦.mp3", 8_000_000)

        val again = newIndex()
        val e = again.get("track:a1")
        assertNotNull(e)
        assertEquals("file:///sdcard/Download/晴天 - 周杰伦.mp3", e!!.path)
        assertEquals(8_000_000L, e.size)
        assertEquals("晴天 - 周杰伦.mp3", e.name)
    }

    @Test
    fun `id 稳定且与键一一对应`() {
        val idx = newIndex()
        idx.put("track:a1", "/a.mp3", "a.mp3", 1)
        val id = idx.get("track:a1")!!.id
        assertEquals(16, id.length)
        // 新建实例（重新解析）后 id 不变：Web 端手上可能还攥着上一轮的地址
        assertEquals(id, newIndex().get("track:a1")!!.id)
        assertEquals(id, idx.byId(id)!!.id)
        assertNull(idx.byId("deadbeefdeadbeef"))
    }

    @Test
    fun `名字里的制表符与换行不破坏文件格式`() {
        val idx = newIndex()
        idx.put("track:weird", "/tmp/a.mp3", "有\t制表符\n和换行.mp3", 5)
        idx.put("track:plain", "/tmp/b.mp3", "普通.mp3", 6)

        val again = newIndex()
        assertEquals(2, again.size())
        assertEquals("有\t制表符\n和换行.mp3", again.get("track:weird")!!.name)
        assertEquals("普通.mp3", again.get("track:plain")!!.name)
    }

    @Test
    fun `反斜杠与引号原样保留`() {
        val idx = newIndex()
        idx.put("track:bs", "C:\\Users\\a\\b.mp3", "a\\b.mp3", 3)
        assertEquals("C:\\Users\\a\\b.mp3", newIndex().get("track:bs")!!.path)
    }

    @Test
    fun `超出上限按最近写入淘汰`() {
        val idx = newIndex(max = 3)
        for (i in 1..5) {
            idx.put("track:$i", "/f$i.mp3", "f$i.mp3", i.toLong(), savedAt = i.toLong())
        }
        assertEquals(3, idx.size())
        assertNull(idx.get("track:1"))
        assertNull(idx.get("track:2"))
        assertNotNull(idx.get("track:5"))
    }

    @Test
    fun `键被覆盖时只留一条`() {
        val idx = newIndex()
        idx.put("track:same", "/old.mp3", "old.mp3", 1)
        idx.put("track:same", "/new.mp3", "new.mp3", 2)
        assertEquals(1, idx.size())
        assertEquals("/new.mp3", idx.get("track:same")!!.path)
    }

    @Test
    fun `损坏的行被跳过而不是整体作废`() {
        text = "坏的没有制表符\n" +
            "id1\ttrack:ok\t/tmp/ok.mp3\tok.mp3\t7\t100\n" +
            "id2\ttrack:bad\t/tmp/bad.mp3\tbad.mp3\t不是数字\t100\n" +
            "\n" +
            "id3\ttrack:noPath\t\t\t9\t100\n"
        val idx = newIndex()
        assertEquals(1, idx.size())
        assertNotNull(idx.get("track:ok"))
    }

    @Test
    fun `removeKey 会落盘`() {
        val idx = newIndex()
        idx.put("track:x", "/x.mp3", "x.mp3", 1)
        idx.removeKey("track:x")
        assertEquals(0, newIndex().size())
    }

    @Test
    fun `批量写入只落一次盘`() {
        var writes = 0
        val idx = LocalIndex(read = { null }, write = { writes++ }, maxEntries = 200)
        idx.putAll(listOf(1, 2, 3, 4).map { LocalIndex.New("track:$it", "/f$it.mp3", "f$it.mp3", it.toLong(), 0L) })
        assertEquals(4, idx.size())
        assertEquals(1, writes)
        assertTrue(idx.entries().isNotEmpty())
    }
}
