import fs from 'node:fs'
import path from 'node:path'
import { runScanWithState, type ScanState, type TrackInfo } from './scan'
import { hasCachedCover, dropCoverCache } from './cover-cache'

// ---------------------------------------------------------------------------
// 租户（Web 用户）曲库：每个 Web 用户独立物理曲库
//   dataPath/libraries/<safeUser>/library.json          曲目索引
//   dataPath/libraries/<safeUser>/library-settings.json 扫描目录
//   内存：Map<safeUser, TenantState>；首次访问时懒加载
//   扫描：与全局 library 共用 runScan 实现，独立 ScanState
//   向后兼容：不改任何全局导出，admin UI 与 lx-music-mobile 协议继续用全局
// ---------------------------------------------------------------------------

export interface TenantSettings {
  /** 该用户扫描目录列表；空数组 = 尚未配置 */
  dirs: string[]
  /** 扫描完成后自动回填在线封面（默认关闭：自动爬取会给音源带来额外请求） */
  coverAuto?: boolean
}

export interface TenantState {
  safeUser: string
  tracks: TrackInfo[]
  tracksById: Map<string, TrackInfo>
  scannedAt: number
  settings: TenantSettings
  scanState: ScanState
  persistChain: Promise<void>
  /** 供 grouping.ts 复用（缓存键） */
  maxMtime: number
}

const DATA_KEY = 'gusi-tenant-library-v1'

interface LibraryFile { version: number, tracks: TrackInfo[], scannedAt: number }

const safeName = (u: string): string => {
  const s = (u || '').replace(/[^A-Za-z0-9_.-]/g, '_').substring(0, 64)
  return s || 'default'
}

const tenantDir = (safeUser: string): string => {
  const p = path.join(global.lx.dataPath, 'libraries', safeUser)
  try { fs.mkdirSync(p, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  return p
}

const libFile = (safeUser: string): string => path.join(tenantDir(safeUser), 'library.json')
const settingsFile = (safeUser: string): string => path.join(tenantDir(safeUser), 'library-settings.json')

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}
const writeJsonAtomic = (file: string, data: unknown): void => {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}
const writeJsonAtomicAsync = (file: string, data: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    const tmp = file + '.tmp'
    fs.writeFile(tmp, JSON.stringify(data), err => {
      if (err) return reject(err)
      fs.rename(tmp, file, e2 => e2 ? reject(e2) : resolve())
    })
  })

// 内存中的租户注册表
const tenants = new Map<string, TenantState>()

const DEFAULT_SETTINGS: TenantSettings = { dirs: [] }

const emptyScanState = (): ScanState => ({ scanning: false, total: 0, done: 0, startedAt: 0, finishedAt: 0, error: null })

type ScanDoneHook = (rawUser: string) => void
const scanDoneHooks: ScanDoneHook[] = []

/** 注册「扫描完成」回调（封面回填等模块使用，避免与 tenant 形成循环依赖） */
export const onTenantScanDone = (fn: ScanDoneHook): void => { scanDoneHooks.push(fn) }

/** 用户名的安全目录名（供 cover 缓存等模块定位同一租户目录） */
export const safeUserName = (u: string): string => safeName(u)

/** 把在线回填封面合并到曲目（内存标记，不写回 library.json） */
const applyCoverFlags = (t: TenantState): void => {
  for (const tr of t.tracks) {
    if (tr.hasCover) {
      if (tr.coverCache) tr.coverCache = undefined
      continue
    }
    tr.coverCache = hasCachedCover(t.safeUser, tr.id) ? true : undefined
  }
}

/** 重新合并回填封面标记（回填完成 / 清空缓存后调用） */
export const refreshCoverFlags = (rawUser: string): void => { applyCoverFlags(loadTenant(rawUser)) }

const loadTenant = (rawUser: string): TenantState => {
  const safeUser = safeName(rawUser)
  let t = tenants.get(safeUser)
  if (t) return t
  const storedSettings = readJson<TenantSettings>(settingsFile(safeUser))
  const storedLib = readJson<LibraryFile>(libFile(safeUser))
  t = {
    safeUser,
    tracks: storedLib?.tracks ?? [],
    tracksById: new Map((storedLib?.tracks ?? []).map(x => [x.id, x])),
    scannedAt: storedLib?.scannedAt ?? 0,
    settings: { ...DEFAULT_SETTINGS, ...(storedSettings ?? {}) },
    scanState: emptyScanState(),
    persistChain: Promise.resolve(),
    maxMtime: 0,
  }
  // 计算 maxMtime（供 grouping 缓存键）
  for (const tr of t.tracks) if (tr.mtime > t.maxMtime) t.maxMtime = tr.mtime
  tenants.set(safeUser, t)
  applyCoverFlags(t)
  return t
}

/** 释放内存中的租户（用户删除或手动清理时使用；扫描中拒绝释放） */
export const dropTenant = (rawUser: string): void => {
  const s = safeName(rawUser)
  const t = tenants.get(s)
  if (!t) return
  if (t.scanState.scanning) return
  tenants.delete(s)
  dropCoverCache(s)
}

export const listTenants = (): string[] => [...tenants.keys()]

export const getTenant = (rawUser: string): TenantState => loadTenant(rawUser)

/** 同步读设置（供 admin 侧 GET/PUT 使用） */
export const getTenantSettings = (rawUser: string): TenantSettings => ({ ...loadTenant(rawUser).settings })

/** 保存设置（原子写；保存后立即生效，不自动扫描） */
export const saveTenantSettings = (rawUser: string, patch: Partial<TenantSettings>): TenantSettings => {
  const t = loadTenant(rawUser)
  if (patch.coverAuto !== undefined) t.settings.coverAuto = !!patch.coverAuto
  if (patch.dirs !== undefined) {
    t.settings.dirs = (Array.isArray(patch.dirs) ? patch.dirs : [])
      .map(d => String(d).trim()).filter(Boolean).slice(0, 32)
  }
  writeJsonAtomic(settingsFile(t.safeUser), t.settings)
  return { ...t.settings }
}

/** 租户统计：tracks/artists/albums/bytes/scannedAt */
export const tenantLibraryStats = (rawUser: string): { tracks: number, artists: number, albums: number, bytes: number, scannedAt: number } => {
  const t = loadTenant(rawUser)
  const artists = new Set<string>()
  const albums = new Set<string>()
  let bytes = 0
  for (const tr of t.tracks) {
    if (tr.singer) artists.add(tr.singer)
    if (tr.album) albums.add(`${tr.singer}||${tr.album}`)
    bytes += tr.size
  }
  return { tracks: t.tracks.length, artists: artists.size, albums: albums.size, bytes, scannedAt: t.scannedAt }
}

export const getTenantTracks = (rawUser: string): TrackInfo[] => loadTenant(rawUser).tracks
export const getTenantTrack = (rawUser: string, id: string): TrackInfo | undefined => loadTenant(rawUser).tracksById.get(id)
export const getTenantScannedAt = (rawUser: string): number => loadTenant(rawUser).scannedAt

export interface TenantTrackPage { total: number, page: number, size: number, tracks: Array<Omit<TrackInfo, 'filePath'>> }

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '')

const toPublic = (t: TrackInfo): Omit<TrackInfo, 'filePath'> => {
  const { filePath: _filePath, ...rest } = t
  return rest
}

export const listTenantTracks = (rawUser: string, opts: { q?: string, page?: number, size?: number }): TenantTrackPage => {
  const t = loadTenant(rawUser)
  const size = Math.max(1, Math.min(200, opts.size ?? 50))
  const page = Math.max(1, Math.min(1e9, opts.page ?? 1))
  let list = t.tracks
  const q = (opts.q ?? '').trim()
  if (q) {
    const nq = norm(q)
    list = list.filter(tr => {
      const nameN = norm(tr.name)
      const singerN = norm(tr.singer)
      const albumN = norm(tr.album)
      return nameN.includes(nq) || singerN.includes(nq) || albumN.includes(nq)
    })
  }
  const total = list.length
  const start = (page - 1) * size
  return { total, page, size, tracks: list.slice(start, start + size).map(toPublic) }
}

export const searchTenantTracks = (rawUser: string, q: string, limit = 50): Array<Omit<TrackInfo, 'filePath'>> => {
  const t = loadTenant(rawUser)
  const nq = norm(q ?? '')
  if (!nq) return []
  const out: TrackInfo[] = []
  for (const tr of t.tracks) {
    if (norm(tr.name).includes(nq) || norm(tr.singer).includes(nq) || norm(tr.album).includes(nq)) {
      out.push(tr)
      if (out.length >= Math.max(1, Math.min(200, limit))) break
    }
  }
  return out.map(toPublic)
}

const persistTenant = (t: TenantState): void => {
  const snapshot = { version: 1, tracks: t.tracks, scannedAt: t.scannedAt } as LibraryFile
  t.persistChain = t.persistChain
    .then(() => writeJsonAtomicAsync(libFile(t.safeUser), snapshot))
    .catch(err => console.error(`[tenant-library:${t.safeUser}] persist failed:`, err?.message ?? err))
}

// ---------------------------------------------------------------------------
// 曲目删除：软删除（文件移入曲库根下的 .gusi-trash/，可人工恢复）
//   安全阀 1：只接受本用户索引里已存在的 id（前端无法传任意路径）
//   安全阀 2：文件必须落在该用户的某个扫描目录内，否则跳过
//   回收站目录以 . 开头 —— scan.ts 会跳过所有点目录，故不会被重新扫回索引
// ---------------------------------------------------------------------------

/** 回收站目录名（点开头 = 扫描器不进入） */
export const TENANT_TRASH_DIRNAME = '.gusi-trash'

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 同名冲突时在扩展名前插时间戳，避免覆盖回收站里的旧文件 */
const stampName = (p: string, stamp: number): string => {
  const ext = path.extname(p)
  return ext ? p.slice(0, -ext.length) + '.' + stamp + ext : p + '.' + stamp
}

export interface RemoveTracksResult {
  removed: number
  failed: Array<{ id: string, name?: string, reason: string }>
  total: number
  trashDir: string
}

export const removeTenantTracks = (rawUser: string, ids: string[]): RemoveTracksResult => {
  const t = loadTenant(rawUser)
  const dirs = t.settings.dirs.filter(d => !!d)
  const removed: TrackInfo[] = []
  const failed: RemoveTracksResult['failed'] = []
  for (const raw of ids) {
    const id = String(raw)
    const tr = t.tracksById.get(id)
    if (!tr) { failed.push({ id, reason: '曲目不存在' }); continue }
    // 取最深匹配的扫描目录作为该文件的归属根
    const owner = dirs.filter(d => isInside(tr.filePath, d)).sort((a, b) => b.length - a.length)[0]
    if (!owner) { failed.push({ id, name: tr.name, reason: '文件不在该用户曲库目录内，已跳过' }); continue }
    if (!fs.existsSync(tr.filePath)) {
      // 文件已被外部删除：仅清理索引，仍算删除成功
      removed.push(tr)
      failed.push({ id, name: tr.name, reason: '文件已不存在（已清理索引）' })
      continue
    }
    try {
      const dest = path.join(owner, TENANT_TRASH_DIRNAME, path.relative(owner, tr.filePath))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(tr.filePath, fs.existsSync(dest) ? stampName(dest, Date.now()) : dest)
      removed.push(tr)
    } catch (e) {
      failed.push({ id, name: tr.name, reason: (e as Error).message })
    }
  }
  if (removed.length) {
    const gone = new Set(removed.map(r => r.id))
    t.tracks = t.tracks.filter(x => !gone.has(x.id))
    for (const id of gone) t.tracksById.delete(id)
    // maxMtime 是 grouping 的缓存键，删除后必须重算，否则专辑/歌手分组不刷新
    let max = 0
    for (const tr of t.tracks) if (tr.mtime > max) max = tr.mtime
    t.maxMtime = max
    applyCoverFlags(t)
    persistTenant(t)
  }
  return { removed: removed.length, failed, total: t.tracks.length, trashDir: TENANT_TRASH_DIRNAME }
}

/** 触发该用户的扫描（若已在扫描则忽略） */
export const startTenantScan = (rawUser: string): { accepted: boolean, reason?: string, scanState: ScanState } => {
  const t = loadTenant(rawUser)
  if (t.scanState.scanning) return { accepted: false, reason: '扫描正在进行中', scanState: t.scanState }
  if (!t.settings.dirs.length) return { accepted: false, reason: '请先为该用户配置扫描目录', scanState: t.scanState }
  const dirs = [...t.settings.dirs]
  const old = t.tracksById
  void runScanWithState(dirs, old, t.scanState).then(result => {
    t.tracks = result
    t.tracksById = new Map(result.map(x => [x.id, x]))
    t.scannedAt = Date.now()
    let max = 0
    for (const tr of result) if (tr.mtime > max) max = tr.mtime
    t.maxMtime = max
    // 新扫描结果需重新合并在线回填封面标记
    applyCoverFlags(t)
    persistTenant(t)
    // 自动回填（默认关闭）
    if (t.settings.coverAuto) {
      for (const hook of scanDoneHooks) {
        try { hook(rawUser) } catch { /* 单个钩子失败不影响扫描结果 */ }
      }
    }
  }).catch(err => {
    t.scanState.error = err?.message ?? String(err)
    t.scanState.scanning = false
    t.scanState.finishedAt = Date.now()
  })
  return { accepted: true, scanState: t.scanState }
}

export const getTenantScanState = (rawUser: string): ScanState & { scannedAt: number, trackCount: number } => {
  const t = loadTenant(rawUser)
  return { ...t.scanState, scannedAt: t.scannedAt, trackCount: t.tracks.length }
}

/** 供 grouping.ts 使用：返回 (tracks, scannedAt, maxMtime) 三元组，作为缓存键基础 */
export const tenantGroupingSeed = (rawUser: string): { tracks: TrackInfo[], scannedAt: number, maxMtime: number } => {
  const t = loadTenant(rawUser)
  return { tracks: t.tracks, scannedAt: t.scannedAt, maxMtime: t.maxMtime }
}

// 用户删除时的清理（保留文件，仅清内存）
export const removeTenant = (rawUser: string): boolean => {
  const s = safeName(rawUser)
  dropTenant(s)
  // 文件不删，避免下次登录丢数据；如需硬删请走 admin 端点
  return true
}

// ---------------------------------------------------------------------------
// 目录安全：给前端提示可用系统授权目录（复用 admin/library 的实现，此处不重复）
// ---------------------------------------------------------------------------

export { DATA_KEY as TENANT_DATA_KEY }
