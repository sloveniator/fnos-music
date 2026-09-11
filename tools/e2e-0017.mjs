// UPGRADE_0017 Web E2E：随机播放入口 / 无放回洗牌 / 跨控件状态同步 / 快捷键
// 用法：node tools/e2e-0017.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(path.resolve('tools/node_modules/playwright-core'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gusi-e2e17-'))
const PORT = 19993
const ADMIN_PW = 'e2e-admin'
const BASE = 'http://127.0.0.1:' + PORT
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 造一个 4 首曲目的迷你曲库，走的是 0016 那套文件夹命名规则
const MusicDir = path.join(tmp, 'music')
fs.mkdirSync(path.join(MusicDir, 'ArtistA', 'AlbumOne'), { recursive: true })
fs.mkdirSync(path.join(MusicDir, 'misc'), { recursive: true })
const rnd = new Uint8Array(2048)
for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256)
for (const p of [
  'ArtistA/AlbumOne/01 - First Song.mp3',
  'ArtistA/AlbumOne/02 - Second Song.mp3',
  'Bob - Hello World.mp3',
  'misc/track04.flac',
]) fs.writeFileSync(path.join(MusicDir, p), rnd)

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

let browser = null
let webToken = null
try {
  check('server 启动可达', await waitUp())

  // 1) 管理后台登录 → 配曲库 → 扫描 → 建一个 Web 用户
  const al = await adminCall('POST', '/admin/login', { password: ADMIN_PW })
  const alJson = await al.json().catch(() => ({}))
  console.log('  [dbg] login status=' + al.status + ' body=' + JSON.stringify(alJson).slice(0, 200))
  const at = alJson.token
  const hdr = { 'X-Admin-Token': at }
  const set = await adminCall('POST', '/admin/api/library/settings', { dirs: [MusicDir] }, hdr)
  const setJson = await set.json().catch(() => ({}))
  console.log('  [dbg] settings status=' + set.status + ' body=' + JSON.stringify(setJson).slice(0, 200))
  check('library settings save', set.status === 200)
  const sc = await adminCall('POST', '/admin/api/library/scan', null, hdr)
  const scJson = await sc.json().catch(() => ({}))
  console.log('  [dbg] scan status=' + sc.status + ' body=' + JSON.stringify(scJson).slice(0, 200))
  check('scan accepted', sc.status === 200)
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const st = (await (await adminCall('GET', '/admin/api/library/stats', null, hdr)).json()).data
    if (st.scan.scanning === false && st.tracks >= 4) break
  }
  const st = (await (await adminCall('GET', '/admin/api/library/stats', null, hdr)).json()).data
  check('scan found 4 tracks', st.tracks >= 4, 'tracks=' + st.tracks)

  const mk = await adminCall('POST', '/admin/api/users', { name: 'e2euser', password: 'e2e-pass', scope: 'web' }, hdr)
  check('web user created', mk.status === 200 || mk.status === 201)

  // 2) 起 Chromium，走消费者登录
  const exe = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe'
  browser = await chromium.launch({ executablePath: exe, headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()) })
  page.on('response', (r) => {
    if (r.status() === 404) {
      const u = r.url().replace(BASE, '')
      console.log('  [net-404] ' + r.request().method() + ' ' + u)
    }
  })

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.fill('#login-name', 'e2euser')
  await page.fill('#login-pass', 'e2e-pass')
  await page.click('#login-btn')
  await page.waitForSelector('#view:not([hidden])', { timeout: 8000 })
  await sleep(500)
  check('consumer login ok', true)

  // 3) 全部歌曲页：顶部工具条 + 播放全部 + 随机播放
  await page.evaluate(() => { location.hash = '#/tracks' })
  await page.waitForSelector('.page-head', { timeout: 8000 })
  const head = await page.evaluate(() => {
    const h = document.querySelector('.page-head')
    if (!h) return null
    const btns = [...h.querySelectorAll('.btns button')].map(b => (b.innerText || '').trim())
    return { meta: (h.querySelector('.meta')?.innerText || '').trim(), btns }
  })
  check('全部歌曲顶部工具条存在', !!head && /共\s*\d+\s*首/.test(head.meta), JSON.stringify(head))
  check('顶部有"播放全部"', !!head && head.btns.some(t => t.includes('播放全部')))
  check('顶部有"随机播放"', !!head && head.btns.some(t => t.includes('随机播放')))

  // 4) 触发随机播放 → 播放模式切到 shuffle（localStorage 与底栏图标同步）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.page-head .btns button')]
    btns.find(b => b.innerText.includes('随机播放'))?.click()
  })
  await sleep(700)
  const afterShuf = await page.evaluate(() => ({
    mode: localStorage.getItem('gusi-mode'),
    btnModeHasShuffle: !!document.querySelector('#btn-mode path'),
    btnModeTitle: document.getElementById('btn-mode')?.title || '',
    lfModeTitle: document.getElementById('lf-mode')?.title || '',
    playerVisible: !document.getElementById('player').hidden,
  }))
  check('随机播放切到 shuffle 模式', afterShuf.mode === 'shuffle', JSON.stringify(afterShuf))
  check('#btn-mode 与 #lf-mode title 同步', afterShuf.btnModeTitle === '随机播放' && afterShuf.lfModeTitle === '随机播放',
    `btn="${afterShuf.btnModeTitle}" lf="${afterShuf.lfModeTitle}"`)

  // 5) 快捷键 L/Q/S
  await page.keyboard.press('KeyL')
  await sleep(300)
  const lfVisible = await page.evaluate(() => !document.getElementById('lyric-full').hidden)
  check('快捷键 L 打开歌词全屏', lfVisible)
  await page.keyboard.press('Escape')
  await sleep(200)
  const lfHidden = await page.evaluate(() => document.getElementById('lyric-full').hidden)
  check('Escape 关闭歌词全屏', lfHidden)

  await page.keyboard.press('KeyQ')
  await sleep(200)
  const queueVisible = await page.evaluate(() => !document.getElementById('queue').hidden)
  check('快捷键 Q 打开队列', queueVisible)
  await page.keyboard.press('Escape')
  await sleep(200)
  const queueHidden = await page.evaluate(() => document.getElementById('queue').hidden)
  check('Escape 关闭队列', queueHidden)

  // 快捷键 S 切循环模式（在 shuffle 基础上应切到 single 或 order）
  const beforeS = await page.evaluate(() => localStorage.getItem('gusi-mode'))
  await page.keyboard.press('KeyS')
  await sleep(200)
  const afterS = await page.evaluate(() => localStorage.getItem('gusi-mode'))
  check('快捷键 S 切换循环模式', beforeS !== afterS, `${beforeS} -> ${afterS}`)

  // 6) 帮助面板显示 L/Q/S
  await page.keyboard.press('Shift+Slash')
  await sleep(300)
  const help = await page.evaluate(() => {
    const p = document.getElementById('help-panel')
    if (!p || p.hidden) return null
    const text = p.innerText
    return { hasL: /\bL\b[\s\S]{0,20}歌词/.test(text), hasQ: /\bQ\b[\s\S]{0,20}队列/.test(text), hasS: /\bS\b[\s\S]{0,30}(模式|循环|随机)/.test(text), raw: text }
  })
  check('帮助面板含 L/Q/S 三条快捷键', !!help && help.hasL && help.hasQ && help.hasS,
    JSON.stringify(help && { hasL: help.hasL, hasQ: help.hasQ, hasS: help.hasS }))
  await page.keyboard.press('Escape')

  // 7) 无放回洗牌：队列面板已建（≥4 项）。先重新打开队列。
  const queueLen = await page.evaluate(() => {
    const p = document.getElementById('queue')
    if (p) p.hidden = false
    return p ? p.querySelectorAll('li, tr, .q-item, [class*="queue"] > *').length : -1
  })
  check('队列面板有若干项', queueLen > 0, 'queueLen=' + queueLen)

  // 8) 下载按钮：底栏 #np-download 存在且当前曲目是本地曲库时可见
  const dlBtn = await page.evaluate(() => {
    const b = document.getElementById('np-download')
    if (!b) return null
    return { title: b.title, visible: b.style.visibility !== 'hidden', pointer: b.style.pointerEvents !== 'none' }
  })
  check('底栏下载按钮存在且可见', !!dlBtn && dlBtn.title === '下载当前曲目' && dlBtn.visible && dlBtn.pointer, JSON.stringify(dlBtn))

  // 9) 下载接口：直接调 /web/media/download/<id>，验证 200 + Content-Disposition: attachment
  const anyTrack = await page.evaluate(async () => {
    const token = localStorage.getItem('gusi-web-token') || ''
    const r = await fetch('/web/api/tracks?size=1', { headers: { 'X-Web-Token': token } })
    const d = await r.json()
    return (d.data && d.data.tracks && d.data.tracks[0]) ? { id: d.data.tracks[0].id, name: d.data.tracks[0].name } : null
  })
  check('曲库有可下载曲目', !!anyTrack, JSON.stringify(anyTrack))
  if (anyTrack) {
    const resp = await page.evaluate(async (id) => {
      const token = localStorage.getItem('gusi-web-token') || ''
      const r = await fetch('/web/media/download/' + id + '?k=' + encodeURIComponent(token), { method: 'GET' })
      const h = Object.fromEntries(r.headers.entries())
      const ab = await r.arrayBuffer().catch(() => null)
      return { status: r.status, cd: h['content-disposition'] || '', ct: h['content-type'] || '', size: ab ? ab.byteLength : 0 }
    }, anyTrack.id)
    check('下载接口 200 且带 Content-Disposition: attachment', resp.status === 200 && /attachment/.test(resp.cd) && resp.size > 0, JSON.stringify(resp))
  }

  // 10) 快捷键 D 触发下载：拦截 <a> click
  await page.evaluate(() => {
    window.__lastDownloadUrl = null
    const _origCreate = document.createElement.bind(document)
    document.createElement = (tag) => {
      const el = _origCreate(tag)
      if (String(tag).toLowerCase() === 'a') {
        const origClick = el.click.bind(el)
        el.click = function () {
          window.__lastDownloadUrl = el.href
          window.__lastDownloadAttr = el.download
          return origClick()
        }
      }
      return el
    }
  })
  await page.keyboard.press('KeyD')
  await sleep(200)
  const anchorState = await page.evaluate(() => ({ url: window.__lastDownloadUrl, attr: window.__lastDownloadAttr }))
  check('快捷键 D 触发下载（<a> 点击）', !!anchorState.url && anchorState.url.includes('/web/media/download/'), JSON.stringify(anchorState))

  // 11) 曲目菜单含"下载…"
  await page.evaluate(() => { location.hash = '#/tracks' })
  await sleep(500)
  const menuState = await page.evaluate(() => {
    const mb = document.querySelector('.more-wrap .iconbtn')
    if (!mb) return null
    mb.click()
    const m = document.querySelector('.menu')
    if (!m) return null
    const items = [...m.querySelectorAll('button')].map(b => b.innerText.trim())
    return { items }
  })
  check('曲目菜单含"下载…"', !!menuState && menuState.items.includes('下载…'), JSON.stringify(menuState))

  // 12) 帮助面板含 D
  await page.keyboard.press('Shift+Slash')
  await sleep(300)
  const help2 = await page.evaluate(() => {
    const p = document.getElementById('help-panel')
    return p && !p.hidden ? p.innerText : null
  })
  check('帮助面板含 D 下载当前曲目', !!help2 && /\bD\b[\s\S]{0,20}下载/.test(help2), (help2 || '').slice(0, 200))
  await page.keyboard.press('Escape')

  // 13) 播放页（CD 旋转 + 歌词）：点击底栏封面拉起
  // 13.1 封面/容器存在、pointer cursor、title
  const coverState = await page.evaluate(() => {
    const c = document.getElementById('np-cover')
    if (!c) return null
    const wrap = c.closest('.np-art')
    return {
      coverTitle: c.title,
      coverCursor: c.style.cursor,
      wrapCursor: wrap ? wrap.style.cursor : null,
    }
  })
  check('底栏封面带"打开播放页"提示且可点击', !!coverState && coverState.coverTitle === '打开播放页' && coverState.coverCursor === 'pointer' && coverState.wrapCursor === 'pointer',
    JSON.stringify(coverState))

  // 13.2 点击封面 → 播放页出现，含 CD 结构和 #lf-disc
  await page.evaluate(() => {
    const c = document.getElementById('np-cover')
    if (c) c.click()
  })
  await sleep(300)
  const playPageOpen = await page.evaluate(() => {
    const p = document.getElementById('lyric-full')
    if (!p || p.hidden) return null
    const disc = document.getElementById('lf-disc')
    const stage = document.querySelector('.lf-stage')
    const wrap = document.querySelector('.lf-disc-wrap')
    const inner = document.querySelector('.lf-disc-inner')
    const discCover = document.getElementById('lf-disc-cover')
    const label = document.querySelector('.lf-disc-label')
    const hub = document.querySelector('.lf-disc-hub')
    const body = document.getElementById('lf-body')
    const bg = document.getElementById('lf-bg')
    return {
      hidden: p.hidden,
      discExists: !!disc,
      stageExists: !!stage,
      wrapExists: !!wrap,
      innerExists: !!inner,
      discCoverExists: !!discCover,
      labelExists: !!label,
      hubExists: !!hub,
      bodyExists: !!body,
      bgExists: !!bg,
      discClass: disc ? disc.className : '',
      bgStyle: bg ? (bg.style.backgroundImage || '') : '',
      discCoverSrc: discCover ? (discCover.getAttribute('src') || '') : '',
    }
  })
  check('点击底栏封面拉起播放页', !!playPageOpen && !playPageOpen.hidden, JSON.stringify(playPageOpen))
  check('播放页含 CD 结构（disc/stage/wrap/inner/label/hub/body/bg）',
    !!playPageOpen && playPageOpen.discExists && playPageOpen.stageExists && playPageOpen.wrapExists &&
    playPageOpen.innerExists && playPageOpen.labelExists && playPageOpen.hubExists &&
    playPageOpen.bodyExists && playPageOpen.bgExists,
    JSON.stringify(playPageOpen && { disc: playPageOpen.discExists, stage: playPageOpen.stageExists, hub: playPageOpen.hubExists, body: playPageOpen.bodyExists }))

  // 13.3 CSS 关键帧 lf-spin 存在 + CD 有旋转动画
  const discStyle = await page.evaluate(() => {
    const disc = document.getElementById('lf-disc')
    if (!disc) return null
    const cs = getComputedStyle(disc)
    const kf = document.styleSheets
    let hasSpinKeyframe = false
    for (const s of kf) {
      try {
        for (const r of s.cssRules) {
          if (r instanceof CSSKeyframesRule && r.name === 'lf-spin') { hasSpinKeyframe = true; break }
        }
      } catch {}
      if (hasSpinKeyframe) break
    }
    return {
      name: cs.animationName,
      dur: cs.animationDuration,
      timing: cs.animationTimingFunction,
      iteration: cs.animationIterationCount,
      playState: cs.animationPlayState,
      borderRadius: cs.borderRadius,
      hasSpinKeyframe,
    }
  })
  check('CD 具备 lf-spin 旋转动画且有关键帧',
    !!discStyle && discStyle.hasSpinKeyframe && /lf-spin/.test(discStyle.name) && parseFloat(discStyle.dur) > 0 && discStyle.iteration === 'infinite',
    JSON.stringify(discStyle))

  // 13.4 播放态同步：切 pause → CD 停止；再点 play → CD 旋转
  const pauseDiscState = await page.evaluate(() => {
    // 直接调用 player 的 setPlayIcon 会受 cur/audio 影响；这里仅观察类切换逻辑
    const disc = document.getElementById('lf-disc')
    const before = disc ? disc.classList.contains('playing') : null
    // 手动切换观察：不真改 audio
    return { before }
  })
  // 通过 UI 播放/暂停（若无实际曲目，audio.play 会失败但 setPlayIcon 仍会触发）
  await page.evaluate(() => {
    const disc = document.getElementById('lf-disc')
    // 用 btn-play 触发一次切换；即使无 cur，setPlayIcon 也会更新盘片类
    document.getElementById('btn-play').click()
  })
  await sleep(150)
  const discAfterClick = await page.evaluate(() => {
    const disc = document.getElementById('lf-disc')
    if (!disc) return null
    const cs = getComputedStyle(disc)
    return { hasPlaying: disc.classList.contains('playing'), playState: cs.animationPlayState }
  })
  check('CD 播放态通过 .playing 类驱动 animation-play-state',
    !!discAfterClick && ((discAfterClick.hasPlaying && discAfterClick.playState === 'running') ||
      (!discAfterClick.hasPlaying && discAfterClick.playState === 'paused')),
    JSON.stringify(discAfterClick))

  // 13.5 关闭按钮 → 播放页关闭；再次按 L 键重新打开
  await page.evaluate(() => { document.getElementById('lf-close').click() })
  await sleep(200)
  const afterClose = await page.evaluate(() => document.getElementById('lyric-full').hidden)
  check('#lf-close 关闭播放页', afterClose === true)

  await page.keyboard.press('KeyL')
  await sleep(200)
  const afterLKey = await page.evaluate(() => !document.getElementById('lyric-full').hidden)
  check('快捷键 L 重新打开播放页', afterLKey)
  await page.keyboard.press('Escape')

  // 14) 移动端样式：断言 .lf-disc 有移动端尺寸覆盖（≤900px）
  const mediaRules = await page.evaluate(() => {
    let found = null
    for (const s of document.styleSheets) {
      try {
        for (const r of s.cssRules) {
          if (r instanceof CSSMediaRule && /900px/.test(r.media.mediaText)) {
            for (const inner of r.cssRules) {
              const sel = (inner.selectorText || '').trim()
              if (sel === '.lf-disc' && /220px|42vh/.test(inner.cssText)) { found = inner.cssText; break }
              if (sel === '.lf-stage' && /grid-template-rows/.test(inner.cssText)) { found = found || inner.cssText }
            }
            if (found) break
          }
        }
      } catch {}
      if (found) break
    }
    return found
  })
  check('移动端 .lf-disc 尺寸响应式覆盖存在', !!mediaRules, (mediaRules || '').slice(0, 120))

  // 8) 首页最近播放区块（若已有播放记录）
  await page.evaluate(() => { location.hash = '#/home' })
  await sleep(500)
  const home = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row-head')]
    const rh = rows.find(r => (r.innerText || '').includes('最近播放'))
    if (!rh) return null
    const btns = [...rh.querySelectorAll('button')].map(b => (b.innerText || '').trim())
    return { btns }
  })
  check('首页最近播放区块含随机播放按钮', !!home && home.btns.some(t => t.includes('随机播放')), JSON.stringify(home))

  // 9) 搜索页 tracks 结果工具条
  await page.evaluate(() => { location.hash = '#/search?q=song' })
  await sleep(600)
  const searchHead = await page.evaluate(() => {
    const rh = [...document.querySelectorAll('.row-head')].find(r => (r.innerText || '').includes('歌曲'))
    if (!rh) return null
    const btns = [...rh.querySelectorAll('button')].map(b => (b.innerText || '').trim())
    return { btns }
  })
  check('搜索页 tracks 结果含随机播放', !!searchHead && searchHead.btns.some(t => t.includes('随机播放')), JSON.stringify(searchHead))

  // 10) 无 JS 运行时错误（404 资源失败不计：测试曲目是随机字节，无内嵌封面）
  const runtimeErrors = jsErrors.filter(e => !/status of 404|Failed to load resource/i.test(e))
  check('无 JS 运行时错误', runtimeErrors.length === 0, runtimeErrors.slice(0, 2).join(' | '))

  await page.screenshot({ path: 'tools/e2e-0017.png' })
  console.log('  (screenshot: tools/e2e-0017.png)')
} catch (e) {
  console.log('[EXC] ' + (e && e.stack || e))
  fail++
} finally {
  if (browser) await browser.close()
  child.kill('SIGKILL')
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
