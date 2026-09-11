// ---------------------------------------------------------------------------
// 跨源歌词兜底（免费公开歌词通道）
//   NAS 曲库歌词缺失时，按「歌名 + 歌手」到酷狗 / QQ 音乐的免费歌词接口检索补齐。
//   仅歌词文本，无音频取链；检索失败/无命中一律回空（调用方展示原空态）。
//   通道：酷狗 lyrics.kugou.com search/download（KG-RC 通道，免登录）；
//         QQ musicu.fcg PlayLyricInfo（base64 LRC，免登录）。
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises'
import path from 'node:path'
import { LRUCache } from 'lru-cache'
import { extractLyric as nasExtractLyric } from '@/library/metadata'
import { getTrack, type TrackInfo } from '@/library'
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const UA_KG = 'KuGou2012-9020-ExpandSearchManager'
const KG_THASH = 'expand_search_manager.cpp:852736169:451'

const fetchText = async (url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<string> => {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}

const fetchJson = async (url: string, init: RequestInit & { headers: Record<string, string> }): Promise<any> => {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

// ---------------- 酷狗 ----------------

const kgSearchLyricId = async (name: string, singer: string, hash: string, timelengthMs: number): Promise<{ id: string; accesskey: string } | null> => {
  const keyword = singer ? `${singer} ${name}` : name
  const url = `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&hash=${hash}&timelength=${timelengthMs}&lrctxt=1&duration=${timelengthMs}`
  const j = await fetchJson(url, { headers: { 'KG-RC': '1', 'KG-THash': KG_THASH, 'User-Agent': UA_KG } })
  const c = (j?.candidates ?? []).find((x: any) => x?.id && x?.accesskey)
  return c ? { id: String(c.id), accesskey: String(c.accesskey) } : null
}

const kgDownloadLyric = async (id: string, accesskey: string): Promise<string> => {
  const url = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(id)}&accesskey=${encodeURIComponent(accesskey)}&fmt=lrc&decode=1`
  const j = await fetchJson(url, { headers: { 'KG-RC': '1', 'KG-THash': KG_THASH, 'User-Agent': UA_KG } })
  if (j?.status !== 200 || !j?.content) return ''
  return Buffer.from(String(j.content), 'base64').toString('utf8')
}

export const kgLyricByText = async (name: string, singer: string, timelengthMs: number): Promise<string> => {
  // hash 参数仅在真正持有酷狗 hash 时才有效；跨源兜底场景传空 hash，接口按 keyword 匹配
  const c = await kgSearchLyricId(name, singer, '', timelengthMs)
  if (!c) return ''
  return kgDownloadLyric(c.id, c.accesskey)
}

// ---------------- QQ 音乐 ----------------

const TX_SEARCH_COMM = { ct: '19', cv: '1845', uin: '0' }

const txMusicuPost = async (payload: unknown): Promise<any> => {
  const resp = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'User-Agent': UA_BROWSER,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
    },
    body: JSON.stringify({ comm: TX_SEARCH_COMM, req: payload }),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

export const txLyricByText = async (name: string, singer: string): Promise<string> => {
  // 1) 搜索拿 songMID
  const search = await txMusicuPost({
    module: 'music.search.SearchCgiService',
    method: 'DoSearchForQQMusicDesktop',
    param: { search_type: 0, query: singer ? `${name} ${singer}` : name, page_num: 1, num_per_page: 5 },
  })
  const songs: any[] = search?.req?.data?.body?.song?.list ?? []
  if (!songs.length) return ''
  // 取与歌手最匹配的首个结果（无歌手信息时取第一条）
  const hit = singer
    ? songs.find((s) => (s.singer ?? []).some((x: any) => String(x?.name ?? '').includes(singer) || singer.includes(String(x?.name ?? '')))) ?? songs[0]
    : songs[0]
  if (!hit?.mid) return ''
  // 2) 拉歌词（base64 LRC）
  const lyric = await txMusicuPost({
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo',
    param: { songMID: String(hit.mid) },
  })
  if (lyric?.req?.code !== 0 || !lyric?.req?.data?.lyric) return ''
  const text = Buffer.from(String(lyric.req.data.lyric), 'base64').toString('utf8')
  return text.includes('[') ? text : ''
}

// ---------------- 统一兜底入口 ----------------

export interface LyricFallbackResult { lyric: string; provider: string }

// ---------------------------------------------------------------------------
// 兜底歌词缓存（跨源外部检索结果）
//   QQ 搜索接口对短时间高频调用有风控（回 0 条），且无歌词曲目每次都打外部接口。
//   键为 trackId（rescan 后 id 变化即自然失效），值含 lyric/provider 与源文件
//   mtime+size 快照；文件被替换后快照不匹配即失效重取。
//   NAS 内嵌/.lrc 命中走 metadata 层快路径，不进本缓存。
// ---------------------------------------------------------------------------

const FALLBACK_CACHE_FILE = (): string => path.join(global.lx.dataPath, 'lyric-cache.json')
const FALLBACK_TTL = 7 * 24 * 60 * 60 * 1000

interface CachedLyric { lyric: string, provider: string, mtime: number, size: number, savedAt: number }

let fallbackCache: LRUCache<string, CachedLyric> = new LRUCache({ max: 512, ttl: FALLBACK_TTL })

const loadFallbackCache = async (): Promise<void> => {
  try {
    const data = JSON.parse(await fs.readFile(FALLBACK_CACHE_FILE(), 'utf8')) as { entries?: Record<string, CachedLyric> }
    const fresh = new LRUCache<string, CachedLyric>({ max: 512, ttl: FALLBACK_TTL })
    if (data && typeof data.entries == 'object') {
      for (const [k, v] of Object.entries(data.entries)) {
        if (v && typeof v.lyric == 'string' && v.lyric.includes('[')) fresh.set(k, v)
      }
    }
    fallbackCache = fresh
  } catch { /* 首启或文件损坏：用空缓存 */ }
}

let cacheWriteChain: Promise<void> = Promise.resolve()
const persistFallbackCache = (): void => {
  const entries: Record<string, CachedLyric> = {}
  fallbackCache.forEach((v, k) => { entries[k] = v })
  const snapshot = JSON.stringify({ version: 1, entries })
  cacheWriteChain = cacheWriteChain.then(async () => {
    const file = FALLBACK_CACHE_FILE()
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, snapshot)
    await fs.rename(tmp, file)
  }).catch(() => {})
}

void loadFallbackCache()

const rememberFallback = (trackId: string, track: TrackInfo, lyric: string, provider: string): void => {
  fallbackCache.set(trackId, { lyric, provider, mtime: track.mtime, size: track.size, savedAt: Date.now() })
  persistFallbackCache()
}

/**
 * 歌词兜底：NAS 内嵌/同目录 .lrc 优先（extractLyric），失败按文本跨源检索。
 * provider 标识来源（nas/kg/tx），空串表示全部未命中。
 *
 * 重载：当调用方已从租户曲库拿到 TrackInfo（Web 端）时，直接传入以跳过全局 getTrack 查找，
 * 避免跨租户误命中；缓存 key 用 trackId + filePath 组合，源文件变即失效。
 */
export const lyricWithFallback = async (trackId: string, preResolved?: TrackInfo): Promise<LyricFallbackResult> => {
  const track = preResolved ?? getTrack(trackId)
  if (!track) return { lyric: '', provider: '' }
  // 缓存键：全局/租户 id 空间可能重叠，追加 filePath 隔离
  const cacheKey = preResolved ? `${trackId}|${track.filePath}` : trackId
  const nas = await nasExtractLyric(track.filePath).catch(() => null)
  if (nas && nas.includes('[')) return { lyric: nas, provider: 'nas' }

  // 跨源兜底缓存命中：源文件 mtime+size 未变即直接返回（免打外部接口）
  const cached = fallbackCache.peek(cacheKey)
  if (cached && cached.mtime === track.mtime && cached.size === track.size && cached.lyric.includes('[')) {
    return { lyric: cached.lyric, provider: cached.provider }
  }

  const name = track.name
  const singer = track.singer || ''
  try {
    const kg = await kgLyricByText(name, singer, 0)
    if (kg.includes('[')) { rememberFallback(cacheKey, track, kg, 'kg'); return { lyric: kg, provider: 'kg' } }
  } catch { /* 下一个源 */ }
  try {
    const tx = await txLyricByText(name, singer)
    if (tx.includes('[')) { rememberFallback(cacheKey, track, tx, 'tx'); return { lyric: tx, provider: 'tx' } }
  } catch { /* 放弃 */ }
  return { lyric: '', provider: '' }
}
