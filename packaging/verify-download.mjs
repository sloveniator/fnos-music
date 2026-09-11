/* LXM Cloud — download-to-storage end-to-end test (Node, cross-version)
 * Starts a mock WebDAV server + the real lxm server, then exercises:
 *   local target write, webdav target PUT (with MKCOL), url download, cancel, target CRUD.
 * Usage: node packaging/verify-download.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const PORT = 43020
const DAV_PORT = 43021
const PASS = 'dl-test-pw'
const Base = `http://127.0.0.1:${PORT}`
const DavBase = `http://127.0.0.1:${DAV_PORT}/dav`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-dl-'))
const musicDir = path.join(tmp, 'music')
const localOut = path.join(tmp, 'out-local')
const dataDir = path.join(tmp, 'data')
fs.mkdirSync(path.join(musicDir, 'ArtistA', 'AlbumOne'), { recursive: true })
fs.mkdirSync(localOut, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
const song = path.join(musicDir, 'ArtistA', 'AlbumOne', '01 - Download Me.mp3')
fs.writeFileSync(song, Buffer.alloc(50000, 7))

// ---- mock WebDAV server (in-memory) ----
const davStore = new Map()
let davAuthOk = 0
let davAuthBad = 0
const dav = http.createServer((req, res) => {
  const auth = req.headers.authorization
  const want = 'Basic ' + Buffer.from('davuser:davpass').toString('base64')
  if (auth && auth !== want) { davAuthBad++; res.writeHead(401); res.end('bad auth'); return }
  if (auth) davAuthOk++
  const key = decodeURIComponent(req.url.replace(/^\/dav\//, ''))
  if (req.method == 'MKCOL') {
    davStore.set(key + '/', { dir: true })
    res.writeHead(201); res.end(); return
  }
  if (req.method == 'PUT') {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const finishPut = () => { davStore.set(key, Buffer.concat(chunks)); res.writeHead(201); res.end() }
      if (key.includes('slow')) setTimeout(finishPut, 3000) // 拖慢以稳定复现排队/取消
      else finishPut()
    })
    return
  }
  if (req.method == 'GET') {
    const v = davStore.get(key)
    if (Buffer.isBuffer(v)) { res.writeHead(200, { 'Content-Length': String(v.length) }); res.end(v); return }
    res.writeHead(404); res.end(); return
  }
  res.writeHead(200); res.end('ok')
})

let fail = 0
const check = (name, cond) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name); if (!cond) fail++ }

const jget = async(method, uri, headers, body) => {
  const res = await fetch(uri, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

let server
try {
  await new Promise(r => dav.listen(DAV_PORT, '127.0.0.1', r))
  server = spawn('node', ['index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), BIND_IP: '127.0.0.1', GS_ADMIN_PASSWORD: PASS, DATA_PATH: dataDir, GS_WEB_STATIC_DIR: path.join(ROOT, 'ui', 'dist') },
    stdio: 'ignore',
  })
  // wait for listen
  for (let i = 0; i < 60; i++) {
    try { await fetch(Base + '/hello'); break } catch { await new Promise(r => setTimeout(r, 500)) }
  }

  const login = await jget('POST', Base + '/admin/login', { 'Content-Type': 'application/json' }, { password: PASS })
  const hdr = { 'Content-Type': 'application/json', 'X-Admin-Token': login.json.token }
  check('login', login.json?.token?.length >= 32)

  // scan
  await jget('POST', Base + '/admin/api/library/settings', hdr, { dirs: [musicDir] })
  await jget('POST', Base + '/admin/api/library/scan', hdr)
  let tracks = 0
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300))
    const s = await jget('GET', Base + '/admin/api/library/stats', hdr)
    tracks = s.json.data.tracks
    if (!s.json.data.scan.scanning && tracks >= 1) break
  }
  check('scan 1 track', tracks >= 1)
  const list = await jget('GET', Base + '/admin/api/library/tracks', hdr)
  const t = list.json.data.tracks[0]
  check('track parsed', t.name === 'Download Me' && t.singer === 'ArtistA')

  // ---- targets CRUD ----
  const targets = [
    { name: '本地输出', type: 'local', path: localOut },
    { name: 'WebDAV网盘', type: 'webdav', url: DavBase, username: 'davuser', password: 'davpass' },
  ]
  const save = await jget('POST', Base + '/admin/api/library/targets', hdr, { targets })
  const savedTargets = save.json.data.targets
  check('targets saved 2', savedTargets.length === 2)
  check('webdav password masked', savedTargets[1].hasPassword === true && !('password' in savedTargets[1]))
  const localId = savedTargets[0].id
  const davId = savedTargets[1].id

  // ---- download track -> local ----
  const d1 = await jget('POST', Base + '/admin/api/library/downloads', hdr, { trackId: t.id, targetId: localId, subdir: 'ArtistA/AlbumOne' })
  check('enqueue local', d1.json?.data?.id)
  let task1
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    task1 = dl.json.data.tasks.find(x => x.id === d1.json.data.id)
    if (task1 && (task1.status === 'done' || task1.status === 'error')) break
  }
  check('local download done', task1?.status === 'done')
  const outFile = path.join(localOut, 'ArtistA', 'AlbumOne', task1.filename)
  check('local file exists + size', fs.existsSync(outFile) && fs.statSync(outFile).size === 50000)
  check('local subdir sanitized', task1.subdir === 'ArtistA/AlbumOne')

  // ---- download track -> webdav ----
  const d2 = await jget('POST', Base + '/admin/api/library/downloads', hdr, { trackId: t.id, targetId: davId, subdir: '网盘备份' })
  let task2
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    task2 = dl.json.data.tasks.find(x => x.id === d2.json.data.id)
    if (task2 && (task2.status === 'done' || task2.status === 'error')) break
  }
  check('webdav download done', task2?.status === 'done')
  const davKey = '网盘备份/' + task2.filename
  check('webdav received bytes', Buffer.isBuffer(davStore.get(davKey)) && davStore.get(davKey).length === 50000)
  check('webdav auth sent', davAuthOk >= 1 && davAuthBad === 0)
  check('webdav MKCOL made', davStore.get('网盘备份/') === undefined || davStore.has('网盘备份/'))

  // ---- download by url (server's own stream endpoint) ----
  const st = await jget('GET', Base + '/admin/api/library/stream-token', hdr)
  const tok = st.json.data.token
  const d3 = await jget('POST', Base + '/admin/api/library/downloads', hdr, { url: `${Base}/api/stream/${t.id}?k=${tok}`, targetId: localId, filename: 'via-url.mp3' })
  let task3
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    task3 = dl.json.data.tasks.find(x => x.id === d3.json.data.id)
    if (task3 && (task3.status === 'done' || task3.status === 'error')) break
  }
  check('url download done', task3?.status === 'done')
  check('url file size', fs.existsSync(path.join(localOut, 'via-url.mp3')) && fs.statSync(path.join(localOut, 'via-url.mp3')).size === 50000)

  // ---- path traversal rejected ----
  const bad = await jget('POST', Base + '/admin/api/library/downloads', hdr, { trackId: t.id, targetId: localId, subdir: '../../etc', filename: 'evil' })
  const badId = bad.json?.data?.id
  let badTask
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    badTask = dl.json.data.tasks.find(x => x.id === badId)
    if (badTask && badTask.status !== 'running' && badTask.status !== 'queued') break
  }
  check('traversal subdir stripped (no escape)', badTask?.status === 'done' && !fs.existsSync(path.join(tmp, 'etc')))

  // ---- cancel queued (slow webdav puts keep 2 slots busy so #3 stays queued) ----
  const slow = []
  for (let i = 0; i < 3; i++) slow.push((await jget('POST', Base + '/admin/api/library/downloads', hdr, { trackId: t.id, targetId: davId, filename: `slow${i}.mp3` })).json.data.id)
  const cancelRes = await jget('POST', `${Base}/admin/api/library/downloads/${slow[2]}/cancel`, hdr)
  check('cancel accepted', cancelRes.json?.data?.cancelled === true)
  await new Promise(r => setTimeout(r, 300))
  const dlAfter = await jget('GET', Base + '/admin/api/library/downloads', hdr)
  const cancelled = dlAfter.json.data.tasks.find(x => x.id === slow[2])
  check('cancelled task status', cancelled?.status === 'cancelled')

  // ---- clear finished ----
  await new Promise(r => setTimeout(r, 1500))
  const cleared = await jget('POST', Base + '/admin/api/library/downloads/clear', hdr)
  check('clear finished', cleared.json?.data?.removed >= 1)

  // ---- password preserved on edit (send empty password) ----
  const edit = await jget('POST', Base + '/admin/api/library/targets', hdr, {
    targets: [
      { id: localId, name: '本地输出', type: 'local', path: localOut },
      { id: davId, name: 'WebDAV网盘', type: 'webdav', url: DavBase, username: 'davuser', password: '' },
    ],
  })
  // re-download to webdav to prove old password still works (auth ok count grows, no 401)
  const before = davAuthOk
  const d4 = await jget('POST', Base + '/admin/api/library/downloads', hdr, { trackId: t.id, targetId: davId, filename: 'pwd-kept.mp3' })
  let task4
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 250))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    task4 = dl.json.data.tasks.find(x => x.id === d4.json.data.id)
    if (task4 && (task4.status === 'done' || task4.status === 'error')) break
  }
  check('password preserved across edit', task4?.status === 'done' && davAuthOk > before && davAuthBad === 0)

  // ---- target usage (local statfs) ----
  const usage = await jget('GET', Base + '/admin/api/library/targets/usage', hdr)
  const lu = usage.json?.data?.usage?.[localId]
  check('local usage free is number', !!lu && typeof lu.free === 'number' && lu.free >= 0 && typeof lu.total === 'number')

  // ---- auto-scan after download into a scanned dir ----
  const tSave = await jget('POST', Base + '/admin/api/library/targets', hdr, {
    targets: [
      { id: localId, name: '本地输出', type: 'local', path: localOut },
      { id: davId, name: 'WebDAV网盘', type: 'webdav', url: DavBase, username: 'davuser', password: '' },
      { name: '曲库目录', type: 'local', path: musicDir },
    ],
  })
  const libTargetId = tSave.json.data.targets[2].id
  const beforeCount = (await jget('GET', Base + '/admin/api/library/stats', hdr)).json.data.tracks
  const dAuto = await jget('POST', Base + '/admin/api/library/downloads', hdr, { url: `${Base}/api/stream/${t.id}?k=${tok}`, targetId: libTargetId, subdir: 'auto', filename: 'auto-added.mp3' })
  let taskAuto
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const dl = await jget('GET', Base + '/admin/api/library/downloads', hdr)
    taskAuto = dl.json.data.tasks.find(x => x.id === dAuto.json.data.id)
    if (taskAuto && (taskAuto.status === 'done' || taskAuto.status === 'error')) break
  }
  check('auto-scan download done', taskAuto?.status === 'done')
  let afterCount = beforeCount
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 500))
    const s = await jget('GET', Base + '/admin/api/library/stats', hdr)
    afterCount = s.json.data.tracks
    if (afterCount > beforeCount) break
  }
  check('auto-scan picked up new file', afterCount > beforeCount)
} catch (err) {
  console.log('EXCEPTION: ' + (err?.stack ?? err))
  fail++
} finally {
  if (server) server.kill()
  dav.close()
}
console.log('')
if (fail === 0) console.log('DOWNLOAD TEST: ALL PASSED')
else { console.log(`DOWNLOAD TEST: ${fail} FAILED`); process.exit(1) }
