import fs from 'node:fs/promises'
import path from 'node:path'
import { isAudioFile, readTrackMeta, type TrackMeta } from './metadata'

// ---------------------------------------------------------------------------
// 曲库扫描器：递归扫描配置目录，增量（size+mtime 未变则复用旧元数据），
// 并发读取标签，进度状态供 Web UI 轮询。
// WebDAV 目录在 fnOS 上挂载为本地路径后与本地目录同等对待。
// ---------------------------------------------------------------------------

export interface TrackInfo extends TrackMeta {
  id: string
  filePath: string
  relPath: string
  ext: string
  size: number
  mtime: number
  /** 封面来自在线回填缓存（非文件内嵌），仅运行时标记、不写回索引 */
  coverCache?: boolean
}

export interface ScanState {
  scanning: boolean
  total: number
  done: number
  startedAt: number
  finishedAt: number
  error: string | null
}

const SKIP_DIRS = new Set(['node_modules', '@eaDir', '#recycle', '.thumbnails', '.DS_Store'])
const MAX_DEPTH = 12
const CONCURRENCY = 8

export const scanState: ScanState = {
  scanning: false,
  total: 0,
  done: 0,
  startedAt: 0,
  finishedAt: 0,
  error: null,
}

interface FileEntry { filePath: string, relPath: string }

const walk = async (root: string, dir: string, depth: number, out: FileEntry[]): Promise<void> => {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (entry.isDirectory()) {
      await walk(root, full, depth + 1, out)
    } else if (entry.isFile() && isAudioFile(name)) {
      out.push({ filePath: full, relPath: path.relative(root, full) })
    }
  }
}

/** 稳定 ID：相对路径 hash（同路径重扫 ID 不变，歌单导入不失效） */
/** 曲目 id 由扫描根下的相对路径决定（小写 md5 前 16 位）；重命名文件会改变 id */
export const trackId = (relPath: string): string => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto')
  return crypto.createHash('md5').update(relPath.toLowerCase()).digest('hex').substring(0, 16)
}

/**
 * 执行扫描。oldTracks 用于增量复用；返回完整新曲库。
 * 调用方负责加锁（scanning 期间拒绝再次触发）与持久化。
 */
export const runScan = async (dirs: string[], oldTracks: Map<string, TrackInfo>): Promise<TrackInfo[]> => {
  return runScanWithState(dirs, oldTracks, scanState)
}

/** 使用外部 state 对象的扫描实现：多租户并发扫描时各自持有独立 ScanState */
export const runScanWithState = async (dirs: string[], oldTracks: Map<string, TrackInfo>, state: ScanState): Promise<TrackInfo[]> => {
  if (state.scanning) throw new Error('扫描正在进行中')
  state.scanning = true
  state.error = null
  state.startedAt = Date.now()
  state.finishedAt = 0
  state.total = 0
  state.done = 0
  try {
    const files: FileEntry[] = []
    for (const root of dirs) {
      const stat = await fs.stat(root).catch(() => null)
      if (!stat?.isDirectory()) {
        state.error = `目录不存在或无权限：${root}`
        continue
      }
      await walk(root, root, 0, files)
    }
    state.total = files.length
    const result: TrackInfo[] = []
    let cursor = 0
    const worker = async(): Promise<void> => {
      for (;;) {
        const idx = cursor++
        if (idx >= files.length) return
        const { filePath, relPath } = files[idx]
        const id = trackId(relPath)
        try {
          const stat = await fs.stat(filePath)
          const mtime = Math.floor(stat.mtimeMs)
          const old = oldTracks.get(id)
          let meta: TrackMeta | null = null
          if (old && old.size == stat.size && old.mtime == mtime) {
            meta = old // 增量：未变化跳过标签读取
          } else {
            meta = await readTrackMeta(filePath, relPath)
          }
          result.push({
            id,
            filePath,
            relPath,
            ext: path.extname(filePath).toLowerCase().replace(/^\./, ''),
            size: stat.size,
            mtime,
            ...meta,
          })
        } catch {
          // 单个文件失败不致命：若旧索引存在则保留
          const old = oldTracks.get(id)
          if (old) result.push(old)
        } finally {
          state.done++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length || 1) }, () => worker()))
    result.sort((a, b) => a.singer.localeCompare(b.singer) || a.album.localeCompare(b.album) || (a.trackNum ?? 999) - (b.trackNum ?? 999) || a.name.localeCompare(b.name))
    return result
  } finally {
    state.scanning = false
    state.finishedAt = Date.now()
  }
}
