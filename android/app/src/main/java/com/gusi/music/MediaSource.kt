package com.gusi.music

import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * 本地回环服务读取文件的唯一入口。
 *
 * 抽成接口是为了让 [LocalMediaServer] 保持纯 JVM：测试里给一个基于临时目录的实现，
 * 就能真的起服务、真的发 HTTP 请求（而不是 mock 掉网络层，那样等于什么都没测）。
 * 安卓侧的真实实现见 [UriMediaSource]。
 */
interface MediaSource {

    /** 字节数；拿不到返回 -1（此时服务端退化为不带 Content-Length 的整段响应）。 */
    fun size(path: String): Long

    /** 从 [from] 字节处开始读文件内容；文件不在或读不了返回 null。 */
    fun open(path: String, from: Long): InputStream?

    fun exists(path: String): Boolean
}

/** 普通文件系统实现（也是单测用的实现）。 */
class FileMediaSource : MediaSource {

    override fun size(path: String): Long = try {
        File(path).length()
    } catch (_: Throwable) {
        -1L
    }

    override fun open(path: String, from: Long): InputStream? = try {
        val f = File(path)
        if (!f.isFile) null else FileInputStream(f).let { ins ->
            if (from > 0) skipFully(ins, from)
            ins
        }
    } catch (_: Throwable) {
        null
    }

    override fun exists(path: String): Boolean = try {
        File(path).isFile
    } catch (_: Throwable) {
        false
    }
}

/**
 * 尽量用 `skip` 而不是「读掉再丢」，但 skip 允许提前返回（尤其是 Socket/管道流），
 * 必须循环到真正跳过目标字节数为止，否则 Range 请求会返回错位的数据（听起来像破音）。
 */
internal fun skipFully(ins: InputStream, n: Long): Long {
    var left = n
    while (left > 0) {
        val step = ins.skip(left)
        if (step > 0) {
            left -= step
            continue
        }
        // skip 返回 0：退化成读一个字节（流不支持 seek 时只能这样）
        if (ins.read() < 0) break
        left--
    }
    return n - left
}
