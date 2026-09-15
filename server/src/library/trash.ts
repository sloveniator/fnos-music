// ---------------------------------------------------------------------------
// 曲库回收站（软删除）的统一文件层 —— 全局曲库用
//
// 语义与租户曲库（library/tenant.ts 里的 remove/listTrash/restore/purge）保持一致：
//   软删除 = 文件搬到 <扫描目录>/.gusi-trash/<原相对路径>，不是 rm；
//   .gusi-trash 是点目录，扫描器（scan.ts）不进，所以不会被扫回索引；
//   恢复 = 搬回原相对路径（撞名加时间戳，绝不覆盖）；彻底删除只在回收站页显式触发。
//
// 为什么单独一个模块而不是复用 tenant.ts：tenant 那套的入口是「用户名」，内部自己
// loadTenant；全局曲库的目录来自 library-settings.json 的 dirs，索引在 library/index.ts
// 的内存里。这里把纯文件操作抽出来，目录列表由调用方传入，两边语义对齐、实现不互相牵连。
// （tenant.ts 是 CRLF 文件，不为这次改动去动它，避免整文件行尾翻新。）
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'

/** 回收站目录名（点开头 = 扫描器不进入） */
export const TRASH_DIRNAME = '.gusi-trash'

export interface TrashEntry {
  /** 相对 .gusi-trash 的路径，同时也是它在曲库里的原相对路径 */
  relPath: string
  name: string
  singer: string
  album: string
  size: number
  mtime: number
}

export interface TrashOpResult {
  ok: number
  failed: Array<{ path: string, reason: string }>
}

export const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 同名冲突时在扩展名前插时间戳，避免覆盖回收站里的旧文件 */
export const stampName = (p: string, stamp: number): string => {
  const ext = path.extname(p)
  return ext ? p.slice(0, -ext.length) + '.' + stamp + ext : p + '.' + stamp
}

/** 回收站根目录列表（每个扫描目录下一个） */
export const trashRoots = (dirs: string[]): string[] =>
  dirs.filter(d => !!d).map(d => path.join(d, TRASH_DIRNAME))

const walk = (root: string, cb: (full: string) => void): void => {
  let entries: any[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) as any[] } catch { return }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) walk(full, cb)
    else if (e.isFile()) cb(full)
  }
}

/**
 * 把一个文件搬进它所属扫描目录的回收站。
 * owner 必须是 filePath 所属的扫描目录（调用方已用 isInside 校验过）。
 */
export const moveIntoTrash = (owner: string, filePath: string): string => {
  const dest = path.join(owner, TRASH_DIRNAME, path.relative(owner, filePath))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(filePath, fs.existsSync(dest) ? stampName(dest, Date.now()) : dest)
  return dest
}

/** 回收站内相对路径 → 绝对路径；不在任何回收站根内则返回 null（防 ../ 越权） */
export const resolveInTrash = (dirs: string[], relPath: string): string | null => {
  const rel = String(relPath ?? '')
  if (!rel || rel === '.' || path.isAbsolute(rel) || rel.includes('\0')) return null
  if (rel.split(/[\\/]/).some(seg => seg === '..')) return null
  for (const root of trashRoots(dirs)) {
    const p = path.resolve(root, rel)
    if (isInside(p, root)) return p
  }
  return null
}

export const listTrash = (dirs: string[]): TrashEntry[] => {
  const out: TrashEntry[] = []
  for (const root of trashRoots(dirs)) {
    walk(root, (full) => {
      let st: fs.Stats
      try { st = fs.statSync(full) } catch { return }
      const relPath = path.relative(root, full)
      const seg = relPath.split(path.sep)
      out.push({
        relPath,
        name: path.basename(relPath, path.extname(relPath)),
        singer: seg.length >= 3 ? seg[seg.length - 3] : '',
        album: seg.length >= 2 ? seg[seg.length - 2] : '',
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      })
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 搬空的目录顺手清掉，回收站里不留一串空壳 */
export const pruneEmptyTrashDirs = (dirs: string[]): void => {
  for (const root of trashRoots(dirs)) {
    const prune = (dir: string): void => {
      let entries: any[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) as any[] } catch { return }
      for (const e of entries) if (e.isDirectory()) prune(path.join(dir, e.name))
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch { /* 非空：留着 */ }
    }
    prune(root)
  }
}

/** 恢复：按原相对路径搬回曲库；原位置已有同名文件时加时间戳，绝不覆盖 */
export const restoreTrash = (dirs: string[], relPaths: string[]): TrashOpResult => {
  const roots = dirs.filter(d => !!d)
  const result: TrashOpResult = { ok: 0, failed: [] }
  for (const raw of relPaths) {
    const rel = String(raw ?? '')
    const src = resolveInTrash(roots, rel)
    if (!src) { result.failed.push({ path: rel, reason: '非法路径' }); continue }
    if (!fs.existsSync(src)) { result.failed.push({ path: rel, reason: '回收站里没有这个文件' }); continue }
    const owner = roots
      .filter(d => isInside(src, path.join(d, TRASH_DIRNAME)))
      .sort((a, b) => b.length - a.length)[0]
    const dest = owner ? path.resolve(owner, rel) : ''
    if (!owner || !isInside(dest, owner)) { result.failed.push({ path: rel, reason: '目标路径越界' }); continue }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(src, fs.existsSync(dest) ? stampName(dest, Date.now()) : dest)
      result.ok++
    } catch (e) { result.failed.push({ path: rel, reason: (e as Error).message }) }
  }
  pruneEmptyTrashDirs(roots)
  return result
}

/** 彻底删除（不可恢复）；relPaths 传 ['*'] 表示清空整个回收站 */
export const purgeTrash = (dirs: string[], relPaths: string[]): TrashOpResult => {
  const roots = dirs.filter(d => !!d)
  const result: TrashOpResult = { ok: 0, failed: [] }
  const targets: string[] = []
  if (relPaths.some(x => String(x) === '*')) {
    for (const root of trashRoots(roots)) walk(root, (full) => targets.push(full))
  } else {
    for (const raw of relPaths) {
      const rel = String(raw ?? '')
      const p = resolveInTrash(roots, rel)
      if (!p) { result.failed.push({ path: rel, reason: '非法路径' }); continue }
      if (!fs.existsSync(p)) { result.failed.push({ path: rel, reason: '回收站里没有这个文件' }); continue }
      targets.push(p)
    }
  }
  for (const p of targets) {
    try { fs.unlinkSync(p); result.ok++ } catch (e) { result.failed.push({ path: p, reason: (e as Error).message }) }
  }
  pruneEmptyTrashDirs(roots)
  return result
}
