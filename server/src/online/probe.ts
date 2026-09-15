// ---------------------------------------------------------------------------
// 直链探活（第三方 JS 音源的兜底校验）
//
// 为什么需要：第三方脚本"解析成功"只代表它返回了一个 http(s) 字符串，不代表这个地址活着。
// 2026-09 实测 qdy 脚本的咪咕通道（music.haitangw.cc/musicapi/mg.php）整站返回 404 HTML：
// 解析链认为成功 → 不回退内置适配器 → 浏览器拿到 404 → <audio> error →
// 播放器按错误级联自动跳歌（用户看到的就是"点了没反应/一直跳"）。
// 所以采纳第三方直链前先探一次活：只等响应头，拿到就取消响应体，不下载内容。
//
// 成本控制：同一域名连续失败会进 5 分钟黑名单，避免每首歌都白等一次探活。
// 误判的代价只是"这一次走内置适配器"，比播不出来小得多。
// ---------------------------------------------------------------------------
import { accessLog } from '@/utils/log4js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PROBE_TIMEOUT = 5000
const DEAD_HOST_TTL = 5 * 60 * 1000

/** hostname → 判死时间戳（黑名单内直接判不可用，不再探） */
const deadHosts = new Map<string, number>()

/**
 * 探活：能取到 2xx/3xx 落地的音频类响应即视为可用。
 * HTML 响应（错误页/防盗链页）判不可用——第三方源处理失效时普遍返回这种。
 */
export const probePlayableUrl = async (rawUrl: string, referer?: string): Promise<boolean> => {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.protocol != 'http:' && u.protocol != 'https:') return false

  const deadAt = deadHosts.get(u.hostname)
  if (deadAt && Date.now() - deadAt < DEAD_HOST_TTL) return false

  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' }
    if (referer) headers.Referer = referer
    const res = await fetch(u, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT) })
    const ct = String(res.headers.get('content-type') ?? '').toLowerCase()
    // 只关心响应头：立刻取消，避免把整首歌拉下来
    try { await res.body?.cancel() } catch { /* ignore */ }
    // 200 正常、206 部分内容；304/3xx 已被 follow 消化。text/html = 错误页
    const ok = (res.status === 200 || res.status === 206) && !ct.includes('text/html')
    if (!ok) {
      deadHosts.set(u.hostname, Date.now())
      accessLog.warn(`直链探活失败（${res.status} ${ct || 'no-ct'}）：${u.hostname}${u.pathname.substring(0, 60)}`)
    }
    return ok
  } catch (e) {
    deadHosts.set(u.hostname, Date.now())
    accessLog.warn(`直链探活异常：${u.hostname}${u.pathname.substring(0, 60)} ${(e as Error).message}`)
    return false
  }
}

/** 某个域名是否在探活黑名单里（管理后台展示"第三方源疑似失效"用） */
export const isHostDead = (hostname: string): boolean => {
  const t = deadHosts.get(hostname)
  return !!t && Date.now() - t < DEAD_HOST_TTL
}
