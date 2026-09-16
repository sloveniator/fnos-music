package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class TsvTest {

    @Test
    fun `分隔符与控制字符都能往返`() {
        val samples = listOf(
            "普通",
            "带\t制表符",
            "带\n换行",
            "带\r回车",
            "带\\反斜杠",
            "带\u0000空字节",
            "带\u0001分隔符",
            "混合\t\n\\\u0002",
            ""
        )
        for (s in samples) {
            assertEquals(s, Tsv.unesc(Tsv.esc(s)))
        }
    }

    @Test
    fun `转义后没有再出现需要二次转义的字符`() {
        val escaped = Tsv.esc("a\tb\nc\\d\u0001e")
        assertFalse(escaped.contains('\t'))
        assertFalse(escaped.contains('\n'))
        assertFalse(escaped.any { it.code < 0x20 })
    }

    @Test
    fun `畸形输入不炸也尽量还原`() {
        assertEquals("abc", Tsv.unesc("abc"))
        assertEquals("a\\", Tsv.unesc("a\\"))       // 结尾孤立反斜杠
        assertEquals("a\\xzz", Tsv.unesc("a\\xzz")) // 不是十六进制就按字面量
        assertEquals("a\u007f", Tsv.unesc("a\\x7f"))
    }
}
