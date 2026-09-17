#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-17 主人：「安卓 app 全屏播放，进度条无法滑动」的定向验证。

根因（本次修之前实测）：`#lf-seek` 只挂了 click —— 点一下能跳，按住拖完全没反应；
触摸下更糟，浏览器把手势判给页面滚动，只发两个 pointermove 就补一个 pointercancel：
    pointerdown:1 pointermove:2 pointercancel:1 touchmove:11
现在三条进度轴（桌面 #seek / 窄屏顶边 #np-seek / 歌词全屏 #lf-seek）共用
`bindSeekAxis()`：pointerdown 里 preventDefault + setPointerCapture 把手势扣下来，
拖动中只画界面（tick 不回写被拖的轴），松手才落 currentTime。

验证项：
  T 触摸 390×844（安卓壳的真实输入形态）
    T1 触摸拖 #lf-seek 20%→70%：落在 70%（±6%）且 **没有 pointercancel**
    T2 拖动中按住不放：fill 停在手指位置，音频自己在走（tick 没把手拖回去）
    T3 拖动中轴加粗但命中区仍是 29px（手指不会跳）
    T4 松手后 tick 恢复回写：fill% ≈ currentTime/duration
    T5 点按也能跳（30%）
    T6 回归：#np-seek 触摸拖仍然正常（上一轮修的，不能被改坏）
  D 桌面 1280×720
    D1 鼠标拖 #seek 20%→80%：落在 80%（以前只有 click，拖了不跟手）
    D2 鼠标拖 #lf-seek：落在落点

用法：python3 tools/e2e-seekdrag.py        （BASE 可用 GS_BASE 覆盖）
"""
import json, os, random, shutil, string, sys, time, urllib.request, wave

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
WAV = '00 长轨静音.wav'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'seekdg' + RND, 'Sdg' + RND + '!9'
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


def ensure_fixture():
    os.makedirs(FIX, exist_ok=True)
    p = os.path.join(FIX, WAV)
    if os.path.exists(p) and os.path.getsize(p) > 100000:
        return p
    with wave.open(p, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b'\x00\x00' * 44100 * 180)
    return p


ARM = """(sel) => {
  const e = document.querySelector(sel);
  if (!e.__armed) {
    e.__armed = true;
    ['pointerdown','pointermove','pointerup','pointercancel','click']
      .forEach((t) => e.addEventListener(t, () => { window.__diag[t] = (window.__diag[t] || 0) + 1; }));
  }
  window.__diag = {};
  return true;
}"""

SNAP = """() => {
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
    return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1),
            t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), h: +r.height.toFixed(1) }; };
  const cs = (s) => { const e = q(s); return e ? getComputedStyle(e) : null; };
  const pct = (s) => { const e = q(s); return e ? +(parseFloat(e.style.width) || 0) : null; };
  const a = window.__player ? window.__player.audio : null;
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    lf: R('#lf-seek'), lfStyleH: cs('#lf-seek') ? cs('#lf-seek').height : null,
    lfPad: cs('#lf-seek') ? cs('#lf-seek').padding : null,
    lfFillPct: pct('#lf-seek-fill'), lfFillBox: R('#lf-seek-fill'),
    lfCurTxt: q('#lf-t-cur') ? q('#lf-t-cur').textContent : null,
    seek: R('#seek'), seekFillPct: pct('#seek-fill'), seekCurTxt: q('#t-cur') ? q('#t-cur').textContent : null,
    hit: R('#np-seek'), npPct: pct('#np-progress'), npBarH: cs('#np-progress') ? cs('#np-progress').height : null,
    bar: R('#player'), seeking: q('#player') ? q('#player').classList.contains('seeking') : null,
    lfHidden: q('#lyric-full').hidden,
    t: a ? +a.currentTime.toFixed(3) : -1, d: a ? +(a.duration || 0).toFixed(3) : 0,
    paused: a ? a.paused : null, name: window.__player && window.__player.cur ? window.__player.cur.name : '',
  };
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
        if s['d'] > 5 and not s['paused'] and '长轨' in s['name']:
            return s
        time.sleep(0.25)
    return pg.evaluate(SNAP)


def open_full(pg):
    pg.evaluate("() => { document.querySelector('.np').click(); }")
    pg.wait_for_timeout(400)


def touch_drag_hold(ctx, pg, x1, y1, x2, y2, steps=12, hold=0.0, release=True):
    """触摸拖动；hold>0 时在终点按住不放（用于验证拖动中 tick 不回写）。"""
    cdp = ctx.new_cdp_session(pg)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x1, 'y': y1}]})
    time.sleep(0.1)
    for i in range(1, steps + 1):
        x = x1 + (x2 - x1) * i / steps
        y = y1 + (y2 - y1) * i / steps
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y}]})
        time.sleep(0.03)
    if hold:
        time.sleep(hold)
    if release:
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        time.sleep(0.25)


def main():
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
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        # ---------------- T 触摸 ----------------
        print('\n== T 触摸 390×844：全屏进度轴可拖 ==')
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                            user_agent='Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 '
                                       '(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 GusiMusicApp/1.0.30')
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        s0 = play_long(pg)
        check('T0 长轨在放（duration>5s，非暂停）', s0['d'] > 5 and not s0['paused'],
              '%s d=%.1fs' % (s0['name'], s0['d']))

        # T6 回归：窄屏顶边那条线（上一轮修好的，不能被这次重构改坏）
        hit = s0['hit']
        pg.evaluate(ARM, '#np-seek')
        touch_drag_hold(ctx, pg, hit['l'] + hit['w'] * 0.2, s0['bar']['t'] + 8,
                        hit['l'] + hit['w'] * 0.7, s0['bar']['t'] + 8)
        s = pg.evaluate(SNAP); dg = pg.evaluate('window.__diag')
        check('T6a #np-seek 触摸拖到 70% 后 currentTime 落在 70%（±6%）',
              s['d'] and abs(s['t'] / s['d'] * 100 - 70) <= 6,
              'diag=%s 实际 %.0f%%' % (dg, s['t'] / s['d'] * 100))
        check('T6b #np-seek 拖动没被浏览器抢走（无 pointercancel）', not dg.get('pointercancel'), dg)

        open_full(pg)
        s = pg.evaluate(SNAP)
        check('T0b 进了歌词全屏且进度轴可见（29px 命中区）',
              (not s['lfHidden']) and s['lf'] and s['lf']['w'] > 100 and s['lfStyleH'] == '29px',
              'lf=%s h=%s' % (s['lf'], s['lfStyleH']))

        lf = s['lf']
        y = lf['t'] + lf['h'] / 2
        x1 = lf['l'] + lf['w'] * 0.2
        x2 = lf['l'] + lf['w'] * 0.7

        # T1 触摸拖动
        pg.evaluate(ARM, '#lf-seek')
        t0 = pg.evaluate(SNAP)['t']
        touch_drag_hold(ctx, pg, x1, y, x2, y)
        s1 = pg.evaluate(SNAP); dg = pg.evaluate('window.__diag')
        check('T1a 触摸拖 #lf-seek 20%→70%：currentTime 落在 70%（±6%）',
              s1['d'] and abs(s1['t'] / s1['d'] * 100 - 70) <= 6,
              '%.2fs→%.2fs（%.0f%%→%.0f%%）' % (t0, s1['t'], t0 / s1['d'] * 100, s1['t'] / s1['d'] * 100))
        check('T1b 拖动全程没被浏览器抢走（pointerdown>0 且 pointercancel=0）',
              dg.get('pointerdown') and not dg.get('pointercancel'), dg)
        check('T1c 拖动过程被真正处理（pointermove 到达 ≥5 次）', dg.get('pointermove', 0) >= 5, dg)

        # T2/T3 按住不放：fill 跟手、tick 不回写、命中区不变
        pg.evaluate(ARM, '#lf-seek')
        cdp = ctx.new_cdp_session(pg)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x1, 'y': y}]})
        time.sleep(0.08)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x2, 'y': y}]})
        time.sleep(0.1)
        sA = pg.evaluate(SNAP)
        time.sleep(0.9)
        sB = pg.evaluate(SNAP)
        check('T2a 按住不放时 fill 停在手指位置（70%±4）',
              sA['lfFillPct'] is not None and abs(sA['lfFillPct'] - 70) <= 4 and abs(sB['lfFillPct'] - 70) <= 4,
              'fill %s%% → %s%%' % (sA['lfFillPct'], sB['lfFillPct']))
        check('T2b 同一段按住期间音频自己在走（tick 活着，只是不回写这条轴）',
              sB['t'] - sA['t'] > 0.4, 't %.2f→%.2f' % (sA['t'], sB['t']))
        check('T2c 时间标签跟手（显示手指位置而不是播放位置）',
              sA['lfCurTxt'] and abs(int(sA['lfCurTxt'].split(':')[0]) * 60 + int(sA['lfCurTxt'].split(':')[1])
                                     - sA['d'] * 0.7) <= 6,
              'lf-t-cur=%s（手指=%.0fs 播放=%.0fs）' % (sA['lfCurTxt'], sA['d'] * 0.7, sA['t']))
        check('T3a 拖动中轴加粗（padding 12px→11px，露出 7px 线）', sA['lfPad'] == '11px 0px', sA['lfPad'])
        check('T3b 拖动中命中区高度不变（仍 29px，手指不会跳）', sA['lfStyleH'] == '29px', sA['lfStyleH'])
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        time.sleep(0.4)
        sC = pg.evaluate(SNAP)
        check('T3c 松手后轴复原（padding 12px / 29px）',
              sC['lfPad'] == '12px 0px' and sC['lfStyleH'] == '29px',
              'pad=%s h=%s' % (sC['lfPad'], sC['lfStyleH']))

        # T4 松手后 tick 恢复回写
        time.sleep(0.6)
        sD = pg.evaluate(SNAP)
        check('T4 松手后 tick 恢复回写（fill% ≈ currentTime/duration ±3）',
              abs(sD['lfFillPct'] - sD['t'] / sD['d'] * 100) <= 3,
              'fill=%s%% 实际=%.1f%%' % (sD['lfFillPct'], sD['t'] / sD['d'] * 100))

        # T5 点按也要能跳
        pg.evaluate(ARM, '#lf-seek')
        pg.touchscreen.tap(lf['l'] + lf['w'] * 0.3, y)
        time.sleep(0.4)
        sE = pg.evaluate(SNAP)
        check('T5 点按 30% 也能定位', abs(sE['t'] / sE['d'] * 100 - 30) <= 6,
              '%.0f%%' % (sE['t'] / sE['d'] * 100))
        ctx.close()

        # ---------------- D 桌面鼠标 ----------------
        print('\n== D 桌面 1280×720：鼠标拖也要跟手 ==')
        ctx = b.new_context(viewport={'width': 1280, 'height': 720})
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        s0 = play_long(pg)
        sk = s0['seek']
        check('D0 桌面底栏有完整 seek 轴', sk and sk['w'] > 200, '%s' % sk)
        y = sk['t'] + sk['h'] / 2
        x1 = sk['l'] + sk['w'] * 0.2
        x2 = sk['l'] + sk['w'] * 0.8
        pg.evaluate(ARM, '#seek')
        pg.mouse.move(x1, y); pg.mouse.down()
        for i in range(1, 13):
            pg.mouse.move(x1 + (x2 - x1) * i / 12, y); time.sleep(0.03)
        sMid = pg.evaluate(SNAP)
        pg.mouse.up(); time.sleep(0.3)
        s1 = pg.evaluate(SNAP); dg = pg.evaluate('window.__diag')
        check('D1a 鼠标按住拖时 #seek-fill 跟手（拖动中 fill≈80%）',
              abs(sMid['seekFillPct'] - 80) <= 6, '拖动中 fill=%s%%' % sMid['seekFillPct'])
        check('D1b 鼠标松手落在 80%（±6%）', abs(s1['t'] / s1['d'] * 100 - 80) <= 6,
              '%.2fs（%.0f%%）' % (s1['t'], s1['t'] / s1['d'] * 100))
        open_full(pg)
        sf = pg.evaluate(SNAP)
        lf2 = sf['lf']
        # 桌面端不显示歌词全屏（#lf-seek 宽高为 0），这条轴只在窄屏用；有宽度才测
        if lf2 and lf2['w'] > 10:
            y2 = lf2['t'] + lf2['h'] / 2
            pg.mouse.move(lf2['l'] + lf2['w'] * 0.25, y2); pg.mouse.down()
            for i in range(1, 13):
                pg.mouse.move(lf2['l'] + lf2['w'] * (0.25 + 0.5 * i / 12), y2); time.sleep(0.03)
            pg.mouse.up(); time.sleep(0.3)
            s2 = pg.evaluate(SNAP)
            check('D2 鼠标拖全屏轴落在 75%（±6%）', abs(s2['t'] / s2['d'] * 100 - 75) <= 6,
                  '%.0f%%' % (s2['t'] / s2['d'] * 100))
        else:
            print('  [SKIP] D2 桌面端不显示歌词全屏（#lf-seek 宽 %s），该轴只服务窄屏' % (lf2 and lf2['w']))
        ctx.close()
        b.close()

    print('\n== 结果：%d 通过 / %d 失败 ==' % (P, F))
    return 1 if F else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
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
