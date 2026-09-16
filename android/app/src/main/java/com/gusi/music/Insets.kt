package com.gusi.music

/**
 * 安全区（刘海 / 状态栏 / 手势条）换算与注入。
 *
 * 为什么壳要管这件事：Web 端整篇布局都建立在 `env(safe-area-inset-*)` 上
 * （顶栏、底栏胶囊、歌词全屏都留了安全区），但**安卓 WebView 不一定上报**它 ——
 * Chromium 的 M136 只在全屏 WebView 里支持，M144 才铺开到所有 WebView；
 * 之前恒为 0。结果就是：壳开了沉浸式（内容画到状态栏底下）而页面以为没有安全区，
 * 顶栏按钮被状态栏时钟压住。
 *
 * 所以壳自己做权威来源：读 WindowInsets → 换算成 CSS px → 内联写到
 * `document.documentElement` 的 `--safe-top/--safe-bottom/--safe-left/--safe-right`。
 * Web 端 CSS 里这四个变量默认取 `env(...)`，被壳覆写后以壳为准（见 app.css 的 `:root`）。
 *
 * 抽成纯 JDK 文件是为了能单测：换算写错一位数，用户看到的是「顶栏被时钟压住」这种
 * 只能在真机上才发现的毛病。
 */
object Insets {

    /** 四边安全区，单位是 CSS px（不是物理像素）。 */
    data class Box(val top: Int, val bottom: Int, val left: Int, val right: Int) {
        val isEmpty: Boolean get() = top == 0 && bottom == 0 && left == 0 && right == 0

        /** 安全区变大/变小都要重新注入，但**没变就别注入**（inset 回调很频繁）。 */
        fun sameAs(other: Box?): Boolean =
            other != null && top == other.top && bottom == other.bottom &&
                left == other.left && right == other.right
    }

    val ZERO = Box(0, 0, 0, 0)

    /**
     * 物理像素 → CSS px。
     *
     * WebView 里的 CSS px 就是 dp（density 已按屏幕缩放），所以拿 density 除。
     * density 拿不到（0/负数/NaN）时原样返回：宁可偏大一点，也不能除出个负数让
     * `calc()` 反向扣掉安全区。
     */
    fun cssPx(physicalPx: Int, density: Float): Int {
        if (density <= 0f || density.isNaN() || density.isInfinite()) return maxOf(0, physicalPx)
        return Math.round(physicalPx / density)
    }

    /** 按物理像素和 density 组一个 Box（物理值先归零到非负，避免负 inset 传下去）。 */
    fun of(topPx: Int, bottomPx: Int, leftPx: Int, rightPx: Int, density: Float): Box = Box(
        top = cssPx(maxOf(0, topPx), density),
        bottom = cssPx(maxOf(0, bottomPx), density),
        left = cssPx(maxOf(0, leftPx), density),
        right = cssPx(maxOf(0, rightPx), density)
    )

    /**
     * 注入脚本。四边**每次都全量写**（含 0）：只写非零值的话，旋转/键盘收起后
     * 旧值会留在页面上，页面就一直以为底下还垫着一条安全区。
     *
     * 注入必须幂等、不能抛：这段脚本跑在页面上下文里，出错的代价是整页布局歪掉，
     * 所以整体包 try，并且不依赖页面上任何存在的函数（documentElement 就够了）。
     */
    fun js(box: Box): String = buildString {
        append("(function(){try{var s=document.documentElement.style;")
        append("s.setProperty('--safe-top','").append(box.top).append("px');")
        append("s.setProperty('--safe-bottom','").append(box.bottom).append("px');")
        append("s.setProperty('--safe-left','").append(box.left).append("px');")
        append("s.setProperty('--safe-right','").append(box.right).append("px');")
        append("}catch(e){}})()")
    }
}
