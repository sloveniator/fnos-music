// 探针：抓取「前端点删除时实际发往 /web/api/tracks/delete 的 ids」
// 关键点：请求被 route 拦截并直接 fulfill 假成功，绝不落到服务端 —— 不会真删任何文件。
// 用法：node tools/probe-delete-id.mjs [baseUrl]
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/app/working/workspaces/mingbu-backend/node_modules/playwright-core')

const BASE = process.argv[2] || 'http://localhost:20059'
const USER = 'Slceleto'
const PASS = 'REDACTED'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const captured = []
let browser
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
} catch (e) {
  console.error('launch failed:', e.message)
  process.exit(2)
}
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
// 保险 1（决定性）：页面内 patch fetch，/tracks/delete 直接假响应，请求不出浏览器
await ctx.addInitScript(() => {
  window.__cap = []
  const of = window.fetch
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.indexOf('/tracks/delete') >= 0) {
      let ids = []
      try { ids = (JSON.parse((init && init.body) || '{}').ids) || [] } catch {}
      window.__cap.push({ url, ids, raw: (init && init.body) || '' })
      return new Response(JSON.stringify({ code: 0, data: { removed: ids.length, failed: [], total: 33, trashDir: '.gusi-trash' } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return of.apply(this, arguments)
  }
})
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error] ' + m.text()) })

// 拦截删除请求：记录 postData，回假成功；真正要删的东西一个都不碰
await page.route('**/tracks/delete*', async (route) => {
  const req = route.request()
  let body = null
  try { body = JSON.parse(req.postData() || '{}') } catch { body = req.postData() }
  captured.push({ ids: (body && body.ids) || [], raw: req.postData() })
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ code: 0, data: { removed: ((body && body.ids) || []).length, failed: [], total: 33, trashDir: '.gusi-trash' } }),
  })
})

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
if (await page.locator('#login').isVisible().catch(() => false)) {
  await page.fill('#login-name', USER)
  await page.fill('#login-pass', PASS)
  await page.click('#login-btn')
  await page.waitForSelector('#shell:not([hidden])', { timeout: 15000 })
  console.log('登录成功')
} else {
  console.log('已是登录态')
}

// 服务端索引里的真实 id 集合（= 删除接口认的 id）
const indexIds = await page.evaluate(async () => {
  const t = localStorage.getItem('gusi-web-token') || ''
  const r = await fetch('/web/api/tracks?page=1&size=500', { headers: { 'X-Web-Token': t } })
  const d = await r.json()
  return (d.data.tracks || []).map((x) => x.id)
})
const idSet = new Set(indexIds)
console.log('索引曲目数: ' + indexIds.length)

/** 在当前页面里，对第 n 行点「…」→「删除…」→ 确定；返回确认框文案 */
const clickRowDelete = async (n) => {
  return page.evaluate((idx) => {
    const rows = [...document.querySelectorAll('#view tbody tr')]
    const tr = rows[idx]
    if (!tr) return { err: 'no row ' + idx }
    const mb = tr.querySelector('.acts .more-wrap button')
    if (!mb) return { err: 'no menu button' }
    mb.click()
    const item = [...document.querySelectorAll('.menu button')].find((b) => /删除/.test(b.textContent))
    if (!item) return { err: 'no delete item', menu: [...document.querySelectorAll('.menu button')].map((b) => b.textContent) }
    item.click()
    const dlg = document.querySelector('#dialog')
    const msg = document.querySelector('#dlg-msg') ? document.querySelector('#dlg-msg').textContent : ''
    return { opened: dlg && !dlg.hidden, msg, rowName: tr.textContent.slice(0, 40) }
  }, n)
}
const confirmDlg = async () => {
  const vis = await page.evaluate(() => { const d = document.querySelector('#dialog'); return !!(d && !d.hidden) })
  if (vis) await page.click('#dlg-ok')
  await page.waitForTimeout(350)
}
/** 页面内 patch 的 fetch 记录（权威来源；captured 只是兜底） */
const cap = () => page.evaluate(() => window.__cap || []).then((a) => a.map((x) => ({ ids: x.ids, raw: x.raw })))
const capReset = () => page.evaluate(() => { window.__cap = [] })

/** 服务端真出错了？页面 toast 文案就是用户看到的东西 */
const toastText = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })

const report = []
const testView = async (hash, label, rowsToTry = 3) => {
  captured.length = 0
  await capReset()
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.waitForTimeout(1200)
  const nRows = await page.evaluate(() => document.querySelectorAll('#view tbody tr').length)
  const out = []
  for (let i = 0; i < Math.min(rowsToTry, nRows); i++) {
    const r = await clickRowDelete(i)
    if (r.err) { out.push({ i, err: r.err, menu: r.menu }); continue }
    await confirmDlg()
    const pageCap = await cap()
    const last = pageCap.length ? pageCap[pageCap.length - 1] : captured[captured.length - 1]
    out.push({
      i,
      row: (r.rowName || '').replace(/\s+/g, ' ').trim(),
      ids: last ? last.ids : null,
      ok: last ? last.ids.every((id) => idSet.has(id)) : false,
    })
  }
  const bad = out.filter((x) => x.ids && !x.ok)
  report.push({ view: hash, label, rows: nRows, probed: out.length, bad: bad.length, detail: out })
  console.log(`\n== ${label} ${hash}  行数=${nRows} 探测=${out.length} 坏id=${bad.length}`)
  for (const o of out) {
    console.log('   ' + (o.err ? 'ERR ' + o.err + ' ' + JSON.stringify(o.menu || []) : `row#${o.i} ${o.ids && o.ids.length ? (o.ok ? 'OK  ' : 'BAD ') : '（未触发请求）'} ${JSON.stringify(o.ids)}  ${o.row}`))
  }
}

await testView('#/home', '首页')
await testView('#/tracks', '全部歌曲')
await testView('#/playlists', '专辑/歌单')
await testView('#/playlist/love', '我喜欢')
await testView('#/playlist/default', '我的歌单')
await testView('#/artists', '歌手')

// 批量「删除选中」
captured.length = 0
await page.evaluate(() => { location.hash = '#/tracks' })
await page.waitForTimeout(1200)
const batch = await page.evaluate(async () => {
  const boxes = [...document.querySelectorAll('#view tbody tr .row-sel')]
  boxes.slice(0, 3).forEach((b) => { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })) })
  await new Promise((r) => setTimeout(r, 200))
  const btn = document.querySelector('.del-sel')
  if (!btn) return { err: 'no del-sel' }
  if (btn.disabled) return { err: 'btn disabled' }
  btn.click()
  await new Promise((r) => setTimeout(r, 200))
  const d = document.querySelector('#dialog')
  const msg = document.querySelector('#dlg-msg') ? document.querySelector('#dlg-msg').textContent : ''
  return { opened: !!(d && !d.hidden), msg }
})
if (batch.err) console.log('\n== 批量删除选中：' + batch.err)
else {
  await confirmDlg()
  const bc = await cap()
  const last = bc.length ? bc[bc.length - 1] : captured[captured.length - 1]
  console.log('\n== 批量删除选中 ' + JSON.stringify(last && last.ids) + '  全部命中=' + (last ? last.ids.every((id) => idSet.has(id)) : false))
  console.log('   对话框: ' + (batch.msg || '').replace(/\s+/g, ' ').slice(0, 80))
  report.push({ view: 'batch', label: '删除选中', detail: last ? last.ids : null, bad: last ? last.ids.filter((id) => !idSet.has(id)).length : -1 })
}

console.log('\n---- 汇总 ----')
console.log(JSON.stringify(report.map((r) => ({ view: r.view, probed: r.probed, bad: r.bad })), null, 1))
await browser.close()
