import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  getSettings, saveSettings, getStreamToken, verifyStreamToken, resetSecret,
  getTrack, getTracks, listTracks, searchTracks, libraryStats, getScanState, startScan, scheduleAutoScan,
} from '@/library'
import { serveAudio } from '@/library/stream'
import { extractCover, extractLyric } from '@/library/metadata'
import { enqueueDownload, cancelDownload, removeDownload, listDownloads, clearFinishedDownloads } from '@/library/download'
import { getTargetUsage } from '@/library/usage'
import { getAddress } from '@/utils/tools'
import { buildSourceScript } from './source-script'
import { resolveFromUserSources, listUserSources, saveUserSource, deleteUserSource, setUserSourceEnabled, testUserSource, getUserSource, readScript } from '@/online/user-source'
import { getTenantSettings, saveTenantSettings, startTenantScan, getTenantScanState, tenantLibraryStats, listTenants } from '@/library/tenant'

// ---------------------------------------------------------------------------
// 曲库 HTTP 层
//   公开（流媒体 token 鉴权）：/api/stream /api/cover /api/lyric /api/proxy /api/search
//   管理（X-Admin-Token，由 handleApi 调用）：/admin/api/library/*
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, code: number, data: unknown): void => {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

const ok = (res: http.ServerResponse, data: unknown): void => json(res, 200, { code: 0, data })
const fail = (res: http.ServerResponse, code: number, msg: string): void => json(res, code, { code: -1, msg })

// 音源脚本/流地址必须走 TCP 直连：fnOS 网关 /app/* 需要登录态，手机洛雪 App 无法通过
// 经网关访问时 Host 是网关地址，须换成局域网 IP + 服务端口
const directBase = (): string => {
  const port = global.lx.listenPort
  const addrs = getAddress()
  return `http://${addrs[0] ?? '127.0.0.1'}:${port}`
}

const baseFromReq = (req: http.IncomingMessage): string => {
  const host = req.headers.host
  if (host && /:\d+$/.test(host) && Number(host.split(':')[1]) === global.lx.listenPort) return `http://${host}`
  return directBase()
}

// ---------------------------------------------------------------------------
// 第三方音源代理：转发到管理后台配置的上游 API 模板（服务端不内置任何爬取逻辑）
// 模板占位符：{source} {id} {quality}；上游响应兼容 {code,data} / {url} / 纯文本 URL
// ---------------------------------------------------------------------------

const extractUrl = (payload: unknown): string | null => {
  if (typeof payload == 'string') {
    const s = payload.trim()
    return /^https?:\/\//.test(s) ? s : null
  }
  if (!payload || typeof payload != 'object') return null
  const obj = payload as Record<string, any>
  const candidates = [obj.data, obj.url, obj.src, obj.playUrl, obj.data?.url, obj.data?.playUrl, obj.data?.[0]]
  for (const c of candidates) {
    if (typeof c == 'string' && /^https?:\/\//.test(c.trim())) return c.trim()
  }
  return null
}

/** 解析第三方源播放直链（供 /api/proxy 与下载到 NAS 复用）
 *  解析顺序：服务端承载的第三方 JS 源（若启用且覆盖该平台）→ 旧「上游 API 模板」代理 */
export const resolveProxyUrl = async(source: string, id: string, quality: string): Promise<string> => {
  if (!/^[\w-]{1,32}$/.test(source) || !/^[\w|=-]{1,128}$/.test(id)) throw new Error('参数非法')
  // 1) 服务端第三方 JS 源（Web/移动共用）
  const attempt = await resolveFromUserSources(source, id, quality)
  if (attempt) return attempt.url
  // 2) 上游 API 模板
  const settings = getSettings()
  if (!settings.proxyUrl) throw new Error('未配置上游音源 API，且未启用覆盖该平台的服务端第三方源（管理后台「音源与代理」）')
  const target = settings.proxyUrl
    .replace(/\{source\}/g, encodeURIComponent(source))
    .replace(/\{id\}/g, encodeURIComponent(id))
    .replace(/\{quality\}/g, encodeURIComponent(quality))
  if (!/^https?:\/\//.test(target)) throw new Error('上游 API 模板非法')
  const resp = await fetch(target, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'gusi-music-proxy/1.0', Accept: 'application/json, text/plain, */*' },
  })
  if (!resp.ok) throw new Error(`上游返回 HTTP ${resp.status}`)
  const text = await resp.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {}
  const playUrl = extractUrl(payload)
  if (!playUrl) throw new Error('上游响应中未找到播放地址')
  return playUrl
}

const handleProxy = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
  const source = url.searchParams.get('source') ?? ''
  const id = url.searchParams.get('id') ?? ''
  const quality = url.searchParams.get('q') ?? '128k'
  try {
    ok(res, await resolveProxyUrl(source, id, quality))
  } catch (err: any) {
    fail(res, 502, err?.message ?? String(err))
  }
}

/** 公开流媒体 API（token 鉴权）。返回 true 表示已处理。 */
export const handleLibraryRequest = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  const p = url.pathname
  if (!p.startsWith('/api/')) return false
  if (!verifyStreamToken(url.searchParams.get('k'))) {
    fail(res, 403, '无效的访问令牌')
    return true
  }

  let seg: RegExpExecArray | null
  if ((seg = /^\/api\/stream\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在（可能已重新扫描）')
      return true
    }
    await serveAudio(req, res, track.filePath)
    return true
  }

  if ((seg = /^\/api\/download\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在')
      return true
    }
    await serveAudio(req, res, track.filePath, { attachment: `${track.name}${path.extname(track.filePath)}` })
    return true
  }

  if ((seg = /^\/api\/cover\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track?.hasCover) {
      res.writeHead(404)
      res.end()
      return true
    }
    void extractCover(track.filePath).then(pic => {
      if (!pic) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': pic.mime, 'Content-Length': String(pic.data.length), 'Cache-Control': 'public, max-age=86400' })
      res.end(pic.data)
    }).catch(() => {
      res.writeHead(500)
      res.end()
    })
    return true
  }

  if ((seg = /^\/api\/lyric\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在')
      return true
    }
    void extractLyric(track.filePath).then(lyric => {
      ok(res, { lyric: lyric ?? '', tlyric: null, rlyric: null, lxlyric: null })
    }).catch(() => fail(res, 500, '歌词读取失败'))
    return true
  }

  if (p == '/api/proxy') {
    await handleProxy(req, res, url)
    return true
  }

  if (p == '/api/search') {
    ok(res, searchTracks(url.searchParams.get('q') ?? '', parseInt(url.searchParams.get('limit') ?? '50', 10)))
    return true
  }

  fail(res, 404, 'not found')
  return true
}

// ---------------------------------------------------------------------------
// 管理 API（handleApi 认证后调用）。返回 true 表示已处理。
// ---------------------------------------------------------------------------

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

export const handleLibraryAdmin = async(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method ?? 'GET'
  if (!p.startsWith('/admin/api/library')) return false

  if (method == 'GET' && p == '/admin/api/library/stats') {
    ok(res, { ...libraryStats(), settings: getSettings(), tokenPreview: getStreamToken().substring(0, 8), scan: getScanState() })
    return true
  }

  if (method == 'GET' && p == '/admin/api/library/settings') {
    ok(res, getSettings())
    return true
  }

  // fnOS 系统授权目录（应用中心 → 设置 → 授权目录 下发，供音乐库目录快捷选择）
  if (method == 'GET' && p == '/admin/api/library/system-dirs') {
    // 优先读快照文件（config_callback 在授权变更时重写），实现免重启热生效
    let raw = ''
    const snapshotFile = process.env.GS_ACCESSIBLE_PATHS_FILE
    if (snapshotFile) {
      try {
        const text = fs.readFileSync(snapshotFile, 'utf8')
        const m = /^TRIM_DATA_ACCESSIBLE_PATHS='([\s\S]*?)'$/m.exec(text)
        if (m) raw = m[1]
      } catch {}
    }
    if (!raw) raw = process.env.GS_ACCESSIBLE_PATHS ?? process.env.TRIM_DATA_ACCESSIBLE_PATHS ?? ''
    const dirs = raw.split(':').map(s => s.trim()).filter(Boolean)
    ok(res, { dirs })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/settings') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    const patch: Record<string, unknown> = {}
    if (Array.isArray(body.dirs)) patch.dirs = body.dirs.map((d: unknown) => String(d).trim()).filter(Boolean).slice(0, 32)
    if (typeof body.proxyUrl == 'string') patch.proxyUrl = body.proxyUrl.trim()
    if (Array.isArray(body.proxySources)) patch.proxySources = (body.proxySources as unknown[]).map((s: unknown) => String(s)).filter((s: string) => ['wy', 'kw', 'tx', 'kg', 'mg'].includes(s))
    if (typeof body.autoScanAfterDownload == 'boolean') patch.autoScanAfterDownload = body.autoScanAfterDownload
    if (Array.isArray(body.onlineSources)) patch.onlineSources = (body.onlineSources as unknown[]).map((s: unknown) => String(s)).filter((s: string) => ['kw', 'wy', 'mg', 'soda'].includes(s))
    ok(res, saveSettings(patch))
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/scan') {
    if (getScanState().scanning) {
      fail(res, 409, '扫描正在进行中')
      return true
    }
    if (!getSettings().dirs.length) {
      fail(res, 400, '请先添加音乐目录')
      return true
    }
    startScan()
    ok(res, getScanState())
    return true
  }

  // 上传音频文件到曲库目录（原始字节流，PUT；扩展名白名单 + 路径防逃逸）
  if (method == 'PUT' && p == '/admin/api/library/upload') {
    const name = String(url.searchParams.get('name') ?? '').trim()
    const sub = String(url.searchParams.get('dir') ?? '').trim()
    if (!name) {
      fail(res, 400, '缺少文件名 (?name=xxx.flac)')
      return true
    }
    const ext = path.extname(name).toLowerCase().replace(/^\./, '')
    const AUDIO_EXT = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'ape', 'wma'])
    if (!AUDIO_EXT.has(ext)) {
      fail(res, 400, '仅支持音频文件: ' + [...AUDIO_EXT].join(' / '))
      return true
    }
    const dirs = getSettings().dirs
    if (!dirs.length) {
      fail(res, 400, '请先在「音乐库」添加曲库目录')
      return true
    }
    let targetDir = path.resolve(dirs[0])
    if (sub) {
      // 只允许一层相对子目录，防路径穿越
      const safeSub = sub.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
      if (!safeSub || /^[\.\s]+$/.test(safeSub) || /^[\/]/.test(sub) || sub.includes('..')) {
        fail(res, 400, '子目录非法')
        return true
      }
      targetDir = path.join(targetDir, safeSub)
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true })
    } catch {
      fail(res, 500, '无法创建目标目录')
      return true
    }
    // 文件名清洗（保中文/字母/数字/空格/连字符，去路径分隔符与危险字符）
    const safeName = path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || ('upload_' + Date.now() + '.' + ext)
    const finalPath = path.join(targetDir, safeName)
    const tmpPath = finalPath + '.uploading-' + process.pid
    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath, { flags: 'w' })
        req.pipe(out)
        req.on('error', (e: Error) => { out.destroy(); reject(e) })
        out.on('error', (e: Error) => { req.unpipe(out); reject(e) })
        out.on('finish', () => resolve())
      })
      fs.renameSync(tmpPath, finalPath)
      // 入库：若目标目录是已配置的曲库扫描目录（或其子目录），增量扫描立即收录
      try {
        scheduleAutoScan(finalPath)
      } catch { /* ignore */ }
      ok(res, { filePath: finalPath, scanned: getSettings().autoScanAfterDownload !== false, dirs: getSettings().dirs })
    } catch (err: any) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
      fail(res, 500, '写入失败: ' + (err?.message ?? String(err)))
    }
    return true
  }

  if (method == 'GET' && p == '/admin/api/library/tracks') {
    ok(res, listTracks({
      q: url.searchParams.get('q') ?? undefined,
      page: parseInt(url.searchParams.get('page') ?? '1', 10),
      size: parseInt(url.searchParams.get('size') ?? '50', 10),
    }))
    return true
  }

  if (method == 'GET' && p == '/admin/api/library/stream-token') {
    ok(res, { token: getStreamToken() })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/stream-token/reset') {
    resetSecret()
    ok(res, { token: getStreamToken() })
    return true
  }

  let seg: RegExpExecArray | null
  if ((seg = /^\/admin\/api\/library\/track\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在')
      return true
    }
    ok(res, track)
    return true
  }

  // 管理端试听/下载：直接走曲库路径（admin token 已验证）
  if ((seg = /^\/admin\/api\/library\/preview\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在')
      return true
    }
    await serveAudio(req, res, track.filePath)
    return true
  }
  if ((seg = /^\/admin\/api\/library\/download\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track) {
      fail(res, 404, '曲目不存在')
      return true
    }
    await serveAudio(req, res, track.filePath, { attachment: `${track.name}${path.extname(track.filePath)}` })
    return true
  }
  if ((seg = /^\/admin\/api\/library\/cover\/([\w-]{1,64})$/.exec(p))) {
    const track = getTrack(seg[1])
    if (!track?.hasCover) {
      res.writeHead(404)
      res.end()
      return true
    }
    try {
      const pic = await extractCover(track.filePath)
      if (!pic) {
        res.writeHead(404)
        res.end()
        return true
      }
      res.writeHead(200, { 'Content-Type': pic.mime, 'Content-Length': String(pic.data.length), 'Cache-Control': 'public, max-age=86400' })
      res.end(pic.data)
    } catch {
      res.writeHead(500)
      res.end()
    }
    return true
  }

  // 导出 .lxmc 歌单（playListPart_v2，手机端「我的歌单 → 导入」直接可用）
  if (method == 'POST' && p == '/admin/api/library/export') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : []
    const name = String(body.name ?? '古四音乐').trim() || '古四音乐'
    let list = getTracks()
    if (ids.length) {
      const idSet = new Set(ids)
      list = list.filter(t => idSet.has(t.id))
    }
    if (!list.length) {
      fail(res, 400, '没有可导出的曲目')
      return true
    }
    const musicInfos = list.map(t => ({
      id: `local_${t.id}`,
      name: t.name,
      singer: t.singer || '未知歌手',
      source: 'local',
      interval: t.interval,
      meta: {
        songId: t.id,
        albumName: t.album,
        picUrl: '',
        filePath: t.id,
        ext: t.ext,
      },
    }))
    const payload = {
      type: 'playListPart_v2',
      data: {
        id: 'userlist_gusi_' + Date.now().toString(36),
        name,
        sourceListId: null,
        listMeta: {},
        list: musicInfos,
      },
    }
    const encoded = encodeURIComponent(`${name}.lxmc`)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gusi-library.lxmc"; filename*=UTF-8''${encoded}`,
    })
    res.end(JSON.stringify(payload))
    return true
  }

  // ---------------- 下载目标管理 ----------------
  if (method == 'GET' && p == '/admin/api/library/targets') {
    const targets = getSettings().downloadTargets.map(t => ({
      id: t.id, name: t.name, type: t.type, path: t.path ?? '', url: t.url ?? '', username: t.username ?? '',
      hasPassword: !!t.password,
    }))
    ok(res, { targets, autoScanAfterDownload: getSettings().autoScanAfterDownload })
    return true
  }

  if (method == 'GET' && p == '/admin/api/library/targets/usage') {
    const list = getSettings().downloadTargets
    const usage: Record<string, { free: number | null, total: number | null }> = {}
    await Promise.all(list.map(async t => {
      usage[t.id] = await getTargetUsage(t)
    }))
    ok(res, { usage })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/targets') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    if (!Array.isArray(body.targets)) {
      fail(res, 400, 'targets 需为数组')
      return true
    }
    const old = getSettings().downloadTargets
    // 密码留空时保留同 id 旧密码（编辑不回填明文）
    const merged = (body.targets as any[]).map(t => {
      if (t?.type == 'webdav' && !t.password) {
        const prev = old.find(o => o.id == t.id)
        if (prev?.password) return { ...t, password: prev.password }
      }
      return t
    })
    saveSettings({ downloadTargets: merged })
    const targets = getSettings().downloadTargets.map(t => ({
      id: t.id, name: t.name, type: t.type, path: t.path ?? '', url: t.url ?? '', username: t.username ?? '',
      hasPassword: !!t.password,
    }))
    ok(res, { targets })
    return true
  }

  // ---------------- 下载任务 ----------------
  if (method == 'GET' && p == '/admin/api/library/downloads') {
    ok(res, { tasks: listDownloads() })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/downloads/clear') {
    ok(res, { removed: clearFinishedDownloads() })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/downloads') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    try {
      let task
      if (body.trackId) {
        task = enqueueDownload({ kind: 'track', trackId: String(body.trackId), targetId: String(body.targetId ?? ''), subdir: body.subdir ? String(body.subdir) : undefined, filename: body.filename ? String(body.filename) : undefined })
      } else if (body.source && body.songId) {
        const playUrl = await resolveProxyUrl(String(body.source), String(body.songId), String(body.quality ?? '128k'))
        task = enqueueDownload({ kind: 'url', url: playUrl, targetId: String(body.targetId ?? ''), subdir: body.subdir ? String(body.subdir) : undefined, filename: body.filename ? String(body.filename) : undefined })
      } else if (body.url) {
        task = enqueueDownload({ kind: 'url', url: String(body.url), targetId: String(body.targetId ?? ''), subdir: body.subdir ? String(body.subdir) : undefined, filename: body.filename ? String(body.filename) : undefined })
      } else {
        fail(res, 400, '缺少 trackId / url / (source+songId)')
        return true
      }
      ok(res, task)
    } catch (err: any) {
      fail(res, 400, err?.message ?? String(err))
    }
    return true
  }

  if ((seg = /^\/admin\/api\/library\/downloads\/([\w-]{1,32})\/cancel$/.exec(p)) && method == 'POST') {
    ok(res, { cancelled: cancelDownload(seg[1]) })
    return true
  }
  if ((seg = /^\/admin\/api\/library\/downloads\/([\w-]{1,32})$/.exec(p)) && method == 'DELETE') {
    ok(res, { removed: removeDownload(seg[1]) })
    return true
  }

  // 生成音源脚本（base 用当前请求 Host，确保手机可达）
  if (method == 'GET' && p == '/admin/api/library/source-script') {
    const proxyParam = url.searchParams.get('proxy')
    const sources = proxyParam === '' ? [] : proxyParam ? proxyParam.split(',').map(s => s.trim()).filter(Boolean) : getSettings().proxySources
    const script = buildSourceScript(baseFromReq(req), sources)
    if (url.searchParams.get('download')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="gusi-user-source.js"' })
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end(script)
    return true
  }

  // ---------------- 服务端第三方 JS 音源（做法2：worker 沙箱承载） ----------------
  // 第三方源脚本可大到 300KB+（混淆整包），用独立的大体 reader
  const readBigBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 900 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  if (method == 'GET' && p == '/admin/api/library/user-sources') {
    ok(res, { list: listUserSources() })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/user-sources') {
    let body: any
    try {
      body = JSON.parse(await readBigBody(req))
    } catch (e: any) {
      fail(res, 400, e?.message?.includes('too large') ? '脚本过大' : 'invalid body')
      return true
    }
    const r = saveUserSource({ id: body.id, name: body.name, script: body.script, enabled: typeof body.enabled == 'boolean' ? body.enabled : undefined })
    if (r.error) {
      fail(res, 400, r.error)
      return true
    }
    // 启用即后台预热：脚本启动 + inited 采集能力（不阻塞保存响应）
    if (r.meta.enabled) {
      setUserSourceEnabled(r.meta.id, true).catch(() => {})
    }
    ok(res, r.meta)
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/user-sources/enable') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    const r = await setUserSourceEnabled(String(body.id ?? ''), body.enabled === true)
    if (!r.ok) {
      fail(res, 400, r.error ?? '操作失败')
      return true
    }
    ok(res, { id: body.id, enabled: body.enabled === true, capabilities: r.capabilities })
    return true
  }

  if (method == 'POST' && p == '/admin/api/library/user-sources/test') {
    let body: any
    try {
      body = JSON.parse(await readBigBody(req))
    } catch (e: any) {
      fail(res, 400, e?.message?.includes('too large') ? '脚本过大' : 'invalid body')
      return true
    }
    try {
      const r = await testUserSource({
        id: body.id ? String(body.id) : undefined,
        name: body.name ? String(body.name) : undefined,
        script: body.script ? String(body.script) : undefined,
        probe: body.probe ? { source: String(body.probe.source ?? ''), id: String(body.probe.id ?? ''), type: body.probe.type ? String(body.probe.type) : '128k' } : undefined,
      })
      ok(res, r)
    } catch (e: any) {
      fail(res, 400, e?.message ?? String(e))
    }
    return true
  }


  // 从网址导入脚本：服务端代取（浏览器直连会被 CORS / 源站 UA 校验挡下）
  if (method == 'POST' && p == '/admin/api/library/user-sources/fetch') {
    let body: any
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    const raw = String(body.url ?? '').trim()
    if (!/^https?:\/\/\S+$/i.test(raw)) {
      fail(res, 400, '请填写 http/https 脚本直链')
      return true
    }
    const FETCH_MAX = 2 * 1024 * 1024
    const doFetch = async (u: string) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 20000)
      try {
        const resp = await fetch(u, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept': '*/*',
          },
        })
        if (!resp.ok) throw new Error('HTTP ' + resp.status)
        const buf = Buffer.from(await resp.arrayBuffer())
        if (!buf.length) throw new Error('返回内容为空')
        if (buf.length > FETCH_MAX) throw new Error('脚本过大（>2MB）')
        const text = buf.toString('utf8')
        const head = text.slice(0, 500)
        if (/<html[\s>]/i.test(head) || /^\s*<!doctype/i.test(head)) throw new Error('返回的是网页而非脚本，请改用 raw 直链')
        let name = ''
        try {
          const pn = decodeURIComponent(new URL(resp.url || u).pathname)
          name = (pn.split('/').filter(Boolean).pop() || '').replace(/\.(js|mjs|txt)$/i, '').slice(0, 60)
        } catch {}
        return { finalUrl: resp.url || u, size: buf.length, name, script: text }
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      let got: any
      try {
        got = await doFetch(raw)
      } catch (e1: any) {
        // http 源站常常只支持 https，原样失败后再升一次
        if (/^http:\/\//i.test(raw)) got = await doFetch(raw.replace(/^http:\/\//i, 'https://'))
        else throw e1
      }
      ok(res, got)
    } catch (e: any) {
      fail(res, 400, '导入失败：' + (e?.name === 'AbortError' ? '下载超时（20 秒）' : (e?.message || String(e))))
    }
    return true
  }

  if ((seg = /^\/admin\/api\/library\/user-sources\/([\w-]{1,40})$/.exec(p)) && method == 'GET') {
    const m = getUserSource(seg[1])
    const script = readScript(seg[1])
    if (!m) {
      fail(res, 404, '源不存在')
      return true
    }
    ok(res, { ...m, script })
    return true
  }

  if ((seg = /^\/admin\/api\/library\/user-sources\/([\w-]{1,40})$/.exec(p)) && method == 'DELETE') {
    ok(res, { removed: deleteUserSource(seg[1]) })
    return true
  }

  // ---------------- UPGRADE_0020：Web 用户租户曲库 ----------------
  // GET /admin/api/library/users —— 列出所有用户的租户曲库概况
  if (method == 'GET' && p == '/admin/api/library/users') {
    const allUsers = (global.lx.config.users || [])
      .map(u => {
        const safeName = (u.name || '').replace(/[^A-Za-z0-9_.-]/g, '_').substring(0, 64) || 'default'
        return {
          name: u.name,
          safeName,
          settings: getTenantSettings(u.name),
          stats: tenantLibraryStats(u.name),
          scan: getTenantScanState(u.name),
        }
      })
    ok(res, { users: allUsers, tenants: listTenants() })
    return true
  }

  // GET /admin/api/library/user-settings/:name
  const segUs = /^\/admin\/api\/library\/user-settings\/([^\/]{1,64})$/.exec(p)
  if (segUs && method == 'GET') {
    const name = decodeURIComponent(segUs[1])
    if (!global.lx.config.users.some(u => u.name == name)) {
      fail(res, 404, '该用户不存在')
      return true
    }
    ok(res, { name, settings: getTenantSettings(name), stats: tenantLibraryStats(name), scan: getTenantScanState(name) })
    return true
  }

  // POST /admin/api/library/user-settings/:name  {dirs: string[]}
  if (segUs && method == 'POST') {
    const name = decodeURIComponent(segUs[1])
    if (!global.lx.config.users.some(u => u.name == name)) {
      fail(res, 404, '该用户不存在')
      return true
    }
    let body: any
    try { body = JSON.parse(await readBody(req)) } catch {
      fail(res, 400, 'invalid body')
      return true
    }
    const dirs: string[] = Array.isArray(body.dirs)
      ? body.dirs.map((d: unknown) => String(d).trim()).filter(Boolean)
      : []
    if (dirs.length > 32) {
      fail(res, 400, '目录数量超过上限（32）')
      return true
    }
    ok(res, { name, settings: saveTenantSettings(name, { dirs }) })
    return true
  }

  // POST /admin/api/library/user-scan/:name
  const segScan = /^\/admin\/api\/library\/user-scan\/([^\/]{1,64})$/.exec(p)
  if (segScan && method == 'POST') {
    const name = decodeURIComponent(segScan[1])
    if (!global.lx.config.users.some(u => u.name == name)) {
      fail(res, 404, '该用户不存在')
      return true
    }
    const r = startTenantScan(name)
    if (!r.accepted) {
      fail(res, 409, r.reason ?? '无法启动扫描')
      return true
    }
    ok(res, { name, scan: r.scanState })
    return true
  }

  // GET /admin/api/library/user-scan/:name —— 轮询扫描状态
  if (segScan && method == 'GET') {
    const name = decodeURIComponent(segScan[1])
    ok(res, { name, scan: getTenantScanState(name) })
    return true
  }

  // GET /admin/api/library/user-stats/:name
  const segStats = /^\/admin\/api\/library\/user-stats\/([^\/]{1,64})$/.exec(p)
  if (segStats && method == 'GET') {
    const name = decodeURIComponent(segStats[1])
    if (!global.lx.config.users.some(u => u.name == name)) {
      fail(res, 404, '该用户不存在')
      return true
    }
    ok(res, { name, stats: tenantLibraryStats(name), scan: getTenantScanState(name) })
    return true
  }

  fail(res, 404, 'not found')
  return true
}
