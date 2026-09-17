#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-17 主人反馈：「播放导航缩小时，歌曲进度条用不了」的定向验证。

背景（两处一起修）：
  ① 窄屏（≤900px）底栏里 .seek-row 是藏着的 —— 底栏只靠贴胶囊顶边那条 2.5px 进度线
     给反馈，而那条线原先**点不动也拖不动**，等于缩小的播放导航里根本没有进度入口。
     现在在**同一条线上**盖了一层透明命中区 #np-seek（宽高见 CSS），
     按住即定位、拖动跟手、松手才落 currentTime；视觉零变化，拖动中才加粗到 4px + 圆点。
  ② 连带 bug：≤900px 的 `.seek-row { display: none }` 是无前缀选择器，
     而歌词全屏的 #lf-seek 的 class 里也带 seek-row —— 手机上进全屏连进度轴都不显示。
     现在只藏底栏那一条（`#player .seek-row`）。

验证项：
  M 窄屏 390×844
    M1 顶边进度线可拖（拖到 65% → currentTime 落在 58~72%）
    M2 按住期间 tick 不回写（停 800ms，线上百分比仍是手指位置，而音频自己在走）
    M3 拖动反馈：拖动中 #player 带 .seeking、线加粗 4px；松手后复原 2.5px
    M4 点按也能定位（30%）
    M5 线本身没变形：不拖时 2.5px / 贴胶囊顶边 / 与全屏 fill 同源百分比
    M6 不抢信息区手势：点封面中心仍打开歌词全屏，currentTime 不跳
    M7 全屏进度轴回归显示（.lf-ctrls .lf-seek 是 flex 且有高度）且点 70% 能跳
  D 桌面 1280×720
    D1 #np-seek 隐藏（桌面本来就有完整 seek 轴）
    D2 #player .seek-row 仍显示
    D3 #lf-seek 仍显示

用法：python3 tools/e2e-npseek.py        （BASE 可用 GS_BASE 覆盖）
"""
import json, os, random, shutil, string, sys, time, urllib.error, urllib.request, wave

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
WAV = '00 长轨静音.wav'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'npseek' + RND, 'Npk' + RND + '!9'
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
    """长轨夹具缺失就地生成：180s / 44.1kHz / 单声道静音 wav（够长才拖得动进度）"""
    os.makedirs(FIX, exist_ok=True)
    p = os.path.join(FIX, WAV)
    if os.path.exists(p) and os.path.getsize(p) > 100000:
        return p
    with wave.open(p, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b'\x00\x00' * 44100 * 180)
    return p


SNAP = """() => {
  const q = (s) => document.querySelector(s);
  const R = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect();
    return {l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1),
            t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), h: +r.height.toFixed(1)}; };
  const cs = (s) => { const e = q(s); return e ? getComputedStyle(e) : null; };
  const pct = (s) => { const e = q(s); return e ? +(parseFloat(e.style.width) || 0).toFixed(2) : null; };
  const bar = q('#player');
  const a = window.__player ? window.__player.audio : null;
  const lrow = cs('.lf-ctrls .lf-seek');
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    bar: R('#player'), cover: R('#np-cover'), np: R('.np'),
    hit: R('#np-seek'), hitDisplay: cs('#np-seek').display, hitH: cs('#np-seek').height,
    line: R('#np-progress'), lineH: cs('#np-progress').height,
    lineTop: +cs('#np-progress').top.replace('px', ''),
    npPct: pct('#np-progress'), seekPct: pct('#seek-fill'), lfPct: pct('#lf-seek-fill'),
    barSeekRow: cs('#player .seek-row').display,
    lfSeekRow: lrow ? lrow.display : null, lfSeekRowBox: R('.lf-ctrls .lf-seek'),
    lfSeek: R('#lf-seek'), lfFill: R('#lf-seek-fill'),
    seeking: bar ? bar.classList.contains('seeking') : null,
    lfHidden: q('#lyric-full').hidden,
    t: a ? +a.currentTime.toFixed(3) : -1, d: a ? +(a.duration || 0).toFixed(3) : 0,
    paused: a ? a.paused : null,
    name: window.__player && window.__player.cur ? window.__player.cur.name : '',
  };
}"""


def ratio(s):
    return (s['t'] / s['d']) if s['d'] else -1


def play_long(pg):
    """在全部歌曲页点「播放全部」，并确保当前曲是那条长轨"""
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


tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
shutil.copy(ensure_fixture(), os.path.join(dd, WAV))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 1:
        break
    time.sleep(1)
print('临时用户 %s，曲目 %s，夹具 %s' % (USER, get('/api/stats', tok)['data'].get('tracks'), WAV))

from playwright.sync_api import sync_playwright

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        # ---------------- M 窄屏 ----------------
        print('\n== M 窄屏 390×844：缩小的播放导航里拖进度 ==')
        ctx = b.new_context(viewport={'width': 390, 'height': 844})
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        s0 = play_long(pg)
        check('M0 长轨在放（duration>5s，非暂停）', s0['d'] > 5 and not s0['paused'],
              '%s d=%.1fs paused=%s' % (s0['name'], s0['d'], s0['paused']))

        # M5 线本身没变形
        check('M5a 不拖时线仍是 2.5px 贴胶囊顶边',
              s0['lineH'] == '2.5px' and s0['hitDisplay'] == 'block'
              and abs(s0['line']['t'] - s0['bar']['t']) <= 1.5 and s0['lineTop'] == 0,
              'lineH=%s top=%.1f barTop=%.1f' % (s0['lineH'], s0['line']['t'], s0['bar']['t']))
        check('M5b 命中区与线同宽同起点（百分比天然同源）',
              abs(s0['hit']['w'] - s0['bar']['w']) <= 4 and abs(s0['hit']['t'] - s0['bar']['t']) <= 1.5,
              'hit w=%.1f bar w=%.1f' % (s0['hit']['w'], s0['bar']['w']))
        check('M5c 底栏仍不摆 seek 轴（设计没变）', s0['barSeekRow'] == 'none', s0['barSeekRow'])
        check('M5d 线上百分比与底栏 seek-fill 同源（同一 tick 写出的两处）',
              abs((s0['npPct'] or 0) - (s0['seekPct'] or 0)) <= 0.5 and abs((s0['npPct'] or 0) - ratio(s0) * 100) <= 3,
              'np=%s%% #seek-fill=%s%% 实际=%.1f%%' % (s0['npPct'], s0['seekPct'], ratio(s0) * 100))

        # M1/M2/M3 拖动
        bar, hit = s0['bar'], s0['hit']
        y = bar['t'] + 8                     # 命中区高 16px，取中间偏上
        x1 = hit['l'] + hit['w'] * 0.20
        x2 = hit['l'] + hit['w'] * 0.65
        pg.mouse.move(x1, y)
        pg.mouse.down()
        pg.wait_for_timeout(150)
        sd = pg.evaluate(SNAP)
        check('M3a 按下即进拖动态（#player.seeking + 线加粗 4px）',
              sd['seeking'] and sd['lineH'] == '4px', 'seeking=%s lineH=%s' % (sd['seeking'], sd['lineH']))
        check('M1a 按下即定位预览（20%±4）', abs((sd['npPct'] or 0) - 20) <= 4, 'np=%s%%' % sd['npPct'])
        t_hold0 = pg.evaluate("() => window.__player.audio.currentTime")
        pg.wait_for_timeout(800)
        sh_ = pg.evaluate(SNAP)
        check('M2 按住 800ms：音频自己在走，线仍停在手指位置（tick 不回写）',
              sh_['npPct'] is not None and abs(sh_['npPct'] - 20) <= 4
              and pg.evaluate("() => window.__player.audio.currentTime") - t_hold0 > 0.3,
              'np=%s%% 音频 %.2f→%.2f' % (sh_['npPct'], t_hold0,
                                          pg.evaluate("() => window.__player.audio.currentTime")))
        pg.mouse.move(x2, y)
        pg.wait_for_timeout(200)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        s1 = pg.evaluate(SNAP)
        check('M1b 松手落到 65%（currentTime 58~72%）', 0.58 <= ratio(s1) <= 0.72,
              't=%.1fs d=%.1fs = %.1f%%' % (s1['t'], s1['d'], ratio(s1) * 100))
        check('M3b 松手后拖动态复原（无线加粗、无 .seeking）',
              (not s1['seeking']) and s1['lineH'] == '2.5px',
              'seeking=%s lineH=%s' % (s1['seeking'], s1['lineH']))
        check('M1c 线宽跟着落地位置走', abs((s1['npPct'] or 0) - 65) <= 6, 'np=%s%%' % s1['npPct'])

        # M4 点按
        x3 = hit['l'] + hit['w'] * 0.30
        pg.mouse.click(x3, y)
        pg.wait_for_timeout(500)
        s2 = pg.evaluate(SNAP)
        check('M4 点按 30% 也能定位（25~37%）', 0.25 <= ratio(s2) <= 0.37,
              '= %.1f%%' % (ratio(s2) * 100))

        # M6 不抢信息区手势
        r_before = ratio(pg.evaluate(SNAP))
        pg.mouse.click(s0['cover']['l'] + s0['cover']['w'] / 2, s0['cover']['t'] + s0['cover']['h'] / 2)
        pg.wait_for_timeout(400)
        s3 = pg.evaluate(SNAP)
        check('M6 点封面中心仍打开歌词全屏，且 currentTime 不跳',
              (not s3['lfHidden']) and abs(ratio(s3) - r_before) < 0.03,
              'lfHidden=%s %.1f%% -> %.1f%%' % (s3['lfHidden'], r_before * 100, ratio(s3) * 100))

        # M7 全屏进度轴
        s4 = pg.evaluate(SNAP)
        check('M7a 全屏进度轴回归显示（.lf-ctrls .lf-seek 是 flex 且有高度）',
              s4['lfSeekRow'] == 'flex' and s4['lfSeekRowBox'] and s4['lfSeekRowBox']['h'] > 0,
              'display=%s h=%s' % (s4['lfSeekRow'], s4['lfSeekRowBox'] and s4['lfSeekRowBox']['h']))
        check('M7c 全屏进度轴命中区撑到手指能点（≥28px，线本身仍 5px 高）',
              s4['lfSeek'] and s4['lfSeek']['h'] >= 28, '#lf-seek h=%s' % (s4['lfSeek'] and s4['lfSeek']['h']))
        check('M7d 撑高命中区没有压扁填充条（fill 仍 5px、有宽度）',
              s4['lfFill'] and abs(s4['lfFill']['h'] - 5) <= 1 and s4['lfFill']['w'] > 20,
              'fill %sx%s' % (s4['lfFill'] and s4['lfFill']['w'], s4['lfFill'] and s4['lfFill']['h']))
        rect = pg.evaluate("""() => { const r = document.getElementById('lf-seek').getBoundingClientRect();
          return {x: r.left + r.width * 0.7, y: r.top + r.height / 2}; }""")
        pg.mouse.click(rect['x'], rect['y'])
        pg.wait_for_timeout(500)
        s5 = pg.evaluate(SNAP)
        check('M7b 全屏进度轴点 70% 能跳（62~80%）', 0.62 <= ratio(s5) <= 0.80, '= %.1f%%' % (ratio(s5) * 100))
        ctx.close()

        # ---------------- D 桌面 ----------------
        print('\n== D 桌面 1280×720：桌面行为不变 ==')
        ctx = b.new_context(viewport={'width': 1280, 'height': 720})
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        play_long(pg)
        d = pg.evaluate(SNAP)
        check('D1 桌面上 #np-seek 隐藏（不抢底栏点击）', d['hitDisplay'] == 'none', d['hitDisplay'])
        check('D2 桌面底栏 seek 轴仍在', d['barSeekRow'] == 'flex', d['barSeekRow'])
        check('D3 桌面全屏进度轴仍在', d['lfSeekRow'] == 'flex', str(d['lfSeekRow']))
        ctx.close()
        b.close()
    print('\n== %d passed, %d failed ==' % (P, F))
    sys.exit(1 if F else 0)
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
                print('临时账号已清理:', x.status)
        except urllib.error.HTTPError as e:
            print('清理失败:', e.code)
