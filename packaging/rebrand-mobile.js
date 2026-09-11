#!/usr/bin/env node
// 安卓端品牌化改造（幂等）：包名 / 应用名 / 图标 / 版本
// 支持从上游 cn.toside.music.mobile 或中间态 com.lxmcloud.music 迁移到 com.gusi.music
// 运行：node packaging/rebrand-mobile.js
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { makeIcon } = require('./logo')

const ROOT = path.resolve(__dirname, '..')
const MOBILE = path.join(ROOT, 'mobile')

const APP_NAME = '古四音乐'
const NEW_ID = 'com.gusi.music'
const OLD_IDS = ['com.lxmcloud.music', 'cn.toside.music.mobile'] // 按长度降序逐个迁移

// ---------- 1. 包名：移动 java 源码树 + 替换所有引用 ----------
const javaDir = path.join(MOBILE, 'android', 'app', 'src', 'main', 'java')
const treeOf = (id) => path.join(javaDir, ...id.split('.'))
const newTree = treeOf(NEW_ID)
for (const oldId of OLD_IDS) {
  const oldTree = treeOf(oldId)
  if (!fs.existsSync(oldTree) || oldTree === newTree) continue
  fs.mkdirSync(path.dirname(newTree), { recursive: true })
  // 逐层合并移动（目标树可能已存在部分目录）
  const merge = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true })
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name)
      if (e.isDirectory()) merge(s, d)
      else fs.renameSync(s, d)
    }
    fs.rmdirSync(src)
  }
  merge(oldTree, newTree)
  console.log('moved java tree', oldId, '→', NEW_ID)
}
// 清理遗留空目录（cn/toside、com/lxmcloud）
for (const oldId of OLD_IDS) {
  const parts = oldId.split('.')
  for (let i = parts.length; i >= 1; i--) {
    const p = path.join(javaDir, ...parts.slice(0, i))
    try { fs.rmdirSync(p) } catch {}
  }
}

/** 递归替换文本文件中的包名（仅处理文本扩展名） */
const TEXT_EXT = new Set(['.java', '.gradle', '.xml', '.properties', '.pro', '.json', '.kt'])
const replaceInTree = (dir) => {
  let count = 0
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      if (name === 'build' && full.includes('android')) continue // gradle 产物
      count += replaceInTree(full)
      continue
    }
    if (!TEXT_EXT.has(path.extname(name))) continue
    let content = fs.readFileSync(full, 'utf8')
    let hit = false
    for (const oldId of OLD_IDS) {
      if (content.includes(oldId)) {
        content = content.split(oldId).join(NEW_ID)
        hit = true
      }
    }
    if (hit) { fs.writeFileSync(full, content); count++ }
  }
  return count
}
const n1 = replaceInTree(path.join(MOBILE, 'android'))
const n2 = replaceInTree(path.join(MOBILE, 'src'))
console.log(`package id replaced in ${n1 + n2} files`)

// ---------- 2. 应用名 / package.json / app.json ----------
const pkgPath = path.join(MOBILE, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.name = 'gusi-music-mobile'
pkg.version = '1.0.0'
pkg.versionCode = 1
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

fs.writeFileSync(path.join(MOBILE, 'app.json'), JSON.stringify({
  name: 'GusiMusic',
  displayName: APP_NAME,
}, null, 2) + '\n')

fs.writeFileSync(
  path.join(MOBILE, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
  `<resources>\n    <string name="app_name">${APP_NAME}</string>\n</resources>\n`,
)
console.log('app name →', APP_NAME)

// ---------- 3. 图标：共享 logo 模块（古钱外圆内方） ----------
const resDir = path.join(MOBILE, 'android', 'app', 'src', 'main', 'res')
const sizes = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 }
for (const [dir, size] of Object.entries(sizes)) {
  const target = path.join(resDir, dir)
  if (!fs.existsSync(target)) continue
  const png = makeIcon(size)
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith('ic_launcher')) {
      fs.writeFileSync(path.join(target, name), png)
    }
  }
}
try { fs.rmSync(path.join(resDir, 'mipmap-anydpi-v26'), { recursive: true, force: true }) } catch {}
console.log('launcher icons replaced')

console.log('REBRAND DONE')
