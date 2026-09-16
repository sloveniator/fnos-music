package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackMemoryTest {

    private var text: String? = null
    private fun newStore(max: Int = 300) = PlaybackMemory(read = { text }, write = { text = it }, maxEntries = max)

    private fun entry(pos: Long, dur: Long) =
        PlaybackMemory.Entry(PlaybackMemory.keyOf("晴天", "周杰伦"), pos, dur, 1L)

    @Test
    fun `写入后跨实例读回`() {
        val m = newStore()
        m.put(PlaybackMemory.keyOf("晴天", "周杰伦"), 62_000, 269_000)
        val again = newStore()
        val e = again.get(PlaybackMemory.keyOf("晴天", "周杰伦"))
        assertEquals(62_000L, e!!.positionMs)
        assertEquals(269_000L, e.durationMs)
        assertEquals(1, again.size())
    }

    @Test
    fun `曲名歌手组成键，空曲名不算键`() {
        assertEquals("晴天\u0001周杰伦", PlaybackMemory.keyOf(" 晴天 ", " 周杰伦 "))
        assertEquals("", PlaybackMemory.keyOf("   ", "谁"))
        // 分隔符是不可见控制字符（正常标签里不会出现），所以含空格/斜杠的曲名不会串位：
        // 若用「/」或空格做分隔，"A B/C" 与 "A/B C" 就会撞车
        assertTrue(PlaybackMemory.keyOf("A B", "C") != PlaybackMemory.keyOf("A", "B C"))
        assertTrue(PlaybackMemory.keyOf("A/B", "C") != PlaybackMemory.keyOf("A", "B/C"))
    }

    @Test
    fun `正常情况从上次位置续播`() {
        assertEquals(62_000L, PlaybackMemory.resumePoint(entry(62_000, 269_000), 269_000))
    }

    @Test
    fun `太短的听过不算数`() {
        assertEquals(-1L, PlaybackMemory.resumePoint(entry(5_000, 269_000), 269_000))
        assertEquals(-1L, PlaybackMemory.resumePoint(entry(14_999, 269_000), 269_000))
        assertEquals(15_000L, PlaybackMemory.resumePoint(entry(15_000, 269_000), 269_000))
    }

    @Test
    fun `听到结尾的不再续播`() {
        assertEquals(-1L, PlaybackMemory.resumePoint(entry(260_000, 269_000), 269_000))  // 距结尾 9 秒
        assertEquals(-1L, PlaybackMemory.resumePoint(entry(269_000, 269_000), 269_000))
        assertEquals(250_000L, PlaybackMemory.resumePoint(entry(250_000, 269_000), 269_000))
    }

    @Test
    fun `时长未知（直播流）不续播`() {
        assertEquals(-1L, PlaybackMemory.resumePoint(entry(62_000, 0), 0))
        // 本次没拿到时长，但记录里有：仍然可用
        assertEquals(62_000L, PlaybackMemory.resumePoint(entry(62_000, 269_000), 0))
    }

    @Test
    fun `没有记录就是从头`() {
        assertEquals(-1L, PlaybackMemory.resumePoint(null, 269_000))
    }

    @Test
    fun `听完判定`() {
        assertTrue(PlaybackMemory.finished(260_000, 269_000))
        assertTrue(!PlaybackMemory.finished(200_000, 269_000))
        assertTrue(!PlaybackMemory.finished(10_000, 0))   // 时长未知：不判定为听完
    }

    @Test
    fun `超出上限按最近更新淘汰`() {
        val m = newStore(max = 2)
        m.put("a", 20_000, 100_000, updatedAt = 1)
        m.put("b", 20_000, 100_000, updatedAt = 2)
        m.put("c", 20_000, 100_000, updatedAt = 3)
        assertEquals(2, m.size())
        assertEquals(null, m.get("a"))
        assertEquals(null, m.get("a"))
    }

    @Test
    fun `删除后落盘`() {
        val m = newStore()
        m.put("a", 20_000, 100_000)
        m.remove("a")
        assertEquals(0, newStore().size())
    }

    @Test
    fun `损坏行跳过且控制字符不出现在落盘文本里`() {
        // 控制字符写进 SharedPreferences 的 XML 是非法的 → 必须被转义
        val m = newStore()
        m.put("怪\u0001键", 20_000, 100_000)
        assertTrue(text!!.none { it.code < 0x20 && it != '\n' && it != '\t' })
        assertEquals(20_000L, newStore().get("怪\u0001键")!!.positionMs)

        text = "坏的没有制表符\na\t不是数字\t100\t1\nb\t20000\t100000\t1\n"
        val again = newStore()
        assertEquals(1, again.size())
        assertEquals(20_000L, again.get("b")!!.positionMs)
    }
}
