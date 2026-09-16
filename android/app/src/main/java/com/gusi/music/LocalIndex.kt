package com.gusi.music

import java.security.MessageDigest

/**
 * 「哪首歌在手机上有一份」的索引。
 *
 * 键是 [MediaKey]（`track:<id>` / `online:<source>/<rid>`），值是落盘位置（file:// 或
 * content:// 字符串，交给 [UriMediaSource] 打开）。用 TSV 持久化而不是 JSON：
 * 这一层要能在纯 JVM 单测里跑（Android 的 org.json 在单测里是空壳），
 * 而 JSON 手写解析比 TSV 更容易出错。
 *
 * 持久化只是**缓存**：真相在系统的 DownloadManager 里（[LocalPlayback] 启动时会重建），
 * 所以这里读坏了、丢了都不影响正确性，最多多查一次系统。这份宽容是故意的：
 * 索引损坏绝不能让 App 起不来。
 */
class LocalIndex(
    private val read: () -> String?,
    private val write: (String) -> Unit,
    private val maxEntries: Int = MAX_ENTRIES
) {

    data class Entry(
        val id: String,
        val key: String,
        val path: String,
        val name: String,
        val size: Long,
        val savedAt: Long
    )

    private val byKey = LinkedHashMap<String, Entry>()

    init {
        parse(read())
    }

    data class New(val key: String, val path: String, val name: String, val size: Long, val savedAt: Long)

    @Synchronized
    fun put(key: String, path: String, name: String, size: Long, savedAt: Long = System.currentTimeMillis()) {
        putInner(New(key, path, name, size, savedAt))
        prune()
        flush()
    }

    /** 批量写入（启动时从系统下载库重建索引）：只落一次盘，别为几百首歌写几百次 SharedPreferences。 */
    @Synchronized
    fun putAll(items: List<New>) {
        for (i in items) putInner(i)
        prune()
        flush()
    }

    private fun putInner(n: New) {
        byKey[n.key] = Entry(id = idOf(n.key), key = n.key, path = n.path, name = n.name, size = n.size, savedAt = n.savedAt)
    }

    @Synchronized
    fun get(key: String): Entry? = byKey[key]

    @Synchronized
    fun byId(id: String): Entry? = byKey.values.firstOrNull { it.id == id }

    @Synchronized
    fun removeKey(key: String) {
        if (byKey.remove(key) != null) flush()
    }

    @Synchronized
    fun size(): Int = byKey.size

    @Synchronized
    fun entries(): List<Entry> = byKey.values.toList()

    /** 超出上限时按最近保存时间淘汰（手机存储有限，不让索引无限长）。 */
    private fun prune() {
        if (byKey.size <= maxEntries) return
        val doomed = byKey.values.sortedByDescending { it.savedAt }.drop(maxEntries)
        for (e in doomed) byKey.remove(e.key)
    }

    private fun flush() {
        try {
            write(serialize())
        } catch (_: Throwable) {
            // 写不进去只影响下次启动的重建速度，不影响播放
        }
    }

    fun serialize(): String = buildString {
        for (e in byKey.values) {
            append(Tsv.esc(e.id)).append('\t')
            append(Tsv.esc(e.key)).append('\t')
            append(Tsv.esc(e.path)).append('\t')
            append(Tsv.esc(e.name)).append('\t')
            append(e.size).append('\t')
            append(e.savedAt).append('\n')
        }
    }

    private fun parse(text: String?) {
        if (text.isNullOrEmpty()) return
        for (line in text.lineSequence()) {
            if (line.isBlank()) continue
            val f = line.split('\t')
            if (f.size < 6) continue
            val size = f[4].toLongOrNull() ?: continue
            val savedAt = f[5].toLongOrNull() ?: 0L
            val e = Entry(Tsv.unesc(f[0]), Tsv.unesc(f[1]), Tsv.unesc(f[2]), Tsv.unesc(f[3]), size, savedAt)
            if (e.id.isEmpty() || e.key.isEmpty() || e.path.isEmpty()) continue
            byKey[e.key] = e
        }
    }

    companion object {
        private const val MAX_ENTRIES = 200

        /**
         * 键 → URL 安全的短 id。同一首歌无论从 stream 还是 download 路径来，键相同、id 也相同，
         * 所以 Web 端重排 URL（换 token）不会让已经发出去的本地地址失效。
         */
        fun idOf(key: String): String {
            val md = MessageDigest.getInstance("SHA-1")
            val d = md.digest(key.toByteArray(Charsets.UTF_8))
            val sb = StringBuilder(16)
            for (i in 0 until 8) sb.append(String.format("%02x", d[i]))
            return sb.toString()
        }
    }
}
