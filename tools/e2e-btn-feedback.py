#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证：播放/暂停键改乳白 + 「点按只给即时动画，不留残影」。

覆盖：
  A 桌面(真 hover)：乳白配色 / 无 accent 蓝紫外发光 / 近黑图标；按压→松手后的计算样式回到基态；
    hover 只提亮不加阴影，指针移开即无痕。
  B 手机仿真(hover:none)：CDP 强制 :hover，逐个比对按钮/卡片的计算样式与基态是否完全一致
    （一致 = 点按后不会黏住高亮/位移/阴影）；tap 之后再量一次。
  C 布局回归：底栏不出屏、无横向溢出、播放键 ≥42px 正圆；歌词全屏同款乳白。
截图证据：tools/shot-milky-*.png
"""
import json, os, random, shutil, string, sys, time, urllib.request

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西/01 可爱女人.mp3'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'sbfb' + RND, 'Bfb' + RND + '!9'
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
shutil.copy(FIX, os.path.join(dd, '01 可爱女人.mp3'))
for _ in range(30):
    if get('/api/stats', tok)['data'].get('tracks', 0) > 0: break
    time.sleep(1)

# 计算样式取样：基态与 hover 态都取同样这些属性
PROPS = ['backgroundColor', 'backgroundImage', 'boxShadow', 'transform', 'borderTopColor',
         'color', 'filter', 'opacity', 'height']
SAMPLE = """(args) => {
  const [sel, props] = args;
  const e = document.querySelector(sel);
  if (!e) return null;
  const cs = getComputedStyle(e);
  const o = {};
  props.forEach(k => { o[k] = cs[k]; });
  return o;
}"""

PLAY_PROBE = """() => {
  const b = document.getElementById('btn-play');
  const cs = getComputedStyle(b);
  const ic = getComputedStyle(b.querySelector('svg'));
  const r = b.getBoundingClientRect();
  const bar = document.getElementById('player').getBoundingClientRect();
  const lf = document.getElementById('lf-play');
  const lcs = getComputedStyle(lf);
  return {
    w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderTopLeftRadius,
    bgImage: cs.backgroundImage, bgColor: cs.backgroundColor, shadow: cs.boxShadow,
    color: cs.color, iconFilter: ic.filter, border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    lfW: Math.round(lf.getBoundingClientRect().width), lfBg: lcs.backgroundImage, lfColor: lcs.color,
    lfShadow: lcs.boxShadow,
    barBottom: Math.round(bar.bottom), vh: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}"""

SEED = """() => {
  const old = document.getElementById('diag'); if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'diag';
  wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:99;display:block;width:340px';
  const mk = (tag, cls, txt, par) => { const d = document.createElement(tag); d.className = cls;
    d.style.cssText = 'width:64px;height:28px;display:inline-flex;align-items:center;justify-content:center';
    d.textContent = txt; (par || wrap).appendChild(d); return d; };
  mk('div', 'card', 'cd');
  mk('div', 'bcard', 'bc');
  mk('div', 'fy-card', 'fy');
  mk('div', 'fm-card', 'fm');
  mk('div', 'coll-card', 'cl');
  mk('button', 'btn primary', 'pr');
  mk('button', 'btn', 'bt');
  mk('button', 'load-more', 'lm');
  mk('button', 'iconbtn', 'ic');
  mk('button', 'chip hchip', 'ch');
  mk('span', 'crumb', 'cb');
  mk('button', 'otab', 'ot');
  const nav = document.createElement('div'); nav.className = 'nav'; wrap.appendChild(nav);
  mk('a', '', 'nv', nav);
  const sf = document.createElement('div'); sf.className = 'side-foot'; wrap.appendChild(sf);
  mk('button', '', 'sf', sf);
  const sl = document.createElement('div'); sl.className = 'side-links'; wrap.appendChild(sl);
  mk('a', '', 'sl', sl);
  const qb = document.createElement('div'); qb.className = 'queue-body'; wrap.appendChild(qb);
  mk('div', 'q-row', 'qr', qb);
  document.body.appendChild(wrap);
}"""

# 强制 hover 后必须与基态完全一致的样本（按钮 + 可点卡片/列表）
TOUCH_SAMPLES = [
    '#diag .card', '#diag .bcard', '#diag .fy-card', '#diag .fm-card',
    '#diag .btn.primary', '#diag .btn:not(.primary)', '#diag .load-more', '#diag .iconbtn',
    '#diag .chip.hchip', '#diag .crumb', '#diag .nav a', '#diag .side-foot button',
    '#diag .side-links a', '#diag .queue-body .q-row', '#player .icon-btn:not(.play)',
    '#btn-play',
]

FAILED_SEL = []


def force_hover(cdp, sel, on):
    doc = cdp.send('DOM.getDocument', {'depth': 1})
    n = cdp.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': sel})
    if not n.get('nodeId'):
        return False
    cdp.send('CSS.forcePseudoState', {'nodeId': n['nodeId'],
                                      'forcedPseudoClasses': ['hover'] if on else []})
    return True


try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        # ============ A 桌面：乳白配色 + 按压无残留 ============
        print('\n== A 桌面 1280x800（真 hover）==')
        ctx = br.new_context(viewport={'width': 1280, 'height': 800})
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('table.tracks tbody tr', timeout=20000)
        pg.evaluate("() => document.querySelector('table.tracks tbody tr').click()")
        pg.wait_for_selector('body.has-player', timeout=15000)
        pg.wait_for_timeout(900)
        pg.mouse.move(4, 4)
        d = pg.evaluate(PLAY_PROBE)
        base_shadow = d['shadow']
        print('   desktop play: %dx%d %s' % (d['w'], d['h'], d['color']))

        check('A 乳白底：radial 高光 + 暖白渐变', 'radial-gradient' in d['bgImage'] and 'linear-gradient' in d['bgImage'], d['bgImage'][:70] + '…')
        check('A 底色偏乳白（暖白 RGB 出现在渐变里）',
              ('255, 253, 249' in d['bgImage'] and '232, 228, 220' in d['bgImage']) or '255, 254, 251' in d['bgImage'],
              'found' if '255, 253, 249' in d['bgImage'] else 'missing')
        check('A 不再有 accent 蓝紫外发光', '79, 140, 255' not in d['shadow'] and '124, 92, 255' not in d['shadow'], d['shadow'][:70])
        check('A 保留柔和暗投影（有 depth）', 'rgba(3, 6, 14' in d['shadow'], d['shadow'][:70])
        check('A 图标近黑（浅底对比）', d['color'] == 'rgb(27, 32, 43)', d['color'])
        check('A 图标投影不再是白色重影', 'drop-shadow' in d['iconFilter'], d['iconFilter'])
        check('A 仍是正圆、尺寸 ≥42px', d['w'] == d['h'] and d['w'] >= 42 and d['radius'] == '50%', '%dx%d %s' % (d['w'], d['h'], d['radius']))

        # hover：只提亮，不加阴影、不改位移
        pg.hover('#btn-play')
        pg.wait_for_timeout(300)
        h = pg.evaluate(PLAY_PROBE)
        check('A hover 不新增阴影（点过后不留外发光）', h['shadow'] == base_shadow, h['shadow'][:46])
        check('A hover 不位移/不缩放', pg.eval_on_selector('#btn-play', 'e => getComputedStyle(e).transform') == 'none', 'transform=none')
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-milky-desktop-hover.png'))
        pg.mouse.move(4, 4)
        pg.wait_for_timeout(300)

        # 按压 → 松手：即时动画 + 回到基态
        box = pg.eval_on_selector('#btn-play', 'e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }')
        pg.mouse.move(box['x'], box['y'])
        pg.mouse.down()
        pg.wait_for_timeout(120)
        press = pg.eval_on_selector('#btn-play', 'e => getComputedStyle(e).transform')
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-milky-desktop-press.png'))
        pg.mouse.up()
        pg.wait_for_timeout(60)
        check('A 按压有即时动画（scale 变换）', press not in ('none', '') and 'matrix' in press, press)
        pg.mouse.move(4, 4)
        pg.wait_for_timeout(450)
        after = pg.evaluate(PLAY_PROBE)
        check('A 松手+移开指针后完全回到基态（无残影）',
              after['shadow'] == base_shadow and pg.eval_on_selector('#btn-play', 'e => getComputedStyle(e).transform') == 'none',
              after['shadow'][:46])
        pg.mouse.move(4, 4)
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-milky-desktop.png'))

        # 其他按钮：同样按一下就有动画，松手无残留
        for sel in ['#np-love', '#np-download', '#btn-mode']:
            pg.mouse.move(4, 4)
            pg.wait_for_timeout(150)
            b0 = pg.eval_on_selector(sel, 'e => { const cs = getComputedStyle(e); return cs.boxShadow + "|" + cs.transform; }')
            bx = pg.eval_on_selector(sel, 'e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; }')
            pg.mouse.move(bx['x'], bx['y'])
            pg.mouse.down()
            pg.wait_for_timeout(120)
            mid = pg.eval_on_selector(sel, 'e => getComputedStyle(e).transform')
            pg.mouse.up()
            pg.mouse.move(4, 4)
            pg.wait_for_timeout(450)
            b1 = pg.eval_on_selector(sel, 'e => { const cs = getComputedStyle(e); return cs.boxShadow + "|" + cs.transform; }')
            check('A %s 按压有即时动画' % sel, mid not in ('none', '') and 'matrix' in mid, mid)
            check('A %s 松手后无残留（阴影/位移回基态）' % sel, b0 == b1, b1[:52])
        check('A 无 JS 运行时错误', not errs, errs[:1])
        ctx.close()

        # ============ B 手机仿真：hover 归零 ============
        print('\n== B 手机仿真 390x844（hover:none / pointer:coarse）==')
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        print('   MQ:', pg.evaluate("() => ({hover: matchMedia('(hover: hover)').matches, coarse: matchMedia('(pointer: coarse)').matches})"))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('table.tracks tbody tr', timeout=20000)
        pg.tap('table.tracks tbody tr')
        pg.wait_for_selector('body.has-player', timeout=15000)
        pg.wait_for_timeout(900)
        pg.evaluate(SEED)
        cdp = ctx.new_cdp_session(pg)
        cdp.send('DOM.enable'); cdp.send('CSS.enable')
        for sel in TOUCH_SAMPLES:
            pg.mouse.move(389, 4)
            pg.wait_for_timeout(80)
            base = pg.evaluate(SAMPLE, [sel, PROPS])
            if base is None:
                check('B %s 存在' % sel, False, '选择器没匹配到元素'); FAILED_SEL.append(sel); continue
            if not force_hover(cdp, sel, True):
                check('B %s 可强制 hover' % sel, False, 'CDP 未找到节点'); FAILED_SEL.append(sel); continue
            pg.wait_for_timeout(120)
            hov = pg.evaluate(SAMPLE, [sel, PROPS])
            force_hover(cdp, sel, False)
            diff = {k: (base[k], hov[k]) for k in PROPS if base[k] != hov[k]}
            check('B %s 点按后不留高亮/位移/阴影' % sel, not diff, ('差异 ' + str(diff))[:150] if diff else 'hover 与基态一致')
        cdp.detach()
        # 换一个新页做「真实 tap 之后有没有残留」：强制 hover 的实验会污染同页状态
        ctx2 = br.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        pg.close(); pg = ctx2.new_page()
        errs2 = []
        pg.on('pageerror', lambda e: errs2.append(str(e)))
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('table.tracks tbody tr', timeout=20000)
        pg.tap('table.tracks tbody tr')
        pg.wait_for_selector('body.has-player', timeout=15000)
        pg.wait_for_timeout(900)
        pg.mouse.move(389, 4)
        pg.wait_for_timeout(150)
        play_base = pg.evaluate(SAMPLE, ['#btn-play', PROPS])
        pg.tap('#btn-play')
        pg.wait_for_timeout(400)
        play_after = pg.evaluate(SAMPLE, ['#btn-play', PROPS])
        diff = {k: (play_base[k], play_after[k]) for k in PROPS if play_base[k] != play_after[k]}
        check('B tap 播放键后无残留（样式不因点击而停留）', not diff, str(diff)[:140] if diff else '与基态一致')
        # 乳白配色在手机上同样生效 + 布局
        d = pg.evaluate(PLAY_PROBE)
        check('B 手机底栏播放键同款乳白', 'radial-gradient' in d['bgImage'] and '79, 140, 255' not in d['shadow'], d['bgImage'][:60] + '…')
        check('B 手机底栏不出屏', 0 < d['barBottom'] <= d['vh'] + 1, '%d/%d' % (d['barBottom'], d['vh']))
        check('B 手机无横向溢出', d['overflow'] <= 0, 'overflow=%d' % d['overflow'])
        check('B 手机播放键 ≥44px 正圆', d['w'] == d['h'] and d['w'] >= 44, '%dx%d' % (d['w'], d['h']))
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-milky-mobile.png'))
        # 歌词全屏同款
        pg.tap('.np')
        pg.wait_for_timeout(900)
        dl = pg.evaluate(PLAY_PROBE)
        check('B 歌词全屏播放键同款乳白',
              'radial-gradient' in dl['lfBg'] and '79, 140, 255' not in dl['lfShadow'] and dl['lfColor'] == 'rgb(27, 32, 43)',
              dl['lfBg'][:50] + '…')
        check('B 歌词全屏播放键 ≥56px', dl['lfW'] >= 56, '%dpx' % dl['lfW'])
        pg.screenshot(path=os.path.join(ROOT, 'tools/shot-milky-lyric-mobile.png'))
        check('B 无 JS 运行时错误', not errs and not errs2, errs[:1] + errs2[:1])
        ctx.close(); ctx2.close()

        # ============ C 窄屏布局回归 ============
        print('\n== C 窄屏布局回归 ==')
        for label, w, h in [('360x640', 360, 640), ('320x568', 320, 568)]:
            ctx = br.new_context(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
            pg = ctx.new_page()
            pg.goto(BASE + '/')
            pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
            pg.reload()
            pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
            pg.goto(BASE + '/#/tracks')
            pg.wait_for_selector('table.tracks tbody tr', timeout=20000)
            pg.tap('table.tracks tbody tr')
            pg.wait_for_selector('body.has-player', timeout=15000)
            pg.wait_for_timeout(700)
            d = pg.evaluate(PLAY_PROBE)
            check('C %s 播放键 ≥42px 正圆' % label, d['w'] == d['h'] and d['w'] >= 42, '%dx%d' % (d['w'], d['h']))
            check('C %s 底栏不出屏 / 无横向溢出' % label, 0 < d['barBottom'] <= d['vh'] + 1 and d['overflow'] <= 0,
                  'bar=%d/%d ovf=%d' % (d['barBottom'], d['vh'], d['overflow']))
            check('C %s 乳白配色生效' % label, 'radial-gradient' in d['bgImage'] and '79, 140, 255' not in d['shadow'], d['bgImage'][:48] + '…')
            ctx.close()
        br.close()
    print('\n== %d passed, %d failed ==' % (P, F))
    if FAILED_SEL:
        print('未匹配到的样点:', FAILED_SEL)
    sys.exit(1 if F else 0)
finally:
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    r = urllib.request.Request(BASE + '/admin/login', method='POST')
    r.add_header('Content-Type', 'application/json')
    with op.open(r, json.dumps({'password': 'REDACTED'}).encode(), timeout=30) as x:
        at = json.loads(x.read().decode())['token']
    r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
    r.add_header('X-Admin-Token', at)
    try:
        with op.open(r, timeout=30) as x: print('临时账号已清理:', x.status)
    except Exception as e:
        print('清理失败:', e)
