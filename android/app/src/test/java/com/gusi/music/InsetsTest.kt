package com.gusi.music

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 安全区换算与注入脚本。
 *
 * 这一层的错误全都会以「只能在真机上看出来」的形态出现：数字差一倍 → 顶栏被状态栏压住；
 * 注入不幂等 → 转屏后底栏悬空。所以边界条件挨个钉住。
 */
class InsetsTest {

    @Test
    fun `物理像素按 density 换算成 CSS px`() {
        // 典型手机：density 2.75、状态栏 88px、手势条 66px → 32 / 24 CSS px
        assertEquals(32, Insets.cssPx(88, 2.75f))
        assertEquals(24, Insets.cssPx(66, 2.75f))
        // density 1 的设备（少数平板）原样
        assertEquals(24, Insets.cssPx(24, 1f))
    }

    @Test
    fun `四舍五入而不是截断`() {
        // 88 / 3 = 29.33 → 29；88 / 2.5 = 35.2 → 35；63 / 2 = 31.5 → 32
        assertEquals(29, Insets.cssPx(88, 3f))
        assertEquals(35, Insets.cssPx(88, 2.5f))
        assertEquals(32, Insets.cssPx(63, 2f))
    }

    @Test
    fun `density 异常时原样返回而非算出负数`() {
        assertEquals(30, Insets.cssPx(30, 0f))
        assertEquals(30, Insets.cssPx(30, -1f))
        assertEquals(30, Insets.cssPx(30, Float.NaN))
        assertEquals(0, Insets.cssPx(-5, 0f))
    }

    @Test
    fun `负的物理 inset 归零`() {
        val b = Insets.of(-10, -1, -3, -8, 2f)
        assertTrue(b.isEmpty)
        assertEquals(Insets.ZERO, b)
    }

    @Test
    fun `of 会把整组值一起换算`() {
        val b = Insets.of(topPx = 88, bottomPx = 66, leftPx = 0, rightPx = 22, density = 2.75f)
        assertEquals(Insets.Box(top = 32, bottom = 24, left = 0, right = 8), b)
    }

    @Test
    fun `isEmpty 只在四边全零时为真`() {
        assertTrue(Insets.ZERO.isEmpty)
        assertFalse(Insets.Box(1, 0, 0, 0).isEmpty)
        assertFalse(Insets.Box(0, 0, 0, 2).isEmpty)
    }

    @Test
    fun `sameAs 认得出没变化（避免每帧都往页面里灌 JS）`() {
        val a = Insets.Box(32, 24, 0, 0)
        assertTrue(a.sameAs(Insets.Box(32, 24, 0, 0)))
        assertFalse(a.sameAs(Insets.Box(32, 25, 0, 0)))
        assertFalse(a.sameAs(Insets.Box(0, 0, 0, 0)))
        assertFalse(a.sameAs(null))
    }

    /** 把脚本里真正写进去的四个 px 值抽出来（顺带证明四边都写了）。 */
    private fun valuesIn(js: String): List<Int> =
        Regex("--safe-[a-z]+','(-?\\d+)px'").findAll(js).map { it.groupValues[1].toInt() }.toList()

    @Test
    fun `注入脚本四边全量写入，零值也写`() {
        val js = Insets.js(Insets.Box(32, 24, 0, 8))
        // 顺序即 top/bottom/left/right
        assertEquals(listOf(32, 24, 0, 8), valuesIn(js))
    }

    @Test
    fun `注入脚本自带 try 且不依赖页面上的任何函数`() {
        val js = Insets.js(Insets.ZERO)
        assertTrue(js.startsWith("(function(){try{"))
        assertTrue(js.endsWith("}catch(e){}})()"))
        // 自执行、无契约依赖：不出现 window.__gusi* / GusiBridge 之类的符号
        assertFalse(js.contains("GusiBridge"))
        assertFalse(js.contains("__gusi"))
    }

    @Test
    fun `负值不会被写进脚本`() {
        // of() 负责把负的物理 inset 归零，js() 本身只是老实拼字符串
        assertEquals(listOf(0, 0, 0, 0), valuesIn(Insets.js(Insets.of(-6, -6, -6, -6, 2f))))
    }

    @Test
    fun `注入脚本与 e2e-safe-area-py 逐字符锁定同一份字面量`() {
        // 容器里装不了真机，安全区那一层只能靠 tools/e2e-safe-area.py 在真实 Chromium 里量：
        // 它注入的正是这份字面量。两处各自钉死同一个字符串 —— 任何一边改了引号/顺序/分号，
        // 都会在这两个测试里炸出来，而不是在用户手机上表现为「顶栏被时钟压住」。
        val expected = "(function(){try{var s=document.documentElement.style;" +
            "s.setProperty('--safe-top','32px');s.setProperty('--safe-bottom','24px');" +
            "s.setProperty('--safe-left','0px');s.setProperty('--safe-right','0px');" +
            "}catch(e){}})()"
        assertEquals(expected, Insets.js(Insets.Box(32, 24, 0, 0)))
    }
}
