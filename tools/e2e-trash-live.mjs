// 回收站全链路线上验证（localhost:20059，真实曲库）
//
// 用法：
//   node tools/e2e-trash-live.mjs                      # 默认夹具 gusi-final2.mp3 / new2.mp3（一次性）
//   node tools/e2e-trash-live.mjs a.mp3 b.mp3          # 指定夹具（会被永久删除！只放测试文件）
//   node tools/e2e-trash-live.mjs --guard-only         # 只跑安全阀检查（不需要夹具，可随时重跑）
//
// 夹具必须已存在于曲库并被索引：脚本会删→列→恢复（含重扫）→再删→彻底删除，最后不留痕。
// 注意：脚本结束后夹具被彻底删除，想重跑得重新放文件 + 扫描。
import fs from 'node:fs'
import path from 'node:path'
// 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
const _APP_PASS = process.env.GS_APP_PASS || ''
if (!_APP_PASS) throw new Error('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

const BASE = 'http://localhost:20059'
const LIB = '/app/working/workspaces/fnos-music/project/fnos-music/server/data/libraries/Slceleto'
const USER = 'Slceleto', PASS = _APP_PASS

const argv = process.argv.slice(2)
const guardOnly = argv.includes('--guard-only')
const positionals = argv.filter(a => !a.startsWith('--'))
const FIXTURES = positionals.length ? positionals : ['gusi-final2.mp3', 'new2.mp3']

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')) }
}

const lg = await (await fetch(BASE + '/web/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: USER, password: PASS }),
})).json()
const TOKEN = lg?.data?.token || ''
check('web 登录拿到 token', !!TOKEN)
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + '/web/api' + p, {
    method: opt.method || 'GET',
    headers: { 'X-Web-Token': TOKEN, ...(opt.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  })
  return r.json().catch(() => ({}))
}
const tracks = async () => ((await api('/tracks?page=1&size=500'))?.data?.tracks || [])
const trash = async () => (await api('/trash'))?.data || { list: [], count: 0, bytes: 0 }

if (guardOnly) {
  console.log('\n— 安全阀（不需要夹具）—')
  const t0 = await trash()
  check('GET /trash 可用', Array.isArray(t0.list), 'count=' + t0.count)
  const b1 = await api('/trash/purge', { method: 'POST', body: { paths: ['../../../../etc/passwd'] } })
  check('purge 越界路径 → 非法路径', b1?.data?.ok === 0 && /非法路径/.test(JSON.stringify(b1?.data?.failed || [])), JSON.stringify(b1?.data?.failed))
  const b2 = await api('/trash/restore', { method: 'POST', body: { paths: ['../x.mp3'] } })
  check('restore 越界路径 → 非法路径', b2?.data?.ok === 0 && /非法路径/.test(JSON.stringify(b2?.data?.failed || [])), JSON.stringify(b2?.data?.failed))
  const b3 = await api('/trash/purge', { method: 'POST', body: { paths: ['/etc/passwd'] } })
  check('purge 绝对路径被拒', b3?.data?.ok === 0, JSON.stringify(b3?.data?.failed))
  const b4 = await api('/trash/purge', { method: 'POST', body: { paths: ['nope-not-here.mp3'] } })
  check('purge 不存在的条目 → 回收站里没有这个文件', b4?.data?.ok === 0 && /没有这个文件/.test(JSON.stringify(b4?.data?.failed || [])), JSON.stringify(b4?.data?.failed))
  const b5 = await api('/trash/purge', { method: 'POST', body: { paths: [] } })
  check('空列表被拒 400', b5?.code === -1, String(b5?.msg))
  const b6 = await api('/trash/restore', { method: 'POST', body: { paths: [] } })
  check('恢复空列表被拒 400', b6?.code === -1, String(b6?.msg))
  check('/etc/passwd 仍健在', fs.existsSync('/etc/passwd'))
  check('回收站状态未被改变', (await trash()).count === t0.count)
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}

console.log('\n— 前置状态 —')
const sizes = {}
for (const f of FIXTURES) {
  const p = path.join(LIB, f)
  const ok = fs.existsSync(p)
  sizes[f] = ok ? fs.statSync(p).size : 0
  check('夹具在曲库内: ' + f, ok, ok ? sizes[f] + ' B' : '不存在')
}
let list = await tracks()
const baseCount = list.length
console.log('  初始曲目数: ' + baseCount)
const ids = {}
for (const f of FIXTURES) {
  const name = f.replace(/\.[^.]+$/, '')
  const hit = list.find(t => t.name === name || (t.relPath || '').endsWith('/' + f) || t.relPath === f)
  check('索引命中: ' + f, !!hit, hit ? 'id=' + String(hit.id).slice(0, 40) : '未找到')
  if (hit) ids[f] = hit.id
}
check('回收站初始为空', (await trash()).count === 0)

console.log('\n— 1) 删除 → 进回收站 —')
const del1 = await api('/tracks/delete', { method: 'POST', body: { ids: [ids[FIXTURES[0]]] } })
check('删除 ' + FIXTURES[0] + ' 成功', del1?.data?.removed === 1, JSON.stringify(del1?.data?.failed || []))
check('磁盘上已移走', !fs.existsSync(path.join(LIB, FIXTURES[0])))
let t = await trash()
check('回收站列出 1 个', t.count === 1, t.list.map(x => x.relPath).join(','))
const e0 = t.list[0] || {}
check('relPath = 原相对路径', e0.relPath === FIXTURES[0], String(e0.relPath))
check('大小与源文件一致', e0.size === sizes[FIXTURES[0]], String(e0.size))
check('mtime 有值', !!e0.mtime)
check('bytes 汇总正确', t.bytes === sizes[FIXTURES[0]], String(t.bytes))

console.log('\n— 2) 恢复 → 回原路径并重扫 —')
const re = await api('/trash/restore', { method: 'POST', body: { paths: [FIXTURES[0]] } })
check('恢复返回 ok=1', re?.data?.ok === 1, JSON.stringify(re?.data?.failed || []))
check('文件回到原位置', fs.existsSync(path.join(LIB, FIXTURES[0])))
check('恢复后大小不变', fs.existsSync(path.join(LIB, FIXTURES[0])) && fs.statSync(path.join(LIB, FIXTURES[0])).size === sizes[FIXTURES[0]])
check('回收站已空', (await trash()).count === 0)
let back = 0
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000))
  back = (await tracks()).length
  if (back >= baseCount) break
}
check('重扫后曲目数回到 ' + baseCount, back === baseCount, '实测 ' + back)

console.log('\n— 3) 全部删除 + 彻底删除 —')
const del2 = await api('/tracks/delete', { method: 'POST', body: { ids: FIXTURES.map(f => ids[f]) } })
check('夹具全部删除成功', del2?.data?.removed === FIXTURES.length, JSON.stringify(del2?.data?.failed || []))
t = await trash()
check('回收站列出 ' + FIXTURES.length + ' 个', t.count === FIXTURES.length, t.list.map(x => x.relPath).join(','))
const single = await api('/trash/purge', { method: 'POST', body: { paths: [FIXTURES[FIXTURES.length - 1]] } })
check('单文件 purge ok=1', single?.data?.ok === 1, JSON.stringify(single?.data?.failed || []))
check(FIXTURES[FIXTURES.length - 1] + ' 已从磁盘消失', !fs.existsSync(path.join(LIB, FIXTURES[FIXTURES.length - 1])) && !fs.existsSync(path.join(LIB, '.gusi-trash', FIXTURES[FIXTURES.length - 1])))
check('回收站剩 ' + (FIXTURES.length - 1) + ' 个', (await trash()).count === FIXTURES.length - 1)
const wipe = await api('/trash/purge', { method: 'POST', body: { paths: ['*'] } })
check('清空回收站', wipe?.data?.ok === FIXTURES.length - 1, JSON.stringify(wipe?.data?.failed || []))
check('回收站彻底为空', (await trash()).count === 0)
check('夹具都不在磁盘上', FIXTURES.every(f => !fs.existsSync(path.join(LIB, f))))
check('.gusi-trash 空壳目录已清理', !fs.existsSync(path.join(LIB, '.gusi-trash')))
const finalList = await tracks()
check('曲目数 = ' + (baseCount - FIXTURES.length), finalList.length === baseCount - FIXTURES.length, '实测 ' + finalList.length)
check('夹具不在索引里', !finalList.some(x => FIXTURES.includes(path.basename(x.relPath || ''))))

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
