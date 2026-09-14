// ---------------------------------------------------------------------------
// 汽水音乐（Soda Music / 抖音音乐）适配器 —— L1：全程免登录（不带 Cookie，不做解密）
//   搜索：api.qishui.com/luna/search/{track|album|playlist}（Android 客户端参数，免签名）
//   歌词：beta-luna.douyin.com/luna/h5/seo_track（web 免登录接口，LRC 明文）
//   播放：seo_track → track_player.url_player_info → PlayInfoList[].MainPlayUrl
//         免登录档位为 m4a / medium（≈64kbps），字节实测为明文 ftypM4A（无 senc），
//         可直接拉流（Range 206），无需 DRM 解密。
//   专辑：music.douyin.com/qishui/share/album 服务端渲染页 → _ROUTER_DATA.loaderData.album_page
//   歌单：api.qishui.com/luna/pc/playlist/detail（PC 参数 + cursor 分页）
//   封面：p3-luna.douyinpic.com/img/<uri>~<template_prefix>-resize:300:300.jpg
//
// L1 策略：只上架「免费全曲」，不做受限试听。
//   实测 label_info.only_vip_playable === true ⟺ 免登录只给 30/56/60s 试听片段
//   （周杰伦原版等独家曲目）；为真的一律从搜索/专辑/歌单结果里过滤，
//   解析直链时再按实际流时长二次校验，仅片段则报错，避免把试听片段当全曲落盘。
//   落盘容器 m4a：不写 ID3/MP4 标签（L1 最省事档位），曲库按「歌手/专辑/文件名」识别。
//
// 未实现 · 排行榜/榜单（实测无公开端点，故不注册 boards 能力）：
//   /luna/search/{chart|rank|billboard|toplist|hot...} 一律 ERR_INVALID_PARAM
//   （该路由白名单只有 track/album/artist/playlist）；/luna/pc/ 下 60+ 个榜单候选路径
//   全部 404；beta-luna/luna/h5/seo_* 只有 seo_track；分享页前端 chunk 也只调 seo_track。
//   榜单只能走客户端私有接口（与 L2 同源），留待 L2 一起评估。
// ---------------------------------------------------------------------------

import type { OnlineItem, OnlineSearchResult, OnlineCollection, OnlineCollectionResult, OnlineCollectionDetail } from './kw'

/** 拉取上游音频流时需要的 Referer（douyinvod 会 403 拒绝酷我/网易 Referer） */
export const SODA_REFERER = 'https://music.douyin.com/'

/** 该源音频容器扩展名（落盘 / 下载命名用） */
export const SODA_AUDIO_EXT = 'm4a'

const ANDROID_UA =
  'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)'
const PC_UA = 'LunaPC/3.3.0(359450208)'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const H5_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

const SEARCH_BASE = 'https://api.qishui.com/luna/search'
const PLAYLIST_DETAIL = 'https://api.qishui.com/luna/pc/playlist/detail'
const SEO_TRACK = 'https://beta-luna.douyin.com/luna/h5/seo_track'
const ALBUM_SHARE = 'https://www.qishui.com/share/album'
const IMG_BASE = 'https://p3-luna.douyinpic.com/img/'

const TRACK_ID_RE = /^\d{1,24}$/

/** Android 搜索通道参数（浏览器 UA 会被判为 web 端，搜索接口需要客户端身份） */
const androidParams = (): Record<string, string> => ({
  device_platform: 'android', os: 'android', ssmix: 'a', aid: '386088',
  app_name: 'luna', version_code: '100198030', version_name: '19.8.0',
  manifest_version_code: '100198030', update_version_code: '100198030',
  resolution: '1080*1920', dpi: '480', device_type: 'ABR-AL80', device_brand: 'HUAWEI',
  language: 'zh', os_api: '35', os_version: '15', ac: 'wifi', device_model: 'ABR-AL80',
  package: 'com.luna.music', iid: '2204957404569386', device_id: '2204957404565290',
})

/** PC 通道参数（歌单详情等 pc 接口需要 windows 端身份） */
const pcParams = (): Record<string, string> => {
  const now = Date.now()
  const deviceId = String(now)
  return {
    aid: '386088', app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: deviceId, cdid: '', iid: String(now + 1), version_name: '3.3.0', version_code: '30030000',
    channel: 'official', build_mode: 'master', network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai',
    resolution: '', device_platform: 'windows', device_type: 'Windows', os_version: 'Windows 11',
    fp: deviceId,
  }
}

const qs = (p: Record<string, string>): string =>
  Object.keys(p).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&')

const fetchText = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12_000,
): Promise<string> => {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    headers: { Accept: '*/*', ...headers },
  })
  if (!resp.ok) throw new Error(`汽水接口 HTTP ${resp.status}`)
  return resp.text()
}

const fetchJson = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12_000,
): Promise<any> => {
  const text = await fetchText(url, headers, timeoutMs)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('汽水接口返回非 JSON（接口可能已变更）')
  }
}

// ------------------------------ 字段映射 ------------------------------

const artistsOf = (raw: any): string => {
  const arr: any[] = Array.isArray(raw) ? raw : []
  const names = arr
    .map((a) => String(a?.name ?? a?.user_info?.nickname ?? a?.nickname ?? '').trim())
    .filter(Boolean)
  return names.join('、')
}

/**
 * 封面：url_cover 里 urls 是图床前缀、uri 是对象名、template_prefix 是处理模板。
 * 拼成 <前缀><uri>~<模板>-resize:WxH.jpg（实测 200 image/jpeg；不带模板会 400）。
 */
const sodaPic = (img: any): string | null => {
  const uri = String(img?.uri ?? '').trim()
  const prefix = String(img?.template_prefix ?? '').trim()
  const base = Array.isArray(img?.urls) ? String(img.urls[0] ?? '').trim() : ''
  if (uri && prefix) return `${IMG_BASE}${uri}~${prefix}-resize:300:300.jpg`
  if (uri && base) return base.replace(/\/?$/, '/') + uri
  return null
}

/** 仅 VIP 可播 = 免登录只给试听片段 → L1 不上架 */
const isFreeFull = (labelInfo: any): boolean => !(labelInfo && labelInfo.only_vip_playable === true)

/** track 实体 → 列表项（VIP 专属曲目返回 null，由调用方过滤） */
const toItem = (track: any, fallbackAlbum = ''): OnlineItem | null => {
  const id = String(track?.id ?? '').trim()
  if (!TRACK_ID_RE.test(id)) return null
  if (!isFreeFull(track?.label_info)) return null
  return {
    source: 'soda',
    id,
    name: String(track?.name ?? '未知歌曲'),
    singer: artistsOf(track?.artists) || '未知歌手',
    album: String(track?.album?.name ?? fallbackAlbum ?? ''),
    intervalMs: parseInt(String(track?.duration ?? '0'), 10) || 0,
    pic: sodaPic(track?.album?.url_cover),
  }
}

const mapItems = (tracks: any[], fallbackAlbum = ''): OnlineItem[] =>
  tracks.map((t) => toItem(t, fallbackAlbum)).filter((x): x is OnlineItem => !!x)

// ------------------------------ 搜索 ------------------------------

interface SearchGroup { data?: any[], has_more?: boolean, next_cursor?: string }

const searchGroup = async (type: string, keyword: string, page: number, size: number): Promise<SearchGroup> => {
  const p = Math.max(1, page)
  const n = Math.min(Math.max(size, 1), 30)
  const url =
    `${SEARCH_BASE}/${type}?` +
    qs({ ...androidParams(), q: keyword, cursor: String((p - 1) * n), count: String(n) })
  const j = await fetchJson(url, { 'User-Agent': ANDROID_UA })
  const groups: any[] = Array.isArray(j?.result_groups) ? j.result_groups : []
  return (groups[0] ?? {}) as SearchGroup
}

/**
 * 上游不返回命中总数，只给 has_more/next_cursor；按「已取条数 + 还有下一页」估算 total，
 * 仅用于前端「加载更多」按钮的显隐（末页返回 has_more=false 时自然收敛）。
 */
const estimateTotal = (page: number, size: number, got: number, hasMore: boolean): number =>
  (page - 1) * size + got + (hasMore ? size : 0)

export const sodaSearch = async (keyword: string, page: number, size: number): Promise<OnlineSearchResult> => {
  const p = Math.max(1, page)
  const n = Math.min(Math.max(size, 1), 30)
  const g = await searchGroup('track', keyword, p, n)
  const raw: any[] = Array.isArray(g.data) ? g.data : []
  const list = mapItems(raw.map((d) => d?.entity?.track).filter(Boolean))
  return { list, total: estimateTotal(p, n, list.length, g.has_more === true), page: p, size: n }
}

export const sodaSearchAlbums = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const p = Math.max(1, page)
  const n = Math.min(Math.max(size, 1), 30)
  const g = await searchGroup('album', keyword, p, n)
  const raw: any[] = Array.isArray(g.data) ? g.data : []
  const list: OnlineCollection[] = []
  for (const d of raw) {
    const a = d?.entity?.album
    const id = String(a?.id ?? '').trim()
    if (!id) continue
    list.push({
      source: 'soda',
      id,
      name: String(a?.name ?? '未知专辑'),
      creator: artistsOf(a?.artists),
      trackCount: parseInt(String(a?.count_tracks ?? '0'), 10) || 0,
      pic: sodaPic(a?.url_cover),
    })
  }
  return { list, total: estimateTotal(p, n, list.length, g.has_more === true), page: p, size: n }
}

export const sodaSearchPlaylists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const p = Math.max(1, page)
  const n = Math.min(Math.max(size, 1), 30)
  const g = await searchGroup('playlist', keyword, p, n)
  const raw: any[] = Array.isArray(g.data) ? g.data : []
  const list: OnlineCollection[] = []
  for (const d of raw) {
    const pl = d?.entity?.playlist
    const id = String(pl?.id ?? '').trim()
    if (!id) continue
    list.push({
      source: 'soda',
      id,
      name: String(pl?.title || pl?.public_title || '未知歌单'),
      creator: String(pl?.owner?.public_name || pl?.owner?.nickname || ''),
      trackCount: parseInt(String(pl?.count_tracks ?? '0'), 10) || 0,
      pic: sodaPic(pl?.url_cover),
    })
  }
  return { list, total: estimateTotal(p, n, list.length, g.has_more === true), page: p, size: n }
}

// ------------------------------ 详情 ------------------------------

/** 从服务端渲染页里抠出 _ROUTER_DATA 的 JSON（按括号配对，避免正则被字符串内的花括号骗到） */
const extractRouterData = (page: string): any => {
  const marker = '_ROUTER_DATA'
  let start = page.indexOf(marker)
  if (start < 0) throw new Error('汽水页面结构已变更（未找到 _ROUTER_DATA）')
  start = page.indexOf('{', start + marker.length)
  if (start < 0) throw new Error('汽水页面结构已变更（未找到数据块）')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < page.length; i++) {
    const ch = page[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(page.slice(start, i + 1))
        } catch {
          throw new Error('汽水页面数据解析失败')
        }
      }
    }
  }
  throw new Error('汽水页面数据不完整')
}

export const sodaAlbumDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  if (!/^\d{1,24}$/.test(id)) throw new Error('汽水 albumId 非法')
  const html = await fetchText(`${ALBUM_SHARE}?album_id=${encodeURIComponent(id)}`, {
    'User-Agent': H5_UA,
    Referer: SODA_REFERER,
  }, 15_000)
  const data = extractRouterData(html)
  const albumPage = data?.loaderData?.album_page
  const info = albumPage?.albumInfo
  if (!info?.id) throw new Error('汽水：专辑不存在或已下架')
  const tracks: any[] = Array.isArray(albumPage?.trackList) ? albumPage.trackList : []
  const name = String(info.name ?? '未知专辑')
  const list = mapItems(tracks, name)
  return {
    info: {
      source: 'soda',
      id: String(info.id),
      name,
      creator: artistsOf(info.artists) || String(info.company ?? ''),
      trackCount: parseInt(String(info.count_tracks ?? '0'), 10) || list.length,
      pic: sodaPic(info.url_cover),
    },
    list,
  }
}

/** 歌单详情单页返回体较大（约 50KB/首），限制页数避免超长拉取 */
const PLAYLIST_MAX_PAGES = 8
const PLAYLIST_PAGE_SIZE = 50

export const sodaPlaylistDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  if (!/^\d{1,24}$/.test(id)) throw new Error('汽水 playlistId 非法')
  const tracks: any[] = []
  let info: any = null
  let cursor = ''
  for (let page = 0; page < PLAYLIST_MAX_PAGES; page++) {
    const url =
      `${PLAYLIST_DETAIL}?` +
      qs({ ...pcParams(), playlist_id: id, cursor, count: String(PLAYLIST_PAGE_SIZE) })
    const j = await fetchJson(url, {
      'User-Agent': PC_UA,
      'x-luna-background-type': 'foreground',
      'x-luna-is-background-req': '0',
    }, 20_000)
    if (page === 0) {
      info = j?.playlist
      if (!info?.id) throw new Error('汽水：歌单不存在或已下架')
    }
    const resources: any[] = Array.isArray(j?.media_resources) ? j.media_resources : []
    for (const r of resources) {
      if (r?.type && r.type !== 'track') continue
      const t = r?.entity?.track_wrapper?.track
      if (t) tracks.push(t)
    }
    if (j?.has_more !== true) break
    const next = String(j?.next_cursor ?? '').trim()
    if (!next || next === cursor) break
    cursor = next
  }
  const list = mapItems(tracks)
  return {
    info: {
      source: 'soda',
      id: String(info.id),
      name: String(info.title || info.public_title || '未知歌单'),
      creator: String(info.owner?.public_name || info.owner?.nickname || ''),
      trackCount: parseInt(String(info.count_tracks ?? '0'), 10) || list.length,
      pic: sodaPic(info.url_cover),
    },
    list,
  }
}

// ------------------------------ 播放 / 歌词 ------------------------------

/** 免登录 seo_track 详情（含 track/歌词/播放信息入口） */
const seoTrack = async (id: string): Promise<any> => {
  if (!TRACK_ID_RE.test(id)) throw new Error('汽水 trackId 非法')
  const j = await fetchJson(
    `${SEO_TRACK}?track_id=${encodeURIComponent(id)}&device_platform=web`,
    { 'User-Agent': WEB_UA, 'X-Requested-With': 'XMLHttpRequest', cookie: '' },
    15_000,
  )
  const code = Number(j?.status_code ?? 0)
  if (code !== 0) throw new Error('汽水详情失败：' + String(j?.status_info?.status_msg ?? code))
  const track = j?.seo_track?.track
  if (!track?.id) throw new Error('汽水：曲目不存在')
  return j
}

/** 播放信息：优先取「实际时长最长」的流（试听片段时长必然明显短于全曲） */
const bestPlayInfo = (list: any[]): any | null => {
  let best: any = null
  for (const it of Array.isArray(list) ? list : []) {
    const url = String(it?.MainPlayUrl ?? it?.main_play_url ?? it?.BackupPlayUrl ?? it?.backup_play_url ?? '').trim()
    if (!url) continue
    if (!best) { best = it; continue }
    const a = Number(it?.Duration ?? it?.duration ?? 0)
    const b = Number(best?.Duration ?? best?.duration ?? 0)
    if (a > b) { best = it; continue }
    if (a === b && Number(it?.Size ?? it?.size ?? 0) > Number(best?.Size ?? best?.size ?? 0)) best = it
  }
  return best
}

/** 解析免登录播放直链；仅试听片段/需账号授权的曲目一律报错（L1 不上架） */
export const sodaPlayUrl = async (id: string): Promise<string> => {
  const seo = await seoTrack(id)
  const track = seo.seo_track.track
  if (!isFreeFull(track?.label_info)) {
    throw new Error('汽水：该曲仅 VIP 可听（免登录只有试听片段），L1 只提供免费全曲')
  }
  let info = bestPlayInfo(track?.audio_info?.play_info_list)
  if (!info) {
    const playerInfoUrl = String(seo?.track_player?.url_player_info ?? '').trim()
    if (!playerInfoUrl) throw new Error('汽水未返回可播放地址（可能版权受限）')
    const pj = await fetchJson(playerInfoUrl, { 'User-Agent': WEB_UA, Referer: SODA_REFERER }, 15_000)
    info = bestPlayInfo(pj?.Result?.Data?.PlayInfoList ?? [])
  }
  if (!info) throw new Error('汽水未返回可播放地址（可能版权受限）')
  if (String(info.PlayAuth ?? info.play_auth ?? '').trim()) {
    // 带 PlayAuth 的流是加密的，L1 不做解密（L2 才处理）
    throw new Error('汽水：该曲需要账号授权（加密流，L1 不解密）')
  }
  const fullSec = Math.round((parseInt(String(track?.duration ?? '0'), 10) || 0) / 1000)
  const streamSec = Math.round(Number(info?.Duration ?? info?.duration ?? 0))
  if (fullSec > 0 && streamSec > 0 && streamSec + 5 < fullSec) {
    throw new Error(`汽水：仅提供试听片段（${streamSec}s / 全长 ${fullSec}s）`)
  }
  const url = String(info?.MainPlayUrl ?? info?.main_play_url ?? info?.BackupPlayUrl ?? '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('汽水未返回可播放地址')
  return url
}

/** 汽水歌词为 [起始ms,持续ms]<词级时间>文本 的行格式，转标准 LRC 并去掉词级标记 */
const toLrc = (raw: string): string => {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(s)
    if (!m) continue
    const start = parseInt(m[1], 10) || 0
    const text = m[3].replace(/<[^>]*>/g, '').trim()
    if (!text) continue
    const mm = String(Math.floor(start / 60000)).padStart(2, '0')
    const ss = String(Math.floor((start % 60000) / 1000)).padStart(2, '0')
    const cs = String(Math.floor((start % 1000) / 10)).padStart(2, '0')
    out.push(`[${mm}:${ss}.${cs}]${text}`)
  }
  return out.join('\n')
}

export const sodaLyric = async (id: string): Promise<{ lyric: string; tlyric: string }> => {
  try {
    const seo = await seoTrack(id)
    const raw = String(seo?.seo_track?.lyric?.content || seo?.lyric?.content || '')
    return { lyric: raw ? toLrc(raw) : '', tlyric: '' }
  } catch {
    return { lyric: '', tlyric: '' }
  }
}
