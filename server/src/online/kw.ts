// ---------------------------------------------------------------------------
// 酷我音乐平台适配器（内置在线源 · 方案 B）
//   搜索：search.kuwo.cn r.s 公开接口（免签名，响应为单引号 JSON）
//   试听：antiserver.kuwo.cn convert_url3 → mp3 直链（NAS 代理拉流）
//   封面：img1.kuwo.cn star/albumcover/{web_albumpic_short}
//   说明：仅用于 Web 播放器的在线搜索/试听；不做 VIP/无损解锁，纯公开内容。
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

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
        name: String(it.NAME || it.SONGNAME || '未知歌曲'),
        singer: String(it.ARTIST || it.AARTIST || '未知歌手').replace(/&nbsp;/g, ' ').replace(/&/g, '、'),
        album: String(it.ALBUM || '').replace(/&nbsp;/g, ' '),
        intervalMs: (parseInt(String(it.DURATION ?? '0'), 10) || 0) * 1000,
        pic: pic ? 'http://img1.kuwo.cn/star/albumcover/' + pic.replace(/^120\//, '300/') : null,
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
      name: String(it.name || it.ALBUM || '未知专辑').replace(/&nbsp;/g, ' '),
      creator: String(it.artist || it.aartist || '').replace(/&nbsp;/g, ' ').replace(/&/g, '、'),
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
      name: String(it.name || '未知歌单').replace(/&nbsp;/g, ' '),
      creator: String(it.nickname || '').replace(/&nbsp;/g, ' '),
      trackCount: parseInt(String(it.songnum ?? '0'), 10) || 0,
      pic: (() => {
        const p = String(it.pic || it.hts_pic || '')
        return p ? p.replace(/_?240/g, '') : null
      })(),
    }))
  return { list, total, page, size }
}

