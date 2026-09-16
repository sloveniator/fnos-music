package com.gusi.music

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import java.io.File
import java.io.InputStream

/**
 * 安卓侧的真实文件读法。
 *
 * 拿的是 [ContentResolver] 而不是 Context：这一层只会被进程级单例持有（[LocalPlayback] 的
 * static 字段），持 Context 只会给 lint 和未来的自己找麻烦。
 *
 * 落盘位置有两种形态，必须都认：
 *  - `file:///storage/emulated/0/Download/xxx.mp3` —— Android 9 及以下、或指定了公共目录时；
 *  - `content://media/external/audio/media/123` —— Android 10+ 的分区存储下 DownloadManager 走 MediaStore。
 *
 * Range 请求走 `skipFully`（provider 的流基于 FileInputStream，skip 即 lseek），
 * 拿不到可 seek 的流时退化为顺序读 —— 无论哪条路，都不会返回错位的数据（错位听起来像破音）。
 */
class UriMediaSource(private val resolver: ContentResolver) : MediaSource {

    override fun size(path: String): Long {
        val uri = parse(path) ?: return -1L
        if (uri.scheme == "content") {
            return try {
                resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
            } catch (t: Throwable) {
                -1L
            }
        }
        return try {
            File(requirePath(uri)).length()
        } catch (_: Throwable) {
            -1L
        }
    }

    override fun exists(path: String): Boolean {
        val uri = parse(path) ?: return false
        if (uri.scheme == "content") {
            return try {
                resolver.openFileDescriptor(uri, "r")?.use { true } ?: false
            } catch (_: Throwable) {
                false
            }
        }
        return try {
            File(requirePath(uri)).isFile
        } catch (_: Throwable) {
            false
        }
    }

    override fun open(path: String, from: Long): InputStream? {
        val uri = parse(path) ?: return null
        if (uri.scheme == "content") {
            // 用 openInputStream（而不是自己拿 ParcelFileDescriptor + channel.position）：
            // provider 给的是 AutoCloseInputStream，它本身就基于 FileInputStream，
            // skip 走 lseek 是 O(1)；而自己管 fd 一旦忘了关就是泄漏，关闭时机还得跟流的生命周期绑。
            return try {
                val ins = resolver.openInputStream(uri) ?: return null
                if (from > 0) skipFully(ins, from)
                ins
            } catch (t: Throwable) {
                Log.w(TAG, "打开 $uri 失败：${t.message}")
                null
            }
        }
        return FileMediaSource().open(requirePath(uri), from)
    }

    private fun parse(path: String): Uri? = try {
        Uri.parse(path)
    } catch (_: Throwable) {
        null
    }

    /** `file://` 的 path 段，或裸路径（DownloadManager 少数机型会给绝对路径）。 */
    private fun requirePath(uri: Uri): String {
        val p = uri.path
        return if (!p.isNullOrEmpty()) p else uri.toString()
    }

    private companion object {
        const val TAG = "GusiLocalMedia"
    }
}
