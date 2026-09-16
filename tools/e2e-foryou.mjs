// E2E：为你推荐（按账户听歌喜好）—— 服务端引擎
//   覆盖：口味画像（播放历史 → 歌手权重）、今日推荐/猜你喜欢的内容、在线补歌、
//         去重、当天稳定性、账户隔离、在线播放记录落盘、第三方挂掉时的退化。
//   在真实数据的副本上跑（重写绝对路径 + 泄漏硬校验），绝不碰真实曲库。
//   用法：node tools/e2e-foryou.mjs      （保留现场：KEEP=1）
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
const _APP_PASS = process.env.GS_APP_PASS || ''
if (!_APP_PASS) throw new Error('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

const KEEP = process.env.KEEP == '1'
const ROOT = process.cwd()
const REAL_DATA = path.join(ROOT, 'server', 'data')
const REAL_LIB = path.join(REAL_DATA, 'libraries', 'Slceleto')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-foryou-'))
const DATA = path.join(TMP, 'data')
const LOGS = path.join(TMP, 'logs')
const LIB = path.join(DATA, 'libraries', 'Slceleto')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = _APP_PASS

let pass = 0, fail = 0, warn = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}
const soft = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { warn++; console.log('[WARN] ' + name + '（降级，不算失败）' + (detail ? '  -- ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fingerprint = (dir) => {
  let n = 0, bytes = 0
  const walk = (p) => {
    let st
    try { st = fs.statSync(p) } catch { return }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return }
    if (st.isFile()) { n++; bytes += st.size }
  }
  walk(dir)
  return { n, bytes }
}
const REAL_BEFORE = fingerprint(REAL_LIB)

// ------------------------------ 数据副本 + 隔离校验 ------------------------------
fs.cpSync(REAL_DATA, DATA, { recursive: true })
{
  const st = JSON.parse(fs.readFileSync(path.join(LIB, 'library-settings.json'), 'utf8'))
  st.dirs = [LIB]
  fs.writeFileSync(path.join(LIB, 'library-settings.json'), JSON.stringify(st))
  const idxPath = path.join(LIB, 'library.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  for (const t of idx.tracks || []) t.filePath = path.join(LIB, t.relPath)
  fs.writeFileSync(idxPath, JSON.stringify(idx))

  // 播放历史也属于真实账户数据：清掉，保证画像是从零开始建的
  // （用户目录形如 data/users/<名字>_<hash>）
  const usersRoot = path.join(DATA, 'users')
  for (const u of fs.existsSync(usersRoot) ? fs.readdirSync(usersRoot) : []) {
    for (const f of ['web-played.json', 'web-played-online.json']) {
      const p = path.join(usersRoot, u, f)
      if (fs.existsSync(p)) fs.rmSync(p)
    }
  }

  const LEGACY_DIRS = ['/tmp/gusi-test-music', '/tmp/gusi-dl']
  const walkJson = (p) => {
    let s2
    try { s2 = fs.statSync(p) } catch { return }
    if (s2.isDirectory()) { for (const f of fs.readdirSync(p)) walkJson(path.join(p, f)); return }
    if (!/\.json$/.test(p)) return
    let txt = fs.readFileSync(p, 'utf8')
    const orig = txt
    if (txt.includes(REAL_DATA)) txt = txt.split(REAL_DATA).join(DATA)
    for (const d of LEGACY_DIRS) if (txt.includes(d)) txt = txt.split(d).join(LIB)
    if (txt !== orig) fs.writeFileSync(p, txt)
  }
  walkJson(DATA)
  const pat = new RegExp('(' + REAL_DATA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|/tmp/gusi-test-music|/tmp/gusi-dl)')
  const leaked = []
  const walk = (p) => {
    let s2
    try { s2 = fs.statSync(p) } catch { return }
    if (s2.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return }
    if (/\.json$/.test(p) && pat.test(fs.readFileSync(p, 'utf8'))) leaked.push(path.basename(p))
  }
  walk(DATA)
  if (leaked.length) {
    console.error('!! 副本里仍有指向真实曲库的绝对路径，已中止: ' + [...new Set(leaked)].join(', '))
    process.exit(3)
  }
  console.log('数据副本: ' + DATA + '（隔离校验通过）')
}

// ------------------------------ 实例管理 ------------------------------
const freePort = async () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
})
const PORT = await freePort()
const BASE = 'http://127.0.0.1:' + PORT
fs.mkdirSync(LOGS, { recursive: true })

let child = null
const startSrv = async () => {
  child = spawn(process.execPath, [path.resolve('server/server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), BIND_IP: '127.0.0.1',
      DATA_PATH: DATA, LOG_PATH: LOGS,
      GS_ADMIN_PASSWORD: ADMIN_PW,
      GS_WEB_STATIC_DIR: path.resolve('ui/dist'),
      GS_APP_STATIC_DIR: path.resolve('ui/app'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d))
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return } catch {}
    await sleep(400)
  }
  throw new Error('服务未起来')
}
const stopSrv = async () => {
  if (!child) return
  const c = child
  child = null
  // 先 SIGTERM：服务端 exit hook 会把防抖中的播放历史刷盘（SIGKILL 会丢掉最后 2 秒）
  try { c.kill('SIGTERM') } catch {}
  await sleep(1200)
  try { c.kill('SIGKILL') } catch {}
  // 等端口真正释放，否则重启会 EADDRINUSE
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/admin/api/status') } catch { return }
    await sleep(200)
  }
}
process.on('exit', () => { try { child?.kill('SIGKILL') } catch {}; if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} } })
process.on('uncaughtException', (e) => { console.error(e); try { child?.kill('SIGKILL') } catch {}; process.exit(1) })

await startSrv()
console.log('隔离实例就绪: ' + BASE + '\n')

// ------------------------------ 登录 ------------------------------
const login = async (user, pw) => {
  const r = await fetch(BASE + '/web/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user, password: pw }),
  })
  const j = await r.json().catch(() => ({}))
  return j?.data?.token || ''
}
let TOKEN = await login(WEB_USER, WEB_PASS)
check('web 登录拿到 token', !!TOKEN)
const api = async (p, opt = {}, token = TOKEN) => {
  const r = await fetch(BASE + '/web/api' + p, {
    method: opt.method || 'GET',
    headers: { 'X-Web-Token': token, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

// ------------------------------ 一、冷启动（有曲库、无历史） ------------------------------
console.log('一、冷启动画像')
const tracks = (await api('/tracks?page=1&size=500'))?.data?.tracks || []
check('曲库有曲目', tracks.length >= 10, 'total=' + tracks.length)

let fy = (await api('/for-you'))?.data || {}
check('for-you 冷启动返回两张卡片', !!fy.daily && !!fy.guess, 'daily=' + (fy.daily?.tracks?.length ?? 0) + ' guess=' + (fy.guess?.tracks?.length ?? 0))
check('冷启动无偏好数据（cold=true）', fy.profile?.cold === true, JSON.stringify(fy.profile?.signals || {}))
check('冷启动仍然给得出本地推荐', (fy.daily?.tracks?.length || 0) >= 8 && (fy.guess?.tracks?.length || 0) >= 6,
  'daily=' + fy.daily?.tracks?.length + ' guess=' + fy.guess?.tracks?.length)
check('冷启动文案说明「还不了解你」', /还不/.test(fy.daily?.reason || ''), fy.daily?.reason)

// ------------------------------ 二、种口味：反复听某歌手的歌 ------------------------------
console.log('\n二、口味画像（播放历史 → 歌手权重）')
const bySinger = new Map()
for (const t of tracks) {
  const s = (t.singer || '').trim()
  if (!s || s === '未知歌手') continue
  if (!bySinger.has(s)) bySinger.set(s, [])
  bySinger.get(s).push(t)
}
const [singerA, tracksA] = [...bySinger.entries()].sort((a, b) => b[1].length - a[1].length)[0] || ['', []]
check('找到一个有多首曲目的歌手作为口味锚点', tracksA.length >= 3, singerA + ' · ' + tracksA.length + ' 首')
// 按「最近在听」的顺序播放：倒序 POST，最后播的那首排最前
for (const t of [...tracksA].reverse()) await api('/played', { method: 'POST', body: { trackId: t.id } })
const after = (await api('/played'))?.data?.tracks || []
check('播放历史已写入（最近在前）', after.length === tracksA.length && after[0].id === tracksA[0].id,
  after.map((t) => t.singer).join(','))

// 播放记录写入有 2s 防抖：等它落盘再重启，否则丢的是刚播的那几首
await sleep(2600)
// 再往副本里塞一条「本账户已下载」的记录：主动下载 = 明确的喜欢，应计入画像
{
  const dlFile = path.join(DATA, 'downloads.json')
  const dl = JSON.parse(fs.readFileSync(dlFile, 'utf8'))
  dl.push({
    id: 'e2e-dl-signal', userName: WEB_USER, source: 'wy', rid: 'e2e-rid-dl',
    name: '下载信号测试曲', singer: '下载歌手Z', album: '下载专辑', duration: '200000',
    status: 'done', size: 1024, bytes: 1024, attempts: 1, maxAttempts: 3, retryAt: 0,
    createdAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now(), error: '',
  })
  fs.writeFileSync(dlFile, JSON.stringify(dl))
}
// 画像与推荐结果都是进程内缓存（5 分钟），重启一次以验证「重新计算」的结果
await stopSrv()
await startSrv()
TOKEN = await login(WEB_USER, WEB_PASS)

fy = (await api('/for-you'))?.data || {}
check('画像头部歌手 = 反复听的歌手', fy.profile?.singers?.[0]?.name === singerA,
  JSON.stringify((fy.profile?.singers || []).slice(0, 3).map((s) => s.name + ':' + s.weight.toFixed(2))))
check('画像记录了播放信号', (fy.profile?.signals?.played || 0) >= tracksA.length && fy.profile?.cold === false,
  JSON.stringify(fy.profile?.signals || {}))
check('推荐文案带上你的口味', (fy.daily?.reason || '').includes(singerA), fy.daily?.reason)
check('下载记录也进画像（主动下载=喜欢）',
  (fy.profile?.signals?.downloaded || 0) === 1 &&
  (fy.profile?.singers || []).some((s0) => s0.name === '下载歌手Z' && s0.weight > 0),
  JSON.stringify({ signals: fy.profile?.signals, singers: (fy.profile?.singers || []).map((s0) => s0.name) }))

const daily = fy.daily?.tracks || []
const guess = fy.guess?.tracks || []
const isA = (t) => (t.singer || '').includes(singerA.split(/[&、,，\/]/)[0]) || String(t.singer || '').includes(singerA)
const dailyA = daily.filter(isA).length
check('今日推荐以你的口味歌手为主', dailyA >= 2, 'daily 里 ' + singerA + ' = ' + dailyA + ' / ' + daily.length)
check('猜你喜欢参照「最近在听」', guess.filter(isA).length >= 1, 'guess 里 ' + singerA + ' = ' + guess.filter(isA).length)
check('本地曲目已在推荐里（不是空表）', daily.some((t) => t.kind !== 'online') && guess.some((t) => t.kind !== 'online'),
  'daily 本地=' + daily.filter((t) => t.kind !== 'online').length + ' guess 本地=' + guess.filter((t) => t.kind !== 'online').length)

// ------------------------------ 三、在线补歌 + 去重 + 稳定性 ------------------------------
console.log('\n三、在线补歌 / 去重 / 稳定性')
soft('按口味歌手补到了在线新歌', (fy.daily?.onlineCount || 0) > 0 && (fy.guess?.onlineCount || 0) > 0,
  'daily 在线=' + (fy.daily?.onlineCount ?? 0) + ' guess 在线=' + (fy.guess?.onlineCount ?? 0))
const onlineRows = [...daily, ...guess].filter((t) => t.kind === 'online')
if (onlineRows.length) {
  const o = onlineRows[0]
  check('在线行字段齐全（前端可直接播放）',
    !!o.id && !!o.source && !!o.rid && !!o.name && !!o.singer && !!o.interval && Number(o.interval) > 0,
    JSON.stringify({ id: o.id, source: o.source, rid: o.rid, interval: o.interval, hasPic: !!o.pic }))
  check('在线补的都是口味歌手的歌', onlineRows.every(isA), onlineRows.map((t) => t.singer).slice(0, 3).join(' | '))
  const localKeys = new Set(tracks.map((t) => (t.name || '').toLowerCase().replace(/\s+/g, '') + '|' + (t.singer || '').toLowerCase().replace(/\s+/g, '')))
  const dupWithLocal = onlineRows.filter((t) => localKeys.has((t.name || '').toLowerCase().replace(/\s+/g, '') + '|' + (t.singer || '').toLowerCase().replace(/\s+/g, '')))
  check('不会推荐本地已经有的歌', dupWithLocal.length === 0, dupWithLocal.map((t) => t.name).join(' | '))
}
const keyOf = (t) => (t.name || '') + '|' + (t.singer || '')
for (const [label, list] of [['今日推荐', daily], ['猜你喜欢', guess]]) {
  check(label + '内部无重复', new Set(list.map((t) => t.id)).size === list.length && new Set(list.map(keyOf)).size === list.length,
    list.length + ' 首 / 去重后 ' + new Set(list.map(keyOf)).size)
}
const overlap = daily.filter((t) => t.kind === 'online').filter((t) => guess.some((g) => g.id === t.id))
check('两张卡片不重复推同一首在线歌', overlap.length === 0, overlap.map((t) => t.name).join(' | '))
check('卡片封面拼图可取到素材', (fy.daily?.cover?.length || 0) >= 1 && (fy.guess?.cover?.length || 0) >= 1,
  'daily cover=' + fy.daily?.cover?.length)
check('本地/在线计数与曲目数一致',
  fy.daily.localCount + fy.daily.onlineCount === daily.length && fy.guess.localCount + fy.guess.onlineCount === guess.length,
  'daily ' + fy.daily.localCount + '+' + fy.daily.onlineCount + '=' + daily.length)

const fy2 = (await api('/for-you'))?.data || {}
check('同一天内结果稳定（缓存命中，不重复消耗第三方）',
  fy2.daily.tracks.map((t) => t.id).join(',') === daily.map((t) => t.id).join(','),
  'daily 前 3 = ' + daily.slice(0, 3).map((t) => t.name).join(' | '))
check('今日推荐当天不随刷新变化', fy2.daily.updatedAt === fy.daily.updatedAt)

// ------------------------------ 四、在线播放记录 → 画像 ------------------------------
console.log('\n四、在线播放记录')
const r1 = await api('/played/online', { method: 'POST', body: { source: 'kw', rid: 'test-rid-1', name: '测试在线曲', singer: '在线歌手X', album: '在线专辑' } })
const r2 = await api('/played/online', { method: 'POST', body: { source: 'kw' } })
check('在线播放记录接口可用', r1.status === 200, 'status=' + r1.status)
check('缺少字段时拒绝', r2.status === 400, 'status=' + r2.status)
await sleep(2500) // 写入防抖 2s
const userDir = fs.readdirSync(path.join(DATA, 'users')).find((u) => /^slceleto/i.test(u))
const onlineFile = path.join(DATA, 'users', userDir || 'Slceleto', 'web-played-online.json')
let saved = null
try { saved = JSON.parse(fs.readFileSync(onlineFile, 'utf8')) } catch {}
check('在线播放记录落盘（独立文件，不吃曲库索引）',
  !!saved?.list?.length && saved.list[0].rid === 'test-rid-1' && saved.list[0].singer === '在线歌手X',
  onlineFile.replace(TMP, '…'))

// ------------------------------ 五、账户隔离 ------------------------------
console.log('\n五、账户隔离（不同账户不同口味）')
const adminLogin = await (await fetch(BASE + '/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: ADMIN_PW }),
})).json()
const ATOKEN = adminLogin?.token || ''
const mkUser = await fetch(BASE + '/admin/api/users', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ATOKEN },
  body: JSON.stringify({ name: 'e2e_taste_2', password: 'e2e-pass-2' }),
})
check('创建第二个账户', mkUser.status === 200, 'status=' + mkUser.status)
const T2 = await login('e2e_taste_2', 'e2e-pass-2')
check('第二账户登录成功', !!T2)
const fyB = (await api('/for-you', {}, T2))?.data || {}
check('第二账户是独立画像（没有别人的播放历史）',
  (fyB.profile?.signals?.played || 0) === 0 && (fyB.profile?.singers || []).length === 0,
  JSON.stringify(fyB.profile?.signals || {}))
check('第二账户不会拿到别人曲库的推荐', (fyB.daily?.tracks?.length || 0) === 0, 'daily=' + (fyB.daily?.tracks?.length ?? 0))
check('第二账户在曲库为空时不炸', fyB.daily?.name === '今日推荐' && Array.isArray(fyB.guess?.tracks))

// ------------------------------ 六、真实曲库零改动 ------------------------------
console.log('\n六、隔离校验')
const REAL_AFTER = fingerprint(REAL_LIB)
check('真实曲库指纹未变', REAL_AFTER.n === REAL_BEFORE.n && REAL_AFTER.bytes === REAL_BEFORE.bytes,
  REAL_BEFORE.n + '/' + REAL_BEFORE.bytes + ' → ' + REAL_AFTER.n + '/' + REAL_AFTER.bytes)
{
  const realUsers = fs.existsSync(path.join(REAL_DATA, 'users')) ? fs.readdirSync(path.join(REAL_DATA, 'users')) : []
  const dirty = realUsers.filter((u) => {
    const f = path.join(REAL_DATA, 'users', u, 'web-played-online.json')
    return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('test-rid-1')
  })
  check('真实账户的播放历史没被测试写入', dirty.length === 0, dirty.join(',') || '干净')
}

console.log('\n今日推荐（前 8 首）：')
for (const t of daily.slice(0, 8)) console.log('  ' + (t.kind === 'online' ? '[在线] ' : '[本地] ') + t.name + ' — ' + t.singer)
console.log('猜你喜欢（前 6 首）：')
for (const t of guess.slice(0, 6)) console.log('  ' + (t.kind === 'online' ? '[在线] ' : '[本地] ') + t.name + ' — ' + t.singer)

await stopSrv()
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 / ' + warn + ' 降级')
console.log('工作目录: ' + TMP + (KEEP ? '（保留）' : '（已清理）'))
process.exit(fail ? 1 : 0)
