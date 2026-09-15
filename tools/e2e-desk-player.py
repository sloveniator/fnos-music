#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-15 主人三项反馈的定向验证（网页端/桌面）：

  ①「缩小时的播放导航高度再增加一点，按钮太紧凑，放大一点，再放宽松」
     → >900px 底栏 --player-h ≥74px、传输键 44px、间距 16px、右侧组 14px；
       中心控制区既不压歌名区也不压右侧组。
  ②「播放/暂停按钮大小不用动，圆圈边缘太生硬做扩散美化」
     → 尺寸仍 46px 正圆；1px 硬描边与 0 0 0 4px 实心环都没了，改成多层递减外扩散。
  ③「全屏歌曲播放时，没有控制按钮，补上」
     → #lf-ctrls 在桌面（>900px）也显示，五个控件可点（elementFromPoint 命中自己），
       播放/上下曲/模式/进度/音量全都能用。

移动端（≤900px）回归：底栏两行布局与按钮尺寸不变，全屏控制条照旧是主控台。
"""
import json, os, random, shutil, string, sys, time, urllib.request, urllib.error

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'sdkp' + RND, 'Dkp' + RND + '!9'
P = F = 0
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def check(name, cond, detail=''):
    global P, F
    if cond:
        P += 1; print('  [PASS] %s  -- %s' % (name, detail))
    else:
        F += 1; print('  [FAIL] %s  -- %s' % (name, detail))


def post(path, body, t=None):
    r = urllib.request.Request(BASE + '/web' + path, method='POST')
    r.add_header('Content-Type', 'application/json')
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, json.dumps(body).encode(), timeout=60) as x:
        return json.loads(x.read().decode())


def get(path, t=None):
    r = urllib.request.Request(BASE + '/web' + path)
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, timeout=60) as x:
        return json.loads(x.read().decode())


tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
for fn in ['00 长轨静音.wav', '01 可爱女人.mp3', '02 完美主义.mp3']:
    shutil.copy(os.path.join(FIX, fn), os.path.join(dd, fn))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 3: break
    time.sleep(1)
print('临时用户 %s，曲目 %s' % (USER, get('/api/stats', tok)['data'].get('tracks')))

BAR = """() => {
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
                     return {l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width),
                             h: Math.round(r.height), t: Math.round(r.top), b: Math.round(r.bottom)}; };
  const bar = q('#player'), br = bar.getBoundingClientRect();
  const btns = ['#btn-mode', '#btn-prev', '#btn-play', '#btn-next', '#btn-queue'];
  const boxes = btns.map(s => { const e = q(s); const r = e.getBoundingClientRect();
    return {s: s, w: Math.round(r.width), h: Math.round(r.height), l: r.left, r: r.right}; });
  const gaps = [];
  for (let i = 1; i < boxes.length; i++) gaps.push(Math.round(boxes[i].l - boxes[i - 1].r));
  const right = ['#btn-lyric', '#vol-ico', '#vol'];
  const rboxes = right.map(s => { const e = q(s); const r = e.getBoundingClientRect();
    return {s: s, l: r.left, r: r.right}; });
  const rgaps = [];
  for (let i = 1; i < rboxes.length; i++) rgaps.push(Math.round(rboxes[i].l - rboxes[i - 1].r));
  const cs = getComputedStyle(q('#btn-play'));
  const svgcs = getComputedStyle(q('#btn-play svg'));
  const sh = cs.boxShadow;
  return {
    barH: Math.round(br.height), barBottom: Math.round(br.bottom), vh: window.innerHeight,
    barLeft: Math.round(br.left), barRight: Math.round(br.right),
    boxes: boxes.map(b => b.s + '=' + b.w + 'x' + b.h), gaps: gaps, rgaps: rgaps,
    ctrls: R('.ctrls'), np: R('.np'), right: R('#player .right'),
    playW: Math.round(q('#btn-play').getBoundingClientRect().width),
    playH: Math.round(q('#btn-play').getBoundingClientRect().height),
    radius: cs.borderTopLeftRadius, borderW: cs.borderTopWidth, shadow: sh,
    bg: cs.backgroundImage, color: cs.color, iconFilter: svgcs.filter,
    glowLayers: (sh.match(/rgba?\\([^)]*\\)/g) || []).filter(x => /150, 188, 255|79, 140, 255/.test(x)).length,
    hardRing: /0px 0px 0px/.test(sh),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    lift: getComputedStyle(document.documentElement).getPropertyValue('--player-lift').trim(),
  };
}"""

LF = """() => {
  const q = (s) => document.querySelector(s);
  const c = q('#lf-ctrls'), cr = c.getBoundingClientRect();
  const cs = getComputedStyle(c);
  const ids = ['#lf-mode', '#lf-prev', '#lf-play', '#lf-next', '#lf-vol-ico'];
  const hit = ids.map(s => { const e = q(s); const r = e.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return s + ':' + (el && el.closest(s) === e ? 'ok' : 'blocked-by-' + (el ? el.tagName + '.' + el.className : 'null'))
           + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top); });
  const body = q('#lf-body').getBoundingClientRect();
  const seek = q('#lf-seek').getBoundingClientRect();
  const gaps = [];
  let prev = null;
  for (const s of ids.slice(0, 4)) { const r = q(s).getBoundingClientRect();
    if (prev) gaps.push(Math.round(r.left - prev)); prev = r.right; }
  return { display: cs.display, h: Math.round(cr.height), top: Math.round(cr.top), bottom: Math.round(cr.bottom),
           vh: window.innerHeight, hit: hit, gaps: gaps, seekW: Math.round(seek.width),
           bodyBottom: Math.round(body.bottom), overlayHidden: q('#lyric-full').hidden,
           title: (q('#lf-title').textContent || '').trim(),
           modeTitle: q('#lf-mode').title, btnModeTitle: q('#btn-mode').title,
           playSvgLen: q('#lf-play').querySelector('svg').innerHTML.length,
           cur: q('#lf-t-cur').textContent, dur: q('#lf-t-dur').textContent };
}"""

MOB = """() => {
  const q = (s) => document.querySelector(s);
  const g = (s) => { const e = q(s); const r = e.getBoundingClientRect();
    return {w: Math.round(r.width), h: Math.round(r.height)}; };
  const c = q('#lf-ctrls'), cs = getComputedStyle(c);
  return { barH: Math.round(q('#player').getBoundingClientRect().height),
           mode: g('#btn-mode'), play: g('#btn-play'),
           lfDisplay: cs.display, lfH: Math.round(c.getBoundingClientRect().height),
           lfPlay: g('#lf-play'), vh: window.innerHeight,
           overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}"""


def open_track(pg, name):
    pg.goto(BASE + '/#/tracks')
    pg.wait_for_selector('table.tracks tbody tr', timeout=25000)
    pg.wait_for_timeout(400)
    ok = pg.evaluate("""(n) => {
      const rows = [...document.querySelectorAll('table.tracks tbody tr')];
      const r = rows.find(x => x.textContent.includes(n));
      if (!r) return false; r.click(); return true;
    }""", name)
    pg.wait_for_selector('body.has-player', timeout=15000)
    pg.wait_for_timeout(900)
    return ok


try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        # ================= A 桌面 1280x800：底栏加高放大放宽 + 播放键柔化 =================
        print('\n== A 桌面 1280x800 底栏 ==')
        ctx = b.new_context(viewport={'width': 1280, 'height': 800})
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        open_track(pg, '长轨静音')
        pg.mouse.move(4, 4)
        d = pg.evaluate(BAR)
        print('   barH=%d left=%d right=%d 按钮=%s 间距=%s 右组=%s' %
              (d['barH'], d['barLeft'], d['barRight'], d['boxes'], d['gaps'], d['rgaps']))
        check('A 底栏加高（≥76px，原来 71px）', 76 <= d['barH'] <= 104, 'barH=%d' % d['barH'])
        check('A 传输键放大到 44px（播放键仍 46px）',
              d['boxes'] == ['#btn-mode=44x44', '#btn-prev=44x44', '#btn-play=46x46',
                             '#btn-next=44x44', '#btn-queue=44x44'], d['boxes'])
        check('A 传输键间距放宽到 16px', d['gaps'] == [16, 16, 16, 16], d['gaps'])
        check('A 右侧组间距放宽到 14px（组内图标↔滑块仍 8px）',
              d['rgaps'][0] == 14 and d['rgaps'][1] >= 8, d['rgaps'])
        check('A 中心控制区不压歌名区、不压右侧组',
              d['ctrls']['l'] >= d['np']['r'] and d['ctrls']['r'] <= d['right']['l'],
              'np.r=%s ctrls=%s..%s right.l=%s' % (d['np']['r'], d['ctrls']['l'], d['ctrls']['r'], d['right']['l']))
        check('A 底栏不出屏 / 无横向溢出',
              d['barBottom'] <= d['vh'] + 1 and d['overflow'] <= 0 and d['lift'] in ('0px', ''),
              'bottom=%d/%d overflow=%d lift=%s' % (d['barBottom'], d['vh'], d['overflow'], d['lift']))
        # —— ② 播放键：尺寸不动，边缘柔化 ——
        check('A 播放键尺寸没动（正圆 46px + 50%）',
              d['playW'] == 46 and d['playH'] == 46 and d['radius'] == '50%', '%dx%d %s' % (d['playW'], d['playH'], d['radius']))
        check('A 硬描边已去掉（border-width=0）', d['borderW'] == '0px', d['borderW'])
        check('A 实心环已去掉（没有 0 0 0 Npx）', not d['hardRing'], d['shadow'][:60])
        check('A 改成多层递减外扩散（accent 扩散 ≥3 层）', d['glowLayers'] >= 3, 'layers=%d %s' % (d['glowLayers'], d['shadow'][:80]))
        check('A 保留柔和暗投影（有 depth）', 'rgba(2, 5, 12' in d['shadow'], d['shadow'][:40])
        check('A 填充改成径向化开（radial 渐变 + 不给乳白色号）',
              'radial-gradient' in d['bg'] and '255, 253, 249' not in d['bg'], d['bg'][:60])
        check('A 图标仍亮白 + 深色投影', d['color'] == 'rgb(241, 245, 255)' and 'drop-shadow' in d['iconFilter'],
              '%s / %s' % (d['color'], d['iconFilter']))
        # 底栏特写截图（只看底栏那一条）
        br = pg.evaluate("""() => { const r = document.getElementById('player').getBoundingClientRect();
          return {x: 0, y: Math.round(r.top) - 10, width: window.innerWidth, height: Math.round(r.height) + 22}; }""")
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-desk-bar-after.png'), clip=br)
        pb = pg.evaluate("""() => { const r = document.getElementById('btn-play').getBoundingClientRect();
          return {x: Math.round(r.left) - 34, y: Math.round(r.top) - 26, width: Math.round(r.width) + 68, height: Math.round(r.height) + 52}; }""")
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-desk-play-after.png'), clip=pb)

        # ================= B 全屏播放页：控制条补齐 =================
        print('\n== B 桌面 1280x800 全屏 ==')
        pg.keyboard.press('KeyL')
        pg.wait_for_timeout(700)
        lf = pg.evaluate(LF)
        print('   lf-ctrls display=%s h=%d 命中=%s' % (lf['display'], lf['h'], lf['hit']))
        check('B 全屏打开', not lf['overlayHidden'], str(lf['overlayHidden']))
        check('B 控制条在桌面端显示（display:flex 且高度 >0）',
              lf['display'] == 'flex' and lf['h'] > 80, '%s h=%d' % (lf['display'], lf['h']))
        check('B 控制条不出屏（贴在全屏底部）', 0 < lf['bottom'] <= lf['vh'] + 1, '%d/%d' % (lf['bottom'], lf['vh']))
        check('B 五个控件都能点到（没被歌词/装饰层盖住）',
              all(':ok ' in h for h in lf['hit']), lf['hit'])
        check('B 控件尺寸放大一档（46/56）',
              all(x in ' '.join(lf['hit']) for x in ['46x46', '56x56']), lf['hit'])
        check('B 控制条不压歌词区', lf['bodyBottom'] <= lf['top'] + 2, 'body.b=%d ctrls.t=%d' % (lf['bodyBottom'], lf['top']))
        # 播放/暂停
        n0 = lf['playSvgLen']
        pg.click('#lf-play')
        pg.wait_for_timeout(600)
        lf2 = pg.evaluate(LF)
        check('B 全屏播放/暂停可用（图标切换）', lf2['playSvgLen'] != n0, 'svg %d -> %d' % (n0, lf2['playSvgLen']))
        # 下一首 / 上一首：页内点击 + 250ms 采样。
        # 注意：临时曲库里两条 4KB 假 mp3 播不出来，播放器判「不可播」会自动往后跳，
        # 等 1.2s 已经绕回原曲 —— 那是 fixture 的问题不是按钮的问题，所以短等待即可。
        st0 = pg.evaluate("() => ({name: document.getElementById('np-name').textContent,"
                          " title: document.getElementById('lf-title').textContent,"
                          " index: window.__player.index})")
        nx = pg.evaluate("async () => { document.getElementById('lf-next').click();"
                         " await new Promise(r => setTimeout(r, 250));"
                         " return {name: document.getElementById('np-name').textContent,"
                         " title: document.getElementById('lf-title').textContent,"
                         " index: window.__player.index}; }")
        check('B 全屏下一首可用（曲目/标题/index 一起前进）',
              nx['name'] != st0['name'] and nx['title'] != st0['title'] and nx['index'] == st0['index'] + 1,
              '%s(idx=%s) -> %s(idx=%s)' % (st0['name'], st0['index'], nx['name'], nx['index']))
        pv = pg.evaluate("async () => { document.getElementById('lf-prev').click();"
                         " await new Promise(r => setTimeout(r, 250));"
                         " return {name: document.getElementById('np-name').textContent,"
                         " index: window.__player.index}; }")
        check('B 全屏上一首可用（回到原曲）', pv['name'] == st0['name'] and pv['index'] == st0['index'],
              '%s -> %s(idx=%s)' % (nx['name'], pv['name'], pv['index']))
        pg.wait_for_timeout(700)
        # 模式
        m0 = pg.evaluate(LF)['modeTitle']
        pg.click('#lf-mode')
        pg.wait_for_timeout(400)
        m1 = pg.evaluate(LF)
        check('B 全屏模式键可用（顺序→单曲）', m1['modeTitle'] == '单曲循环', '%s -> %s' % (m0, m1['modeTitle']))
        check('B 底栏模式键同步', m1['btnModeTitle'] == m1['modeTitle'], 'btn=%s lf=%s' % (m1['btnModeTitle'], m1['modeTitle']))
        pg.click('#lf-mode'); pg.wait_for_timeout(300)   # 复原成顺序播放
        # 进度条
        # audio 是 new Audio()（不在 DOM 里），要经 window.__player.audio 拿
        pg.evaluate("() => { const a = window.__player.audio; if (a && a.paused) a.play().catch(() => {}); }")
        pg.wait_for_timeout(600)
        seek = pg.evaluate("""() => { const r = document.getElementById('lf-seek').getBoundingClientRect();
          return {x: r.left + r.width * 0.7, w: Math.round(r.width), y: r.top + r.height / 2}; }""")
        pg.mouse.click(seek['x'], seek['y'])
        pg.wait_for_timeout(700)
        pos = pg.evaluate("() => { const a = window.__player.audio;"
                          " return {t: a ? a.currentTime : -1, d: a ? (a.duration || 0) : 0}; }")
        check('B 全屏进度条可拖（点 70% 位置 → currentTime 落在 60~80%）',
              pos['d'] > 0 and 0.55 <= pos['t'] / pos['d'] <= 0.85,
              't=%.2f d=%.2f ratio=%.2f' % (pos['t'], pos['d'], (pos['t'] / pos['d']) if pos['d'] else -1))
        # 音量
        pg.evaluate("""() => { const v = document.getElementById('lf-vol'); v.value = 35;
          v.dispatchEvent(new Event('input', {bubbles: true})); }""")
        pg.wait_for_timeout(400)
        vol = pg.evaluate("""() => ({lf: document.getElementById('lf-vol').value,
                                    bar: document.getElementById('vol').value})""")
        check('B 全屏音量可用（且与底栏同步）', vol['lf'] == '35' and vol['bar'] == '35', str(vol))
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-desk-fullscreen-after.png'))
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(500)
        check('B Escape 仍能关闭全屏', pg.evaluate("() => document.getElementById('lyric-full').hidden"),
              'hidden=%s' % pg.evaluate("() => document.getElementById('lyric-full').hidden"))
        check('A/B 无 JS 运行时错误', not errs, errs[:1])
        ctx.close()

        # ================= C 其它桌面视口：不出屏不溢出 =================
        for w, h in [(901, 700), (1024, 768), (1440, 900), (1920, 1080)]:
            print('\n== C %dx%d ==' % (w, h))
            ctx = b.new_context(viewport={'width': w, 'height': h})
            pg = ctx.new_page()
            pg.goto(BASE + '/')
            pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
            pg.reload()
            pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
            open_track(pg, '可爱女人')
            pg.mouse.move(4, 4)
            d = pg.evaluate(BAR)
            check('%dx%d 底栏加高（≥74px）' % (w, h), d['barH'] >= 74, 'barH=%d' % d['barH'])
            check('%dx%d 按钮放大后仍不重叠、不出屏' % (w, h),
                  d['ctrls']['l'] >= d['np']['r'] and d['ctrls']['r'] <= d['right']['l']
                  and d['barBottom'] <= d['vh'] + 1 and d['overflow'] <= 0,
                  'ctrls=%s..%s np.r=%s right.l=%s ovf=%d' % (d['ctrls']['l'], d['ctrls']['r'],
                                                              d['np']['r'], d['right']['l'], d['overflow']))
            if w >= 1200:
                check('%dx%d 传输键 44px' % (w, h), all('=44x44' in x or '=46x46' in x for x in d['boxes']), d['boxes'])
            ctx.close()

        # ================= D 移动端回归：两行底栏不变 =================
        print('\n== D 移动端 390x844 回归 ==')
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = ctx.new_page()
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        open_track(pg, '可爱女人')
        # 移动端：点信息区/封面展开全屏（桌面不响应这个手势），再量控制条
        pg.evaluate("() => { (document.querySelector('.np-art') || document.querySelector('.np')).click(); }")
        pg.wait_for_timeout(900)
        m = pg.evaluate(MOB)
        print('   barH=%d play=%s lf=%s' % (m['barH'], m['play'], m['lfPlay']))
        check('D 移动端底栏仍是两行 104px', m['barH'] == 104, 'barH=%d' % m['barH'])
        check('D 移动端传输键尺寸未被桌面档影响（40/48）',
              m['mode']['w'] == 40 and m['play']['w'] == 48, '%s / %s' % (m['mode'], m['play']))
        check('D 移动端无横向溢出', m['overflow'] <= 0, 'ovf=%d' % m['overflow'])
        check('D 移动端全屏控制条照旧显示（56px 播放键）',
              m['lfDisplay'] == 'flex' and m['lfPlay']['w'] == 56, '%s %s' % (m['lfDisplay'], m['lfPlay']))
        ctx.close()
        b.close()
    print('\n== %d passed, %d failed ==' % (P, F))
    sys.exit(1 if F else 0)
finally:
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    try:
        r = urllib.request.Request(BASE + '/admin/login', method='POST')
        r.add_header('Content-Type', 'application/json')
        with op.open(r, json.dumps({'password': 'REDACTED'}).encode(), timeout=30) as x:
            at = json.loads(x.read().decode())['token']
        r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
        r.add_header('X-Admin-Token', at)
        with op.open(r, timeout=30) as x:
            print('临时账号已清理:', x.status)
    except urllib.error.HTTPError as e:
        print('清理失败:', e.code)
