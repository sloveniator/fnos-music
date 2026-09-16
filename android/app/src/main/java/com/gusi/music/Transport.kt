package com.gusi.music

/**
 * 进度相关的纯计算（通知栏/锁屏都靠它）。
 *
 * 单独拎出来是因为这三件事都「差一两秒就会被用户发现」，而它们在设备上没法靠肉眼调：
 *  1. 系统侧画进度条时要用**播放器真正的位置**，不是我们收到推送那一刻的位置；
 *  2. 播放中系统按 speed 自行外推，按「快进 30 秒」时的基准必须和外推的口径一致；
 *  3. duration 未知（电台直播流）时不能瞎夹取，否则进度条会跳到 0。
 */
object Transport {

    /** 通知栏「快进/后退」的步长。 */
    const val SEEK_STEP_MS = 30_000L

    /** 时间戳最多往回认这么多（时钟跳变/推送积压时的保险丝）。 */
    const val MAX_SKEW_MS = 10_000L

    /** 相对跳转的目标位置：不越左边界，duration 已知时不越右边界。 */
    fun seekTarget(positionMs: Long, deltaMs: Long, durationMs: Long): Long {
        val raw = (positionMs + deltaMs).coerceAtLeast(0L)
        return if (durationMs > 0) raw.coerceAtMost(durationMs) else raw
    }

    /**
     * 「此刻」的播放位置。
     *
     * @param positionMs 最后一次上报的位置
     * @param playing 上报时是否在播放
     * @param atElapsedMs 上报时刻（elapsedRealtime 基准）
     * @param nowElapsedMs 现在
     * @param durationMs 时长；<=0 表示未知
     */
    fun positionNow(
        positionMs: Long,
        playing: Boolean,
        atElapsedMs: Long,
        nowElapsedMs: Long,
        durationMs: Long
    ): Long {
        var pos = positionMs.coerceAtLeast(0L)
        // atElapsedMs <= 0 = 「不知道什么时候上报的」：宁可按原位置算，也不要从 0 开始外推出一个假进度
        if (playing && atElapsedMs > 0) {
            val dt = (nowElapsedMs - atElapsedMs).coerceIn(0L, MAX_SKEW_MS * 60)
            pos += dt
        }
        return if (durationMs > 0) pos.coerceAtMost(durationMs) else pos
    }
}
