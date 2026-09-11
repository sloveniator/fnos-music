#!/usr/bin/env node
// 古四音乐 · 图标产物生成：fpk 外壳 ICON / Web favicon / 消费者端图标
// 设计实现见 packaging/logo.js（外圆内方古钱 + 唱片纹 + 播放三角）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { makeIcon } = require('./logo')

const ROOT = path.resolve(__dirname, '..')
const ensure = (p) => fs.mkdirSync(path.dirname(p), { recursive: true })
const write = (p, buf) => { ensure(p); fs.writeFileSync(p, buf); console.log('written', path.relative(ROOT, p)) }

write(path.join(ROOT, 'build', 'ICON.PNG'), makeIcon(64))
write(path.join(ROOT, 'build', 'ICON_256.PNG'), makeIcon(256))
write(path.join(ROOT, 'ui', 'dist', 'assets', 'icon.png'), makeIcon(32))
write(path.join(ROOT, 'ui', 'app', 'assets', 'icon.png'), makeIcon(32))
console.log('DONE')
