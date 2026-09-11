// ---------------------------------------------------------------------------
// 在线下载队列（MVP）
//   移植 daoyin（盗音）下载能力的最小内核：搜索 → 入队 → 多源并发下载 →
//   落盘到当前用户曲库目录 → 完成后可触发曲库扫描。
//   持久化：dataPath/downloads.json（任务列表 + 状态）
//   不引入 SQLite/ffmpeg：MVP 阶段保留 mp3/m4a/flac 原始文件，标签由曲库扫描时读
//   SSE：/web/api/downloads/events 实时推送任务状态变更
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ID3 from 'node-id3'
import { onlineResolvePlayUrl, onlineSearch } from '@/online'
import type { OnlineItem } from '@/online/kw'
import { getSettings } from '@/library'
import { getTenantSettings, startTenantScan } from '@/library/tenant'
import { runScan } from '@/library/scan'
import { getQuota } from '@/user/quota'

export interface DownloadTask {
  id: string
  userName: string
  source: string       // kw | wy | mg
  rid: string
  name: string
  singer: string
  album: string
  duration: number
  pic: string
  status: 'pending' | 'downloading' | 'done' | 'failed' | 'skipped'
  filePath?: string
  size: number
  bytes: number         // 已下载字节
  url?: string          // 直链缓存（避免每次重试重取）
  attempts: number
  maxAttempts: number
  retryAt: number       // 指数退避：下次可重试时间戳
  error?: string
  createdAt: number
  startedAt: number
  finishedAt: number
}

const MAX_TASKS = 200
const MAX_ATTEMPTS = 3
const CONCURRENCY = 3
const MAX_BYTES = 80 * 1024 * 1024

const file = () => path.join(global.lx.dataPath, 'downloads.json')

const readAll = (): DownloadTask[] => {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as DownloadTask[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

let tasks = readAll()
let byId = new Map(tasks.map(t => [t.id, t]))
let dedupKeys = new Set(tasks.filter(t => t.status !== 'done' && t.status !== 'failed').map(t => t.source + ':' + t.rid))
let timer: NodeJS.Timeout | null = null
const subs = new Set<(t: DownloadTask) => void>()

const writeAll = (): void => {
  try {
    fs.mkdirSync(global.lx.dataPath, { recursive: true })
    const tmp = file() + '.tmp'
    const data = JSON.stringify(tasks)
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file())
  } catch (err) {
    console.error('[downloads] persist failed:', err)
  }
}

const schedulePersist = (): void => {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    writeAll()
  }, 200)
}

const notify = (t: DownloadTask): void => {
  for (const cb of subs) {
    try { cb(t) } catch {}
  }
}

// ---------- 下载目录解析 ----------
// 优先级：租户配置 > 用户专属目录 > 全局配置 > dataPath/library
// 用户注册时自动创建 dataPath/library/<username>，无需手动设置
const dirForUser = (userName: string): string => {
  // 优先用租户配置的扫描目录
  const tenant = getTenantSettings(userName)
  if (tenant.dirs.length) return tenant.dirs[0]
  // 用户专属下载目录（注册时自动创建）
  const userDir = path.join(global.lx.dataPath, 'library', userName)
  try { fs.mkdirSync(userDir, { recursive: true }) } catch {}
  return userDir
}

const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true })
}

const safeName = (s: string, max = 120): string => {
  const clean = (s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().substring(0, max)
  return clean
}

const targetPath = (dir: string, task: DownloadTask): string => {
  // 文件名：<歌手> - <曲名>.<ext>；extension 通过 Content-Type / 上游决定，MVP 先用 .mp3 兜底
  const singer = safeName(task.singer)
  const name = safeName(task.name)
  const base = [singer, name].filter(Boolean).join(' - ') || task.rid || 'unknown'
  return path.join(dir, base + '.mp3')
}

// ---------- 已存在检测 ----------
const isDownloaded = (dir: string, task: DownloadTask): string | null => {
  const target = targetPath(dir, task)
  try {
    if (fs.existsSync(target)) {
      const st = fs.statSync(target)
      if (st.size > 0) return target
    }
  } catch {}
  return null
}

// ---------- 主下载 ----------
const pickSource = async (source: string, rid: string): Promise<string> => {
  return onlineResolvePlayUrl(source, rid)
}

// ---------- ID3v2 标签写入（仅 mp3） ----------
// 失败降级：不抛错给下载流程；仅返回错误信息供 task.error 记录。
const writeId3Tags = (filePath: string, task: DownloadTask): string | null => {
  if (!filePath.toLowerCase().endsWith('.mp3')) return null
  try {
    const tags: Record<string, unknown> = {}
    if (task.name) tags.title = task.name
    if (task.singer) tags.artist = task.singer
    if (task.album) tags.album = task.album
    if (task.duration > 0) tags.TCON = 'Music'
    if (!Object.keys(tags).length) return null
    const r = ID3.write(tags, filePath) as true | Error
    if (r === true) return null
    return r?.message || String(r)
  } catch (e: any) {
    return e?.message || String(e)
  }
}

const downloadTask = async (task: DownloadTask): Promise<void> => {
  if (task.status === 'done') return
  const dir = dirForUser(task.userName)
  ensureDir(dir)

  // 已存在则直接跳过（多版本弹窗暂不做）
  const existing = isDownloaded(dir, task)
  if (existing) {
    task.status = 'done'
    task.filePath = existing
    try { task.size = fs.statSync(existing).size } catch {}
    task.bytes = task.size
    task.finishedAt = Date.now()
    task.error = undefined
    dedupKeys.delete(task.source + ':' + task.rid)
    notify(task)
    schedulePersist()
    return
  }

  task.status = 'downloading'
  task.startedAt = Date.now()
  task.attempts += 1
  task.error = undefined
  task.bytes = 0
  notify(task)

  // 直链获取（缓存到 task.url）
  if (!task.url) {
    try {
      task.url = await pickSource(task.source, task.rid)
    } catch (err) {
      failTask(task, '取直链失败：' + (err as Error).message)
      return
    }
  }

  const target = targetPath(dir, task)
  const tmp = target + '.part'
  const ext = task.name.toLowerCase().endsWith('.m4a') ? '.m4a' : '.mp3'

  try {
    // 用 fetch 直接下：自带 TLS/HTTP2/跟随重定向；比 http.request 稳。
    try { fs.unlinkSync(tmp) } catch {}
    const ctl = new AbortController()
    const timeoutMs = Number(process.env.GS_DOWNLOAD_TIMEOUT_MS) || 120_000
    const timer = setTimeout(() => ctl.abort(new Error('下载超时')), timeoutMs)
    let resp: Response
    try {
      resp = await fetch(task.url, {
        redirect: 'follow',
        signal: ctl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': task.url.includes('kuwo') ? 'https://www.kuwo.cn/'
                    : task.url.includes('126.net') || task.url.includes('music.163.com') ? 'https://music.163.com/'
                    : 'https://music.163.com/',
        },
      })
    } catch (e: any) {
      clearTimeout(timer)
      throw new Error(e?.message || 'fetch failed')
    }
    if (!resp.ok) {
      clearTimeout(timer)
      try { fs.unlinkSync(tmp) } catch {}
      throw new Error('上游返回 ' + resp.status)
    }
    const len = Number(resp.headers.get('content-length'))
    if (Number.isFinite(len) && len > MAX_BYTES) {
      clearTimeout(timer)
      try { fs.unlinkSync(tmp) } catch {}
      throw new Error('文件超过 ' + (MAX_BYTES / 1024 / 1024) + 'MB 上限')
    }
    if (!resp.body) {
      clearTimeout(timer)
      try { fs.unlinkSync(tmp) } catch {}
      throw new Error('上游返回空 body')
    }

    const out = fs.createWriteStream(tmp)
    let received = 0
    const reader = (resp.body as any).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const buf = Buffer.from(value)
        received += buf.length
        if (received > MAX_BYTES) throw new Error('超出大小上限')
        task.bytes = received
        const ok = await new Promise<boolean>((resolve) => {
          out.write(buf, (err) => resolve(!err))
        })
        if (!ok) throw new Error('写入失败')
      }
      await new Promise<void>((resolve, reject) => out.end(() => resolve()))
    } catch (e: any) {
      try { out.destroy() } catch {}
      try { fs.unlinkSync(tmp) } catch {}
      clearTimeout(timer)
      throw new Error(e?.message || '下载中断')
    }
    clearTimeout(timer)
    if (received <= 0) {
      try { fs.unlinkSync(tmp) } catch {}
      throw new Error('下载内容为空')
    }

    // 写入完成，重命名
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target)
      fs.renameSync(tmp, target)
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch {}
      dedupKeys.delete(task.source + ':' + task.rid)
      throw err
    }
    dedupKeys.delete(task.source + ':' + task.rid)

    const stat = fs.statSync(target)
    task.status = 'done'
    task.filePath = target
    task.size = stat.size
    task.bytes = stat.size
    task.finishedAt = Date.now()
    task.error = undefined
    // 写 ID3v2 标签（mp3 文件才支持；失败仅记 error，不影响任务状态）
    if (target.toLowerCase().endsWith('.mp3')) {
      try { writeId3Tags(target, task) } catch (e: any) {
        task.error = 'ID3 写入失败：' + (e?.message || e)
      }
    }
    // 触发扫描（异步，不阻塞）
    try {
      const r = startTenantScan(task.userName)
      if (!r.accepted && r.reason && r.reason !== '扫描正在进行中') {
        // 未配目录 → 走全局扫描
        const g = getSettings()
        if (g.dirs.length) void runScan(g.dirs, new Map()).catch(() => void 0)
      }
    } catch {}
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch {}
    failTask(task, (err as Error).message)
    return
  }

  notify(task)
  schedulePersist()
}

const failTask = (task: DownloadTask, msg: string): void => {
  if (task.attempts >= task.maxAttempts) {
    task.status = 'failed'
    task.error = msg
    task.finishedAt = Date.now()
    dedupKeys.delete(task.source + ':' + task.rid)
  } else {
    // 指数退避：1s → 2s → 4s → ...（上限 60s）
    task.status = 'pending'
    task.error = msg
    const delay = Math.min(60_000, 1000 * Math.pow(2, task.attempts - 1))
    task.retryAt = Date.now() + delay
  }
  notify(task)
  schedulePersist()
}

// ---------- 队列调度 ----------
const running = new Set<string>()

const tick = async (): Promise<void> => {
  if (running.size >= CONCURRENCY) return
  const now = Date.now()
  const pending = tasks.filter(t => t.status === 'pending' && !running.has(t.id) && (!t.retryAt || now >= t.retryAt))
  for (const task of pending) {
    if (running.size >= CONCURRENCY) break
    running.add(task.id)
    void downloadTask(task).finally(() => {
      running.delete(task.id)
      schedulePersist()
    })
  }
}

const loop = (): void => {
  void tick().catch(err => console.error('[downloads] tick failed:', err))
}

// ---------- 公开 API ----------
export const subscribe = (cb: (t: DownloadTask) => void): (() => void) => {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

export const listTasks = (userName?: string): DownloadTask[] => {
  const src = userName ? tasks.filter(t => t.userName === userName) : tasks
  return src.slice().sort((a, b) => b.createdAt - a.createdAt)
}

export const getTask = (id: string): DownloadTask | undefined => byId.get(id)

export const removeTask = (id: string): boolean => {
  const t = byId.get(id)
  if (!t) return false
  if (t.status === 'downloading') return false
  dedupKeys.delete(t.source + ':' + t.rid)
  tasks = tasks.filter(x => x.id !== id)
  byId.delete(id)
  schedulePersist()
  return true
}

/** 从队列移除（可选同时删除本地物理文件） */
export const removeTaskWithFile = (id: string, deleteFile: boolean): { ok: boolean, deletedFile?: string, reason?: string } => {
  const t = byId.get(id)
  if (!t) return { ok: false, reason: '任务不存在' }
  if (t.status === 'downloading') return { ok: false, reason: '下载中的任务不可操作' }
  dedupKeys.delete(t.source + ':' + t.rid)
  let deletedFile: string | undefined
  if (deleteFile && t.filePath && t.status === 'done') {
    try {
      if (fs.existsSync(t.filePath)) { fs.unlinkSync(t.filePath); deletedFile = t.filePath }
    } catch {}
  }
  tasks = tasks.filter(x => x.id !== id)
  byId.delete(id)
  schedulePersist()
  return { ok: true, deletedFile }
}

export const retryTask = (id: string): DownloadTask | undefined => {
  const t = byId.get(id)
  if (!t) return undefined
  t.status = 'pending'
  t.attempts = 0
  t.error = undefined
  t.startedAt = 0
  t.finishedAt = 0
  t.bytes = 0
  t.url = undefined
  t.retryAt = 0
  dedupKeys.add(t.source + ':' + t.rid)
  notify(t)
  schedulePersist()
  return t
}

/** 批量操作：返回每项处理结果 */
export const batchOperate = (ids: string[], op: 'remove' | 'retry' | 'delete-file', userName: string): { ok: number, skipped: number, deletedFiles: string[], details: { id: string, ok: boolean, reason?: string }[] } => {
  const out: { id: string, ok: boolean, reason?: string, deletedFile?: string }[] = []
  let ok = 0
  let skipped = 0
  const deletedFiles: string[] = []
  for (const id of ids.slice(0, 100)) {
    const t = byId.get(id)
    if (!t || t.userName !== userName) {
      out.push({ id, ok: false, reason: '不存在或不属于当前用户' })
      skipped++
      continue
    }
    if (t.status === 'downloading') {
      out.push({ id, ok: false, reason: '下载中不可操作' })
      skipped++
      continue
    }
    if (op === 'remove') {
      const r = removeTaskWithFile(id, false)
      out.push({ id, ok: r.ok, reason: r.reason })
      r.ok ? ok++ : skipped++
    } else if (op === 'retry') {
      const t2 = retryTask(id)
      out.push({ id, ok: !!t2 })
      t2 ? ok++ : skipped++
    } else if (op === 'delete-file') {
      if (t.status === 'done' && t.filePath && fs.existsSync(t.filePath)) {
        try {
          fs.unlinkSync(t.filePath)
          deletedFiles.push(t.filePath)
          out.push({ id, ok: true, deletedFile: t.filePath })
          ok++
        } catch (e: any) {
          out.push({ id, ok: false, reason: e?.message || '删除文件失败' })
          skipped++
        }
      } else {
        out.push({ id, ok: false, reason: '任务未下载或文件不存在' })
        skipped++
      }
    }
  }
  schedulePersist()
  return { ok, skipped, deletedFiles, details: out.map(({ id, ok, reason }) => ({ id, ok, reason })) }
}

/** 入队下载：接受搜索结果的 (source, id, name, singer, intervalMs, pic) */
export const enqueue = async (userName: string, item: Pick<OnlineItem, 'source' | 'id' | 'name' | 'singer' | 'intervalMs' | 'pic'> & { album?: string }): Promise<{ accepted: boolean, task?: DownloadTask, reason?: string }> => {
  if (!item.id) return { accepted: false, reason: 'id 缺失' }
  if (!item.source) return { accepted: false, reason: 'source 缺失' }
  // 元数据兜底：客户端只传 {source, id} 时，通过搜索自动补齐 name/singer/pic
  if (!item.name && !item.singer) {
    try {
      const r = await onlineSearch(item.source, item.id, 1, 20)
      const hit = r.list.find(x => x.id === item.id) || r.list[0]
      if (hit) {
        item.name = hit.name || ''
        item.singer = hit.singer || ''
        item.intervalMs = Number(hit.intervalMs) || 0
        item.pic = hit.pic || ''
      }
    } catch { /* 忽略：保持原样入队，文件名会回退到 rid */ }
  }
  // 去重：同名同 rid 未完成任务不重复入队（原子性 Set 检查）
  const dedupKey = item.source + ':' + item.id
  if (dedupKeys.has(dedupKey)) {
    const t = tasks.find(x => x.source === item.source && x.rid === item.id && x.status !== 'done' && x.status !== 'failed')
    return { accepted: false, reason: '该曲目已在下载队列中', task: t }
  }
  dedupKeys.add(dedupKey)
  if (tasks.length >= MAX_TASKS) return { accepted: false, reason: '队列已满（最多 ' + MAX_TASKS + ' 项）' }
  // 配额检查：按 duration × 320KBps 预估，缺 duration 时按 3MB 兜底
  const estBytes = (item.intervalMs > 0 ? Math.round((item.intervalMs / 1000) * 320 * 1024 / 8) : 3 * 1024 * 1024)
  const quota = getQuota(userName)
  if (quota.remainingBytes < estBytes) {
    const usedGb = (quota.usedBytes / (1024 * 1024 * 1024)).toFixed(2)
    return { accepted: false, reason: '网盘容量不足：已用 ' + usedGb + 'GB / 配额 ' + quota.effectiveGb + 'GB' }
  }
  const id = crypto.randomBytes(8).toString('hex')
  const task: DownloadTask = {
    id,
    userName,
    source: item.source,
    rid: item.id,
    name: (item.name || '').substring(0, 160),
    singer: (item.singer || '').substring(0, 120),
    album: (item.album || '').substring(0, 120),
    duration: Number(item.intervalMs) || 0,
    pic: item.pic || '',
    status: 'pending',
    size: 0,
    bytes: 0,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    retryAt: 0,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
  }
  tasks.unshift(task)
  byId.set(id, task)
  schedulePersist()
  notify(task)
  // 立刻触发一次调度（不用等 500ms tick）
  void tick().catch(() => void 0)
  return { accepted: true, task }
}

/** 批量入队 */
export const enqueueMany = async (userName: string, items: (Pick<OnlineItem, 'source' | 'id' | 'name' | 'singer' | 'intervalMs' | 'pic'> & { album?: string })[]): Promise<{ accepted: number, skipped: number, tasks: DownloadTask[], reasons: { index: number, name: string, reason: string }[] }> => {
  let accepted = 0
  let skipped = 0
  const out: DownloadTask[] = []
  const reasons: { index: number, name: string, reason: string }[] = []
  for (let i = 0; i < items.length; i++) {
    if (out.length >= MAX_TASKS) {
      const it = items[i]
      reasons.push({ index: i, name: it.name || it.id, reason: '队列已满' })
      skipped++
      continue
    }
    const it = items[i]
    const r = await enqueue(userName, it)
    if (r.accepted && r.task) { accepted++; out.push(r.task) }
    else {
      skipped++
      if (r.reason) reasons.push({ index: i, name: it.name || it.id, reason: r.reason })
    }
  }
  return { accepted, skipped, tasks: out, reasons }
}

/**
 * 解析歌单文本，逐行搜索在线源并批量入队。
 * 支持的分隔符（按优先级）：
 *   1. \t（tab）：歌手\t曲名[可选：版本]
 *   2. "-"（中/英）：歌手 - 曲名
 *   3. "-"、" - "、"–"、" — "
 * 每行可包含可选的版本备注（括号内容/竖线后），搜索时只取歌手+曲名，
 * 版本备注用于在候选中优先匹配（如 "周杰伦 - 晴天 - 稻香Live"）。
 * 一行一个任务，最多 parseBatch 返回前 MAX_TASKS 条。
 */
const splitPlaylistLine = (raw: string): { singer: string, name: string, note: string } => {
  const line = (raw || '').trim()
  if (!line) return { singer: '', name: '', note: '' }
  // 优先 tab
  if (line.includes('\t')) {
    const parts = line.split('\t').map(s => s.trim())
    const singer = parts[0] || ''
    const name = parts[1] || ''
    const note = parts.slice(2).join(' ')
    return { singer, name, note }
  }
  // "歌手 - 曲名"（- 前后可有空格）
  const m = line.match(/^([^-\t–—]{1,40})\s*[-–—]\s*(.+)$/)
  if (m) {
    const singer = m[1].trim()
    const rest = m[2].trim()
    // rest 里可能又含 -（版本备注），取第一次 - 之后为 note
    const n = rest.match(/^([^-\t–—]{1,80})\s*[-–—]\s*(.+)$/)
    if (n) return { singer, name: n[1].trim(), note: n[2].trim() }
    return { singer, name: rest, note: '' }
  }
  // 纯曲名（没识别出歌手）
  return { singer: '', name: line, note: '' }
}

const SIMILARITY = (a: string, b: string): number => {
  if (!a || !b) return 0
  if (a === b) return 1
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (long.includes(short) && short.length >= 2) return 0.9
  // 字符交集比
  const setA = new Set(short)
  let hits = 0
  for (const c of setA) if (long.includes(c)) hits++
  return hits / Math.max(short.length, 1)
}

export const parsePlaylistText = async (
  userName: string,
  text: string,
  source: string,
  opts?: { maxLines?: number },
): Promise<{
  accepted: number
  skipped: number
  notFound: { line: string, reason: string }[]
  tasks: DownloadTask[]
}> => {
  const maxLines = Math.min(opts?.maxLines ?? 50, 50)
  const rawLines = text.split(/\r?\n/)
  const lines: { singer: string, name: string, note: string, raw: string }[] = []
  for (const raw of rawLines) {
    const t = raw.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    const p = splitPlaylistLine(t)
    if (!p.name) continue
    lines.push({ ...p, raw: t })
    if (lines.length >= maxLines) break
  }

  const notFound: { line: string, reason: string }[] = []
  const hits: (Pick<OnlineItem, 'source' | 'id' | 'name' | 'singer' | 'intervalMs' | 'pic'> & { album?: string })[] = []

  for (const line of lines) {
    // 组装搜索关键词：歌手+曲名
    const kw = (line.singer + ' ' + line.name).trim()
    let list: OnlineItem[] = []
    try {
      const r = await onlineSearch(source, kw, 1, 20)
      list = r.list || []
    } catch (e: any) {
      notFound.push({ line: line.raw, reason: '搜索失败：' + (e?.message || 'unknown') })
      continue
    }
    if (!list.length) {
      // 降级：只搜曲名
      try {
        const r = await onlineSearch(source, line.name, 1, 20)
        list = r.list || []
      } catch { /* keep empty */ }
    }
    if (!list.length) {
      notFound.push({ line: line.raw, reason: '未找到匹配曲目' })
      continue
    }
    // 打分：singer 相似 × name 相似 + note 优先匹配（如果 note 命中曲名/版本）
    let best: { item: OnlineItem, score: number } | null = null
    for (const it of list) {
      let s = SIMILARITY(line.name, it.name) * 0.7
      s += SIMILARITY(line.singer, it.singer) * 0.3
      if (line.note) {
        if ((it.name || '').includes(line.note) || (it.singer || '').includes(line.note)) s += 0.15
      }
      if (!best || s > best.score) best = { item: it, score: s }
    }
    if (!best || best.score < 0.3) {
      notFound.push({ line: line.raw, reason: '匹配分数过低（' + best?.score.toFixed(2) + '）' })
      continue
    }
    const it = best.item
    hits.push({
      source: it.source || source,
      id: it.id,
      name: it.name || line.name,
      singer: it.singer || line.singer,
      album: it.album || '',
      intervalMs: Number(it.intervalMs) || 0,
      pic: it.pic || '',
    })
  }

  const r = await enqueueMany(userName, hits)
  return {
    accepted: r.accepted,
    skipped: r.skipped,
    notFound,
    tasks: r.tasks,
  }
}

export const stats = (userName?: string): { total: number, done: number, failed: number, pending: number, downloading: number, bytes: number } => {
  const list = userName ? listTasks(userName) : listTasks()
  const sum = { total: list.length, done: 0, failed: 0, pending: 0, downloading: 0, bytes: 0 }
  for (const t of list) {
    if (t.status === 'done') sum.done++
    else if (t.status === 'failed') sum.failed++
    else if (t.status === 'downloading') sum.downloading++
    else sum.pending++
    sum.bytes += t.size
  }
  return sum
}

// ---------- 搜索代理（复用现有 onlineSearch，为下载页统一入口） ----------
export const searchForDownload = (source: string, keyword: string, page = 1, size = 30) => {
  return onlineSearch(source, keyword, page, size)
}

// ---------- 生命周期 ----------
export const initDownloads = (): void => {
  // 重启恢复：把 downloading/pending 归到 pending，等 tick 重新调度
  for (const t of tasks) {
    if (t.status === 'downloading') {
      t.status = 'pending'
      t.error = '服务器重启，任务重新排队'
      notify(t)
    }
  }
  // 清理崩溃残留的 .part 临时文件
  try {
    const libRoot = path.join(global.lx.dataPath, 'library')
    if (fs.existsSync(libRoot)) {
      for (const user of fs.readdirSync(libRoot, { withFileTypes: true })) {
        if (!user.isDirectory()) continue
        const uDir = path.join(libRoot, user.name)
        for (const f of fs.readdirSync(uDir, { withFileTypes: true })) {
          if (f.isFile() && /\.part$/i.test(f.name)) {
            try { fs.unlinkSync(path.join(uDir, f.name)) } catch {}
          }
        }
      }
    }
  } catch {}
  schedulePersist()
  // 主循环
  if (!timer) timer = null
  const loopTimer = setInterval(loop, 500)
  loopTimer.unref?.()
  // 立即调一次
  void loop()
}
