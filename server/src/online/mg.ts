// ---------------------------------------------------------------------------
// 咪咕音乐平台适配器（内置在线源）
//   搜索：jadeite.migu.cn music_search/v3（app 通道，md5 签名头，免登录）
//   试听：app.c.nf.migu.cn listen-url → freetyst.nf.migu.cn 直链（匿名可听，
//         部分曲目 auditionsLength=60s 试听片段，与官方免费策略一致）
//   歌词：搜索结果 lrcUrl 直取 LRC 明文（trcUrl 翻译暂空）
//   封面：img3/img2/img1（webp 直链）
//   歌单：resourceinfo.do 取元信息 + resource/playlist/song/v2.0 翻页取曲目（均免签名）
//   签名算法源自 lx-music-desktop v2.12.2（Apache-2.0）mg/musicSearch.js createSignature；
//   仅公开内容试听，不做 VIP/无损解锁。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { OnlineItem, OnlineSearchResult, OnlineCollection, OnlineCollectionResult, OnlineCollectionDetail } from './kw'

const UA =
  'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'

const MG_DEVICE_ID = '963B7AA0D21511ED807EE5846EC87D20'
const MG_SIGN_SALT = '6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50'
const MG_CHANNEL = '0146921'

const toMD5 = (s: string): string => createHash('md5').update(s).digest('hex')

/** 照抄 desktop mg/musicSearch.js createSignature：sign = md5(keyword + salt + deviceId + time) */
const mgSign = (keyword: string): { time: string; sign: string } => {
  const time = Date.now().toString()
  return { time, sign: toMD5(`${keyword}${MG_SIGN_SALT}${MG_DEVICE_ID}${time}`) }
}

const fetchJson = async (url: string, headers: Record<string, string>, timeoutMs = 12_000): Promise<any> => {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'application/json, */*', ...headers },
  })
  if (!resp.ok) throw new Error(`咪咕接口 HTTP ${resp.status}`)
  return resp.json()
}

const SEARCH_SWITCH = encodeURIComponent('{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}')
/** 歌手/歌单搜索用的开关表（与 SEARCH_SWITCH 同一套字段，只改开哪一类） */
const mgSwitchOnly = (key: 'singer' | 'songlist'): string =>
  encodeURIComponent(JSON.stringify({
    song: 0, album: 0, singer: 0, tagSong: 0, mvSong: 0, bestShow: 0, songlist: 0, lyricSong: 0, [key]: 1,
  }))

/** 咪咕图床：img1/2/3 与歌单封面都是站内相对路径，统一补域名 */
const mgPic = (p: string): string | null => {
  if (!p) return null
  return /^https?:\/\//.test(p) ? p : 'https://d.musicapp.migu.cn' + p
}

/** songItem 的歌手串：singerList 是数组，多个歌手用「、」连接（与搜索的写法一致） */
const mgSingers = (it: any): string => {
  const arr: any[] = Array.isArray(it?.singerList) ? it.singerList : []
  return arr.map((s) => String(s?.name ?? '')).filter(Boolean).join('、')
}

/**
 * 咪咕 songItem → 在线曲目。
 * 搜索与歌单详情两个通道的曲目字段名一致（songId / songName / album / duration / img1..3），
 * 所以映射只写这一处；播放用的是 songId（见 mgPlayUrl 的数值校验）。
 */
const mgSong = (it: any): OnlineItem | null => {
  const sid = String(it?.songId ?? '').trim()
  if (!/^\d{1,16}$/.test(sid)) return null
  return {
    source: 'mg',
    id: sid,
    name: String(it?.songName || it?.name || '未知歌曲'),
    singer: mgSingers(it) || '未知歌手',
    album: String(it?.album || ''),
    intervalMs: (parseInt(String(it?.duration ?? '0'), 10) || 0) * 1000,
    pic: mgPic(String(it?.img3 || it?.img2 || it?.img1 || '')),
  }
}

export const mgSearch = async (keyword: string, page: number, size: number): Promise<OnlineSearchResult> => {
  const j = await mgSearchRaw(keyword, page, size, SEARCH_SWITCH)
  const rawGroups: any[] = Array.isArray(j.songResultData?.resultList) ? j.songResultData.resultList : []
  const seen = new Set<string>()
  const list: OnlineItem[] = []
  for (const group of rawGroups) {
    if (!Array.isArray(group)) continue
    for (const it of group) {
      // 搜索结果是分组返回的：按 copyrightId 去重（同一版权可能落在多组里）
      if (!it?.songId || !it?.copyrightId || seen.has(it.copyrightId)) continue
      seen.add(it.copyrightId)
      const song = mgSong(it)
      if (song) list.push(song)
    }
  }
  return { list, total: parseInt(String(j.songResultData?.totalCount ?? '0'), 10) || list.length, page, size }
}

// ------------------------------ 歌单 / 歌手搜索 ------------------------------
// 咪咕 searchAll 的 searchSwitch 是一张「要哪几类结果」的开关表；关掉 song/tagSong
// 只留 songlist（歌单）或 singer（歌手），响应里分别落在 songListResultData /
// singerResultData。分类字段名与 song 结果完全不同，所以单独映射。

const mgSearchRaw = async (keyword: string, page: number, size: number, sw: string): Promise<any> => {
  const { time, sign } = mgSign(keyword)
  const url =
    'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=' + sw +
    '&pageSize=' + Math.min(size, 50) +
    '&text=' + encodeURIComponent(keyword) +
    '&pageNo=' + page + '&sort=0&sid=USS'
  const j = await fetchJson(url, {
    uiVersion: 'A_music_3.6.1',
    deviceId: MG_DEVICE_ID,
    timestamp: time,
    sign,
    channel: MG_CHANNEL,
  })
  if (j?.code !== '000000') throw new Error('咪咕搜索失败：' + (j?.info ?? '未知错误'))
  return j
}

/** 咪咕歌单搜索（searchSwitch.songlist） */
export const mgSearchPlaylists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const j = await mgSearchRaw(keyword, page, size, mgSwitchOnly('songlist'))
  const arr: any[] = Array.isArray(j?.songListResultData?.result) ? j.songListResultData.result : []
  const list: OnlineCollection[] = arr
    .filter((it) => it?.id)
    .map((it) => ({
      source: 'mg',
      id: String(it.id),
      name: String(it.name || '未知歌单'),
      creator: String(it.userName || ''),
      trackCount: parseInt(String(it.musicNum ?? '0'), 10) || 0,
      pic: mgPic(String(it.musicListPicUrl || it.img || '')),
    }))
  return { list, total: parseInt(String(j?.songListResultData?.totalCount ?? '0'), 10) || list.length, page, size }
}

/** 咪咕歌手搜索（searchSwitch.singer）；头像取最大尺寸档（imgSizeType 03 > 02 > 01） */
export const mgSearchArtists = async (keyword: string, page: number, size: number): Promise<OnlineCollectionResult> => {
  const j = await mgSearchRaw(keyword, page, size, mgSwitchOnly('singer'))
  const arr: any[] = Array.isArray(j?.singerResultData?.result) ? j.singerResultData.result : []
  const list: OnlineCollection[] = arr
    .filter((it) => it?.id)
    .map((it) => {
      const pics: any[] = Array.isArray(it.singerPicUrl) ? it.singerPicUrl : []
      const best = pics.find((p) => p?.imgSizeType === '03') || pics.find((p) => p?.imgSizeType === '02') || pics[0]
      const pic = String(best?.img || '')
      return {
        source: 'mg',
        id: String(it.id),
        name: String(it.name || '未知歌手'),
        creator: '',
        trackCount: parseInt(String(it.songCount ?? '0'), 10) || 0,
        pic: /^https?:\/\//.test(pic) ? pic : null,
      }
    })
  return { list, total: parseInt(String(j?.singerResultData?.totalCount ?? '0'), 10) || list.length, page, size }
}

// ------------------------------ 歌单详情 ------------------------------
// 咪咕歌单的「元信息」和「曲目」在两个通道上，且都免登录、免签名
// （签名只用于 searchAll；这也是为什么之前误判为"拿不到"）：
//   元信息 → MIGUM2.0/v1.0/content/resourceinfo.do?needSimple=00&resourceType=2021&resourceId=…
//   曲目   → MIGUM3.0/resource/playlist/song/v2.0?playlistId=…&pageNo=…&pageSize=…
// 通道由开源项目 guohuiyuan/music-lib（migu/playlist.go）定位，这里是按本项目结构重写。

/** 每页拉多少首（上游实测 100 可用；调小只会变慢，调大有被截断的风险） */
const MG_PL_PAGE_SIZE = 100
/** 翻页上限：单页最坏 100 首，6 页 600 首，足够覆盖平台歌单的常见体量 */
const MG_PL_MAX_PAGES = 6

/**
 * 咪咕歌单详情（歌单广场里点进一张歌单走这条路）。
 * 元信息失败 = 歌单不存在/已下架，直接抛；曲目页失败只停翻页、保留已取到的部分，
 * 避免"第 3 页超时导致整张歌单打不开"。
 */
export const mgPlaylistDetail = async (id: string): Promise<OnlineCollectionDetail> => {
  if (!/^\d{1,16}$/.test(id)) throw new Error('咪咕歌单 id 非法')

  const j = await fetchJson(
    'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?needSimple=00&resourceType=2021&resourceId=' + encodeURIComponent(id),
    { Referer: 'https://music.migu.cn/' },
  )
  if (j?.code !== '000000') throw new Error('咪咕歌单不存在或已下架：' + String(j?.info ?? ''))
  const r = Array.isArray(j?.resource) ? j.resource[0] : null
  if (!r) throw new Error('咪咕歌单不存在或已下架')

  // 封面优先站内中图（_m.webp，约 20KB）；originalImgUrl 是无后缀原图（可用但 1.5MB 量级）
  const info: OnlineCollection = {
    source: 'mg',
    id: String(r.musicListId || id),
    name: String(r.title || '未知歌单'),
    creator: String(r.ownerName || ''),
    trackCount: parseInt(String(r.musicNum ?? '0'), 10) || 0,
    pic: mgPic(String(r.imgItem?.img || r.imgItem?.webpImg || r.originalImgUrl || '')),
  }

  const list: OnlineItem[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= MG_PL_MAX_PAGES; page++) {
    let d: any
    try {
      d = await fetchJson(
        `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${MG_PL_PAGE_SIZE}&playlistId=${encodeURIComponent(id)}`,
        { Referer: 'https://music.migu.cn/' },
      )
    } catch (e) {
      if (page === 1) throw e
      break
    }
    if (d?.code !== '000000') {
      if (page === 1) throw new Error('咪咕歌单曲目获取失败：' + String(d?.info ?? '未知错误'))
      break
    }
    const arr: any[] = Array.isArray(d?.data?.songList) ? d.data.songList : []
    if (!arr.length) break
    for (const it of arr) {
      const song = mgSong(it)
      if (!song || seen.has(song.id)) continue
      seen.add(song.id)
      list.push(song)
    }
    const total = parseInt(String(d?.data?.totalCount ?? '0'), 10) || 0
    if (arr.length < MG_PL_PAGE_SIZE || (total && list.length >= total)) break
  }

  if (!info.trackCount) info.trackCount = list.length
  return { info, list }
}

/** 解析咪咕试听直链（listen-url 通道，songId 匿名可查） */
export const mgPlayUrl = async (id: string): Promise<string> => {
  if (!/^\d{1,16}$/.test(id)) throw new Error('咪咕 songId 非法')
  const j = await fetchJson(
    'https://app.c.nf.migu.cn/MIGUM2.0/v2.0/content/listen-url?netType=00&resourceType=2&songId=' + encodeURIComponent(id) + '&toneFlag=PQ',
    { channel: MG_CHANNEL, Referer: 'https://app.c.nf.migu.cn/' },
  )
  if (j?.code !== '000000') throw new Error('咪咕未返回可播放地址（可能版权受限）')
  const playUrl = String(j.data?.url ?? '')
  if (!/^https?:\/\//.test(playUrl)) throw new Error('咪咕未返回可播放地址')
  return playUrl
}

/** 咪咕歌词：songItem.lrcUrl 明文 LRC；失败回空（调用方展示空态） */
export const mgLyric = async (id: string): Promise<{ lyric: string; tlyric: string }> => {
  if (!/^\d{1,16}$/.test(id)) return { lyric: '', tlyric: '' }
  try {
    const j = await fetchJson(
      'https://app.c.nf.migu.cn/MIGUM2.0/v2.0/content/listen-url?netType=00&resourceType=2&songId=' + encodeURIComponent(id) + '&toneFlag=PQ',
      { channel: MG_CHANNEL, Referer: 'https://app.c.nf.migu.cn/' },
    )
    if (j?.code !== '000000') return { lyric: '', tlyric: '' }
    const lrcUrl = String(j.data?.songItem?.lrcUrl ?? '')
    if (!/^https?:\/\//.test(lrcUrl)) return { lyric: '', tlyric: '' }
    const resp = await fetch(lrcUrl, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': UA, Referer: 'https://app.c.nf.migu.cn/' },
    })
    if (!resp.ok) return { lyric: '', tlyric: '' }
    const text = await resp.text()
    return { lyric: text.includes('[') ? text : '', tlyric: '' }
  } catch {
    return { lyric: '', tlyric: '' }
  }
}
