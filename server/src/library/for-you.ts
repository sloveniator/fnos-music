import type { TrackInfo } from '@/library/scan'
import { getTenantTracks } from '@/library/tenant'
import { getPlayed, getPlayedOnline, tasteLibrary } from '@/web/playlists'
import { listTasks } from '@/downloads/queue'
import { onlineSearch, onlineSources } from '@/online'

/**
 * 为你推荐：按账户的听歌喜好生成「今日推荐」与「猜你喜欢」。
 *
 * 与旧实现的区别（旧版：今日推荐 = 按日期随机洗牌、猜你喜欢 = 只看最近播放的歌手/专辑）：
 *   1. 真正建口味画像 —— 播放历史（近因加权衰减）+ 我喜欢 + 自建歌单 + 在线播放记录 + 下载记录，
 *      落到「歌手权重 / 专辑权重」两个维度；账户之间完全独立（每用户各算一份）。
 *   2. 本地曲库只有几十首时，「推荐」不可能靠本地洗牌成立 —— 所以按画像里的
 *      头部歌手去在线源补新歌（本地已有的同名曲目会被排掉），本地 + 在线混合成一份。
 *      在线不可用/超时则自动退化为纯本地，绝不因为第三方挂了让首页空掉。
 *   3. 今日推荐用「日期 + 用户名」做种子 → 当天稳定、次日自动换；猜你喜欢更看重
 *      「最近在听」的窗口，偏向画像头部歌手的深挖。
 *
 * 结果按用户缓存 5 分钟：首页每次刷新都去搜第三方是不可接受的（也容易被风控）。
 */

const CACHE_TTL = 5 * 60 * 1000
/** 一张推荐卡的目标首数（主人 2026-09-17：今日推荐与猜你喜欢都补到 35 首，按天轮换）。
 *  35 首是「整份推荐」的目标：本地曲库够多就多给本地，不够则按画像去在线源补齐；
 *  第三方搜不到那么多时有多少给多少，绝不为了凑数重复推同一首。 */
const MIX_SIZE = 35
/** 本地曲目在一张卡里的上限：本地全占满就没有「在线新歌」的位置了 */
const DAILY_LOCAL_MAX = 20
const GUESS_LOCAL_MAX = 14
/** 单歌手在本地候选里的上限（越小越杂食；猜你喜欢更看头部歌手，故允许放宽到 2） */
const DAILY_LOCAL_PER_SINGER = 2
const GUESS_LOCAL_PER_SINGER = 1
/** 在线补歌要找几位画像头部歌手：每位一次搜索、单歌手最多 4 首，
 *  daily 需要 9 位才能凑够 35 首「零本地曲库」的账户（9 × 4 = 36） */
const DAILY_ONLINE_SINGERS = 9
const GUESS_ONLINE_SINGERS = 7
/** 单歌手最多贡献几首在线歌 */
const ONLINE_PER_SINGER = 4
/** 每歌手取歌的硬上限：口味面很窄的账户（画像里只有两三位歌手）靠放宽上限凑到目标量，
 *  但不超过这个数 —— 一份推荐里同一位歌手最多 8 首，再多就成个人专辑了 */
const ONLINE_PER_SINGER_MAX = 8
/** 每位歌手最多翻几页搜索结果：两份推荐共用同一个「不重复」排除集，
 *  一天要从同几位歌手身上取最多 70 首，一页（20 条）根本不够 */
const ONLINE_MAX_PAGES = 3
/** 在线搜索的并发度：9 位歌手串行最坏要等 9 × 5s，并发 3 路把等待压到约 1/3 */
const ONLINE_CONCURRENCY = 3
/** 口味画像回看的播放条数（播放历史本身最多 100 条） */
const HISTORY_WINDOW = 60
/** 「最近在听」窗口：猜你喜欢只看这一段 */
const RECENT_WINDOW = 15
/** 近因衰减：越靠后听的越不值钱 */
const DECAY = 0.93

const norm = (s?: string | null): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '')
/** 统一口径的曲目指纹：用于「本地已有 / 已推过」去重 */
const trackKey = (name?: string, singer?: string): string => norm(name) + '|' + norm(singer)

const hash = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}
/** mulberry32：同一种子给出同一串随机数（当天结果稳定的基础） */
const prng = (seed: number): (() => number) => {
  let n = seed | 0
  return () => {
    n = (n + 0x6D2B79F5) | 0
    let t = Math.imul(n ^ (n >>> 15), 1 | n)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** 本地日期（不是 UTC）：跨零点即换推荐，跟用户的作息对齐 */
const dayKey = (d = new Date()): string =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

/** 给第三方搜索加超时：宁可退化成本地推荐，不让首页等它 */
const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  const guard = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  try {
    return await Promise.race([p.catch(() => null), guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 口味画像
// ---------------------------------------------------------------------------

export interface SingerTaste {
  name: string
  /** 归一化后的权重（头部 = 1） */
  weight: number
  plays: number
  loved: number
}

export interface TasteSignals {
  played: number
  playedOnline: number
  loved: number
  playlists: number
  /** 成功下载到本账户的在线曲目数（主动下载 = 明确的喜欢） */
  downloaded: number
}

export interface TasteProfile {
  /** 头部歌手，权重降序 */
  singers: SingerTaste[]
  albums: Array<{ name: string, weight: number }>
  signals: TasteSignals
  /** 一点偏好数据都没有（新账户 / 从没听过）——此时推荐只能给「随便挑几首」 */
  cold: boolean
}

interface Acc { w: number, plays: number, loved: number, dl: number }

interface ProfileInternal {
  pub: TasteProfile
  singerW: Map<string, number>
  albumW: Map<string, number>
}

const bump = (m: Map<string, Acc>, key: string, w: number, kind: 'play' | 'love' | 'dl'): void => {
  if (!key) return
  const cur = m.get(key) ?? { w: 0, plays: 0, loved: 0, dl: 0 }
  cur.w += w
  if (kind === 'play') cur.plays++
  else if (kind === 'dl') cur.dl++
  else cur.loved++
  m.set(key, cur)
}

/**
 * 建画像。recentOnly 时只看最近 RECENT_WINDOW 条播放（猜你喜欢用）。
 * 全部数据来自本用户：播放历史 / 在线播放记录 / 我喜欢 / 自建歌单，互不串账户。
 */
const buildProfile = async (userName: string, recentOnly: boolean): Promise<ProfileInternal> => {
  const singers = new Map<string, Acc>()
  const albums = new Map<string, Acc>()
  const display = new Map<string, string>()
  const show = (raw: string): string => {
    const k = norm(raw)
    if (k && !display.has(k)) display.set(k, String(raw).trim())
    return k
  }
  const window = recentOnly ? RECENT_WINDOW : HISTORY_WINDOW
  const signals: TasteSignals = { played: 0, playedOnline: 0, loved: 0, playlists: 0, downloaded: 0 }

  // 1) 本地播放历史（数组本身「最近在前」，所以下标即近因）
  const played = getPlayed(userName).slice(0, window)
  signals.played = played.length
  played.forEach((t, i) => {
    const w = 1.2 * Math.pow(DECAY, i)
    bump(singers, show(t.singer), w, 'play')
    bump(albums, show(t.album), w * 0.5, 'play')
  })

  // 2) 在线播放记录（听在线歌同样说明口味，别因为不是本地曲目就丢信号）
  const playedOnline = getPlayedOnline(userName).slice(0, window)
  signals.playedOnline = playedOnline.length
  playedOnline.forEach((t, i) => {
    const w = 1.0 * Math.pow(DECAY, i)
    bump(singers, show(t.singer), w, 'play')
    bump(albums, show(t.album), w * 0.5, 'play')
  })

  // 3) 我喜欢（强信号）
  const lib = await tasteLibrary(userName)
  for (const m of lib.loved) {
    signals.loved++
    const s = (m as any)?.singer
    const a = (m as any)?.album
    if (s) bump(singers, show(s), 2.5, 'love')
    if (a) bump(albums, show(a), 1.0, 'love')
  }

  // 4) 自建歌单（同一歌单里同一歌手只算一次，避免「一个歌手占满整张歌单」把画像带偏）
  signals.playlists = lib.playlists.length
  for (const list of lib.playlists) {
    const seen = new Set<string>()
    for (const m of list) {
      const s = (m as any)?.singer
      if (!s) continue
      const k = show(s)
      if (seen.has(k)) continue
      seen.add(k)
      bump(singers, k, 1.0, 'play')
    }
  }

  // 5) 下载记录：主动把这首歌下载下来，是最不含糊的「我喜欢」。
  //    只认本账户、只认成功下载（失败/试听片段不算）。
  const dlSeen = new Set<string>()
  for (const task of listTasks(userName)) {
    if (task.status != 'done') continue
    const k = trackKey(task.name, task.singer)
    if (!k || dlSeen.has(k)) continue
    dlSeen.add(k)
    signals.downloaded++
    if (task.singer) bump(singers, show(task.singer), 1.5, 'dl')
    if (task.album) bump(albums, show(task.album), 0.6, 'dl')
  }

  // 归一化：头部歌手权重为 1，其余按比例（不同账户的画像强度可比但互不影响）
  const max = Math.max(0, ...[...singers.values()].map((v) => v.w))
  const singerW = new Map<string, number>()
  for (const [k, v] of singers) singerW.set(k, max > 0 ? v.w / max : 0)
  const albumMax = Math.max(0, ...[...albums.values()].map((v) => v.w))
  const albumW = new Map<string, number>()
  for (const [k, v] of albums) albumW.set(k, albumMax > 0 ? v.w / albumMax : 0)

  const top = [...singers.entries()]
    .map(([k, v]) => ({ name: display.get(k) ?? k, weight: max > 0 ? v.w / max : 0, plays: v.plays, loved: v.loved }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
  const topAlbums = [...albums.entries()]
    .map(([k, v]) => ({ name: display.get(k) ?? k, weight: albumMax > 0 ? v.w / albumMax : 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)

  return {
    pub: {
      singers: top,
      albums: topAlbums,
      signals,
      cold: signals.played + signals.playedOnline + signals.loved + signals.playlists + signals.downloaded === 0,
    },
    singerW,
    albumW,
  }
}

// ---------------------------------------------------------------------------
// 选曲
// ---------------------------------------------------------------------------

interface MixRow {
  /** 本地曲目为 trackId，在线曲目为 <source>_<rid> */
  id: string
  kind?: 'online'
  source?: string
  rid?: string
  name: string
  singer: string
  album: string
  interval?: string
  hasCover?: boolean
  relPath?: string
  mtime?: number
  pic?: string
}

const stripLocal = (t: TrackInfo): MixRow => {
  const { filePath, ...rest } = t
  void filePath
  return rest as unknown as MixRow
}

/** 本地候选打分：歌手权重为主、专辑次之，再叠一点点「新入库」分与随机抖动 */
const pickLocal = (
  tracks: TrackInfo[],
  prof: ProfileInternal,
  opts: { limit: number, seed: number, perSingerMax: number, exclude?: Set<string>, novelty?: Map<string, number> },
): TrackInfo[] => {
  const rand = prng(opts.seed)
  const ranked = tracks
    .filter((t) => !opts.exclude?.has(t.id))
    .map((t) => {
      const sw = prof.singerW.get(norm(t.singer)) ?? 0
      const aw = prof.albumW.get(norm(t.album)) ?? 0
      const nv = opts.novelty?.get(t.id) ?? 0
      // 抖动在这里算（遍历顺序固定 → 同一 seed 结果稳定）
      const jitter = rand() * 0.6
      return { t, score: 3.2 * sw + 1.4 * aw + nv + jitter }
    })
    .sort((a, b) => b.score - a.score)
  const out: TrackInfo[] = []
  const perSinger = new Map<string, number>()
  for (const { t } of ranked) {
    const s = norm(t.singer)
    if ((perSinger.get(s) ?? 0) >= opts.perSingerMax) continue
    perSinger.set(s, (perSinger.get(s) ?? 0) + 1)
    out.push(t)
    if (out.length >= opts.limit) break
  }
  return out
}

/** 画像强度：信号总条数。太少时推荐只能说「刚开始了解你」，不能吹「你常听」 */
const profileStrength = (s: TasteSignals): number =>
  s.played + s.playedOnline + s.loved + s.playlists + s.downloaded

/** 新入库程度：mtime 排名越靠前分越高（0 ~ 0.5） */
const noveltyMap = (tracks: TrackInfo[]): Map<string, number> => {
  const sorted = [...tracks].sort((a, b) => b.mtime - a.mtime)
  const m = new Map<string, number>()
  sorted.forEach((t, i) => m.set(t.id, 0.5 * (1 - i / Math.max(1, sorted.length))))
  return m
}

const toOnlineRow = (x: any, source: string): MixRow => ({
  id: source + '_' + String(x.id ?? '').replace(/^MUSIC_/, ''),
  kind: 'online',
  source,
  rid: x.id,
  name: x.name,
  singer: x.singer,
  album: x.album,
  interval: x.intervalMs ? String(x.intervalMs) : undefined,
  pic: x.pic,
})

/** 拆开合并署名的歌手串：'Anne-Marie、TroyBoi' / 'A & B' / 'A feat. B' */
const singerTokens = (raw: string): string[] =>
  String(raw)
    .split(/[、,&，,;；\/]|\s+(?:feat|ft|with)\.?\s+/i)
    .map((x) => x.trim())
    .filter(Boolean)

const ONLINE_ORDER = ['kw', 'wy', 'mg', 'soda']
const enabledOnlineIds = (): string[] => onlineSources().filter((s) => s.enabled).map((s) => s.id)

/**
 * 按画像头部歌手去在线源找「你还没有的」歌。
 * kw/wy 优先（接口稳、覆盖好），拿到候选后按种子打散，保证当天结果稳定。
 *
 * 关键约束：候选按歌手**只抓一次**，两份推荐共用这个候选池。实测这条路线的源（kw）
 * 对同一关键词的连续重复查询会直接返回空列表 —— 第二轮再打一遍等于没打，反而
 * 把「今日推荐」撑到 35 首的同时把「猜你喜欢」饿死（当场实测 35 / 8）。
 */
const pickOnline = async (
  prof: TasteProfile,
  opts: {
    singers: string[], limit: number, exclude: Set<string>, perSingerMax: number, seed: number,
    pool?: Map<string, any[]>,
  },
): Promise<MixRow[]> => {
  const enabled = enabledOnlineIds()
  const source = ONLINE_ORDER.find((s) => enabled.includes(s))
  if (!source) return []
  const out: MixRow[] = []
  const rand = prng(opts.seed ^ 0x9E3779B9)
  const pool = opts.pool ?? new Map<string, any[]>()
  // 目标量摊到几位歌手头上：歌手多就按 4 首封顶，歌手少（画像窄）才放宽到 8 首。
  // 这样「35 首」在口味面窄的账户上也尽量凑满，而不是固定 5 位 × 4 首 = 20 首封顶。
  const perSinger = Math.min(
    ONLINE_PER_SINGER_MAX,
    Math.max(opts.perSingerMax, Math.ceil(opts.limit / Math.max(1, opts.singers.length))),
  )

  /**
   * 取一位歌手的候选（走缓存）：过滤掉翻唱/合集（歌手对不上）与无效时长。
   * 一页 20 条里常常只有几条能过校验，所以会往后翻页，直到够两份推荐分的量
   * （每位最多 8 首 × 2 份）或翻满 ONLINE_MAX_PAGES 页。
   */
  const fetchSinger = async (singer: string): Promise<any[]> => {
    const hit = pool.get(singer)
    if (hit) return hit
    const tokens = singerTokens(singer).sort((a, b) => b.length - a.length)
    const query = tokens[0] || singer
    const ok = (x: any) => x?.id && Number(x.intervalMs) > 0 && tokens.some((tk) => norm(x.singer).includes(norm(tk)))
    const got: any[] = []
    for (let page = 1; page <= ONLINE_MAX_PAGES; page++) {
      const res: any = await withTimeout(onlineSearch(source, query, page, 20), 5000)
      const list: any[] = Array.isArray(res?.list) ? res.list : []
      if (!list.length) break
      got.push(...list.filter(ok))
      if (got.length >= ONLINE_PER_SINGER_MAX * 2) break
    }
    pool.set(singer, got)
    return got
  }

  /**
   * 两轮收编：第一轮每位歌手按 4 首（保住「一份推荐里不出现个人专辑」的观感），
   * 收完还凑不满目标量，第二轮才放宽到 8 首补差额。两轮都只从候选池里取，不碰网络。
   */
  // 每位歌手在**这一份推荐里**已经收了几首：两轮之间不清零，
  // 否则第二轮又会多给同一位歌手 8 首（上限本来是「一份推荐里最多 8 首」）。
  const taken = new Map<string, number>()
  const passes = [perSinger, ONLINE_PER_SINGER_MAX]
  for (const cap of passes) {
    // 分批并发搜索，批内仍按歌手顺序收编：打散与去重都在收编时做，
    // 所以「同一天同一账户」的结果与逐位串行完全一致（并发不影响确定性）。
    for (let i = 0; i < opts.singers.length && out.length < opts.limit; i += ONLINE_CONCURRENCY) {
      const batch = opts.singers.slice(i, i + ONLINE_CONCURRENCY)
      const lists = await Promise.all(batch.map((s) => fetchSinger(s)))
      for (let b = 0; b < lists.length; b++) {
        const raw = lists[b]
        const singer = batch[b]
        if (out.length >= opts.limit || !raw.length) continue
        if ((taken.get(singer) ?? 0) >= cap) continue
        const cands = [...raw] // 别原地打乱：候选池还要给另一份推荐用
        for (let k = cands.length - 1; k > 0; k--) {
          const j = Math.floor(rand() * (k + 1))
          const tmp = cands[k]
          cands[k] = cands[j]
          cands[j] = tmp
        }
        let n = taken.get(singer) ?? 0
        for (const x of cands) {
          if (n >= cap || out.length >= opts.limit) break
          const key = trackKey(x.name, x.singer)
          if (opts.exclude.has(key)) continue
          opts.exclude.add(key)
          out.push(toOnlineRow(x, source))
          n++
        }
        taken.set(singer, n)
      }
    }
    if (out.length >= opts.limit) break
  }
  return out
}

/** 本地与在线交错排列：避免「前半页全是本地、后半页全是在线」的割裂观感 */
const interleave = (a: MixRow[], b: MixRow[]): MixRow[] => {
  const out: MixRow[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]!)
    if (i < b.length) out.push(b[i]!)
  }
  return out
}

const coverOf = (tracks: MixRow[], n: number): MixRow[] =>
  tracks.filter((t) => (t.kind === 'online' ? !!t.pic : t.hasCover)).slice(0, n)

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export interface ForYouMix {
  id: 'daily' | 'guess'
  name: string
  /** 一句话说明推荐依据（首页卡片副标题 / 详情页 meta） */
  reason: string
  updatedAt: number
  /** 封面候选序列（本地带 id+hasCover，在线带 pic）：UI 一个格子只显示一张，
   *  多给几个是给加载失败留的兜底 —— 第一张挂了换下一张 */
  cover: MixRow[]
  localCount: number
  onlineCount: number
  tracks: MixRow[]
}

export interface ForYou {
  profile: TasteProfile
  daily: ForYouMix
  guess: ForYouMix
}

const topSingers = (p: TasteProfile, n: number): string[] =>
  p.singers.filter((s) => s.weight > 0 && !/^(未知歌手|未知|various artists|群星)$/i.test(s.name)).slice(0, n).map((s) => s.name)

const joinNames = (names: string[], max = 3): string => names.slice(0, max).join(' · ')

const build = async (userName: string): Promise<ForYou> => {
  const all = getTenantTracks(userName)
  const day = dayKey()
  const novelty = noveltyMap(all)
  const localKeys = new Set(all.map((t) => trackKey(t.name, t.singer)))
  // 两张卡片的在线候选共享一个排除集：同一首在线歌不在两个推荐里重复出现
  // 也共享同一个歌手候选池：在线源对重复查询会返回空，一天只抓一次
  const onlinePool = new Map<string, any[]>()
  const usedOnline = new Set(localKeys)

  const broad = await buildProfile(userName, false)
  const recent = await buildProfile(userName, true)
  const cold = broad.pub.cold
  const strength = profileStrength(broad.pub.signals)
  const playedAll = getPlayed(userName)

  // ---- 今日推荐：整体口味，每天一份，跳过最近刚听过的 ----
  const dailySeed = hash(day + ':' + userName + ':daily')
  const justPlayed = new Set(playedAll.slice(0, 6).map((t) => t.id))
  let dailyLocal = pickLocal(all, broad, { limit: DAILY_LOCAL_MAX, seed: dailySeed, perSingerMax: DAILY_LOCAL_PER_SINGER, exclude: justPlayed, novelty })
  // 曲库小时「跳过最近听过」会把候选掏空，此时放宽（宁可重复听，也不要空推荐）
  if (dailyLocal.length < 8) dailyLocal = pickLocal(all, broad, { limit: DAILY_LOCAL_MAX, seed: dailySeed, perSingerMax: DAILY_LOCAL_PER_SINGER, novelty })
  // 在线补歌的目标是「整份推荐 MIX_SIZE 首」：本地曲库空/小时在线多补，本地充足时只补缺口。
  // 之前固定 limit 8 + 5 位歌手 × 4 首、整份只有 20 首，遇到「没有本地曲库」的账户
  // （在线听歌为主）看着就像没做功能。
  const dailySingers = topSingers(broad.pub, DAILY_ONLINE_SINGERS)
  const dailyOnline = cold || !dailySingers.length
    ? []
    : await pickOnline(broad.pub, { singers: dailySingers, limit: Math.max(8, MIX_SIZE - dailyLocal.length), exclude: usedOnline, perSingerMax: ONLINE_PER_SINGER, seed: dailySeed, pool: onlinePool })

  // ---- 猜你喜欢：只看最近在听的窗口，偏向头部歌手的其他作品 ----
  const guessSeed = hash(day + ':' + userName + ':guess')
  const heardAll = new Set(playedAll.map((t) => t.id))
  let guessLocal = pickLocal(all, recent, { limit: GUESS_LOCAL_MAX, seed: guessSeed, perSingerMax: GUESS_LOCAL_PER_SINGER, exclude: heardAll, novelty })
  if (guessLocal.length < 4) guessLocal = pickLocal(all, recent, { limit: GUESS_LOCAL_MAX, seed: guessSeed, perSingerMax: 2, novelty })
  const guessSingers = topSingers(recent.pub, GUESS_ONLINE_SINGERS)
  const guessOnline = cold || !guessSingers.length
    ? []
    : await pickOnline(recent.pub, { singers: guessSingers, limit: Math.max(10, MIX_SIZE - guessLocal.length), exclude: usedOnline, perSingerMax: ONLINE_PER_SINGER, seed: guessSeed, pool: onlinePool })

  const dailyTracks = interleave(dailyLocal.map(stripLocal), dailyOnline)
  const guessTracks = interleave(guessLocal.map(stripLocal), guessOnline)
  const now = Date.now()

  const mk = (id: 'daily' | 'guess', name: string, reason: string, tracks: MixRow[]): ForYouMix => ({
    id,
    name,
    reason,
    updatedAt: now,
    cover: coverOf(tracks, 4),
    localCount: tracks.filter((t) => t.kind !== 'online').length,
    onlineCount: tracks.filter((t) => t.kind === 'online').length,
    tracks,
  })

  return {
    profile: broad.pub,
    daily: mk(
      'daily',
      '今日推荐',
      cold
        ? '还不太了解你的口味，先挑几首给你'
        : strength < 3
          ? '刚开始了解你：先按最近听到的 ' + joinNames(dailySingers, 2) + ' 起个头'
          : '你常听 ' + joinNames(dailySingers) + (dailyOnline.length ? '，另配 ' + dailyOnline.length + ' 首在线新歌' : ''),
      dailyTracks,
    ),
    guess: mk(
      'guess',
      '猜你喜欢',
      cold
        ? '听几首之后，这里会越来越准'
        : '接着你最近在听的 ' + joinNames(guessSingers, 2) + ' 往下挖' + (guessOnline.length ? '（' + guessOnline.length + ' 首你没听过的）' : ''),
      guessTracks,
    ),
  }
}

// 每用户缓存 + 并发合流：首页刷新不会反复去打第三方
const cache = new Map<string, { at: number, day: string, data: ForYou }>()
const inflight = new Map<string, Promise<ForYou>>()

export const forYou = async (userName: string): Promise<ForYou> => {
  const day = dayKey()
  const hit = cache.get(userName)
  if (hit && hit.day === day && Date.now() - hit.at < CACHE_TTL) return hit.data
  const running = inflight.get(userName)
  if (running) return running
  const task = build(userName)
    .then((data) => {
      cache.set(userName, { at: Date.now(), day, data })
      return data
    })
    .finally(() => { inflight.delete(userName) })
  inflight.set(userName, task)
  return task
}

export const dropForYouCache = (userName?: string): void => {
  if (userName) cache.delete(userName)
  else cache.clear()
}
