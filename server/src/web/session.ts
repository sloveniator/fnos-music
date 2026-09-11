import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Web 消费者端会话：用户名 + 连接码登录（与同步用户同账号体系），
// token 走 X-Web-Token 头或媒体 URL 的 k 查询参数；失败限流防爆破
// ---------------------------------------------------------------------------

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000 // 30 天，NAS 私人设备友好
const MAX_SESSIONS_PER_USER = 10

interface Session {
  name: string
  expiry: number
  createdAt: number
}

const sessions = new Map<string, Session>()

// 登录失败限流：每 IP 10 次失败封禁 5 分钟（对齐同步协议风格）
const FAIL_LIMIT = 10
const FAIL_WINDOW = 5 * 60 * 1000
const loginFails = new Map<string, { count: number, first: number }>()

export const loginBlocked = (ip: string): boolean => {
  const rec = loginFails.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > FAIL_WINDOW) {
    loginFails.delete(ip)
    return false
  }
  return rec.count >= FAIL_LIMIT
}

export const loginFail = (ip: string): void => {
  const rec = loginFails.get(ip)
  if (!rec || Date.now() - rec.first > FAIL_WINDOW) {
    loginFails.set(ip, { count: 1, first: Date.now() })
    return
  }
  rec.count++
}

export const loginSuccess = (ip: string): void => {
  loginFails.delete(ip)
}

export const createSession = (name: string): string => {
  // 单用户会话数上限：踢最早的
  const mine = [...sessions.entries()].filter(([, s]) => s.name == name).sort((a, b) => a[1].createdAt - b[1].createdAt)
  while (mine.length >= MAX_SESSIONS_PER_USER) {
    const [oldest] = mine.shift()!
    sessions.delete(oldest)
  }
  const token = randomBytes(24).toString('hex')
  sessions.set(token, { name, expiry: Date.now() + SESSION_TTL, createdAt: Date.now() })
  return token
}

export const verifySession = (token: string | null | undefined): Session | null => {
  if (!token || typeof token != 'string') return null
  const s = sessions.get(token)
  if (!s) return null
  if (s.expiry < Date.now()) {
    sessions.delete(token)
    return null
  }
  return s
}

export const destroySession = (token: string): void => {
  sessions.delete(token)
}

// 每 15 分钟清扫过期会话
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [t, s] of sessions) if (s.expiry < now) sessions.delete(t)
  const failNow = Date.now()
  for (const [ip, rec] of loginFails) if (failNow - rec.first > FAIL_WINDOW) loginFails.delete(ip)
}, 15 * 60 * 1000)
sweeper.unref?.()
