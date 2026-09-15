import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { serveAudio } from '@/library/stream'
import { extractCover } from '@/library/metadata'
import { tenantGroupingSeed, listTenantTracks, getTenantTrack, getTenantTracks, tenantLibraryStats, getTenantScanState, getTenantSettings, saveTenantSettings, safeUserName, refreshCoverFlags, startTenantScan, removeTenantTracks, renameTenantTrack, updateTenantTrackTags,
  listTenantTrash, restoreTenantTrash, purgeTenantTrash } from '@/library/tenant'
import { coverCacheStats, readCachedCover, clearCoverCache } from '@/library/cover-cache'
import { runCoverBackfill, cancelCoverBackfill, coverBackfillState, subscribeCoverBackfill } from '@/library/cover-backfill'
import {
  tenantListAlbums, tenantListArtists, tenantAlbumTracks, tenantArtistAlbums, tenantArtistTracks,
} from './grouping'
import {
  loginBlocked, loginFail, loginSuccess, createSession, verifySession, destroySession,
} from './session'
import {
  createPlaylist, renamePlaylist, removePlaylists, addTrackIds, removeMusicIds,
  clearPlaylist, toggleLove, recordPlayed, recordPlayedOnline, getPlayed, overwritePlaylistOrder, migrateTrackRefs, dropTrackRefs,
  getListDataStable,
} from './playlists'
import { getUserSpace } from '@/user'
import { forYou } from '@/library/for-you'
import { LIST_IDS } from '@/constants'
import { lyricWithFallback } from '@/online/lyric-fallback'
import { fmChannels, fmNext } from '@/online'
import { onlineSources, onlineSearch, onlineSearchAlbums, onlineSearchPlaylists, onlineCollection, importOnlineUrl, onlineResolvePlayUrl, isOnlineSource, onlineLyric, onlineBoards, onlineBoardList, onlineRecPlaylists, onlineAudioExt, onlineStreamReferer } from '@/online'
import { pipeHttpStream } from '@/utils/httpPipe'
import { accessLog } from '@/utils/log4js'
import { auditDestructive } from '@/utils/audit'
import { resolveCover, fetchLyricFor, writeAudioTags, saveUrlToFile, ensureDirSync } from '@/downloads/tags'
import {
  enqueue, enqueueMany, listTasks, getTask, removeTask, retryTask, batchOperate, parsePlaylistText,
  stats as downloadStats, subscribe as subscribeDownload, searchForDownload,
} from '@/downloads/queue'
import {
  isRegisterOpen, registerUser, findRegisteredUser, verifyPassword,
  regBlocked, regFail, regSuccess, countRegisteredUsers,
} from '@/user/register'
import { getQuota, canAcceptBytes } from '@/user/quota'

// ---------------------------------------------------------------------------
// /web/* — 消费者音乐应用 API（会话鉴权）
//   POST /web/login|logout   GET /web/me
//   GET  /web/api/*          曲库浏览/搜索/统计/歌单/最近播放
//   POST /web/api/*          歌单增删改/收藏切换/播放记录
//   GET  /web/media/*        流/封面/歌词/下载（token 可走 ?k= 供 <audio>/<img> 用）
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, code: number, data: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
const ok = (res: http.ServerResponse, data: unknown): void => json(res, 200, { code: 0, data })
const fail = (res: http.ServerResponse, code: number, msg: string): void => json(res, code, { code: -1, msg })

const cloudSafeName = (s: string, max = 120): string =>
  (s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().substring(0, max)

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 256 * 1024) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const clientIp = (req: http.IncomingMessage): string => {
  if (global.lx.config['proxy.enabled']) {
    const fwd = req.headers[global.lx.config['proxy.header']]
    const ip = Array.isArray(fwd) ? fwd[0] : fwd
    if (ip) return ip.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** 审计用操作者信息：谁 + 从哪来（IP / UA），供删除、恢复、彻底删除三条路径复用 */
const auditActor = (req: http.IncomingMessage, user: string) =>
  ({ user, ip: clientIp(req), ua: String(req.headers['user-agent'] ?? '') })

const parseJson = (raw: string): any => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * MusicInfo → 带 NAS trackId 的 Web 视图（前端据此取封面/流）
 * missing：source=local 但曲库里已经没有这个 id（文件被删/改名/外部移动后重扫）。
 * 这类是「死引用」，前端要把它显示成不可播放的幽灵行、只给「从歌单移除」，
 * 否则用户点「删除」只会得到「曲目不存在」。
 */
const toWebMusic = (userName: string, m: any) => {
  const trackId = m.source == 'local' && typeof m.id == 'string' && m.id.startsWith('local_') ? m.id.substring(6) : null
  return {
    ...m,
    trackId,
    missing: m.source == 'local' && !(trackId && getTenantTrack(userName, trackId)),
  }
}

const playlistSummary = async(userName: string) => {
  // 走稳定读取：刚启动/刚建用户空间时 getListData() 可能读到空列表，
  // 会让侧栏歌单数显示 0、点进去「一首都没有」
  const data = await getListDataStable(userName)
  return [
    { id: LIST_IDS.DEFAULT, name: '我的歌单', count: data.defaultList.length, fixed: true },
    { id: LIST_IDS.LOVE, name: '我喜欢', count: data.loveList.length, fixed: true },
    ...data.userList.map(l => ({ id: l.id, name: l.name, count: (l.list as unknown[]).length, fixed: false })),
  ]
}

// ---------------- 在线封面代理（图片直连第三方） ----------------
const PIC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
// 白名单防 SSRF：只允许已知音源图床
const PIC_HOST_ALLOW = [
  /(^|\.)music\.126\.net$/, /(^|\.)126\.net$/, /(^|\.)music\.163\.com$/,
  /(^|\.)kuwo\.cn$/, /(^|\.)migu\.cn$/, /(^|\.)qq\.com$/, /(^|\.)gtimg\.cn$/,
  /(^|\.)douyinpic\.com$/, // 汽水音乐图床（p3/p6-luna.douyinpic.com）
]
const PIC_TTL = 6 * 60 * 60 * 1000
const picCache = new Map<string, { ct: string, buf: Buffer, ts: number }>()

export const handleWebRequest = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  const p = url.pathname
  const method = req.method ?? 'GET'
  if (!p.startsWith('/web/')) return false

  // ---------------- 登录状态（无需鉴权，前端启动时调用以决定 UI 分支） ----------------
  if (method == 'GET' && p == '/web/login-state') {
    // firstRun：还没有任何账号（内置 + 网页注册都为 0）—— 此时前端直接进注册表单
    const firstRun = countRegisteredUsers() === 0 && (global.lx.config.users || []).length === 0
    ok(res, { registerOpen: isRegisterOpen(), firstRun })
    return true
  }

  // ---------------- 注册（无需鉴权，仅 registerOpen 时开放） ----------------
  if (method == 'POST' && p == '/web/register') {
    if (!isRegisterOpen()) return fail(res, 403, '注册模式已关闭'), true
    const ip = 'reg:' + clientIp(req)
    if (regBlocked(ip)) return fail(res, 429, '注册失败次数过多，请 15 分钟后再试'), true
    let body: any
    try { body = parseJson(await readBody(req)) }
    catch { return fail(res, 400, '请求体异常'), true }
    const name = String(body?.name ?? '').trim()
    const password = String(body?.password ?? '')
    const confirm = String(body?.confirm ?? '')
    const email = String(body?.email ?? '').trim()
    if (password !== confirm) return fail(res, 400, '两次输入的密码不一致'), true
    const r = await registerUser(name, password, email)
    if (!r.ok) { regFail(ip); return fail(res, 400, r.reason), true }
    regSuccess(ip)
    // 注册成功后自动登录
    const token = createSession(r.user.name)
    ok(res, { token, name: r.user.name })
    return true
  }

  // ---------------- 登录（双通道：config.users → users.json） ----------------
  if (method == 'POST' && p == '/web/login') {
    const ip = clientIp(req)
    if (loginBlocked(ip)) return fail(res, 429, '失败次数过多，请 5 分钟后再试'), true
    let body: any
    try { body = parseJson(await readBody(req)) }
    catch { return fail(res, 400, '请求体异常'), true }
    const name = String(body?.name ?? '').trim()
    const password = String(body?.password ?? '')
    let authenticated = false
    let authName = ''
    // 通道 1：config.js 预置用户
    const cfgUser = global.lx.config.users.find(u => u.name == name)
    if (cfgUser && cfgUser.password == password) {
      authenticated = true
      authName = name
    } else {
      // 通道 2：运行时注册用户（scrypt 校验）
      const regUser = findRegisteredUser(name)
      if (regUser) {
        try {
          const good = await verifyPassword(password, regUser.salt, regUser.passwordHash)
          if (good) { authenticated = true; authName = name }
        } catch { /* 校验异常按失败处理 */ }
      }
    }
    if (!authenticated) {
      loginFail(ip)
      return fail(res, 401, '用户名或密码错误'), true
    }
    loginSuccess(ip)
    const token = createSession(authName)
    ok(res, { token, name: authName })
    return true
  }

  // ---------------- 会话鉴权 ----------------
  const session = verifySession(req.headers['x-web-token'] as string ?? url.searchParams.get('k'))
  if (!session) return fail(res, 401, '未登录或会话已过期'), true
  const userName = session.name

  if (method == 'POST' && p == '/web/logout') {
    destroySession((req.headers['x-web-token'] as string) ?? url.searchParams.get('k') ?? '')
    ok(res, {})
    return true
  }

  let seg: RegExpExecArray | null

  // ---------------- 媒体（<audio>/<img> 用 ?k= 查询参数） ----------------
  // 在线源代理流：解析第三方直链后由 NAS 中转（Range 透传，供 seek）
  //   ?dl=1       走下载模式（附加 Content-Disposition: attachment，不带 Range）
  //   ?name=...   下载文件名（可选，未提供时从上游 URL / Content-Type 推断）
  if (method == 'GET' && (seg = /^\/web\/media\/online\/([\w-]{1,16})\/([A-Za-z0-9_]{1,48})$/.exec(p))) {
    const [, oSource, oRid] = seg
    if (!isOnlineSource(oSource)) return fail(res, 400, '未知的在线源：' + oSource), true
    const asDownload = url.searchParams.get('dl') == '1'
    const fileName = (url.searchParams.get('name') ?? '').substring(0, 180)
    // 容器扩展名按源声明（汽水 m4a）；上游 Content-Type 不可信——汽水返回 video/mp4，
    // 既不合适给 <audio>，也会让下载文件名被补成 .mp3，这里统一覆盖成音频 MIME
    const oExt = onlineAudioExt(oSource)
    const oCt = oExt == 'm4a' ? 'audio/mp4' : oExt == 'flac' ? 'audio/flac' : oExt == 'aac' ? 'audio/aac' : undefined

    // 下载模式且容器为 mp3：先把上游整包落到临时文件，写好封面与歌词再回传。
    // 直接 pipe 是「裸流转发」，用户拿到的文件没有封面也没有歌词（此前行为）。
    // 多花一次落盘 + 几秒，换来下载文件在任意播放器里都带图带词。
    if (asDownload && oExt == 'mp3') {
      const tmpFile = path.join(global.lx.dataPath, 'tmp', 'dl-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.mp3')
      const cleanup = (): void => { try { fs.unlinkSync(tmpFile) } catch {} }
      try {
        ensureDirSync(path.dirname(tmpFile))
        const meta = {
          name: (url.searchParams.get('title') ?? '').substring(0, 180) || fileName.replace(/\.[A-Za-z0-9]{2,5}$/, ''),
          singer: (url.searchParams.get('singer') ?? '').substring(0, 120),
          album: (url.searchParams.get('album') ?? '').substring(0, 120),
          duration: Number(url.searchParams.get('dur')) || 0,
          source: oSource,
          rid: oRid,
        }
        const playUrl = await onlineResolvePlayUrl(oSource, oRid)
        await saveUrlToFile(playUrl, { Referer: onlineStreamReferer(oSource) }, tmpFile)
        // 封面地址由客户端带过来，必须过图床白名单——否则等于给了一个任意 URL 取回口子
        const pic = (url.searchParams.get('pic') ?? '').substring(0, 600)
        let picAllowed = false
        try { picAllowed = !!pic && PIC_HOST_ALLOW.some((re) => re.test(new URL(pic).hostname)) } catch { picAllowed = false }
        const [cover, lyric] = await Promise.all([
          resolveCover(meta, picAllowed ? pic : ''),
          fetchLyricFor(meta),
        ])
        const tr = writeAudioTags(tmpFile, meta, cover, lyric)
        if (tr.error) accessLog.warn('下载标签写入失败：' + tmpFile + ' ' + tr.error)
        // 回传结束（含客户端中途断开）后清临时文件；出错路径在 catch 里清
        res.on('close', cleanup)
        const att = fileName || meta.name || 'download'
        await serveAudio(req, res, tmpFile, { attachment: /\.[A-Za-z0-9]{2,5}$/.test(att) ? att : att + '.mp3' })
      } catch (e) {
        cleanup()
        if (!res.headersSent) fail(res, 502, (e as Error).message)
        else { try { res.end() } catch {} }
      }
      return true
    }

    void onlineResolvePlayUrl(oSource, oRid).then(
      (playUrl) => pipeHttpStream(
        req, res, playUrl,
        { Referer: onlineStreamReferer(oSource) },
        { ...(asDownload ? { download: true, filename: fileName } : {}), ...(oCt ? { contentType: oCt } : {}) },
      ),
      (e) => fail(res, 502, (e as Error).message),
    )
    return true
  }
  // 在线封面代理：/web/media/pic?u=<encodeURIComponent(url)>
  // 第三方图床多为 http（部分域名 https 不可达），由 NAS 取回再回传，
  // 规避浏览器对 http 图片的拦截；命中本地缓存直接返回
  if (method == 'GET' && p == '/web/media/pic') {
    const raw = url.searchParams.get('u') ?? ''
    let target: URL | null = null
    try { target = new URL(raw) } catch { target = null }
    if (!target || (target.protocol != 'http:' && target.protocol != 'https:')) return fail(res, 400, '图片地址非法'), true
    const picUrl: URL = target
    if (!PIC_HOST_ALLOW.some((re) => re.test(picUrl.hostname))) return fail(res, 403, '图片来源不在白名单内'), true
    const hit = picCache.get(picUrl.href)
    if (hit && Date.now() - hit.ts < PIC_TTL) {
      res.writeHead(200, {
        'Content-Type': hit.ct, 'Content-Length': String(hit.buf.length),
        'Cache-Control': 'public, max-age=86400', 'X-Pic-Cache': 'hit',
      })
      res.end(hit.buf)
      return true
    }
    try {
      const r = await fetch(picUrl.href, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'User-Agent': PIC_UA, Referer: picUrl.origin + '/' },
      })
      if (!r.ok) return fail(res, 502, '上游返回 ' + r.status), true
      const ct = String(r.headers.get('content-type') ?? '').split(';')[0].trim() || 'image/jpeg'
      if (!/^image\//.test(ct)) return fail(res, 502, '上游不是图片'), true
      const buf = Buffer.from(await r.arrayBuffer())
      if (!buf.length || buf.length > 6 * 1024 * 1024) return fail(res, 502, '图片为空或过大'), true
      picCache.set(picUrl.href, { ct, buf, ts: Date.now() })
      if (picCache.size > 150) picCache.delete(String(picCache.keys().next().value))
      res.writeHead(200, {
        'Content-Type': ct, 'Content-Length': String(buf.length), 'Cache-Control': 'public, max-age=86400',
      })
      res.end(buf)
    } catch (e) {
      return fail(res, 502, '取图失败：' + (e as Error).message), true
    }
    return true
  }
  // 在线源封面已在 media 段最前处理（pic 分支必须先于 online/{source} 匹配）
  if (method == 'GET' && (seg = /^\/web\/media\/stream\/([\w-]{1,64})$/.exec(p))) {
    const track = getTenantTrack(userName, seg[1])
    if (!track) return fail(res, 404, '曲目不存在（可能已重新扫描）'), true
    await serveAudio(req, res, track.filePath)
    return true
  }
  if (method == 'GET' && (seg = /^\/web\/media\/download\/([\w-]{1,64})$/.exec(p))) {
    const track = getTenantTrack(userName, seg[1])
    if (!track) return fail(res, 404, '曲目不存在'), true
    await serveAudio(req, res, track.filePath, { attachment: `${track.name}${path.extname(track.filePath)}` })
    return true
  }
  if (method == 'GET' && (seg = /^\/web\/media\/cover\/([\w-]{1,64})$/.exec(p))) {
    const track = getTenantTrack(userName, seg[1])
    if (!track) {
      res.writeHead(404)
      res.end()
      return true
    }
    const sendPic = (pic: { mime: string, data: Buffer }) => {
      res.writeHead(200, { 'Content-Type': pic.mime, 'Content-Length': String(pic.data.length), 'Cache-Control': 'private, max-age=86400' })
      res.end(pic.data)
    }
    const send404 = () => { res.writeHead(404); res.end() }
    // 无内嵌封面的曲目：回退到在线回填缓存（covers/<trackId>.jpg）
    if (!track.hasCover) {
      const cached = readCachedCover(safeUserName(userName), track.id)
      if (cached) sendPic(cached)
      else send404()
      return true
    }
    void extractCover(track.filePath).then(pic => {
      if (pic) return sendPic(pic)
      const cached = readCachedCover(safeUserName(userName), track.id)
      if (cached) return sendPic(cached)
      send404()
    }).catch(() => {
      const cached = readCachedCover(safeUserName(userName), track.id)
      if (cached) return sendPic(cached)
      res.writeHead(500)
      res.end()
    })
    return true
  }
  if (method == 'GET' && (seg = /^\/web\/media\/lyric\/([\w-]{1,64})$/.exec(p))) {
    const track = getTenantTrack(userName, seg[1])
    if (!track) return fail(res, 404, '曲目不存在'), true
    // 歌词兜底：NAS 内嵌/.lrc 优先，未命中按「歌名+歌手」跨源（酷狗/QQ 免费歌词通道）检索
    // 传入已解析的租户 track，避免跨租户查找全局曲库
    void lyricWithFallback(seg[1], track).then(r => {
      ok(res, { lyric: r.lyric ?? '', tlyric: null, rlyric: null, lxlyric: null, provider: r.provider })
    }).catch(() => fail(res, 500, '歌词读取失败'))
    return true
  }

  // ---------------- 曲库浏览 ----------------
  if (method == 'GET' && p == '/web/me') {
    ok(res, { name: userName, serverName: global.lx.config['serverName'] ?? '' })
    return true
  }
  if (method == 'GET' && p == '/web/api/stats') {
    ok(res, { ...tenantLibraryStats(userName), scan: getTenantScanState(userName) })
    return true
  }
  // 用户容量配额（下载中心/设置页可独立调用）
  if (method == 'GET' && p == '/web/api/quota') {
    ok(res, getQuota(userName))
    return true
  }
  // ---------------- 下载目录（下载中心专用） ----------------
  // 用户注册时自动分配专属目录 dataPath/library/<username>，无需手动设置
  if (method == 'GET' && p == '/web/api/downloads/dir') {
    const t = getTenantSettings(userName)
    const userDir = path.join(global.lx.dataPath, 'library', userName)
    ok(res, {
      current: t.dirs[0] || userDir,
      dirs: t.dirs,
      authed: [],
      userDir,          // 用户专属目录
      autoAssigned: true, // 标记为自动分配
    })
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/dir') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const dir = String(body?.dir ?? '').trim()
    if (!dir) return fail(res, 400, '目录不能为空'), true
    // 限制长度 & 只允许常见路径字符
    if (dir.length > 512) return fail(res, 400, '路径过长'), true
    if (!/^[A-Za-z]:[\\/].+$|^[\\/].+$|^~\//.test(dir)) return fail(res, 400, '路径格式非法'), true
    // 检查可写性（尝试 mkdir）
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK) }
    catch (e: any) { return fail(res, 400, '目录不可写：' + (e?.message || 'unknown')), true }
    ok(res, { current: dir, settings: saveTenantSettings(userName, { dirs: [dir] }) })
    return true
  }
  // ---------------- 在线源（Web 在线搜索 / 代理播放，方案 B） ----------------
  if (method == 'GET' && p == '/web/api/online/sources') {
    ok(res, { sources: onlineSources() })
    return true
  }
  if (method == 'GET' && p == '/web/api/online/search') {
    const source = url.searchParams.get('source') ?? 'kw'
    const keyword = (url.searchParams.get('q') ?? '').trim()
    const type = url.searchParams.get('type') ?? 'song'
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') ?? '20', 10) || 20))
    if (!keyword || keyword.length > 100) return fail(res, 400, '请输入搜索关键词'), true
    if (!isOnlineSource(source)) return fail(res, 400, '未知的在线源：' + source), true
    try {
      if (type === 'album') ok(res, await onlineSearchAlbums(source, keyword, page, size))
      else if (type === 'playlist') ok(res, await onlineSearchPlaylists(source, keyword, page, size))
      else ok(res, await onlineSearch(source, keyword, page, size))
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // /web/api/online/collection?source=&type=album|playlist&id= —— 专辑/歌单曲目展开
  if (method == 'GET' && p == '/web/api/online/collection') {
    const source = url.searchParams.get('source') ?? ''
    const type = url.searchParams.get('type') ?? ''
    const id = url.searchParams.get('id') ?? ''
    if (!isOnlineSource(source)) return fail(res, 400, '未知的在线源：' + source), true
    if (type !== 'album' && type !== 'playlist') return fail(res, 400, 'type 必须是 album/playlist'), true
    if (!/^[A-Za-z0-9_\-]{1,48}$/.test(id)) return fail(res, 400, 'id 非法'), true
    try {
      ok(res, await onlineCollection(source, type, id))
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // /web/api/online/import?url= —— 粘贴分享链接导入歌单/专辑（自动识别平台与类型）
  if (method == 'GET' && p == '/web/api/online/import') {
    const raw = url.searchParams.get('url') ?? ''
    if (!raw || raw.length > 512) return fail(res, 400, '请粘贴有效的分享链接'), true
    try {
      const imported = await importOnlineUrl(raw)
      ok(res, imported)
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // /web/api/online/url —— 直链查询（播放器换源）
  if (method == 'GET' && p == '/web/api/online/url') {
    const source = url.searchParams.get('source') ?? ''
    const rid = url.searchParams.get('rid') ?? ''
    if (!isOnlineSource(source) || !/^[A-Za-z0-9_]{1,48}$/.test(rid)) return fail(res, 400, '参数非法'), true
    try {
      const playUrl = await onlineResolvePlayUrl(source, rid)
      ok(res, { url: playUrl })
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // /web/api/online/rec-playlists?source=wy&limit=12 —— 推荐歌单
  if (method == 'GET' && p == '/web/api/online/rec-playlists') {
    const source = url.searchParams.get('source') ?? 'wy'
    const limit = parseInt(url.searchParams.get('limit') ?? '12', 10) || 12
    if (!isOnlineSource(source)) return fail(res, 400, '参数非法'), true
    try {
      ok(res, { list: await onlineRecPlaylists(source, limit) })
    } catch (e: any) { fail(res, 500, '获取推荐歌单失败：' + (e?.message || e)) }
    return true
  }

  // /web/api/online/boards?source= —— 榜单目录
  if (method == 'GET' && p == '/web/api/online/boards') {
    const source = url.searchParams.get('source') ?? ''
    if (!isOnlineSource(source)) return fail(res, 400, '参数非法'), true
    ok(res, { list: onlineBoards(source) })
    return true
  }
  // /web/api/online/board?source=&bid= —— 榜单曲目
  if (method == 'GET' && p == '/web/api/online/board') {
    const source = url.searchParams.get('source') ?? ''
    const bid = url.searchParams.get('bid') ?? ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200)
    if (!isOnlineSource(source) || !/^[A-Za-z0-9_]{1,48}$/.test(bid)) return fail(res, 400, '参数非法'), true
    try {
      ok(res, await onlineBoardList(source, bid, limit))
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // /web/api/online/lyric?source=&rid= —— 在线歌词（LRC 明文；源不支持时 lyric=''）
  if (method == 'GET' && p == '/web/api/online/lyric') {
    const source = url.searchParams.get('source') ?? ''
    const rid = url.searchParams.get('rid') ?? ''
    if (!isOnlineSource(source) || !/^[A-Za-z0-9_]{1,48}$/.test(rid)) return fail(res, 400, '参数非法'), true
    const r = await onlineLyric(source, rid)
    ok(res, r)
    return true
  }
  // ---------------- FM 电台（汽水听歌模式 → 自动续播频道） ----------------
  // GET /web/api/fm/modes —— 频道目录（实时拉汽水「听歌模式」，含频道说明/播放速率）
  if (method == 'GET' && p == '/web/api/fm/modes') {
    try {
      ok(res, { list: await fmChannels() })
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // GET /web/api/fm/next?key=&limit=&exclude= —— 取下一批频道曲目（前端队列见底时续播）
  //   exclude 为客户端已播曲目 id（逗号分隔），服务端据此避开重复；池子跑完一圈自动重开
  if (method == 'GET' && p == '/web/api/fm/next') {
    const key = (url.searchParams.get('key') ?? '').trim()
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 50)
    const exclude = (url.searchParams.get('exclude') ?? '')
      .split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_\-]{1,48}$/.test(s)).slice(0, 800)
    if (!/^[a-z0-9_]{1,48}$/.test(key)) return fail(res, 400, '参数非法'), true
    try {
      ok(res, await fmNext(key, exclude, limit))
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }
  // ---------------- 在线下载队列（MVP，移植 daoyin 下载能力的最小内核） ----------------
  // 保存到云盘：把本地曲目复制进用户网盘目录（默认 dataPath/library/<user>，受配额约束）
  //   POST /web/api/cloud/save { trackIds: string[] }
  //   落盘结构与下载中心一致：<网盘根>/<歌手>/<专辑>/<曲名>.<ext>
  if (method == 'POST' && p == '/web/api/cloud/save') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const ids: string[] = Array.isArray(body?.trackIds)
      ? body.trackIds.map((x: unknown) => String(x)).filter(Boolean).slice(0, 300)
      : []
    if (!ids.length) return fail(res, 400, '未指定曲目'), true
    // 云盘目录固定为用户专属网盘（自动创建，独立于曲库扫描目录），受 1GB 配额约束
    const dir = path.join(global.lx.dataPath, 'library', userName)
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e: any) { return fail(res, 500, '云盘目录不可写：' + (e?.message || '')), true }
    let remaining = getQuota(userName).remainingBytes
    const out = { saved: 0, skipped: 0, missing: 0, failed: 0, bytes: 0, full: false, reason: '' }
    for (const id of ids) {
      const tr = getTenantTrack(userName, id)
      if (!tr) { out.missing++; continue }
      const ext = path.extname(tr.filePath) || '.mp3'
      const dest = path.join(dir, cloudSafeName(tr.singer), cloudSafeName(tr.album), cloudSafeName(tr.name) + ext)
      // 已在网盘内的同一文件 → 跳过，避免自我复制
      if (path.resolve(tr.filePath) === path.resolve(dest)) { out.skipped++; continue }
      try { if (fs.statSync(dest).size > 0) { out.skipped++; continue } } catch { /* 不存在则继续 */ }
      let size = 0
      try { size = fs.statSync(tr.filePath).size } catch { out.failed++; continue }
      if (size > remaining) {
        out.full = true
        out.reason = '云盘剩余空间不足（剩 ' + (remaining / 1048576).toFixed(1) + ' MB）'
        break
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(tr.filePath, dest)
        remaining -= size
        out.saved++
        out.bytes += size
      } catch { out.failed++ }
    }
    // 有新文件落地才触发增量扫描，让保存的曲目立即出现在曲库中
    if (out.saved > 0) { try { startTenantScan(userName) } catch { /* 扫描失败不影响保存结果 */ } }
    ok(res, out)
    return true
  }

  if (method == 'GET' && p == '/web/api/downloads/stats') {
    ok(res, downloadStats(userName))
    return true
  }
  if (method == 'GET' && p == '/web/api/downloads/tasks') {
    const filter = url.searchParams.get('status') ?? ''
    let list = listTasks(userName)
    if (filter) list = list.filter(t => t.status === filter)
    ok(res, { tasks: list, stats: downloadStats(userName) })
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/enqueue') {
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const items = Array.isArray(body?.items) ? body.items : (body?.source && body?.id ? [body] : [])
    if (!items.length) return fail(res, 400, 'items 缺失'), true
    if (items.length > 50) return fail(res, 400, '批量上限 50 项'), true
    const r = await enqueueMany(userName, items)
    ok(res, { accepted: r.accepted, skipped: r.skipped, reasons: r.reasons })
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/retry') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const id = String(body?.id ?? '')
    if (!/^[a-f0-9]{16}$/.test(id)) return fail(res, 400, 'id 非法'), true
    const t = getTask(id)
    if (!t || t.userName !== userName) return fail(res, 404, '任务不存在'), true
    retryTask(id)
    ok(res, { id })
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/remove') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const id = String(body?.id ?? '')
    if (!/^[a-f0-9]{16}$/.test(id)) return fail(res, 400, 'id 非法'), true
    const t = getTask(id)
    if (!t || t.userName !== userName) return fail(res, 404, '任务不存在'), true
    const ok2 = removeTask(id)
    if (!ok2) return fail(res, 400, '下载中的任务不可删除'), true
    ok(res, { id })
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/batch') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter((x: string) => /^[a-f0-9]{16}$/.test(x)) : []
    const op = String(body?.op ?? 'remove')
    if (!op || !['remove', 'retry', 'delete-file'].includes(op)) return fail(res, 400, 'op 必须是 remove/retry/delete-file'), true
    if (ids.length === 0) return fail(res, 400, '未选择任何任务'), true
    if (ids.length > 100) return fail(res, 400, '一次最多 100 条'), true
    const r = batchOperate(ids, op as any, userName)
    ok(res, r)
    return true
  }
  if (method == 'POST' && p == '/web/api/downloads/parse-text') {
    let body: any
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const text = String(body?.text ?? '')
    if (!text.trim()) return fail(res, 400, '歌单文本为空'), true
    if (text.length > 20000) return fail(res, 400, '文本过长（>20000 字符）'), true
    const source = ['kw', 'wy', 'mg'].includes(String(body?.source)) ? String(body.source) : 'kw'
    const maxLines = Math.min(50, Math.max(1, parseInt(String(body?.maxLines ?? '50'), 10) || 50))
    try {
      const r = await parsePlaylistText(userName, text, source, { maxLines })
      ok(res, r)
    } catch (e: any) {
      fail(res, 502, (e?.message || '解析失败'))
    }
    return true
  }
  // SSE：实时推送下载状态
  if (method == 'GET' && p == '/web/api/downloads/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('retry: 5000\r\n\r\n')
    const unsubscribe = subscribeDownload(t => {
      if (t.userName !== userName) return
      res.write('event: task\r\ndata: ' + JSON.stringify(t) + '\r\n\r\n')
    })
    req.on('close', () => unsubscribe())
    return true
  }
  if (method == 'GET' && p == '/web/api/downloads/search') {
    // 不分平台：默认并发查全部已启用源并合并去重；带 source 时仅查该源（兼容/调试）
    const only = (url.searchParams.get('source') ?? '').trim()
    const keyword = (url.searchParams.get('q') ?? '').trim()
    const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') ?? '20', 10) || 20))
    if (!keyword || keyword.length > 100) return fail(res, 400, '请输入搜索关键词'), true
    if (only && !isOnlineSource(only)) return fail(res, 400, '未知的在线源：' + only), true
    try {
      ok(res, await searchForDownload(keyword, size, only || undefined))
    } catch (e) {
      fail(res, 502, (e as Error).message)
    }
    return true
  }

  if (method == 'GET' && p == '/web/api/tracks') {
    ok(res, listTenantTracks(userName, {
      q: url.searchParams.get('q') ?? undefined,
      page: parseInt(url.searchParams.get('page') ?? '1', 10),
      size: parseInt(url.searchParams.get('size') ?? '50', 10),
    }))
    return true
  }
  // 删除曲目：软删除，文件移入曲库根下 .gusi-trash/（扫描器跳过点目录，不会回流索引）
  if (method == 'POST' && p == '/web/api/tracks/delete') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.map((x: unknown) => String(x)) : []
    if (!ids.length) return fail(res, 400, '请提供要删除的曲目'), true
    if (ids.length > 500) return fail(res, 400, '单次最多删除 500 首'), true
    const r = removeTenantTracks(userName, ids)
    // 审计：软删除也动真实文件（搬进 .gusi-trash/），谁在什么时候删了什么必须留痕
    auditDestructive('tracks.delete', auditActor(req, userName), {
      requested: ids.length,
      removed: r.removed,
      remaining: r.total,
      trashDir: r.trashDir,
      ids: r.removedIds,
      failed: r.failed.map((f) => ({ id: f.id, name: f.name, reason: f.reason })),
    })
    // 曲目没了，歌单/收藏里的 local_<id> 就是死引用，必须一并摘掉：
    // 否则歌单里会留一行「看着能点、点了只会报曲目不存在」的幽灵曲目。
    const playlists = r.removedIds.length
      ? await dropTrackRefs(userName, r.removedIds)
        .catch((err: any) => { console.error('drop track refs error:', err?.message); return [] as string[] })
      : []
    ok(res, { ...r, playlists })
    return true
  }

  // 回收站：软删除后的文件在这里可见、可恢复、可彻底删除
  if (method == 'GET' && p == '/web/api/trash') {
    const list = listTenantTrash(userName)
    ok(res, { list, count: list.length, bytes: list.reduce((s, x) => s + x.size, 0) })
    return true
  }

  if (method == 'POST' && p == '/web/api/trash/restore') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const paths: string[] = Array.isArray(body?.paths) ? body.paths.map((x: unknown) => String(x)) : []
    if (!paths.length) return fail(res, 400, '请选择要恢复的文件'), true
    if (paths.length > 500) return fail(res, 400, '单次最多恢复 500 个'), true
    const rr = restoreTenantTrash(userName, paths)
    auditDestructive('trash.restore', auditActor(req, userName), {
      requested: paths.length,
      ok: rr.ok,
      paths,
      failed: rr.failed,
    })
    ok(res, rr)
    return true
  }

  if (method == 'POST' && p == '/web/api/trash/purge') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const paths: string[] = Array.isArray(body?.paths) ? body.paths.map((x: unknown) => String(x)) : []
    if (!paths.length) return fail(res, 400, '请选择要删除的文件'), true
    if (paths.length > 500) return fail(res, 400, '单次最多删除 500 个'), true
    const pr = purgeTenantTrash(userName, paths)
    // 彻底删除不可恢复，这一行是唯一的追责依据
    auditDestructive('trash.purge', auditActor(req, userName), {
      requested: paths.length,
      ok: pr.ok,
      clearAll: paths.some((x) => String(x) === '*'),
      paths,
      failed: pr.failed,
    })
    ok(res, pr)
    return true
  }

  // 重命名曲目文件。曲目 id 由相对路径决定，改完文件名 id 就变了，所以歌单/
  // 我喜欢/最近播放里存的 local_<id> 必须一并迁移，否则这些引用会变成失效项。
  if (method == 'POST' && p == '/web/api/tracks/rename') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const id = String(body?.id ?? '')
    const name = String(body?.name ?? '')
    if (!id) return fail(res, 400, '请提供曲目'), true
    if (!name.trim()) return fail(res, 400, '请提供新的文件名'), true
    let r: ReturnType<typeof renameTenantTrack>
    try { r = renameTenantTrack(userName, id, name) } catch (e: any) { return fail(res, 400, e?.message || '重命名失败'), true }
    const playlists = await migrateTrackRefs(userName, r.oldId, r.newId)
      .catch((err: any) => { console.error('migrate track refs error:', err?.message); return [] as string[] })
    ok(res, {
      track: { ...r.track, filePath: undefined },
      renamed: r.renamed,
      tagUpdated: r.tagUpdated,
      warning: r.warning,
      playlists,
    })
    return true
  }
  // 编辑标签：node-id3 的 update 是合并式写入，未提交的字段（含内嵌封面）原样保留
  if (method == 'POST' && p == '/web/api/tracks/tags') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const id = String(body?.id ?? '')
    if (!id) return fail(res, 400, '请提供曲目'), true
    const tags = body?.tags && typeof body.tags == 'object' ? body.tags : {}
    let r: ReturnType<typeof updateTenantTrackTags>
    try { r = updateTenantTrackTags(userName, id, tags) } catch (e: any) { return fail(res, 400, e?.message || '保存失败'), true }
    ok(res, { track: { ...r.track, filePath: undefined } })
    return true
  }
  if (method == 'GET' && p == '/web/api/albums') {
    const seed = tenantGroupingSeed(userName)
    ok(res, tenantListAlbums(userName, seed.tracks, seed.scannedAt, seed.maxMtime, {
      q: url.searchParams.get('q') ?? undefined,
      page: parseInt(url.searchParams.get('page') ?? '1', 10),
      size: parseInt(url.searchParams.get('size') ?? '60', 10),
    }))
    return true
  }
  if (method == 'GET' && p == '/web/api/artists') {
    const seed = tenantGroupingSeed(userName)
    ok(res, tenantListArtists(userName, seed.tracks, seed.scannedAt, seed.maxMtime, {
      q: url.searchParams.get('q') ?? undefined,
      page: parseInt(url.searchParams.get('page') ?? '1', 10),
      size: parseInt(url.searchParams.get('size') ?? '60', 10),
    }))
    return true
  }
  if (method == 'GET' && p == '/web/api/album') {
    const seed = tenantGroupingSeed(userName)
    const singer = url.searchParams.get('singer') ?? ''
    const album = url.searchParams.get('album') ?? ''
    ok(res, { singer, album, tracks: tenantAlbumTracks(userName, seed.tracks, seed.scannedAt, seed.maxMtime, singer, album).map(t => ({ ...t, filePath: undefined })) })
    return true
  }
  if (method == 'GET' && p == '/web/api/artist') {
    const seed = tenantGroupingSeed(userName)
    const singer = url.searchParams.get('singer') ?? ''
    ok(res, { singer, albums: tenantArtistAlbums(userName, seed.tracks, seed.scannedAt, seed.maxMtime, singer), tracks: tenantArtistTracks(userName, seed.tracks, seed.scannedAt, seed.maxMtime, singer).map(t => ({ ...t, filePath: undefined })) })
    return true
  }

  // ---------------- 为你推荐（按账户听歌喜好） ----------------
  // 旧实现是「今日推荐 = 按日期随机洗牌」「猜你喜欢 = 只看最近播放的歌手」，
  // 跟账户口味基本无关；现在改成真正的口味画像（library/for-you.ts）：
  //   播放历史（近因加权）+ 我喜欢 + 自建歌单 + 在线播放记录 → 歌手/专辑权重
  //   → 本地投票选题 + 按画像头部歌手去在线源补「你还没有的」新歌。
  // 结果按用户缓存 5 分钟，今日推荐用「日期+用户名」做种子（当天稳定、次日自动换）；
  // 第三方超时或失败自动退化为纯本地，首页不会因为在线源挂了而空掉。
  if (method == 'GET' && p == '/web/api/for-you') {
    ok(res, await forYou(userName))
    return true
  }

  // ---------------- 最近播放 ----------------
  if (method == 'GET' && p == '/web/api/played') {
    ok(res, { tracks: getPlayed(userName).map(t => ({ ...t, filePath: undefined })) })
    return true
  }
  if (method == 'POST' && p == '/web/api/played') {
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    recordPlayed(userName, String(body?.trackId ?? ''))
    ok(res, {})
    return true
  }

  // 在线曲目播放记录：在线曲目不在曲库索引里，走不了上面那条，
  // 但「听的是谁」是口味画像的关键信号，单独记一份（不参与同步）。
  if (method == 'POST' && p == '/web/api/played/online') {
    let body: any = {}
    try { body = parseJson(await readBody(req)) } catch { return fail(res, 400, '请求体异常'), true }
    const source = String(body?.source ?? '')
    const rid = String(body?.rid ?? '')
    if (!source || !rid) return fail(res, 400, '缺少 source/rid'), true
    recordPlayedOnline(userName, {
      source,
      rid,
      name: String(body?.name ?? ''),
      singer: String(body?.singer ?? ''),
      album: String(body?.album ?? ''),
    })
    ok(res, {})
    return true
  }

  // ---------------- 歌单 ----------------
  if (method == 'GET' && p == '/web/api/playlists') {
    ok(res, { playlists: await playlistSummary(userName) })
    return true
  }
  if (method == 'GET' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})$/.exec(p))) {
    const listId = seg[1]
    const data = await getListDataStable(userName)
    let musics: any[] | null = null
    let name = ''
    if (listId == LIST_IDS.DEFAULT) {
      musics = data.defaultList
      name = '我的歌单'
    } else if (listId == LIST_IDS.LOVE) {
      musics = data.loveList
      name = '我喜欢'
    } else {
      const target = data.userList.find(l => l.id == listId)
      if (target) {
        musics = target.list as any[]
        name = target.name
      }
    }
    if (!musics) return fail(res, 404, '歌单不存在'), true
    ok(res, { id: listId, name, tracks: musics.map(m => toWebMusic(userName, m)) })
    return true
  }
  if (method == 'POST' && p == '/web/api/playlists') {
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const name = String(body?.name ?? '').trim().substring(0, 60)
    if (!name) return fail(res, 400, '歌单名不能为空'), true
    try {
      const id = await createPlaylist(userName, name)
      ok(res, { id })
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }
  if (method == 'POST' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})\/rename$/.exec(p))) {
    const listId = seg[1]
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const name = String(body?.name ?? '').trim().substring(0, 60)
    if (!name) return fail(res, 400, '歌单名不能为空'), true
    try {
      await renamePlaylist(userName, listId, name)
      ok(res, {})
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }
  if (method == 'POST' && p == '/web/api/playlists/remove') {
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const ids = (Array.isArray(body?.ids) ? body.ids : []).map(String).filter((id: string) => id != LIST_IDS.DEFAULT && id != LIST_IDS.LOVE)
    if (!ids.length) return fail(res, 400, '没有可删除的歌单'), true
    await removePlaylists(userName, ids)
    ok(res, {})
    return true
  }
  if (method == 'POST' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})\/add$/.exec(p))) {
    const listId = seg[1]
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const trackIds = (Array.isArray(body?.trackIds) ? body.trackIds : []).map(String).slice(0, 500)
    if (!trackIds.length) return fail(res, 400, '请选择曲目'), true
    try {
      const added = await addTrackIds(userName, listId, trackIds)
      ok(res, { added })
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }
  if (method == 'POST' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})\/remove$/.exec(p))) {
    const listId = seg[1]
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const musicIds = (Array.isArray(body?.musicIds) ? body.musicIds : []).map(String).slice(0, 500)
    if (!musicIds.length) return fail(res, 400, '请选择曲目'), true
    await removeMusicIds(userName, listId, musicIds)
    ok(res, {})
    return true
  }
  if (method == 'POST' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})\/clear$/.exec(p))) {
    await clearPlaylist(userName, seg[1])
    ok(res, {})
    return true
  }
  // 歌单内排序（musicIds 为完整新顺序）
  if (method == 'POST' && (seg = /^\/web\/api\/playlists\/([\w-]{1,64})\/order$/.exec(p))) {
    const listId = seg[1]
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    const musicIds = (Array.isArray(body?.musicIds) ? body.musicIds : []).map(String)
    if (!musicIds.length) return fail(res, 400, '缺少排序数据'), true
    try {
      await overwritePlaylistOrder(userName, listId, musicIds)
      ok(res, {})
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }

  // ---------------- 版本信息 ----------------
  if (method == 'GET' && p == '/web/version') {
    let version = 'dev'
    try {
      version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || version
    } catch {}
    ok(res, { version })
    return true
  }

  // ---------------- 收藏 ----------------
  if (method == 'POST' && p == '/web/api/love/toggle') {
    let body: any
    try {
      body = parseJson(await readBody(req))
    } catch {
      return fail(res, 400, '请求体异常'), true
    }
    try {
      const loved = await toggleLove(userName, String(body?.trackId ?? ''))
      ok(res, { loved })
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }
  if (method == 'GET' && p == '/web/api/love-ids') {
    // 同样走稳定读取：否则冷启动时返回空集合，收藏心形会全部显示成未收藏
    const data = await getListDataStable(userName)
    ok(res, { ids: data.loveList.map(m => m.id) })
    return true
  }

  fail(res, 404, 'not found')
  return true
}
