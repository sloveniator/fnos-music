package com.gusi.music

import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.session.MediaSessionCompat
import androidx.media.MediaBrowserServiceCompat

/**
 * 车机（Android Auto / Android Automotive）的曲库入口。
 *
 * 车机不认我们的 Web 界面，它只认 `MediaBrowserServiceCompat`：
 * 车机连上来 → 拿一棵可浏览的树 → 用户点某一项 → 我们**转手让手机上的 Web 播放器去放**。
 *
 * 这个类只做「MediaBrowserServiceCompat 的协议翻译」，三件事分别放在别处：
 *  - 树与播放计划：[CarLibrary]（纯逻辑，可单测）；
 *  - 取数、缓存、认人：[CarSource]（真机上带 WebView 的登录令牌走 HTTP）；
 *  - 出声：[PlaybackService] 的 session 回调收到 `onPlayFromMediaId` 后，
 *    经 [CarSource] 得到计划，再把 `__gusiCmd('playlist', {i, list})` 送进 WebView。
 *
 * 为什么播放不在这里实现：壳自己放会立刻出现第二套播放状态 ——
 * 通知栏/锁屏（C2）、续播记忆（C3）、离线本地文件替换（C1）全都对不上。
 *
 * 已知限制（也写在 android/README.md 的「车机」一节）：
 *  - 不带封面 —— 车机只能拿 Uri 自己去取图，而封面接口要登录 cookie，车机侧拿不到；
 *  - 列表按页取，单页 200 首（服务端上限），不做「翻页/搜索」；
 *  - 只实现浏览 + 点播：Android Auto 的语音（「播放某某」）要另接 `onPlayFromSearch`，没做；
 *  - 点播时若 WebView 不在了（进程刚被重建、页面还没起来）指令无处可送，
 *    车机表现为「点了没反应」，需要先在手机上打开一次应用。
 */
class CarMediaService : MediaBrowserServiceCompat() {

    override fun onCreate() {
        super.onCreate()
        // 播放服务可能还没起（还没放过歌），那就先只提供可浏览的树；
        // 之后每次交互再对齐一次 token，车机重连时就能拿到。
        syncSession()
    }

    override fun onGetRoot(
        clientPackageName: String,
        clientUid: Int,
        rootHints: Bundle?
    ): BrowserRoot? {
        syncSession()
        return BrowserRoot(CarLibrary.ROOT_ID, null)
    }

    override fun onLoadChildren(
        parentId: String,
        result: Result<List<MediaBrowserCompat.MediaItem>>
    ) {
        // 要去网络取数据，必须脱离主线程再回结果
        result.detach()
        CarSource.childrenAsync(this, parentId) { items ->
            result.sendResult(items.map(::mediaItem))
        }
    }

    // ------------------------------------------------------------ 内部

    private fun syncSession() {
        val token: MediaSessionCompat.Token? = PlaybackService.sessionToken()
        if (token != null) setSessionToken(token)
    }

    private fun mediaItem(it: CarLibrary.Item): MediaBrowserCompat.MediaItem {
        val desc = MediaDescriptionCompat.Builder()
            .setMediaId(it.mediaId)
            .setTitle(it.title)
            .setSubtitle(it.subtitle.ifBlank { null })
            .build()
        var flags = 0
        if (it.browsable) flags = flags or MediaBrowserCompat.MediaItem.FLAG_BROWSABLE
        if (it.playable) flags = flags or MediaBrowserCompat.MediaItem.FLAG_PLAYABLE
        return MediaBrowserCompat.MediaItem(desc, flags)
    }
}
