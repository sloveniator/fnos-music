#!/usr/bin/env node
/**
 * 古四音乐 · Logo 生成器（共享模块）
 * 设计：古钱币「外圆内方」× 黑胶唱片 —— 墨蓝圆角底 + 金色钱环唱片纹 + 方孔内播放三角
 * 纯像素绘制 + 4x 超采样抗锯齿，无第三方依赖；PNG 编码手写（zlib）
 */
'use strict'
const zlib = require('node:zlib')

// ---------- 颜色工具 ----------
const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]

// 调色板
const BG_TOP = [0x1d, 0x28, 0x38]      // 墨蓝（上）
const BG_BOT = [0x0c, 0x12, 0x1a]      // 近黑（下）
const DISC = [0x25, 0x33, 0x47]        // 钱体/唱片
const DISC_HI = [0x2d, 0x3e, 0x55]     // 唱片高光弧
const GOLD = [0xc9, 0xa0, 0x5e]        // 古铜金
const GOLD_HI = [0xe3, 0xc2, 0x85]     // 亮金
const GROOVE = [0x1a, 0x24, 0x33]      // 纹路（暗）

/**
 * 场景着色：坐标以中心为原点（-0.5..0.5），返回 [r,g,b,a]（0..255）
 */
function shade(nx, ny) {
  // 圆角矩形底（半径 22%），外缘透明
  const rad = 0.22
  const ax = Math.abs(nx), ay = Math.abs(ny)
  const qx = ax - (0.5 - rad), qy = ay - (0.5 - rad)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad
  if (outside > 0.004) return [0, 0, 0, 0]
  const bgEdge = outside > -0.004 ? (outside + 0.004) / 0.008 : 0 // 边缘羽化
  let c = mix(BG_TOP, BG_BOT, ny + 0.5)
  let alpha = 255 * (1 - bgEdge)

  const r = Math.hypot(nx, ny)

  // ---- 唱片/钱体 ----
  const R_OUT = 0.375, R_RING = 0.030
  if (r <= R_OUT) {
    c = DISC.slice()
    // 左上高光弧（斜向渐变）
    const hi = Math.max(0, 1 - Math.hypot(nx - 0.14, ny + 0.15) / 0.42)
    c = mix(c, DISC_HI, hi * 0.5)
    // 唱片纹路：三圈细环
    for (const gr of [0.335, 0.295, 0.255]) {
      if (Math.abs(r - gr) < 0.006) c = mix(c, GROOVE, 0.85)
    }
    // 外缘金环
    if (r >= R_OUT - R_RING) {
      const t = (r - (R_OUT - R_RING)) / R_RING
      const gold = mix(GOLD, GOLD_HI, Math.max(0, 1 - Math.abs(t - 0.45) * 2.4))
      c = gold
      if (r >= R_OUT - 0.004) c = mix(c, BG_BOT, (r - (R_OUT - 0.004)) / 0.004) // 外沿收口
    }
    alpha = 255 * (1 - bgEdge)
  }

  // ---- 方孔（外圆内方）----
  const H = 0.145, HB = 0.020 // 孔半宽 / 金边宽
  const sq = Math.max(ax, ay)
  if (sq <= H + HB) {
    if (sq > H) {
      // 孔沿金边
      const t = (sq - H) / HB
      c = mix(GOLD_HI, GOLD, t)
    } else {
      // 孔内：透出底色（更深）
      c = mix(BG_TOP, BG_BOT, ny + 0.5).map(v => v * 0.72)
    }
    alpha = 255 * (1 - bgEdge)
  }

  // ---- 播放三角（孔内，指向右）----
  const tx = nx, ty = ny
  const TW = 0.062, TH = 0.085, TIP = 0.085
  if (tx > -TW - 0.01 && tx < TIP + 0.01 && Math.abs(ty) < TH + 0.01) {
    // 三角形内部判定：左边竖直边 x=-TW，顶点 (TIP,0)
    const inTri = tx >= -TW && tx <= TIP && Math.abs(ty) <= (TH * (1 - (tx + TW) / (TIP + TW)))
    if (inTri) {
      c = mix(GOLD, GOLD_HI, 0.55)
      alpha = 255 * (1 - bgEdge)
    }
  }

  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(alpha)]
}

/** 生成 size×size PNG（4x 超采样抗锯齿） */
function makeIcon(size, ss = 4) {
  const S = size * ss
  const buf = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [r, g, b, a] = shade((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5)
      const o = (y * S + x) * 4
      // 预乘存储便于降采样
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a
    }
  }
  // 降采样（面积平均，alpha 加权）
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0 // filter none
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const o = ((y * ss + sy) * S + (x * ss + sx)) * 4
          const a = buf[o + 3]
          R += buf[o] * a; G += buf[o + 1] * a; B += buf[o + 2] * a; A += a
        }
      }
      const o = y * (1 + size * 4) + 1 + x * 4
      if (A === 0) { raw[o] = raw[o + 1] = raw[o + 2] = raw[o + 3] = 0; continue }
      raw[o] = Math.round(R / A); raw[o + 1] = Math.round(G / A); raw[o + 2] = Math.round(B / A)
      raw[o + 3] = Math.round(A / (ss * ss))
    }
  }
  return pngEncode(raw, size)
}

function pngEncode(raw, size) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc)
    return Buffer.concat([len, body, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

module.exports = { makeIcon }

// 直接运行：输出预览图到 cmp/
if (require.main === module) {
  const fs = require('node:fs')
  for (const s of [256, 64, 32]) {
    fs.writeFileSync(`../..//cmp/logo-preview-${s}.png`, makeIcon(s))
    console.log('preview', s)
  }
}
