package com.gusi.music

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * 车机曲库的数据层：取服务端 JSON（内存缓存）→ 用 [CarLibrary] 变成车机要的树/播放计划。
 *
 * 为什么单独一层：[CarLibrary] 是纯逻辑（可单测），这一层只依赖一个 `fetch(path)` 函数 ——
 * 真机上是带登录令牌的 HTTP，单测里换成夹具就能把「缓存策略、专辑页回退、
 * 点单曲时队列该是哪张专辑」全测掉，不用起服务、不用连网。
 *
 * 上层两个使用者：
 *  - [CarMediaService]（浏览）：车机连上来要一棵树；
 *  - [PlaybackService] 的 session 回调（点播）：车机选了某一项，要一份播放计划。
 *    两者必须共用同一个实例 —— 「这歌属于哪张专辑」是浏览时才知道的，点播时才用得上。
 */
class CarSource(
    private val fetch: (String) -> String,
    private val loggedIn: () -> Boolean = { WebSession.loggedIn }
) {

    /** key = "tracks" / "albums" / 专辑 mediaId 的缓存。 */
    private val cache = HashMap<String, String>()

    /**
     * 「这首歌是从哪张专辑里看到的」→ 专辑 mediaId。
     *
     * 用来决定点一首歌时队列是什么：车机在专辑页点第 3 首，队列必须是**那张专辑**
     * （放完接第 4 首），而不是「全部歌曲」的第一页。不知道属于哪张专辑时才退回全库。
     */
    private val trackAlbum = HashMap<String, String>()

    /** 最近一次失败原因（HTTP 码/网络异常），用来给车机一行像样的提示。 */
    @Volatile
    var lastError: String? = null
        private set

    // ------------------------------------------------------------ 浏览

    /** 某一层节点的子项。空树/失败都会给一行「为什么这里是空的」而不是空列表。 */
    fun children(parentId: String): List<CarLibrary.Item> {
        if (!loggedIn()) {
            return listOf(hint("请先在手机上打开古四音乐", "登录之后，曲库会出现在这里"))
        }

        val items: List<CarLibrary.Item> = when (parentId) {
            CarLibrary.ROOT_ID -> CarLibrary.rootChildren()
            CarLibrary.GROUP_TRACKS -> CarLibrary.tracksChildren(tracksJson())
            CarLibrary.GROUP_ALBUMS -> CarLibrary.albumsChildren(albumsJson())
            else -> CarLibrary.albumOf(parentId)?.let { (singer, album) ->
                val json = albumJson(singer, album)
                // 记下这批曲目属于哪张专辑，点单曲时才知道队列该是这张专辑
                CarLibrary.trackObjects(json).forEach { t ->
                    val id = t.optString("id")
                    if (id.isNotEmpty()) trackAlbum[id] = parentId
                }
                CarLibrary.albumTracksChildren(json, singer, album)
            } ?: emptyList()
        }

        if (items.isNotEmpty()) return items

        val why = lastError
        return listOf(
            when {
                why != null -> hint("曲库读不出来", why)
                CarLibrary.isAlbum(parentId) -> hint("这张专辑里没有曲目", "可能刚被删空")
                else -> hint("曲库是空的", "先在电脑或手机上往曲库里加歌")
            }
        )
    }

    // ------------------------------------------------------------ 点播

    /** 车机点了某一项的播放计划；放不了（空曲库/找不到）返回 null，不假装在播。 */
    fun plan(mediaId: String): CarLibrary.PlayPlan? = when {
        // 「全部歌曲」本身也是可播放项：点一下就从第一首放起
        mediaId == CarLibrary.GROUP_TRACKS -> CarLibrary.playAll(tracksJson())

        CarLibrary.isTrack(mediaId) -> {
            val id = mediaId.removePrefix(CarLibrary.TRACK_PREFIX)
            // 在专辑页点过它 → 队列是那张专辑；否则（全部歌曲页）退化成第一页全库
            val inAlbum = trackAlbum[id]?.let { albumId ->
                CarLibrary.albumOf(albumId)?.let { (singer, album) ->
                    CarLibrary.playTrack(albumJson(singer, album), id)
                }
            }
            inAlbum ?: CarLibrary.playTrack(tracksJson(), id)
        }

        CarLibrary.isAlbum(mediaId) -> CarLibrary.albumOf(mediaId)?.let { (singer, album) ->
            CarLibrary.playAlbum(albumJson(singer, album), singer, album)
        }

        else -> null
    }

    // ------------------------------------------------------------ 取数

    private fun tracksJson(): String = cached(CarLibrary.GROUP_TRACKS) {
        fetch("/web/api/tracks?size=${CarLibrary.MAX_CHILDREN}")
    }

    private fun albumsJson(): String = cached(CarLibrary.GROUP_ALBUMS) {
        fetch("/web/api/albums?size=${CarLibrary.MAX_CHILDREN}")
    }

    /**
     * 某张专辑的曲目：走 `/web/api/album`，而不是从「全部歌曲第一页」里筛。
     * 后者在曲库超过一页时会把歌筛没（专辑里的歌散在第 2 页之后就一首都不剩）。
     */
    private fun albumJson(singer: String, album: String): String {
        val key = CarLibrary.albumMediaId(singer, album)
        return cached(key) {
            fetch("/web/api/album?singer=${enc(singer)}&album=${enc(album)}")
        }
    }

    /** 成功才进缓存：网络抖一下不该变成「曲库空了」，用户得重启 App 才好。 */
    private fun cached(key: String, load: () -> String): String {
        cache[key]?.let { return it }
        val json = try {
            load()
        } catch (t: Throwable) {
            lastError = t.message ?: "网络异常"
            return ""
        }
        if (json.isEmpty()) {
            // 空响应也是失败（代理截断、服务端抽风），别读成「你的曲库是空的」：
            // 那会让用户去曲库里反复找原因，实际该看网络。
            lastError = "服务端没有返回数据"
            return ""
        }
        lastError = null
        cache[key] = json
        return json
    }

    private fun hint(title: String, subtitle: String) =
        CarLibrary.Item(HINT_PREFIX + title, title, subtitle, browsable = false, playable = false)

    companion object {
        const val HINT_PREFIX = "hint:"

        /**
         * 车机相关的取数都走这一个线程，串行就够了（车机一次点一项、一次展开一层）。
         * 它是守护线程：进程退出时不会被它拖着。
         */
        private val io = Executors.newSingleThreadExecutor { r ->
            Thread(r, "gusi-car-io").apply { isDaemon = true }
        }

        @Volatile
        private var shared: CarSource? = null

        /**
         * 进程内唯一的车机数据源。
         *
         * 必须是同一个：浏览时才会知道「这首属于哪张专辑」，点播时要用这条信息决定队列；
         * 浏览服务与播放服务是两个不同的实例，共用一个 source 才能对上。
         */
        fun shared(context: Context): CarSource {
            shared?.let { return it }
            return synchronized(this) {
                shared ?: remote(context).also { shared = it }
            }
        }

        /** 真机上的实现：带 WebView 那份登录令牌去服务端取；失败抛异常（由 [cached] 记成 lastError）。 */
        fun remote(context: Context): CarSource {
            val app = context.applicationContext
            return CarSource(fetch = { path ->
                val base = Prefs(app).baseUrl
                if (base.isEmpty()) throw IllegalStateException("还没配置服务器地址")
                val token = WebSession.token
                if (token.isNullOrBlank()) throw IllegalStateException("还没有登录令牌")
                httpGet(base + path, token)
            })
        }

        /**
         * 异步取播放计划。车机的点播回调在主线程，绝不能在这里等网络。
         * 拿到计划后由调用方送进 WebView（`__gusiCmd('playlist', …)`）。
         */
        fun planAsync(context: Context, mediaId: String, onPlan: (CarLibrary.PlayPlan?) -> Unit) {
            val source = shared(context)
            io.execute { onPlan(runCatching { source.plan(mediaId) }.getOrNull()) }
        }

        /**
         * 异步取某一层的子项（浏览用）。`onLoadChildren` 必须先在主线程 `detach()` 再回结果，
         * 取数放到这里做，就不会把车机的浏览界面卡住。
         */
        fun childrenAsync(
            context: Context,
            parentId: String,
            onItems: (List<CarLibrary.Item>) -> Unit
        ) {
            val source = shared(context)
            io.execute { onItems(runCatching { source.children(parentId) }.getOrDefault(emptyList())) }
        }

        private fun httpGet(url: String, token: String): String {
            var conn: HttpURLConnection? = null
            try {
                // 注意是 openConnection() 之后再转型：`URL(...) as HttpURLConnection` 转的是
                // URL 对象本身（URL 是 final 类），运行到这一步必然 ClassCastException，
                // 表现成「曲库永远是空的」——编译器当时也只是给了个 warning，容易漏。
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    setRequestProperty("X-Web-Token", token)
                    setRequestProperty("Accept", "application/json")
                    connectTimeout = 6000
                    readTimeout = 10000
                }
                val code = conn.responseCode
                if (code != 200) throw IllegalStateException("HTTP $code")
                return conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            } finally {
                conn?.disconnect()
            }
        }

        private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
    }
}
