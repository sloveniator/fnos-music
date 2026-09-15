// ---------------------------------------------------------------------------
// 公开源仓库（洛雪生态第三方 JS 音源）—— 批量抓取 / 版本比较 / 入库升级
//   洛雪社区的音源普遍集中在几个公开仓库里（内置 pdone/lx-music-source，8.7k star），
//   每个子目录一个音源，目录里放 <版本>.js 与 latest.js。本模块把这些目录变成
//   「可批量拉取、可比较版本、可一键入库/升级」的清单：
//     - 列目录：jsDelivr data API / GitHub API tree（按可达性回退）
//     - 取脚本：jsDelivr CDN → gcore CDN → ghproxy → raw.githubusercontent
//     - 比版本：脚本头 @version 归一化后比大小；版本相同再比字节数（内容有变）
//     - applyRemoteSources：下载 → saveUserSource，升级保留既有启用态
//   结果带 10 分钟内存缓存 + 落盘快照，源仓库全挂时后台仍能看到上次结果。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { listUserSources, getUserSource, saveUserSource, parseScriptMeta, isSafeId } from '@/online/user-source'

// ============================== 仓库清单 ==============================
export interface RegistryRepo {
  /** 站内短 id，用于前端增删/标识 */
  id: string
  /** 展示名 */
  name: string
  /** GitHub owner/repo */
  repo: string
  /** 分支（默认 main） */
  branch: string
  /** true = 内置不可删 */
  builtin?: boolean
}

export const BUILTIN_REGISTRIES: RegistryRepo[] = [
  { id: 'pdone', name: '洛雪音源合集（pdone）', repo: 'pdone/lx-music-source', branch: 'main', builtin: true },
]

const registriesFile = (): string => path.join(global.lx.dataPath, 'source-registries.json')

/** 自定义仓库（后台追加）落盘；内置仓库永远在最前 */
export const loadRegistries = (): RegistryRepo[] => {
  let custom: RegistryRepo[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(registriesFile(), 'utf8'))
    if (Array.isArray(raw?.list)) custom = raw.list
  } catch { /* 没有就用内置 */ }
  const builtinIds = new Set(BUILTIN_REGISTRIES.map((r) => r.id))
  const valid = custom.filter((r) => r && typeof r.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r.repo) && !builtinIds.has(r.id))
  return [...BUILTIN_REGISTRIES, ...valid]
}

const saveRegistries = (list: RegistryRepo[]): void => {
  const custom = list.filter((r) => !r.builtin && !BUILTIN_REGISTRIES.some((b) => b.id === r.id))
  try {
    const tmp = registriesFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ list: custom }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, registriesFile())
  } catch (e) { console.error('[registry] save failed', e) }
}

export const addRegistry = (input: { repo: string; name?: string; branch?: string }): { ok: boolean; error?: string; registry?: RegistryRepo } => {
  let repo = String(input.repo || '').trim()
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#].*)?$/i.exec(repo)
  if (m) repo = m[1]
  repo = repo.replace(/^\/+|\/+$/g, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: '请填 owner/repo 或 GitHub 仓库地址' }
  const list = loadRegistries()
  if (list.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return { ok: false, error: '该仓库已在列表中' }
  const id = repo.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 24) || 'repo'
  let uid = id
  let n = 2
  const used = new Set(list.map((r) => r.id))
  while (used.has(uid)) uid = `${id}-${n++}`
  const reg: RegistryRepo = { id: uid, name: String(input.name || '').trim().substring(0, 60) || repo, repo, branch: String(input.branch || 'main').trim().substring(0, 40) || 'main' }
  saveRegistries([...list, reg])
  return { ok: true, registry: reg }
}

export const removeRegistry = (id: string): boolean => {
  const list = loadRegistries()
  const hit = list.find((r) => r.id === id)
  if (!hit || hit.builtin) return false
  saveRegistries(list.filter((r) => r.id !== id))
  return true
}

// ============================== 工具 ==============================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FETCH_MAX = 2 * 1024 * 1024

const httpGet = async (url: string, timeoutMs = 20000): Promise<{ status: number; text: string; bytes: number }> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*' } })
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > FETCH_MAX) throw new Error('内容过大（>2MB）')
    return { status: resp.status, text: buf.toString('utf8'), bytes: buf.length }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按镜像候选逐个下载脚本。
 * expectBytes 来自 GitHub 树（权威 size）：CDN 缓存可能停在旧 commit，
 * 长度不符就换下一个镜像，避免把过期脚本当新版入库。
 */
const downloadScript = async (reg: RegistryRepo, filePath: string, expectBytes?: number): Promise<{ script: string; url: string }> => {
  const errs: string[] = []
  for (const u of scriptUrlCandidates(reg, filePath)) {
    try {
      const r = await httpGet(u)
      if (r.status !== 200) throw new Error('HTTP ' + r.status)
      if (/^\s*(<!doctype|<html[\s>])/i.test(r.text.slice(0, 200))) throw new Error('返回网页而非脚本')
      if (!r.text.trim()) throw new Error('内容为空')
      if (expectBytes && r.bytes !== expectBytes) throw new Error(`镜像内容过期（${r.bytes}B ≠ 仓库 ${expectBytes}B）`)
      return { script: r.text, url: u }
    } catch (e: any) { errs.push((e?.message || String(e))) }
  }
  throw new Error('下载失败：' + errs.join(' / '))
}

/** 版本归一：从 "v9.3 93特供版" / "v1.2.1" 这类文案里取出可比较的数字串 */
export const normalizeVersion = (v?: string): string => {
  const m = /(\d+(?:\.\d+)*)/.exec(String(v || ''))
  return m ? m[1] : ''
}

const byteLen = (s: string): number => Buffer.byteLength(s)

/** 并发上限跑任务（抓 10 个脚本串行太慢，但也不能不限流去打 CDN） */
const mapLimit = async <T, R>(items: T[], limit: number, fn: (it: T, idx: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

const versionParts = (v: string): number[] => normalizeVersion(v).split('.').filter((x) => x !== '').map((x) => Number(x))

/** a > b → 1，a < b → -1，相等 → 0；无法解析的按 0 处理 */
export const compareVersion = (a?: string, b?: string): number => {
  const x = versionParts(a || '')
  const y = versionParts(b || '')
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) {
    const xi = x[i] || 0
    const yi = y[i] || 0
    if (xi > yi) return 1
    if (xi < yi) return -1
  }
  return 0
}

/** 仓库内脚本下载地址候选：CDN 优先（国内可达性最好），raw 垫底 */
export const scriptUrlCandidates = (reg: RegistryRepo, filePath: string): string[] => {
  const p = filePath.startsWith('/') ? filePath : '/' + filePath
  return [
    `https://cdn.jsdelivr.net/gh/${reg.repo}@${reg.branch}${p}`,
    `https://gcore.jsdelivr.net/gh/${reg.repo}@${reg.branch}${p}`,
    `https://ghproxy.net/https://raw.githubusercontent.com/${reg.repo}/${reg.branch}${p}`,
    `https://raw.githubusercontent.com/${reg.repo}/${reg.branch}${p}`,
  ]
}

// ============================== 列目录 ==============================
interface RepoFile { path: string; size: number }

const listFromJsdelivr = async (reg: RegistryRepo): Promise<RepoFile[]> => {
  const r = await httpGet(`https://data.jsdelivr.com/v1/packages/gh/${reg.repo}@${reg.branch}?structure=flat`, 20000)
  if (r.status !== 200) throw new Error('jsDelivr 列表 HTTP ' + r.status)
  const j = JSON.parse(r.text)
  const files: RepoFile[] = (j?.files || []).filter((f: any) => typeof f?.name === 'string').map((f: any) => ({ path: String(f.name).replace(/^\//, ''), size: Number(f.size) || 0 }))
  if (!files.length) throw new Error('jsDelivr 列表为空')
  return files
}

const listFromGithub = async (reg: RegistryRepo): Promise<RepoFile[]> => {
  const r = await httpGet(`https://api.github.com/repos/${reg.repo}/git/trees/${reg.branch}?recursive=1`, 20000)
  if (r.status !== 200) throw new Error('GitHub API HTTP ' + r.status + (r.status === 403 ? '（匿名额度已用完，稍后再试）' : ''))
  const j = JSON.parse(r.text)
  const files: RepoFile[] = (j?.tree || []).filter((t: any) => t?.type === 'blob').map((t: any) => ({ path: String(t.path), size: Number(t.size) || 0 }))
  if (!files.length) throw new Error('GitHub 树为空')
  return files
}

export const listRepoFiles = async (reg: RegistryRepo): Promise<RepoFile[]> => {
  // GitHub API 是权威源（含精确 size）；jsDelivr 的 data API 有时停留在旧 commit
  // （实测 pdone 仓库少 qdy/changqing/huanyin，lx 只到 4.js），只能当兜底。
  const errs: string[] = []
  for (const fn of [listFromGithub, listFromJsdelivr]) {
    try { return await fn(reg) } catch (e: any) { errs.push(e?.message || String(e)) }
  }
  throw new Error('列目录失败：' + errs.join(' / '))
}

// ============================== 挑最新脚本 ==============================
/** 目录里可见版本文件：数字版本名或 latest.js */
const versionFromFilename = (name: string): string => {
  const base = name.replace(/\.js$/i, '')
  if (/^latest$/i.test(base)) return ''
  return normalizeVersion(base)
}

interface Pick { path: string; size: number; versionFromName: string }

const pickLatestFile = (files: RepoFile[], dir: string): Pick | null => {
  const inDir = files.filter((f) => f.path.startsWith(dir + '/') && /\.js$/i.test(f.path) && !f.path.slice(dir.length + 1).includes('/'))
  if (!inDir.length) return null
  const named = inDir.filter((f) => !/\/[^/]*\.min\.js$/i.test(f.path))
  const pool = named.length ? named : inDir
  const scored = pool.map((f) => ({ path: f.path, size: f.size, versionFromName: versionFromFilename(f.path.slice(dir.length + 1)) }))
  const latest = scored.find((s) => /\/latest\.js$/i.test(s.path))
  const versioned = scored.filter((s) => s.versionFromName)
  const best = versioned.sort((a, b) => compareVersion(b.versionFromName, a.versionFromName))[0]
  if (latest && best && compareVersion(best.versionFromName, latest.versionFromName) > 0) {
    // latest.js 落后于同目录的版本文件：以版本文件为准（仓库维护脚本偶尔漏跑）
    return best
  }
  return latest || best || scored[0]
}

// ============================== 抓取清单 ==============================
export type RemoteState = 'new' | 'upgrade' | 'same' | 'changed' | 'older'

export interface RemoteSource {
  /** 入库时使用的 id（仓库目录名） */
  key: string
  name: string
  registry: string
  registryName: string
  repo: string
  path: string
  url: string
  version: string
  versionRaw: string
  description?: string
  author?: string
  bytes: number
  state: RemoteState
  /** 本地已装版本（未装为 null） */
  installed: { id: string; name: string; version?: string; bytes: number; enabled: boolean; origin?: string } | null
}

interface CacheShape {
  fetchedAt: number
  list: RemoteSource[]
  registries: { id: string; name: string; repo: string; ok: boolean; error?: string; count: number }[]
}

let cache: CacheShape | null = null
const CACHE_TTL = 10 * 60 * 1000

const cacheFile = (): string => path.join(global.lx.dataPath, 'user-sources', 'registry-cache.json')

const loadCache = (): CacheShape | null => {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (raw && Array.isArray(raw.list)) cache = raw
  } catch { /* ignore */ }
  return cache
}

const persistCache = (c: CacheShape): void => {
  try {
    const f = cacheFile()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 })
    fs.renameSync(tmp, f)
  } catch (e) { console.error('[registry] cache write failed', e) }
}

const localIndex = (): { byId: Map<string, any>; byName: Map<string, any> } => {
  const byId = new Map<string, any>()
  const byName = new Map<string, any>()
  for (const s of listUserSources()) {
    byId.set(s.id, s)
    if (s.name) byName.set(String(s.name).trim().toLowerCase(), s)
  }
  return { byId, byName }
}

const stateOf = (remote: { version: string; bytes: number }, local: any): RemoteState => {
  if (!local) return 'new'
  const cmp = compareVersion(remote.version, local.version)
  if (cmp > 0) return 'upgrade'
  if (cmp < 0) return 'older'
  return remote.bytes === local.bytes ? 'same' : 'changed'
}

/**
 * 抓取所有仓库的可用音源清单。
 * refresh=false 且缓存未过期时直接回缓存（后台点一次刷新不该反复打仓库）。
 */
export const listRemoteSources = async (opts: { refresh?: boolean } = {}): Promise<CacheShape & { cached: boolean }> => {
  const prev = loadCache()
  if (prev && !opts.refresh && Date.now() - prev.fetchedAt < CACHE_TTL) {
    // 缓存里存的是远端清单，本地安装/启用状态随时会变（网盘上传、删除、直接覆盖脚本）。
    // 回缓存前先按当前本地状态重算，否则刚入库/删掉的源在后台还显示旧状态，要等 TTL 过期。
    repatchCacheLocalState()
    return { ...prev, cached: true }
  }

  const registries = loadRegistries()
  const out: RemoteSource[] = []
  const seen = new Set<string>()
  const stats: CacheShape['registries'] = []
  const { byId, byName } = localIndex()

  for (const reg of registries) {
    let files: RepoFile[] = []
    try {
      files = await listRepoFiles(reg)
    } catch (e: any) {
      stats.push({ id: reg.id, name: reg.name, repo: reg.repo, ok: false, error: e?.message || String(e), count: 0 })
      continue
    }
    const dirs = Array.from(new Set(files.filter((f) => f.path.includes('/')).map((f) => f.path.split('/')[0])))
      .filter((d) => isSafeId(d) && !seen.has(d))
      .sort()
    const tasks = dirs.map((dir) => ({ dir, pick: pickLatestFile(files, dir) })).filter((t) => !!t.pick) as { dir: string; pick: Pick }[]
    const fetched = await mapLimit(tasks, 3, async ({ dir, pick }): Promise<RemoteSource | null> => {
      let script = ''
      let usedUrl = ''
      try {
        const got = await downloadScript(reg, pick.path, pick.size || undefined)
        script = got.script
        usedUrl = got.url
      } catch { return null }
      const info = parseScriptMeta(script)
      const versionRaw = info.version || (pick.versionFromName ? '文件名 ' + pick.versionFromName : '')
      const version = normalizeVersion(versionRaw)
      const local = byId.get(dir) || byName.get(String(info.name || '').trim().toLowerCase()) || null
      const item: RemoteSource = {
        key: dir,
        name: info.name || dir,
        registry: reg.id,
        registryName: reg.name,
        repo: reg.repo,
        path: pick.path,
        url: usedUrl || scriptUrlCandidates(reg, pick.path)[0],
        version,
        versionRaw: versionRaw || '未标注',
        bytes: byteLen(script),
        state: 'new',
        installed: local
          ? { id: local.id, name: local.name, version: local.version, bytes: local.bytes, enabled: !!local.enabled, origin: local.origin }
          : null,
      }
      if (info.description) item.description = info.description
      if (info.author) item.author = info.author
      item.state = stateOf(item, local)
      return item
    })
    for (const item of fetched) {
      if (!item) continue
      out.push(item)
      seen.add(item.key)
    }
    stats.push({ id: reg.id, name: reg.name, repo: reg.repo, ok: true, count: fetched.filter(Boolean).length })
  }

  // 仓库全挂 + 有旧快照 → 用旧快照兜底，别让后台变空白
  if (!out.length && prev && prev.list.length) {
    return { ...prev, cached: true, registries: stats.length ? stats : prev.registries }
  }
  const fresh: CacheShape = { fetchedAt: Date.now(), list: out.sort((a, b) => a.key.localeCompare(b.key)), registries: stats }
  cache = fresh
  persistCache(fresh)
  return { ...fresh, cached: false }
}


// ============================== 下载 / 入库 ==============================
export interface ApplyResult {
  key: string
  action: 'install' | 'upgrade' | 'skip' | 'fail'
  name?: string
  version?: string
  error?: string
}


/**
 * 本地状态一变（入库 / 升级 / 删除 / 覆盖脚本），缓存里的 installed/state 就过期了。
 * 这里就地重算（纯本地，不联网）：apply 结束时调一次，命中缓存返回前也调一次，
 * 保证后台列表永远反映当前的本地实况。
 */
const repatchCacheLocalState = (): void => {
  const c = loadCache()
  if (!c) return
  const { byId, byName } = localIndex()
  let changed = false
  for (const item of c.list) {
    const local = byId.get(item.key) || byName.get(String(item.name || '').trim().toLowerCase()) || null
    const installed = local
      ? { id: local.id, name: local.name, version: local.version, bytes: local.bytes, enabled: !!local.enabled, origin: local.origin }
      : null
    const state = stateOf(item, local)
    if (JSON.stringify(installed) !== JSON.stringify(item.installed) || state !== item.state) {
      item.installed = installed
      item.state = state
      changed = true
    }
  }
  if (changed) persistCache(c)
}

/**
 * 批量入库 / 升级。key 为仓库目录名（与本地 id 对齐，升级即原地覆盖）。
 * enable 只对「新装」生效：升级永远保留用户当前的启用状态。
 */
export const applyRemoteSources = async (keys: string[], opts: { enable?: boolean; refresh?: boolean } = {}): Promise<ApplyResult[]> => {
  const want = keys.map((k) => String(k || '').trim()).filter((k) => isSafeId(k)).slice(0, 40)
  const { list } = await listRemoteSources({ refresh: !!opts.refresh })
  const byKey = new Map(list.map((s) => [s.key, s]))
  const results: ApplyResult[] = []
  const regs = new Map(loadRegistries().map((r) => [r.id, r]))
  for (const key of want) {
    const item = byKey.get(key)
    if (!item) { results.push({ key, action: 'fail', error: '清单里没有这个源，请先刷新列表' }); continue }
    const reg = regs.get(item.registry)
    if (!reg) { results.push({ key, action: 'fail', error: '来源仓库已移除' }); continue }
    try {
      const { script } = await downloadScript(reg, item.path, item.bytes)
      const existing = getUserSource(key)
      if (existing && existing.bytes === byteLen(script) && compareVersion(item.version, existing.version) <= 0) {
        results.push({ key, action: 'skip', name: existing.name, version: existing.version })
        continue
      }
      const info = parseScriptMeta(script)
      const saved = saveUserSource({
        id: key,
        name: existing?.name || info.name || item.name || key,
        script,
        enabled: existing ? existing.enabled : !!opts.enable,
        origin: `${item.repo}/${key}`,
      })
      if (saved.error) { results.push({ key, action: 'fail', error: saved.error }); continue }
      results.push({ key, action: existing ? 'upgrade' : 'install', name: saved.meta.name, version: saved.meta.version || item.version })
    } catch (e: any) {
      results.push({ key, action: 'fail', error: e?.message || String(e) })
    }
  }
  repatchCacheLocalState()
  return results
}

/** 供前端/测试引用：单个源的首选下载地址 */
export const remoteSourceUrl = (item: { repo: string; path: string }): string => {
  const reg = loadRegistries().find((r) => r.repo === item.repo)
  return scriptUrlCandidates(reg || { id: 'x', name: 'x', repo: item.repo, branch: 'main' }, item.path)[0]
}
