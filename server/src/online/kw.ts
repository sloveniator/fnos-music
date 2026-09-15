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

/** 酷我歌手搜索（r.s ft=artist）—— 复用集合结构承载歌手，trackCount 即该歌手歌曲数 */
export const kwSearchArtists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const url =
    'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=artist&itemset=web_2013&client=kt&pn=' + (page - 1) +
    '&rn=' + size + '&rformat=json&encoding=utf8&vipver=1'
  const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
  const j = kwParseJSON(text)
  // 头像相对路径形如 240/s4s56/58/291211030.jpg，需拼 BASEPICPATH（img1.kuwo.cn/star/starheads/）
  const base = String(j.BASEPICPATH || 'http://img1.kuwo.cn/star/starheads/')
  const arr: any[] = Array.isArray(j.abslist) ? j.abslist : []
  const list: OnlineCollection[] = arr
    .filter((it) => it && (it.ARTISTID || it.DC_TARGETID))
    .map((it) => {
      const p = String(it.PICPATH || '')
      return {
        source: 'kw',
        id: String(it.ARTISTID || it.DC_TARGETID),
        name: cleanText(it.ARTIST || '未知歌手'),
        creator: cleanText(it.AARTIST || it.COUNTRY || ''),
        trackCount: parseInt(String(it.SONGNUM ?? '0'), 10) || 0,
        pic: /^https?:/.test(p) ? p : (p ? base + p.replace(/^120\//, '240/') : null),
      }
    })
  return { list, total: parseInt(j.TOTAL ?? '0', 10) || 0, page, size }
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
        if (!p) return null
        // 上游给的是 _150/_240 缩略图，广场/搜索结果是大卡片，提到 _500 更清晰
        // （去掉后缀的 URL 只会 307 跳转，别自作聪明删尺寸）
        return /_\d+\.(jpg|jpeg|png|webp)$/i.test(p) ? p.replace(/_\d+(\.(?:jpg|jpeg|png|webp))$/i, '_500$1') : p
      })(),
    }))
  return { list, total, page, size }
}

// ---------------------------------------------------------------------------
// 酷我歌单曲目（歌单详情）
//   www.kuwo.cn/api/www 那套接口需要网页下发的 kw_token（实测 cookie + csrf 头组合
//   仍被拒 "The request is illegal!"），改用 nplserver pl.svc 免鉴权通道：
//   op=getlistinfo&pid=<歌单 id>&pn=<页>&rn=<每页>，返回 title/pic/uname/total + musiclist。
//   musiclist 里只有数字 id（= 播放用的 MUSIC_<id>）与 120px 封面，这里统一归一成
//   内置源的 OnlineItem（封面提到 240px）。
// ---------------------------------------------------------------------------
const KW_PL_SVC = 'http://nplserver.kuwo.cn/pl.svc'
/** 单页条数 / 最多翻几页（300 首上限，够长歌单用，避免一次拉爆上游） */
const KW_PL_ROWS = 100
const KW_PL_MAX_PAGES = 3

export const kwPlaylistDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  if (!/^\d{1,16}$/.test(id)) throw new Error('酷我歌单 id 非法')
  const items: OnlineItem[] = []
  let info: OnlineCollection | null = null
  let total = 0
  for (let pn = 0; pn < KW_PL_MAX_PAGES; pn++) {
    const url =
      KW_PL_SVC + '?op=getlistinfo&pid=' + encodeURIComponent(id) + '&pn=' + pn + '&rn=' + KW_PL_ROWS +
      '&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.1.1.2&newver=1'
    const text = await fetchText(url, { Referer: 'http://www.kuwo.cn/' })
    let j: any
    try {
      j = JSON.parse(text)
    } catch {
      throw new Error('酷我歌单接口响应异常')
    }
    if (!j || j.result !== 'ok') throw new Error('酷我歌单不存在或已下架')
    total = parseInt(String(j.total ?? '0'), 10) || 0
    if (!info) {
      const cov = String(j.pic || '')
      info = {
        source: 'kw',
        id: String(j.id ?? id),
        name: cleanText(j.title || '未知歌单'),
        creator: cleanText(j.uname || ''),
        trackCount: total,
        pic: /_\d+\.(jpg|jpeg|png|webp)$/i.test(cov) ? cov.replace(/_\d+(\.(?:jpg|jpeg|png|webp))$/i, '_500$1') : (cov || null),
      }
    }
    const arr: any[] = Array.isArray(j.musiclist) ? j.musiclist : []
    for (const it of arr) {
      const rid = String(it?.id ?? '').trim()
      if (!/^\d{1,16}$/.test(rid)) continue
      const albumpic = String(it.albumpic || '')
      items.push({
        source: 'kw',
        id: 'MUSIC_' + rid,
        name: cleanText(it.name || '未知歌曲'),
        singer: cleanText(it.artist || '未知歌手').replace(/&/g, '、'),
        album: cleanText(it.album || ''),
        intervalMs: (parseInt(String(it.duration ?? '0'), 10) || 0) * 1000,
        pic: albumpic ? albumpic.replace(/\/120\//, '/240/') : null,
      })
    }
    if (!arr.length || items.length >= total) break
  }
  if (!info) throw new Error('酷我歌单不存在或已下架')
  return { info: { ...info, trackCount: total || items.length }, list: items }
}

