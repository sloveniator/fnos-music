#!/usr/bin/env node
/**
 * 古四音乐 · Logo 模块（共享）
 * 设计：蓝色发光音符图标（源图 packaging/logo-src.png，圆角方形 + 环绕音轨 + 波形）
 * 预渲染多尺寸位图至 packaging/assets/icon-<size>.png，
 * 供 fpk 外壳图标 / Web favicon / Android launcher 复用。
 *
 * 需要新的尺寸时：把源图缩放到该尺寸后放入 packaging/assets/。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const ASSETS = path.join(__dirname, 'assets')

/** 可用尺寸（升序） */
function available() {
  return fs.readdirSync(ASSETS)
    .filter((n) => /^icon-\d+\.png$/.test(n))
    .map((n) => Number(n.match(/\d+/)[0]))
    .sort((a, b) => a - b)
}

/** 取 size×size 的 PNG Buffer；尺寸缺失时抛错并列出可用尺寸 */
function makeIcon(size) {
  const f = path.join(ASSETS, `icon-${size}.png`)
  if (!fs.existsSync(f)) {
    throw new Error(`缺少预渲染图标 assets/icon-${size}.png；可用尺寸：${available().join('/')}`)
  }
  return fs.readFileSync(f)
}

module.exports = { makeIcon, available }

if (require.main === module) {
  console.log('available sizes:', available().join(', '))
}
