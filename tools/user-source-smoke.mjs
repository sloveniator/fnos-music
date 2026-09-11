// ---------------------------------------------------------------------------
// 服务端第三方 JS 音源 —— 运行时自测
//   用法（先 npm run build）：
//     node tools/user-source-smoke.mjs            # 离线确定性用例
//     node tools/user-source-smoke.mjs --live     # 追加真实源（Huibq 等）联网测活
//   退出码：全过 0，任一失败 1。真实源联网用例失败不计退出码（只打印诊断）。
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-us-'))
// 模拟 server 启动环境（library/index.ts 需要 global.lx.dataPath）
globalThis.lx = { dataPath: tmp, listenPort: 19990 }

const require = createRequire(import.meta.url)
const us = require(path.resolve('server/server/online/user-source.js'))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}

// ---------------- 用例脚本 ----------------
const FAKE = `(function () {
  'use strict'
  var lx = globalThis.lx, EV = lx.EVENT_NAMES
  lx.on(EV.request, function (req) {
    if (req.action === 'musicUrl') {
      var info = req.info || {}
      var mi = info.musicInfo || {}
      return Promise.resolve('https://fake.example/a.mp3?src=' + req.source + '&id=' + encodeURIComponent(mi.hash || mi.songmid || '') + '&q=' + (info.type || ''))
    }
    if (req.action === 'lyric') return Promise.resolve({ lyric: '[00:00.00]test', tlyric: '' })
    return Promise.reject(new Error('unsupported action: ' + req.action))
  })
  lx.send(EV.inited, { status: true, sources: { kw: { type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k'] } } })
})()
`

const HANGS = `(function(){ while (true) { /* spin */ } })()`
const EVIL_PROCESS = `(function(){ process.exit(1) })()`
const EVIL_EVAL = `(function(){ return eval('1+1') })()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 1. 保存 / 列表 / 启用 ----------------
console.log('\n[1] save / list / enable')
let r = us.saveUserSource({ name: 'Fake 测试源', script: FAKE, enabled: true })
check('saveUserSource ok', !r.error && !!r.meta && r.meta.id.startsWith('fake'), r.error || r.meta?.id)
const id = r.meta.id
const list0 = us.listUserSources()
check('list contains', list0.some((x) => x.id === id))
r = us.saveUserSource({ name: '空脚本', script: '   ' })
check('拒绝空脚本', !!r.error)
r = us.saveUserSource({ name: 'x'.repeat(90) + '超长', script: '// hi' })
check('名称截断 <=80', !r.error && r.meta.name.length <= 80)
us.deleteUserSource(r.meta.id)
check('删除后消失', !us.listUserSources().some((x) => x.id === r.meta.id))

// ---------------- 2. 协议闭环：测活 + capabilities ----------------
console.log('\n[2] protocol: inited capabilities + musicUrl invoke')
const t1 = await us.testUserSource({ name: 'fake-draft', script: FAKE, probe: { source: 'kw', id: 'MUSIC_7C9F', type: '320k' } })
check('testUserSource(草稿) 返回 url', t1.ok === true && typeof t1.url === 'string' && t1.url.includes('MUSIC_7C9F'), t1.ok ? t1.url : t1.error)
check('testUserSource 采到 capabilities', !!t1.capabilities && Array.isArray(t1.capabilities.kw) && t1.capabilities.kw.includes('musicUrl'), JSON.stringify(t1.capabilities))

const en = await us.setUserSourceEnabled(id, true)
check('enable ok', en.ok === true, en.error || '')
await sleep(600) // 等 initedDone 持久化
const list1 = us.listUserSources().find((x) => x.id === id)
check('capabilities 持久化到 meta', !!list1 && Array.isArray(list1.capabilities?.kw), JSON.stringify(list1?.capabilities))

// ---------------- 3. 解析链 resolveFromUserSources ----------------
console.log('\n[3] resolve chain')
const chain = await us.resolveFromUserSources('kw', 'MUSIC_ABC123')
check('resolveFromUserSources 命中第三方', chain !== null && chain.url.startsWith('https://fake.example/') && chain.via === id, chain ? chain.url + ' via ' + chain.via : 'null')
const chain2 = await us.resolveFromUserSources('wy', '12345')
check('不覆盖平台(wy)返回 null', chain2 === null)
us.deleteUserSource(id)
const chain3 = await us.resolveFromUserSources('kw', 'MUSIC_X')
check('删除后返回 null', chain3 === null)

// ---------------- 4. 资源护栏 ----------------
console.log('\n[4] resource guards')
const hangT = Date.now()
const tHang = await us.testUserSource({ name: 'hang', script: HANGS, probe: { source: 'kw', id: 'x' } })
const hangMs = Date.now() - hangT
check('死循环被掐断(≤8s)', tHang.ok === false && hangMs < 8000, tHang.error + ' / ' + hangMs + 'ms')
const tProc = await us.testUserSource({ name: 'proc', script: EVIL_PROCESS, probe: { source: 'kw', id: 'x' } })
check('process 不可见(脚本无法 exit)', tProc.ok === false && /exit|undefined|not defined/i.test(tProc.error || ''), tProc.error || 'ok?!')
const tEval = await us.testUserSource({ name: 'eval', script: EVIL_EVAL, probe: { source: 'kw', id: 'x' } })
check('eval 不可见', tEval.ok === false, tEval.error || 'ok?!')

// ---------------- 5. 禁用终止 ----------------
console.log('\n[5] disable')
const id2 = us.saveUserSource({ name: 'Fake2', script: FAKE }).meta.id
await us.setUserSourceEnabled(id2, false)
const chain4 = await us.resolveFromUserSources('kw', 'MUSIC_Y')
check('禁用后不参与解析', chain4 === null)
us.deleteUserSource(id2)

// ---------------- 6. header 清洗 ----------------
console.log('\n[6] header sanitize')
const BAD_HEAD = `(function () {
  var lx = globalThis.lx, EV = lx.EVENT_NAMES
  lx.on(EV.request, function (req) {
    return new Promise(function (resolve, reject) {
      lx.request('http://127.0.0.1:1/x', { method: 'get', headers: { 'tag': 'a\\u0001b', 'bad name': 'v', 'X-Ok': 'y' } }, function (err) {
        if (err) return reject(new Error('net:' + (err && err.message)))
        resolve('https://x.example/')
      })
    })
  })
  lx.send(EV.inited, { status: true, sources: { kw: { type: 'music', actions: ['musicUrl'] } } })
})()
`
const tHead = await us.testUserSource({ name: 'badhead', script: BAD_HEAD, probe: { source: 'kw', id: 'x' } })
check('非法 header 被清洗(走连接错误而非抛错)', tHead.ok === false && /net:/.test(tHead.error || '') && !/Invalid character/.test(tHead.error || ''), tHead.error || 'ok?!')

// ---------------- LIVE: 真实源（--live，仅诊断） ----------------
const live = process.argv.includes('--live')
if (live) {
  console.log('\n[LIVE] 真实源测活（网络依赖，仅诊断）')
  const MEDIA = process.env.MEDIA || 'C:/Users/Administrator/.qwenpaw/workspaces/default/media'
  const files = fs.existsSync(MEDIA) ? fs.readdirSync(MEDIA).filter((f) => f.endsWith('.js')) : []
  if (!files.length) { console.log('  未找到 media 目录：' + MEDIA) }
  const real = files.map((f) => ({ f, src: fs.readFileSync(path.join(MEDIA, f), 'utf8') }))
  const probes = [
    { source: 'wy', id: '1430355808', type: '128k' },
    { source: 'kw', id: '123456', type: '128k' },
  ]
  for (const { f, src } of real) {
    const t0 = Date.now()
    const kb = Math.round(src.length / 1024)
    try {
      if (src.length < 60 * 1024) {
        // 小脚本：直接探针 musicUrl
        let line = ''
        for (const pc of probes) {
          const res = await us.testUserSource({ name: f, script: src, probe: pc })
          if (res.ok) { line = '[OK] ' + pc.source + ' -> ' + String(res.url).slice(0, 120); break }
          line = '[NO] ' + pc.source + ' -> ' + String(res.error || 'fail').slice(0, 120)
        }
        console.log('  ' + f + ' (' + kb + 'KB) ' + line + ' [' + (Date.now() - t0) + 'ms]')
      } else {
        // 大脚本（混淆整包）：boot-only —— 验证能启动、能采到 capabilities
        const r = us.saveUserSource({ name: f, script: src, enabled: false })
        if (r.error) { console.log('  ' + f + ' (' + kb + 'KB) [SAVE-FAIL] ' + r.error); continue }
        const en = await us.setUserSourceEnabled(r.meta.id, true)
        await sleep(2500)
        const st = us.listUserSources().find((x) => x.id === r.meta.id)
        const caps = st && st.capabilities && Object.keys(st.capabilities).length ? Object.keys(st.capabilities).join(',') : '(none)'
        const tail = st && st.logTail ? st.logTail.slice(-3).join(' | ') : ''
        const err = (en.error || (st && st.lastError) || '').slice(0, 160)
        console.log('  ' + f + ' (' + kb + 'KB) [boot ' + (st ? st.status : '?') + '] caps={' + caps + '}' + (err ? ' err=' + err : '') + ' [' + (Date.now() - t0) + 'ms]')
        if (tail) console.log('      log: ' + tail.slice(0, 220))
        us.deleteUserSource(r.meta.id)
      }
    } catch (e) {
      console.log('  ' + f + ' (' + kb + 'KB) [EXC] ' + String((e && e.message) || e).slice(0, 160))
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
