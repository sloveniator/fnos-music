#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-17 主人报的 App 内两处播放条问题 —— 取证脚本（只读测量 + 截图，不改代码）。

主人原话：
  ①「缩小版的播放导航，顶部显示不全」
  ②「全屏播放，进度条无法滑动」

本脚本要做的事：
  A. 以手机尺寸 390×844 + **安卓壳注入的安全区**（壳会把 --safe-* 内联写到
     documentElement；浏览器里默认是 env()=0，不复现就看不到壳里的真相）
     测量底栏胶囊里每个子元素相对胶囊盒的位置 —— 谁越界谁就是「显示不全」的元凶。
  B. 在歌词全屏页里用**真触摸事件**（CDP Input.dispatchTouchEvent）拖 #lf-seek，
     同时数 pointerdown/move/up/cancel/click 的到达次数：
       - 若只有 click 到达 → 该轴根本没实现拖动（代码里只挂了 click）
       - 若 pointerdown 有、pointercancel 跟着来 → 手势被浏览器抢走（缺 touch-action）
  C. 对照组：#np-seek（窄屏顶边那条线）已知可拖，用同样方式拖一遍确认脚本本身有效。

用法：python3 tools/diag-app-player.py        （BASE 可用 GS_BASE 覆盖）
"""
import json, os, random, shutil, string, sys, time, urllib.request, wave

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
WAV = '00 长轨静音.wav'
OUT = os.path.join(ROOT, 'tools')
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'diagpl' + RND, 'Dgp' + RND + '!9'
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def ensure_fixture():
    os.makedirs(FIX, exist_ok=True)
    p = os.path.join(FIX, WAV)
    if os.path.exists(p) and os.path.getsize(p) > 100000:
        return p
    with wave.open(p, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b'\x00\x00' * 44100 * 180)
    return p


# 壳注入安全区的方式：documentElement 内联 --safe-*
INSET_JS = """(insets) => {
  const s = document.documentElement.style;
  s.setProperty('--safe-top', insets.top + 'px');
  s.setProperty('--safe-bottom', insets.bottom + 'px');
  s.setProperty('--safe-left', insets.left + 'px');
  s.setProperty('--safe-right', insets.right + 'px');
}"""

SNAP = """() => {
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1),
            t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), h: +r.height.toFixed(1) }; };
  const cs = (s) => { const e = q(s); return e ? getComputedStyle(e) : null; };
  const bar = q('#player');
  const br = bar ? bar.getBoundingClientRect() : null;
  const bs = bar ? getComputedStyle(bar) : null;
  const inner = (patch) => {   // 子元素相对胶囊盒的越界量
    const e = q(patch); if (!e || !br) return null;
    const r = e.getBoundingClientRect();
    return { t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), h: +r.height.toFixed(1),
             over: +(r.bottom - br.bottom).toFixed(1), under: +(br.top - r.top).toFixed(1) };
  };
  const a = window.__player ? window.__player.audio : null;
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    safe: { top: getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
            bottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim() },
    playerH: cs(':root').getPropertyValue('--player-h').trim(),
    playerLift: cs(':root').getPropertyValue('--player-lift').trim(),
    bar: R('#player'), barBottom: bs ? bs.bottom : null, barH: bs ? bs.height : null,
    barOverflow: bs ? bs.overflow : null, barAlign: bs ? bs.alignItems : null,
    barRows: bs ? bs.gridTemplateRows : null, barCols: bs ? bs.gridTemplateColumns : null,
    barPad: bs ? bs.padding : null,
    np: inner('.np'), npArt: inner('.np-art'), cover: inner('.np-cover'), meta: inner('.np-meta'),
    name: inner('.np-name'), singer: inner('.np-singer'), center: inner('.center'),
    ctrls: inner('.ctrls'), play: inner('#btn-play'), love: inner('#np-love'),
    line: R('#np-progress'), hit: R('#np-seek'), hitH: cs('#np-seek').height,
    hitDisp: cs('#np-seek').display,
    lfHidden: q('#lyric-full').hidden,
    lfSeek: R('#lf-seek'), lfSeekH: cs('#lf-seek').height, lfSeekRow: R('.lf-ctrls .lf-seek'),
    lfCtrls: R('.lf-ctrls'), lfHead: R('.lf-head'),
    lfFillW: q('#lf-seek-fill') ? q('#lf-seek-fill').style.width : null,
    npFillW: q('#np-progress') ? q('#np-progress').style.width : null,
    t: a ? +a.currentTime.toFixed(3) : -1, d: a ? +(a.duration || 0).toFixed(3) : 0,
    paused: a ? a.paused : null, name_: window.__player && window.__player.cur ? window.__player.cur.name : '',
  };
}"""

TOUCH_DRAG = """(sel) => {
  window.__diag = {};
  const e = document.querySelector(sel);
  ['pointerdown','pointermove','pointerup','pointercancel','click','touchstart','touchmove','touchend']
    .forEach((t) => e.addEventListener(t, () => { window.__diag[t] = (window.__diag[t] || 0) + 1; }));
  return true;
}"""


def play_long(pg):
    pg.locator('#view button:has-text("播放全部")').first.click()
    pg.wait_for_timeout(800)
    pg.evaluate("""() => {
      const pl = window.__player;
      const i = pl.queue.findIndex(t => /长轨/.test(t.name));
      if (i >= 0 && pl.index !== i) pl.play(pl.queue, i);
    }""")
    pg.evaluate("() => { const a = window.__player.audio; if (a && a.paused) a.play().catch(() => {}); }")
    for _ in range(40):
        s = pg.evaluate(SNAP)
        if s['d'] > 5 and not s['paused'] and '长轨' in s['name_']:
            return s
        time.sleep(0.25)
    return pg.evaluate(SNAP)


def touch_drag(ctx, pg, x1, y1, x2, y2, steps=12, hold=0.35):
    cdp = ctx.new_cdp_session(pg)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x1, 'y': y1}]})
    time.sleep(0.12)
    for i in range(1, steps + 1):
        x = x1 + (x2 - x1) * i / steps
        y = y1 + (y2 - y1) * i / steps
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y}]})
        time.sleep(0.03)
    time.sleep(hold)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    time.sleep(0.35)


def mouse_drag(pg, x1, y1, x2, y2, steps=12, hold=0.3):
    pg.mouse.move(x1, y1)
    pg.mouse.down()
    for i in range(1, steps + 1):
        x = x1 + (x2 - x1) * i / steps
        pg.mouse.move(x, y1 + (y2 - y1) * i / steps)
        time.sleep(0.03)
    time.sleep(hold)
    pg.mouse.up()
    time.sleep(0.3)


def report(tag, s):
    print('--- %s ---' % tag)
    print('  视口 %(vw)sx%(vh)s 安全区 top=%(t)s bottom=%(b)s' % {
        'vw': s['vw'], 'vh': s['vh'], 't': s['safe']['top'], 'b': s['safe']['bottom']})
    print('  --player-h=%s  --player-lift=%s' % (s['playerH'], s['playerLift']))
    print('  胶囊 #player: top=%(t)s bottom=%(b)s h=%(h)s | css height=%(ch)s bottom=%(cb)s'
          % {'t': s['bar']['t'], 'b': s['bar']['b'], 'h': s['bar']['h'], 'ch': s['barH'], 'cb': s['barBottom']})
    print('  overflow=%s align-items=%s rows=%s cols=%s padding=%s'
          % (s['barOverflow'], s['barAlign'], s['barRows'], s['barCols'], s['barPad']))
    for key, label in [('np', '.np 信息区'), ('npArt', '.np-art 封面盒'), ('cover', '.np-cover'),
                       ('meta', '.np-meta'), ('name', '.np-name'), ('singer', '.np-singer'),
                       ('center', '.center'), ('ctrls', '.ctrls'), ('play', '#btn-play'), ('love', '#np-love')]:
        v = s[key]
        if v:
            print('    %-14s top=%-7s bottom=%-7s h=%-6s 越出胶囊下沿=%-7s 高于胶囊上沿=%s'
                  % (label, v['t'], v['b'], v['h'], v['over'], v['under']))
    print('  进度线 #np-progress: %s  命中区 #np-seek: %s (%s, h=%s)'
          % (s['line'], s['hit'], s['hitDisp'], s['hitH']))
    print('  全屏 #lf-seek: %s h=%s | .lf-ctrls: %s | .lf-head: %s'
          % (s['lfSeek'], s['lfSeekH'], s['lfCtrls'], s['lfHead']))


ensure_fixture()
tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
shutil.copy(os.path.join(FIX, WAV), os.path.join(dd, WAV))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 1:
        break
    time.sleep(1)
print('临时用户 %s，曲目 %s' % (USER, get('/api/stats', tok)['data'].get('tracks')))

from playwright.sync_api import sync_playwright

CASES = [
    ('手势导航（top 24 / bottom 24）', {'top': 24, 'bottom': 24, 'left': 0, 'right': 0}),
    ('三键导航（top 32 / bottom 48）', {'top': 32, 'bottom': 48, 'left': 0, 'right': 0}),
    ('浏览器（无安全区，对照组）', {'top': 0, 'bottom': 0, 'left': 0, 'right': 0}),
]

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for tag, ins in CASES:
            print('\n================ %s ================' % tag)
            ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                                device_scale_factor=3,
                                user_agent='Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 '
                                           '(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 GusiMusicApp/1.0.30')
            pg = ctx.new_page()
            pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
            pg.add_init_script("""() => {
              const apply = () => { const s = document.documentElement.style;
                s.setProperty('--safe-top', '%dpx'); s.setProperty('--safe-bottom', '%dpx');
                s.setProperty('--safe-left', '%dpx'); s.setProperty('--safe-right', '%dpx'); };
              apply();
              document.addEventListener('DOMContentLoaded', apply);
            }""" % (ins['top'], ins['bottom'], ins['left'], ins['right']))
            pg.goto(BASE + '/#/tracks')
            pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
            pg.evaluate(INSET_JS, ins)
            s = play_long(pg)
            print('在放：%s  d=%.1fs paused=%s' % (s['name_'], s['d'], s['paused']))
            report('窄屏底栏几何', s)

            # 截图：底栏区域（含下方安全区）
            pg.screenshot(path=os.path.join(OUT, 'diag-bar-%s.png' % ins['bottom']),
                          clip={'x': 0, 'y': 844 - 260, 'width': 390, 'height': 260})

            # C 对照组：拖 #np-seek（已知可拖）
            hit = s['hit']
            pg.evaluate(TOUCH_DRAG, '#np-seek')
            t0 = pg.evaluate(SNAP)['t']
            touch_drag(ctx, pg, hit['l'] + hit['w'] * 0.2, s['bar']['t'] + 8,
                       hit['l'] + hit['w'] * 0.7, s['bar']['t'] + 8)
            s2 = pg.evaluate(SNAP)
            print('  [对照组] 触摸拖 #np-seek 20%%→70%%：diag=%s currentTime %.2fs→%.2fs（比值 %.0f%%→%.0f%%）'
                  % (pg.evaluate('window.__diag'), t0, s2['t'],
                     t0 / s2['d'] * 100 if s2['d'] else 0, s2['t'] / s2['d'] * 100 if s2['d'] else 0))

            # B 被测：全屏进度轴
            pg.evaluate("() => { document.querySelector('.np').click(); }")
            pg.wait_for_timeout(600)
            sf = pg.evaluate(SNAP)
            print('  进了全屏？lyric-full hidden=%s  #lf-seek=%s h=%s' % (sf['lfHidden'], sf['lfSeek'], sf['lfSeekH']))
            pg.screenshot(path=os.path.join(OUT, 'diag-full-%s.png' % ins['bottom']))
            ls = sf['lfSeek']
            if ls and ls['w'] > 10:
                y = ls['t'] + ls['h'] / 2
                x1 = ls['l'] + ls['w'] * 0.2
                x2 = ls['l'] + ls['w'] * 0.7
                # B1 真触摸拖动
                pg.evaluate(TOUCH_DRAG, '#lf-seek')
                t0 = pg.evaluate(SNAP)['t']
                touch_drag(ctx, pg, x1, y, x2, y)
                s3 = pg.evaluate(SNAP)
                diag_t = pg.evaluate('window.__diag')
                print('  [触摸拖 #lf-seek] 事件计数=%s  currentTime %.2fs→%.2fs（%.0f%%→%.0f%%）'
                      % (diag_t, t0, s3['t'], t0 / s3['d'] * 100 if s3['d'] else 0,
                         s3['t'] / s3['d'] * 100 if s3['d'] else 0))
                print('    拖动中 fill 宽度=%s（松手后=%s）' % (s3['lfFillW'], pg.evaluate(SNAP)['lfFillW']))
                # B2 鼠标拖动
                pg.evaluate(TOUCH_DRAG, '#lf-seek')
                t0 = pg.evaluate(SNAP)['t']
                mouse_drag(pg, x1, y, x2, y)
                s4 = pg.evaluate(SNAP)
                print('  [鼠标拖 #lf-seek] 事件计数=%s  currentTime %.2fs→%.2fs（%.0f%%→%.0f%%）'
                      % (pg.evaluate('window.__diag'), t0, s4['t'],
                         t0 / s4['d'] * 100 if s4['d'] else 0, s4['t'] / s4['d'] * 100 if s4['d'] else 0))
                # B3 单点（tap）基线：以前只实现 click，点按本应有效
                pg.evaluate(TOUCH_DRAG, '#lf-seek')
                t0 = pg.evaluate(SNAP)['t']
                pg.touchscreen.tap(ls['l'] + ls['w'] * 0.8, y)
                time.sleep(0.4)
                s5 = pg.evaluate(SNAP)
                print('  [触摸点按 #lf-seek 80%%] 事件计数=%s  currentTime %.2fs→%.2fs（%.0f%%)'
                      % (pg.evaluate('window.__diag'), t0, s5['t'],
                         s5['t'] / s5['d'] * 100 if s5['d'] else 0))
            ctx.close()
        b.close()
    print('\n截图：tools/diag-bar-*.png（底栏 260px 区域）、tools/diag-full-*.png（全屏页）')
finally:
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    ap = os.environ.get('GS_ADMIN_PASSWORD', '')
    if not ap:
        print('未设 GS_ADMIN_PASSWORD，临时账号 %s 未清理（曲库目录已删）' % USER)
    else:
        try:
            r = urllib.request.Request(BASE + '/admin/login', method='POST')
            r.add_header('Content-Type', 'application/json')
            with op.open(r, json.dumps({'password': ap}).encode(), timeout=30) as x:
                at = json.loads(x.read().decode())['token']
            r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
            r.add_header('X-Admin-Token', at)
            with op.open(r, timeout=30) as x:
                print('临时账号 %s 已清理：HTTP %s' % (USER, x.status))
        except Exception as e:
            print('清理 %s 失败：%s' % (USER, e))
