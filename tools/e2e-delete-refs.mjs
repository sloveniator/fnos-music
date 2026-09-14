// E2E：删除曲目 → 清理歌单死引用；失效引用可见可移除
//   用真实数据的副本（含一条已失效的「我的歌单」引用）跑，绝不碰线上实例。
//   用法：node tools/e2e-delete-refs.mjs
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/app/working/workspaces/mingbu-backend/node_modules/playwright-core')

const ROOT = process.cwd()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-del-'))
const DATA = path.join(TMP, 'data')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = 'REDACTED'

/** 动态挑一个空闲端口：固定端口一旦有僵尸实例占着，测试会静默连到别人身上 */
const freePort = async () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})
const PORT = await freePort()
const BASE = 'http://127.0.0.1:' + PORT
const LIB = path.join(DATA, 'libraries', WEB_USER)

// 复制真实数据：这样索引/歌单形状与线上一致
fs.cpSync(path.join(ROOT, 'server', 'data'), DATA, { recursive: true })
console.log('数据副本: ' + DATA)

// --------------------------------------------------------------------------
// 隔离必须做彻底：真实 library-settings.json 里是【绝对路径】，索引里也是绝对
// filePath。不重写的话，隔离实例会拿着真实路径去删真文件——已经踩过一次
// （真实 mp3 被移进了真实 .gusi-trash）。所以：重写 + 硬校验。
// --------------------------------------------------------------------------
{
  const settingsPath = path.join(LIB, 'library-settings.json')
  const st = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  st.dirs = [LIB]
  fs.writeFileSync(settingsPath, JSON.stringify(st))

  const idxPath = path.join(LIB, 'library.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  for (const t of idx.tracks || []) t.filePath = path.join(LIB, t.relPath)
  fs.writeFileSync(idxPath, JSON.stringify(idx))

  // 全副本清洗：文本级把「真实数据目录」前缀替换成副本目录。downloads.json 这类
  // 历史任务记录里会残留真实文件的绝对路径，不清掉的话孤立实例会拿着真路径去动真文件
  // ——2026-09-14 的事故正是这一类（副本实例把真实曲库整批搬进了回收站）。
  const realData = path.join(ROOT, 'server', 'data')
  const LEGACY_DIRS = ['/tmp/gusi-test-music', '/tmp/gusi-dl']
  const sanitizeJson = (p) => {
    let txt = fs.readFileSync(p, 'utf8')
    const orig = txt
    if (txt.includes(realData)) txt = txt.split(realData).join(DATA)
    for (const d of LEGACY_DIRS) if (txt.includes(d)) txt = txt.split(d).join(LIB)
    if (txt !== orig) fs.writeFileSync(p, txt)
  }
  const walkJson = (p) => {
    let s2
    try { s2 = fs.statSync(p) } catch { return }
    if (s2.isDirectory()) { for (const f of fs.readdirSync(p)) walkJson(path.join(p, f)); return }
    if (/\.json$/.test(p)) sanitizeJson(p)
  }
  walkJson(DATA)

  // 硬校验：副本里任何文件都不允许再出现「真实数据目录」或我遗留的临时曲库目录
  const leaked = (() => {
    const out = []
    const pat = new RegExp('(' + realData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|/tmp/gusi-test-music|/tmp/gusi-dl)')
    const walk = (p) => {
      let s2
      try { s2 = fs.statSync(p) } catch { return }
      if (s2.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return }
      if (!/\.json$/.test(p)) return
      const txt = fs.readFileSync(p, 'utf8')
      if (pat.test(txt)) out.push(path.basename(p))
    }
    walk(DATA)
    return [...new Set(out)]
  })()
  if (leaked.length) {
    console.error('!! 副本里仍有指向真实曲库的绝对路径，已中止: ' + leaked.join(', '))
    process.exit(3)
  }
  console.log('数据副本: ' + DATA + '\n隔离校验通过 (dirs=' + st.dirs[0] + ', 全副本无真实路径泄漏)')
}

// 确定性夹具：往副本的「我的歌单」快照里注入一条指向不存在曲目的死引用。
// 之前这条测试数据靠的是线上恰好有一条死引用（gusi-final2 的文件被移进了回收站），
// 文件一还原测试就假失败——夹具必须自己造，不依赖线上残留状态。
{
  const usersDir = path.join(DATA, 'users')
  const userDir = fs.readdirSync(usersDir).find((d) => d.startsWith(WEB_USER)) || fs.readdirSync(usersDir)[0]
  const listDir = path.join(usersDir, userDir, 'list')
  const info = JSON.parse(fs.readFileSync(path.join(listDir, 'snapshotInfo.json'), 'utf8'))
  const snapPath = path.join(listDir, 'snapshot', 'snapshot_' + info.latest)
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  const dead = {
    id: 'local_deadbeefdeadbeef', name: '死引用测试曲', singer: '测试歌手', source: 'local', interval: null,
    meta: { songId: 'deadbeefdeadbeef', albumName: '测试专辑', picUrl: '', filePath: 'deadbeefdeadbeef', ext: 'mp3' },
  }
  snap.defaultList = [dead]
  fs.writeFileSync(snapPath, JSON.stringify(snap))
  console.log('夹具: 我的歌单已注入 1 条死引用 (' + dead.id + ', 目标曲目不存在于索引)')
}

const child = spawn(process.execPath, [path.resolve('server/server/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT), BIND_IP: '127.0.0.1',
    DATA_PATH: DATA, LOG_PATH: path.join(TMP, 'logs'),
    GS_ADMIN_PASSWORD: ADMIN_PW,
    GS_WEB_STATIC_DIR: path.resolve('ui/dist'),
    GS_APP_STATIC_DIR: path.resolve('ui/app'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))

child.on('exit', (code) => { if (code != null && !stopping) console.error('[srv] 意外退出, code=' + code) })
let stopping = false
const stop = () => { stopping = true; try { child.kill('SIGKILL') } catch {} }
process.on('exit', stop)
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(1) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch {}
    await sleep(400)
  }
  return false
}
if (!await waitUp()) {
  console.error('服务未起来（端口 ' + PORT + '）：' + (child.exitCode != null ? '子进程已退出 code=' + child.exitCode : '超时'))
  stop()
  process.exit(2)
}
console.log('隔离实例就绪: ' + BASE + '  (pid ' + child.pid + ')')

let token = ''
const api = async (p, opt = {}) => {
  const res = await fetch(BASE + '/web/api' + p, {
    method: opt.method || 'GET',
    headers: { 'X-Web-Token': token, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  const j = await res.json().catch(() => ({}))
  return { status: res.status, ...j }
}
{
  const r = await fetch(BASE + '/web/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: WEB_USER, password: WEB_PASS }),
  })
  const j = await r.json()
  token = j?.data?.token || ''
}
check('web 登录拿到 token', !!token)
{
  const pre = await api('/playlists/default')
  console.log('  [直读] /playlists/default -> ' + JSON.stringify(pre).slice(0, 180))
  const pre2 = await api('/playlists/default')
  console.log('  [直读#2] -> ' + JSON.stringify(pre2).slice(0, 180))
}

// --------------------------------------------------------------------------
// A. 浏览器侧：失效引用在「我的歌单」（内置列表）里必须可见、可移除
// --------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('response', async (r) => {
  if (r.url().includes('/web/api/playlists')) console.log('  [resp] ' + r.status() + ' ' + r.url().replace(BASE, '') + ' :: ' + (await r.text().catch(() => '')).slice(0, 200))
})
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => localStorage.setItem('gusi-web-token', t), token)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('#shell:not([hidden])', { timeout: 15000 })

await page.evaluate(() => { location.hash = '#/playlist/default' })
// 首页那批请求（含第三方推荐）会拖住路由，等实际渲染而不是拍脑袋 sleep
const waitRows = async (n = 1) => {
  try {
    await page.waitForFunction((k) => document.querySelectorAll('#view tbody tr').length >= k, n, { timeout: 20000 })
    return true
  } catch {
    console.log('!! 行未渲染, #view 片段: ' + (await page.evaluate(() => document.querySelector('#view').innerHTML)).slice(0, 300))
    return false
  }
}
await waitRows(1)
const rowInfo = await page.evaluate(() => {
  const tr = document.querySelector('#view tbody tr')
  if (!tr) return null
  return {
    text: tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
    disabled: tr.classList.contains('disabled'),
    hasHeart: !!tr.querySelector('.love button'),
    hasX: [...tr.querySelectorAll('.acts button')].some((b) => b.textContent === '×'),
    meta: (document.querySelector('#view .hero .meta') || {}).textContent || '',
  }
})
check('失效行存在', !!rowInfo, rowInfo && rowInfo.text)
check('失效行灰显(disabled)', !!rowInfo?.disabled)
check('失效行不显示收藏心形', rowInfo && !rowInfo.hasHeart)
check('内置歌单也给了 × 移除按钮', !!rowInfo?.hasX)
check('页头提示失效数量', /引用已失效/.test(rowInfo?.meta || ''), rowInfo?.meta)

// 行菜单：只应有「从歌单移除」
const menuItems = await page.evaluate(async () => {
  const tr = document.querySelector('#view tbody tr')
  tr.querySelector('.acts .more-wrap button').click()
  await new Promise((r) => setTimeout(r, 100))
  const items = [...document.querySelectorAll('.menu button')].map((b) => b.textContent)
  document.querySelectorAll('.menu').forEach((m) => m.remove())
  return items
})
check('失效行菜单只剩「从歌单移除」', menuItems.length === 1 && menuItems[0] === '从歌单移除', JSON.stringify(menuItems))

// 点行本体：应给出解释而不是尝试播放
await page.evaluate(() => { document.querySelector('#view tbody tr').click() })
await page.waitForTimeout(400)
const clickToast = await page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })
check('点击失效行给出解释', /已不在曲库/.test(clickToast), clickToast)

// 点 × 真正移除这条死引用
await page.evaluate(() => {
  const tr = document.querySelector('#view tbody tr')
  const x = [...tr.querySelectorAll('.acts button')].find((b) => b.textContent === '×')
  x.click()
})
await page.waitForTimeout(1200)
const afterRemove = await page.evaluate(() => ({
  rows: document.querySelectorAll('#view tbody tr').length,
  empty: !!document.querySelector('#view .empty'),
  toast: (() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })(),
}))
const plDefault = await api('/playlists/default')
check('× 移除了失效引用', afterRemove.rows === 0 && (plDefault.data?.tracks || []).length === 0, JSON.stringify(afterRemove))
check('移除内置歌单项不报错', /已移除/.test(afterRemove.toast), afterRemove.toast)

// --------------------------------------------------------------------------
// B. 核心修复：删除曲目后，歌单里的引用必须被清理
// --------------------------------------------------------------------------
const tracks1 = (await api('/tracks?page=1&size=5')).data.tracks
const victim = tracks1[0]
check('取到待删曲目', !!victim?.id, victim?.id + ' ' + victim?.name)

let r = await api('/playlists/default/add', { method: 'POST', body: { trackIds: [victim.id] } })
check('加入「我的歌单」', r.data?.added === 1, JSON.stringify(r.data || r))

let detail = await api('/playlists/default')
check('歌单里是有效引用', detail.data.tracks.length === 1 && detail.data.tracks[0].missing === false, JSON.stringify(detail.data.tracks))

r = await api('/tracks/delete', { method: 'POST', body: { ids: [victim.id] } })
check('删除接口 removed=1', r.data?.removed === 1, JSON.stringify(r.data))
check('删除响应带上被清理的歌单名', Array.isArray(r.data?.playlists) && r.data.playlists.includes('我的歌单'), JSON.stringify(r.data?.playlists))

detail = await api('/playlists/default')
check('歌单引用已被清理（不再留幽灵行）', detail.data.tracks.length === 0, JSON.stringify(detail.data.tracks))
const stillThere = (await api('/tracks?page=1&size=200')).data.tracks.some((t) => t.id === victim.id)
check('曲库索引里也没了', !stillThere)
const trashed = fs.existsSync(path.join(LIB, '.gusi-trash', victim.relPath))
check('文件进了 .gusi-trash', trashed, 'relPath=' + victim.relPath)
check('原位置文件已移走', !fs.existsSync(path.join(LIB, victim.relPath)))

// 「我喜欢」同理
const tracks2 = (await api('/tracks?page=1&size=5')).data.tracks
const v2 = tracks2[0]
await api('/love/toggle', { method: 'POST', body: { trackId: v2.id } })
const loveBefore = (await api('/playlists/love')).data.tracks.length
r = await api('/tracks/delete', { method: 'POST', body: { ids: [v2.id] } })
const loveAfter = (await api('/playlists/love')).data.tracks.length
check('「我喜欢」的死引用也被清理', loveBefore === 1 && loveAfter === 0 && r.data.removed === 1, `before=${loveBefore} after=${loveAfter}`)

// --------------------------------------------------------------------------
// C. UI 删除全流程（真实点击）：提示里要说明歌单引用被清理
// --------------------------------------------------------------------------
const tracks3 = (await api('/tracks?page=1&size=5')).data.tracks
const v3 = tracks3[0]
await api('/playlists/default/add', { method: 'POST', body: { trackIds: [v3.id] } })
await page.evaluate(() => { location.hash = '#/tracks' })
await waitRows(1)
const before = await page.evaluate(() => document.querySelectorAll('#view tbody tr').length)
const delUi = await page.evaluate(async (name) => {
  const rows = [...document.querySelectorAll('#view tbody tr')]
  const tr = rows.find((r) => r.textContent.includes(name)) || rows[0]
  tr.querySelector('.acts .more-wrap button').click()
  await new Promise((r) => setTimeout(r, 80))
  const item = [...document.querySelectorAll('.menu button')].find((b) => b.textContent === '删除…')
  if (!item) return { err: 'no delete item' }
  item.click()
  await new Promise((r) => setTimeout(r, 150))
  const ok = document.querySelector('#dlg-ok')
  if (!ok || document.querySelector('#dialog').hidden) return { err: 'no dialog' }
  ok.click()
  return { ok: true }
}, v3.name)
check('UI 行菜单能点出删除并确认', delUi.ok === true, JSON.stringify(delUi))
await page.waitForTimeout(1800)
const uiState = await page.evaluate(() => ({
  rows: document.querySelectorAll('#view tbody tr').length,
  toast: (() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })(),
}))
check('UI 删除后列表少一行', uiState.rows === before - 1, `${before} -> ${uiState.rows}`)
check('提示说明已从歌单移除引用', /已从「我的歌单」移除引用/.test(uiState.toast), uiState.toast)
const plAfter = await api('/playlists/default')
check('UI 删除同样清掉了歌单引用', plAfter.data.tracks.length === 0, JSON.stringify(plAfter.data.tracks))

// 刷新歌单页：不该再有幽灵行
await page.evaluate(() => { location.hash = '#/playlist/default' })
await page.waitForTimeout(1500)
const rowsNow = await page.evaluate(() => document.querySelectorAll('#view tbody tr').length)
check('歌单页刷新后无残留行', rowsNow === 0, 'rows=' + rowsNow)

check('无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()
stop()
console.log(`\n结果: ${pass} pass / ${fail} fail   临时目录 ${TMP}`)
process.exit(fail ? 1 : 0)
