// 下载落盘后的标签内嵌：封面（APIC）+ 歌词（USLT / SYLT）
//
// 为什么单独成模块：写标签有两条入口，必须共用同一套实现，否则迟早不一致——
//   1. 云盘落盘（downloads/queue.ts）：下载完成后就地写标签；
//   2. 浏览器直下（web/api.ts 的 /web/media/online/*?dl=1）：先落到临时文件写好标签，
//      再整文件回传给浏览器，这样「下载到本机」拿到的文件同样是带封面和歌词的。
//
// 容器支持：node-id3 只写 ID3v2（mp3）。m4a（汽水免登录档位）/flac 等本环境没有可用的
// 标签写入器（无 ffmpeg，无 mutagen），一律安静跳过——返回结果里如实标注，不抛错。
import fs from 'node:fs'
import ID3 from 'node-id3'
import { onlineLyric, onlineSearch } from '@/online'
import { kgLyricByText, txLyricByText } from '@/online/lyric-fallback'
import { coverScore, MIN_COVER_SCORE } from '@/utils/match'

export interface TagMeta {
  name?: string
  singer?: string
  album?: string
  /** 毫秒；仅用于跨源歌词兜底时对齐时长 */
  duration?: number
  source?: string
  rid?: string
}

export interface CoverImage { mime: string, data: Buffer }

export interface TagWriteResult {
  /** 是否写入容器（当前 = 是否 mp3） */
  supported: boolean
  cover: boolean
  lyric: boolean
  error: string | null
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 拉取在线封面图（限 3MB），失败返回 null 不影响下载结果 */
export const fetchCoverImage = async (url?: string | null): Promise<CoverImage | null> => {
  try {
    if (!/^https?:\/\//.test(String(url ?? ''))) return null
    // 网易云原图常 500KB+，会让 ID3 标签臃肿；图床支持 param 参数取缩略图
    const target = /music\.126\.net\//.test(String(url)) && !String(url).includes('?') ? String(url) + '?param=500y500' : String(url)
    const r = await fetch(target, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': UA },
    })
    if (!r.ok) return null
    const ct = String(r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ab = await r.arrayBuffer()
    if (!ab.byteLength || ab.byteLength > 3 * 1024 * 1024) return null
    const mime = /^image\/(jpeg|jpg|png|webp)$/.test(ct) ? (ct === 'image/jpg' ? 'image/jpeg' : ct) : 'image/jpeg'
    return { mime, data: Buffer.from(ab) }
  } catch { return null }
}

/** LRC 逐行解析成 SYLT 条目（毫秒）；无时间标签的行（作词/作曲等元信息）丢弃 */
export const parseLrc = (lrc: string): { text: string, timeStamp: number }[] => {
  const out: { text: string, timeStamp: number }[] = []
  for (const raw of String(lrc ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // 一行可有多个时间标签：[00:12.34][01:02.5]歌词
    const stamps = Array.from(line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g))
    if (!stamps.length) continue
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const m of stamps) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0
      out.push({ text, timeStamp: min * 60_000 + sec * 1000 + frac })
    }
  }
  return out.sort((a, b) => a.timeStamp - b.timeStamp)
}

const hasCJK = (s: string): boolean => /[\u3400-\u9fff\uf900-\ufaff]/.test(s)

/**
 * 取歌词（LRC 明文）：
 *   1. 源内歌词（kw/wy/mg/汽水各自接口）
 *   2. 跨源兜底：酷狗按「歌名+歌手」→ QQ 音乐
 * 任何一步失败都降级到下一步；全失败返回 ''（不写歌词帧，不影响下载）。
 */
export const fetchLyricFor = async (meta: TagMeta): Promise<string> => {
  const name = String(meta.name ?? '').trim()
  const singer = String(meta.singer ?? '').trim()
  if (meta.source && meta.rid) {
    try {
      const r = await onlineLyric(meta.source, meta.rid)
      if (r?.lyric && r.lyric.includes('[')) return r.lyric
    } catch { /* 落到兜底 */ }
  }
  if (name) {
    try {
      const kg = await kgLyricByText(name, singer, Number(meta.duration) || 0)
      if (kg && kg.includes('[')) return kg
    } catch { /* 下一个源 */ }
    try {
      const tx = await txLyricByText(name, singer)
      if (tx && tx.includes('[')) return tx
    } catch { /* 放弃 */ }
  }
  return ''
}

/**
 * 写 ID3v2 标签：标题/歌手/专辑 + 内嵌封面 + 内嵌歌词（USLT 全文 + SYLT 逐行时间）。
 * 同步函数，失败只回传 error 字符串，不抛错给下载流程。
 */
export const writeAudioTags = (filePath: string, meta: TagMeta, cover: CoverImage | null, lyric: string): TagWriteResult => {
  const r: TagWriteResult = { supported: false, cover: false, lyric: false, error: null }
  if (!filePath.toLowerCase().endsWith('.mp3')) return r
  r.supported = true
  try {
    const tags: Record<string, unknown> = {}
    if (meta.name) tags.title = meta.name
    if (meta.singer) tags.artist = meta.singer
    if (meta.album) tags.album = meta.album
    if (Number(meta.duration) > 0) tags.TCON = 'Music'
    if (cover) {
      tags.image = {
        mime: cover.mime,
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: cover.data,
      }
    }
    const text = String(lyric ?? '').trim()
    if (text.includes('[')) {
      const language = hasCJK(text) ? 'chi' : 'eng'
      // USLT：全文，兼容面最广（Navidrome / foobar / 各类手机播放器都读得到）
      tags.unsynchronisedLyrics = { language, shortText: '', text }
      // SYLT：逐行时间轴，支持滚动歌词的播放器用得上；写了不亏
      const sync = parseLrc(text)
      if (sync.length) {
        tags.synchronisedLyrics = [{
          language, timeStampFormat: 2, contentType: 1, shortText: '', synchronisedText: sync,
        }]
      }
    }
    if (!Object.keys(tags).length) return r
    const w = ID3.write(tags, filePath) as true | Error
    if (w !== true) {
      r.error = w?.message || String(w)
      return r
    }
    r.cover = !!cover
    r.lyric = !!tags.unsynchronisedLyrics
    return r
  } catch (e: any) {
    r.error = e?.message || String(e)
    return r
  }
}

/**
 * 无封面直链时按「歌手 + 曲名」跨源找图（与曲库封面回填同一套打分与阈值）。
 * 上游搜索结果里常有条目不带封面（酷我的 live/串烧版本尤其常见），
 * 但歌本身在别的源大概率有图——不兜这一下，用户就会拿到一张白图都没有的文件。
 */
const searchCoverByText = async (meta: TagMeta): Promise<CoverImage | null> => {
  const keyword = [meta.singer, meta.name].filter(Boolean).join(' ').substring(0, 80).trim()
  if (!keyword) return null
  const target = { name: String(meta.name ?? ''), singer: String(meta.singer ?? ''), album: String(meta.album ?? '') }
  for (const src of ['wy', 'kw']) {
    try {
      const res = await onlineSearch(src, keyword, 1, 12)
      let best: { pic?: string | null } | null = null
      let bestScore = 0
      for (const it of res?.list ?? []) {
        if (!it || !it.pic) continue
        const sc = coverScore(target, { name: it.name, singer: it.singer, album: it.album })
        if (sc > bestScore) { bestScore = sc; best = it }
      }
      if (best?.pic && bestScore >= MIN_COVER_SCORE) {
        const img = await fetchCoverImage(best.pic)
        if (img) return img
      }
    } catch { /* 单源失败继续下一个源 */ }
  }
  return null
}

/** 封面图：优先用调用方给的直链，拿不到再按文本兜底找 */
export const resolveCover = async (meta: TagMeta, picUrl?: string | null): Promise<CoverImage | null> => {
  if (picUrl) {
    const direct = await fetchCoverImage(picUrl)
    if (direct) return direct
  }
  return searchCoverByText(meta)
}

/** 目录不存在则创建（临时文件、下载目录共用） */
export const ensureDirSync = (dir: string): void => {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}

const MAX_FETCH_BYTES = 200 * 1024 * 1024

/**
 * 取上游直链整包落盘（跟随 3xx —— 酷我等「直链」其实是跳转链接）。
 * 下载直下路径用：必须先把文件拿到本地才能写标签，写不了标签就没法满足
 * 「下载的歌曲带封面和歌词」。失败抛错，由调用方清理半成品。
 */
export const saveUrlToFile = async (url: string, headers: Record<string, string>, dest: string): Promise<number> => {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('上游超时')), 120_000)
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
    })
    if (!r.ok) throw new Error('上游返回 ' + r.status)
    if (!r.body) throw new Error('上游返回空 body')
    const len = Number(r.headers.get('content-length'))
    if (Number.isFinite(len) && len > MAX_FETCH_BYTES) throw new Error('文件超过 200MB 上限')
    const out = fs.createWriteStream(dest)
    const reader = (r.body as any).getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.length
        if (received > MAX_FETCH_BYTES) throw new Error('文件超过 200MB 上限')
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        }
      }
      await new Promise<void>((resolve, reject) => out.end(() => resolve()))
    } catch (e) {
      try { out.destroy() } catch {}
      throw e
    }
    if (received <= 0) throw new Error('下载内容为空')
    return received
  } catch (e) {
    try { fs.unlinkSync(dest) } catch {}
    throw e
  } finally {
    clearTimeout(timer)
  }
}
