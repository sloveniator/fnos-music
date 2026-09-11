// 整机 E2E：真实起 server，走 /admin/login + user-sources 全套 API
// 用法：node tools/e2e-user-sources.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-'))
const PORT = 19991
const ADMIN_PW = 'e2e-admin-pass'
const BASE = 'http://127.0.0.1:' + PORT

const FAKE = `(function () {
  var lx = globalThis.lx, EV = lx.EVENT_NAMES
  lx.on(EV.request, function (req) {
    if (req.action === 'musicUrl') {
      var mi = (req.info && req.info.musicInfo) || {}
      return Promise.resolve('https://cdn.example/track.mp3?src=' + req.source + '&hash=' + encodeURIComponent(mi.hash || mi.songmid || ''))
    }
    return Promise.reject(new Error('unsupported'))
  })
  lx.send(EV.inited, { status: true, sources: { kw: { type: 'music', actions: ['musicUrl'] }, wy: { type: 'music', actions: ['musicUrl'] } } })
})()
`

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}

const child = spawn(process.execPath, [path.resolve('server/server/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    BIND_IP: '127.0.0.1',
    DATA_PATH: path.join(tmp, 'data'),
    LOG_PATH: path.join(tmp, 'logs'),
    GS_ADMIN_PASSWORD: ADMIN_PW,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/admin/api/status')
      if (r.status === 401) return true
    } catch {}
    await sleep(500)
  }
  return false
}
async function apiReq(p, opt = {}, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Admin-Token'] = token
  const r = await fetch(BASE + p, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined })
  let data = await r.json().catch(() => ({}))
  if (data && typeof data === 'object' && 'code' in data) {
    if (data.code === 0) data = data.data
    else data = { __err: data.msg || ('code ' + data.code) }
  }
  return { status: r.status, data }
}

let token = ''
try {
  check('server 启动可达', await waitUp())
  const login = await apiReq('/admin/login', { method: 'POST', body: { password: ADMIN_PW } })
  check('login 成功', login.status === 200 && !!login.data.token, login.data.__err || '')
  token = login.data.token || ''

  // CRUD
  const save = await apiReq('/admin/api/library/user-sources', { method: 'POST', body: { name: 'E2E 测试源', script: FAKE, enabled: false } }, token)
  check('save 新源', save.status === 200 && !!save.data && !!save.data.id, save.data.__err || (save.data && save.data.id) || '')
  const id = save.data.id

  const en = await apiReq('/admin/api/library/user-sources/enable', { method: 'POST', body: { id, enabled: true } }, token)
  check('enable', en.status === 200 && en.data.enabled === true, JSON.stringify(en.data))

  const t = await apiReq('/admin/api/library/user-sources/test', { method: 'POST', body: { id, probe: { source: 'kw', id: 'MUSIC_ABC', type: '320k' } } }, token)
  check('test(已保存) 返回直链', t.status === 200 && t.data.ok === true && String(t.data.url).includes('MUSIC_ABC'), (t.data.url || t.data.error) + ' / caps=' + JSON.stringify(t.data.capabilities))
  check('test 采到 capabilities', !!t.data.capabilities && Array.isArray(t.data.capabilities.kw), JSON.stringify(t.data.capabilities))

  const td = await apiReq('/admin/api/library/user-sources/test', { method: 'POST', body: { name: 'draft', script: FAKE, probe: { source: 'wy', id: '54321' } } }, token)
  check('test(草稿) 返回直链', td.status === 200 && td.data.ok === true && String(td.data.url).includes('54321'), td.data.url || td.data.error)

  const g = await apiReq('/admin/api/library/user-sources/' + id, {}, token)
  check('get 单条含脚本', g.status === 200 && (g.data.script || '').includes('musicUrl'), 'scriptLen=' + String(g.data.script || '').length)

  const list = await apiReq('/admin/api/library/user-sources', {}, token)
  const row = (list.data.list || []).find((x) => x.id === id)
  check('list 含状态/能力', !!row && !!row.status && Array.isArray(row.capabilities && row.capabilities.kw), JSON.stringify(row && { status: row.status, caps: row.capabilities }))

  const bad = await apiReq('/admin/api/library/user-sources/test', { method: 'POST', body: { id: 'nonexistent', probe: { source: 'kw', id: 'x' } } }, token)
  check('test 不存在源 → ok:false+error', bad.status === 200 && bad.data.ok === false && !!bad.data.error, bad.data.__err || (bad.data && bad.data.error) || '')

  const del = await apiReq('/admin/api/library/user-sources/' + id, { method: 'DELETE' }, token)
  check('delete', del.status === 200 && del.data.removed === true, JSON.stringify(del.data))
  const after = await apiReq('/admin/api/library/user-sources', {}, token)
  check('删除后 list 无此 id', !(after.data.list || []).some((x) => x.id === id))

  // 无 token 应 401
  const noAuth = await apiReq('/admin/api/library/user-sources')
  check('未认证被拒', noAuth.status === 401)
} catch (e) {
  console.log('[EXC] ' + (e && e.message))
  fail++
} finally {
  child.kill('SIGKILL')
  await sleep(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
