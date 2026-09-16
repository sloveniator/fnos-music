package com.gusi.music

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.util.Log
import android.widget.Toast
import java.net.URLDecoder

/**
 * Web 端「下载到本机」的落点。
 *
 * 为什么要自己接管（而不是让 WebView 默认行为）：WebView 默认会把下载丢给系统的
 * 下载器，但拿不到中文文件名、也带不上 cookie/token；这里统一走 DownloadManager，
 * 自己解析 Content-Disposition，文件名与 Web 端给的名字一致（`歌名 - 歌手.mp3`）。
 */
object DownloadHelper {

    private const val TAG = "GusiDownload"

    fun enqueue(
        context: Context,
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?
    ) {
        val dm = context.getSystemService(DownloadManager::class.java)
        if (dm == null) {
            Toast.makeText(context, R.string.dl_no_manager, Toast.LENGTH_LONG).show()
            return
        }

        val uri = try {
            Uri.parse(url)
        } catch (t: Throwable) {
            null
        }
        if (uri == null || uri.scheme.isNullOrEmpty()) {
            Toast.makeText(context, R.string.dl_bad_url, Toast.LENGTH_LONG).show()
            return
        }

        val name = fileName(contentDisposition, url)
        val req = DownloadManager.Request(uri)
            .setTitle(name)
            .setDescription(context.getString(R.string.dl_desc))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(false)

        mimeType?.takeIf { it.isNotEmpty() }?.let { req.setMimeType(it) }

        try {
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        } catch (t: Throwable) {
            // 某些系统不允许直接指定公共目录（或已存在同名文件）→ 交给系统自己决定落点
            Log.w(TAG, "指定下载目录失败，交回系统决定：${t.message}")
        }

        userAgent?.takeIf { it.isNotEmpty() }?.let { req.addRequestHeader("User-Agent", it) }
        CookieStore.cookieFor(url)?.let { req.addRequestHeader("Cookie", it) }

        try {
            dm.enqueue(req)
            Toast.makeText(context, context.getString(R.string.dl_started, name), Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            Log.w(TAG, "入队失败", t)
            Toast.makeText(context, context.getString(R.string.dl_failed, t.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    /** 服务端优先给的是 RFC 5987 的 `filename*=UTF-8''…`，其次才是 ascii 的 `filename=`。 */
    fun fileName(contentDisposition: String?, url: String): String {
        val cd = contentDisposition ?: ""
        val star = Regex("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").find(cd)
        if (star != null) {
            return sanitize(decode(star.groupValues[1]))
        }
        val plain = Regex("filename\\s*=\\s*\"?([^\";]+)\"?").find(cd)
        if (plain != null) {
            return sanitize(decode(plain.groupValues[1]))
        }
        val last = url.substringBefore('?').trimEnd('/').substringAfterLast('/')
        return sanitize(decode(last).ifEmpty { "gusi-download" })
    }

    private fun decode(s: String): String = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (_: Throwable) {
        s
    }

    /** 只留文件名本身：防止 `../` 或 `\` 之类把落盘位置挪走。 */
    private fun sanitize(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\').trim()
        val cleaned = base.replace(Regex("[\\x00-\\x1f]"), "").ifEmpty { "gusi-download" }
        return if (cleaned.length > 120) cleaned.take(120) else cleaned
    }
}
