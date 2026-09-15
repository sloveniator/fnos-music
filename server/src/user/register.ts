// ---------------------------------------------------------------------------
// 运行时注册用户存储（网页端自助注册 / 无预置用户时首个用户注册）
//   - 密码用 node:crypto.scrypt 加盐哈希（N=16384, r=8, p=1, keylen=64）
//   - 数据文件：dataPath/users.json
//   - 字段：{ name, passwordHash, salt, email, createdAt, registrationYear }
//   - 与 config.js 预置用户并存：login 先查 config，未命中再查此表
//   - 注册默认开放（首个用户注册即可用）；需要关闭时设 GS_REGISTER_DISABLED=1
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { saveTenantSettings } from '@/library/tenant'

export interface RegisteredUser {
  name: string
  passwordHash: string   // scrypt hex
  salt: string           // random hex
  /** 注册邮箱（管理后台可见，用于联系/找回；老数据可能没有） */
  email?: string
  createdAt: number      // epoch ms
  registrationYear: number
  /** 可选：管理员手工提额（GB），优先于年度计算 */
  maxGb?: number
}

interface UsersFile {
  version: 1
  users: RegisteredUser[]
}

const FILE = () => path.join(global.lx.dataPath, 'users.json')

const SCRYPT_PARAMS = { cost: 16384, blockSize: 8, parallelization: 1, keylen: 64 } as const

export const hashPassword = (password: string, salt: string): Promise<string> => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS, (err, key) => {
    if (err) return reject(err)
    resolve(key.toString('hex'))
  })
})

export const verifyPassword = async (password: string, salt: string, hash: string): Promise<boolean> => {
  const got = await hashPassword(password, salt)
  // 使用 timingSafeEqual 防时序攻击
  const a = Buffer.from(got, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

const readAll = (): UsersFile => {
  try {
    const text = fs.readFileSync(FILE(), 'utf8')
    const j = JSON.parse(text)
    if (j && Array.isArray(j.users)) return { version: 1, users: j.users }
    return { version: 1, users: [] }
  } catch {
    return { version: 1, users: [] }
  }
}

const writeAll = (data: UsersFile): void => {
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
}

export const listRegisteredUsers = (): RegisteredUser[] => readAll().users

export const findRegisteredUser = (name: string): RegisteredUser | undefined =>
  readAll().users.find(u => u.name === name)

export const countRegisteredUsers = (): number => readAll().users.length

/**
 * 注册模式是否开放。
 * 默认**一直开放**（自助注册：账号 + 密码 + 邮箱，注册后自动登录、各自独立曲库与配额）；
 * 想关掉就设环境变量 GS_REGISTER_DISABLED=1 / true / yes（NAS 只给自己用时可关）。
 */
export const isRegisterOpen = (): boolean => {
  const off = String(process.env.GS_REGISTER_DISABLED ?? '').trim().toLowerCase()
  return !(off === '1' || off === 'true' || off === 'yes' || off === 'on')
}

const NAME_RE = /^[A-Za-z0-9_]{1,32}$/
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{6,128}$/
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

// 注册速率限制：每 IP 3 次失败封禁 15 分钟
const REG_FAIL_LIMIT = 3
const REG_FAIL_WINDOW = 15 * 60 * 1000
const regFails = new Map<string, { count: number, first: number }>()

export const regBlocked = (ip: string): boolean => {
  const rec = regFails.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > REG_FAIL_WINDOW) {
    regFails.delete(ip)
    return false
  }
  return rec.count >= REG_FAIL_LIMIT
}

export const regFail = (ip: string): void => {
  const rec = regFails.get(ip)
  if (!rec || Date.now() - rec.first > REG_FAIL_WINDOW) {
    regFails.set(ip, { count: 1, first: Date.now() })
    return
  }
  rec.count++
}

export const regSuccess = (ip: string): void => {
  regFails.delete(ip)
}

/** 邮箱是否已被别的账号占用（老数据可能没邮箱，跳过） */
export const emailTaken = (email: string, exceptName = ''): boolean =>
  readAll().users.some(u => u.name !== exceptName && (u.email ?? '').toLowerCase() === email.toLowerCase())

export const registerUser = async (
  name: string,
  password: string,
  email = '',
): Promise<{ ok: true, user: RegisteredUser } | { ok: false, reason: string }> => {
  // 只在开放模式允许
  if (!isRegisterOpen()) return { ok: false, reason: '注册模式已关闭' }
  // 校验
  if (!NAME_RE.test(name)) return { ok: false, reason: '用户名需为 1-32 位字母、数字或下划线' }
  if (password.length < 6 || password.length > 128) return { ok: false, reason: '密码需 6-128 位' }
  if (!PASSWORD_RE.test(password)) return { ok: false, reason: '密码需包含大小写字母、数字和特殊字符' }
  email = email.trim()
  if (!email) return { ok: false, reason: '请填写邮箱' }
  if (email.length > 128 || !EMAIL_RE.test(email)) return { ok: false, reason: '邮箱格式不正确' }
  // 与 config 用户/已注册用户冲突
  const cfgUsers = global.lx.config.users || []
  if (cfgUsers.some(u => u.name === name)) return { ok: false, reason: '用户名已被占用' }
  if (findRegisteredUser(name)) return { ok: false, reason: '用户名已被占用' }
  if (emailTaken(email)) return { ok: false, reason: '该邮箱已被注册' }

  const salt = crypto.randomBytes(16).toString('hex')
  const passwordHash = await hashPassword(password, salt)
  const now = Date.now()
  const user: RegisteredUser = {
    name,
    passwordHash,
    salt,
    email,
    createdAt: now,
    registrationYear: new Date(now).getFullYear(),
  }

  // 写入前先再检一次，避免并发注册
  const all = readAll()
  if (all.users.some(u => u.name === name)) return { ok: false, reason: '用户名已被占用' }
  if (all.users.some(u => (u.email ?? '').toLowerCase() === email.toLowerCase())) return { ok: false, reason: '该邮箱已被注册' }
  all.users.push(user)
  writeAll(all)

  // 预创建用户数据目录
  try {
    fs.mkdirSync(path.join(global.lx.dataPath, 'libraries', name), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(global.lx.dataPath, 'library', name), { recursive: true, mode: 0o700 })
  } catch { /* ignore */ }

  // 开箱即用：把专属下载目录登记为该用户的曲库扫描目录。
  //   不登记的话「下载到云盘」只会落盘（配额照算），文件永远进不了索引 ——
  //   网页端曲库为空、听不了、也管不了，而且此前网页端与后台都没有配这个目录的入口。
  try {
    saveTenantSettings(name, { dirs: [path.join(global.lx.dataPath, 'library', name)] })
  } catch { /* ignore: 目录配置失败不影响注册本身，后台仍可补配 */ }

  return { ok: true, user }
}

export const updateUserMaxGb = (name: string, maxGb: number | undefined): RegisteredUser | undefined => {
  const all = readAll()
  const u = all.users.find(x => x.name === name)
  if (!u) return undefined
  if (maxGb === undefined || maxGb === null) {
    delete u.maxGb
  } else {
    u.maxGb = maxGb
  }
  writeAll(all)
  return u
}

/** 管理后台重置已注册用户的密码（重新加盐哈希，明文不落盘） */
export const setRegisteredPassword = async (name: string, password: string): Promise<boolean> => {
  const all = readAll()
  const u = all.users.find(x => x.name === name)
  if (!u) return false
  const salt = crypto.randomBytes(16).toString('hex')
  u.salt = salt
  u.passwordHash = await hashPassword(password, salt)
  writeAll(all)
  return true
}

export const removeRegisteredUser = (name: string): boolean => {
  const all = readAll()
  const before = all.users.length
  all.users = all.users.filter(u => u.name !== name)
  if (all.users.length === before) return false
  writeAll(all)
  return true
}
