// 管理后台「音源与代理」页 UI 冒烟（真实 Chromium）
// 用法：node tools/ui-us-check.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(path.resolve('tools/node_modules/playwright-core'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-ui-'))
const PORT = 19992
const ADMIN_PW = 'ui-admin-pass'
const BASE = 'http://127.0.0.1:' + PORT

const FAKE = `(function () {
  var lx = globalThis.lx, EV = lx.EVENT_NAMES
  lx.on(EV.request, function (req) {
    if (req.action === 'musicUrl') return Promise.resolve('https://cdn.example/t.mp3?src=' + req.source)
    return Promise.reject(new Error('no'))
  })
  lx.send(EV.inited, { status: true, sources: { kw: { type: 'music', actions: ['musicUrl'] } } })
})()
`

const child = spawn(process.execPath, [path.resolve('server/server/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    BIND_IP: '127.0.0.1',
    DATA_PATH: path.join(tmp, 'data'),
    LOG_PATH: path.join(tmp, 'logs'),
    GS_ADMIN_PASSWORD: ADMIN_PW,
    GS_WEB_STATIC_DIR: path.resolve('ui/dist'),
    GS_APP_STATIC_DIR: path.resolve('ui/app'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/admin/api/status')
      if (r.status === 401) return true
    } catch {}
    await sleep(400)
  }
  return false
}

let browser = null
try {
  check('server 启动可达', await waitUp())
  const exe = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'
  browser = await chromium.launch({ executablePath: exe, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()) })
  await page.evaluate(() => {
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      console.error('UNHANDLED_REJECTION: ' + String((r && r.message) || r))
    })
  })
  page.on('response', async (r) => {
    if (r.url().includes('user-sources')) {
      const txt = await r.text().catch(() => '')
      console.log('  [net] ' + r.request().method() + ' ' + r.url().replace(BASE, '') + ' -> ' + r.status() + ' ' + txt.slice(0, 220))
    }
  })

  // 登录
  await page.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' })
  await page.fill('#login-password', ADMIN_PW)
  await page.click('#login-btn')
  await page.waitForSelector('#main-view:not(.hidden)', { timeout: 8000 })
  check('登录成功进入主界面', true)

  // 进入「音源与代理」tab
  await page.click('.tab[data-tab="source"]')
  await page.waitForSelector('#us-table', { timeout: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('#us-table tbody tr').length > 0, null, { timeout: 8000 })
  const emptyMsg = await page.textContent('#us-table tbody tr td')
  check('第三方源卡渲染（空态提示）', (emptyMsg || '').includes('尚未添加'), (emptyMsg || '').slice(0, 60))

  // 添加对话框
  await page.click('#us-add')
  await page.waitForSelector('#us-dialog[open]', { timeout: 5000 })
  await page.fill('#us-name', 'UI冒烟源')
  await page.fill('#us-script', FAKE)
  await page.click('#us-dlg-save')
  await page.waitForTimeout(1500)
  const dbgState = await page.evaluate(() => ({
    open: !!document.getElementById('us-dialog').open,
    rows: document.querySelectorAll('#us-table tbody tr').length,
    html: document.querySelector('#us-table tbody').innerHTML.slice(0, 300),
    listLen: null,
  }))
  console.log('  [dbg] ' + JSON.stringify(dbgState))
  await page.waitForFunction(() => document.querySelectorAll('#us-table tbody tr').length >= 1, null, { timeout: 8000 }).catch(() => {})
  let rowText = await page.textContent('#us-table tbody tr')
  check('保存后出现一行', (rowText || '').includes('UI冒烟源'), (rowText || '').slice(0, 80))
  check('无 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))

  // 行内测活（会触发启动 → 能力采集）
  await page.click('#us-table tbody tr button:has-text("测活")')
  await page.waitForTimeout(2500)
  rowText = await page.textContent('#us-table tbody tr')
  check('测活后能力 chips 出现(kw)', (rowText || '').includes('kw'), (rowText || '').slice(0, 120))
  check('测活后无运行时错误', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))

  const toast = await page.textContent('body')
  check('测活 toast 已展示', (toast || '').length > 0, '')

  // 停用开关
  const before = await page.textContent('#us-table tbody tr')
  await page.click('#us-table tbody tr .switch input')
  await page.waitForTimeout(1500)
  rowText = await page.textContent('#us-table tbody tr')
  check('开关可停用', (before || '').includes('启用') && (rowText || '').includes('停用'), '')
  await page.screenshot({ path: 'tools/ui-us-check.png', fullPage: false })
  console.log('  (screenshot: tools/ui-us-check.png)')
} catch (e) {
  console.log('[EXC] ' + (e && e.message))
  fail++
} finally {
  if (browser) await browser.close()
  child.kill('SIGKILL')
  await sleep(300)
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
