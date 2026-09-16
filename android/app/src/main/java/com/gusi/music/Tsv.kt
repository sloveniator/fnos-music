package com.gusi.music

/**
 * 极简 TSV 转义（[LocalIndex] 与 [PlaybackMemory] 共用）。
 *
 * 为什么不用 JSON：这两层都要能在纯 JVM 单测里跑，而 Android 的 `org.json` 在单测里是空壳
 * （方法全返回默认值），用它会得到「测试通过但线上崩」的假安全感。
 *
 * 除了反斜杠/制表符/换行/回车，控制字符（`\u0000`-`\u001f`）也一并转义：
 * 这些字符写进 SharedPreferences 的 XML 是**非法**的，会让整份偏好设置读不出来。
 */
object Tsv {

    fun esc(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (c in s) {
            when (c) {
                '\\' -> sb.append("\\\\")
                '\t' -> sb.append("\\t")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                else -> if (c.code < 0x20) sb.append(String.format("\\x%02x", c.code)) else sb.append(c)
            }
        }
        return sb.toString()
    }

    fun unesc(s: String): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    't' -> { sb.append('\t'); i += 2; continue }
                    'n' -> { sb.append('\n'); i += 2; continue }
                    'r' -> { sb.append('\r'); i += 2; continue }
                    '\\' -> { sb.append('\\'); i += 2; continue }
                    'x' -> {
                        if (i + 3 < s.length) {
                            val hex = s.substring(i + 2, i + 4).toIntOrNull(16)
                            if (hex != null) {
                                sb.append(hex.toChar())
                                i += 4
                                continue
                            }
                        }
                    }
                    else -> if (n == 'x') Unit    // 落空：按字面量继续
                }
            }
            sb.append(c)
            i++
        }
        return sb.toString()
    }
}
