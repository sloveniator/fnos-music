import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { runScan, scanState, type TrackInfo } from './scan'

export type { TrackInfo } from './scan'

// ---------------------------------------------------------------------------
// 曲库持久化 + 设置 + 流媒体 token
//   data/library.json          曲库索引（原子写）
//   data/library-settings.json 扫描目录 / 上游音源代理配置
//   data/library-secret.json   流媒体签名密钥（重置即让旧脚本失效）
// ---------------------------------------------------------------------------

interface LibraryFile { version: number, tracks: TrackInfo[], scannedAt: number }

/** 下载目标：local=直接写路径（含 fnOS 已挂载的 WebDAV/网盘）；webdav=服务端 PUT 到远端 WebDAV/AList */
export interface DownloadTarget {
  id: string
  name: string
  type: 'local' | 'webdav'
  path?: string // local：绝对目录
  url?: string // webdav：base URL
  username?: string
  password?: string
}

interface LibrarySettings { dirs: string[], proxyUrl: string, proxySources: string[], downloadTargets: DownloadTarget[], autoScanAfterDownload: boolean, onlineSources: string[] }

const libFile = () => path.join(global.lx.dataPath, 'library.json')
const settingsFile = () => path.join(global.lx.dataPath, 'library-settings.json')
const secretFile = () => path.join(global.lx.dataPath, 'library-secret.json')

const DEFAULT_SETTINGS: LibrarySettings = { dirs: [], proxyUrl: '', proxySources: [], downloadTargets: [], autoScanAfterDownload: true, onlineSources: ['kw', 'wy', 'mg'] }

let tracks: TrackInfo[] = []
let tracksById = new Map<string, TrackInfo>()
let scannedAt = 0
let settings: LibrarySettings = { ...DEFAULT_SETTINGS }
let secret = ''
let streamToken = ''

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

const writeJsonAtomic = (file: string, data: unknown): void => {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

/** library.json 可能很大（万首级别），用异步原子写避免阻塞事件循环；串行排队防乱序 */
let persistChain: Promise<void> = Promise.resolve()
const writeJsonAtomicAsync = (file: string, data: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    const tmp = file + '.tmp'
    fs.writeFile(tmp, JSON.stringify(data), err => {
      if (err) return reject(err)
      fs.rename(tmp, file, e2 => e2 ? reject(e2) : resolve())
    })
  })

const loadSecret = (): void => {
  let store = readJson<{ secret: string }>(secretFile())
  if (!store?.secret) {
    store = { secret: crypto.randomBytes(32).toString('hex') }
    try {
      fs.writeFileSync(secretFile(), JSON.stringify(store), { mode: 0o600 })
    } catch {
      secret = store.secret
      streamToken = crypto.createHmac('sha256', store.secret).update('gusi-stream-v1').digest('hex').substring(0, 32)
      return
    }
  }
  try {
    fs.chmodSync(secretFile(), 0o600)
  } catch {}
  secret = store.secret
  streamToken = crypto.createHmac('sha256', secret).update('gusi-stream-v1').digest('hex').substring(0, 32)
}

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

export const loadLibrary = (): void => {
  loadSecret()
  const stored = readJson<LibrarySettings>(settingsFile())
  if (stored) settings = { ...DEFAULT_SETTINGS, ...stored }
  const lib = readJson<LibraryFile>(libFile())
  if (lib?.tracks) {
    tracks = lib.tracks
    scannedAt = lib.scannedAt ?? 0
  }
  tracksById = new Map(tracks.map(t => [t.id, t]))
  buildNormIndex()
}

export const getSettings = (): LibrarySettings => settings

const sanitizeTargets = (input: unknown): DownloadTarget[] => {
  if (!Array.isArray(input)) return []
  const out: DownloadTarget[] = []
  for (const raw of input.slice(0, 32)) {
    if (!raw || typeof raw != 'object') continue
    const t = raw as Record<string, unknown>
    const type = t.type === 'webdav' ? 'webdav' : 'local'
    const name = String(t.name ?? '').trim().substring(0, 64)
    if (!name) continue
    const target: DownloadTarget = {
      id: typeof t.id == 'string' && /^[\w-]{1,32}$/.test(t.id) ? t.id : crypto.randomBytes(6).toString('hex'),
      name,
      type,
    }
    if (type == 'local') {
      const p = String(t.path ?? '').trim()
      if (!p) continue
      target.path = p
    } else {
      const u = String(t.url ?? '').trim()
      if (!/^https?:\/\//.test(u)) continue
      target.url = u.replace(/\/+$/, '')
      target.username = String(t.username ?? '')
      target.password = String(t.password ?? '')
    }
    out.push(target)
  }
  return out
}

export const saveSettings = (patch: Partial<LibrarySettings>): LibrarySettings => {
  settings = { ...settings, ...patch }
  if (!Array.isArray(settings.dirs)) settings.dirs = []
  settings.dirs = settings.dirs.map(d => String(d).trim()).filter(Boolean)
  if (patch.downloadTargets !== undefined) settings.downloadTargets = sanitizeTargets(patch.downloadTargets)
  else if (!Array.isArray(settings.downloadTargets)) settings.downloadTargets = []
  if (patch.autoScanAfterDownload !== undefined) settings.autoScanAfterDownload = !!patch.autoScanAfterDownload
  if (patch.onlineSources !== undefined) {
    settings.onlineSources = (Array.isArray(patch.onlineSources) ? patch.onlineSources : [])
      .map(s => String(s)).filter(s => ['kw', 'wy', 'mg', 'soda'].includes(s))
    if (!settings.onlineSources.length) settings.onlineSources = []
  } else if (!Array.isArray(settings.onlineSources)) settings.onlineSources = []
  writeJsonAtomic(settingsFile(), settings)
  try {
    fs.chmodSync(settingsFile(), 0o600) // 含 webdav 账号密码
  } catch {}
  return settings
}

export const getDownloadTarget = (id: string): DownloadTarget | undefined =>
  settings.downloadTargets.find(t => t.id == id)

export const getStreamToken = (): string => streamToken

export const verifyStreamToken = (k: string | null): boolean => {
  if (!k || typeof k != 'string') return false
  const a = Buffer.from(k)
  const b = Buffer.from(streamToken)
  return a.length == b.length && crypto.timingSafeEqual(a, b)
}

export const resetSecret = (): void => {
  fs.writeFileSync(secretFile(), JSON.stringify({ secret: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
  loadSecret()
}

export const getTracks = (): TrackInfo[] => tracks
export const getTrack = (id: string): TrackInfo | undefined => tracksById.get(id)
export const getScannedAt = (): number => scannedAt
export const getScanState = (): typeof scanState & { scannedAt: number, trackCount: number } => ({
  ...scanState,
  scannedAt,
  trackCount: tracks.length,
})

const persist = (): void => {
  const snapshot = { version: 1, tracks, scannedAt } as LibraryFile
  persistChain = persistChain
    .then(() => writeJsonAtomicAsync(libFile(), snapshot))
    .catch(err => console.error('[library] persist failed:', err?.message ?? err))
}

export const startScan = (): void => {
  if (scanState.scanning) return
  const dirs = [...settings.dirs]
  const old = tracksById
  void runScan(dirs, old).then(result => {
    tracks = result
    tracksById = new Map(tracks.map(t => [t.id, t]))
    scannedAt = Date.now()
    persist()
    buildNormIndex()
  }).catch(err => {
    scanState.error = err?.message ?? String(err)
    scanState.scanning = false
    scanState.finishedAt = Date.now()
  })
}

// ---------------------------------------------------------------------------
// 下载完成自动增量扫描：仅当落盘文件位于扫描目录内才触发；防抖合并批量下载
// ---------------------------------------------------------------------------

let autoScanTimer: ReturnType<typeof setTimeout> | null = null

export const scheduleAutoScan = (resultPath: string): void => {
  if (!settings.autoScanAfterDownload || !settings.dirs.length) return
  let abs: string
  try {
    abs = path.resolve(resultPath)
  } catch {
    return
  }
  const underScanDir = settings.dirs.some(d => {
    try {
      const root = path.resolve(d)
      return abs == root || abs.startsWith(root + path.sep)
    } catch {
      return false
    }
  })
  if (!underScanDir) return
  if (autoScanTimer) clearTimeout(autoScanTimer)
  autoScanTimer = setTimeout(() => {
    autoScanTimer = null
    if (!scanState.scanning) startScan()
  }, 4000)
}

// ---------------------------------------------------------------------------
// 检索（归一化索引预构建：扫描完成时一次性 lowercase+去空白，避免每次请求重复正则）
// ---------------------------------------------------------------------------

interface NormIndex { name: string, singer: string, album: string }

let normIndex = new Map<string, NormIndex>()

const buildNormIndex = (): void => {
  const idx = new Map<string, NormIndex>()
  for (const t of tracks) {
    idx.set(t.id, { name: norm(t.name), singer: norm(t.singer), album: norm(t.album) })
  }
  normIndex = idx
}

export interface TrackPage { total: number, page: number, size: number, tracks: Array<Omit<TrackInfo, 'filePath'>> }

const toPublic = (t: TrackInfo): Omit<TrackInfo, 'filePath'> => {
  const { filePath: _filePath, ...rest } = t
  return rest
}

const matchTrack = (n: NormIndex, nq: string): boolean =>
  n.name.includes(nq) || n.singer.includes(nq) || n.album.includes(nq)

export const listTracks = (opts: { q?: string, page?: number, size?: number }): TrackPage => {
  const size = Math.max(1, Math.min(200, opts.size ?? 50))
  const page = Math.max(1, opts.page ?? 1)
  let list = tracks
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(t => matchTrack(normIndex.get(t.id) ?? { name: '', singer: '', album: '' }, nq))
  }
  const total = list.length
  const start = (page - 1) * size
  return { total, page, size, tracks: list.slice(start, start + size).map(toPublic) }
}

/** 搜索 API（供脚本/管理端按关键词取曲库条目） */
export const searchTracks = (q: string, limit = 50): Array<Omit<TrackInfo, 'filePath'>> => {
  const nq = norm(q ?? '')
  if (!nq) return []
  const out: TrackInfo[] = []
  for (const t of tracks) {
    if (matchTrack(normIndex.get(t.id) ?? { name: '', singer: '', album: '' }, nq)) {
      out.push(t)
      if (out.length >= Math.max(1, Math.min(200, limit))) break
    }
  }
  return out.map(toPublic)
}

/** 聚合统计（专辑/艺人数量，供 UI 概览） */
export const libraryStats = (): { tracks: number, artists: number, albums: number, bytes: number, scannedAt: number } => {
  const artists = new Set<string>()
  const albums = new Set<string>()
  let bytes = 0
  for (const t of tracks) {
    if (t.singer) artists.add(t.singer)
    if (t.album) albums.add(`${t.singer}||${t.album}`)
    bytes += t.size
  }
  return { tracks: tracks.length, artists: artists.size, albums: albums.size, bytes, scannedAt }
}
