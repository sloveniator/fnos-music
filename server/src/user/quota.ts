// ---------------------------------------------------------------------------
// 用户网盘容量计算
//
//  容量策略：
//    - 起始（注册当年）：1 GB
//    - 每满一年 +2 GB（按 registrationYear 相对当前年份计算）
//    - 上限 10 GB
//    - 管理员可用 maxGb 手工覆盖（写入 users.json）
//
//  扫描目标：
//    - dataPath/library/<user>/**  （下载目录）
//    - dataPath/libraries/<user>/library.json 内 tracks.size 汇总（租户曲库）
//
//  返回：
//    { limitGb, effectiveGb, usedBytes, remainingBytes, note }
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { findRegisteredUser } from './register'

export interface QuotaInfo {
  limitGb: number         // 上限 10
  effectiveGb: number     // 依据规则算出的可容量（含 maxGb 覆盖）
  usedBytes: number
  remainingBytes: number
  note: string            // 说明文字，如 "第 3 年 / 上限 10GB / 已用 1.2GB"
}

const GB = 1024 * 1024 * 1024
const CAP_GB = 10
const BASE_GB = 1
const INCREMENT_GB = 2

export const QUOTA_RULE = {
  baseGb: BASE_GB,
  incrementGb: INCREMENT_GB,
  capGb: CAP_GB,
} as const

/** 计算某个用户的有效容量（GB） */
export const computeEffectiveGb = (
  registrationYear: number,
  maxGb: number | undefined,
  currentYear: number = new Date().getFullYear(),
): number => {
  if (maxGb !== undefined && maxGb > 0) {
    return Math.min(CAP_GB, maxGb)
  }
  const years = Math.max(0, currentYear - registrationYear)
  const gb = BASE_GB + years * INCREMENT_GB
  return Math.min(CAP_GB, gb)
}

/** 递归统计目录字节数（跳过 .part / 临时文件） */
const dirBytes = (root: string): number => {
  let total = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) }
  catch { return 0 }
  for (const ent of entries) {
    const full = path.join(root, ent.name)
    if (ent.isDirectory()) {
      total += dirBytes(full)
    } else if (ent.isFile()) {
      // 跳过下载临时文件
      if (/\.part$/i.test(ent.name)) continue
      if (ent.name.startsWith('.') && ent.name !== '.gitkeep') continue
      try { total += fs.statSync(full).size } catch { /* ignore */ }
    }
  }
  return total
}

/** 从租户曲库文件汇总 tracks.size */
const tenantLibraryBytes = (userName: string): number => {
  const file = path.join(global.lx.dataPath, 'libraries', userName, 'library.json')
  try {
    const text = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(text)
    const tracks = j && Array.isArray(j.tracks) ? j.tracks : []
    let total = 0
    for (const t of tracks) {
      if (t && typeof t.size === 'number' && t.size > 0) total += t.size
      else if (t && typeof t.size === 'string') {
        const n = parseInt(t.size, 10)
        if (Number.isFinite(n) && n > 0) total += n
      }
    }
    return total
  } catch { return 0 }
}

/** 主入口：获取用户配额信息 */
export const getQuota = (userName: string): QuotaInfo => {
  const reg = findRegisteredUser(userName)
  // 未注册用户（config.js 内置用户）也给出默认配额，避免前端拿到 undefined
  const effectiveGb = reg
    ? computeEffectiveGb(reg.registrationYear, reg.maxGb)
    : BASE_GB
  const limitGb = CAP_GB

  const downloadDir = path.join(global.lx.dataPath, 'library', userName)
  const downloadBytes = dirBytes(downloadDir)
  const tenantBytes = tenantLibraryBytes(userName)
  // 避免下载目录与租户库目录物理重叠导致重复计数：以较大者为准
  // 一般情况下两者指向不同目录；这里对 downloadBytes 与 tenantBytes 直接求和
  const usedBytes = downloadBytes + tenantBytes
  const remainingBytes = Math.max(0, effectiveGb * GB - usedBytes)

  const note = reg
    ? `第 ${new Date().getFullYear() - reg.registrationYear + 1} 年 / 上限 ${limitGb}GB / 当前配额 ${effectiveGb}GB / 已用 ${(usedBytes / GB).toFixed(2)}GB`
    : `内置用户 / 配额 ${effectiveGb}GB / 已用 ${(usedBytes / GB).toFixed(2)}GB`

  return { limitGb, effectiveGb, usedBytes, remainingBytes, note }
}

/** 供下载入队前使用的快捷判断：是否可以再放入 maxSizeBytes 的文件 */
export const canAcceptBytes = (userName: string, maxSizeBytes: number): boolean => {
  const q = getQuota(userName)
  return q.remainingBytes >= maxSizeBytes
}
