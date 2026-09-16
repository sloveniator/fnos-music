#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""定向验证：播放/暂停按钮配色（带真实曲目）。
断言：底栏（#btn-play）玻璃质感 + 亮白图标 + 极淡 accent 光晕环；
      歌词全屏（#lf-play）仍为乳白实心（那是上一次主人点名要的，本轮没动）；
      底栏各视口布局未被影响。
"""
import json, os, random, shutil, string, sys, time, urllib.request, urllib.error
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

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
    glowLayers: ((cs.boxShadow.match(/rgba?\([^)]*\)/g) || [])
                 .filter(x => /150, 188, 255|79, 140, 255/.test(x))).length,
    hardRing: /0px 0px 0px/.test(cs.boxShadow),
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
            # —— 底栏播放键：决定链 ①乳白实心 → ②玻璃按键（与其它图标同族）
            #    → ③2026-09-15「圆圈边缘太生硬，做扩散美化」：去掉 1px 硬描边与 0 0 0 4px 实心环，
            #      改成由近及远多层递减的外扩散。尺寸没动（46px，窄屏 42px）。
            check('%s 玻璃底：径向化开的半透明白（不再是乳白实心）' % label,
                  'radial-gradient' in d['bgImage'] and '255, 253, 249' not in d['bgImage'],
                  d['bgImage'][:58] + '…')
            check('%s 边缘柔化：没有 1px 硬描边' % label, d['border'].startswith('0px'), d['border'])
            check('%s 边缘柔化：没有 0 0 0 Npx 实心环' % label, not d['hardRing'], d['shadow'][:52])
            check('%s 边缘柔化：≥3 层由近及远递减的 accent 扩散' % label, d['glowLayers'] >= 3,
                  'layers=%s' % d['glowLayers'])
            check('%s 保留柔和暗投影' % label, 'rgba(2, 5, 12' in d['shadow'], d['shadow'][:52])
            check('%s 图标亮白 + 投影（深底上对比稳）' % label,
                  d['color'] == 'rgb(241, 245, 255)' and 'drop-shadow' in d['iconFilter'],
                  '%s / %s' % (d['color'], d['iconFilter']))
            check('%s 仍是正圆且尺寸 ≥42px（窄屏下限）' % label, d['w'] == d['h'] and d['w'] >= 42 and d['radius'] == '50%', '%dx%d r=%s' % (d['w'], d['h'], d['radius']))
            # —— 歌词页按钮：仍是乳白（本轮只改了底栏那一个） ——
            check('%s 歌词页按钮仍是乳白' % label,
                  'radial-gradient' in d['lfBgImage'] and '255, 253, 249' in d['lfBgImage'],
                  '%dpx %s' % (d['lfW'], d['lfBgImage'][:44] + '…'))
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
    with op.open(r, json.dumps({'password': _ADMIN_PASS}).encode(), timeout=30) as x:
        at = json.loads(x.read().decode())['token']
    r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
    r.add_header('X-Admin-Token', at)
    try:
        with op.open(r, timeout=30) as x: print('临时账号已清理:', x.status)
    except urllib.error.HTTPError as e:
        print('清理失败:', e.code)
