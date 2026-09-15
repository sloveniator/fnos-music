// ---------------------------------------------------------------------------
// 公开分享路由：/s/<code>（免登录）
//   GET  /s/assets/share.js|share.css   分享页静态资源（白名单）
//   GET  /s/<code>                      分享页 HTML（服务端渲染头部）
//   POST /s/<code>/unlock               校验提取码 → 下发 cookie（HttpOnly）
//   GET  /s/<code>/api                  清单 JSON（需通过提取码）
//   GET  /s/<code>/stream|cover|lyric|download/<i>
//   - 媒体按「分享者租户」解析曲目，只暴露该链接快照内的曲目 id，与登录态无关
//   - 过期 → 410，撤销/不存在 → 404，提取码错误 → 401，方法不对 → 405（不穿透到 /web）
// ---------------------------------------------------------------------------
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getTenantTrack, safeUserName } from '@/library/tenant'
import { serveAudio } from '@/library/stream'
import { extractCover } from '@/library/metadata'
import { readCachedCover } from '@/library/cover-cache'
import { lyricWithFallback } from '@/online/lyric-fallback'
import { getIP } from '@/utils/tools'
import { auditDestructive } from '@/utils/audit'
import { sharePageHtml, errorPageHtml } from './page'
import {
  getShare, isExpired, hasPassword, checkPassword, touchShare,
  hitBlocked, hitShare, pwdBlocked, pwdFail, pwdReset, type ShareRecord, type ShareType,
} from './store'

const SHARE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"

const SEC_HEADERS: http.OutgoingHttpHeaders = {
  'Content-Security-Policy': SHARE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
}

const sendHtml = (res: http.ServerResponse, status: number, html: string): void => {
  const buf = Buffer.from(html, 'utf8')
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' })
  res.end(buf)
}

const sendJson = (res: http.ServerResponse, status: number, data: unknown): void => {
  const buf = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length), 'Cache-Control': 'no-store' })
  res.end(buf)
}

const errPage = (res: http.ServerResponse, status: number, title: string, message: string, hint?: string) =>
  sendHtml(res, status, errorPageHtml({ status, title, message, hint }))

// 方法不允许：分享页/清单/媒体都只认 GET/HEAD，别让非 GET 穿透到需要登录的 /web 路由
// （穿透后会返回 401「未登录」，语义完全是错的，容易被误读成鉴权问题）
const notAllowed = (res: http.ServerResponse): boolean => {
  res.writeHead(405, { ...SEC_HEADERS, 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Method Not Allowed')
  return true
}

const readBody = (req: http.IncomingMessage, max = 8 * 1024): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > max) { reject(new Error('body too large')); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

// ---------------- 静态资源（白名单，仅分享页自用） ----------------
const ASSET_TYPES: Record<string, string> = {
  'share.js': 'text/javascript; charset=utf-8',
  'share.css': 'text/css; charset=utf-8',
}

const shareStaticDir = (): string => {
  const env = process.env.GS_SHARE_STATIC_DIR
  if (env) return env
  const appDir = process.env.GS_APP_STATIC_DIR
  if (appDir) return path.resolve(appDir, '..', 'share')
  return path.resolve(__dirname, '../../ui/share')
}

const serveAsset = (req: http.IncomingMessage, res: http.ServerResponse, file: string): void => {
  const target = path.join(shareStaticDir(), file)
  let st: fs.Stats
  try {
    st = fs.statSync(target)
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...SEC_HEADERS, ETag: etag, 'Cache-Control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': ASSET_TYPES[file] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    ETag: etag,
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(target).pipe(res)
}

// ---------------- 提取码 cookie ----------------
const cookieName = (code: string) => 'gusi_s_' + code
/** 无需服务端密钥：用提取码哈希做 HMAC 密钥，改提取码即刻失效；重启后仍有效 */
const cookieValue = (rec: ShareRecord): string =>
  crypto.createHmac('sha256', rec.passHash).update('share:' + rec.code).digest('hex').substring(0, 40)

const readCookie = (req: http.IncomingMessage, name: string): string => {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

/** 返回 null = 通过；否则返回需要下发的拒绝响应信息 */
const gate = (req: http.IncomingMessage, rec: ShareRecord): 'ok' | 'need' => {
  if (!hasPassword(rec)) return 'ok'
  return readCookie(req, cookieName(rec.code)) === cookieValue(rec) ? 'ok' : 'need'
}

// ---------------- 文案 ----------------
const TYPE_TEXT: Record<ShareType, string> = { track: '单曲分享', playlist: '歌单分享', album: '专辑分享', artist: '歌手分享' }

const expireText = (rec: ShareRecord): string => {
  if (!rec.expiresAt) return '永久有效'
  const left = rec.expiresAt - Date.now()
  if (left <= 0) return '已过期'
  const hours = left / 3600000
  if (hours < 24) return Math.max(1, Math.round(hours)) + ' 小时后失效'
  return Math.ceil(hours / 24) + ' 天后失效'
}

// ---------------- 曲目解析 ----------------
interface ShareItem { i: number, name: string, singer: string, album: string, interval: string | null, playable: boolean }

const resolveItems = (rec: ShareRecord): ShareItem[] => rec.ids.map((id, i) => {
  const t = getTenantTrack(rec.owner, id)
  if (!t) return { i, name: '（曲目已不存在）', singer: '', album: '', interval: null, playable: false }
  return { i, name: t.name, singer: t.singer, album: t.album, interval: t.interval ?? null, playable: true }
})

// ---------------- 主入口 ----------------
export const handleShareRequest = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  const p = url.pathname
  if (p !== '/s' && !p.startsWith('/s/')) return false
  const method = (req.method ?? 'GET').toUpperCase()

  // 分享页静态资源
  const asset = /^\/s\/assets\/([a-z0-9._-]{1,40})$/i.exec(p)
  if (asset) {
    if (method != 'GET' && method != 'HEAD') return false
    if (!ASSET_TYPES[asset[1]]) {
      res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return true
    }
    serveAsset(req, res, asset[1])
    return true
  }

  const ip = getIP(req) || 'unknown'
  if (hitBlocked(ip)) {
    errPage(res, 429, '访问过于频繁', '这个 IP 短时间内打开了太多次分享链接，请稍后再试。')
    return true
  }
  hitShare(ip)

  const seg = /^\/s\/([a-z0-9]{4,24})(\/(?:api|unlock|stream|cover|lyric|download)(?:\/(\d{1,6}))?)?\/?$/.exec(p)
  if (!seg) {
    errPage(res, 404, '链接不存在', '分享链接格式不正确，请向分享者确认完整链接。')
    return true
  }
  const code = seg[1]
  const rest = (seg[2] ?? '').replace(/^\//, '')
  const idx = seg[3] ? parseInt(seg[3], 10) : -1
  const rec = getShare(code)
  if (!rec) {
    errPage(res, 404, '链接不存在或已被撤销', '这条分享可能被分享者删除了，或者链接复制时少了字符。')
    return true
  }
  if (isExpired(rec)) {
    errPage(res, 410, '链接已过期', '分享者在创建时设了有效期，这条链接现在已经失效。', '可以让分享者重新生成一条发给你。')
    return true
  }

  // ---- 提取码解锁 ----
  if (rest === 'unlock') {
    if (method != 'POST') return false
    const key = code + '@' + ip
    if (pwdBlocked(key)) {
      sendJson(res, 429, { code: -1, msg: '提取码错误次数过多，请 10 分钟后再试' })
      return true
    }
    let body: any = null
    try { body = JSON.parse(await readBody(req)) } catch { /* 空体按错误处理 */ }
    const pwd = String(body?.password ?? '').trim()
    if (!hasPassword(rec)) {
      sendJson(res, 200, { code: 0, data: { ok: true } })
      return true
    }
    if (!pwd || !await checkPassword(rec, pwd)) {
      pwdFail(key)
      auditDestructive('share.unlock_fail', { user: rec.owner, ip, ua: String(req.headers['user-agent'] ?? '') }, { code })
      sendJson(res, 401, { code: -1, msg: '提取码不正确' })
      return true
    }
    pwdReset(key)
    const maxAge = Math.floor((rec.expiresAt ? Math.min(rec.expiresAt, Date.now() + 7 * 86400000) : Date.now() + 7 * 86400000) - Date.now()) / 1000
    res.setHeader('Set-Cookie', `${cookieName(code)}=${cookieValue(rec)}; Path=/s/${code}; Max-Age=${Math.max(60, Math.floor(maxAge))}; HttpOnly; SameSite=Lax`)
    sendJson(res, 200, { code: 0, data: { ok: true } })
    return true
  }

  // ---- 清单 ----
  if (rest === 'api') {
    if (method != 'GET' && method != 'HEAD') return notAllowed(res)
    if (gate(req, rec) === 'need') {
      sendJson(res, 401, { code: -2, need: true, msg: '需要提取码' })
      return true
    }
    const items = resolveItems(rec)
    touchShare(code)
    sendJson(res, 200, {
      code: 0,
      data: {
        code,
        title: rec.title,
        subtitle: rec.subtitle,
        owner: rec.owner,
        type: rec.type,
        typeText: TYPE_TEXT[rec.type] ?? '分享',
        allowDownload: rec.allowDownload,
        expiresAt: rec.expiresAt,
        expireText: expireText(rec),
        hasPassword: hasPassword(rec),
        total: items.length,
        playable: items.filter(x => x.playable).length,
        items,
      },
    })
    return true
  }

  // ---- 媒体 ----
  if (rest.startsWith('stream') || rest.startsWith('cover') || rest.startsWith('lyric') || rest.startsWith('download')) {
    if (method != 'GET' && method != 'HEAD') return notAllowed(res)
    if (gate(req, rec) === 'need') {
      if (rest.startsWith('lyric')) sendJson(res, 401, { code: -2, need: true, msg: '需要提取码' })
      else { res.writeHead(401, { ...SEC_HEADERS }); res.end() }
      return true
    }
    if (idx < 0 || idx >= rec.ids.length) {
      res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return true
    }
    const track = getTenantTrack(rec.owner, rec.ids[idx])
    if (!track) {
      if (rest.startsWith('lyric')) sendJson(res, 404, { code: -1, msg: '曲目已不存在' })
      else { res.writeHead(404, { ...SEC_HEADERS }); res.end() }
      return true
    }
    if (rest.startsWith('stream')) {
      await serveAudio(req, res, track.filePath)
      return true
    }
    if (rest.startsWith('download')) {
      if (!rec.allowDownload) {
        sendJson(res, 403, { code: -1, msg: '分享者关闭了下载' })
        return true
      }
      await serveAudio(req, res, track.filePath, { attachment: `${track.name}${path.extname(track.filePath)}` })
      return true
    }
    if (rest.startsWith('cover')) {
      const cached = readCachedCover(safeUserName(rec.owner), track.id)
      const sendPic = (pic: { mime: string, data: Buffer }) => {
        res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': pic.mime, 'Content-Length': String(pic.data.length), 'Cache-Control': 'public, max-age=86400' })
        res.end(pic.data)
      }
      if (!track.hasCover) {
        if (cached) sendPic(cached)
        else { res.writeHead(404, { ...SEC_HEADERS }); res.end() }
        return true
      }
      const pic = await extractCover(track.filePath).catch(() => null)
      if (pic) sendPic(pic)
      else if (cached) sendPic(cached)
      else { res.writeHead(404, { ...SEC_HEADERS }); res.end() }
      return true
    }
    // lyric：返回 LRC 文本（前端自行解析）
    const r = await lyricWithFallback(track.id, track).catch(() => null)
    sendJson(res, 200, { code: 0, data: { lyric: r?.lyric ?? '', provider: r?.provider ?? null } })
    return true
  }

  // ---- 分享页 HTML ----
  if (method != 'GET' && method != 'HEAD') return notAllowed(res)
  const items = resolveItems(rec)
  const playable = items.filter(x => x.playable).length
  touchShare(code)
  sendHtml(res, 200, sharePageHtml({
    code,
    title: rec.title,
    subtitle: rec.subtitle,
    owner: rec.owner,
    typeText: TYPE_TEXT[rec.type] ?? '分享',
    playable,
    total: items.length,
    expireText: expireText(rec),
    hasPassword: hasPassword(rec),
    allowDownload: rec.allowDownload,
    coverPath: rec.coverId && getTenantTrack(rec.owner, rec.coverId) ? `/s/${code}/cover/${rec.ids.indexOf(rec.coverId)}` : '',
  }))
  return true
}
