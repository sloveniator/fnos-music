// ---------------------------------------------------------------------------
// 第三方 JS 音源 —— 服务端承载管理器
//   每个已托管的第三方脚本 = 独立 worker（user-source-worker.ts），本模块负责：
//     - 脚本/元数据持久化：data/user-sources/{id}.js + data/user-sources/meta.json
//     - worker 生命周期：按需拉起、boot 等待、invoke 看门狗、失活重建、禁用终止
//     - capabilities 采集：脚本 send(inited,{sources}) 回报 → 元数据缓存
//     - 解析链导出：resolveFromUserSources(source,id,quality,extra) 依序尝试
//       启用且覆盖该平台的脚本，成功即返回直链（null = 无可尝试，交由内置/旧代理）
//   资源护栏（信任脚本但防失控）：单次 invoke 超时 → terminate 重建；请求体上限、
//   重定向上限在 worker 内；脚本环境无 require/process/eval/Function。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getSettings } from '@/library'

// ============================== 类型 ==============================
export interface UserSourceMeta {
  id: string
  name: string
  enabled: boolean
  /** capabilities[platform] = actions 列表（脚本 inited 回报；未知为空对象） */
  capabilities: Record<string, string[]>
  /** 脚本最近一次 updateAlert 通告 */
  lastAlert?: { log?: string; updateUrl?: string }
  bytes: number
  updatedAt: number
  lastError?: string
}

export interface UserSourceStatus extends UserSourceMeta {
  status: 'ready' | 'boot' | 'dead' | 'cold'
  /** 最近日志尾部（调试图） */
  logTail: string[]
}

export interface UserSourceProbe {
  source: string
  id: string
  type?: string
}

const MAX_SCRIPT_BYTES = 700 * 1024
const BOOT_TIMEOUT = 10_000
const INVOKE_TIMEOUT = 20_000

// ============================== 内部状态 ==============================
const dir = (): string => {
  const p = path.join(global.lx.dataPath, 'user-sources')
  try { fs.mkdirSync(p, { recursive: true }) } catch { /* ignore */ }
  return p
}
const metaFile = (): string => path.join(dir(), 'meta.json')
const scriptFile = (id: string): string => path.join(dir(), safeId(id) + '.js')

let metas: UserSourceMeta[] | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

function ensureLoaded(): void {
  if (metas) return
  const raw = readJson<{ list: UserSourceMeta[] }>(metaFile())
  metas = raw && Array.isArray(raw.list) ? raw.list : []
}

function persistMeta(): void {
  if (!metas) return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      const tmp = metaFile() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ list: metas }, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, metaFile())
      try { fs.chmodSync(metaFile(), 0o600) } catch { /* ignore */ }
    } catch (e) { console.error('[user-source] persist meta failed', e) }
  }, 300)
}

export const safeId = (id: string): string => (id || '').replace(/[^A-Za-z0-9_-]/g, '').substring(0, 40)
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,40}$/.test(id)

// ============================== Worker 运行器 ==============================
interface Pending { resolve: (r: { ok: boolean; data?: any; error?: string; ms?: number }) => void; timer: ReturnType<typeof setTimeout> }

class SourceRunner {
  readonly id: string
  private worker: Worker | null = null
  private script: string | null = null
  private seq = 0
  private booted = false
  private deadError: string | null = null
  private inited = false
  capabilities: Record<string, string[]> = {}
  private pending = new Map<string, Pending>()
  logTail: string[] = []
  lastAlert: { log?: string; updateUrl?: string } | undefined
  private bootWaiters: Array<(ok: boolean, err?: string) => void> = []

  constructor(meta: UserSourceMeta) {
    this.id = meta.id
    this.script = readScript(meta.id)
  }

  status(): 'ready' | 'boot' | 'dead' | 'cold' {
    if (!this.worker) return this.script ? 'cold' : 'dead'
    if (this.deadError) return 'dead'
    return this.booted ? (this.inited ? 'ready' : 'boot') : 'boot'
  }

  info(): UserSourceStatus {
    return { id: this.id, name: '', enabled: false, capabilities: { ...this.capabilities }, bytes: 0, updatedAt: 0, status: this.status(), logTail: this.logTail.slice(-8), lastAlert: this.lastAlert }
  }

  private spawn(): void {
    const sourceId = this.id
    const script = this.script
    if (!script) { this.deadError = 'script file missing'; return }
    const workerFile = path.join(__dirname, 'user-source-worker.js')
    const useTs = !fs.existsSync(workerFile) && fs.existsSync(path.join(__dirname, 'user-source-worker.ts'))
    this.deadError = null
    this.inited = false
    this.booted = false
    const w = useTs
      ? new Worker(path.join(__dirname, 'user-source-worker.ts'), { execArgv: process.execArgv })
      : new Worker(workerFile)
    this.worker = w
    w.on('message', (m: any) => this.onMsg(m, sourceId))
    w.on('error', (e: Error) => {
      this.deadError = String((e && (e as any).message) || e)
      this.logTail.push('worker error: ' + this.deadError)
      if (this.logTail.length > 40) this.logTail.shift()
      this.failAll(this.deadError)
      this.cleanupWorker()
    })
    w.on('exit', (code) => {
      if (!this.deadError && code !== 0) this.deadError = 'worker exited (' + code + ')'
      this.failAll(this.deadError || 'worker exited')
      this.cleanupWorker()
    })
    w.postMessage({ t: 'loadSource', script, sourceId })
  }

  private cleanupWorker(): void {
    this.worker = null
    this.booted = false
    for (const f of this.bootWaiters) f(false, this.deadError || 'worker closed')
    this.bootWaiters = []
  }

  private failAll(err: string): void {
    for (const [k, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: err })
      this.pending.delete(k)
    }
  }

  private onMsg(m: any, sourceId: string): void {
    if (!m || typeof m.t !== 'string') return
    switch (m.t) {
      case 'ready':
        // worker 启动完成（loadSource 尚未处理）；真正可服务见 scriptBooted
        break
      case 'scriptBooted':
        this.booted = true
        for (const f of this.bootWaiters) f(true)
        this.bootWaiters = []
        break
      case 'initedDone': {
        this.inited = true
        const caps: Record<string, string[]> = {}
        const srcs: Record<string, { actions?: string[]; qualitys?: string[]; type?: string }> = m.sources || {}
        for (const k of Object.keys(srcs)) {
          const a = srcs[k] && Array.isArray(srcs[k].actions) ? srcs[k].actions!.map(String) : []
          if (a.length) caps[k] = a
        }
        this.capabilities = caps
        this.logTail.push('inited: ' + JSON.stringify(caps))
        if (this.logTail.length > 40) this.logTail.shift()
        // 回报给管理者持久化（延迟合并写）
        updateCapabilities(sourceId, caps)
        break
      }
      case 'updateAlert':
        this.lastAlert = { log: m.log, updateUrl: m.updateUrl }
        this.logTail.push('updateAlert: ' + String(m.log || ''))
        if (this.logTail.length > 40) this.logTail.shift()
        updateCapabilities(sourceId, this.capabilities, this.lastAlert)
        break
      case 'log':
        this.logTail.push('[' + (m.level || 'log') + '] ' + String(m.msg || ''))
        if (this.logTail.length > 40) this.logTail.shift()
        break
      case 'sourceError':
        this.deadError = String(m.error || 'script error')
        this.logTail.push('sourceError: ' + this.deadError)
        if (this.logTail.length > 40) this.logTail.shift()
        // 脚本顶层抛错后无法再响应：终止重建等待下一次 invoke
        this.failAll(this.deadError)
        try { this.worker?.terminate() } catch { /* ignore */ }
        this.cleanupWorker()
        break
      case 'done': {
        const p = this.pending.get(m.requestKey)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(m.requestKey)
        p.resolve({ ok: !!m.ok, data: m.data, error: m.error, ms: m.ms })
        break
      }
      default:
        break
    }
  }

  ensureBoot(): Promise<string | null> {
    if (this.worker && this.booted) return Promise.resolve(null)
    if (this.worker && !this.booted) {
      return new Promise((resolve) => {
        const f = (ok: boolean, err?: string) => { clearTimeout(t); resolve(ok ? null : (err || 'boot failed')) }
        const t = setTimeout(() => { f(false, 'boot timeout') }, BOOT_TIMEOUT)
        this.bootWaiters.push(f)
      })
    }
    try {
      this.spawn()
    } catch (e) {
      this.deadError = String((e as Error).message || e)
      return Promise.resolve(this.deadError)
    }
    return new Promise((resolve) => {
      const f = (ok: boolean, err?: string) => { clearTimeout(t); resolve(ok ? null : (err || 'boot failed')) }
      const t = setTimeout(() => { f(false, 'boot timeout') }, BOOT_TIMEOUT)
      this.bootWaiters.push(f)
    })
  }

  async invoke(source: string, action: string, info: Record<string, any>, timeoutMs = INVOKE_TIMEOUT): Promise<{ ok: boolean; data?: any; error?: string; ms?: number }> {
    const bootErr = await this.ensureBoot()
    if (bootErr || !this.worker || !this.booted) return { ok: false, error: bootErr || 'worker unavailable' }
    const requestKey = (this.seq++).toString(36)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey)
        // 看门狗：单次调用超时 → 掐断并重建，防止脚本把 server 拖死
        this.logTail.push('invoke timeout, worker recycled')
        if (this.logTail.length > 40) this.logTail.shift()
        try { this.worker?.terminate() } catch { /* ignore */ }
        this.cleanupWorker()
        resolve({ ok: false, error: 'invoke timeout (' + timeoutMs + 'ms), worker recycled' })
      }, timeoutMs)
      this.pending.set(requestKey, { resolve, timer })
      this.worker!.postMessage({ t: 'invoke', requestKey, source, action, info })
    })
  }

  kill(): void {
    try { this.worker?.terminate() } catch { /* ignore */ }
    this.worker = null
    this.booted = false
    this.deadError = null
  }
}

// ============================== 脚本文件存取 ==============================
export const readScript = (id: string): string | null => {
  try { return fs.readFileSync(scriptFile(id), 'utf8') } catch { return null }
}

// ============================== 管理者操作 ==============================
export const listUserSources = (): UserSourceStatus[] => {
  ensureLoaded()
  return metas!.map((m) => {
    const live = runners.get(m.id)
    const status = live ? live.status() : 'cold'
    const tail = live ? live.logTail.slice(-8) : []
    const liveCaps = live && Object.keys(live.capabilities).length ? live.capabilities : undefined
    return {
      ...m,
      capabilities: liveCaps || m.capabilities || {},
      status,
      logTail: tail,
      lastAlert: m.lastAlert || (live && live.lastAlert) || undefined,
    }
  })
}

export const getUserSource = (id: string): UserSourceMeta | undefined => {
  ensureLoaded()
  return metas!.find((m) => m.id === id)
}

export const saveUserSource = (input: { id?: string; name: string; script: string; enabled?: boolean }): { meta: UserSourceMeta; error?: string } => {
  ensureLoaded()
  const name = String(input.name ?? '').trim().substring(0, 80)
  const script = String(input.script ?? '')
  if (!name) return { meta: null as any, error: '缺少名称' }
  if (!script.trim()) return { meta: null as any, error: '脚本内容为空' }
  const bytes = Buffer.byteLength(script)
  if (bytes > MAX_SCRIPT_BYTES) return { meta: null as any, error: '脚本过大（>' + MAX_SCRIPT_BYTES + 'B）' }
  let id = safeId(input.id || '')
  if (!id) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').substring(0, 24) || 'src'
    id = base
    const used = new Set(metas!.map((m) => m.id))
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
  }
  if (!isSafeId(id)) return { meta: null as any, error: 'id 非法' }
  try {
    const file = scriptFile(id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, script, { mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch { /* ignore */ }
  } catch (e) {
    return { meta: null as any, error: '写入脚本失败: ' + String((e as Error).message || e) }
  }
  const idx = metas!.findIndex((m) => m.id === id)
  const meta: UserSourceMeta = {
    id,
    name,
    enabled: idx >= 0 ? (input.enabled !== undefined ? !!input.enabled : metas![idx].enabled) : input.enabled !== undefined ? !!input.enabled : true,
    capabilities: idx >= 0 ? metas![idx].capabilities : {},
    bytes,
    updatedAt: Date.now(),
  }
  if (idx >= 0) metas![idx] = meta
  else metas!.push(meta)
  // 脚本变更 → 回收旧 worker，下次按需以新脚本重建
  const old = runners.get(id)
  if (old) { old.kill(); runners.delete(id) }
  const tmpOld = tempRunners.get(id)
  if (tmpOld) { tmpOld.kill(); tempRunners.delete(id) }
  persistMeta()
  return { meta }
}

export const deleteUserSource = (id: string): boolean => {
  ensureLoaded()
  const idx = metas!.findIndex((m) => m.id === id)
  if (idx < 0) return false
  getRunner(id)?.kill()
  dropRunner(id)
  metas!.splice(idx, 1)
  persistMeta()
  try { fs.unlinkSync(scriptFile(id)) } catch { /* ignore */ }
  return true
}

export const setUserSourceEnabled = async (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; capabilities?: Record<string, string[]> }> => {
  ensureLoaded()
  const m = metas!.find((x) => x.id === id)
  if (!m) return { ok: false, error: '源不存在' }
  m.enabled = !!enabled
  persistMeta()
  if (!enabled) {
    getRunner(id)?.kill()
    dropRunner(id)
    return { ok: true, capabilities: m.capabilities }
  }
  const script = readScript(id)
  if (!script) return { ok: false, error: '脚本文件缺失' }
  const r = getRunner(id)
  const bootErr = await r.ensureBoot()
  if (bootErr) return { ok: false, error: bootErr }
  return { ok: true, capabilities: r.capabilities }
}

// 测试：可以是已保存的 id（默认探针），或一次性 name+script（临时起 worker）
export const testUserSource = async (input: { id?: string; name?: string; script?: string; probe?: UserSourceProbe }): Promise<{
  ok: boolean
  error?: string
  capabilities?: Record<string, string[]>
  url?: string
  ms?: number
}> => {
  const probe = input.probe || { source: '', id: '' }
  const source = String(probe.source || '').substring(0, 16)
  const pid = String(probe.id || '').substring(0, 128)
  const type = String(probe.type || '128k').substring(0, 16)
  if (!source || !pid) return { ok: false, error: '测活需提供 source 与歌曲 id' }

  let r: SourceRunner
  let tempMeta: UserSourceMeta | null = null
  if (input.id) {
    ensureLoaded()
    const m = metas!.find((x) => x.id === safeId(input.id!))
    if (!m) return { ok: false, error: '源不存在' }
    r = getRunner(m.id)
    if (!readScript(m.id)) return { ok: false, error: '脚本文件缺失' }
  } else {
    // 未保存草稿：临时 worker，测完即弃
    tempMeta = {
      id: '__test_' + crypto.randomBytes(4).toString('hex'),
      name: input.name || 'test',
      enabled: false,
      capabilities: {},
      bytes: Buffer.byteLength(input.script || ''),
      updatedAt: Date.now(),
    }
    const saved = saveToRunnerScript(tempMeta.id, input.script || '')
    if (!saved) return { ok: false, error: '脚本写入失败' }
    r = new SourceRunner({ ...tempMeta, bytes: saved })
    tempRunners.set(tempMeta.id, r)
  }

  const bootErr = await r.ensureBoot()
  if (bootErr) {
    if (tempMeta) cleanupTemp(tempMeta.id)
    return { ok: false, error: '脚本启动失败: ' + bootErr }
  }
  // 等待 inited（脚本主动回报能力；有中央服务器依赖的脚本可能更久，测活给宽限）
  await waitInited(r, 8000)
  const info = { type, musicInfo: buildMusicInfo(source, pid, {}) }
  const res = await r.invoke(source, 'musicUrl', info)
  const caps = r.capabilities
  if (tempMeta) cleanupTemp(tempMeta.id)
  if (res.ok) return { ok: true, url: res.data, ms: res.ms, capabilities: caps }
  return { ok: false, error: res.error || '调用失败', ms: res.ms, capabilities: caps }
}

function waitInited(r: SourceRunner, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (r.capabilities && Object.keys(r.capabilities).length) { clearInterval(iv); resolve(); return }
      if (Date.now() - t0 > ms) { clearInterval(iv); resolve(); return }
    }, 200)
  })
}

// 临时测试 runner 的脚本落盘（不入 meta.json）
const tempRunners = new Map<string, SourceRunner>()
function saveToRunnerScript(id: string, script: string): number | null {
  try {
    const tmp = scriptFile(id)
    const t = tmp + '.tmp'
    fs.writeFileSync(t, script, { mode: 0o600 })
    fs.renameSync(t, tmp)
    return Buffer.byteLength(script)
  } catch { return null }
}
function cleanupTemp(id: string): void {
  try { fs.unlinkSync(scriptFile(id)) } catch { /* ignore */ }
  const r = tempRunners.get(id)
  if (r) { r.kill(); tempRunners.delete(id) }
}

function updateCapabilities(id: string, caps: Record<string, string[]>, lastAlert?: { log?: string; updateUrl?: string }): void {
  if (!metas) return
  const m = metas.find((x) => x.id === id)
  if (!m) return
  if (caps && Object.keys(caps).length) m.capabilities = caps
  if (lastAlert) m.lastAlert = lastAlert
  persistMeta()
}

// ============================== 解析链（供 online/代理使用） ==============================
const runners = new Map<string, SourceRunner>()
const getRunner = (id: string): SourceRunner => {
  let r = runners.get(id)
  if (!r) {
    const m = getUserSource(id)
    if (!m) return new SourceRunner({ id, name: id, enabled: false, capabilities: {}, bytes: 0, updatedAt: 0 })
    r = new SourceRunner(m)
    runners.set(id, r)
  }
  return r
}
const dropRunner = (id: string): void => {
  runners.delete(id)
}

export interface ResolveAttempt { url: string; via: string; ms: number }

/** 依序尝试启用的第三方源。返回 null 表示没有可尝试的源。 */
export const resolveFromUserSources = async (source: string, id: string, quality = '128k', extra?: Record<string, any>): Promise<ResolveAttempt | null> => {
  ensureLoaded()
  if (!metas || !metas.length) return null
  const enabled = metas.filter((m) => m.enabled)
  if (!enabled.length) return null
  const s = String(source).substring(0, 16)
  const pid = String(id).substring(0, 128)
  // 总预算 15s、最多试 4 个脚本：优先第三方但绝不让播放链路被拖死
  const deadline = Date.now() + 15_000
  let tried = 0
  for (const m of enabled) {
    if (tried >= 4) break
    const caps = m.capabilities
    if (caps && Object.keys(caps).length && !(caps[s] || []).includes('musicUrl')) continue
    const script = readScript(m.id)
    if (!script) continue
    const budget = deadline - Date.now()
    if (budget < 2000) break
    tried++
    try {
      const r = getRunner(m.id)
      const info = { type: quality, musicInfo: buildMusicInfo(s, pid, extra) }
      const res = await r.invoke(s, 'musicUrl', info, Math.min(INVOKE_TIMEOUT, budget))
      if (res.ok && typeof res.data === 'string' && /^https?:\/\//i.test(res.data)) {
        return { url: res.data, via: m.id, ms: res.ms || 0 }
      }
    } catch {
      // 继续下一个源
    }
  }
  return null
}

/** 构造脚本期望的 musicInfo：脚本普遍读 hash/songmid/songId；尽量多给已知字段 */
export function buildMusicInfo(source: string, id: string, extra?: Record<string, any>): Record<string, any> {
  const e = extra && typeof extra === 'object' ? extra : {}
  const hash = typeof e.hash === 'string' && e.hash ? String(e.hash) : id
  const songmid = typeof e.songmid === 'string' && e.songmid ? String(e.songmid) : id
  const albumId = typeof e.albumId === 'string' ? String(e.albumId) : undefined
  return {
    source,
    id,
    hash,
    songmid,
    songId: id,
    rid: id,
    albumId,
    name: typeof e.name === 'string' ? e.name : '',
    singer: typeof e.singer === 'string' ? e.singer : '',
    album: typeof e.album === 'string' ? e.album : '',
    interval: typeof e.interval === 'number' ? e.interval : 0,
    pic: typeof e.pic === 'string' ? e.pic : '',
    meta: { songId: id, albumName: typeof e.album === 'string' ? e.album : undefined, picUrl: typeof e.pic === 'string' ? e.pic : undefined },
  }
}

/** 应用退出清理 */
export const shutdownUserSources = (): void => {
  for (const r of runners.values()) r.kill()
  for (const r of tempRunners.values()) r.kill()
  runners.clear()
  tempRunners.clear()
}
