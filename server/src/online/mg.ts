// ---------------------------------------------------------------------------
// 咪咕音乐平台适配器（内置在线源）
//   搜索：jadeite.migu.cn music_search/v3（app 通道，md5 签名头，免登录）
//   试听：app.c.nf.migu.cn listen-url → freetyst.nf.migu.cn 直链（匿名可听，
//         部分曲目 auditionsLength=60s 试听片段，与官方免费策略一致）
//   歌词：搜索结果 lrcUrl 直取 LRC 明文（trcUrl 翻译暂空）
//   封面：img3/img2/img1（webp 直链）
//   签名算法源自 lx-music-desktop v2.12.2（Apache-2.0）mg/musicSearch.js createSignature；
//   仅公开内容试听，不做 VIP/无损解锁。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { OnlineItem, OnlineSearchResult } from './kw'

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

export const mgSearch = async (keyword: string, page: number, size: number): Promise<OnlineSearchResult> => {
  const { time, sign } = mgSign(keyword)
  const url =
    'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=' + SEARCH_SWITCH +
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
  const rawGroups: any[] = Array.isArray(j.songResultData?.resultList) ? j.songResultData.resultList : []
  const seen = new Set<string>()
  const list: OnlineItem[] = []
  for (const group of rawGroups) {
    if (!Array.isArray(group)) continue
    for (const it of group) {
      if (!it?.songId || !it?.copyrightId || seen.has(it.copyrightId)) continue
      seen.add(it.copyrightId)
      let pic = String(it.img3 || it.img2 || it.img1 || '')
      if (pic && !/^https?:/.test(pic)) pic = 'https://d.musicapp.migu.cn' + pic
      const singers = Array.isArray(it.singerList) ? it.singerList.map((s: any) => String(s?.name ?? '')).filter(Boolean).join('、') : ''
      list.push({
        source: 'mg',
        id: String(it.songId),
        name: String(it.songName || it.name || '未知歌曲'),
        singer: singers || '未知歌手',
        album: String(it.album || ''),
        intervalMs: (parseInt(String(it.duration ?? '0'), 10) || 0) * 1000,
        pic: pic || null,
      })
    }
  }
  return { list, total: parseInt(String(j.songResultData?.totalCount ?? '0'), 10) || list.length, page, size }
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
