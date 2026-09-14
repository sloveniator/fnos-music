// E2E：汽水（soda）在线曲目 → 下载落盘 → 自动入库 → 可拉流播放
//   全程在真实数据的副本上跑（重写绝对路径 + 硬校验），绝不碰线上实例与真实曲库。
//   用法：node tools/e2e-soda-download.mjs        （保留现场：KEEP=1）
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP = process.env.KEEP == '1'
const ROOT = process.cwd()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-soda-'))
const DATA = path.join(TMP, 'data')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = 'REDACTED'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitUp = async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch {}
    await sleep(400)
  }
  return false
}
if (!await waitUp()) { console.error('服务未起来（pid ' + child.pid + '）'); stop(); process.exit(2) }
console.log('隔离实例就绪: ' + BASE + '  (pid ' + child.pid + ')\n')

// ------------------------------ 1. 启用汽水源 ------------------------------
const admLogin = await (await fetch(BASE + '/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: ADMIN_PW }),
})).json()
const ADM = { 'X-Admin-Token': admLogin?.data?.token || admLogin?.token || '' }
const st0 = await (await fetch(BASE + '/admin/api/library/settings', { headers: ADM })).json()
const cur = st0?.data?.onlineSources || []
const next = [...new Set([...cur, 'soda'])]
await fetch(BASE + '/admin/api/library/settings', {
  method: 'POST', headers: { ...ADM, 'Content-Type': 'application/json' },
  body: JSON.stringify({ onlineSources: next }),
})
const saved = (await (await fetch(BASE + '/admin/api/library/settings', { headers: ADM })).json())?.data?.onlineSources || []
check('管理后台启用 soda', saved.includes('soda'), JSON.stringify(saved))

// ------------------------------ 2. App 登录 ------------------------------
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
const dirInfo = await api('/downloads/dir')
check('下载目录指向副本曲库', String(JSON.stringify(dirInfo)).includes(LIB), JSON.stringify(dirInfo).slice(0, 160))

// ------------------------------ 3. 挑一首最短的免费曲（下载最快） ------------------------------
const sr = await api('/online/search?source=soda&type=song&q=' + encodeURIComponent('杰伦') + '&page=1&size=30')
const list = sr?.data?.list || []
const candidates = list.filter((t) => t.intervalMs > 0).sort((a, b) => a.intervalMs - b.intervalMs)
const pick = candidates[0]
check('搜到可下载曲目', !!pick, pick ? `${pick.name} / ${pick.singer} / ${Math.round(pick.intervalMs / 1000)}s / rid=${pick.id}` : JSON.stringify(sr).slice(0, 160))
if (!pick) { stop(); process.exit(1) }

// ------------------------------ 4. 入队下载 ------------------------------
const beforeCount = (await api('/stats'))?.data?.tracks || 0
console.log('  入队前曲目数: ' + beforeCount)
const enq = await api('/downloads/enqueue', {
  method: 'POST',
  body: { items: [{ source: 'soda', id: pick.id, name: pick.name, singer: pick.singer, intervalMs: pick.intervalMs, pic: pick.pic, album: pick.album }] },
})
check('入队被接受', enq?.data?.accepted === 1, JSON.stringify(enq).slice(0, 200))

let task = null
for (let i = 0; i < 90; i++) {
  const t = await api('/downloads/tasks')
  task = (t?.data?.tasks || []).find((x) => x.rid === pick.id && x.source === 'soda') || null
  if (task && (task.status === 'done' || task.status === 'failed')) break
  await sleep(1000)
}
check('下载任务完成', task?.status === 'done', task ? `status=${task.status} err=${task.error || '-'} bytes=${task.bytes}` : '未找到任务')

// ------------------------------ 5. 落盘校验：位置 / 扩展名 / 容器 ------------------------------
const fp = task?.filePath || ''
check('有落盘路径', !!fp, fp)
if (fp) {
  check('落在副本曲库目录内', fp.startsWith(LIB + path.sep), fp)
  check('扩展名为 .m4a', fp.endsWith('.m4a'), path.basename(fp))
  const rel = path.relative(LIB, fp)
  check('按 歌手/专辑/曲名 分目录', rel.split(path.sep).length >= 2, rel)
  const exists = fs.existsSync(fp)
  check('文件真实存在', exists)
  if (exists) {
    const st = fs.statSync(fp)
    const fd = fs.openSync(fp, 'r')
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    fs.closeSync(fd)
    check('文件非空', st.size > 50 * 1024, st.size + ' bytes')
    check('容器为 MP4/M4A（ftypM4A）', head.slice(4, 8).toString() === 'ftyp' && head.slice(8, 12).toString() === 'M4A ', head.toString('hex'))
    check('未落进回收站', !fp.includes('.gusi-trash'))
    check('大小与任务记录一致', st.size === task.size, `fs=${st.size} task=${task.size}`)
  }
}

// ------------------------------ 6. 自动入库（下载完成触发增量扫描） ------------------------------
let hit = null
for (let i = 0; i < 60; i++) {
  const r = await api('/tracks?q=' + encodeURIComponent(pick.name) + '&size=50')
  hit = (r?.data?.tracks || []).find((t) => (t.ext || '').toLowerCase() === 'm4a') || null
  if (hit) break
  await sleep(1000)
}
const after = (await api('/stats'))?.data?.tracks || 0
check('曲库曲目数 +1', after === beforeCount + 1, `${beforeCount} -> ${after}`)
check('新曲目已被索引', !!hit, hit ? `id=${hit.id} name=${hit.name} singer=${hit.singer} ext=${hit.ext} size=${hit.size}` : '未索引到')

// ------------------------------ 7. 拉流播放（本机文件） ------------------------------
if (hit) {
  const u = BASE + '/web/media/stream/' + encodeURIComponent(hit.id) + '?k=' + encodeURIComponent(TOKEN)
  const r = await fetch(u, { headers: { Range: 'bytes=0-4095' } })
  const b = Buffer.from(await r.arrayBuffer())
  check('本地 m4a 拉流 206', r.status === 206, 'status=' + r.status)
  check('Content-Type=audio/mp4', (r.headers.get('content-type') || '') === 'audio/mp4', String(r.headers.get('content-type')))
  check('返回音频字节', b.slice(4, 8).toString() === 'ftyp', b.slice(0, 12).toString('hex'))
  check('时长/专辑/歌手元数据已解析', /^\d+:\d{2}$/.test(String(hit.interval || '')) && !!hit.album && !!hit.singer,
    `interval=${hit.interval} album=${hit.album} singer=${hit.singer} ext=${hit.ext}`)
}

// ------------------------------ 8. 重复入队必须幂等（复用已存在文件，不重复下载/不产生副本） ------------------------------
const again = await api('/downloads/enqueue', {
  method: 'POST',
  body: { items: [{ source: 'soda', id: pick.id, name: pick.name, singer: pick.singer, intervalMs: pick.intervalMs, pic: pick.pic, album: pick.album }] },
})
let t2 = null
if ((again?.data?.accepted || 0) > 0) {
  for (let i = 0; i < 30; i++) {
    const t = await api('/downloads/tasks')
    t2 = (t?.data?.tasks || []).filter((x) => x.rid === pick.id && x.source === 'soda').pop() || null
    if (t2 && (t2.status === 'done' || t2.status === 'failed')) break
    await sleep(1000)
  }
}
const dirFiles = fp ? fs.readdirSync(path.dirname(fp)).filter((f) => f.toLowerCase().endsWith('.m4a')) : []
check('重复入队幂等（done 且复用原文件）', (again?.data?.accepted || 0) === 0 || (t2?.status === 'done' && t2?.filePath === fp),
  'accepted=' + (again?.data?.accepted ?? '-') + ' reasons=' + JSON.stringify(again?.data?.reasons || []) + ' status=' + (t2?.status || '-'))
check('曲目目录未产生重复文件', dirFiles.length === 1, JSON.stringify(dirFiles))
const after2 = (await api('/stats'))?.data?.tracks || 0
check('曲目数未被重复计数', after2 === after, `${after} -> ${after2}`)

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
if (KEEP) console.log('现场保留: ' + TMP)
else console.log('临时目录已清理')
stop()
process.exit(fail ? 2 : 0)
