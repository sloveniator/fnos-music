// UPGRADE_0020 E2E：每用户独立物理曲库（方案 C）
// 用法：node tools/e2e-0020.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e20-'))
const PORT = 19994
const ADMIN_PW = 'e2e-admin'
const BASE = 'http://127.0.0.1:' + PORT
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 造两份互不重叠的曲库目录：A 有 3 首（Song_A1/A2/A3），B 有 2 首（Song_B1/B2）
const mkRiff = (seed = 0, bytes = 2048) => {
  const b = new Uint8Array(bytes)
  for (let i = 0; i < b.length; i++) b[i] = ((i * 7 + seed * 131) & 0xff)
  return b
}
const A_DIR = path.join(tmp, 'musicA')
fs.mkdirSync(path.join(A_DIR, 'Artist_A', 'Album_A'), { recursive: true })
fs.writeFileSync(path.join(A_DIR, 'Artist_A', 'Album_A', '01 - Song_A1.mp3'), mkRiff(1))
fs.writeFileSync(path.join(A_DIR, 'Artist_A', 'Album_A', '02 - Song_A2.mp3'), mkRiff(2))
fs.writeFileSync(path.join(A_DIR, 'Artist_A', '03 - Song_A3.mp3'), mkRiff(3))

const B_DIR = path.join(tmp, 'musicB')
fs.mkdirSync(path.join(B_DIR, 'Artist_B', 'Album_B'), { recursive: true })
fs.writeFileSync(path.join(B_DIR, 'Artist_B', 'Album_B', '01 - Song_B1.mp3'), mkRiff(4))
fs.writeFileSync(path.join(B_DIR, 'Artist_B', 'Album_B', '02 - Song_B2.mp3'), mkRiff(5))

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

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('[PASS] ' + name + (detail ? '  -- ' + detail : '')) }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -- ' + detail : '')) }
}

const J = async (r) => r.json().catch(() => ({}))
async function adminCall(method, p, body, hdr) {
  const r = await fetch(BASE + p, { method, headers: { ...hdr, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return r
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/admin/api/status'); if (r.status === 401) return true } catch {}
    await sleep(400)
  }
  return false
}

try {
  check('server 启动可达', await waitUp())

  // ---- 1) 管理登录 ----
  const al = await adminCall('POST', '/admin/login', { password: ADMIN_PW })
  const at = (await J(al)).token
  const hdr = { 'X-Admin-Token': at }

  // ---- 2) 建两个用户 ----
  for (const [name, pw] of [['userA', 'pwA'], ['userB', 'pwB']]) {
    const r = await adminCall('POST', '/admin/api/users', { name, password: pw }, hdr)
    const j = await J(r)
    check(`创建用户 ${name}`, r.status === 200, JSON.stringify(j).slice(0, 120))
  }

  // ---- 3) 租户曲库：列出用户 ----
  const usersR = await adminCall('GET', '/admin/api/library/users', null, hdr)
  const usersJ = await J(usersR)
  const users = (usersJ.data?.users || usersJ.users || [])
  check('列出租户列表含 userA/userB', users.some(u => u.name === 'userA') && users.some(u => u.name === 'userB'),
    'count=' + users.length + ' names=' + users.map(u => u.name).join(','))

  // ---- 4) 分别配置扫描目录 ----
  const setA = await adminCall('POST', '/admin/api/library/user-settings/userA', { dirs: [A_DIR] }, hdr)
  check('userA 设置扫描目录', setA.status === 200, JSON.stringify(await J(setA)).slice(0, 120))
  const setB = await adminCall('POST', '/admin/api/library/user-settings/userB', { dirs: [B_DIR] }, hdr)
  check('userB 设置扫描目录', setB.status === 200)

  // 未配置用户应拒绝扫描（不存在的用户返回 404）
  const scanNone = await adminCall('POST', '/admin/api/library/user-scan/nobody', null, hdr)
  check('未配置/不存在用户的扫描被拒', [400, 404, 409].includes(scanNone.status), 'status=' + scanNone.status)

  // ---- 5) 分别触发扫描并轮询直到完成 ----
  const waitScanDone = async (name) => {
    for (let i = 0; i < 40; i++) {
      const r = await adminCall('GET', `/admin/api/library/user-scan/${name}`, null, hdr)
      const j = await J(r)
      const s = j.data?.scan || j.scan
      if (s && !s.scanning && s.trackCount > 0) return s
      await sleep(400)
    }
    return null
  }
  await adminCall('POST', '/admin/api/library/user-scan/userA', null, hdr)
  await adminCall('POST', '/admin/api/library/user-scan/userB', null, hdr)
  const scanA = await waitScanDone('userA')
  const scanB = await waitScanDone('userB')
  check('userA 扫描完成', !!scanA, scanA ? `tracks=${scanA.trackCount}` : 'timeout')
  check('userB 扫描完成', !!scanB, scanB ? `tracks=${scanB.trackCount}` : 'timeout')
  check('userA 扫描到 3 首', scanA?.trackCount === 3, 'trackCount=' + (scanA?.trackCount ?? 'n/a'))
  check('userB 扫描到 2 首', scanB?.trackCount === 2, 'trackCount=' + (scanB?.trackCount ?? 'n/a'))

  // ---- 6) 租户统计独立 ----
  const statA = (await J(await adminCall('GET', '/admin/api/library/user-stats/userA', null, hdr)))
  const statB = (await J(await adminCall('GET', '/admin/api/library/user-stats/userB', null, hdr)))
  check('userA 统计 tracks=3', (statA.data?.stats?.tracks ?? statA.stats?.tracks) === 3, JSON.stringify(statA).slice(0, 160))
  check('userB 统计 tracks=2', (statB.data?.stats?.tracks ?? statB.stats?.tracks) === 2, JSON.stringify(statB).slice(0, 160))

  // ---- 7) 全局曲库未被租户污染 ----
  const gStats = await adminCall('GET', '/admin/api/library/stats', null, hdr)
  check('全局曲库 stats 端点仍可达', gStats.status === 200, 'status=' + gStats.status)

  // ---- 8) Web 端登录两个用户，各自只见自己的曲目 ----
  const webLogin = async (name, pw) => {
    const r = await fetch(BASE + '/web/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password: pw }) })
    const j = await J(r)
    return { token: j.data?.token || j.token, status: r.status }
  }
  const tA = await webLogin('userA', 'pwA')
  const tB = await webLogin('userB', 'pwB')
  check('userA web 登录成功', !!tA.token, 'status=' + tA.status)
  check('userB web 登录成功', !!tB.token, 'status=' + tB.status)

  const webGet = async (token, p) => {
    const r = await fetch(BASE + p, { headers: { 'X-Web-Token': token } })
    return { status: r.status, data: await J(r) }
  }

  // 8a) stats 反映各自租户
  const webAStats = (await webGet(tA.token, '/web/api/stats')).data?.data ?? {}
  const webBStats = (await webGet(tB.token, '/web/api/stats')).data?.data ?? {}
  check('userA /web/api/stats tracks=3', webAStats.tracks === 3, JSON.stringify(webAStats).slice(0, 160))
  check('userB /web/api/stats tracks=2', webBStats.tracks === 2, JSON.stringify(webBStats).slice(0, 160))

  // 8b) 曲目列表：userA 只见 A 曲目，userB 只见 B 曲目
  const webATracks = (await webGet(tA.token, '/web/api/tracks?size=50')).data?.data ?? {}
  const webBTracks = (await webGet(tB.token, '/web/api/tracks?size=50')).data?.data ?? {}
  const aNames = (webATracks.tracks || []).map(t => t.name)
  const bNames = (webBTracks.tracks || []).map(t => t.name)
  check('userA 曲目数=3', (webATracks.tracks || []).length === 3, aNames.join(','))
  check('userB 曲目数=2', (webBTracks.tracks || []).length === 2, bNames.join(','))
  check('userA 曲目均含 A', aNames.every(n => n.includes('A')), aNames.join(','))
  check('userB 曲目均含 B', bNames.every(n => n.includes('B')), bNames.join(','))
  check('userA 不见 userB 曲目', aNames.every(n => !n.includes('B')), aNames.join(','))
  check('userB 不见 userA 曲目', bNames.every(n => !n.includes('A')), bNames.join(','))

  // 8c) 专辑/歌手视图隔离
  const webAAlbums = (await webGet(tA.token, '/web/api/albums')).data?.data ?? {}
  const webBAlbums = (await webGet(tB.token, '/web/api/albums')).data?.data ?? {}
  const aAlbumNames = (webAAlbums.albums || []).map(a => a.name)
  const bAlbumNames = (webBAlbums.albums || []).map(a => a.name)
  check('userA 专辑名均为 A 系列', aAlbumNames.every(n => /_A|A/.test(n)), aAlbumNames.join(','))
  check('userB 专辑名均为 B 系列', bAlbumNames.every(n => /_B|B/.test(n)), bAlbumNames.join(','))

  const webAArtists = (await webGet(tA.token, '/web/api/artists')).data?.data ?? {}
  const webBArtists = (await webGet(tB.token, '/web/api/artists')).data?.data ?? {}
  const aArtists = (webAArtists.artists || []).map(a => a.name)
  const bArtists = (webBArtists.artists || []).map(a => a.name)
  check('userA 歌手名为 Artist_A', aArtists.includes('Artist A'), aArtists.join(','))
  check('userB 歌手名为 Artist_B', bArtists.includes('Artist B'), bArtists.join(','))

  // 8d) 跨租户 id 访问被拒：userB 用 userA 的曲目 id 拿流/封面/歌词/下载 → 404
  const aTrack = webATracks.tracks?.[0]
  const crossStream = await webGet(tB.token, '/web/media/stream/' + aTrack.id)
  const crossCover = await webGet(tB.token, '/web/media/cover/' + aTrack.id)
  const crossLyric = await webGet(tB.token, '/web/media/lyric/' + aTrack.id)
  check('跨租户取流 404', crossStream.status === 404, 'status=' + crossStream.status)
  check('跨租户取封面 404', crossCover.status === 404, 'status=' + crossCover.status)
  check('跨租户取歌词 404', crossLyric.status === 404, 'status=' + crossLyric.status)

  // 8e) 同租户内可访问
  const ownStream = await fetch(BASE + '/web/media/stream/' + aTrack.id + '?k=' + encodeURIComponent(tA.token))
  check('同租户取流可达', ownStream.status === 200, 'status=' + ownStream.status)

  // 8f) 歌曲加入歌单：userB 尝试添加 userA 的曲目 → 无有效曲目
  const addR = await fetch(BASE + '/web/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Web-Token': tB.token }, body: JSON.stringify({ name: 'test' }) })
  const addJ = await J(addR)
  const listId = addJ.data?.id
  if (listId) {
    const addCross = await fetch(BASE + '/web/api/playlists/' + listId + '/add', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Web-Token': tB.token },
      body: JSON.stringify({ trackIds: [aTrack.id] })
    })
    check('跨租户加入歌单被拒（无有效曲目）', addCross.status === 400, 'status=' + addCross.status)
  }

  // ---- 9) 未登录时不返回曲库 ----
  const anon = await fetch(BASE + '/web/api/stats')
  check('未登录 /web/api/stats → 401', anon.status === 401, 'status=' + anon.status)

} catch (e) {
  console.log('[EXC] ' + (e && e.stack || e))
  fail++
} finally {
  child.kill('SIGKILL')
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
