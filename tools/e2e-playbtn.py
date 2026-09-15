#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定向验证：播放/暂停按钮毛玻璃改造（带真实曲目）。
断言：按钮不再是纯白实心块 + 毛玻璃属性生效 + 底栏各视口布局未被影响。
"""
import json, os, random, shutil, string, sys, time, urllib.request, urllib.error

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西/01 可爱女人.mp3'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'sbtn' + RND, 'Btn' + RND + '!9'
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

PROBE = """() => {
  const b = document.getElementById('btn-play');
  const cs = getComputedStyle(b);
  const lf = document.getElementById('lf-play');
  const lcs = getComputedStyle(lf);
  const r = b.getBoundingClientRect();
  const bar = document.getElementById('player').getBoundingClientRect();
  const meta = document.querySelector('.np-meta');
  const cov = document.querySelector('.np-cover');
  const love = document.getElementById('np-love').getBoundingClientRect();
  const dl = document.getElementById('np-download').getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    bgColor: cs.backgroundColor, bgImage: cs.backgroundImage,
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
    color: cs.color, shadow: cs.boxShadow,
    border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    radius: cs.borderTopLeftRadius,
    iconFilter: getComputedStyle(document.querySelector('#btn-play svg')).filter,
    lfW: Math.round(lf.getBoundingClientRect().width),
    lfBgColor: lcs.backgroundColor, lfBgImage: lcs.backgroundImage,
    lfBackdrop: lcs.backdropFilter || lcs.webkitBackdropFilter || '',
    barBottom: Math.round(bar.bottom), vh: window.innerHeight,
    metaW: meta ? Math.round(meta.getBoundingClientRect().width) : 0,
    covW: cov ? Math.round(cov.getBoundingClientRect().width) : 0,
    loveVisible: love.width > 0 && love.height > 0,
    dlVisible: dl.width > 0 && dl.height > 0,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}"""

ONLY = os.environ.get('ONLY', '')
VIEWS = [
    ('1280x800 桌面', 1280, 800, {'cover': None, 'meta': 0}),
    ('844x390 横屏', 844, 390, {'cover': None, 'meta': 150, 'needActs': True}),
    ('768x1024 平板', 768, 1024, {'cover': None, 'meta': 0}),
    ('414x896 大屏手机', 414, 896, {'cover': 36, 'meta': 80, 'needActs': True}),
    ('390x844 iPhone14', 390, 844, {'cover': 36, 'meta': 80, 'needActs': True}),
    ('360x640 小安卓', 360, 640, {'cover': 32, 'meta': 74, 'needActs': True}),
    ('320x568 窄屏', 320, 568, {'cover': 32, 'meta': 38, 'needActs': True}),
]
if ONLY:
    VIEWS = [v for v in VIEWS if ONLY in v[0]]

try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for label, w, h, exp in VIEWS:
            print('\n== %s ==' % label)
            ctx = b.new_context(viewport={'width': w, 'height': h})
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(BASE + '/')
            pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
            pg.reload()
            pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
            pg.goto(BASE + '/#/tracks')
            pg.wait_for_selector('table.tracks tbody tr', timeout=20000)
            pg.wait_for_timeout(500)
            pg.evaluate("() => document.querySelector('table.tracks tbody tr').click()")
            pg.wait_for_selector('body.has-player', timeout=15000)
            pg.wait_for_timeout(800)
            pg.mouse.move(4, 4)
            d = pg.evaluate(PROBE)
            # —— 毛玻璃本体 ——
            check('%s 按钮不再是纯白实心块' % label, d['bgColor'] in ('rgba(0, 0, 0, 0)', 'transparent'), 'background-color=%s' % d['bgColor'])
            check('%s 玻璃层（radial + accent 渐变）' % label,
                  'radial-gradient' in d['bgImage'] and 'linear-gradient' in d['bgImage'], d['bgImage'][:58] + '…')
            check('%s backdrop 模糊生效' % label, 'blur' in d['backdrop'] and 'saturate' in d['backdrop'], d['backdrop'])
            check('%s 图标为近白 + 有投影' % label, d['color'].startswith('rgb(255, 255, 255)') and 'drop-shadow' in d['iconFilter'],
                  '%s / %s' % (d['color'], d['iconFilter']))
            check('%s 1px 高光描边 + 外发光' % label, d['border'].startswith('1px') and 'rgba(255, 255, 255, 0.28)' in d['border'] and 'rgba(79, 140, 255' in d['shadow'],
                  '%s / shadow ok' % d['border'])
            check('%s 仍是正圆且尺寸 ≥42px（窄屏下限）' % label, d['w'] == d['h'] and d['w'] >= 42 and d['radius'] == '50%', '%dx%d r=%s' % (d['w'], d['h'], d['radius']))
            # —— 歌词页同款按钮 ——
            check('%s 歌词页按钮同款玻璃' % label,
                  'radial-gradient' in d['lfBgImage'] and 'blur' in d['lfBackdrop'] and d['lfBgColor'] in ('rgba(0, 0, 0, 0)', 'transparent'),
                  '%dx%s blur=%s' % (d['lfW'], d['lfW'], d['lfBackdrop'][:22]))
            # —— 布局回归 ——
            check('%s 底栏不出屏' % label, d['barBottom'] <= d['vh'] + 1 and d['barBottom'] > 0, '%d/%d' % (d['barBottom'], d['vh']))
            check('%s 无横向溢出' % label, d['docOverflow'] <= 0, 'overflow=%d' % d['docOverflow'])
            if exp['cover']:
                check('%s 封面已压缩 ≤%dpx' % (label, exp['cover']), 0 < d['covW'] <= exp['cover'], 'cover=%d' % d['covW'])
            if exp['meta']:
                check('%s 歌名区宽 ≥%dpx' % (label, exp['meta']), d['metaW'] >= exp['meta'], 'meta=%d' % d['metaW'])
            if exp.get('needActs'):
                check('%s 保留收藏/下载入口' % label, d['loveVisible'] and d['dlVisible'], 'love=%s dl=%s' % (d['loveVisible'], d['dlVisible']))
            # —— 交互：点击播放/暂停图标仍正常切换 ——
            before = pg.eval_on_selector('#btn-play', 'e => e.querySelector("svg").innerHTML.length')
            pg.click('#btn-play')
            pg.wait_for_timeout(500)
            paused = pg.eval_on_selector('#btn-play', 'e => e.querySelector("svg").innerHTML.length')
            check('%s 点击后图标切换（播放↔暂停）' % label, before != paused, 'svg %d -> %d' % (before, paused))
            check('%s 无 JS 运行时错误' % label, not errs, errs[:1])
            ctx.close()
        b.close()
    print('\n== %d passed, %d failed ==' % (P, F))
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
    except urllib.error.HTTPError as e:
        print('清理失败:', e.code)
