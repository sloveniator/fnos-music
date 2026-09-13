import fs from 'node:fs/promises'
import path from 'node:path'
import { LRUCache } from 'lru-cache'

// ---------------------------------------------------------------------------
// 曲库元数据解析（纯 JS，零依赖）
// 优先级（用户要求「优先参考文件夹相关名称」）：
//   1. 目录结构：  <根>/<艺人>/<专辑>/[Disc N/]NN - 标题.ext
//   2. 文件名：    "艺人 - 标题.ext"
//   3. 内嵌标签仅补全前两级取不到的字段：ID3v2.3/2.4 / FLAC VorbisComment / MP4 ilst
// ---------------------------------------------------------------------------

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.ape'])
export const isAudioFile = (name: string): boolean => AUDIO_EXT.has(path.extname(name).toLowerCase())

const RX_JUNK_TAIL = /\s*[\(（【\[]\s*(official|mv|video|audio|lyric|歌词|完整版|无损|音质|hq|live|现场|伴奏|instrumental|acoustic|remaster)[^\)）】\]]*[\)）】\]]*\s*$/i

const cleanTitle = (s: string): string => {
  let out = s.replace(/_/g, ' ')
  for (let i = 0; i < 3; i++) {
    const trimmed = out.replace(RX_JUNK_TAIL, '')
    if (trimmed === out) break
    out = trimmed
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** 解析文件名："01 - 艺人 - 标题" | "艺人 - 标题" | "标题"（先剥音轨号，再按 ' - ' 切分） */
export const parseFileName = (fileName: string): { artist: string | null, title: string, track: number | null } => {
  const base = fileName.replace(/\.[^.]+$/, '')
  const { track, rest } = stripTrackNo(base)
  const m = /^(.{1,80}?)\s+[-－–—]\s+(.{1,200})$/.exec(rest)
  if (m) {
    const artist = m[1].trim()
    return { artist: artist && !/^\d+$/.test(artist) ? artist : null, title: cleanTitle(m[2]), track }
  }
  return { artist: null, title: cleanTitle(rest), track }
}

/** 剥离音轨号前缀："01 - xx" / "01. xx" / "01_xx" */
export const stripTrackNo = (s: string): { track: number | null, rest: string } => {
  const m = /^\s*(\d{1,3})\s*[.\-_]\s*(.+)$/.exec(s)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n > 0 && n < 1000) return { track: n, rest: m[2].trim() }
  }
  return { track: null, rest: s.trim() }
}

// 根目录常见「音乐容器」名（不带/带方括号/中英/首字母）：应跳过，不当歌手或专辑
// 兼容用户实际目录命名，如「【Music】」「【演唱会】」「Music」「歌曲」「专辑库」等
const GENERIC_DIRS = /^(?:【|】|\[|\]|\(|\)|·|•|「|」)*\s*(?:music|歌曲|音乐|音乐库|歌|flac|mp3|mp4|ape|wav|aac|ogg|opus|无损|有损|专辑|专辑库|album|albums|downloads?|media|库|曲库|云盘|共享|share|演唱会|concert|live|mv|mvs|movies?|影片|视频|下载|下载文件夹|下载目录)\s*(?:【|】|\[|\]|\(|\)|·|•|「|」)*$/i
const DISC_DIR = /^(disc|cd|碟|盘)\s*\d+$/i

/** 判断是否是「通用容器」目录名（应跳过） */
const isGenericDirName = (s: string): boolean => {
  const t = s.trim()
  return !t || GENERIC_DIRS.test(t) || DISC_DIR.test(t) || t.length > 60
}

/**
 * 解析目录层级：<根>/[容器/]*<艺人>/<专辑>/[Disc N]/
 * 从后往前剥：Disc 目录 + 通用容器（如【Music】/【演唱会】/Music/歌曲）。
 * 剩余最后两层作 album/artist；只剩一层时 artist=album=该层。
 * 文件名里的「艺人 - 标题」在 parsePathMeta 里作为 fallback。
 */
export const parseDirParts = (parts: string[]): { artist: string | null, album: string | null } => {
  const clean = (s: string): string => s.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const ps = [...parts]
  while (ps.length && isGenericDirName(ps[ps.length - 1])) ps.pop()
  let artist: string | null = null
  let album: string | null = null
  if (ps.length >= 2) {
    artist = clean(ps[ps.length - 2])
    album = clean(ps[ps.length - 1])
  } else if (ps.length == 1) {
    artist = clean(ps[0])
    album = artist
  }
  if (artist && isGenericDirName(artist)) artist = null
  if (album && isGenericDirName(album)) album = null
  return { artist, album }
}

export interface PathMeta { title: string, artist: string | null, album: string | null, track: number | null }

export const parsePathMeta = (relPath: string): PathMeta => {
  const parts = relPath.split(/[\\/]/)
  const fileName = parts.pop() as string
  const { artist: fnArtist, title, track } = parseFileName(fileName)
  const { artist: dirArtist, album } = parseDirParts(parts)
  return {
    title,
    artist: dirArtist ?? fnArtist,
    album,
    track,
  }
}

// ---------------------------------------------------------------------------
// 内嵌标签
// ---------------------------------------------------------------------------

interface RawTags {
  title?: string
  artist?: string
  album?: string
  track?: number
  year?: string
  durationSec?: number | null
  picture?: { mime: string, data: Buffer }
  lyric?: string
}

const swapUtf16 = (b: Buffer): string => {
  const out = Buffer.allocUnsafe(b.length & ~1)
  for (let i = 0; i + 1 < b.length; i += 2) {
    out[i] = b[i + 1]
    out[i + 1] = b[i]
  }
  return out.toString('utf16le')
}

const decodeText = (enc: number, buf: Buffer): string => {
  let b = buf
  while (b.length && b[b.length - 1] == 0) b = b.subarray(0, b.length - 1)
  let s = ''
  switch (enc) {
    case 0: s = b.toString('latin1'); break
    case 1:
      if (b.length >= 2 && b[0] == 0xFF && b[1] == 0xFE) s = b.subarray(2).toString('utf16le')
      else if (b.length >= 2 && b[0] == 0xFE && b[1] == 0xFF) s = swapUtf16(b.subarray(2))
      else s = b.toString('utf16le')
      break
    case 2: s = swapUtf16(b); break
    case 3: s = b.toString('utf8'); break
    default: return ''
  }
  // 多值文本帧取第一个值
  const nul = s.indexOf('\0')
  if (nul >= 0) s = s.substring(0, nul)
  return s.trim()
}

const syncSafe = (buf: Buffer, offset: number): number =>
  (buf[offset] << 21) | (buf[offset + 1] << 14) | (buf[offset + 2] << 7) | buf[offset + 3]

const parseYear = (s: string): string | undefined => {
  const m = /(19|20)\d{2}/.exec(s)
  return m ? m[0] : undefined
}

const parseTrackNo = (s: string): number | undefined => {
  const m = /^(\d{1,4})\s*\//.exec(s) ?? /^(\d{1,4})$/.exec(s)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  return n > 0 && n < 10000 ? n : undefined
}

// --------------------------- ID3v2 (mp3 / wav) -----------------------------

const id3TextFrame = (id: string, body: Buffer, tags: RawTags): void => {
  if (body.length < 2) return
  const text = decodeText(body[0], body.subarray(1))
  if (!text) return
  switch (id) {
    case 'TIT2': if (!tags.title) tags.title = text; break
    case 'TPE1': if (!tags.artist) tags.artist = text; break
    case 'TPE2': if (!tags.artist) tags.artist = text; break
    case 'TALB': if (!tags.album) tags.album = text; break
    case 'TRCK': if (tags.track == null) tags.track = parseTrackNo(text); break
    case 'TDRC':
    case 'TYER': if (!tags.year) tags.year = parseYear(text); break
  }
}

const parseApic = (body: Buffer, tags: RawTags): void => {
  if (body.length < 5) return
  const enc = body[0]
  let pos = 1
  const mimeEnd = body.indexOf(0, pos)
  if (mimeEnd < 0) return
  const mime = body.toString('latin1', pos, mimeEnd) || 'image/jpeg'
  pos = mimeEnd + 1 + 1 // skip mime + picture type
  if (enc == 1 || enc == 2) {
    while (pos + 1 < body.length && !(body[pos] == 0 && body[pos + 1] == 0)) pos += 2
    pos += 2
  } else {
    const dEnd = body.indexOf(0, pos)
    if (dEnd < 0) return
    pos = dEnd + 1
  }
  if (mime.startsWith('image/') && !tags.picture && body.length - pos > 1024) {
    tags.picture = { mime, data: body.subarray(pos) }
  }
}

const parseUslt = (body: Buffer, tags: RawTags): void => {
  if (body.length < 6) return
  const enc = body[0]
  // lang 3 bytes + description
  let pos = 4
  if (enc == 1 || enc == 2) {
    while (pos + 1 < body.length && !(body[pos] == 0 && body[pos + 1] == 0)) pos += 2
    pos += 2
  } else {
    const dEnd = body.indexOf(0, pos)
    if (dEnd < 0) return
    pos = dEnd + 1
  }
  if (!tags.lyric) {
    const text = decodeText(enc, body.subarray(pos))
    if (text.length > 8 && text.includes('[')) tags.lyric = text
  }
}

/** 返回 { tags, id3Size }（id3Size 含 10 字节头，用于 mp3 时长计算） */
export const parseId3v2 = (buf: Buffer): { tags: RawTags, id3Size: number } => {
  const tags: RawTags = {}
  if (buf.length < 10 || buf.toString('latin1', 0, 3) != 'ID3') return { tags, id3Size: 0 }
  const major = buf[3]
  if (major < 3 || major > 4) return { tags, id3Size: 0 }
  const flags = buf[5]
  const tagSize = syncSafe(buf, 6)
  const total = 10 + tagSize
  let pos = 10
  if (flags & 0x40) { // extended header
    const extSize = major == 4 ? syncSafe(buf, pos) : buf.readUInt32BE(pos)
    pos += extSize + (major == 4 ? 0 : 4)
  }
  const end = Math.min(buf.length, total)
  while (pos + 10 <= end) {
    const id = buf.toString('latin1', pos, pos + 4)
    if (!/^[A-Z][A-Z0-9]{3}$/.test(id)) break
    const size = major == 4 ? syncSafe(buf, pos + 4) : buf.readUInt32BE(pos + 4)
    if (size <= 0 || pos + 10 > end) break
    if (pos + 10 + size > end) {
      // 内嵌封面常达数百 KB，超过头部读取窗口。仍按已读部分解析，
      // 保证 hasCover 检测不受窗口大小影响（完整提取见 readCover）
      if (id == 'APIC') parseApic(buf.subarray(pos + 10, end), tags)
      break
    }
    const body = buf.subarray(pos + 10, pos + 10 + size)
    switch (id[0]) {
      case 'T': id3TextFrame(id, body, tags); break
      case 'A': if (id == 'APIC') parseApic(body, tags); break
      case 'U': if (id == 'USLT') parseUslt(body, tags); break
    }
    pos += 10 + size
  }
  return { tags, id3Size: total }
}

// ------------------------------ FLAC ---------------------------------------

const parseVorbisComment = (body: Buffer, tags: RawTags): void => {
  let pos = 0
  const le = (o: number): number => body.readUInt32LE(o)
  if (pos + 4 > body.length) return
  const vendorLen = le(pos)
  pos += 4 + vendorLen
  if (pos + 4 > body.length) return
  const count = le(pos)
  pos += 4
  for (let i = 0; i < count && pos + 4 <= body.length; i++) {
    const len = le(pos)
    pos += 4
    if (pos + len > body.length) break
    const item = body.toString('utf8', pos, pos + len)
    pos += len
    const eq = item.indexOf('=')
    if (eq < 0) continue
    const key = item.substring(0, eq).toUpperCase()
    const val = item.substring(eq + 1).trim()
    if (!val) continue
    switch (key) {
      case 'TITLE': if (!tags.title) tags.title = val; break
      case 'ARTIST': if (!tags.artist) tags.artist = val; break
      case 'ALBUMARTIST': if (!tags.artist) tags.artist = val; break
      case 'ALBUM': if (!tags.album) tags.album = val; break
      case 'TRACKNUMBER': if (tags.track == null) tags.track = parseTrackNo(val); break
      case 'DATE': if (!tags.year) tags.year = parseYear(val); break
      case 'LYRICS': if (!tags.lyric) tags.lyric = val; break
    }
  }
}

const parseFlacPicture = (body: Buffer, tags: RawTags): void => {
  let pos = 0
  const be = (o: number, l: number): number => body.readUIntBE(o, l)
  if (body.length < 32) return
  pos += 4 // picture type
  const mimeLen = be(pos, 4); pos += 4
  if (pos + mimeLen > body.length) return
  const mime = body.toString('latin1', pos, pos + mimeLen); pos += mimeLen
  const descLen = be(pos, 4); pos += 4
  if (pos + descLen > body.length) return; pos += descLen
  pos += 16 // w h depth colors
  const dataLen = be(pos, 4); pos += 4
  if (pos + dataLen > body.length || dataLen < 1024) return
  if (!tags.picture && mime.startsWith('image/')) tags.picture = { mime, data: body.subarray(pos, pos + dataLen) }
}

export const parseFlac = (buf: Buffer): RawTags => {
  const tags: RawTags = {}
  if (buf.length < 4 || buf.toString('latin1', 0, 4) != 'fLaC') return tags
  let pos = 4
  while (pos + 4 <= buf.length) {
    const header = buf[pos]
    const last = (header & 0x80) != 0
    const type = header & 0x7f
    const size = buf.readUIntBE(pos + 1, 3)
    pos += 4
    if (pos + size > buf.length) break
    const body = buf.subarray(pos, pos + size)
    if (type == 0 && size >= 18) { // STREAMINFO
      const sampleRate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4)
      const totalSamples = ((body[13] & 0x0f) * 0x100000000) + (body[14] * 0x1000000) + (body[15] << 16) + (body[16] << 8) + body[17]
      if (sampleRate > 0 && totalSamples > 0) tags.durationSec = totalSamples / sampleRate
    } else if (type == 4) {
      parseVorbisComment(body, tags)
    } else if (type == 6) {
      parseFlacPicture(body, tags)
    }
    pos += size
    if (last) break
  }
  return tags
}

// ------------------------------ MP4 (m4a) ----------------------------------

const MP4_CONTAINERS = new Set(['moov', 'udta', 'ilst', 'trak', 'mdia', 'minf', 'stbl'])

const walkMp4Atoms = (buf: Buffer, start: number, end: number, depth: number, handler: (name: string, bodyStart: number, bodyEnd: number) => boolean | void): void => {
  if (depth > 6) return
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const name = buf.toString('latin1', pos + 4, pos + 8)
    let bodyStart = pos + 8
    if (size == 1) {
      if (pos + 16 > end) break
      size = Number(buf.readBigUInt64BE(pos + 8))
      bodyStart += 8
    } else if (size == 0) {
      size = end - pos
    }
    if (size < 8 || pos + size > end) break
    const stop = handler(name, bodyStart, pos + size) === true
    if (stop) return
    if (MP4_CONTAINERS.has(name) || (name == 'meta' && pos + 12 <= end)) {
      walkMp4Atoms(buf, name == 'meta' ? bodyStart + 4 : bodyStart, pos + size, depth + 1, handler)
    }
    pos += size
  }
}

const mp4DataValue = (buf: Buffer, bodyStart: number, bodyEnd: number): { type: number, data: Buffer } | null => {
  if (bodyEnd - bodyStart < 8) return null
  const type = buf.readUInt32BE(bodyStart) & 0xffffff
  return { type, data: buf.subarray(bodyStart + 8, bodyEnd) }
}

export const parseMp4 = (buf: Buffer): RawTags => {
  const tags: RawTags = {}
  if (buf.length < 12 || buf.toString('latin1', 4, 8) != 'ftyp') return tags
  const meta: Record<string, string> = {}
  let durationSec: number | null = null
  walkMp4Atoms(buf, 0, buf.length, 0, (name, bs, be) => {
    if (name == 'mvhd') {
      const version = buf[bs]
      if (version == 1 && be - bs >= 32) {
        const timescale = buf.readUInt32BE(bs + 20)
        const dur = Number(buf.readBigUInt64BE(bs + 24))
        if (timescale > 0) durationSec = dur / timescale
      } else if (version == 0 && be - bs >= 20) {
        const timescale = buf.readUInt32BE(bs + 12)
        const dur = buf.readUInt32BE(bs + 16)
        if (timescale > 0) durationSec = dur / timescale
      }
      return
    }
    if (name == 'ilst' || !/^(©nam|©ART|©alb|©day|trkn|covr|©lyr)$/.test(name)) return
    // 标签原子：内部是 data 原子
    walkMp4Atoms(buf, bs, be, 5, (inner, ibs, ibe) => {
      if (inner != 'data') return
      const v = mp4DataValue(buf, ibs, ibe)
      if (!v) return
      const text = () => v.data.toString('utf8').trim()
      switch (name) {
        case '©nam': if (!meta.title) meta.title = text(); break
        case '©ART': if (!meta.artist) meta.artist = text(); break
        case '©alb': if (!meta.album) meta.album = text(); break
        case '©day': if (!meta.year) meta.year = parseYear(text()) ?? ''; break
        case '©lyr': if (!meta.lyric) meta.lyric = text(); break
        case 'trkn': if (v.data.length >= 4) { const n = v.data.readUInt16BE(2); if (n > 0) meta.track = String(n) } break
        case 'covr':
          if (!tags.picture && v.data.length > 1024) {
            tags.picture = { mime: v.type == 14 ? 'image/png' : 'image/jpeg', data: v.data }
          }
          break
      }
    })
  })
  if (meta.title) tags.title = meta.title
  if (meta.artist) tags.artist = meta.artist
  if (meta.album) tags.album = meta.album
  if (meta.year) tags.year = meta.year
  if (meta.track) tags.track = parseTrackNo(meta.track)
  if (meta.lyric) tags.lyric = meta.lyric
  if (durationSec) tags.durationSec = durationSec
  return tags
}

// ------------------------------ APE (Monkey's Audio) ------------------------

/** APE v3980+：APE_DESCRIPTOR(26B) + APE_HEADER(24B)，时长 = ((totalFrames-1)*blocksPerFrame + finalFrameBlocks) / sampleRate */
export const parseApe = (head: Buffer): RawTags => {
  const tags: RawTags = {}
  if (head.length < 50 || head.toString('latin1', 0, 4) != 'MAC ') return tags
  const version = head.readUInt16LE(4)
  if (version < 3980) return tags // 旧版头部结构不同且罕见，跳过
  const descriptorBytes = head.readUInt32LE(8)
  const hPos = descriptorBytes
  if (hPos <= 0 || hPos + 26 > head.length) return tags
  const blocksPerFrame = head.readUInt32LE(hPos + 4)
  const finalFrameBlocks = head.readUInt32LE(hPos + 8)
  const totalFrames = head.readUInt32LE(hPos + 12)
  const sampleRate = head.readUInt32LE(hPos + 20)
  if (totalFrames > 0 && blocksPerFrame > 0 && sampleRate >= 8000 && sampleRate <= 192000) {
    const samples = (totalFrames - 1) * blocksPerFrame + finalFrameBlocks
    if (samples > 0) tags.durationSec = samples / sampleRate
  }
  return tags
}

// ------------------------------ WMA (ASF) ------------------------------------

// ASF GUID 在文件中按混合端序存储：75B22630-668E-11CF-A6D9-00AA0062CE6C → 磁盘字节 30 26 B2 75 8E 66 CF 11 …
const ASF_HEADER_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])
const ASF_FILEPROP_GUID = Buffer.from([0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65])

/** ASF 头对象：File Properties Object 的 Play Duration(100ns) − Preroll 即可播时长 */
export const parseAsf = (head: Buffer): RawTags => {
  const tags: RawTags = {}
  if (head.length < 54 || !ASF_HEADER_GUID.equals(head.subarray(0, 16))) return tags
  const headerSize = Number(head.readBigUInt64LE(16))
  const end = Math.min(head.length, headerSize)
  let pos = 30 // 16 GUID + 8 size + 4 count + 2 reserved
  while (pos + 24 <= end) {
    const guid = head.subarray(pos, pos + 16)
    const size = Number(head.readBigUInt64LE(pos + 16))
    if (size < 24 || pos + size > end) break
    if (guid.equals(ASF_FILEPROP_GUID)) {
      const body = pos + 24
      if (size >= 24 + 60) {
        const playDur100ns = Number(head.readBigUInt64LE(body + 40))
        const prerollMs = head.readUInt32LE(body + 56)
        const sec = (playDur100ns - prerollMs * 10000) / 1e7
        if (sec > 0) tags.durationSec = sec
      }
      break
    }
    pos += size
  }
  return tags
}

// ------------------------------ MP3 时长 ------------------------------------

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]]

export const parseMp3Duration = (buf: Buffer, fileSize: number, id3Size: number): number | null => {
  const start = id3Size
  for (let i = start; i + 4 < Math.min(buf.length, start + 4096); i++) {
    if (buf[i] != 0xff || (buf[i + 1] & 0xe0) != 0xe0) continue
    const versionBits = (buf[i + 1] >> 3) & 3
    const layerBits = (buf[i + 1] >> 1) & 3
    if (versionBits == 1 || layerBits != 1) continue // 仅 MPEG Layer III
    const bitrateIdx = (buf[i + 2] >> 4) & 0xf
    const srIdx = (buf[i + 2] >> 2) & 3
    const channelMode = (buf[i + 3] >> 6) & 3
    if (bitrateIdx == 0 || bitrateIdx == 15 || srIdx == 3) continue
    const sampleRates = SAMPLE_RATES[versionBits]
    if (!sampleRates) continue
    const sampleRate = sampleRates[srIdx]
    const bitrate = (versionBits == 3 ? BITRATES_MPEG1_L3 : BITRATES_MPEG2_L3)[bitrateIdx] * 1000
    const samplesPerFrame = versionBits == 3 ? 1152 : 576
    let offset = i + 4 + (channelMode == 3 ? 17 : 32)
    if (offset + 12 <= buf.length) {
      const side = buf.toString('latin1', offset, offset + 4)
      if (side == 'Xing' || side == 'Info') {
        const flags = buf.readUInt32BE(offset + 4)
        if (flags & 1) {
          const frames = buf.readUInt32BE(offset + 8)
          if (frames > 0) return frames * samplesPerFrame / sampleRate
        }
      }
    }
    const audioBytes = fileSize - id3Size
    if (audioBytes > 0 && bitrate > 0) return audioBytes * 8 / bitrate
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export interface TrackMeta {
  name: string
  singer: string
  album: string
  trackNum: number | null
  year: string | null
  interval: string | null
  hasCover: boolean
}

export const formatInterval = (sec: number | null | undefined): string | null => {
  if (!sec || !isFinite(sec) || sec < 1 || sec > 60 * 60 * 6) return null
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const TAG_READ_SIZE = 512 * 1024

const parseTagsByExt = (ext: string, head: Buffer, fileSize: number): RawTags => {
  switch (ext) {
    case '.mp3':
    case '.wav': {
      const { tags, id3Size } = parseId3v2(head)
      if (ext == '.mp3') tags.durationSec = parseMp3Duration(head, fileSize, id3Size)
      return tags
    }
    case '.flac': return parseFlac(head)
    case '.m4a':
    case '.aac': return parseMp4(head)
    case '.ape': return parseApe(head)
    case '.wma': return parseAsf(head)
    default: return {}
  }
}

const openHead = async (filePath: string): Promise<{ fd: fs.FileHandle, head: Buffer, size: number }> => {
  const fd = await fs.open(filePath, 'r')
  try {
    const stat = await fd.stat()
    const len = Math.min(stat.size, TAG_READ_SIZE)
    const head = Buffer.allocUnsafe(len)
    if (len > 0) await fd.read(head, 0, len, 0)
    return { fd, head, size: stat.size }
  } catch (err) {
    await fd.close()
    throw err
  }
}

/** m4a 的 moov 可能在文件尾，头部没找到时补读尾部 */
const parseMp4WithTail = async (fd: fs.FileHandle, head: Buffer, size: number): Promise<RawTags> => {
  const tags = parseMp4(head)
  if (tags.title || tags.picture || size <= TAG_READ_SIZE) return tags
  try {
    const tailLen = Math.min(size, TAG_READ_SIZE)
    const tail = Buffer.allocUnsafe(tailLen)
    await fd.read(tail, 0, tailLen, size - tailLen)
    const tailTags = parseMp4(tail)
    for (const k of ['title', 'artist', 'album', 'year', 'lyric'] as const) {
      if (!tags[k] && tailTags[k]) (tags as any)[k] = tailTags[k]
    }
    if (tailTags.durationSec) tags.durationSec = tailTags.durationSec
    if (!tags.picture && tailTags.picture) tags.picture = tailTags.picture
  } catch {}
  return tags
}

export const readTrackMeta = async (filePath: string, relPath: string): Promise<TrackMeta> => {
  const pathMeta = parsePathMeta(relPath)
  const ext = path.extname(filePath).toLowerCase()
  let tags: RawTags = {}
  try {
    const { fd, head, size } = await openHead(filePath)
    try {
      tags = ext == '.m4a' || ext == '.aac' ? await parseMp4WithTail(fd, head, size) : parseTagsByExt(ext, head, size)
    } finally {
      await fd.close()
    }
  } catch {}
  return {
    name: pathMeta.title || tags.title || pathMeta.title,
    singer: pathMeta.artist ?? tags.artist ?? '',
    album: pathMeta.album ?? tags.album ?? '',
    trackNum: pathMeta.track ?? tags.track ?? null,
    year: tags.year ?? null,
    interval: formatInterval(tags.durationSec),
    hasCover: !!tags.picture,
  }
}

/** 按需提取内嵌封面（不缓存，扫描不写盘） */
const MAX_ID3_TAG_READ = 12 * 1024 * 1024

/** mp3/wav：按 ID3 标签头声明的大小完整读取（封面帧可能远超头部窗口） */
const readId3Cover = async (filePath: string): Promise<{ mime: string, data: Buffer } | null> => {
  const fd = await fs.open(filePath, 'r')
  try {
    const h = Buffer.allocUnsafe(10)
    const hr = await fd.read(h, 0, 10, 0)
    if (hr.bytesRead < 10 || h.toString('latin1', 0, 3) != 'ID3') return null
    const tagSize = syncSafe(h, 6) + 10
    if (tagSize <= 10 || tagSize > MAX_ID3_TAG_READ) return null
    const buf = Buffer.allocUnsafe(tagSize)
    const r = await fd.read(buf, 0, tagSize, 0)
    const parsed = parseId3v2(buf.subarray(0, r.bytesRead))
    return parsed.tags.picture ?? null
  } catch {
    return null
  } finally {
    await fd.close()
  }
}

const readCover = async (filePath: string): Promise<{ mime: string, data: Buffer } | null> => {
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext == '.mp3' || ext == '.wav') {
      const pic = await readId3Cover(filePath)
      if (pic) return pic
    }
    const { fd, head, size } = await openHead(filePath)
    try {
      const tags = ext == '.m4a' || ext == '.aac' ? await parseMp4WithTail(fd, head, size) : parseTagsByExt(ext, head, size)
      return tags.picture ?? null
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
}

/** 按需读取歌词（同名 .lrc 优先，其次内嵌） */
const readLyric = async (filePath: string): Promise<string | null> => {
  try {
    const lrcPath = filePath.replace(/\.[^.]+$/, '.lrc')
    if (await fs.stat(lrcPath).then(s => s.isFile()).catch(() => false)) {
      let text = await fs.readFile(lrcPath, 'utf8')
      if (text.length > 200 * 1024) text = text.substring(0, 200 * 1024)
      if (text.includes('[')) return text
    }
  } catch {}
  const ext = path.extname(filePath).toLowerCase()
  if (!['.mp3', '.flac', '.m4a', '.aac', '.wav'].includes(ext)) return null
  try {
    const { fd, head, size } = await openHead(filePath)
    try {
      const tags = ext == '.m4a' || ext == '.aac' ? await parseMp4WithTail(fd, head, size) : parseTagsByExt(ext, head, size)
      return tags.lyric ?? null
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 按需元数据缓存（封面 / 歌词）
//   列表页一屏几十行会触发几十次完整标签解析 + fd 打开（m4a 还要补读文件尾）；
//   键含 mtime+size，文件被替换后自动失效，扫描无需主动清缓存。
//   负结果用短 TTL，避免坏文件/无封面曲目反复解析。
// ---------------------------------------------------------------------------

const COVER_TTL = 60 * 60 * 1000
const LYRIC_TTL = 6 * 60 * 60 * 1000
const MISS_TTL = 2 * 60 * 1000

type CoverEntry = { mime: string, data: Buffer } | { miss: true }
type LyricEntry = { text: string } | { miss: true }

const COVER_CACHE = new LRUCache<string, CoverEntry>({
  max: 256,
  maxSize: 32 * 1024 * 1024,
  // lru-cache 要求 sizeCalculation 返回正整数；miss 哨兵占 1 字节
  sizeCalculation: (v) => ('miss' in v ? 1 : v.data.length),
})

const LYRIC_CACHE = new LRUCache<string, LyricEntry>({
  max: 512,
  maxSize: 16 * 1024 * 1024,
  sizeCalculation: (v) => ('miss' in v ? 1 : v.text.length),
})

const metaKey = (filePath: string, mtime: number, size: number) => filePath + ':' + mtime + ':' + size

export const extractCover = async (filePath: string): Promise<{ mime: string, data: Buffer } | null> => {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null
  const key = metaKey(filePath, Math.floor(stat.mtimeMs), stat.size)
  const hit = COVER_CACHE.peek(key)
  if (hit) return 'miss' in hit ? null : hit
  const pic = await readCover(filePath).catch(() => null)
  const entry: CoverEntry = pic ? pic : { miss: true }
  COVER_CACHE.set(key, entry, { ttl: pic ? COVER_TTL : MISS_TTL })
  return pic
}

export const extractLyric = async (filePath: string): Promise<string | null> => {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null
  const key = metaKey(filePath, Math.floor(stat.mtimeMs), stat.size)
  const hit = LYRIC_CACHE.peek(key)
  if (hit) return 'miss' in hit ? null : hit.text
  const lyric = await readLyric(filePath).catch(() => null)
  const entry: LyricEntry = lyric ? { text: lyric } : { miss: true }
  LYRIC_CACHE.set(key, entry, { ttl: lyric ? LYRIC_TTL : MISS_TTL })
  return lyric
}

