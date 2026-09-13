import { onlineSearch, type OnlineItem } from '@/online'
import { getTenantTracks, refreshCoverFlags, safeUserName, onTenantScanDone, getTenantSettings } from './tenant'
import { coverEntryOf, recordCover, saveCoverFile } from './cover-cache'

// ---------------------------------------------------------------------------
// 在线封面回填任务：对「无内嵌封面」的曲目按「歌手 + 曲名」跨源匹配并抓取封面
//   - 串行 + 间隔节流：避免触发音源风控（默认 420ms/首）
//   - 三维打分（曲名 / 歌手 / 专辑），低于阈值判定为未匹配，宁可留空也不错配
//   - 命中后落 covers/ 目录并更新内存 coverCache 标记，UI 立即可见
//   - 结果（含未匹配/失败）全部持久化，后续增量运行只处理没有记录的曲目
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
/** 接受匹配的最低分：低于此值视为未命中 */
const MIN_SCORE = 0.8

export interface CoverBackfillState {
  running: boolean
  /** 本次待处理曲目数 */
  total: number
  done: number
  ok: number
  miss: number
  fail: number
  /** 已有记录而跳过的曲目数 */
  skipped: number
  current: string
  startedAt: number
  finishedAt: number
  error: string | null
  cancelRequested: boolean
}

export interface BackfillOptions {
  /** 已有记录（含匹配失败）也重试 */
  force?: boolean
  /** 音源尝试顺序，默认 ['wy','kw']（网易云图床质量更稳） */
  sources?: string[]
  /** 单次最多处理曲目数（保护风控） */
  limit?: number
  /** 每首曲目之间的间隔毫秒 */
  delayMs?: number
}

const states = new Map<string, CoverBackfillState>()

const blank = (): CoverBackfillState => ({
  running: false, total: 0, done: 0, ok: 0, miss: 0, fail: 0, skipped: 0,
  current: '', startedAt: 0, finishedAt: 0, error: null, cancelRequested: false,
})

export const coverBackfillState = (safeUser: string): CoverBackfillState => ({ ...(states.get(safeUser) ?? blank()) })

type Listener = (safeUser: string, s: CoverBackfillState) => void
const listeners = new Set<Listener>()

export const subscribeCoverBackfill = (fn: Listener): (() => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const emit = (safeUser: string): void => {
  const s = coverBackfillState(safeUser)
  for (const l of listeners) {
    try { l(safeUser, s) } catch { /* ignore */ }
  }
}

export const cancelCoverBackfill = (safeUser: string): boolean => {
  const s = states.get(safeUser)
  if (!s || !s.running) return false
  s.cancelRequested = true
  return true
}

// ---------------- 匹配打分 ----------------

/** 归一化：去括号补充说明 / 版本词 / 标点空白，便于跨源比对 */
const norm = (s: string): string => (s || '')
  .toLowerCase()
  .replace(/[（(\[【{][^)）\]】}]*[)）\]】}]/g, '')
  .replace(/\b(feat|ft|live|remaster|remastered|version|acoustic|instrumental|伴奏|纯音乐|翻唱)\b\.?/g, '')
  .replace(/[\s\-_·、,，.。!！?？:：;；'"“”‘’&+＋/\\|]+/g, '')

const splitArtists = (s: string): string[] =>
  (s || '').split(/[、,，/&;；]+/).map(x => norm(x)).filter(x => x.length > 0)

/** 曲名 / 歌手 / 专辑三维打分，返回 0~1 */
const scoreOf = (
  track: { name: string, singer: string, album: string },
  item: { name: string, singer: string, album?: string },
): number => {
  const tn = norm(track.name)
  const inn = norm(item.name)
  if (!tn || !inn) return 0
  let nameScore: number
  if (tn === inn) {
    nameScore = 1
  } else if (tn.includes(inn) || inn.includes(tn)) {
    const ratio = Math.min(tn.length, inn.length) / Math.max(tn.length, inn.length)
    nameScore = 0.82 + 0.13 * ratio
  } else {
    const a = new Set(tn.split(''))
    const b = new Set(inn.split(''))
    let inter = 0
    for (const c of a) if (b.has(c)) inter++
    nameScore = (inter / Math.max(a.size, b.size)) * 0.8
  }
  const ta = splitArtists(track.singer)
  const ia = splitArtists(item.singer)
  const artistHit = ta.length > 0 && ia.length > 0 &&
    ta.some(x => ia.some(y => x === y || x.includes(y) || y.includes(x)))
  let score = artistHit ? Math.min(1, nameScore + 0.15) : nameScore * 0.72
  if (track.album && item.album && norm(track.album) === norm(item.album)) score = Math.min(1, score + 0.08)
  return score
}

/** 网易云图床支持 param 缩略参数：原图常 1MB+，统一取 500x500 控制缓存体积 */
const thumbUrl = (u: string): string => {
  try {
    const url = new URL(u)
    if (/(^|\.)music\.126\.net$/.test(url.hostname) && !url.searchParams.get('param')) {
      url.searchParams.set('param', '500y500')
    }
    return url.href
  } catch { return u }
}

const fetchPic = async (picUrlRaw: string): Promise<{ data: Buffer, ext: string } | null> => {
  const picUrl = thumbUrl(picUrlRaw)
  try {
    const r = await fetch(picUrl, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': UA, Referer: new URL(picUrl).origin + '/' },
    })
    if (!r.ok) return null
    const ct = String(r.headers.get('content-type') ?? '')
    if (!/^image\//.test(ct)) return null
    const data = Buffer.from(await r.arrayBuffer())
    if (!data.length || data.length > 6 * 1024 * 1024) return null
    return { data, ext: /png/i.test(ct) ? 'png' : 'jpg' }
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------- 主流程 ----------------

export const runCoverBackfill = async (rawUser: string, opts: BackfillOptions = {}): Promise<CoverBackfillState> => {
  const safeUser = safeUserName(rawUser)
  const st = states.get(safeUser) ?? blank()
  states.set(safeUser, st)
  if (st.running) return { ...st }

  const sources = (opts.sources && opts.sources.length ? opts.sources : ['wy', 'kw']).slice(0, 3)
  const delayMs = Math.max(100, Math.min(5000, opts.delayMs ?? 420))
  const force = !!opts.force

  const noCover = getTenantTracks(rawUser).filter(t => !t.hasCover)
  // 增量：已有记录的曲目默认跳过（含 nomatch，避免反复爬同一批无解曲目）
  const queue = (force ? noCover : noCover.filter(t => !coverEntryOf(safeUser, t.id)))
    .slice(0, Math.max(1, Math.min(5000, opts.limit ?? 5000)))

  Object.assign(st, blank(), {
    running: true,
    total: queue.length,
    skipped: noCover.length - queue.length,
    startedAt: Date.now(),
  })
  emit(safeUser)

  try {
    for (const tr of queue) {
      if (st.cancelRequested) break
      st.current = tr.singer ? `${tr.singer} - ${tr.name}` : tr.name
      emit(safeUser)

      let hit: { item: OnlineItem, score: number, source: string } | null = null
      const keyword = [tr.singer, tr.name].filter(Boolean).join(' ').substring(0, 80)
      if (keyword) {
        for (const src of sources) {
          try {
            const res = await onlineSearch(src, keyword, 1, 12)
            let best: OnlineItem | null = null
            let bestScore = 0
            for (const it of res?.list ?? []) {
              if (!it || !it.pic) continue
              const sc = scoreOf(tr, it)
              if (sc > bestScore) { bestScore = sc; best = it }
            }
            if (best && bestScore >= MIN_SCORE) { hit = { item: best, score: bestScore, source: src }; break }
          } catch { /* 单源失败继续下一个源 */ }
          await sleep(delayMs)
        }
      }

      const prevTries = coverEntryOf(safeUser, tr.id)?.tries ?? 0
      if (hit) {
        const pic = await fetchPic(hit.item.pic as string)
        if (pic) {
          const file = saveCoverFile(safeUser, tr.id, pic.data, pic.ext)
          recordCover(safeUser, tr.id, {
            status: 'ok', source: hit.source, onlineId: hit.item.id,
            title: hit.item.name, artist: hit.item.singer, picUrl: hit.item.pic as string,
            file, size: pic.data.length, score: Math.round(hit.score * 100) / 100,
            at: Date.now(), tries: prevTries + 1,
          })
          st.ok++
        } else {
          recordCover(safeUser, tr.id, {
            status: 'error', source: hit.source, onlineId: hit.item.id,
            title: hit.item.name, artist: hit.item.singer, picUrl: hit.item.pic as string,
            score: Math.round(hit.score * 100) / 100, at: Date.now(), tries: prevTries + 1,
          })
          st.fail++
        }
      } else {
        recordCover(safeUser, tr.id, { status: 'nomatch', at: Date.now(), tries: prevTries + 1 })
        st.miss++
      }
      st.done++
      emit(safeUser)
      await sleep(delayMs)
    }
  } catch (e) {
    st.error = (e as Error).message
  }

  st.running = false
  st.current = ''
  st.finishedAt = Date.now()
  // 让 UI/接口立刻看到新封面
  try { refreshCoverFlags(rawUser) } catch { /* ignore */ }
  emit(safeUser)
  return { ...st }
}

// 扫描完成后：若租户开启了「自动回填封面」，则后台增量回填（已有记录的曲目自动跳过）
onTenantScanDone((rawUser) => {
  try {
    if (!getTenantSettings(rawUser).coverAuto) return
    const safeUser = safeUserName(rawUser)
    if (coverBackfillState(safeUser).running) return
    void runCoverBackfill(rawUser, { limit: 200 }).catch(() => { /* 状态已记录 */ })
  } catch { /* ignore */ }
})
