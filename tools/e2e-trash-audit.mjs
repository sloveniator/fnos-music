// E2E：曲库破坏性操作的审计日志（删除 / 恢复 / 彻底删除）
//   背景：整库被软删除那一次，事后查不出是谁调的 —— 因为这三条路径只有业务日志。
//   现在每条都写一行 JSON 到 <LOG_PATH>/audit.log：时间、操作者、来源 IP、UA、
//   影响条数、具体曲目 id / 回收站相对路径、失败原因。
//
//   本脚本在真实数据的副本上跑（重写绝对路径 + 隔离硬校验），覆盖：
//     1. tracks.delete  → 删 1 首，审计行里有该曲目 id、来源 IP、剩余曲目数
//     2. trash.restore  → 恢复回来，审计行里有回收站相对路径
//     3. tracks.delete + trash.purge → 彻底删除，审计行里 ok=1
//     4. 审计行必须是合法 JSON、含全部必需字段、且不含会话 token
//     5. 真实曲库零改动（文件数 + 字节数指纹前后一致）
//   用法：node tools/e2e-trash-audit.mjs      （保留现场：KEEP=1）
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP = process.env.KEEP == '1'
const ROOT = process.cwd()
const REAL_DATA = path.join(ROOT, 'server', 'data')
const REAL_LIB = path.join(REAL_DATA, 'libraries', 'Slceleto')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e-audit-'))
const DATA = path.join(TMP, 'data')
const LOGS = path.join(TMP, 'logs')
const LIB = path.join(DATA, 'libraries', 'Slceleto')
const ADMIN_PW = 'e2e-admin'
const WEB_USER = 'Slceleto'
const WEB_PASS = 'REDACTED'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 曲库指纹：文件数 + 总字节（用来证明真实曲库一个字节都没动） */
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
console.log('真实曲库指纹(前): ' + REAL_BEFORE.n + ' 文件 / ' + REAL_BEFORE.bytes + ' 字节')

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

  const LEGACY_DIRS = ['/tmp/gusi-test-music', '/tmp/gusi-dl']
  const sanitizeJson = (p) => {
    let txt = fs.readFileSync(p, 'utf8')
    const orig = txt
    if (txt.includes(REAL_DATA)) txt = txt.split(REAL_DATA).join(DATA)
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
  console.log('数据副本: ' + DATA + '\n隔离校验通过（dirs=' + st.dirs[0] + '，全副本无真实路径泄漏）')
}

// ------------------------------ 启动隔离实例 ------------------------------
const freePort = async () => new Promise((resolve, reject) => {
  const srv = net.createServer()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
})
const PORT = await freePort()
const BASE = 'http://127.0.0.1:' + PORT
fs.mkdirSync(LOGS, { recursive: true })

const child = spawn(process.execPath, [path.resolve('server/server/index.js')], {
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
const stop = () => { try { child.kill('SIGKILL') } catch {} }
process.on('exit', () => { stop(); if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} } })
process.on('uncaughtException', (e) => { console.error(e); process.exit(1) })

const waitUp = async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch {}
    await sleep(400)
  }
  return false
}
if (!await waitUp()) { console.error('服务未起来'); stop(); process.exit(2) }
console.log('隔离实例就绪: ' + BASE + '  (pid ' + child.pid + ')\n')

// ------------------------------ 登录 ------------------------------
const lg = await (await fetch(BASE + '/web/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: WEB_USER, password: WEB_PASS }),
})).json()
const TOKEN = lg?.data?.token || ''
check('web 登录拿到 token', !!TOKEN)
const UA = 'gusi-e2e-audit/1.0'
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + '/web/api' + p, {
    method: opt.method || 'GET',
    headers: { 'X-Web-Token': TOKEN, 'User-Agent': UA, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const readAudit = () => {
  const p = path.join(LOGS, 'audit.log')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l) } catch { return { __bad: l } }
  })
}

// ------------------------------ 1. 软删除 ------------------------------
console.log('一、tracks.delete 审计')
const listed = await api('/tracks?page=1&size=3')
const tracks = listed?.data?.tracks || []
check('拿到曲库曲目', tracks.length > 0, 'total=' + (listed?.data?.total ?? '?'))
const victim = tracks[0]
const del = await api('/tracks/delete', { method: 'POST', body: { ids: [victim.id] } })
check('删除接口返回成功', del.status === 200 && del?.data?.removed === 1,
  'removed=' + del?.data?.removed + ' remaining=' + del?.data?.total)

const trash = await api('/trash')
const trashed = (trash?.data?.list || []).find((x) => x.name === victim.name) || (trash?.data?.list || [])[0]
check('文件进了回收站', (trash?.data?.count || 0) > 0, 'count=' + trash?.data?.count + ' relPath=' + (trashed?.relPath || '?'))

let lines = readAudit()
check('audit.log 已生成且是合法 JSON 行', lines.length === 1 && !lines[0].__bad, JSON.stringify(lines[0] || {}).slice(0, 120))
const d0 = lines[0] || {}
check('删除行字段齐全（t/action/user/ip/ua/count）',
  !!d0.t && d0.action === 'tracks.delete' && d0.user === WEB_USER && !!d0.ip && d0.ua === UA && d0.requested === 1,
  't=' + d0.t + ' ip=' + d0.ip + ' ua=' + d0.ua)
check('删除行记录了具体曲目 id', Array.isArray(d0.ids) && d0.ids.includes(victim.id), 'ids=' + JSON.stringify(d0.ids))
check('删除行记录了剩余曲目数', d0.remaining === del?.data?.total, 'remaining=' + d0.remaining)
check('审计行不含会话 token', !JSON.stringify(d0).includes(TOKEN))

// ------------------------------ 2. 恢复 ------------------------------
console.log('\n二、trash.restore 审计')
const rs = await api('/trash/restore', { method: 'POST', body: { paths: [trashed.relPath] } })
check('恢复接口返回成功', rs.status === 200 && rs?.data?.ok === 1, JSON.stringify(rs?.data))
lines = readAudit()
check('恢复行追加且动作正确', lines.length === 2 && lines[1].action === 'trash.restore', 'lines=' + lines.length)
check('恢复行记录了回收站相对路径与来源 IP',
  Array.isArray(lines[1]?.paths) && lines[1].paths[0] === trashed.relPath && !!lines[1].ip && lines[1].ok === 1,
  'path=' + lines[1]?.paths?.[0] + ' ip=' + lines[1]?.ip)

// ------------------------------ 3. 彻底删除 ------------------------------
console.log('\n三、trash.purge 审计')
// 恢复会触发一次异步全量扫描；索引没重建完就删会得到「曲目不存在」，
// 所以这里必须等它回到索引，否则测的是「曲目不存在」而不是 purge。
const waitBack = async (id) => {
  for (let i = 0; i < 90; i++) {
    const r = await api('/tracks?page=1&size=500')
    if ((r?.data?.tracks || []).some((t) => t.id === id)) return true
    await sleep(1000)
  }
  return false
}
check('恢复后重扫把曲目带回索引（等异步扫描）', await waitBack(victim.id), 'id=' + victim.id)
const del2 = await api('/tracks/delete', { method: 'POST', body: { ids: [victim.id] } })
check('再次删除成功', del2.status === 200 && del2?.data?.removed === 1, JSON.stringify(del2?.data || {}).slice(0, 90))
const trash2 = await api('/trash')
const target = (trash2?.data?.list || []).find((x) => x.relPath === trashed.relPath) || (trash2?.data?.list || [])[0]
const pg = await api('/trash/purge', { method: 'POST', body: { paths: [target?.relPath || trashed.relPath] } })
check('彻底删除接口返回成功', pg.status === 200 && pg?.data?.ok === 1, JSON.stringify(pg?.data))
lines = readAudit()
const last = lines[lines.length - 1] || {}
check('彻底删除行追加且动作正确', last.action === 'trash.purge' && last.ok === 1,
  'action=' + last.action + ' ok=' + last.ok + ' clearAll=' + last.clearAll)
check('彻底删除行记录了路径', Array.isArray(last.paths) && last.paths.length === 1, JSON.stringify(last.paths))
check('审计日志行序 = 删除/恢复/删除/彻底删除',
  lines.map((l) => l.action).join(',') === 'tracks.delete,trash.restore,tracks.delete,trash.purge',
  lines.map((l) => l.action).join(' | '))
check('回收站里已无该文件', !(await api('/trash'))?.data?.list?.some((x) => x.relPath === (target?.relPath || trashed.relPath)))

// ------------------------------ 4. 真实曲库零改动 ------------------------------
console.log('\n四、隔离校验')
const REAL_AFTER = fingerprint(REAL_LIB)
check('真实曲库指纹未变',
  REAL_AFTER.n === REAL_BEFORE.n && REAL_AFTER.bytes === REAL_BEFORE.bytes,
  REAL_BEFORE.n + '/' + REAL_BEFORE.bytes + ' → ' + REAL_AFTER.n + '/' + REAL_AFTER.bytes)
const realLogs = path.join(REAL_DATA, '..', 'logs', 'audit.log')
check('线上日志目录没被测试写入（LOG_PATH 已隔离）',
  !fs.existsSync(realLogs) || fs.statSync(realLogs).mtimeMs < Date.now() - 60_000,
  realLogs)
const idxAfter = JSON.parse(fs.readFileSync(path.join(LIB, 'library.json'), 'utf8'))
check('副本索引里该曲目已移除（确认删的是副本）', !(idxAfter.tracks || []).some((t) => t.id === victim.id))

console.log('\n审计日志样本（删除 / 恢复 / 彻底删除）：')
for (const l of lines) console.log('  ' + JSON.stringify(l).slice(0, 240))

stop()
await sleep(300)
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
console.log('工作目录: ' + TMP + (KEEP ? '（保留）' : '（已清理）'))
process.exit(fail ? 1 : 0)
