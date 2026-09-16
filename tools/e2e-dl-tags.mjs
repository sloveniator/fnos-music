// E2E：下载文件的标签内嵌（封面 APIC + 歌词 USLT/SYLT）
//   覆盖两条下载路径，它们共用 server/src/downloads/tags.ts：
//     1. 云盘落盘（downloads/queue.ts）：下载完成后就地写标签 → 入库文件即带图带词
//     2. 浏览器直下（/web/media/online/*?dl=1）：服务端先落临时文件写标签，再整文件回传
//   同时覆盖三条歌词来源：源内歌词（wy）、跨源文本兜底（kw 无原生歌词 → 酷狗/QQ）、
//   以及 m4a（汽水）走裸流转发不写标签的回归。
//   全程在真实数据的副本上跑（重写绝对路径 + 硬校验），绝不碰线上实例与真实曲库。
//   用法：node tools/e2e-dl-tags.mjs        （保留现场：KEEP=1）
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
const ROOT = process.cwd()
const ID3 = require(path.join(ROOT, 'server', 'node_modules', 'node-id3'))

const KEEP = process.env.KEEP == '1'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-tags-'))
const DATA = path.join(TMP, 'data')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = _APP_PASS
const LIB = path.join(DATA, 'libraries', WEB_USER)

const freePort = async () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
})
const PORT = await freePort()
const BASE = 'http://127.0.0.1:' + PORT

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------ 数据副本 + 隔离校验 ------------------------------
fs.cpSync(path.join(ROOT, 'server', 'data'), DATA, { recursive: true })
{
  const st = JSON.parse(fs.readFileSync(path.join(LIB, 'library-settings.json'), 'utf8'))
  st.dirs = [LIB]
  fs.writeFileSync(path.join(LIB, 'library-settings.json'), JSON.stringify(st))

  const idxPath = path.join(LIB, 'library.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  for (const t of idx.tracks || []) t.filePath = path.join(LIB, t.relPath)
  fs.writeFileSync(idxPath, JSON.stringify(idx))

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

  const leaked = (() => {
    const out = []
    const pat = new RegExp('(' + realData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|/tmp/gusi-test-music|/tmp/gusi-dl)')
    const walk = (p) => {
      let s2
      try { s2 = fs.statSync(p) } catch { return }
      if (s2.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return }
      if (!/\.json$/.test(p)) return
      if (pat.test(fs.readFileSync(p, 'utf8'))) out.push(path.basename(p))
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

// ------------------------------ 启动隔离实例 ------------------------------
let stopping = false
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
const stop = () => { stopping = true; try { child.kill('SIGKILL') } catch {} }
process.on('exit', () => { stop(); if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} } })
process.on('uncaughtException', (e) => { console.error(e); process.exit(1) })

const waitUp = async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch {}
    await sleep(400)
  }
  return false
}
if (!await waitUp()) { console.error('服务未起来（pid ' + child.pid + '）'); stop(); process.exit(2) }
console.log('隔离实例就绪: ' + BASE + '  (pid ' + child.pid + ')\n')

// ------------------------------ 登录 ------------------------------
const admLogin = await (await fetch(BASE + '/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: ADMIN_PW }),
})).json()
const ADM = { 'X-Admin-Token': admLogin?.data?.token || admLogin?.token || '' }
const st0 = await (await fetch(BASE + '/admin/api/library/settings', { headers: ADM })).json()
const cur = st0?.data?.onlineSources || []
await fetch(BASE + '/admin/api/library/settings', {
  method: 'POST', headers: { ...ADM, 'Content-Type': 'application/json' },
  body: JSON.stringify({ onlineSources: [...new Set([...cur, 'kw', 'wy', 'soda'])] }),
})
const enabled = (await (await fetch(BASE + '/admin/api/library/settings', { headers: ADM })).json())?.data?.onlineSources || []
check('在线源就绪 kw/wy/soda', ['kw', 'wy', 'soda'].every((s) => enabled.includes(s)), JSON.stringify(enabled))

const lg = await (await fetch(BASE + '/web/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: WEB_USER, password: WEB_PASS }),
})).json()
const TOKEN = lg?.data?.token || ''
check('web 登录拿到 token', !!TOKEN)
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + '/web/api' + p, {
    method: opt.method || 'GET',
    headers: { 'X-Web-Token': TOKEN, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

// ------------------------------ 工具 ------------------------------
/** 下载直下 URL（与前端 downloadUrl 同构） */
const dlUrl = (pick, extra = {}) => {
  const q = [
    'dl=1',
    'name=' + encodeURIComponent((pick.name || '') + (pick.singer ? ' - ' + pick.singer : '')),
    'title=' + encodeURIComponent(pick.name || ''),
    'singer=' + encodeURIComponent(pick.singer || ''),
    'album=' + encodeURIComponent(pick.album || ''),
    'dur=' + encodeURIComponent(String(pick.intervalMs || '')),
    'k=' + encodeURIComponent(TOKEN),
  ]
  if (pick.pic) q.push('pic=' + encodeURIComponent(pick.pic))
  for (const [k, v] of Object.entries(extra)) q.push(k + '=' + encodeURIComponent(v))
  return BASE + '/web/media/online/' + encodeURIComponent(pick.source) + '/' + encodeURIComponent(pick.id) + '?' + q.join('&')
}
/** SYLT 读出来可能是对象或数组，统一成数组 */
const sylt = (tags) => {
  const s = tags?.synchronisedLyrics
  if (!s) return []
  return Array.isArray(s) ? s : [s]
}
const tagReport = (tags) => {
  const img = tags?.image?.imageBuffer?.length || 0
  const uslt = String(tags?.unsynchronisedLyrics?.text || '')
  const sy = sylt(tags)
  return `title=${tags?.title} artist=${tags?.artist} album=${tags?.album} cover=${img}B uslt=${uslt.length}B(${(uslt.match(/\[/g) || []).length} 行) sylt=${sy.length}帧`
}
const tmpLeftovers = () => {
  try { return fs.readdirSync(path.join(DATA, 'tmp')).filter((f) => f.startsWith('dl-')) } catch { return [] }
}

const searchKw = async (q) => {
  const r = await api('/online/search?source=kw&type=song&q=' + encodeURIComponent(q) + '&page=1&size=20')
  return (r?.data?.list || []).filter((t) => t.intervalMs > 0).sort((a, b) => a.intervalMs - b.intervalMs)
}

// 酷我没有原生歌词接口，它的内嵌歌词全靠「歌名+歌手」跨源文本兜底（酷狗 → QQ）。
// 所以测试曲目必须挑一首兜底确实找得到的：先用同一条兜底链路探一次，
// 否则会把「这首歌全网没词」误判成「标签写坏了」（第一次就踩了：DJ 版海阔天空无词）。
const fallback = require(path.join(ROOT, 'server', 'server', 'online', 'lyric-fallback.js'))
const probeLyric = async (name, singer) => {
  try { const kg = await fallback.kgLyricByText(name, singer, 0); if (kg && kg.includes('[')) return 'kg' } catch { /* 下一个源 */ }
  try { const tx = await fallback.txLyricByText(name, singer); if (tx && tx.includes('[')) return 'tx' } catch { /* 无 */ }
  return ''
}
let kwPick = null, kwProbed = 0, kwProvider = ''
for (const q of ['光辉岁月 Beyond', '海阔天空 Beyond', '真的爱你 Beyond']) {
  for (const t of (await searchKw(q)).slice(0, 8)) {
    if (!/beyond|b安/i.test(t.singer || '')) continue
    kwProbed++
    const p = await probeLyric(t.name, t.singer)
    if (p) { kwPick = { ...t, source: 'kw' }; kwProvider = p; break }
  }
  if (kwPick) break
}
check('kw 挑到「兜底有词」的候选曲目', !!kwPick, kwPick
  ? `${kwPick.name} / ${kwPick.singer} / ${Math.round(kwPick.intervalMs / 1000)}s rid=${kwPick.id} 兜底源=${kwProvider}（试了 ${kwProbed} 首）`
  : `试了 ${kwProbed} 首都没词`)
if (!kwPick) { stop(); process.exit(1) }

// ==========================================================================
// 一、云盘落盘路径（queue.ts）：kw（无原生歌词 → 跨源兜底）
// ==========================================================================
const enq = await api('/downloads/enqueue', {
  method: 'POST',
  body: { items: [{ source: 'kw', id: kwPick.id, name: kwPick.name, singer: kwPick.singer, intervalMs: kwPick.intervalMs, pic: kwPick.pic, album: kwPick.album }] },
})
check('kw 入队被接受', enq?.data?.accepted === 1, JSON.stringify(enq).slice(0, 200))

let qTask = null
for (let i = 0; i < 90; i++) {
  const t = await api('/downloads/tasks')
  qTask = (t?.data?.tasks || []).find((x) => x.rid === kwPick.id && x.source === 'kw') || null
  if (qTask && (qTask.status === 'done' || qTask.status === 'failed')) break
  await sleep(1000)
}
check('kw 下载任务完成', qTask?.status === 'done', qTask ? `status=${qTask.status} err=${qTask.error || '-'} bytes=${qTask.bytes}` : '未找到任务')

if (qTask?.filePath && fs.existsSync(qTask.filePath)) {
  const tags = ID3.read(qTask.filePath)
  console.log('  落盘标签: ' + tagReport(tags))
  check('落盘：标题已写入', tags.title === kwPick.name, `${tags.title}`)
  check('落盘：歌手已写入', tags.artist === kwPick.singer, `${tags.artist}`)
  check('落盘：专辑已写入（源带专辑时须一致）', kwPick.album ? tags.album === kwPick.album : true, `源=${kwPick.album} 标签=${tags.album}`)
  check('落盘：内嵌封面 APIC（源无图时按文本兜底）', (tags?.image?.imageBuffer?.length || 0) > 1000,
    `${(tags?.image?.imageBuffer?.length || 0)}B 源图=${kwPick.pic ? '有' : '无 → 走兜底'}`)
  check('落盘：内嵌歌词 USLT（LRC 明文）', String(tags?.unsynchronisedLyrics?.text || '').includes('['),
    String(tags?.unsynchronisedLyrics?.text || '').slice(0, 40).replace(/\n/g, ' | '))
  const sy = sylt(tags)
  check('落盘：内嵌歌词 SYLT（逐行时间轴）', sy.length > 0 && (sy[0]?.synchronisedText?.length || 0) > 3,
    `帧=${sy.length} 行=${sy[0]?.synchronisedText?.length || 0} 首行时间=${sy[0]?.synchronisedText?.[0]?.timeStamp}`)
  check('落盘：文件未落进回收站', !qTask.filePath.includes('.gusi-trash'), path.basename(qTask.filePath))
} else {
  check('落盘：文件存在', false, String(qTask?.filePath))
}

// ==========================================================================
// 二、浏览器直下路径（?dl=1）：wy（原生歌词），也验证 kw 的兜底歌词
// ==========================================================================
const wyList = await (async () => {
  const r = await api('/online/search?source=wy&type=song&q=' + encodeURIComponent('海阔天空') + '&page=1&size=20')
  return (r?.data?.list || []).filter((t) => t.intervalMs > 0).sort((a, b) => a.intervalMs - b.intervalMs)
})()
check('wy 搜到候选曲目', wyList.length > 0, wyList.length ? `${wyList[0].name} / ${wyList[0].singer} rid=${wyList[0].id}` : '空')
const wyPick = wyList.length ? { ...wyList[0], source: 'wy' } : null

if (wyPick) {
  const out = path.join(TMP, 'browser-wy.mp3')
  const r = await fetch(dlUrl(wyPick))
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(out, buf)
  const cd = String(r.headers.get('content-disposition') || '')
  check('直下 wy：HTTP 200', r.status === 200, 'status=' + r.status)
  check('直下 wy：Content-Disposition 带 .mp3 与 UTF-8 文件名', /\.mp3/.test(cd) && /filename\*=UTF-8''/.test(cd), cd.slice(0, 120))
  check('直下 wy：文件非空', buf.length > 100 * 1024, buf.length + 'B')
  const tags = ID3.read(out)
  console.log('  直下标签: ' + tagReport(tags))
  check('直下 wy：标题/歌手已写入', tags.title === wyPick.name && tags.artist === wyPick.singer, `${tags.title} / ${tags.artist}`)
  check('直下 wy：内嵌封面 APIC', (tags?.image?.imageBuffer?.length || 0) > 1000, (tags?.image?.imageBuffer?.length || 0) + 'B')
  check('直下 wy：内嵌歌词（源内）', String(tags?.unsynchronisedLyrics?.text || '').includes('['),
    String(tags?.unsynchronisedLyrics?.text || '').slice(0, 40).replace(/\n/g, ' | '))
  check('直下 wy：歌词时间轴可解析', sylt(tags).length > 0, 'SYLT 帧=' + sylt(tags).length)
}

// kw 直下（无原生歌词源）：走跨源文本兜底
{
  const out = path.join(TMP, 'browser-kw.mp3')
  const r = await fetch(dlUrl(kwPick))
  const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(out, buf)
  const tags = ID3.read(out)
  console.log('  直下 kw 标签: ' + tagReport(tags))
  check('直下 kw：HTTP 200 且文件非空', r.status === 200 && buf.length > 100 * 1024, `status=${r.status} bytes=${buf.length}`)
  check('直下 kw：内嵌封面 APIC（源无图时按文本兜底）', (tags?.image?.imageBuffer?.length || 0) > 1000,
    `${(tags?.image?.imageBuffer?.length || 0)}B 源图=${kwPick.pic ? '有' : '无 → 走兜底'}`)
  check('直下 kw：内嵌歌词（跨源兜底）', String(tags?.unsynchronisedLyrics?.text || '').includes('['),
    String(tags?.unsynchronisedLyrics?.text || '').slice(0, 40).replace(/\n/g, ' | '))
}

// 临时文件必须清干净（下载走的是 data/tmp 中转）
await sleep(800)
check('直下后 data/tmp 无残留临时文件', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()))

// ==========================================================================
// 三、回归：不写标签的路径不能被改坏
// ==========================================================================
{
  // 3.1 非下载模式：原始流转发（Range 206 + 无 Content-Disposition + 无标签）
  const plain = BASE + '/web/media/online/kw/' + encodeURIComponent(kwPick.id) + '?k=' + encodeURIComponent(TOKEN)
  const r = await fetch(plain, { headers: { Range: 'bytes=0-4095' } })
  const b = Buffer.from(await r.arrayBuffer())
  check('回归：播放流仍走裸转发（206 / 无 attachment）', r.status === 206 && !r.headers.get('content-disposition'), `status=${r.status} cd=${r.headers.get('content-disposition')}`)
  check('回归：播放流返回音频字节', b.length > 1000, b.length + 'B')

  // 3.2 汽水（m4a）下载：非 mp3 容器保持原样回传，不能被写标签流程搞坏
  const sodaList = await (async () => {
    const r2 = await api('/online/search?source=soda&type=song&q=' + encodeURIComponent('杰伦') + '&page=1&size=20')
    return (r2?.data?.list || []).filter((t) => t.intervalMs > 0).sort((a, b) => a.intervalMs - b.intervalMs)
  })()
  if (sodaList.length) {
    const sp = { ...sodaList[0], source: 'soda' }
    const r = await fetch(dlUrl(sp))
    const b = Buffer.from(await r.arrayBuffer())
    const isM4a = b.slice(4, 8).toString() === 'ftyp'
    check('回归：汽水 m4a 下载仍可用', r.status === 200 && b.length > 20 * 1024 && isM4a, `status=${r.status} bytes=${b.length} ftyp=${isM4a}`)
    check('回归：汽水下载未被误标为 mp3 容器', !/\.mp3/.test(String(r.headers.get('content-disposition') || '')), String(r.headers.get('content-disposition') || ''))
    await sleep(400)
    check('回归：汽水直下后 data/tmp 亦无残留', tmpLeftovers().length === 0, JSON.stringify(tmpLeftovers()))
  } else {
    check('回归：汽水候选曲目', false, '搜索为空，无法覆盖 m4a 回归')
  }
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
if (KEEP) console.log('现场保留: ' + TMP + '（浏览器直下产物在 ' + TMP + '/browser-*.mp3）')
else console.log('临时目录已清理')
stop()
process.exit(fail ? 2 : 0)
