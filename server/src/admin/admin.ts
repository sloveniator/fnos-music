import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { getUserSpace, releaseUserSpace } from '@/user'
import { adminCreateUser, adminRemoveUser, adminSetPassword, loadDynamicUsers } from './store'
import { handleLibraryRequest, handleLibraryAdmin } from './library'
import { handleWebRequest } from '@/web/api'
import { findRegisteredUser, updateUserMaxGb } from '@/user/register'
import { getQuota } from '@/user/quota'
import { setListBroadcaster } from '@/web/playlists'

// ---------------------------------------------------------------------------
// 管理后台 HTTP API + 静态 UI 托管
// 认证：POST /admin/login 换取内存 token（24h），后续请求带 X-Admin-Token 头
// 注意：GS_ADMIN_PASSWORD 刻意不走 ENV_PARAMS 日志路径，避免密码泄漏到启动日志
// 登录限流：与 Web 端共用封禁器（独立桶前缀），防局域网弱密码爆破
// ---------------------------------------------------------------------------

import { loginBlocked, loginFail, loginSuccess } from '@/web/session'

const clientIp = (req: http.IncomingMessage): string => {
  if (global.lx.config['proxy.enabled']) {
    const fwd = req.headers[global.lx.config['proxy.header']]
    const ip = Array.isArray(fwd) ? fwd[0] : fwd
    if (ip) return ip.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

const TOKEN_TTL = 24 * 60 * 60 * 1000
const TOKEN_FILE = () => path.join(global.lx.dataPath, 'admin-tokens.json')
const tokens = new Map<string, number>()

// 持久化 token 到磁盘（防重启后管理会话丢失）
const saveTokens = (): void => {
  try {
    const data: Record<string, number> = {}
    for (const [k, v] of tokens) data[k] = v
    const tmp = TOKEN_FILE() + '.tmp'
    const fd = fs.openSync(tmp, 'w')
    try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
    fs.renameSync(tmp, TOKEN_FILE())
  } catch {}
}

const loadTokens = (): void => {
  try {
    const raw = fs.readFileSync(TOKEN_FILE(), 'utf8')
    const data = JSON.parse(raw) as Record<string, number>
    const now = Date.now()
    for (const [k, v] of Object.entries(data)) {
      if (v > now) tokens.set(k, v)
    }
  } catch {}
}

// fnOS 网关转发前缀（与 server.ts 同源）；重定向 Location 需带前缀才能留在网关内
const gatewayBase = (process.env.GS_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '')

export interface AdminHooks {
  removeDevice: (userName: string, clientId: string) => Promise<void>
  getStatus: () => LX.Sync.Status
  getConnectionCount: () => number
  getConnectionCountByUser: (userName: string) => number
  kickUser: (userName: string) => void
  // Web 端发起的歌单变更需广播给该用户全部在线同步设备（含快照 key 更新）
  broadcastListAction: (userName: string, action: LX.Sync.List.ActionList) => Promise<void>
}

let hooks: AdminHooks

export const initAdmin = (injected: AdminHooks) => {
  hooks = injected
  loadTokens()
  loadDynamicUsers()
  // Web 端歌单变更 → 同步设备广播通道
  setListBroadcaster(injected.broadcastListAction)
  // 定期清理过期 token，避免长期运行内存缓慢增长
  const sweeper = setInterval(() => {
    const now = Date.now()
    let changed = false
    for (const [token, expiry] of tokens) {
      if (expiry < now) { tokens.delete(token); changed = true }
    }
    if (changed) saveTokens()
  }, 15 * 60 * 1000)
  sweeper.unref?.()
}

const json = (res: http.ServerResponse, code: number, data: unknown) => {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 64 * 1024) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const isAuthed = (req: http.IncomingMessage) => {
  const token = req.headers['x-admin-token']
  if (typeof token != 'string') return false
  const expiry = tokens.get(token)
  if (!expiry || expiry < Date.now()) {
    tokens.delete(token)
    return false
  }
  return true
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const SECURITY_HEADERS: http.OutgoingHttpHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; media-src 'self'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

const serveStatic = (res: http.ServerResponse, staticDir: string, urlPath: string) => {
  let rel = urlPath.replace(/^\/+/, '')
  if (!rel) rel = 'index.html'
  const normalizedRoot = path.normalize(staticDir + path.sep)
  const filePath = path.normalize(path.join(staticDir, rel))
  if (!filePath.startsWith(normalizedRoot) && filePath !== path.normalize(staticDir)) {
    res.writeHead(403)
    res.end()
    return
  }
  let target = filePath
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    if (path.extname(rel)) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    target = path.join(staticDir, 'index.html')
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, SECURITY_HEADERS)
    res.end('Web UI not built. Set GS_WEB_STATIC_DIR to serve admin UI.')
    return
  }
  const ext = path.extname(target).toLowerCase()
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentTypes[ext] ?? 'application/octet-stream' })
  fs.createReadStream(target).pipe(res)
}

const userDeviceInfo = async(name: string) => {
  const userSpace = getUserSpace(name)
  const devices = await userSpace.getDecices()
  // 仅在该用户当前无活跃连接时才真正释放缓存，
  // 避免破坏「有连接时 UserSpace 必须常驻」的不变量（防数据丢失/半关闭状态）
  if (hooks.getConnectionCountByUser(name) === 0) releaseUserSpace(name, true)
  return devices
}

const handleApi = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method ?? 'GET'
  const adminPassword = process.env.GS_ADMIN_PASSWORD

  if (method == 'POST' && p == '/admin/login') {
    if (!adminPassword) {
      json(res, 503, { message: '管理密码未配置（GS_ADMIN_PASSWORD）' })
      return true
    }
    const ip = 'admin:' + clientIp(req)
    if (loginBlocked(ip)) {
      json(res, 429, { message: '失败次数过多，请 5 分钟后再试' })
      return true
    }
    let body: { password?: string }
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      json(res, 400, { message: 'invalid body' })
      return true
    }
    const inputBuf = Buffer.from(body.password ?? '', 'utf8')
    const expectedBuf = Buffer.from(adminPassword, 'utf8')
    if (inputBuf.length !== expectedBuf.length || !timingSafeEqual(inputBuf, expectedBuf)) {
      loginFail(ip)
      json(res, 401, { message: '密码错误' })
      return true
    }
    loginSuccess(ip)
    const token = randomBytes(24).toString('hex')
    tokens.set(token, Date.now() + TOKEN_TTL)
    saveTokens()
    json(res, 200, { token, serverName: global.lx.config.serverName })
    return true
  }

  // 以下接口均需认证
  if (!isAuthed(req)) {
    json(res, 401, { message: '未登录或会话过期' })
    return true
  }

  // 曲库管理 API（/admin/api/library/*）
  if (p.startsWith('/admin/api/library')) return handleLibraryAdmin(req, res, url)

  const userSeg = /^\/admin\/api\/users\/([^/]+)(\/.*)?$/.exec(p)

  if (method == 'GET' && p == '/admin/api/status') {
    const st = hooks.getStatus()
    json(res, 200, {
      status: st.status,
      message: st.message,
      address: st.address,
      connections: hooks.getConnectionCount(),
      users: global.lx.config.users.length,
      serverName: global.lx.config.serverName,
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
    })
    return true
  }

  if (method == 'GET' && p == '/admin/api/users') {
    const users = await Promise.all(global.lx.config.users.map(u =>
      userDeviceInfo(u.name)
        .then(devices => ({ name: u.name, deviceCount: devices.length }))
        .catch(() => ({ name: u.name, deviceCount: 0 }))
    ))
    json(res, 200, { users })
    return true
  }

  if (method == 'POST' && p == '/admin/api/users') {
    let body: { name?: string, password?: string }
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      json(res, 400, { message: 'invalid body' })
      return true
    }
    try {
      adminCreateUser(String(body.name ?? ''), String(body.password ?? ''))
      json(res, 200, { success: true })
    } catch (err: any) {
      json(res, 400, { message: err.message })
    }
    return true
  }

  if (userSeg) {
    const name = decodeURIComponent(userSeg[1])
    const rest = userSeg[2] ?? ''

    if (method == 'DELETE' && !rest) {
      try {
        hooks.kickUser(name)
        adminRemoveUser(name, url.searchParams.get('purge') == '1')
        json(res, 200, { success: true })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }

    if (method == 'POST' && rest == '/password') {
      let body: { password?: string }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(res, 400, { message: 'invalid body' })
        return true
      }
      try {
        adminSetPassword(name, String(body.password ?? ''))
        json(res, 200, { success: true })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }

    if (method == 'GET' && rest == '/devices') {
      try {
        json(res, 200, { devices: await userDeviceInfo(name) })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }

    // 网盘配额（运行时注册用户；config.js 内置用户不支持提额）
    //   GET  /admin/api/users/:name/quota       当前配额
    //   POST /admin/api/users/:name/quota       { maxGb: number|null } null/undefined 表示恢复自动计算
    if (method == 'GET' && rest == '/quota') {
      try {
        json(res, 200, { quota: getQuota(name), registered: !!findRegisteredUser(name) })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }
    if (method == 'POST' && rest == '/quota') {
      let body: { maxGb?: number | null }
      try { body = JSON.parse(await readBody(req)) }
      catch { json(res, 400, { message: 'invalid body' }); return true }
      try {
        const raw = body?.maxGb
        const maxGb = (raw === null || raw === undefined) ? undefined : Number(raw)
        if (maxGb !== undefined && (!Number.isFinite(maxGb) || maxGb <= 0)) {
          json(res, 400, { message: 'maxGb 需为正数或使用 null 恢复自动计算' })
          return true
        }
        const u = updateUserMaxGb(name, maxGb)
        if (!u) {
          json(res, 404, { message: '用户不存在（仅运行时注册用户支持配额调整）' })
          return true
        }
        json(res, 200, { success: true, quota: getQuota(name), registered: true })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }

    const deviceSeg = /^\/devices\/([^/]+)$/.exec(rest)
    if (method == 'DELETE' && deviceSeg) {
      try {
        await hooks.removeDevice(name, decodeURIComponent(deviceSeg[1]))
        json(res, 200, { success: true })
      } catch (err: any) {
        json(res, 400, { message: err.message })
      }
      return true
    }
  }

  json(res, 404, { message: 'not found' })
  return true
}

export const handleAdminRequest = async(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname

  // 消费者音乐应用 API（/web/*，独立会话鉴权）
  if (p.startsWith('/web/')) {
    try {
      return await handleWebRequest(req, res, url)
    } catch (err: any) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: -1, msg: err?.message ?? 'internal error' }))
      } catch {}
      return true
    }
  }

  // 曲库流媒体 API（/api/stream /api/cover /api/lyric /api/proxy /api/search，token 鉴权）
  if (p.startsWith('/api/')) {
    try {
      return await handleLibraryRequest(req, res, url)
    } catch (err: any) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: -1, msg: err?.message ?? 'internal error' }))
      } catch {}
      return true
    }
  }

  const method = req.method ?? 'GET'

  // 管理 API
  if (p.startsWith('/admin/api/') || p == '/admin/login') {
    try {
      return await handleApi(req, res, url)
    } catch (err: any) {
      try {
        json(res, 500, { message: err.message })
      } catch {}
      return true
    }
  }

  // 管理页 / 静态资源 / SPA
  if (p == '/admin') {
    // 无尾斜杠访问时重定向：保证 HTML 内相对资源路径（./assets/...）解析正确
    // 经 fnOS 网关访问时须带上转发前缀，否则跳出网关 404
    res.writeHead(302, { Location: gatewayBase + '/admin/' })
    res.end()
    return true
  }
  if (p == '/admin/' || p.startsWith('/admin/assets/') || p.startsWith('/admin/favicon')) {
    const staticDir = process.env.GS_WEB_STATIC_DIR
    if (!staticDir) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>LX Music NAS</title><p>Web UI 未配置（GS_WEB_STATIC_DIR）。API 仍可用：/admin/login</p>')
      return true
    }
    const rel = p == '/admin/'
      ? 'index.html'
      : p.replace(/^\/admin\//, '')
    serveStatic(res, staticDir, '/' + rel)
    return true
  }

  // 消费者音乐应用：/ 与 /assets/*、/favicon.ico（独立静态目录 GS_APP_STATIC_DIR）
  if ((p == '/' || p == '/index.html') && method == 'GET') {
    const appDir = process.env.GS_APP_STATIC_DIR
    if (appDir) {
      serveStatic(res, appDir, '/index.html')
      return true
    }
    // 未部署消费者端时回落管理后台
    res.writeHead(302, { Location: gatewayBase + '/admin/' })
    res.end()
    return true
  }
  if ((p.startsWith('/assets/') || p == '/favicon.ico') && method == 'GET') {
    const appDir = process.env.GS_APP_STATIC_DIR
    if (appDir) {
      serveStatic(res, appDir, p == '/favicon.ico' ? '/assets/icon.png' : p)
      return true
    }
  }

  return false
}
