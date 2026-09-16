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
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.util.LruCache
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
    private var title = ""
    private var artist = ""
    private var durationMs = 0L
    private var positionMs = 0L
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

        val wasPlaying = playing
        val wasTitle = title
        playing = o.optBoolean("playing", false)
        title = o.optString("title", "")
        artist = o.optString("artist", "")
        durationMs = o.optLong("duration", 0L)
        positionMs = o.optLong("position", 0L)
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
        maybeReNotify(force = wasPlaying != playing || wasTitle != title)

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

        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        s.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO or
                        PlaybackStateCompat.ACTION_STOP
                )
                .setState(state, positionMs, if (playing) 1f else 0f)
                .build()
        )
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

        if (durationMs > 0) {
            b.setProgress(1000, ((positionMs * 1000) / durationMs).toInt().coerceIn(0, 1000), false)
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
