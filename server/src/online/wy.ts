// ---------------------------------------------------------------------------
// 网易云音乐平台适配器（内置在线源）
//   通道：云音乐网页 eapi/batch 网关（AES-128-ECB 密文，eapiKey 官方常量）
//   搜索：/api/search/song/list/page（匿名可用）
//   试听：/api/song/enhance/player/url → music.126.net 直链（NAS 代理拉流）
//   歌词：/api/song/lyric → 明文 LRC（含 tlyric 翻译）
//   封面：simpleSongData.al.picUrl（https 直链）
//   说明：算法源自 lx-music-desktop v2.12.2（Apache-2.0）wy/utils/crypto.js；
//         仅公开内容试听（128k standard），不做 VIP/无损解锁。
// ---------------------------------------------------------------------------

import type { OnlineItem, OnlineSearchResult, OnlineCollection, OnlineCollectionResult, OnlineCollectionDetail } from './kw'
import { createHash, createCipheriv, randomBytes, publicEncrypt, constants } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const EAPI_KEY = 'e82ckenh8dichen8'
const EAPI_HOST = 'https://interface.music.163.com/eapi/batch'

const aesEncryptEcb = (buf: Buffer): Buffer => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY), null)
  return Buffer.concat([c.update(buf), c.final()])
}

/** eapi 密文参数（算法照抄 desktop wy/utils/crypto.js eapi()） */
export const wyEapiParams = (url: string, obj: unknown): string => {
  const text = typeof obj === 'object' ? JSON.stringify(obj) : String(obj)
  const digest = createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex')
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return aesEncryptEcb(Buffer.from(data)).toString('hex').toUpperCase()
}

const eapiPost = async (url: string, data: unknown): Promise<any> => {
  const resp = await fetch(EAPI_HOST, {
    method: 'POST',
    signal: AbortSignal.timeout(12_000),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://music.163.com',
      Referer: 'https://music.163.com/',
      Accept: '*/*',
    },
    body: 'params=' + encodeURIComponent(wyEapiParams(url, data)),
  })
  if (!resp.ok) throw new Error(`网易接口 HTTP ${resp.status}`)
  let json: any
  try {
    json = await resp.json()
  } catch {
    throw new Error('网易接口响应异常')
  }
  if (!json || (json.code !== undefined && json.code !== 200)) {
    throw new Error('网易接口返回 ' + (json && json.code != null ? 'code=' + json.code : '空数据'))
  }
  return json
}

const joinSinger = (ar: any[]): string => (Array.isArray(ar) ? ar.map((a) => String(a?.name ?? '')).filter(Boolean).join('、') : '')

export const wySearch = async (keyword: string, page: number, size: number): Promise<OnlineSearchResult> => {
  const json = await eapiPost('/api/search/song/list/page', {
    keyword,
    needCorrect: '1',
    channel: 'typing',
    offset: size * (page - 1),
    scene: 'normal',
    total: page == 1,
    limit: size,
  })
  const resources: any[] = Array.isArray(json.data?.resources) ? json.data.resources : []
  const list: OnlineItem[] = []
  for (const res of resources) {
    const it = res?.baseInfo?.simpleSongData
    if (!it?.id) continue
    list.push({
      source: 'wy',
      id: String(it.id),
      name: String(it.name || '未知歌曲'),
      singer: joinSinger(it.ar),
      album: String(it.al?.name || ''),
      intervalMs: (parseInt(String(it.dt ?? '0'), 10) || 0),
      pic: /^https?:\/\//.test(String(it.al?.picUrl ?? '')) ? String(it.al.picUrl) : null,
    })
  }
  return { list, total: parseInt(String(json.data?.totalCount ?? '0'), 10) || 0, page, size }
}

/** 网易云专辑搜索（公开老 API /api/search/get/web，type=10） */
export const wySearchAlbums = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const url =
    'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) +
    '&type=10&limit=' + size + '&offset=' + (size * (page - 1))
  const resp = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } })
  if (!resp.ok) throw new Error('网易接口 HTTP ' + resp.status)
  const json: any = await resp.json().catch(() => null)
  const arr: any[] = Array.isArray(json?.result?.albums) ? json.result.albums : []
  const list: OnlineCollection[] = arr
    .filter((it) => it?.id)
    .map((it) => ({
      source: 'wy',
      id: String(it.id),
      name: String(it.name || '未知专辑'),
      creator: String(it.artist?.name || it.company || ''),
      trackCount: parseInt(String(it.size ?? '0'), 10) || 0,
      pic: /^https?:\/\//.test(String(it.picUrl ?? '')) ? String(it.picUrl) : null,
    }))
  return { list, total: parseInt(String(json?.result?.albumCount ?? '0'), 10) || list.length, page, size }
}

/** 网易云歌单搜索（公开老 API /api/search/get/web，type=1000） */
export const wySearchPlaylists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const url =
    'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) +
    '&type=1000&limit=' + size + '&offset=' + (size * (page - 1))
  const resp = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' } })
  if (!resp.ok) throw new Error('网易接口 HTTP ' + resp.status)
  const json: any = await resp.json().catch(() => null)
  const arr: any[] = Array.isArray(json?.result?.playlists) ? json.result.playlists : []
  const list: OnlineCollection[] = arr
    .filter((it) => it?.id)
    .map((it) => ({
      source: 'wy',
      id: String(it.id),
      name: String(it.name || '未知歌单'),
      creator: String(it.creator?.nickname || ''),
      trackCount: parseInt(String(it.trackCount ?? '0'), 10) || 0,
      pic: /^https?:\/\//.test(String(it.coverImgUrl ?? '')) ? String(it.coverImgUrl) : null,
    }))
  return { list, total: parseInt(String(json?.result?.playlistCount ?? '0'), 10) || list.length, page, size }
}

/** 批量单曲信息（eapi /api/song/detail；ids 每批最多 100） */
const wySongDetail = async (ids: number[]): Promise<OnlineItem[]> => {
  if (!ids.length) return []
  const json = await eapiPost('/api/song/detail', {
    ids: '[' + ids.join(',') + ']',
    c: '[' + ids.map((x) => '{"id":' + x + '}').join(',') + ']',
  })
  const arr: any[] = Array.isArray(json.songs) ? json.songs : []
  const out: OnlineItem[] = []
  for (const it of arr) {
    if (!it?.id) continue
    out.push({
      source: 'wy',
      id: String(it.id),
      name: String(it.name || '未知歌曲'),
      singer: (Array.isArray(it.artists) ? it.artists.map((a: any) => String(a?.name ?? '')).filter(Boolean).join('、') : ''),
      album: String(it.album?.name || ''),
      intervalMs: parseInt(String(it.duration ?? it.dt ?? '0'), 10) || 0,
      pic: /^https?:\/\//.test(String(it.album?.picUrl ?? '')) ? String(it.album.picUrl) : null,
    })
  }
  return out
}

/** 网易云歌单详情：v6/detail 拿 trackIds → song/detail 分批取全量曲目 */
export const wyPlaylistDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  if (!/^\d{1,16}$/.test(id)) throw new Error('歌单 id 非法')
  const resp = await fetch('https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000&s=8', {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': UA, Referer: 'https://music.163.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) throw new Error('网易接口 HTTP ' + resp.status)
  const json: any = await resp.json().catch(() => null)
  const pl: any = json?.playlist
  if (!pl) throw new Error('歌单不存在或已被删除')
  const trackIds: number[] = Array.isArray(pl.trackIds) ? pl.trackIds.map((x: any) => Number(x?.id)).filter((x: number) => x > 0) : []
  if (!trackIds.length) throw new Error('歌单为空')
  // 分批取单曲信息（每批 100）
  const list: OnlineItem[] = []
  for (let i = 0; i < trackIds.length; i += 100) {
    const batch = trackIds.slice(i, i + 100)
    const items = await wySongDetail(batch).catch(() => [])
    list.push(...items)
    if (i + 100 >= trackIds.length) break
  }
  return {
    info: {
      source: 'wy',
      id,
      name: String(pl.name || '未知歌单'),
      creator: String(pl.creator?.nickname || ''),
      trackCount: parseInt(String(pl.trackCount ?? list.length), 10) || list.length,
      pic: /^https?:\/\//.test(String(pl.coverImgUrl ?? '')) ? String(pl.coverImgUrl) : null,
    },
    list,
  }
}

/** 网易云专辑详情：老接口/eapi/weapi 均受风控，暂不可用（能力位不含 detail） */
export const wyAlbumDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  throw new Error('网易云专辑曲目接口暂不可用，试试搜索同名单曲或导入歌单')
}

/** 解析网易试听直链（eapi enhance/player/url，standard=128k） */
export const wyPlayUrl = async (id: string): Promise<string> => {
  if (!/^\d{1,16}$/.test(id)) throw new Error('歌曲 id 非法')
  const json = await eapiPost('/api/song/enhance/player/url', { ids: '[' + id + ']', br: 128000, level: 'standard' })
  const it: any = Array.isArray(json.data) ? json.data[0] : null
  const url = it?.url
  if (!/^https?:\/\//.test(String(url ?? ''))) throw new Error('该歌曲暂无可播放地址（版权或 VIP 受限）')
  return url as string
}

// ---------------------------------------------------------------------------
// weapi（旧版网页加密通道：AES-128-CBC 双加密 + RSA_NO_PADDING encSecKey）
//   算法照抄 desktop wy/utils/crypto.js weapi()；用于榜单/歌单详情类接口。
// ---------------------------------------------------------------------------
const WY_IV = Buffer.from('0102030405060708')
const WY_PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud')
const WY_BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const WY_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'

const aesCbcEncrypt = (buf: Buffer, key: Buffer, iv: Buffer): Buffer => {
  const c = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([c.update(buf), c.final()])
}

const wyWeapiForm = (obj: unknown): { params: string; encSecKey: string } => {
  const text = JSON.stringify(obj)
  const secretKey = Buffer.from(randomBytes(16).map((n) => WY_BASE62.charCodeAt(n % 62)))
  const first = aesCbcEncrypt(Buffer.from(text), WY_PRESET_KEY, WY_IV).toString('base64')
  const params = aesCbcEncrypt(Buffer.from(first), secretKey, WY_IV).toString('base64')
  const padded = Buffer.concat([Buffer.alloc(128 - secretKey.length), Buffer.from(secretKey).reverse()])
  const encSecKey = publicEncrypt({ key: WY_PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, padded).toString('hex')
  return { params, encSecKey }
}

const weapiPost = async (path: string, data: unknown): Promise<any> => {
  const { params, encSecKey } = wyWeapiForm(data)
  const resp = await fetch('https://music.163.com' + path, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://music.163.com',
      Referer: 'https://music.163.com/',
      Accept: '*/*',
    },
    body: `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`,
  })
  if (!resp.ok) throw new Error(`网易接口 HTTP ${resp.status}`)
  let json: any
  try {
    json = await resp.json()
  } catch {
    throw new Error('网易接口响应异常')
  }
  if (!json || (json.code !== undefined && json.code !== 200)) {
    throw new Error('网易接口返回 ' + (json && json.code != null ? 'code=' + json.code : '空数据'))
  }
  return json
}

// ---------------------------------------------------------------------------
// 榜单（桌面版内置 topList 子集 + weapi 详情）
// ---------------------------------------------------------------------------
export interface WyBoard { id: string; name: string; bangid: string }
export const WY_BOARDS: WyBoard[] = [
  { id: 'bsb', name: '飙升榜', bangid: '19723756' },
  { id: 'rgb', name: '热歌榜', bangid: '3778678' },
  { id: 'xgb', name: '新歌榜', bangid: '3779629' },
  { id: 'ycb', name: '原创榜', bangid: '2884035' },
  { id: 'hyb', name: '韩语榜', bangid: '745956260' },
  { id: 'dyb', name: '抖音榜', bangid: '2250011882' },
  { id: 'diany', name: '电音榜', bangid: '1978921795' },
  { id: 'gdb', name: '古典榜', bangid: '71384707' },
  { id: 'acg', name: 'ACG 榜', bangid: '71385702' },
  { id: 'ygb', name: '欧美热歌榜', bangid: '2809513713' },
  { id: 'ygx', name: '欧美新歌榜', bangid: '2809577409' },
  { id: 'rby', name: '日语榜', bangid: '5059644681' },
  { id: 'rygy', name: '摇滚榜', bangid: '5059633707' },
  { id: 'gf', name: '国风榜', bangid: '5059642708' },
  { id: 'my', name: '民谣榜', bangid: '5059661515' },
  { id: 'bb', name: 'Billboard 榜', bangid: '60198' },
  { id: 'oricon', name: '日本 Oricon 榜', bangid: '60131' },
]

/** 榜单曲目（取前 limit 首并转 OnlineItem，含封面） */
export const wyBoardList = async (bangid: string, limit: number): Promise<OnlineSearchResult> => {
  const j = await weapiPost('/weapi/v3/playlist/detail', { id: Number(bangid), n: 100000, s: 8 })
  const trackIds: number[] = (j.playlist?.trackIds ?? []).map((t: any) => Number(t.id)).filter((n: number) => n > 0)
  if (!trackIds.length) return { list: [], total: 0, page: 1, size: limit }
  const slice = trackIds.slice(0, Math.min(limit, 500))
  const detail = await weapiPost('/weapi/v3/song/detail', {
    c: '[' + slice.map((id) => '{"id":' + id + '}').join(',') + ']',
    ids: '[' + slice.join(',') + ']',
  })
  const list: OnlineItem[] = (detail.songs ?? [])
    .filter((s: any) => s && s.id && s.al)
    .map((s: any) => ({
      source: 'wy',
      id: String(s.id),
      name: String(s.name || '未知歌曲'),
      singer: joinSinger(s.ar),
      album: String(s.al?.name || ''),
      intervalMs: parseInt(String(s.dt ?? '0'), 10) || 0,
      pic: /^https?:\/\//.test(String(s.al?.picUrl ?? '')) ? String(s.al.picUrl) : null,
    }))
  return { list, total: slice.length, page: 1, size: limit }
}

/** 网易云歌词（主词 + 翻译），返回 LRC 文本；无歌词时 lyric='' */
export const wyLyric = async (id: string): Promise<{ lyric: string; tlyric: string }> => {
  if (!/^\d{1,16}$/.test(id)) return { lyric: '', tlyric: '' }
  try {
    const json = await eapiPost('/api/song/lyric', { id: Number(id), lv: -1, tv: -1, kv: -1 })
    return {
      lyric: String(json.lrc?.lyric ?? ''),
      tlyric: String(json.tlyric?.lyric ?? ''),
    }
  } catch {
    return { lyric: '', tlyric: '' }
  }
}
