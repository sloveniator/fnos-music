// E2E：重命名曲目 / 编辑标签 —— 引用迁移、标签写回、UI 保存提交
//   与 e2e-delete-refs.mjs 同源：跑真实数据的副本，绝不碰线上实例。
//   副本内绝对路径全部重写并硬校验（踩过一次：隔离没做彻底，真文件被移走）。
//   用法：node tools/e2e-rename-tags.mjs
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
// 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
const _APP_PASS = process.env.GS_APP_PASS || ''
if (!_APP_PASS) throw new Error('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

const require = createRequire(import.meta.url)
const { chromium } = require('/app/working/workspaces/mingbu-backend/node_modules/playwright-core')

const ROOT = process.cwd()
const ID3 = require(path.join(ROOT, 'server', 'node_modules', 'node-id3'))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-ren-'))
const DATA = path.join(TMP, 'data')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = _APP_PASS

/** 动态挑空闲端口：固定端口被僵尸实例占着时，测试会静默连到别人身上 */
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

// --------------------------------------------------------------------------
// 隔离：副本内绝对路径必须重写，否则重命名会作用在真实文件上
// --------------------------------------------------------------------------
fs.cpSync(path.join(ROOT, 'server', 'data'), DATA, { recursive: true })
console.log('数据副本: ' + DATA)
{
  const settingsPath = path.join(LIB, 'library-settings.json')
  const st = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  st.dirs = [LIB]
  fs.writeFileSync(settingsPath, JSON.stringify(st))

  const idxPath = path.join(LIB, 'library.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  for (const t of idx.tracks || []) t.filePath = path.join(LIB, t.relPath)
  fs.writeFileSync(idxPath, JSON.stringify(idx))

  const leaked = (JSON.stringify(idx).match(/"\/(?:[^"]*?)libraries\/[^"]*"/g) || [])
    .filter((x) => !x.includes(TMP))
  if (leaked.length) {
    console.error('!! 副本里仍有指向真实曲库的绝对路径，已中止: ' + leaked.slice(0, 2).join(' '))
    process.exit(3)
  }
  console.log('副本隔离校验通过 (dirs=' + st.dirs[0] + ')')
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

let stopping = false
const stop = () => { stopping = true; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
process.on('exit', stop)
process.on('uncaughtException', (e) => { console.error(e); stop(); process.exit(1) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0, skipped = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}
const skip = (name, why) => { skipped++; console.log('[SKIP] ' + name + (why ? '  -- ' + why : '')) }

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch { /* 还没起来 */ }
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
  token = (await r.json())?.data?.token || ''
}
check('web 登录拿到 token', !!token)

/** 读内嵌封面字节数（0 = 没有封面） */
const coverBytes = (file) => {
  try {
    const tags = ID3.read(file)
    const img = Array.isArray(tags?.image) ? tags.image[0] : tags?.image
    return img?.imageBuffer?.length || 0
  } catch { return 0 }
}

// --------------------------------------------------------------------------
// A. 准备：一条曲目同时进三处引用（内置「我的歌单」「我喜欢」+ 自建歌单）
//    与「最近播放」，重命名后这四处都必须迁移到新 id
// --------------------------------------------------------------------------
const allTracks = (await api('/tracks?page=1&size=200')).data.tracks
let victim = allTracks[0], coverSize = coverBytes(path.join(LIB, victim.relPath))
for (const t of allTracks.slice(0, 12)) {
  const n = coverBytes(path.join(LIB, t.relPath))
  if (n) { victim = t; coverSize = n; break }
}
check('取到样本曲目', !!victim?.id, victim.relPath + '  cover=' + (coverSize || '无'))
if (!coverSize) skip('封面保留检查', '前 12 首里没有内嵌封面')

const oldId = victim.id
const oldRel = victim.relPath
const oldDir = path.dirname(oldRel) // 重命名只在同目录内改名

const plName = 'E2E 改名目标'
const newPlId = (await api('/playlists', { method: 'POST', body: { name: plName } })).data?.id
check('自建歌单已创建', !!newPlId, plName + ' -> ' + newPlId)

// 真实数据的「我的歌单」里本来就躺着一条失效引用（gusi-final2），计数要带上它
const preDefaultLen = (await api('/playlists/default')).data.tracks.length
check('加入「我的歌单」', (await api('/playlists/default/add', { method: 'POST', body: { trackIds: [oldId] } })).data?.added === 1)
check('加入「我喜欢」', (await api('/love/toggle', { method: 'POST', body: { trackId: oldId } })).code === 0)
check('加入自建歌单', (await api('/playlists/' + newPlId + '/add', { method: 'POST', body: { trackIds: [oldId] } })).data?.added === 1)
await api('/played', { method: 'POST', body: { trackId: oldId } })
check('最近播放已记录', (await api('/played')).data.tracks.some((t) => t.id === oldId))

// --------------------------------------------------------------------------
// B. 重命名：文件名、曲目 id、四处引用必须一起动
// --------------------------------------------------------------------------
const newStem = 'e2e-renamed-' + String(Date.now()).slice(-6)
const ren = (await api('/tracks/rename', { method: 'POST', body: { id: oldId, name: newStem } })).data || {}
// 响应里给的是新曲目对象（oldId 有意不外泄给前端），新 id 从 track.id 取
const newId = ren.track?.id
check('重命名后曲目 id 已变化', !!newId && newId !== oldId, JSON.stringify({ oldId, newId }))
check('文件名已改（带扩展名）', ren.renamed === newStem + '.mp3', String(ren.renamed))
check('标题标签同步写回', ren.tagUpdated === true, String(ren.tagUpdated) + (ren.warning ? ' warning=' + ren.warning : ''))
check('迁移覆盖 3 个歌单', Array.isArray(ren.playlists) && ren.playlists.length === 3, JSON.stringify(ren.playlists))
const dDef = (await api('/playlists/default')).data.tracks
const dDefHit = dDef.find((t) => t.trackId === newId)
check('「我的歌单」引用已迁移', dDef.length === preDefaultLen + 1 && dDefHit && dDefHit.missing === false, JSON.stringify(dDefHit))
check('「我喜欢」引用已迁移', (await api('/playlists/love')).data.tracks[0]?.trackId === newId)
check('自建歌单引用已迁移', (await api('/playlists/' + newPlId)).data.tracks[0]?.trackId === newId)
const playedAfter = (await api('/played')).data.tracks.map((t) => t.id)
check('「最近播放」记录已迁移', playedAfter.includes(newId) && !playedAfter.includes(oldId), JSON.stringify(playedAfter))
check('歌单里的显示名跟着更新', dDefHit?.name === newStem, String(dDefHit?.name))

const newRel = path.join(oldDir, newStem + '.mp3')
const newAbs = path.join(LIB, newRel)
check('旧文件名已消失', !fs.existsSync(path.join(LIB, oldRel)))
check('新文件名已落盘', fs.existsSync(newAbs), newRel)
const t2 = ID3.read(newAbs)
check('磁盘 title = 新文件名', t2?.title === newStem, String(t2?.title))
if (coverSize) check('重命名保留内嵌封面', coverBytes(newAbs) === coverSize, coverSize + ' -> ' + coverBytes(newAbs))

const idAfter = (await api('/tracks?page=1&size=200')).data.tracks.map((t) => t.id)
check('曲库索引只留新 id', idAfter.includes(newId) && !idAfter.includes(oldId))

// --------------------------------------------------------------------------
// C. 编辑标签：合并式写入，未提交字段与封面必须原样保留
// --------------------------------------------------------------------------
const patch = { title: 'E2E 标题', artist: 'E2E 歌手', album: 'E2E 专辑', year: '2024', trackNum: '3' }
const tagRes = await api('/tracks/tags', { method: 'POST', body: { id: newId, tags: patch } })
check('标签接口返回更新后的曲目', tagRes.data?.track?.name === 'E2E 标题' && tagRes.data?.track?.singer === 'E2E 歌手' && tagRes.data?.track?.album === 'E2E 专辑',
  JSON.stringify({ name: tagRes.data?.track?.name, singer: tagRes.data?.track?.singer, album: tagRes.data?.track?.album }))
const t3 = ID3.read(newAbs)
check('磁盘标签五个字段都写进去了',
  t3?.title === 'E2E 标题' && t3?.artist === 'E2E 歌手' && t3?.album === 'E2E 专辑' && String(t3?.year) === '2024' && String(t3?.trackNumber) === '3',
  JSON.stringify({ title: t3?.title, artist: t3?.artist, album: t3?.album, year: t3?.year, track: t3?.trackNumber }))
if (coverSize) check('写标签保留内嵌封面', coverBytes(newAbs) === coverSize, coverSize + ' -> ' + coverBytes(newAbs))
const emptyPatch = await api('/tracks/tags', { method: 'POST', body: { id: newId, tags: {} } })
check('空补丁被拒（留空=不修改）', emptyPatch.code !== 0 && /没有需要保存的修改/.test(emptyPatch.msg || ''), JSON.stringify({ code: emptyPatch.code, msg: emptyPatch.msg }))
const badId = await api('/tracks/rename', { method: 'POST', body: { id: 'ffffffffffffffff', name: 'nope' } })
check('对不存在的曲目重命名被拒', badId.code !== 0 && /曲目不存在/.test(badId.msg || ''), JSON.stringify({ code: badId.code, msg: badId.msg }))

// --------------------------------------------------------------------------
// D. UI：菜单 → 编辑标签… → 保存；菜单 → 重命名… → 保存
//    这一段是此前唯一没有端到端验证过的路径（服务端 API 单测过，UI 保存没跑过）
// --------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('response', async (r) => {
  if (/\/web\/api\/tracks\/(rename|tags)|\/web\/api\/playlists(\/\w+)?$/.test(r.url())) {
    console.log('  [resp] ' + r.status() + ' ' + r.url().replace(BASE, '') + ' :: ' + (await r.text().catch(() => '')).slice(0, 160))
  }
})
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()) })

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => localStorage.setItem('gusi-web-token', t), token)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForSelector('#shell:not([hidden])', { timeout: 15000 })

await page.evaluate(() => { location.hash = '#/tracks' })
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

/** 在某一行上打开「…」菜单并点某个菜单项（evaluate 只收一个参数，故打包成对象） */
const clickMenu = async (rowName, itemText) => page.evaluate(async ({ name, item }) => {
  const rows = [...document.querySelectorAll('#view tbody tr')]
  const tr = rows.find((r) => r.textContent.includes(name))
  if (!tr) return { err: '行未找到: ' + name }
  tr.querySelector('.acts .more-wrap button').click()
  await new Promise((r) => setTimeout(r, 90))
  const b = [...document.querySelectorAll('.menu button')].find((x) => x.textContent === item)
  if (!b) return { err: '菜单项未找到: ' + item + ' -> ' + [...document.querySelectorAll('.menu button')].map((x) => x.textContent).join('/') }
  b.click()
  return { ok: true }
}, { name: rowName, item: itemText })

const uiTag = await clickMenu('E2E 标题', '编辑标签…')
check('UI 能点出「编辑标签…」', uiTag.ok === true, JSON.stringify(uiTag))
await page.waitForTimeout(250)
const dlgOpen = await page.evaluate(() => ({
  open: !document.querySelector('#tag-dialog').hidden,
  title: document.querySelector('#tag-title').value,
  artist: document.querySelector('#tag-artist').value,
  album: document.querySelector('#tag-album').value,
}))
check('标签弹窗打开且预填当前标签', dlgOpen.open && dlgOpen.title === 'E2E 标题' && dlgOpen.album === 'E2E 专辑', JSON.stringify(dlgOpen))
await page.evaluate(() => {
  document.querySelector('#tag-album').value = 'E2E UI 专辑'
  document.querySelector('#tag-ok').click()
})
await page.waitForTimeout(1500)
const tagToast = await page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })
check('UI 保存后提示「标签已保存」', /标签已保存/.test(tagToast), tagToast)
check('UI 保存的标签确实落到磁盘', ID3.read(newAbs)?.album === 'E2E UI 专辑', String(ID3.read(newAbs)?.album))
if (coverSize) check('UI 写标签仍保留封面', coverBytes(newAbs) === coverSize, coverSize + ' -> ' + coverBytes(newAbs))

await waitRows(1)
const uiName = 'e2e-ui-' + String(Date.now()).slice(-6)
const uiRen = await clickMenu('E2E 标题', '重命名…')
check('UI 能点出「重命名…」', uiRen.ok === true, JSON.stringify(uiRen))
await page.waitForTimeout(250)
const renDlg = await page.evaluate(() => ({ open: !document.querySelector('#dialog').hidden, val: document.querySelector('#dlg-input').value }))
check('重命名弹窗打开且预填当前名', renDlg.open && renDlg.val === 'E2E 标题', JSON.stringify(renDlg))
await page.evaluate((v) => {
  const inp = document.querySelector('#dlg-input')
  inp.value = v
  document.querySelector('#dlg-ok').click()
}, uiName)
await page.waitForTimeout(1800)
const renToast = await page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '' })
check('UI 重命名提示已同步歌单引用', /已重命名为/.test(renToast) && /已同步 \d+ 个歌单的引用/.test(renToast), renToast)
const uiNewAbs = path.join(LIB, oldDir, uiName + '.mp3')
check('UI 重命名后磁盘文件已改', fs.existsSync(uiNewAbs) && !fs.existsSync(newAbs), uiName + '.mp3')
const uiId = (await api('/tracks?page=1&size=200')).data.tracks.find((t) => t.relPath === path.join(oldDir, uiName + '.mp3'))?.id
check('UI 重命名后曲库索引同步', !!uiId && uiId !== newId, String(uiId))
const dDef2 = (await api('/playlists/default')).data.tracks
const dDef2Hit = dDef2.find((t) => t.trackId === uiId)
check('UI 重命名后歌单引用未变失效项', dDef2.length === preDefaultLen + 1 && dDef2Hit && dDef2Hit.missing === false, JSON.stringify(dDef2Hit))
await page.evaluate(() => { location.hash = '#/tracks' })
await page.waitForTimeout(1200)
const rowsShowNew = await page.evaluate((n) => [...document.querySelectorAll('#view tbody tr')].some((r) => r.textContent.includes(n)), uiName)
check('刷新后列表显示新名字', rowsShowNew, uiName)

check('无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()
stop()
console.log(`\n结果: ${pass} pass / ${fail} fail / ${skipped} skip   临时目录 ${TMP}`)
process.exit(fail ? 1 : 0)
