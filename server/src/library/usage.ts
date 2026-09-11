import fsp from 'node:fs/promises'
import type { DownloadTarget } from './index'

// ---------------------------------------------------------------------------
// 下载目标剩余空间探测
//   local  —— fs.statfs（含 fnOS 已挂载的 WebDAV/网盘挂载点）
//   webdav —— PROPFIND 请求 DAV 配额属性（quota-available-bytes / quota-used-bytes）
//             非必需属性，服务器不支持时返回 null，UI 显示「—」
// ---------------------------------------------------------------------------

export interface TargetUsage { free: number | null, total: number | null }

const localUsage = async (target: DownloadTarget): Promise<TargetUsage> => {
  try {
    const s = await fsp.statfs(target.path ?? '/')
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    return { free, total }
  } catch {
    return { free: null, total: null }
  }
}

const RX_AVAILABLE = /<[^>]*quota-available-bytes[^>]*>\s*(\d+)\s*</i
const RX_USED = /<[^>]*quota-used-bytes[^>]*>\s*(\d+)\s*</i

const webdavUsage = async (target: DownloadTarget): Promise<TargetUsage> => {
  if (!target.url) return { free: null, total: null }
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml',
    Depth: '0',
    'User-Agent': 'gusi-music-usage/1.0',
  }
  if (target.username) {
    headers.Authorization = 'Basic ' + Buffer.from(`${target.username}:${target.password ?? ''}`).toString('base64')
  }
  try {
    const resp = await fetch(target.url, {
      method: 'PROPFIND',
      headers,
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return { free: null, total: null }
    const text = await resp.text()
    const avail = RX_AVAILABLE.exec(text)
    const used = RX_USED.exec(text)
    if (!avail) return { free: null, total: null }
    const free = parseInt(avail[1], 10)
    const total = used ? free + parseInt(used[1], 10) : null
    return { free: isFinite(free) ? free : null, total: isFinite(total as number) ? total : null }
  } catch {
    return { free: null, total: null }
  }
}

export const getTargetUsage = async (target: DownloadTarget): Promise<TargetUsage> =>
  target.type == 'webdav' ? webdavUsage(target) : localUsage(target)
