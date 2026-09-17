#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-17 主人反馈：「歌词和播放进程没对齐」的定向验证。

夹具是一首 180s 静音轨 + 同名侧车 .lrc，51 行、**每一行都带小数**时间标签：

    行00 [00:00.37]      行01 [00:04.37]      ...      行44 [02:56.37]
    外加 6 行「照妖镜」：12.50 第一句歌词 / 15.35 第二句歌词 / 62.00 第三句歌词
                       80.75 第四句歌词 / 123.40 尾声 / 0.00 前奏

小数就是旧 parseLrc 的照妖镜：`分钟×60 + 秒` 算出来是**秒**，却把小数当**毫秒**加了
进去 —— 12.50 → 512、15.35 → 365、0.37 → 370，再按这个假时间排序，51 行全被打乱。
所以旧代码下进度走到 20s 时高亮还停在第 0 行（前奏），而正确结果是 16.37s 那行。

验证项：
  S 静态
    S0 /web/media/lyric/<id> 回的正是那份侧车 LRC（不是跨源兜底搜来的别的歌词）
  L 浏览器（390×844 窄屏，走手机入口：点底栏信息区进歌词页）
    L1 51 行全部解析出来，时间戳是**秒**且与夹具逐个相等、行序与原文一致
    L2 逐点对齐：6 条探针时间各自落在夹具算出来的那一行（含 12.5/15.35 这类小数行）
    L3 反例：t=20s 不能停在第 0 行（旧代码的典型症状）
    L4 跳转后当前行落在歌词区正中（±8px），且歌词区确实滚了（scrollTop 落在合法区间）
    L5 边界：第一行停顶（scrollTop=0）、最后一行停底（可见且不越界）
    L6 页面上只有一条 .on，是主歌词行，且字号确实被抬大了（翻译行不再抢当前行样式）
    L7 点某一行 → currentTime ≈ 该行时间（行 → 进度 的回路）
    L8 关页 → 音频跑到别处 → 重开：高亮跟着新位置，仍是旧高亮的算失败
    L9 播放中（非暂停）seek 后高亮与 currentTime 对得上，不多点亮
    L10 拖全屏进度轴到 50% 后，高亮 = 90s 对应的那一行

用法：python3 tools/e2e-lyricsync.py        （BASE 可用 GS_BASE 覆盖）
"""
import json, os, random, shutil, string, sys, time, urllib.error, urllib.request, wave

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
STEM = '00 歌词对齐'
WAV = STEM + '.wav'
LRC = STEM + '.lrc'
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'lyrsync' + RND, 'Lyr' + RND + '!9'
P = F = 0
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# ---------- 夹具真值（秒）：所有断言都对着这张表，测试自己不算「应该第几行」以外的东西 ----------
TAGS = {0.0: '前奏', 12.5: '第一句歌词', 15.35: '第二句歌词',
        62.0: '第三句歌词', 80.75: '第四句歌词', 123.4: '尾声'}
TRUTH = sorted([(round(k * 4 + 0.37, 2), '第%02d句' % k) for k in range(45)]
               + list(TAGS.items()))
LRC_TEXT = '\n'.join('[%02d:%05.2f]%s' % (int(t // 60), t % 60, s) for t, s in TRUTH) + '\n'


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
    """180s / 44.1kHz 单声道静音 wav + 同名侧车 .lrc（侧车优先，不依赖内嵌标签）"""
    os.makedirs(FIX, exist_ok=True)
    wp = os.path.join(FIX, WAV)
    if not (os.path.exists(wp) and os.path.getsize(wp) > 100000):
        with wave.open(wp, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
            w.writeframes(b'\x00\x00' * 44100 * 180)
    with open(os.path.join(FIX, LRC), 'w', encoding='utf-8', newline='\n') as f:
        f.write(LRC_TEXT)
    return wp


SNAP = """() => {
  const q = (s) => document.querySelector(s);
  const a = window.__player ? window.__player.audio : null;
  const body = q('#lf-body');
  const main = body ? [...body.querySelectorAll('p:not(.tr)')] : [];
  const cur = body ? body.querySelector('p:not(.tr).on') : null;
  const off = main.find(p => !p.classList.contains('on'));
  let delta = null, scrollTop = null, bodyH = null, range = null, curTop = null, curH = null;
  if (body) {
    const br = body.getBoundingClientRect();
    bodyH = +br.height.toFixed(1);
    scrollTop = +body.scrollTop.toFixed(1);
    range = body.scrollHeight - body.clientHeight;
    if (cur) {
      const er = cur.getBoundingClientRect();
      delta = +((er.top + er.height / 2) - (br.top + br.height / 2)).toFixed(1);
      curTop = +(er.top - br.top).toFixed(1); curH = +er.height.toFixed(1);
    }
  }
  const lines = window.__player && window.__player.lyric ? window.__player.lyric : null;
  return {
    vw: window.innerWidth,
    lfHidden: q('#lyric-full').hidden,
    nLines: lines ? lines.length : 0,
    lines: lines ? lines.map(l => +l.t.toFixed(3)) : null,
    texts: lines ? lines.map(l => l.text) : null,
    nMain: main.length,
    nOn: body ? body.querySelectorAll('p.on').length : -1,
    trOn: body ? body.querySelectorAll('p.tr.on').length : -1,
    onIdx: cur ? Number(cur.dataset.i) : -1,
    onText: cur ? cur.textContent : '',
    onSize: cur ? parseFloat(getComputedStyle(cur).fontSize) : null,
    offSize: off ? parseFloat(getComputedStyle(off).fontSize) : null,
    delta: delta, scrollTop: scrollTop, bodyH: bodyH, range: range, curTop: curTop, curH: curH,
    t: a ? +a.currentTime.toFixed(3) : -1, d: a ? +(a.duration || 0).toFixed(3) : 0,
    paused: a ? a.paused : null,
    name: window.__player && window.__player.cur ? window.__player.cur.name : '',
  };
}"""


def expect_idx(t):
    """按真值表算 t 时刻该亮哪一行（客户端同样的 +0.2s 提前量）"""
    idx = -1
    for i, (ts, _) in enumerate(TRUTH):
        if ts <= t + 0.2:
            idx = i
        else:
            break
    return idx


def seek_paused(pg, t, wait=900):
    """暂停后精确落点（暂停下 seek 也触发 timeupdate，位置不会被播放带偏）"""
    pg.evaluate("() => window.__player.audio.pause()")
    pg.evaluate("(t) => { window.__player.audio.currentTime = t }", t)
    pg.wait_for_timeout(wait)
    return pg.evaluate(SNAP)


def open_lyric_page(pg):
    """走手机入口：点底栏信息区（≤900px 才生效）"""
    if pg.evaluate("() => document.getElementById('lyric-full').hidden"):
        pg.evaluate("""() => {
          const np = document.querySelector('.np');
          const r = np.getBoundingClientRect();
          np.dispatchEvent(new MouseEvent('click', {bubbles: true,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}));
        }""")
        pg.wait_for_timeout(500)
    return pg.evaluate(SNAP)


ensure_fixture()
tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
for f in (WAV, LRC):
    shutil.copy(os.path.join(FIX, f), os.path.join(dd, f))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 1:
        break
    time.sleep(1)
tracks = get('/api/tracks?size=50', tok)['data']['tracks']
tid = next((t['id'] for t in tracks if STEM in t['name']), None)
print('临时用户 %s，曲目 %s，夹具 %d 行 LRC' % (USER, tid, len(TRUTH)))
if not tid:
    print('夹具没被索引到，无法继续'); sys.exit(1)

print('\n== S 夹具与接口 ==')
ly = get('/media/lyric/' + tid, tok)['data']
check('S0 /media/lyric 回的正是那份侧车 LRC（不是兜底搜来的别的歌词）',
      '[00:12.50]第一句歌词' in (ly.get('lyric') or ''), repr((ly.get('lyric') or '')[:40]))

from playwright.sync_api import sync_playwright

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        print('\n== L 窄屏 390×844：歌词时间轴与进度对齐 ==')
        ctx = b.new_context(viewport={'width': 390, 'height': 844})
        pg = ctx.new_page()
        pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tok))
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
        pg.locator('#view button:has-text("播放全部")').first.click()
        pg.wait_for_timeout(900)
        pg.evaluate("""() => {
          const pl = window.__player;
          const i = pl.queue.findIndex(t => /歌词对齐/.test(t.name));
          if (i < 0) throw new Error('fixture not in queue: ' + pl.queue.length);
          pl.play(pl.queue, i);
        }""")
        for _ in range(40):
            s0 = pg.evaluate(SNAP)
            if s0['d'] > 5 and '歌词对齐' in (s0['name'] or ''):
                break
            time.sleep(0.25)
        check('L0 夹具长轨在放（duration>5s）', s0['d'] > 5, '%s d=%.1fs' % (s0['name'], s0['d']))
        s = open_lyric_page(pg)
        check('L0b 走手机入口（点底栏信息区）打开了歌词页', not s['lfHidden'], 'lfHidden=%s' % s['lfHidden'])
        check('L0c 夹具够长够满，歌词区真的能滚（滚动余量 > 500px 才有意义）',
              (s['range'] or 0) > 500, 'range=%s bodyH=%s' % (s['range'], s['bodyH']))

        # L1 时间轴本身
        want = [round(t, 2) for t, _ in TRUTH]
        check('L1a %d 行全部解析出来' % len(TRUTH), s['nLines'] == len(TRUTH), 'nLines=%s' % s['nLines'])
        check('L1b 时间戳是「秒」而不是被放大千倍（12.5 而不是 512；0.37 而不是 370）',
              s['lines'] == want, '前 6 个=%s 期望=%s' % (s['lines'][:6], want[:6]))
        check('L1c 行序与歌词原文逐行一致（假时间会把 51 行整体重排）',
              s['texts'] == [x for _, x in TRUTH], '前 6 个=%s' % s['texts'][:6])

        # L2 逐点对齐
        probes = [0.5, 12.9, 15.5, 20.0, 62.5, 81.0, 100.0, 123.9, 176.9]
        for t in probes:
            st = seek_paused(pg, t)
            ei = expect_idx(t)
            check('L2 t=%6.2fs → 第 %2d 行「%s」' % (t, ei, TRUTH[ei][1]),
                  st['onIdx'] == ei and st['onText'] == TRUTH[ei][1],
                  'onIdx=%s onText=%r (音轨 t=%.2f)' % (st['onIdx'], st['onText'], st['t']))

        # L3 反例：旧代码的典型症状
        st = seek_paused(pg, 20.0)
        check('L3 反例：t=20s 不是停在第 0 行（旧 parseLrc 下 51 行的假时间全 > 20s，'
              '高亮只会趴在「前奏」上）', st['onIdx'] != 0 and st['onIdx'] == expect_idx(20.0),
              'onIdx=%s' % st['onIdx'])

        # L4 落点居中（居中位置由布局决定，取中间几行验证）
        for t in (62.5, 100.0, 81.0):
            st = seek_paused(pg, t)
            check('L4 t=%.1fs 跳转后当前行落在歌词区正中（±8px）' % t,
                  st['delta'] is not None and abs(st['delta']) <= 8,
                  'delta=%spx scrollTop=%s range=%s' % (st['delta'], st['scrollTop'], st['range']))
            check('L4b t=%.1fs 歌词区真的滚了（scrollTop 在 0..range 之间且 > 100）' % t,
                  st['scrollTop'] is not None and 100 < st['scrollTop'] < st['range'],
                  'scrollTop=%s range=%s' % (st['scrollTop'], st['range']))
        st = seek_paused(pg, 100.0)
        check('L4c 往回跳（62.5s ← 100s 反向）同样重新居中',
              abs(st['delta'] or 999) <= 8, 'delta=%s' % st['delta'])

        # L5 边界：首行停顶、末行停底
        st = seek_paused(pg, 0.0)
        check('L5a 第一行：停在顶端（scrollTop=0）且该行完整可见',
              st['scrollTop'] == 0 and st['onIdx'] == 0 and st['curTop'] >= 0
              and st['curTop'] + st['curH'] <= st['bodyH'],
              'scrollTop=%s curTop=%s curH=%s bodyH=%s' % (st['scrollTop'], st['curTop'], st['curH'], st['bodyH']))
        st = seek_paused(pg, 176.9)
        # 末行不可能精确居中：.lf-body 的 padding-bottom(30vh≈203px) < 容器半高(240px)，
        # 滚到底时末行天然落在中心下方 ~15px（设计如此，不是 bug）。另外 .lf-body p 上有
        # `transition: all .25s`，点亮后字号 14.43→17.16px 还在长，滚到底那一瞬间的
        # scrollHeight 比最终值小几像素 —— 所以这里守的是「完整可见 + 确实到底」，
        # 允许 ±12px；精确居中由 L4 用中间的行来守（那里几何上做得到）。
        check('L5b 最后一行：滚到底（±12px）且该行完整可见',
              st['onIdx'] == len(TRUTH) - 1 and abs(st['scrollTop'] - st['range']) <= 12
              and st['curTop'] >= 0 and st['curTop'] + st['curH'] <= st['bodyH'],
              'scrollTop=%s range=%s curTop=%s curH=%s bodyH=%s' % (st['scrollTop'], st['range'], st['curTop'], st['curH'], st['bodyH']))

        # L6 只有一条 .on
        check('L6a 页面上只有一条 .on，且没有翻译行被点亮',
              st['nOn'] == 1 and st['trOn'] == 0 and st['nMain'] == len(TRUTH),
              'nOn=%s trOn=%s nMain=%s' % (st['nOn'], st['trOn'], st['nMain']))
        check('L6b 当前行字号确实比其它行大（当前行样式落在主行上）',
              (st['onSize'] or 0) > (st['offSize'] or 0) > 0,
              'on=%s off=%s' % (st['onSize'], st['offSize']))

        # L7 行 → 进度 回路
        k = next(i for i, (t, _) in enumerate(TRUTH) if _.startswith('第三句'))
        pg.evaluate("""(i) => {
          const p = document.querySelector('#lf-body p:not(.tr)[data-i="' + i + '"]');
          p.dispatchEvent(new MouseEvent('click', {bubbles: true}));
        }""", k)
        pg.wait_for_timeout(600)
        st = pg.evaluate(SNAP)
        check('L7 点「第三句歌词」那行 → currentTime ≈ 62.0s',
              abs(st['t'] - 62.0) < 0.6 and st['onIdx'] == k, 't=%.2f onIdx=%s' % (st['t'], st['onIdx']))

        # L8 关页 → 跑到别处 → 重开
        pg.evaluate("() => { document.getElementById('lyric-full').hidden = true }")
        pg.wait_for_timeout(200)
        pg.evaluate("() => { window.__player.audio.currentTime = 100.5 }")   # 页面关着时移动进度
        pg.wait_for_timeout(700)
        st = open_lyric_page(pg)
        ei = expect_idx(100.5)
        check('L8 重开歌词页：高亮跟着新位置（第 %d 行「%s」），不是上次关页时的旧高亮'
              % (ei, TRUTH[ei][1]), st['onIdx'] == ei and st['onText'] == TRUTH[ei][1],
              'onIdx=%s onText=%r' % (st['onIdx'], st['onText']))
        check('L8b 重开后同样对准中心（±8px）', abs(st['delta'] or 999) <= 8, 'delta=%s' % st['delta'])

        # L9 播放中 seek
        pg.evaluate("() => { const a = window.__player.audio; a.currentTime = 65; a.play().catch(() => {}); }")
        pg.wait_for_timeout(900)
        st = pg.evaluate(SNAP)
        ei = expect_idx(st['t'])
        check('L9 播放中 t=%.2fs 时高亮 = 第 %d 行，且只有一条 .on' % (st['t'], ei),
              (not st['paused']) and st['onIdx'] == ei and st['nOn'] == 1,
              'paused=%s onIdx=%s onText=%r' % (st['paused'], st['onIdx'], st['onText']))
        check('L9b 播放中高亮行也没脱离中心（±40px，平滑跟随允许落后一点）',
              abs(st['delta'] or 999) <= 40, 'delta=%s' % st['delta'])

        # L10 拖全屏进度轴
        pg.evaluate("() => window.__player.audio.pause()")
        box = pg.evaluate("""() => { const r = document.getElementById('lf-seek').getBoundingClientRect();
          return {l: r.left, t: r.top, w: r.width, h: r.height}; }""")
        pg.mouse.move(box['l'] + box['w'] * 0.10, box['t'] + box['h'] / 2)
        pg.mouse.down()
        pg.mouse.move(box['l'] + box['w'] * 0.50, box['t'] + box['h'] / 2)
        pg.wait_for_timeout(200)
        pg.mouse.up()
        pg.wait_for_timeout(900)
        st = pg.evaluate(SNAP)
        ei = expect_idx(st['t'])
        check('L10 拖全屏进度轴到 50%%（t=%.1fs）→ 高亮第 %d 行「%s」' % (st['t'], ei, TRUTH[ei][1]),
              st['onIdx'] == ei, 'onIdx=%s onText=%r' % (st['onIdx'], st['onText']))
        check('L10b 拖动落点 50%% 落在 45~55%%', 0.45 <= (st['t'] / st['d'] if st['d'] else -1) <= 0.55,
              't=%.1f d=%.1f = %.1f%%' % (st['t'], st['d'], (st['t'] / st['d'] * 100) if st['d'] else -1))
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
