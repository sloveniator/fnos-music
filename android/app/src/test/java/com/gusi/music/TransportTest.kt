package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Test

class TransportTest {

    @Test
    fun `相对跳转不越界`() {
        assertEquals(30_000L, Transport.seekTarget(0, 30_000, 200_000))
        assertEquals(0L, Transport.seekTarget(5_000, -30_000, 200_000))      // 后退到底就是 0
        assertEquals(200_000L, Transport.seekTarget(190_000, 30_000, 200_000)) // 快进到底就是总长
        assertEquals(0L, Transport.seekTarget(10_000, -30_000, 0))           // 时长未知：只保证不越左边
        assertEquals(40_000L, Transport.seekTarget(10_000, 30_000, 0))
    }

    @Test
    fun `播放中按时间外推`() {
        val p = Transport.positionNow(10_000, playing = true, atElapsedMs = 1_000_000, nowElapsedMs = 1_002_500, durationMs = 200_000)
        assertEquals(12_500L, p)
    }

    @Test
    fun `暂停时不上浮`() {
        val p = Transport.positionNow(10_000, playing = false, atElapsedMs = 1_000_000, nowElapsedMs = 1_060_000, durationMs = 200_000)
        assertEquals(10_000L, p)
    }

    @Test
    fun `外推不越过总时长`() {
        val p = Transport.positionNow(199_000, playing = true, atElapsedMs = 1_000_000, nowElapsedMs = 1_009_000, durationMs = 200_000)
        assertEquals(200_000L, p)
    }

    @Test
    fun `时长未知时照常外推`() {
        val p = Transport.positionNow(1_000, playing = true, atElapsedMs = 5_000, nowElapsedMs = 8_000, durationMs = 0)
        assertEquals(4_000L, p)
    }

    @Test
    fun `时间戳倒挂（时钟跳变）不产生负增量`() {
        val p = Transport.positionNow(7_000, playing = true, atElapsedMs = 9_000, nowElapsedMs = 5_000, durationMs = 100_000)
        assertEquals(7_000L, p)
    }

    @Test
    fun `不知道上报时刻时不外推`() {
        // 0 = 没有时间戳（服务刚起来、还没收到 Web 端状态）：宁可停在原位，
        // 也不能从 0 外推出「快放完了」这种假进度
        val p = Transport.positionNow(3_000, playing = true, atElapsedMs = 0, nowElapsedMs = 999_999_999, durationMs = 100_000)
        assertEquals(3_000L, p)
    }
}
