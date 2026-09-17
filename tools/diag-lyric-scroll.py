#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""歌词区滚动容器取证：到底谁在滚、能滚多少、当前行的 rect 落在哪。"""
import json, os, random, shutil, string, sys, time, urllib.request, wave

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
STEM = '00 歌词对齐'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'lyrdbg' + RND, 'Lyr' + RND + '!9'
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TRUTH = [(0.0, '前奏'), (12.5, '第一句歌词'), (15.35, '第二句歌词'),
         (62.0, '第三句歌词'), (80.75, '第四句歌词'), (123.4, '尾声')]


def post(p, b, t=None):
    r = urllib.request.Request(BASE + '/web' + p, method='POST')
    r.add_header('Content-Type', 'application/json')
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, json.dumps(b).encode(), timeout=60) as x:
        return json.loads(x.read().decode())


def get(p, t=None):
    r = urllib.request.Request(BASE + '/web' + p)
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, timeout=60) as x:
        return json.loads(x.read().decode())


tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
wp = os.path.join(FIX, STEM + '.wav')
lp = os.path.join(FIX, STEM + '.lrc')
if not (os.path.exists(wp) and os.path.getsize(wp) > 100000):
    with wave.open(wp, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b'\x00\x00' * 44100 * 180)
with open(lp, 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join('[%02d:%05.2f]%s' % (int(t // 60), t % 60, s) for t, s in TRUTH) + '\n')
for f_ in (STEM + '.wav', STEM + '.lrc'):
    shutil.copy(os.path.join(FIX, f_), os.path.join(dd, f_))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 1:
        break
    time.sleep(1)

from playwright.sync_api import sync_playwright

DBG = """() => {
  const q = (s) => document.querySelector(s);
  const body = q('#lf-body');
  const stage = q('.lf-stage');
  const info = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return {top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1),
            scrollTop: +e.scrollTop.toFixed(1), scrollH: e.scrollHeight, clientH: e.clientHeight,
            overflowY: cs.overflowY, position: cs.position, display: cs.display,
            fs: cs.fontSize, padding: cs.padding, flex: cs.flex};
  };
  const cur = body.querySelector('p:not(.tr).on');
  const rows = [...body.querySelectorAll('p:not(.tr)')].map(p => {
    const r = p.getBoundingClientRect();
    return {i: +p.dataset.i, top: +r.top.toFixed(1), h: +r.height.toFixed(1), fs: getComputedStyle(p).fontSize};
  });
  const scrollers = [];
  for (let e = cur; e && e !== document.body; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1) scrollers.push(e.id || e.className);
  }
  return {vw: window.innerWidth, vh: window.innerHeight, body: info(body), stage: info(stage),
          cur: cur ? {i: +cur.dataset.i, top: +cur.getBoundingClientRect().top.toFixed(1),
                      h: +cur.getBoundingClientRect().height.toFixed(1)} : null,
          rows: rows, scrollableAncestors: scrollers,
          t: +window.__player.audio.currentTime.toFixed(2)};
}"""

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844})
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        pg.locator('#view button:has-text("播放全部")').first.click()
        pg.wait_for_timeout(900)
        pg.evaluate("""() => { const pl = window.__player;
          const i = pl.queue.findIndex(t => /歌词对齐/.test(t.name)); pl.play(pl.queue, i); }""")
        for _ in range(40):
            if pg.evaluate("() => window.__player.audio.duration > 5"):
                break
            time.sleep(0.25)
        pg.evaluate("""() => { const np = document.querySelector('.np'); const r = np.getBoundingClientRect();
          np.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2})); }""")
        pg.wait_for_timeout(600)
        for t in (0.0, 20.0, 100.0, 125.0, 20.0):
            pg.evaluate("() => window.__player.audio.pause()")
            pg.evaluate("(t) => { window.__player.audio.currentTime = t }", t)
            pg.wait_for_timeout(900)
            d = pg.evaluate(DBG)
            print('\n--- t=%.1f  当前行=%s  b.scrollTop=%s/%s clientH=%s ---' %
                  (t, d['cur'] and d['cur']['i'], d['body']['scrollTop'], d['body']['scrollH'], d['body']['clientH']))
            print('  #lf-body box top=%.1f h=%.1f overflowY=%s position=%s padding=%s' %
                  (d['body']['top'], d['body']['h'], d['body']['overflowY'], d['body']['position'], d['body']['padding']))
            print('  .lf-stage h=%s overflowY=%s' % (d['stage'] and d['stage']['h'], d['stage'] and d['stage']['overflowY']))
            print('  可滚祖先:', d['scrollableAncestors'])
            cen = d['body']['top'] + d['body']['h'] / 2
            print('  容器中心 y=%.1f；当前行 top=%.1f h=%.1f → 行中心 y=%.1f  delta=%.1f' %
                  (cen, d['cur']['top'], d['cur']['h'], d['cur']['top'] + d['cur']['h'] / 2,
                   d['cur']['top'] + d['cur']['h'] / 2 - cen))
            print('  各行 top/h:', [(r['i'], r['top'], r['h'], r['fs']) for r in d['rows']])
        ctx.close(); b.close()
finally:
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    print('\n（临时用户 %s 未清理账号记录）' % USER)
