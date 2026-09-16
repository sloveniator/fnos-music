package com.gusi.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.util.LruCache
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * 后台播放保活 + 通知栏/锁屏播放控制。
 *
 * 设计要点（都是 WebView 壳绕不开的现实）：
 *  - **不自己播音频**。WebView 里的 HTMLAudioElement 才是唯一播放器；本服务只做两件事：
 *    拖住进程不被系统回收（前台服务 + PARTIAL_WAKE_LOCK），以及把系统侧的
 *    播放指令（通知栏按钮、锁屏、耳机线控）转发给 WebView 的 __player。
 *  - **不为「没在播」的曲目起服务**：收到空标题且未播放的状态时只更新会话，不 startForeground。
 *  - 暂停后保留通知一段时间（PAUSE_KEEP_MS）方便回听，超时自动收摊，避免常驻后台。
 */
class PlaybackService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var session: MediaSessionCompat? = null
    private var wakeLock: PowerManager.WakeLock? = null

    /** 当前 WakeLock 的起租时刻（0 = 没有锁）；用于判断该不该续租 */
    private var wakeAcquiredAt = 0L

    private var playing = false
    private var buffering = false
    private var title = ""
    private var artist = ""
    private var durationMs = 0L
    private var positionMs = 0L

    /** 最后一次状态上报的时刻（elapsedRealtime 基准）；通知栏算「此刻位置」要用它。 */
    private var stateAtElapsedMs = SystemClock.elapsedRealtime()

    // ---- 续播位置记忆（C3）----
    private var memory: PlaybackMemory? = null

    /** 当前曲目的记忆键（曲名 + 歌手）；空串 = 没有曲目 */
    private var trackKey = ""
    private var lastSavedAt = 0L
    private var lastSavedPos = -1L

    /** 本次进程里已经处理过续播的曲目，避免每次状态上报都 seek 一次 */
    private var resumedKey = ""

    private var coverUrl = ""
    private var art: Bitmap? = null
    private var lastNotified = 0L
    private var foregroundStarted = false

    private val artCache = LruCache<String, Bitmap>(12)
    private val artExecutor = Executors.newSingleThreadExecutor()

    private val stopRunnable = Runnable { shutdown() }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        session = MediaSessionCompat(this, "gusi-music").apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    BridgeHolder.send("play")
                }

                override fun onPause() {
                    BridgeHolder.send("pause")
                }

                override fun onSkipToNext() {
                    BridgeHolder.send("next")
                }

                override fun onSkipToPrevious() {
                    BridgeHolder.send("prev")
                }

                override fun onSeekTo(pos: Long) {
                    BridgeHolder.send("seek", (pos / 1000.0).toString())
                }

                override fun onFastForward() = seekBy(Transport.SEEK_STEP_MS)

                override fun onRewind() = seekBy(-Transport.SEEK_STEP_MS)

                override fun onStop() {
                    BridgeHolder.send("pause")
                    shutdown()
                }
            })
            isActive = true
        }
        // 进程被系统重建时，先把最后一次已知状态贴回来，通知栏不会空白
        lastStateJson?.let { applyState(it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            Intent.ACTION_MEDIA_BUTTON -> session?.let { MediaButtonReceiver.handleIntent(it, intent) }
            ACTION_STOP -> {
                BridgeHolder.send("pause")
                shutdown()
                return START_NOT_STICKY
            }
        }
        // 必须在 5 秒内进入前台，否则系统会 ANR 掉这个服务
        ensureForeground()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        releaseWakeLock()
        session?.isActive = false
        session?.release()
        session = null
        artExecutor.shutdownNow()
        instance = null
        super.onDestroy()
    }

    // ---------------------------------------------------------------- 状态入口

    private fun applyState(json: String) {
        val o = try {
            JSONObject(json)
        } catch (t: Throwable) {
            Log.w(TAG, "状态 JSON 解析失败：$json", t)
            return
        }

        val newTitle = o.optString("title", "")
        val newArtist = o.optString("artist", "")
        val newKey = PlaybackMemory.keyOf(newTitle, newArtist)

        // 换曲了：先把**上一首**的最后位置落盘 —— 此刻各字段里还都是上一首的值，
        // 晚一行就变成拿新曲目的 position 覆盖旧曲目的记录了
        if (newKey != trackKey) {
            saveProgress(force = true)
            trackKey = newKey
            lastSavedAt = 0L
            lastSavedPos = -1L
        }

        val wasPlaying = playing
        val wasTitle = title
        val wasBuffering = buffering
        playing = o.optBoolean("playing", false)
        buffering = o.optBoolean("buffering", false)
        title = newTitle
        artist = newArtist
        durationMs = o.optLong("duration", 0L)
        positionMs = o.optLong("position", 0L)
        // 「这个位置是什么时候的」：Web 端给的是墙钟毫秒，换算到 elapsedRealtime 基准，
        // 再交给系统去外推。没有这行，通知栏进度条永远比实际慢一拍。
        val atWall = o.optLong("at", 0L)
        stateAtElapsedMs = if (atWall > 0) {
            val age = (System.currentTimeMillis() - atWall).coerceIn(0L, Transport.MAX_SKEW_MS)
            SystemClock.elapsedRealtime() - age
        } else {
            SystemClock.elapsedRealtime()
        }
        val newCover = o.optString("cover", "")

        // 没有任何曲目、也没在播 —— 收掉通知，别挂一个空壳
        if (title.isEmpty() && !playing) {
            if (foregroundStarted) shutdown()
            return
        }

        if (newCover != coverUrl) {
            coverUrl = newCover
            art = artCache.get(newCover)
            if (art == null && newCover.isNotEmpty()) loadArt(newCover)
        }

        pushSessionState()
        // 曲目/播放态/缓冲态变了立刻重画通知，其余情况节流
        maybeReNotify(force = wasPlaying != playing || wasTitle != title || wasBuffering != buffering)

        // 续播记忆：暂停的那一刻立刻落盘（用户多半就是从这儿离开的），播放中按间隔落盘
        saveProgress(force = wasPlaying && !playing)
        maybeResume()

        // 播放中拖住系统（前台服务 + WakeLock）；暂停后给用户留一段时间能回来接着听
        handler.removeCallbacks(stopRunnable)
        if (playing) {
            acquireWakeLock()
        } else {
            releaseWakeLock()
            handler.postDelayed(stopRunnable, PAUSE_KEEP_MS)
        }
    }

    private fun pushSessionState() {
        val s = session ?: return
        val meta = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
        art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(meta.build())

        // 缓冲中要单独报：系统会把进度条停下并画个转圈，而不是让条子继续往前跑
        val state = when {
            playing && buffering -> PlaybackStateCompat.STATE_BUFFERING
            playing -> PlaybackStateCompat.STATE_PLAYING
            else -> PlaybackStateCompat.STATE_PAUSED
        }
        val speed = if (playing && !buffering) 1f else 0f
        s.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions())
                // updateTime 用「上报时刻」而不是 now：位置和时刻必须是同一瞬间的两个值
                .setState(state, positionMs, speed, stateAtElapsedMs)
                .build()
        )
    }

    /**
     * 会话能力位。     *
     * Android 13+ 的通知栏（系统自带媒体控件）就是读这里决定「要不要画可拖动的进度条」：
     * 需要 duration（元数据里）+ ACTION_SEEK_TO + STATE_PLAYING/PAUSED 同时成立。
     * ±30 秒则只在有时长时才给（直播流跳 30 秒没有意义）。
     */
    private fun actions(): Long {
        var a = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_SEEK_TO or
            PlaybackStateCompat.ACTION_STOP
        if (durationMs > 0) {
            a = a or PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND
        }
        return a
    }

    /** 通知栏/锁屏要「从现在起 ±30 秒」时，基准必须是此刻位置，而不是上次上报的位置。 */
    private fun currentPositionMs(): Long = Transport.positionNow(
        positionMs = positionMs,
        playing = playing,
        atElapsedMs = stateAtElapsedMs,
        nowElapsedMs = SystemClock.elapsedRealtime(),
        durationMs = durationMs
    )

    private fun seekBy(deltaMs: Long) {
        val target = Transport.seekTarget(currentPositionMs(), deltaMs, durationMs)
        BridgeHolder.send("seek", (target / 1000.0).toString())
    }

    // ---------------------------------------------------------------- 续播位置记忆（C3）

    private fun memoryStore(): PlaybackMemory {
        memory?.let { return it }
        val sp = getSharedPreferences(PREFS_RESUME, MODE_PRIVATE)
        val m = PlaybackMemory(
            read = { sp.getString(KEY_RESUME, null) },
            write = { t -> sp.edit().putString(KEY_RESUME, t).apply() }
        )
        memory = m
        return m
    }

    /**
     * 落盘当前进度（默认节流）。
     *
     * 只在时长已知时才记：电台直播流的「听到第 62 秒」没有意义，下次接上也是另一段内容。
     */
    private fun saveProgress(force: Boolean) {
        if (trackKey.isEmpty() || durationMs <= 0) return
        val pos = positionMs
        if (pos < PlaybackMemory.MIN_SAVE_MS) return
        val now = System.currentTimeMillis()
        if (!force && now - lastSavedAt < SAVE_INTERVAL_MS && abs(pos - lastSavedPos) < SAVE_MIN_DELTA_MS) return
        lastSavedAt = now
        lastSavedPos = pos
        val m = memoryStore()
        if (PlaybackMemory.finished(pos, durationMs)) {
            m.remove(trackKey)      // 已经听到结尾：下次从头放，而不是卡在最后两秒
        } else {
            m.put(trackKey, pos, durationMs, now)
        }
    }

    /** 曲目第一次带着时长上报时，问一句「上次听到哪了」。 */
    private fun maybeResume() {
        if (trackKey.isEmpty() || trackKey == resumedKey) return
        // 还没拿到时长：等下一次上报。这里不钉 resumedKey —— 元数据到达前的状态上报不该
        // 把「续播」这个机会用掉
        if (durationMs <= 0) return
        val point = PlaybackMemory.resumePoint(memoryStore().get(trackKey), durationMs)
        resumedKey = trackKey
        if (point <= 0) return
        if (BridgeHolder.send("seek", (point / 1000.0).toString())) {
            Toast.makeText(this, getString(R.string.resume_toast, Transport.clock(point)), Toast.LENGTH_SHORT).show()
        }
    }

    /** 通知栏不需要每秒重画：曲目/播放态变了立刻重画，否则最多 5 秒一次（进度用 setProgress 体现）。 */
    private fun maybeReNotify(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && now - lastNotified < NOTIFY_MIN_INTERVAL_MS) return
        lastNotified = now
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val n = buildNotification()
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
            != android.content.pm.PackageManager.PERMISSION_GRANTED && Build.VERSION.SDK_INT >= 33
        ) {
            // 没有通知权限时仍然 startForeground（服务照常保活），只是系统不显示
            Log.i(TAG, "通知权限未授予，仅保持前台服务")
        }
        nm.notify(NOTIF_ID, n)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, PlaybackService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val prev = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
        val toggle = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this,
            if (playing) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY
        )
        val next = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)
        val rewind = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_REWIND)
        val forward = MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_FAST_FORWARD)

        val style = MediaStyle()
            .setMediaSession(session?.sessionToken)
            .setShowActionsInCompactView(0, 1, 2)
            .setShowCancelButton(true)
            .setCancelButtonIntent(stop)

        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(title.ifEmpty { getString(R.string.notif_unknown_track) })
            .setContentText(artist)
            .setContentIntent(open)
            .setDeleteIntent(stop)
            .setStyle(style)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .addAction(R.drawable.ic_notif_prev, getString(R.string.notif_prev), prev)
            .addAction(
                if (playing) R.drawable.ic_notif_pause else R.drawable.ic_notif_play,
                getString(if (playing) R.string.notif_pause else R.string.notif_play),
                toggle
            )
            .addAction(R.drawable.ic_notif_next, getString(R.string.notif_next), next)

        // 展开后的第 4、5 颗（compact view 仍是 0/1/2 = 上一首/播放暂停/下一首）。
        // 只在有时长时给：Android 13 以下系统不给媒体通知画进度条，这两颗按钮就是「跳着听」的唯一入口。
        if (durationMs > 0) {
            b.addAction(R.drawable.ic_notif_rew, getString(R.string.notif_rewind), rewind)
            b.addAction(R.drawable.ic_notif_ff, getString(R.string.notif_forward), forward)
        }

        if (durationMs > 0) {
            // 老式媒体通知的进度条：位置按「此刻」算，和交给系统的 updateTime 同一口径
            val pos = currentPositionMs()
            b.setProgress(1000, ((pos * 1000) / durationMs).toInt().coerceIn(0, 1000), false)
        }
        art?.let { b.setLargeIcon(it) }
        return b.build()
    }

    private fun ensureForeground() {
        val n = buildNotification()
        try {
            ServiceCompat.startForeground(
                this, NOTIF_ID, n,
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
            )
            foregroundStarted = true
        } catch (t: Throwable) {
            // Android 12+ 从后台启动前台服务会被拒；此时不 crash，等用户回到 App 再继续
            Log.w(TAG, "startForeground 失败（可能处于后台启动限制）", t)
        }
        if (playing) acquireWakeLock()
    }

    /**
     * 播放中拖住 CPU。
     *
     * 只租 [WAKELOCK_TIMEOUT_MS] 一段，播放中的每次状态推送（applyState）都会来续租，
     * 而 Web 端的 timeupdate 被节流到 900ms、远密于续租阈值。
     * 这样即使 Web 端脚本卡死、状态永远停在「播放中」，系统最多替我们多撑一个租期，
     * 不会留下永久 WakeLock 把电池吃干（lint 的 WakelockTimeout 说的就是这个）。
     */
    private fun acquireWakeLock() {
        val held = wakeLock?.isHeld == true
        if (held && System.currentTimeMillis() - wakeAcquiredAt < WAKELOCK_TIMEOUT_MS - WAKE_RENEW_MARGIN_MS) return
        if (held) releaseWakeLock()          // 租期将尽：换一个新的，而不是让锁到期后掉线
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gusi:playback").apply {
            setReferenceCounted(false)
            try {
                acquire(WAKELOCK_TIMEOUT_MS)
                wakeAcquiredAt = System.currentTimeMillis()
            } catch (t: Throwable) {
                Log.w(TAG, "WakeLock 获取失败", t)
            }
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (t: Throwable) {
            Log.w(TAG, "WakeLock 释放失败", t)
        }
        wakeLock = null
        wakeAcquiredAt = 0L
    }

    private fun shutdown() {
        handler.removeCallbacks(stopRunnable)
        // 收摊前把进度落盘：这是「暂停久了被自动关掉」和「用户滑掉应用」两条路的最后机会
        saveProgress(force = true)
        releaseWakeLock()
        session?.isActive = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        stopSelf()
    }

    // ---------------------------------------------------------------- 封面

    private fun loadArt(url: String) {
        artExecutor.execute {
            val bmp = try {
                fetchBitmap(url)
            } catch (t: Throwable) {
                Log.i(TAG, "封面拉取失败：$url")
                null
            } ?: return@execute
            artCache.put(url, bmp)
            handler.post {
                if (coverUrl == url) {
                    art = bmp
                    pushSessionState()
                    maybeReNotify(force = true)
                }
            }
        }
    }

    private fun fetchBitmap(url: String): Bitmap? {
        val abs = ServerAddress.resolveUrl(lastBaseUrl ?: "", url) ?: return null
        // 封面走的是 Web 端的图片代理（域名白名单在服务端），带上 cookie 才拿得到
        val conn = (URL(abs).openConnection() as HttpURLConnection).apply {
            connectTimeout = 6000
            readTimeout = 8000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            CookieStore.cookieFor(abs)?.let { setRequestProperty("Cookie", it) }
        }
        return try {
            conn.inputStream.use { input: InputStream -> BitmapFactory.decodeStream(input) }
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "GusiPlayback"
        private const val CHANNEL_ID = "gusi-playback"
        private const val NOTIF_ID = 1001
        private const val NOTIFY_MIN_INTERVAL_MS = 5000L

        // ---- 续播位置记忆（C3）----
        private const val PREFS_RESUME = "gusi-android-resume"
        private const val KEY_RESUME = "resume_v1"

        /** 播放中落盘间隔 */
        private const val SAVE_INTERVAL_MS = 5000L

        /** 位置变化不足该值时不必重复落盘 */
        private const val SAVE_MIN_DELTA_MS = 5000L

        /** 暂停后通知保留多久（便于回来继续听），超时自动收摊 */
        private const val PAUSE_KEEP_MS = 5 * 60 * 1000L

        /** WakeLock 单次租期；播放中由 applyState 反复续租 */
        private const val WAKELOCK_TIMEOUT_MS = 10 * 60 * 1000L

        /** 剩余租期低于该值时提前续租，避免真的到期掉线 */
        private const val WAKE_RENEW_MARGIN_MS = 2 * 60 * 1000L

        private const val ACTION_STOP = "com.gusi.music.action.STOP"
        private const val UA = "GusiMusicApp/1.0"

        @Volatile
        private var lastStateJson: String? = null

        @Volatile
        private var lastBaseUrl: String? = null

        @Volatile
        private var instance: PlaybackService? = null

        /** MainActivity 每次把桥接状态推过来都调用这里；服务没活着时会顺手拉起。 */
        fun pushState(context: Context, json: String) {
            lastStateJson = json
            val alive = instance
            if (alive != null) {
                alive.handler.post { alive.applyState(json) }
                return
            }
            val playing = try {
                JSONObject(json).optBoolean("playing", false)
            } catch (_: Throwable) {
                false
            }
            if (playing) start(context)
        }

        fun setBaseUrl(base: String) {
            lastBaseUrl = base
        }

        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, PlaybackService::class.java)
                )
            } catch (t: Throwable) {
                Log.w(TAG, "无法启动播放服务（后台启动限制？）", t)
            }
        }

        fun shutdownFromUser(context: Context) {
            context.stopService(Intent(context, PlaybackService::class.java))
        }
    }

    private fun createChannel() {
        // 通知渠道（NotificationChannel）是 API 26 才引入的类。minSdk 是 24，
        // 不守卫的话在 Android 7.0/7.1 上 new 这个类会 NoClassDefFoundError —— 直接崩在服务启动里。
        // 26 以下系统本来也没有「渠道」概念，NotificationCompat 走默认行为即可。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_playback),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(ch)
    }
}
