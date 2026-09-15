// ---------------------------------------------------------------------------
// 音乐分享（对外链接）
//   - 数据文件：dataPath/shares.json（原子写：tmp + fsync + rename）
//   - 曲目是「快照」：创建时把解析后的租户曲目 id 固化下来，之后歌单改动不影响
//     已发出的链接；曲目被删/改名（id 变化）时该条在分享页显示为不可播放
//   - 提取码：可选的 4-16 位，scrypt 加盐哈希（与账号密码同一套）
//   - 有效期：expiresAt = 0 表示永久；过期后页面直接 410，记录仍可见（后台/我的分享）
//   - 撤销 = 删除记录（历史留痕在 audit 日志里）
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hashPassword, verifyPassword } from '@/user/register'

export type ShareType = 'track' | 'playlist' | 'album' | 'artist'

export interface ShareRecord {
  code: string
  /** 分享者（App 登录名），决定曲目来自哪个租户曲库 */
  owner: string
  type: ShareType
  title: string
  subtitle: string
  /** 曲目 id 快照（租户内 id，不含 local_ 前缀） */
  ids: string[]
  /** 有封面的曲目 id（列表封面用，避免逐个探测） */
  coverId: string
  createdAt: number
  /** 0 = 永久有效 */
  expiresAt: number
  passHash: string
  passSalt: string
  allowDownload: boolean
  visits: number
  lastVisitAt: number
}

interface SharesFile {
  version: 1
  shares: ShareRecord[]
}

const FILE = () => path.join(global.lx.dataPath, 'shares.json')

// 短码字母表：去掉 0/O/1/l/I 这类易混字符，10 位 ≈ 50bit 熵，不可枚举
const CODE_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789'

export const newCode = (): string => {
  const bytes = crypto.randomBytes(12)
  let out = ''
  for (let i = 0; i < 10; i++) out += CODE_ALPHA[bytes[i] % CODE_ALPHA.length]
  return out
}

const empty = (): SharesFile => ({ version: 1, shares: [] })

let cache: SharesFile | null = null
let cacheMtime = -1

const readAll = (): SharesFile => {
  let mtime = -1
  try {
    mtime = fs.statSync(FILE()).mtimeMs
  } catch {
    mtime = -1
  }
  // 命中缓存：同一进程内改过（写入时更新），或文件未变
  if (cache && cacheMtime === mtime) return cache
  if (mtime < 0) {
    cache = cache ? cache : empty()
    cacheMtime = -1
    return cache
  }
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    const shares = Array.isArray(j?.shares) ? j.shares.filter((s: any) => s && typeof s.code == 'string') : []
    cache = { version: 1, shares }
  } catch {
    cache = cache ?? empty()
  }
  cacheMtime = mtime
  return cache
}

const writeAll = (data: SharesFile): void => {
  const file = FILE()
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  cache = data
  try { cacheMtime = fs.statSync(file).mtimeMs } catch { cacheMtime = -1 }
}

export const isExpired = (s: ShareRecord, now = Date.now()): boolean => !!s.expiresAt && s.expiresAt <= now

export const hasPassword = (s: ShareRecord): boolean => !!s.passHash

export const listShares = (): ShareRecord[] => readAll().shares

export const listSharesByOwner = (owner: string): ShareRecord[] =>
  readAll().shares.filter(s => s.owner === owner)

export const getShare = (code: string): ShareRecord | undefined =>
  readAll().shares.find(s => s.code === code)

export interface CreateShareInput {
  owner: string
  type: ShareType
  title: string
  subtitle?: string
  ids: string[]
  coverId?: string
  /** 有效天数：0 = 永久 */
  days: number
  password?: string
  allowDownload: boolean
}

export const createShare = async(input: CreateShareInput): Promise<ShareRecord> => {
  const data = readAll()
  let code = newCode()
  const used = new Set(data.shares.map(s => s.code))
  while (used.has(code)) code = newCode()
  const now = Date.now()
  const password = (input.password ?? '').trim()
  const passSalt = password ? crypto.randomBytes(16).toString('hex') : ''
  const rec: ShareRecord = {
    code,
    owner: input.owner,
    type: input.type,
    title: input.title.substring(0, 120),
    subtitle: (input.subtitle ?? '').substring(0, 120),
    ids: input.ids,
    coverId: input.coverId ?? '',
    createdAt: now,
    expiresAt: input.days > 0 ? now + input.days * 24 * 60 * 60 * 1000 : 0,
    passHash: password ? await hashPassword(password, passSalt) : '',
    passSalt,
    allowDownload: input.allowDownload !== false,
    visits: 0,
    lastVisitAt: 0,
  }
  data.shares.unshift(rec)
  writeAll(data)
  return rec
}

export interface UpdateShareInput {
  days?: number
  allowDownload?: boolean
  /** 设置新提取码（空串表示去除提取码，用 clearPassword 更明确） */
  password?: string
  clearPassword?: boolean
}

export const updateShare = async(code: string, patch: UpdateShareInput): Promise<ShareRecord | null> => {
  const data = readAll()
  const rec = data.shares.find(s => s.code === code)
  if (!rec) return null
  if (typeof patch.days == 'number' && patch.days >= 0) {
    rec.expiresAt = patch.days > 0 ? Date.now() + patch.days * 24 * 60 * 60 * 1000 : 0
  }
  if (typeof patch.allowDownload == 'boolean') rec.allowDownload = patch.allowDownload
  if (patch.clearPassword) {
    rec.passHash = ''
    rec.passSalt = ''
  } else if (typeof patch.password == 'string' && patch.password.trim()) {
    const pwd = patch.password.trim()
    const salt = crypto.randomBytes(16).toString('hex')
    rec.passHash = await hashPassword(pwd, salt)
    rec.passSalt = salt
  }
  writeAll(data)
  return rec
}

/** 撤销（删除记录）；返回被删的条数 */
export const removeShares = (codes: string[], owner?: string): ShareRecord[] => {
  const data = readAll()
  const want = new Set(codes)
  const gone: ShareRecord[] = []
  const keep = data.shares.filter(s => {
    if (!want.has(s.code)) return true
    if (owner && s.owner !== owner) return true
    gone.push(s)
    return false
  })
  if (gone.length) {
    data.shares = keep
    writeAll(data)
  }
  return gone
}

/** 访问计数（首次 + 每 10 分钟记一次，避免列表页刷新把计数刷爆） */
const TOUCH_WINDOW = 10 * 60 * 1000
export const touchShare = (code: string): void => {
  const data = readAll()
  const rec = data.shares.find(s => s.code === code)
  if (!rec) return
  const now = Date.now()
  if (now - rec.lastVisitAt < TOUCH_WINDOW) return
  rec.visits = (rec.visits || 0) + 1
  rec.lastVisitAt = now
  try { writeAll(data) } catch { /* 计数失败不影响播放 */ }
}

export const checkPassword = async(s: ShareRecord, password: string): Promise<boolean> => {
  if (!s.passHash) return true
  if (!password) return false
  return verifyPassword(password, s.passSalt, s.passHash)
}

// ---------------------------------------------------------------------------
// 访问限流（内存态）：分享页/API 被爬或提取码爆破时兜底
// ---------------------------------------------------------------------------
const HIT_LIMIT = 120
const HIT_WINDOW = 60 * 1000
const PWD_LIMIT = 8
const PWD_WINDOW = 10 * 60 * 1000

const hits = new Map<string, { count: number, first: number }>()
const pwds = new Map<string, { count: number, first: number }>()

const bump = (map: Map<string, { count: number, first: number }>, key: string, window: number): number => {
  const rec = map.get(key)
  const now = Date.now()
  if (!rec || now - rec.first > window) {
    map.set(key, { count: 1, first: now })
    return 1
  }
  rec.count++
  return rec.count
}

export const hitBlocked = (ip: string): boolean => {
  const rec = hits.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > HIT_WINDOW) { hits.delete(ip); return false }
  return rec.count > HIT_LIMIT
}
export const hitShare = (ip: string): void => { bump(hits, ip, HIT_WINDOW) }

export const pwdBlocked = (key: string): boolean => {
  const rec = pwds.get(key)
  if (!rec) return false
  if (Date.now() - rec.first > PWD_WINDOW) { pwds.delete(key); return false }
  return rec.count >= PWD_LIMIT
}
export const pwdFail = (key: string): void => { bump(pwds, key, PWD_WINDOW) }
export const pwdReset = (key: string): void => { pwds.delete(key) }

const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, r] of hits) if (now - r.first > HIT_WINDOW) hits.delete(k)
  for (const [k, r] of pwds) if (now - r.first > PWD_WINDOW) pwds.delete(k)
}, 5 * 60 * 1000)
sweeper.unref?.()
