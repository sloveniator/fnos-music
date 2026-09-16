package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioSniffTest {

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    @Test
    fun `id3 与裸帧都认成 mp3`() {
        assertEquals("audio/mpeg", AudioSniff.mimeOf(bytes(0x49, 0x44, 0x33, 0x03, 0x00)))
        assertEquals("audio/mpeg", AudioSniff.mimeOf(bytes(0xFF, 0xFB, 0x90, 0x00)))
    }

    @Test
    fun `主流无损与容器格式`() {
        assertEquals("audio/flac", AudioSniff.mimeOf(bytes(0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22)))
        assertEquals("audio/ogg", AudioSniff.mimeOf(bytes(0x4F, 0x67, 0x67, 0x53, 0x00)))
        assertEquals("audio/x-ape", AudioSniff.mimeOf(bytes(0x4D, 0x41, 0x43, 0x20)))
    }

    @Test
    fun `wav 与 m4a 需要看到更靠后的标记`() {
        assertEquals(
            "audio/wav",
            AudioSniff.mimeOf(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45))
        )
        // RIFF 但不是 WAVE（如 AVI）→ 不认
        assertNull(AudioSniff.mimeOf(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20)))
        assertEquals(
            "audio/mp4",
            AudioSniff.mimeOf(bytes(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41, 0x20))
        )
    }

    @Test
    fun `认不出就返回 null，不硬猜`() {
        assertNull(AudioSniff.mimeOf(ByteArray(0)))
        assertNull(AudioSniff.mimeOf(bytes(0x00, 0x01, 0x02)))
        assertNull(AudioSniff.mimeOf("hello world hello".toByteArray()))
    }
}
