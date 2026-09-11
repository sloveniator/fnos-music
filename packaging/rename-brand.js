#!/usr/bin/env node
/**
 * 品牌改名：洛雪云音乐(lxm) → 古四音乐(gusi)
 * 范围：fnos-music 自有代码（server/src、ui、build 无扩展名脚本、packaging 工具、README、mobile 元数据）
 * 禁区：node_modules、编译产物、上游协议命名（LX_USER_、global.lx、mobile 内部 LXM_FILE_EXT_RXP/lxm.* 常量）
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

// 有序规则：长串在前，避免子串误替换
const RULES = [
  ['洛雪云音乐', '古四音乐'],
  ['lxm.cloud.music', 'gusi.music'],
  ['lxm-cloud-music', 'gusi-music'],
  ['lxm-cloud-mobile', 'gusi-music-mobile'],
  ['lxm-cloud', 'gusi-music'],
  ['userlist_lxm_', 'userlist_gusi_'],
  ['lxm-user-source.js', 'gusi-user-source.js'],
  ['lxm-library', 'gusi-library'],
  ['lxm-stream-v1', 'gusi-stream-v1'],
  ['lxm-smoke', 'gusi-smoke'],
  ['lxm-dl-', 'gusi-dl-'],
  ['lxm-web-token', 'gusi-web-token'],
  ['lxm-admin-token', 'gusi-admin-token'],
  ['lxm-server-name', 'gusi-server-name'],
  ['lxm-mode', 'gusi-mode'],
  ['lxm-vol', 'gusi-vol'],
  ['LXM_', 'GS_'], // 仅服务端/脚本自有 env；mobile 目录不走此规则
]

const files = []
function walk(dir, opts = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (/node_modules|[.]git$|^out$|^verify$|^server$/.test(e.name) && !(opts.mobile)) continue
      if (f.includes(path.join('server', 'server'))) continue // 编译产物
      walk(f, opts)
    } else if (opts.mobile) {
      if (/^(app[.]json|package[.]json)$/.test(e.name)) files.push(f)
    } else {
      files.push(f)
    }
  }
}

// 服务端/前端/打包/文档
const targets = []
function collect(dir, filter) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (/node_modules|[.]git$/.test(e.name)) continue
      if (/[\\/]server[\\/]server$/.test(f)) continue // tsc 产物
      if (/[\\/]packaging[\\/](out|verify)$/.test(f)) continue
      collect(f, filter)
    } else if (filter(e.name)) targets.push(f)
  }
}
collect(path.join(ROOT, 'server', 'src'), n => /\.(ts|js|json|md)$/.test(n))
collect(path.join(ROOT, 'ui'), n => /\.(html|js|css|json)$/.test(n))
collect(path.join(ROOT, 'build'), () => true) // cmd/config/wizard 无扩展名
collect(path.join(ROOT, 'packaging'), n => /\.(js|ps1|mjs)$/.test(n) && n !== 'rename-brand.js')
targets.push(path.join(ROOT, 'README.md'))
// mobile 元数据（不含 src 内部常量）
for (const n of ['app.json', 'package.json']) targets.push(path.join(ROOT, 'mobile', n))

let changed = 0
for (const f of targets) {
  let c = fs.readFileSync(f, 'utf8')
  const before = c
  const isMobile = f.includes(path.join('mobile', '')) && !f.includes('rebrand')
  for (const [from, to] of RULES) {
    if (from === 'LXM_' && isMobile) continue // 上游 mobile 常量保护
    c = c.split(from).join(to)
  }
  if (c !== before) {
    fs.writeFileSync(f, c)
    changed++
    console.log('renamed:', path.relative(ROOT, f))
  }
}
console.log('DONE, files changed:', changed)
