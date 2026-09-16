package com.gusi.music

/**
 * 「上次听到哪了」。
 *
 * 键是「曲名 + 歌手」而不是曲目 id：壳只看得到 Web 端推来的这几个字段（`#np-name` /
 * `#np-singer`），拿不到曲库 id —— 而曲名+歌手在「同一台 NAS 上的同一批曲目」里足够唯一。
 * 代价是同一首歌换了标签写法就会被当新的一首（记住两份，不会出错，只是偶尔不续播）。
 *
 * 三档阈值都是故意的：
 *  - 播不到 3 秒不记（误触、切歌路过）；
 *  - 播不到 15 秒不续播（用户大概不觉得这算「听过」）；
 *  - 距离结尾 15 秒内算听完 → 删记录（下次从头放，而不是卡在最后两秒）。
 */
class PlaybackMemory(
    private val read: () -> String?,
    private val write: (String) -> Unit,
    private val maxEntries: Int = MAX_ENTRIES
) {

    data class Entry(val key: String, val positionMs: Long, val durationMs: Long, val updatedAt: Long)

    private val byKey = LinkedHashMap<String, Entry>()

    init {
        parse(read())
    }

    @Synchronized
    fun put(key: String, positionMs: Long, durationMs: Long, updatedAt: Long = System.currentTimeMillis()) {
        if (key.isEmpty()) return
        byKey[key] = Entry(key, positionMs.coerceAtLeast(0L), durationMs, updatedAt)
        prune()
        flush()
    }

    @Synchronized
    fun get(key: String): Entry? = byKey[key]

    @Synchronized
    fun remove(key: String) {
        if (byKey.remove(key) != null) flush()
    }

    @Synchronized
    fun size(): Int = byKey.size

    private fun prune() {
        if (byKey.size <= maxEntries) return
        val doomed = byKey.values.sortedByDescending { it.updatedAt }.drop(maxEntries)
        for (e in doomed) byKey.remove(e.key)
    }

    private fun flush() {
        try {
            write(serialize())
        } catch (_: Throwable) {
            // 记不住位置不影响播放
        }
    }

    fun serialize(): String = buildString {
        for (e in byKey.values) {
            append(Tsv.esc(e.key)).append('\t')
            append(e.positionMs).append('\t')
            append(e.durationMs).append('\t')
            append(e.updatedAt).append('\n')
        }
    }

    private fun parse(text: String?) {
        if (text.isNullOrEmpty()) return
        for (line in text.lineSequence()) {
            if (line.isBlank()) continue
            val f = line.split('\t')
            if (f.size < 4) continue
            val pos = f[1].toLongOrNull() ?: continue
            val dur = f[2].toLongOrNull() ?: 0L
            val at = f[3].toLongOrNull() ?: 0L
            val key = Tsv.unesc(f[0])
            if (key.isEmpty()) continue
            byKey[key] = Entry(key, pos, dur, at)
        }
    }

    companion object {
        private const val MAX_ENTRIES = 300

        /** 播不到这里不值得记 */
        const val MIN_SAVE_MS = 3_000L

        /** 少于这个时长不续播（用户不觉得算听过） */
        const val MIN_RESUME_MS = 15_000L

        /** 距结尾这么近 = 听完了：删记录，下次从头 */
        const val TAIL_MS = 15_000L

        /**
         * 键 = 曲名 + 歌手。
         *
         * 用不可见控制字符当分隔符（而不是 `/`、`空格`、`-`）：正常曲名里就带这些，
         * 一旦撞车就会「A 歌的进度跑到 B 歌上」——比不续播糟糕得多。
         * 唯一残留的理论风险是曲名标签里真的含 `\u0001`，实际上不存在。
         */
        fun keyOf(title: String, artist: String): String {
            val t = title.trim()
            if (t.isEmpty()) return ""
            return t + '\u0001' + artist.trim()
        }

        /**
         * 该从哪儿接着播；返回 <=0 表示从头播。
         *
         * @param entry 上次记录（可能没有）
         * @param durationMs 本次上报的时长；<=0（还没拿到元数据/直播流）时退回记录里的时长
         */
        fun resumePoint(entry: Entry?, durationMs: Long): Long {
            if (entry == null) return -1L
            val dur = if (durationMs > 0) durationMs else entry.durationMs
            if (dur <= 0) return -1L                    // 时长未知（直播流）：位置没有意义
            if (entry.positionMs < MIN_RESUME_MS) return -1L
            if (entry.positionMs >= dur - TAIL_MS) return -1L   // 上次已经听到结尾
            return if (entry.positionMs >= dur) -1L else entry.positionMs
        }

        /** 当前位置是否已经算「听完」。 */
        fun finished(positionMs: Long, durationMs: Long): Boolean =
            durationMs > 0 && positionMs >= durationMs - TAIL_MS
    }
}
