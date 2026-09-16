package com.gusi.music

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * 离线播放（C1）的接线盒：把「Web 端要的那首歌」对到「手机上已经有的那个文件」。
 *
 * 数据流向：
 *   下载完成（或启动时扫系统下载库） → [MediaKey] 归一化 → [LocalIndex] 落索引
 *   Web 端给 `<audio>` 设 src → JS 同步问原生（[JsBridge.localFor]）→ 命中则换成
 *   `http://127.0.0.1:<port>/m/<token>/<id>` → [LocalMediaServer] 带 Range 把本地文件喂回去。
 *
 * 为什么索引可以从系统下载库里重建：DownloadManager 的记录里存着**原始请求 URL**
 * （`COLUMN_URI`），而我们的下载描述是固定文案，所以「重装 App / 清数据 / 上次没写进索引」
 * 都能自愈 —— 索引只是缓存，不是真相。
 */
object LocalPlayback {

    private const val TAG = "GusiLocalPlayback"
    private const val PREFS = "gusi-android-local"
    private const val KEY_INDEX = "index_v1"

    /** 扫系统下载库时最多看多少条记录（防止有人下过上千个文件时启动被拖慢）。 */
    private const val MAX_SCAN = 800

    @Volatile
    private var index: LocalIndex? = null

    @Volatile
    private var source: UriMediaSource? = null

    @Volatile
    private var server: LocalMediaServer? = null

    @Volatile
    private var receiver: BroadcastReceiver? = null

    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "gusi-local-index").apply { isDaemon = true }
    }

    private val main = Handler(Looper.getMainLooper())

    /** 幂等；在 MainActivity.onCreate 调一次。 */
    fun start(context: Context) {
        val app = context.applicationContext
        val idx = index ?: buildIndex(app).also { index = it }
        if (idx.size() > 0) ensureServer(app)
        registerReceiver(app)
        worker.execute {
            val n = rebuildFromDownloadManager(app)
            if (n > 0) ensureServer(app)
        }
    }

    /**
     * JS 线程会同步调这里（`<audio>.src` 的 setter 里），必须快、且不能抛。
     * 返回 null = 用 Web 端原地址（没下载过 / 文件被删了）。
     */
    fun localUrlFor(url: String): String? = try {
        val key = MediaKey.of(url)
        if (key == null) {
            null
        } else {
            val idx = index
            val srv = server
            val src = source
            val e = idx?.get(key)
            if (idx == null || srv == null || src == null || e == null || !srv.running) {
                null
            } else if (!src.exists(e.path)) {
                // 用户在文件管理器里删了 → 索引立即失效，退回网络播放
                idx.removeKey(key)
                null
            } else {
                srv.urlFor(e.id)
            }
        }
    } catch (t: Throwable) {
        Log.w(TAG, "localUrlFor 失败：${t.message}")
        null
    }

    /** 已索引的本地曲目数（诊断用）。 */
    fun count(): Int = index?.size() ?: 0

    fun stop(context: Context) {
        try {
            val r = receiver
            if (r != null) context.applicationContext.unregisterReceiver(r)
        } catch (_: Throwable) {
        }
        receiver = null
        server?.stop()
        server = null
    }

    // ---------------------------------------------------------------- 内部

    private fun buildIndex(app: Context): LocalIndex {
        val sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return LocalIndex(
            read = { sp.getString(KEY_INDEX, null) },
            write = { text -> sp.edit().putString(KEY_INDEX, text).apply() }
        )
    }

    @Synchronized
    private fun ensureServer(app: Context) {
        val idx = index ?: return
        val src = source ?: UriMediaSource(app.applicationContext.contentResolver).also { source = it }
        if (server?.running == true) return
        val srv = LocalMediaServer(
            resolve = { id -> idx.byId(id)?.path },
            source = src,
            token = randomToken()
        )
        val port = srv.start()
        server = srv
        Log.i(TAG, "本地媒体服务已启动：127.0.0.1:$port，索引 ${idx.size()} 首")
    }

    private fun randomToken(): String {
        val b = ByteArray(16)
        SecureRandom().nextBytes(b)
        val sb = StringBuilder(32)
        for (x in b) sb.append(String.format("%02x", x))
        return sb.toString()
    }

    private fun registerReceiver(app: Context) {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: -1L
                if (id < 0) return
                val a = ctx?.applicationContext ?: return
                worker.execute { indexOne(a, id) }
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        try {
            ContextCompat.registerReceiver(app, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            receiver = r
        } catch (t: Throwable) {
            Log.w(TAG, "注册下载完成广播失败：${t.message}")
        }
    }

    /** 启动时重建：DownloadManager 里存着原始请求 URL，能反推回媒体键。 */
    private fun rebuildFromDownloadManager(app: Context): Int {
        val dm = app.getSystemService(DownloadManager::class.java) ?: return 0
        val idx = index ?: return 0
        val desc = app.getString(R.string.dl_desc)
        val out = ArrayList<LocalIndex.New>()
        var cursor: Cursor? = null
        try {
            cursor = dm.query(DownloadManager.Query())
            if (cursor == null) return 0
            val iUrl = cursor.getColumnIndex(DownloadManager.COLUMN_URI)
            val iLocal = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
            val iTitle = cursor.getColumnIndex(DownloadManager.COLUMN_TITLE)
            val iSize = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
            val iDesc = cursor.getColumnIndex(DownloadManager.COLUMN_DESCRIPTION)
            val iStatus = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
            var scanned = 0
            while (cursor.moveToNext() && scanned < MAX_SCAN) {
                scanned++
                if (iDesc < 0 || iStatus < 0 || iUrl < 0 || iLocal < 0) continue
                if (cursor.getString(iDesc) != desc) continue
                if (cursor.getInt(iStatus) != DownloadManager.STATUS_SUCCESSFUL) continue
                val remote = cursor.getString(iUrl) ?: continue
                val local = cursor.getString(iLocal) ?: continue
                val key = MediaKey.of(remote) ?: continue
                val title = if (iTitle >= 0) cursor.getString(iTitle).orEmpty() else ""
                val size = if (iSize >= 0) cursor.getLong(iSize) else -1L
                out.add(LocalIndex.New(key, local, title, size, System.currentTimeMillis()))
            }
        } catch (t: Throwable) {
            Log.w(TAG, "扫系统下载库失败：${t.message}")
            return 0
        } finally {
            try {
                cursor?.close()
            } catch (_: Throwable) {
            }
        }
        if (out.isNotEmpty()) {
            idx.putAll(out)
            Log.i(TAG, "从系统下载库重建索引：${out.size} 首")
        }
        return out.size
    }

    /** 单个下载完成：补进索引（不必等下次启动）。 */
    private fun indexOne(app: Context, downloadId: Long) {
        val dm = app.getSystemService(DownloadManager::class.java) ?: return
        val idx = index ?: return
        val desc = app.getString(R.string.dl_desc)
        var cursor: Cursor? = null
        try {
            cursor = dm.query(DownloadManager.Query().setFilterById(downloadId))
            if (cursor == null || !cursor.moveToFirst()) return
            if (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) != DownloadManager.STATUS_SUCCESSFUL) return
            val iDesc = cursor.getColumnIndex(DownloadManager.COLUMN_DESCRIPTION)
            if (iDesc >= 0 && cursor.getString(iDesc) != desc) return
            val remote = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_URI))
            val local = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
            if (remote == null || local == null) return
            val key = MediaKey.of(remote) ?: return
            val iTitle = cursor.getColumnIndex(DownloadManager.COLUMN_TITLE)
            val iSize = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
            val title = if (iTitle >= 0) cursor.getString(iTitle).orEmpty() else ""
            val size = if (iSize >= 0) cursor.getLong(iSize) else -1L
            idx.put(key, local, title, size)
            main.post { ensureServer(app) }
            Log.i(TAG, "本地索引 +1：$key → $local")
        } catch (t: Throwable) {
            Log.w(TAG, "索引单个下载失败：${t.message}")
        } finally {
            try {
                cursor?.close()
            } catch (_: Throwable) {
            }
        }
    }
}
