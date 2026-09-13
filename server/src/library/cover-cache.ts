import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 在线封面回填缓存（持久化，独立于原始音频文件）
//   dataPath/libraries/<safeUser>/covers/<trackId>.jpg    封面文件
//   dataPath/libraries/<safeUser>/covers/index.json       匹配映射（含失败记录）
// 设计要点：
//   - 不修改用户原始音频：封面单独落盘，随时可整目录删除重建
//   - 失败（nomatch / error）同样落记录：避免每次扫描都重爬同一批无解曲目，触发风控
//   - 原子写 + 串行 persistChain，避免并发写坏索引
// ---------------------------------------------------------------------------

export type CoverStatus = 'ok' | 'nomatch' | 'error'

export interface CoverEntry {
  status: CoverStatus
  /** 命中音源：wy / kw … */
  source?: string
  onlineId?: string
  /** 命中的在线曲名 / 歌手，便于人工核对 */
  title?: string
  artist?: string
  picUrl?: string
  /** 封面文件名（相对 covers 目录） */
  file?: string
  size?: number
  /** 匹配分（0~1，两位小数） */
  score?: number
  at: number
  tries: number
}

interface CoverIndexFile {
  version: number
  updatedAt: number
  entries: Record<string, CoverEntry>
}

interface CacheState {
  safeUser: string
  dir: string
  entries: Map<string, CoverEntry>
  persistChain: Promise<void>
}

const INDEX_VERSION = 1
const states = new Map<string, CacheState>()

const coverDir = (safeUser: string): string => {
  const p = path.join(global.lx.dataPath, 'libraries', safeUser, 'covers')
  try { fs.mkdirSync(p, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  return p
}

const load = (safeUser: string): CacheState => {
  const hit = states.get(safeUser)
  if (hit) return hit
  const dir = coverDir(safeUser)
  const entries = new Map<string, CoverEntry>()
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as CoverIndexFile
    for (const [id, e] of Object.entries(raw?.entries ?? {})) {
      if (e && typeof e.status === 'string') entries.set(id, e as CoverEntry)
    }
  } catch { /* 首次运行或索引损坏：从空开始 */ }
  const st: CacheState = { safeUser, dir, entries, persistChain: Promise.resolve() }
  states.set(safeUser, st)
  return st
}

const persist = (st: CacheState): Promise<void> => {
  st.persistChain = st.persistChain.then(() => new Promise<void>((resolve) => {
    const file = path.join(st.dir, 'index.json')
    const tmp = file + '.tmp'
    const data: CoverIndexFile = {
      version: INDEX_VERSION,
      updatedAt: Date.now(),
      entries: Object.fromEntries(st.entries),
    }
    fs.writeFile(tmp, JSON.stringify(data), (err) => {
      if (!err) { try { fs.renameSync(tmp, file) } catch { /* ignore */ } }
      resolve()
    })
  }))
  return st.persistChain
}

/** 等待所有待写盘完成（供测试/关闭时使用） */
export const flushCoverCache = (safeUser: string): Promise<void> => load(safeUser).persistChain

export const coverEntryOf = (safeUser: string, trackId: string): CoverEntry | undefined =>
  load(safeUser).entries.get(trackId)

/** 是否已有可用缓存封面（status=ok 且封面文件确实存在） */
export const hasCachedCover = (safeUser: string, trackId: string): boolean => {
  const st = load(safeUser)
  const e = st.entries.get(trackId)
  if (!e || e.status !== 'ok' || !e.file) return false
  try { return fs.existsSync(path.join(st.dir, e.file)) } catch { return false }
}

export const readCachedCover = (safeUser: string, trackId: string): { mime: string, data: Buffer } | null => {
  const e = load(safeUser).entries.get(trackId)
  if (!e || e.status !== 'ok' || !e.file) return null
  try {
    const data = fs.readFileSync(path.join(load(safeUser).dir, e.file))
    if (!data.length) return null
    return { mime: /\.png$/i.test(e.file) ? 'image/png' : 'image/jpeg', data }
  } catch { return null }
}

export const saveCoverFile = (safeUser: string, trackId: string, data: Buffer, ext = 'jpg'): string => {
  const st = load(safeUser)
  const name = trackId + '.' + (ext === 'png' ? 'png' : 'jpg')
  fs.writeFileSync(path.join(st.dir, name), data)
  return name
}

export const recordCover = (safeUser: string, trackId: string, entry: CoverEntry): void => {
  const st = load(safeUser)
  st.entries.set(trackId, entry)
  void persist(st)
}

export const coverCacheStats = (safeUser: string): { ok: number, nomatch: number, error: number, total: number } => {
  let ok = 0, nomatch = 0, error = 0
  for (const e of load(safeUser).entries.values()) {
    if (e.status === 'ok') ok++
    else if (e.status === 'nomatch') nomatch++
    else error++
  }
  return { ok, nomatch, error, total: ok + nomatch + error }
}

/** 清空缓存（删除封面文件与索引），返回删除的文件数 */
export const clearCoverCache = (safeUser: string): number => {
  const st = load(safeUser)
  let removed = 0
  for (const e of st.entries.values()) {
    if (!e.file) continue
    try { fs.unlinkSync(path.join(st.dir, e.file)); removed++ } catch { /* ignore */ }
  }
  st.entries.clear()
  void persist(st)
  return removed
}

/** 用户被移除时释放内存 */
export const dropCoverCache = (safeUser: string): void => { states.delete(safeUser) }
