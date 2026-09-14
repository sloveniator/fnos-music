import http from 'node:http'
import https from 'node:https'

// ---------------------------------------------------------------------------
// 第三方 HTTP 流中转（在线源播放 / 在线下载）：把上游音视频流转发给浏览器，
// 透传 Range（seek/进度条）、Content-Type/Length；支持 HEAD。
//   asDownload=true 时追加 Content-Disposition: attachment，让浏览器按
//   filename 触发「另存为」而非内联播放（照抄洛雪/六音的在线下载模式）。
// ---------------------------------------------------------------------------

const UA = 'gusi-music-online/1.0 (lx-music-sync-server compatible)'

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/x-aac': '.aac',
}

const mimeToExt = (mime?: string | null): string => {
  if (!mime) return '.mp3'
  const base = String(mime).split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? '.mp3'
}

/**
 * 生成合法 Content-Disposition：ASCII filename + RFC 5987 filename* 兜底。
 * 注意 filename= 的值必须是 ASCII —— 中文歌名直接放进去会让 Node 在 writeHead 时
 * 抛「Invalid character in header content」，请求被中断，表现为「点下载没反应」。
 * 中文名统一放进 filename*=UTF-8''<pct-encoded>，浏览器优先采用它。
 */
const contentDisposition = (filename: string): string => {
  const safe = (filename || 'download').replace(/[^\w\u4e00-\u9fff._-]/g, '_').substring(0, 180) || 'download'
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(safe)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * @param target        上游 URL
 * @param extraHeaders  需要带的 Referer 等
 * @param opts.download 附加 Content-Disposition: attachment；filename 由
 *                      opts.filename 提供（未提供时按上游 Content-Type 推断扩展名）
 */
export interface PipeOptions { download?: boolean, filename?: string }

export const pipeHttpStream = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
  extraHeaders: Record<string, string> = {},
  opts: PipeOptions = {},
): void => {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    res.writeHead(400)
    res.end('Bad upstream url')
    return
  }
  if (url.protocol != 'http:' && url.protocol != 'https:') {
    res.writeHead(400)
    res.end('Bad upstream protocol')
    return
  }
  const method = req.method == 'HEAD' ? 'HEAD' : 'GET'
  const headers: http.OutgoingHttpHeaders = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    ...extraHeaders,
  }
  // 下载模式下不要透传 Range（浏览器下载一般不带 Range，带了会破坏整包保存）
  if (method != 'HEAD' && !opts.download && typeof req.headers.range == 'string' && /^bytes=/.test(req.headers.range)) {
    headers.Range = req.headers.range
  }

  // 上游给的「直链」多为跳转链接（如酷我 antiserver → CDN 节点），必须跟随 3xx：
  // 原样透传 302 时 <audio> 靠浏览器自动跳转仍能播放，但 a[download] 跳到跨源地址后
  // 会丢弃 download 属性并被当成内联播放，表现为「点了下载却没有文件」。
  const handleUpstream = (pr: http.IncomingMessage): void => {
    if (method == 'HEAD') {
      res.writeHead(pr.statusCode ?? 200, {
        'Content-Type': pr.headers['content-type'] ?? 'application/octet-stream',
        'Accept-Ranges': pr.headers['accept-ranges'] ?? 'bytes',
        'Content-Length': pr.headers['content-length'] ?? '',
      })
      res.end()
      pr.resume()
      return
    }
    const status = pr.statusCode ?? 502
    if (status >= 300 && status < 400) {
      // 还有 3xx 说明 Location 非法或超出跳数上限，此时没有可下载的内容
      res.writeHead(502)
      res.end('upstream redirect not followed')
      pr.resume()
      return
    }
    if (status >= 400 && status < 600) {
      res.writeHead(status)
      res.end()
      pr.resume()
      return
    }
    const ct = pr.headers['content-type'] ?? 'application/octet-stream'
    const outHeaders: Record<string, string> = {
      'Content-Type': ct,
      'Accept-Ranges': pr.headers['accept-ranges'] ?? 'bytes',
      'Content-Length': pr.headers['content-length'] ?? '',
      'Content-Range': pr.headers['content-range'] ?? '',
      'Cache-Control': 'private, max-age=60',
    }
    if (opts.download) {
      // 优先用上游返回的 Content-Disposition 文件名（部分接口会主动指定 .mp3）
      const upstreamCd = typeof pr.headers['content-disposition'] == 'string' ? pr.headers['content-disposition'] : ''
      let baseName = opts.filename?.trim() || ''
      if (!baseName) {
        // 从上游 Content-Disposition 里抠 filename= / filename*=UTF-8'' 值
        const f = /filename\s*=\s*"([^"]+)"/i.exec(upstreamCd) || /filename\s*=\s*([^;]+)/i.exec(upstreamCd)
        if (f) baseName = f[1].trim().replace(/^"|"$/g, '')
      }
      if (!baseName) {
        // 从上游 URL 路径末段抠（酷我 / QQ 直链一般以 .mp3 结尾）
        try {
          const tail = decodeURIComponent(new URL(target).pathname.split('/').filter(Boolean).pop() ?? '')
          if (tail && /\.[A-Za-z0-9]{2,5}$/.test(tail)) baseName = tail
        } catch {}
      }
      if (!baseName) baseName = 'download'
      // 若 basename 无扩展名则按 Content-Type 补齐
      if (!/\.[A-Za-z0-9]{2,5}$/.test(baseName)) baseName += mimeToExt(ct)
      outHeaders['Content-Disposition'] = contentDisposition(baseName)
    }
    try {
      res.writeHead(status, outHeaders)
    } catch (e) {
      // 兜底：任何非法响应头都不该变成 uncaughtException（连接会被直接掐断）
      res.writeHead(502)
      res.end('bad response headers: ' + (e as Error).message)
      pr.resume()
      return
    }
    pr.pipe(res)
  }

  // 跟随 3xx（最多 5 跳，仅限 http/https，相对 Location 按当前跳解析）
  let active: http.ClientRequest | null = null
  const requestOnce = (u: URL, hops: number): void => {
    const m = u.protocol == 'https:' ? https : http
    const rq = m.request(u, { method, headers, timeout: 15_000 }, (pr) => {
      const sc = pr.statusCode ?? 0
      const loc = typeof pr.headers.location == 'string' ? pr.headers.location : ''
      if (sc >= 300 && sc < 400 && loc && hops < 5) {
        let next: URL | null = null
        try { next = new URL(loc, u) } catch { next = null }
        if (next && (next.protocol == 'http:' || next.protocol == 'https:')) {
          active = null
          pr.resume()
          requestOnce(next, hops + 1)
          return
        }
      }
      handleUpstream(pr)
    })
    rq.on('timeout', () => rq.destroy(new Error('upstream timeout')))
    rq.on('error', () => {
      if (!res.headersSent) {
        try {
          res.writeHead(502)
          res.end('upstream error')
        } catch {}
      } else {
        res.destroy()
      }
    })
    active = rq
    rq.end()
  }
  res.on('close', () => { if (active) active.destroy() })
  requestOnce(url, 0)
}
