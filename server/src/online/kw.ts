// ---------------------------------------------------------------------------
// 酷我音乐平台适配器（内置在线源 · 方案 B）
//   搜索：search.kuwo.cn r.s 公开接口（免签名，响应为单引号 JSON）
//   试听：antiserver.kuwo.cn convert_url3 → mp3 直链（NAS 代理拉流）
//   封面：img3.sycdn.kuwo.cn star/albumcover/{web_albumpic_short}（旧域名 img1.kuwo.cn 已停用）
//   说明：仅用于 Web 播放器的在线搜索/试听；不做 VIP/无损解锁，纯公开内容。
// ---------------------------------------------------------------------------

import { decodeName } from '@/utils/common'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * 上游字段里混着两类脏字符，都要洗掉：
 *   1) HTML 实体：`Baby&nbsp;Don&apos;t&nbsp;Hurt&nbsp;Me`
 *   2) 「字面量 \uXXXX」：上游把 & 双重转义成 \u0026，JSON.parse 之后仍是这六个字符
 * 不洗的话，搜索结果与推荐列表会把这些转义串原样显示出来。
 */
const cleanText = (raw: unknown): string =>
  decodeName(
    String(raw ?? '')
      // 上游把 & 双重转义成 \\u0026（字符串里就是「反斜杠反斜杠 u0026」），
      // 所以反斜杠要允许出现多个，否则会吃掉一层后留下「\&」
      .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      // 兜底：双重转义被剥一层后残留的「\&」「\"」这类反斜杠
      .replace(/\\([&,'"、])/g, '$1'),
  ).replace(/\s+/g, ' ').trim()

const SINGLE_RE = /('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g

/** 酷我 r.s 接口返回"单引号 JSON"，转标准 JSON 后 parse */
export const kwParseJSON = (text: string): any => {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('上游响应格式异常')
  const head = text.slice(0, start)
  if (head.includes('404')) throw new Error('酷我接口 404')
  return JSON.parse(text.slice(start).replace(SINGLE_RE, '"'))
}

const fetchText = async (url: string, headers: Record<string, string>, timeoutMs = 12_000): Promise<string> => {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
  })
  if (!resp.ok) throw new Error(`上游返回 HTTP ${resp.status}`)
  return resp.text()
}

export interface OnlineItem {
  source: string
  id: string          // 播放标识（酷我：MUSIC_xxx）
  name: string
  singer: string
  album: string
  intervalMs: number
  pic: string | null
}

export interface OnlineSearchResult {
  list: OnlineItem[]
  total: number
  page: number
  size: number
}

/** 专辑 / 歌单等集合（非单曲搜索结果） */
export interface OnlineCollection {
  source: string
  id: string
  name: string
  creator: string
  trackCount: number
  pic: string | null
}

export interface OnlineCollectionResult {
  list: OnlineCollection[]
  total: number
  page: number
  size: number
}

export interface OnlineCollectionDetail {
  info: OnlineCollection
  list: OnlineItem[]
}

export const kwSearch = async (keyword: string, page: number, size: number): Promise<OnlineSearchResult> => {
  const url =
    'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=music&itemset=web_2013&client=kt&pn=' + (page - 1) +
    '&rn=' + size + '&rformat=json&encoding=utf8&vipver=1'
  const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
  const j = kwParseJSON(text)
  const total = parseInt(j.TOTAL ?? '0', 10) || 0
  const abs: any[] = Array.isArray(j.abslist) ? j.abslist : []
  const list: OnlineItem[] = abs
    .filter((it) => it && (it.MUSICRID || it.MP3RID))
    .map((it) => {
      const rid = String(it.MUSICRID || it.MP3RID || '')
      const pic = String(it.web_albumpic_short || '')
      return {
        source: 'kw',
        id: rid,
        name: cleanText(it.NAME || it.SONGNAME || '未知歌曲'),
        singer: cleanText(it.ARTIST || it.AARTIST || '未知歌手').replace(/&/g, '、'),
        album: cleanText(it.ALBUM || ''),
        intervalMs: (parseInt(String(it.DURATION ?? '0'), 10) || 0) * 1000,
        // web_albumpic_short 形如 120/s4s34/98/932410455.jpg；
        // 旧域名 img1.kuwo.cn 已停用（404），改用 sycdn 图床并把尺寸从 120 提到 240
        pic: pic ? 'http://img3.sycdn.kuwo.cn/star/albumcover/' + pic.replace(/^120\//, '240/') : null,
      }
    })
  return { list, total, page, size }
}

/** 解析酷我播放直链（convert_url3 免鉴权试听） */
export const kwPlayUrl = async (rid: string): Promise<string> => {
  if (!/^MUSIC_[0-9A-Za-z]{1,40}$/.test(rid)) throw new Error('rid 非法')
  const url = 'https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=' + encodeURIComponent(rid) + '&format=mp3'
  const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('酷我未返回可播放地址（可能版权受限）')
  }
  const playUrl = typeof payload.url == 'string' ? payload.url : ''
  if (!/^https?:\/\/.+\.mp3/.test(playUrl) && !/^https?:\/\/.+/.test(playUrl)) throw new Error('酷我未返回可播放地址')
  return playUrl
}

/** 酷我专辑搜索（r.s ft=album） */
export const kwSearchAlbums = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const url =
    'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=album&itemset=web_2013&client=kt&pn=' + (page - 1) +
    '&rn=' + size + '&rformat=json&encoding=utf8&vipver=1'
  const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
  const j = kwParseJSON(text)
  const total = parseInt(j.TOTAL ?? '0', 10) || 0
  const arr: any[] = Array.isArray(j.albumlist) ? j.albumlist : []
  const list: OnlineCollection[] = arr
    .filter((it) => it && (it.albumid || it.id))
    .map((it) => ({
      source: 'kw',
      id: String(it.albumid || it.id),
      name: cleanText(it.name || it.ALBUM || '未知专辑'),
      creator: cleanText(it.artist || it.aartist || '').replace(/&/g, '、'),
      trackCount: parseInt(String(it.songnum ?? '0'), 10) || 0,
      pic: (() => {
        const p = String(it.img || it.hts_img || '')
        return p ? p.replace(/_?120/g, '') : null
      })(),
    }))
  return { list, total, page, size }
}

/** 酷我歌单搜索（r.s ft=playlist） */
export const kwSearchPlaylists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const url =
    'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=playlist&itemset=web_2013&client=kt&pn=' + (page - 1) +
    '&rn=' + size + '&rformat=json&encoding=utf8&vipver=1'
  const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
  const j = kwParseJSON(text)
  const total = parseInt(j.TOTAL ?? '0', 10) || 0
  const arr: any[] = Array.isArray(j.abslist) ? j.abslist : []
  const list: OnlineCollection[] = arr
    .filter((it) => it && it.playlistid)
    .map((it) => ({
      source: 'kw',
      id: String(it.playlistid),
      name: cleanText(it.name || '未知歌单'),
      creator: cleanText(it.nickname || ''),
      trackCount: parseInt(String(it.songnum ?? '0'), 10) || 0,
      pic: (() => {
        const p = String(it.pic || it.hts_pic || '')
        return p ? p.replace(/_?240/g, '') : null
      })(),
    }))
  return { list, total, page, size }
}

