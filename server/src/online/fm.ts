// ---------------------------------------------------------------------------
// FM 电台：把汽水音乐的「听歌模式」做成可自动播放的电台频道
//
// 上游事实（实测于 2026-09-15，全部免登录、无需签名）：
//   ① 模式目录：GET /luna/pc/feed/mode → feed_mode_block → 45 个场景模式
//      （含「深夜 EMO」「沉浸 0.8x」「助眠模式」「通勤必听」「DJ模式」等）
//   ② 场景歌流：**免登录面不可达**。系统性爆破 400+ 候选路径（/luna/{pc/}{feed,mode,
//      scene,queue,...}/{track,list,v2,...}、Android 通道、H5 seo_* 通道）后，
//      只有 feed/mode、playlist/detail、search/*、h5/seo_track 四类存活；
//      feed/mode 带上 scene_mode_id / sub_queue_type 也不改变返回。
//      结论与「榜单」一致：场景队列走客户端私有接口（L2 领域），L1 不做。
//
// 因此频道内容由免登录可用的两路**合成**（模式名 + 追加词作为配方）：
//   歌单：search/playlist → pc/playlist/detail（曲目多、含真歌，免费占比 5~50%）
//   单曲：search/track（产出率高 75~100%，多为氛围/纯音）
//   两路都只保留 L1 可播放的「免费全曲」——sodaSearch/sodaPlaylistDetail 已做 VIP 过滤，
//   这里不再重复判定，避免两处规则漂移。
//
// 「沉浸 0.8x」是播放参数型模式（汽水侧对应 0.8 倍速慢放曲目），
// 频道上带 playbackRate=0.8，由前端落到 audio.playbackRate。
// ---------------------------------------------------------------------------

import type { OnlineItem } from './kw'
import { sodaFeedModes, sodaSearch, sodaSearchPlaylists, sodaPlaylistDetail } from './soda'

export interface FmChannel {
  /** 稳定标识：汽水 sub_queue_type（如 scene_mode_emo） */
  key: string
  /** 频道名（汽水原文，如「深夜 EMO」） */
  name: string
  sceneId: number
  pic: string | null
  /** 频道说明（前端副标题） */
  desc: string
  /** 播放速率（沉浸 0.8x 频道 = 0.8） */
  playbackRate?: number
}

/** 频道配方：仅对「名字本身不足以取到好内容」的模式做关键词/说明覆盖 */
interface Recipe {
  /** 追加关键词（与频道名一起用） */
  extra: string[]
  /** 完全替换关键词表（频道名不再作为取数词，用于名字本身就是「播放参数」的模式） */
  keywords?: string[]
  desc?: string
  playbackRate?: number
}

const RECIPES: Record<string, Recipe> = {
  scene_mode_emo: { extra: ['emo 伤感', '失恋 emo 情歌'], desc: '深夜emo · 伤感/emo 曲目' },
  // 「沉浸0.8x」是**播放参数**模式（汽水侧就是把当前曲目放慢到 0.8 倍速），
  // 所以内容取「正常慢歌」，速率交给前端 —— 若按频道名取数会拿到「0.8x版」慢放 remix，
  // 再叠 0.8 倍速就成了 0.64 倍双重慢放，语义错位。
  scene_mode_slow_motion: {
    extra: [],
    keywords: ['沉浸 慢歌 抒情', '深夜 抒情 慢歌'],
    desc: '沉浸慢放 · 正常曲目 0.8 倍速播放',
    playbackRate: 0.8,
  },
  scene_mode_bedtime: { extra: ['催眠曲', '助眠 轻音乐'], desc: '助眠 · 催眠曲/白噪音' },
  scene_mode_commute: { extra: ['通勤 歌单', '上班路上'], desc: '通勤路上 · 通勤必听' },
  scene_mode_car_mode: { extra: ['车载 音乐', '开车 歌单'], desc: '驾车 · 车载歌单' },
  scene_mode_get_up: { extra: ['起床 元气', '早晨 歌单'], desc: '起床 · 元气开启一天' },
  scene_mode_dj: { extra: ['DJ 蹦迪', '劲爆 电音'], desc: 'DJ · 劲爆串烧' },
  scene_mode_chill: { extra: ['放松 轻音乐', 'chill 放松'], desc: 'Chill · 松弛感' },
  scene_mode_focus: { extra: ['专注 学习', '自习 背景音'], desc: '专注 · 学习工作背景音' },
  scene_mode_library: { extra: ['图书馆 背景音', '自习室 轻音乐'], desc: '图书馆 · 安静背景音' },
  scene_mode_heal: { extra: ['治愈 纯音乐', '解压 放松'], desc: '治愈 · 解压放松' },
  scene_mode_sport: { extra: ['运动 健身 燃脂', '跑步 节奏'], desc: '动感健身 · 燃脂节奏' },
  scene_mode_night_time: { extra: ['夜晚 安静', '夜色 轻音乐'], desc: '夜晚 · 夜色氛围' },
  scene_mode_non_vocal: { extra: ['纯音乐 轻音乐', '无人声 背景音'], desc: '轻音乐 · 无人声' },
  scene_mode_lucky: { extra: ['好运 好运来', '喜庆 祝福'], desc: '好运 · 喜庆祝福' },
  scene_mode_lying_flat: { extra: ['躺平 放松', '解压 慢歌'], desc: '躺平 · 放松解压' },
  scene_mode_fish: { extra: ['摸鱼 歌单', '办公室 背景音'], desc: '摸鱼 · 办公室摸鱼' },
  scene_mode_bath: { extra: ['洗澡 唱歌', 'K歌 欢快'], desc: '洗澡 · 浴室欢唱' },
  scene_mode_clean_up: { extra: ['打扫 音乐', '家务 欢快'], desc: '打扫 · 家务节奏' },
  scene_mode_game: { extra: ['游戏 燃曲', '电竞 BGM'], desc: '打游戏 · 燃系 BGM' },
  scene_mode_drunk: { extra: ['小酒馆 爵士', '微醺 慵懒'], desc: '小酒馆 · 微醺慵懒' },
  scene_mode_travel: { extra: ['旅行 民谣', '公路 音乐'], desc: '旅行 · 路上民谣' },
  scene_mode_rain: { extra: ['雨天 音乐', '雨声 氛围'], desc: '雨天 · 雨天氛围' },
  scene_mode_beach: { extra: ['海边 轻音乐', '海浪 氛围'], desc: '海边 · 海浪氛围' },
  scene_mode_ktv: { extra: ['KTV 必点 合唱', 'K歌 金曲'], desc: 'KTV 必点 · 能唱的金曲' },
  scene_mode_breakup: { extra: ['失恋 情歌', '分手 伤感'], desc: '失恋必听 · 伤感情歌' },
  scene_mode_love_song: { extra: ['浪漫 情歌', '甜 情歌'], desc: '浪漫情歌 · 甜度拉满' },
  scene_mode_sweet_girl: { extra: ['甜美女声', '甜妹 歌单'], desc: '甜美女声 · 甜系女声' },
  scene_mode_rap: { extra: ['说唱 中文', 'hiphop 说唱'], desc: '说唱 · 中文说唱' },
  scene_mode_rock: { extra: ['摇滚 经典', '乐队 摇滚'], desc: '摇滚 · 经典摇滚' },
  scene_mode_folk: { extra: ['民谣 经典', '独立民谣'], desc: '民谣 · 经典民谣' },
  scene_mode_rnb: { extra: ['R&B 情歌', '节奏布鲁斯'], desc: 'R&B · 节奏布鲁斯' },
  scene_mode_electronic: { extra: ['电子 电音', 'edm 电音'], desc: '电音 · EDM' },
  scene_mode_kpop: { extra: ['K-pop 韩国', '韩流 歌单'], desc: 'K-pop · 韩流' },
  scene_mode_jpop: { extra: ['日语 动漫', 'J-pop 经典'], desc: '日语 · 日系' },
  scene_mode_english: { extra: ['欧美 经典', '英文 歌单'], desc: '欧美 · 英文经典' },
  scene_mode_cantonese: { extra: ['粤语 经典 老歌', '港乐 经典'], desc: '粤语 · 经典港乐' },
  scene_mode_chinese_style: { extra: ['国风 古风', '中国风 歌单'], desc: '国风 · 古风中国风' },
  scene_mode_nostalgic: { extra: ['怀旧 老歌 经典', '80 90 老歌'], desc: '怀旧老歌 · 时代金曲' },
  scene_mode_classic: { extra: ['古典 钢琴', '古典音乐 纯音'], desc: '古典 · 古典钢琴' },
  scene_mode_country: { extra: ['乡村 民谣 英文', 'country 音乐'], desc: '乡村 · Country' },
  scene_mode_child: { extra: ['儿歌 童谣', '儿童 歌曲'], desc: '儿歌 · 儿童歌谣' },
  scene_mode_happy: { extra: ['欢快 歌曲', '快乐 歌单'], desc: '快乐时光 · 欢快曲目' },
  scene_mode_calm: { extra: ['佛系 静心', '禅意 轻音乐'], desc: '佛系时间 · 静心' },
}

/** 频道目录缓存（汽水侧更新很慢，1 小时足够） */
const CHANNEL_TTL = 60 * 60 * 1000
let channelCache: { list: FmChannel[]; at: number } | null = null

const genericDesc = (name: string): string => `${name} · 汽水听歌模式`

/** 汽水听歌模式 → FM 频道（实时拉取，含配方合并） */
export const fmChannels = async (): Promise<FmChannel[]> => {
  if (channelCache && Date.now() - channelCache.at < CHANNEL_TTL) return channelCache.list
  const modes = await sodaFeedModes()
  const list: FmChannel[] = modes.map((m) => {
    const r = RECIPES[m.key]
    return {
      key: m.key,
      name: m.name,
      sceneId: m.sceneId,
      pic: m.pic,
      desc: r?.desc || genericDesc(m.name),
      playbackRate: r?.playbackRate,
    }
  })
  if (list.length) channelCache = { list, at: Date.now() }
  return list
}

export const fmChannel = async (key: string): Promise<FmChannel | null> => {
  const list = await fmChannels()
  return list.find((c) => c.key === key) ?? null
}

// ------------------------------ 内容池 ------------------------------

interface Pool {
  ch: FmChannel
  items: OnlineItem[]
  ids: Set<string>
  /** 候选歌单队列（首轮 search/playlist 结果，按曲目数降序） */
  playlists: string[]
  /** 歌单候选是否已拉取（拉过一次就不再重复，失败也不重试，避免上游打转） */
  plSearched: boolean
  plCursor: number
  /** 关键词游标 */
  kwCursor: number
  building: boolean
  at: number
}

const pools = new Map<string, Pool>()
const POOL_TTL = 30 * 60 * 1000
const POOL_MAX = 400
/** 首轮建池至少攒够这么多才返回（不足则继续 expand） */
const POOL_TARGET = 60
/** 首轮建池并行拉取量（一次网络往返就把池子攒起来）；后续扩池降为 2/1 档 */
const PL_FIRST = 4
const KW_FIRST = 2
const PL_MORE = 2
const KW_MORE = 1

const keywordsOf = (ch: FmChannel): string[] => {
  const r = RECIPES[ch.key]
  const base = ch.name.replace(/\s+/g, ' ').trim()
  const list = r?.keywords?.length ? [...r.keywords] : [base, ...(r?.extra ?? [])]
  const seen = new Set<string>()
  return list.filter((k) => {
    const k2 = k.trim()
    if (!k2 || seen.has(k2)) return false
    seen.add(k2)
    return true
  })
}

const addItems = (p: Pool, items: OnlineItem[]): number => {
  let n = 0
  for (const it of items) {
    if (p.items.length >= POOL_MAX) break
    const id = String(it?.id ?? '')
    if (!id || p.ids.has(id)) continue
    p.ids.add(id)
    p.items.push(it)
    n++
  }
  return n
}

/** 拉取一轮内容（歌单 + 关键词并行）；返回新增条数 */
const expand = async (p: Pool): Promise<number> => {
  const ch = p.ch
  const kws = keywordsOf(ch)
  const first = !p.plSearched
  const tasks: Promise<OnlineItem[]>[] = []

  // ① 歌单候选：只在首轮拉一次（后续按游标消费）
  if (!p.plSearched) {
    p.plSearched = true
    tasks.push(
      sodaSearchPlaylists(kws[0], 1, 10)
        .then((r) => {
          p.playlists = r.list
            .filter((x) => Number(x.trackCount) > 0)
            .sort((a, b) => Number(b.trackCount) - Number(a.trackCount))
            .map((x) => String(x.id))
          return [] as OnlineItem[]
        })
        .catch(() => [] as OnlineItem[]),
    )
  }

  // ② 歌单曲目：按游标消费候选歌单（第一批多拿几个，一轮把池子攒够）
  const plN = p.plCursor === 0 ? PL_FIRST : PL_MORE
  const plBatch = p.playlists.slice(p.plCursor, p.plCursor + plN)
  p.plCursor += plBatch.length
  for (const pid of plBatch) {
    tasks.push(
      sodaPlaylistDetail(pid)
        .then((d) => d.list)
        .catch(() => [] as OnlineItem[]),
    )
  }

  // ③ 关键词单曲：按游标消费关键词
  const kwBatch = kws.slice(p.kwCursor, p.kwCursor + (first ? KW_FIRST : KW_MORE))
  p.kwCursor += kwBatch.length
  for (const kw of kwBatch) {
    tasks.push(sodaSearch(kw, 1, 30).then((r) => r.list).catch(() => [] as OnlineItem[]))
  }

  if (!tasks.length) return 0
  const got = await Promise.all(tasks)
  let n = 0
  for (const arr of got) n += addItems(p, arr)
  return n
}

const canExpand = (p: Pool): boolean =>
  p.items.length < POOL_MAX &&
  (!p.plSearched || p.plCursor < p.playlists.length || p.kwCursor < keywordsOf(p.ch).length)

/** 建池 / 复用缓存；返回可用池 */
const ensurePool = async (ch: FmChannel, want: number): Promise<Pool> => {
  const cur = pools.get(ch.key)
  let p: Pool
  if (cur && Date.now() - cur.at < POOL_TTL) {
    p = cur
  } else {
    p = { ch, items: [], ids: new Set(), playlists: [], plSearched: false, plCursor: 0, kwCursor: 0, building: false, at: Date.now() }
    pools.set(ch.key, p)
  }
  if (p.items.length >= Math.max(want, POOL_TARGET)) return p
  // 串行建池：多个并发请求同频道时，后来者等前一个建完（避免重复打上游）
  while (p.building) await new Promise((r) => setTimeout(r, 120))
  if (p.items.length >= Math.max(want, POOL_TARGET)) return p
  p.building = true
  try {
    let guard = 0
    while (p.items.length < Math.max(want, POOL_TARGET) && guard++ < 6 && canExpand(p)) {
      const n = await expand(p)
      if (!n && !canExpand(p)) break
    }
    p.at = Date.now()
  } finally {
    p.building = false
  }
  return p
}

/** 洗牌后取前 n（FM 语义：顺序随机，但不重复当前会话已播） */
const pick = <T>(arr: T[], n: number): T[] => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a.slice(0, n)
}

export interface FmNextResult {
  key: string
  name: string
  desc: string
  playbackRate: number
  list: OnlineItem[]
  /** 池内可播总量（前端可展示「池 N 首」） */
  poolSize: number
  /** true = 池已跑完一圈，本次忽略 exclude 重开（FM 不停播） */
  reset: boolean
}

/**
 * 取下一批频道曲目。
 * @param exclude 已播放过的曲目 id（前端记住的）；排除后不足 limit 时继续扩池，
 *                池子跑完一圈（exclude 覆盖全池）则忽略 exclude 重开并回 reset=true。
 */
export const fmNext = async (key: string, exclude: string[], limit: number): Promise<FmNextResult> => {
  const ch = await fmChannel(key)
  if (!ch) throw new Error('未知的 FM 频道：' + key)
  const lim = Math.min(Math.max(limit, 1), 50)
  const ex = new Set((Array.isArray(exclude) ? exclude : []).map((x) => String(x)))

  const p = await ensurePool(ch, lim + ex.size)
  let fresh = p.items.filter((i) => !ex.has(String(i.id)))
  let guard = 0
  while (fresh.length < lim && guard++ < 3 && canExpand(p)) {
    const n = await expand(p)
    if (!n) break
    fresh = p.items.filter((i) => !ex.has(String(i.id)))
  }

  let reset = false
  let list = pick(fresh, lim)
  if (!list.length && p.items.length) {
    // 全池都被 exclude（听很久了）→ 重开一圈，保证电台永不停
    reset = true
    list = pick(p.items, lim)
  }
  return {
    key: ch.key,
    name: ch.name,
    desc: ch.desc,
    playbackRate: ch.playbackRate ?? 1,
    list,
    poolSize: p.items.length,
    reset,
  }
}

/** 已建好的池子里该频道可播总量（0 = 尚未建池） */
export const fmPoolSize = (key: string): number => pools.get(key)?.items.length ?? 0
