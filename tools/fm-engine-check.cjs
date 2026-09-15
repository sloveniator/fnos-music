// FM 电台内容引擎自检（不依赖 Web 服务，直接跑编译产物）
// 用法：node tools/fm-engine-check.cjs
// 覆盖：频道目录（汽水听歌模式）→ 每频道建池 → 批量续播 → exclude 去重 → 池子耗尽重开
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const fm = require(path.join(ROOT, 'server/server/online/fm.js'))

const fail = []
const okMsg = []
const assert = (cond, msg) => { if (cond) okMsg.push('  ✓ ' + msg); else fail.push('  ✗ ' + msg) }

;(async () => {
  console.log('== 1. 频道目录（汽水「听歌模式」实时拉取） ==')
  const t0 = Date.now()
  const chans = await fm.fmChannels()
  console.log(`  拉取 ${chans.length} 个频道，用时 ${Date.now() - t0}ms`)
  assert(chans.length >= 40, `频道数 ≥ 40（实得 ${chans.length}）`)
  const want = ['scene_mode_emo', 'scene_mode_slow_motion', 'scene_mode_bedtime', 'scene_mode_commute']
  for (const k of want) {
    const c = chans.find((x) => x.key === k)
    assert(!!c, `包含用户点名的模式 ${k}${c ? `（${c.name}）` : ''}`)
  }
  const slow = chans.find((x) => x.key === 'scene_mode_slow_motion')
  assert(slow && slow.playbackRate === 0.8, '「沉浸 0.8x」频道带 playbackRate=0.8')
  for (const c of chans.slice(0, 6)) console.log(`     ${c.key.padEnd(24)} ${c.name.padEnd(10)} ${c.desc}`)

  console.log('\n== 2. 频道建池 + 首批取曲 ==')
  for (const k of ['scene_mode_emo', 'scene_mode_slow_motion', 'scene_mode_bedtime']) {
    const t = Date.now()
    const r = await fm.fmNext(k, [], 20)
    console.log(`  ${r.name.padEnd(10)} 首批 ${String(r.list.length).padStart(2)} 首 / 池 ${String(r.poolSize).padStart(3)} 首 / ${Date.now() - t}ms / rate=${r.playbackRate}`)
    console.log(`     例: ${r.list.slice(0, 3).map((x) => x.name + '-' + x.singer).join(' | ').slice(0, 90)}`)
    assert(r.list.length === 20, `${k} 首批取满 20 首`)
    assert(r.poolSize >= 20, `${k} 池规模 ≥ 20（实得 ${r.poolSize}）`)
    assert(r.list.every((x) => x.source === 'soda' && x.id), `${k} 曲目均为汽水源且带 id`)
  }

  console.log('\n== 3. 续播去重（exclude 生效） ==')
  const a = await fm.fmNext('scene_mode_emo', [], 20)
  const idsA = a.list.map((x) => x.id)
  const b = await fm.fmNext('scene_mode_emo', idsA, 20)
  const idsB = b.list.map((x) => x.id)
  const dup = idsB.filter((id) => idsA.includes(id))
  console.log(`  第一轮 ${idsA.length} 首 / 第二轮 ${idsB.length} 首 / 重复 ${dup.length} 首`)
  assert(dup.length === 0, '两轮之间零重复')
  assert(idsB.length === 20, '第二轮仍取满 20 首（池子够大时）')

  console.log('\n== 4. 池子跑完一圈 → 重开（永不停播） ==')
  const poolAll = await fm.fmNext('scene_mode_emo', [], 50)
  const everything = poolAll.list.map((x) => x.id)
  const full = []
  for (let i = 0; i < 40; i++) {
    const r = await fm.fmNext('scene_mode_emo', everything, 50)
    if (!r.list.length) break
    full.push(...r.list.map((x) => x.id))
    everything.push(...r.list.map((x) => x.id))
  }
  const re = await fm.fmNext('scene_mode_emo', everything, 10)
  console.log(`  排除 ${everything.length} 首后：返回 ${re.list.length} 首，reset=${re.reset}`)
  assert(re.list.length > 0 && re.reset === true, 'exclude 覆盖全池时忽略 exclude 重开（reset=true）')

  console.log('\n== 5. 缓存命中（同频道二次调用应远快于建池） ==')
  const t1 = Date.now(); await fm.fmNext('scene_mode_emo', [], 5); const cached = Date.now() - t1
  console.log(`  缓存命中耗时 ${cached}ms，池 ${fm.fmPoolSize('scene_mode_emo')} 首`)
  assert(cached < 1200, `缓存命中 < 1200ms（实得 ${cached}ms）`)

  console.log('\n===== 结果 =====')
  console.log(okMsg.join('\n'))
  if (fail.length) { console.log('\n失败项：'); console.log(fail.join('\n')); process.exit(1) }
  console.log(`\n全部通过（${okMsg.length} 项）`)
})().catch((e) => { console.error('自检异常：', e); process.exit(1) })
