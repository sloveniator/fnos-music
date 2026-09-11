import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import crypto from 'node:crypto'
import { getDownloadTarget, getTrack, scheduleAutoScan, type DownloadTarget } from './index'

// ---------------------------------------------------------------------------
// 服务端下载引擎：把曲目（曲库文件 / 直链 / 第三方代理解析出的 URL）
// 写入指定下载目标。目标后端两类：
//   local  —— 直接写文件系统（覆盖本地目录、fnOS 已挂载的 WebDAV/网盘挂载点）
//   webdav —— 服务端 MKCOL 建目录 + PUT 上传（覆盖未挂载的 WebDAV / AList / Docker 网盘）
// 内存任务队列，并发上限 2，支持取消；进度按字节计数。
// ---------------------------------------------------------------------------

export interface DownloadTask {
  id: string
  kind: 'track' | 'url'
  trackId?: string
  url?: string
  filename: string
  subdir: string
  targetId: string
  targetName: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  received: number
  total: number
  error?: string
  resultPath?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

const MAX_CONCURRENT = 2
const tasks = new Map<string, DownloadTask>()
const queue: string[] = []
const controllers = new Map<string, AbortController>()
let running = 0

export interface EnqueueInput {
  kind: 'track' | 'url'
  trackId?: string
  url?: string
  filename?: string
  subdir?: string
  targetId: string
}

/** 清洗单个路径段：去分隔符/控制符/相对穿越，限长 */
const sanitizeSegment = (s: string): string => {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s{2,}/g, ' ').trim()
    .replace(/^\.+/, '')
  return cleaned.substring(0, 120)
}

/** 子目录：允许 a/b 嵌套，逐段清洗并剔除 . / .. */
const sanitizeSubdir = (s: string): string => {
  if (!s) return ''
  return s.split(/[\\/]/)
    .map(seg => sanitizeSegment(seg))
    .filter(seg => seg && seg != '.' && seg != '..')
    .join('/')
}

const extOf = (name: string): string => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return m ? '.' + m[1].toLowerCase() : ''
}

export const enqueueDownload = (input: EnqueueInput): DownloadTask => {
  const target = getDownloadTarget(input.targetId)
  if (!target) throw new Error('下载目标不存在')
  let filename = ''
  let total = 0
  let url = input.url
  if (input.kind == 'track') {
    const track = getTrack(input.trackId ?? '')
    if (!track) throw new Error('曲目不存在（可能已重新扫描）')
    const ext = extOf(track.filePath) || `.${track.ext || 'bin'}`
    const base = sanitizeSegment(input.filename ?? '') || sanitizeSegment(`${track.singer ? track.singer + ' - ' : ''}${track.name}`) || track.id
    filename = (/\.[a-z0-9]{1,8}$/i.test(base) ? base : base + ext)
    url = undefined
    total = track.size
  } else {
    if (!url || !/^https?:\/\//.test(url)) throw new Error('直链非法')
    const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    const base = sanitizeSegment(input.filename ?? '') || sanitizeSegment(fromUrl) || crypto.randomBytes(4).toString('hex')
    filename = /\.[a-z0-9]{1,8}$/i.test(base) ? base : base + (extOf(fromUrl) || '.bin')
  }
  const task: DownloadTask = {
    id: crypto.randomBytes(6).toString('hex'),
    kind: input.kind,
    trackId: input.kind == 'track' ? input.trackId : undefined,
    url,
    filename,
    subdir: sanitizeSubdir(input.subdir ?? ''),
    targetId: target.id,
    targetName: target.name,
    status: 'queued',
    received: 0,
    total,
    createdAt: Date.now(),
  }
  tasks.set(task.id, task)
  queue.push(task.id)
  pump()
  return task
}

const pump = (): void => {
  while (running < MAX_CONCURRENT && queue.length) {
    const id = queue.shift() as string
    const task = tasks.get(id)
    if (!task || task.status == 'cancelled') continue
    running++
    void runTask(task).finally(() => {
      running--
      pump()
    })
  }
}

const finish = (task: DownloadTask, status: 'done' | 'error' | 'cancelled', error?: string): void => {
  task.status = status
  if (error) task.error = error.substring(0, 300)
  task.finishedAt = Date.now()
}

const openSource = async (task: DownloadTask): Promise<{ stream: Readable, total: number }> => {
  if (task.kind == 'track') {
    const track = getTrack(task.trackId ?? '')
    if (!track) throw new Error('曲目不存在')
    return { stream: fs.createReadStream(track.filePath), total: track.size }
  }
  const controller = new AbortController()
  controllers.set(task.id, controller)
  const resp = await fetch(task.url as string, {
    signal: controller.signal,
    headers: { 'User-Agent': 'gusi-music-downloader/1.0' },
  })
  if (!resp.ok || !resp.body) throw new Error(`源返回 HTTP ${resp.status}`)
  const len = Number(resp.headers.get('content-length'))
  return { stream: Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream), total: isFinite(len) ? len : 0 }
}

const makeCounter = (task: DownloadTask): Transform =>
  new Transform({
    transform(chunk: Buffer, _enc, cb) {
      task.received += chunk.length
      cb(null, chunk)
    },
  })

// ------------------------------ local --------------------------------------

const writeToLocal = async (target: DownloadTarget, task: DownloadTask, source: Readable): Promise<void> => {
  const root = path.resolve(target.path ?? '')
  const dir = task.subdir ? path.resolve(root, task.subdir) : root
  if (dir != root && !dir.startsWith(root + path.sep)) throw new Error('非法子目录')
  const dest = path.join(dir, task.filename)
  if (!dest.startsWith(dir + path.sep)) throw new Error('非法文件名')
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${dest}.lxmtmp-${task.id}`
  try {
    await pipeline(source, fs.createWriteStream(tmp))
    await fsp.rename(tmp, dest)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  task.resultPath = dest
}

// ------------------------------ webdav -------------------------------------

const authHeader = (target: DownloadTarget): Record<string, string> => {
  if (!target.username) return {}
  const token = Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

const webdavUrl = (target: DownloadTarget, rel: string): string => {
  const segs = rel.split('/').filter(Boolean).map(s => encodeURIComponent(s)).join('/')
  return `${target.url}/${segs}`
}

/** 逐级 MKCOL（幂等：201/204/405/301/302 均视为已存在） */
const ensureCollections = async (target: DownloadTarget, rel: string): Promise<void> => {
  const segs = rel.split('/').filter(Boolean)
  let acc = ''
  for (let i = 0; i < segs.length - 1; i++) {
    acc += (acc ? '/' : '') + segs[i]
    const resp = await fetch(webdavUrl(target, acc), { method: 'MKCOL', headers: authHeader(target), signal: AbortSignal.timeout(15_000) }).catch(() => null)
    if (resp && resp.status >= 400 && resp.status != 405 && resp.status != 409) {
      // 409 Conflict 常见于父级竞态，忽略继续 PUT；其余硬错误抛出
      throw new Error(`WebDAV 建目录失败(${resp.status})：${decodeURIComponent(segs[i])}`)
    }
  }
}

const writeToWebdav = async (target: DownloadTarget, task: DownloadTask, source: Readable, total: number): Promise<void> => {
  const rel = [task.subdir, task.filename].filter(Boolean).join('/')
  await ensureCollections(target, rel)
  const headers: Record<string, string> = { ...authHeader(target), 'Content-Type': 'application/octet-stream' }
  if (total > 0) headers['Content-Length'] = String(total)
  const controller = new AbortController()
  controllers.set(task.id, controller)
  const resp = await fetch(webdavUrl(target, rel), {
    method: 'PUT',
    headers,
    body: source,
    duplex: 'half',
    signal: controller.signal,
  } as unknown as RequestInit)
  if (!resp.ok && resp.status != 201 && resp.status != 204) throw new Error(`WebDAV 上传失败(${resp.status})`)
  task.resultPath = webdavUrl(target, rel)
}

// ------------------------------ runner -------------------------------------

const runTask = async (task: DownloadTask): Promise<void> => {
  // 取消由 cancelDownload 异步改写 task.status，用函数读取规避 TS 字面量窄化
  const status = (): DownloadTask['status'] => task.status
  if (status() == 'cancelled') return
  const target = getDownloadTarget(task.targetId)
  if (!target) {
    finish(task, 'error', '下载目标不存在')
    return
  }
  task.status = 'running'
  task.startedAt = Date.now()
  let source: Readable | null = null
  try {
    const opened = await openSource(task)
    if (status() == 'cancelled') {
      opened.stream.destroy()
      return
    }
    if (!task.total) task.total = opened.total
    source = opened.stream.pipe(makeCounter(task))
    if (target.type == 'webdav') await writeToWebdav(target, task, source, task.total)
    else await writeToLocal(target, task, source)
    if (status() == 'cancelled') return
    task.received = task.total || task.received
    finish(task, 'done')
    if (target.type == 'local' && task.resultPath) scheduleAutoScan(task.resultPath)
  } catch (err: any) {
    source?.destroy()
    if (status() == 'cancelled') return
    if (err?.name == 'AbortError') {
      finish(task, 'cancelled')
      return
    }
    finish(task, 'error', err?.message ?? String(err))
  } finally {
    controllers.delete(task.id)
  }
}

export const cancelDownload = (id: string): boolean => {
  const task = tasks.get(id)
  if (!task) return false
  if (task.status == 'queued') {
    const qi = queue.indexOf(id)
    if (qi >= 0) queue.splice(qi, 1)
    finish(task, 'cancelled')
    return true
  }
  if (task.status == 'running') {
    task.status = 'cancelled'
    controllers.get(id)?.abort()
    return true
  }
  return false
}

export const removeDownload = (id: string): boolean => {
  const task = tasks.get(id)
  if (!task || task.status == 'running' || task.status == 'queued') return false
  tasks.delete(id)
  return true
}

export const listDownloads = (): DownloadTask[] =>
  [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200)

export const clearFinishedDownloads = (): number => {
  let n = 0
  for (const [id, t] of tasks) {
    if (t.status == 'done' || t.status == 'error' || t.status == 'cancelled') {
      tasks.delete(id)
      n++
    }
  }
  return n
}
