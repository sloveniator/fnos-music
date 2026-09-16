package com.gusi.music

/**
 * 按文件头猜音频类型（只在扩展名不可信时兜底）。
 *
 * 为什么需要：Content-Type 给错就等于「播放不了」——浏览器不把 `application/octet-stream`
 * 当媒体流。而落盘文件名来自服务端的 Content-Disposition，理论上都带扩展名，
 * 但用户可能手动改名、某些源返回的名字也可能没有后缀。这时候「宁可嗅探一下」比
 * 「静默播不出来」强得多：这类故障在手机上极难定位，多读 16 个字节不算代价。
 */
object AudioSniff {

    /** 传入文件头（16 字节足够）；认不出返回 null。 */
    fun mimeOf(head: ByteArray): String? {
        if (head.size < 4) return null
        val b = head
        fun at(i: Int) = b[i].toInt() and 0xFF

        // ID3v2 标签
        if (at(0) == 'I'.code && at(1) == 'D'.code && at(2) == '3'.code) return "audio/mpeg"
        // MPEG 帧同步（0xFF 后高 3 位全 1）——绝大多数无标签 mp3 的起始
        if (at(0) == 0xFF && (at(1) and 0xE0) == 0xE0) return "audio/mpeg"
        if (at(0) == 'f'.code && at(1) == 'L'.code && at(2) == 'a'.code && at(3) == 'C'.code) return "audio/flac"
        if (at(0) == 'O'.code && at(1) == 'g'.code && at(2) == 'g'.code && at(3) == 'S'.code) return "audio/ogg"
        if (head.size >= 12) {
            if (at(0) == 'R'.code && at(1) == 'I'.code && at(2) == 'F'.code && at(3) == 'F'.code &&
                at(8) == 'W'.code && at(9) == 'A'.code && at(10) == 'V'.code && at(11) == 'E'.code
            ) {
                return "audio/wav"
            }
            // ISO BMFF：box 类型 'ftyp'（m4a / mp4）
            if (at(4) == 'f'.code && at(5) == 't'.code && at(6) == 'y'.code && at(7) == 'p'.code) {
                return "audio/mp4"
            }
        }
        // Monkey's Audio（APE）
        if (at(0) == 'M'.code && at(1) == 'A'.code && at(2) == 'C'.code && at(3) == ' '.code) return "audio/x-ape"
        // ADTS AAC
        if (at(0) == 0xFF && (at(1) and 0xF0) == 0xF0) return "audio/aac"
        return null
    }
}
