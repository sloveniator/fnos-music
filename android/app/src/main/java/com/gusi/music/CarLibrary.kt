package com.gusi.music

import org.json.JSONArray
import org.json.JSONObject

/**
 * 车机（Android Auto / Android Automotive）需要的「可浏览曲库」结构。
 *
 * 这里放两件事，都是纯逻辑（可 JVM 单测，不需要真车）：
 *  1. 服务端 `/web/api/tracks`、`/web/api/albums` 的 JSON → 车机端的树
 *     （根 → 「全部歌曲」/「专辑」→ 某张专辑的曲目）；
 *  2. 树上某一项 → 交给 Web 播放器的一份「列表 + 下标」。
 *
 * **为什么播放要绕回 Web 播放器**：车机上点一首歌，出声的必须是同一个播放器
 * （WebView 里的 `window.__player`）。壳若自己起一套播放，手机会立刻出现两份状态 ——
 * 通知栏、C3 的续播记忆、C1 的离线本地文件替换全都对不上。
 *
 * 交给 Web 的曲目对象**原样透传服务端返回的那一份**（与 Web 端列表里的对象同源）：
 * 播放器靠 `t.id` 取流、`t.name/singer/album` 显示、`t.kind` 区分在线/本地，
 * 自己另拼一套字段迟早会漂。
 */
object CarLibrary {

    /** 车机端的根节点 id */
    const val ROOT_ID = "root"

    /** 根下的两个固定分组 */
    const val GROUP_TRACKS = "tracks"
    const val GROUP_ALBUMS = "albums"

    const val TRACK_PREFIX = "t:"
    const val ALBUM_PREFIX = "al:"

    /**
     * 专辑 id 里的分隔符：用不可见控制字符，而不是 `|`。
     * 专辑接口给的是 `key = 歌手||专辑`，但歌手名里本来就可能出现 `|`，
     * 用可见字符做分隔再 split 会串味（「A|B」的歌手 + 「C」的专辑会被解析成两段都不对）。
     */
    const val SEP = '\u0001'

    /** 一次最多列给车机多少条（服务端单页上限 200；车机 UI 也不适合更长的列表） */
    const val MAX_CHILDREN = 200

    /** 车机列表里的一项。browsable = 能进去（文件夹），playable = 点了就放（含「从这里开始放」）。 */
    data class Item(
        val mediaId: String,
        val title: String,
        val subtitle: String,
        val browsable: Boolean,
        val playable: Boolean
    )

    /**
     * 交给 Web 播放器的播放计划。
     *
     * [jsArg] 是一段 **JS 对象字面量**（不是字符串）：壳把它塞进
     * `window.__gusiCmd('playlist', <jsArg>)`。JSON 是 JS 字面量的子集，所以直接拼。
     */
    data class PlayPlan(val jsArg: String, val count: Int, val index: Int)

    // ------------------------------------------------------------ id 编解码

    fun trackMediaId(id: String): String = TRACK_PREFIX + id

    fun isTrack(mediaId: String): Boolean = mediaId.startsWith(TRACK_PREFIX)

    fun albumMediaId(singer: String, album: String): String =
        ALBUM_PREFIX + singer + SEP + album

    fun isAlbum(mediaId: String): Boolean = mediaId.startsWith(ALBUM_PREFIX)

    /** 专辑 id → (歌手, 专辑)；格式不对返回 null（车机传来的东西不能假设可信）。 */
    fun albumOf(mediaId: String): Pair<String, String>? {
        if (!isAlbum(mediaId)) return null
        val body = mediaId.substring(ALBUM_PREFIX.length)
        val at = body.indexOf(SEP)
        if (at < 0) return null
        return body.substring(0, at) to body.substring(at + 1)
    }

    // ------------------------------------------------------------ 树

    fun rootChildren(): List<Item> = listOf(
        Item(GROUP_TRACKS, "全部歌曲", "从头开始播放", browsable = false, playable = true),
        Item(GROUP_ALBUMS, "专辑", "", browsable = true, playable = false)
    )

    /**
     * 全部歌曲 → 车机列表项。
     *
     * 副标题用「歌手 · 专辑」：车机上司机只看一眼，歌手比专辑更常用；专辑名放在后面
     * 能顺便区分同名歌（同一首歌在两张专辑里各有一份是很常见的）。
     */
    fun tracksChildren(tracksJson: String): List<Item> =
        trackObjects(tracksJson).take(MAX_CHILDREN).map { t ->
            val name = t.optString("name").ifBlank { "（未命名）" }
            Item(
                mediaId = trackMediaId(t.optString("id")),
                title = name,
                subtitle = subtitleOf(t),
                browsable = false,
                playable = true
            )
        }

    /** 专辑分组 → 车机列表项（每张专辑是可进去的文件夹）。 */
    fun albumsChildren(albumsJson: String): List<Item> {
        val arr = dataArray(albumsJson, "albums")
        val out = ArrayList<Item>(minOf(arr.length(), MAX_CHILDREN))
        for (i in 0 until arr.length()) {
            if (out.size >= MAX_CHILDREN) break
            val a = arr.optJSONObject(i) ?: continue
            val singer = a.optString("singer")
            val album = a.optString("name")
            if (album.isBlank() && singer.isBlank()) continue
            val count = a.optInt("count", 0)
            out.add(
                Item(
                    mediaId = albumMediaId(singer, album),
                    title = album.ifBlank { "（未知专辑）" },
                    subtitle = listOf(singer.ifBlank { "未知歌手" }, if (count > 0) "$count 首" else "")
                        .filter { it.isNotEmpty() }.joinToString(" · "),
                    browsable = true,
                    playable = false
                )
            )
        }
        return out
    }

    /**
     * 某张专辑下的曲目。
     * 专辑接口（`/web/api/album`）返回的 `tracks` 已经是该专辑的曲目（服务端按歌手+专辑过滤好了），
     * 这里再做一次过滤是为了防服务端换实现：宁可少列几首，也不要把别的专辑混进这张里。
     */
    fun albumTracksChildren(albumTracksJson: String, singer: String, album: String): List<Item> =
        albumTracks(albumTracksJson, singer, album)
            .take(MAX_CHILDREN)
            .map { t ->
                val name = t.optString("name").ifBlank { "（未命名）" }
                Item(
                    mediaId = trackMediaId(t.optString("id")),
                    title = name,
                    subtitle = subtitleOf(t),
                    browsable = false,
                    playable = true
                )
            }

    // ------------------------------------------------------------ 播放计划

    /** 「全部歌曲」：从头放。曲库为空返回 null（车机点了个空文件夹，不该假装在播）。 */
    fun playAll(tracksJson: String): PlayPlan? = planOf(trackObjects(tracksJson), 0)

    /** 专辑：从这张专辑第一首开始放。 */
    fun playAlbum(albumTracksJson: String, singer: String, album: String): PlayPlan? =
        planOf(albumTracks(albumTracksJson, singer, album), 0)

    /**
     * 单曲：在给定列表里定位它的下标，从这首开始顺放。
     *
     * 队列用哪一份列表很重要：车机在专辑页里点一首，队列就该是**这张专辑**
     * （放完接着下一首），而不是「全部歌曲」的第一页。所以调用方拿到专辑的列表就传专辑的，
     * 只有不知道它属于哪张专辑时才退化成全库。
     */
    fun playTrack(tracksJson: String, trackId: String): PlayPlan? {
        val list = trackObjects(tracksJson)
        val idx = list.indexOfFirst { it.optString("id") == trackId }
        return if (idx < 0) null else planOf(list, idx)
    }

    /** 专辑接口给的曲目（已按歌手/专辑过滤）。 */
    private fun albumTracks(albumTracksJson: String, singer: String, album: String): List<JSONObject> =
        trackObjects(albumTracksJson).filter { t ->
            (singer.isBlank() || t.optString("singer") == singer) &&
                (album.isBlank() || t.optString("album") == album)
        }

    // ------------------------------------------------------------ JSON 容错

    /**
     * `data.tracks` 里的曲目对象列表；字段缺失/整段异常一律退化成空，不让车机崩。
     *
     * 没有 `id` 的条目直接丢掉：播放器靠 `id` 取流，列出来只会有个「点了没反应」的行。
     */
    fun trackObjects(tracksJson: String): List<JSONObject> {
        val arr = dataArray(tracksJson, "tracks")
        val out = ArrayList<JSONObject>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString("id").isBlank()) continue
            out.add(o)
        }
        return out
    }

    private fun subtitleOf(t: JSONObject): String = listOf(
        t.optString("singer").ifBlank { "未知歌手" },
        t.optString("album")
    ).filter { it.isNotBlank() }.joinToString(" · ")

    private fun dataArray(json: String, field: String): JSONArray = try {
        JSONObject(json).optJSONObject("data")?.optJSONArray(field) ?: JSONArray()
    } catch (t: Throwable) {
        JSONArray()
    }

    private fun planOf(list: List<JSONObject>, index: Int): PlayPlan? {
        if (list.isEmpty()) return null
        val i = index.coerceIn(0, list.size - 1)
        val arg = JSONObject().apply {
            put("i", i)
            put("list", JSONArray(list as Collection<*>))
        }
        return PlayPlan(arg.toString(), list.size, i)
    }
}
