import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

// ---------------------------------------------------------------------------
// 音频文件 HTTP 流式响应：支持 Range（播放进度条/seek）、HEAD、attachment 下载。
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ape': 'audio/ape',
  '.wma': 'audio/x-ms-wma',
}

export const audioMime = (filePath: string): string => MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'

const RX_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * @param attachment 提供文件名时按附件下载（Content-Disposition）
 */
export const serveAudio = async (req: http.IncomingMessage, res: http.ServerResponse, filePath: string, opts: { attachment?: string } = {}): Promise<void> => {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  const size = stat.size
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': audioMime(filePath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
  }
  if (opts.attachment) {
    const encoded = encodeURIComponent(opts.attachment)
    headers['Content-Disposition'] = `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
  }

  const method = req.method ?? 'GET'
  const range = req.headers.range
  const rangeMatch = typeof range == 'string' ? RX_RANGE.exec(range) : null
  let start = 0
  let end = size - 1

  if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
    if (rangeMatch[1]) {
      start = parseInt(rangeMatch[1], 10)
      if (rangeMatch[2]) end = Math.min(parseInt(rangeMatch[2], 10), size - 1)
    } else {
      // 后缀范围 bytes=-N → 最后 N 字节
      const suffix = parseInt(rangeMatch[2], 10)
      start = Math.max(0, size - suffix)
    }
    if (start >= size || start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(end - start + 1)
    res.writeHead(206, headers)
  } else {
    headers['Content-Length'] = String(size)
    res.writeHead(method == 'HEAD' ? 200 : 200, headers)
  }
  if (method == 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath, { start, end })
  stream.on('error', () => {
    stream.destroy()
    res.destroy()
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
