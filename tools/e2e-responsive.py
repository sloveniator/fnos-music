#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
响应式/移动端适配验证（真实 Chromium + 线上实例 localhost:20059）

用法：
    python3 tools/e2e-responsive.py

覆盖：
  1. 手机尺寸矩阵（320/360/390/414/横屏 844x390）：无横向溢出、底栏不出屏、
     内容不被顶栏压住、进度线可见、输入框字号 ≥16px、触控目标 ≥34px
  2. 流式缩放：--pad-x / 底栏高度 / 侧栏宽随视口连续变化（不是断点跳变）
  3. 抽屉导航：开合、宽度、不挤压主内容
  4. 页面巡检：home/tracks/albums/online/downloads/trash/settings
  5. 平板/桌面/2K：结构切换正确、移动端进度线在桌面隐藏
  6. 功能：播放 → 底栏进度线与 seek 轴同步（本次新增的移动端反馈）
"""
import sys
import json
import os
import random
import shutil
import string
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX_DIR = '/tmp/gusi-test-music/周杰伦/范特西'
# 主人账号的曲库是有意清空的（自己下载的歌自己放），底栏根本不会出现 →
# 所以这里自建一个临时账号 + 塞两首样本曲，参数化矩阵测的是真实底栏而不是空状态。
_RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PASSWORD = 'sresp' + _RND, 'Resp' + _RND + '!9'

_op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS = FAIL = 0


def web_post(path, body, token=None):
    r = urllib.request.Request(BASE + '/web' + path, method='POST')
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('X-Web-Token', token)
    with _op.open(r, json.dumps(body).encode(), timeout=60) as x:
        return json.loads(x.read().decode())


def web_get(path, token=None):
    r = urllib.request.Request(BASE + '/web' + path)
    if token:
        r.add_header('X-Web-Token', token)
    with _op.open(r, timeout=60) as x:
        return json.loads(x.read().decode())


def seed_account():
    """注册临时账号并塞样本曲，等扫描入库；返回 (token)。"""
    token = web_post('/register', {'name': USER, 'email': USER + '@e.com',
                                   'password': PASSWORD, 'confirm': PASSWORD})['data']['token']
    dd = os.path.join(DATA, 'library', USER, '周杰伦', '范特西')
    os.makedirs(dd, exist_ok=True)
    for fn in sorted(os.listdir(FIX_DIR)):
        shutil.copy(os.path.join(FIX_DIR, fn), os.path.join(dd, fn))
    for _ in range(40):
        if web_get('/api/stats', token)['data'].get('tracks', 0) > 0:
            break
        time.sleep(1)
    return token


def cleanup_account():
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    try:
        r = urllib.request.Request(BASE + '/admin/login', method='POST')
        r.add_header('Content-Type', 'application/json')
        with _op.open(r, json.dumps({'password': 'REDACTED'}).encode(), timeout=30) as x:
            at = json.loads(x.read().decode())['token']
        r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
        r.add_header('X-Admin-Token', at)
        with _op.open(r, timeout=30) as x:
            print('临时账号已清理:', x.status)
    except Exception as e:
        print('清理失败（手动删 %s）:' % os.path.join(DATA, 'library', USER), e)


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


METRICS = """() => {
  const de = document.documentElement
  const main = document.querySelector('.main')
  const player = document.getElementById('player')
  const topbar = document.getElementById('topbar')
  const ps = getComputedStyle(player), ts = getComputedStyle(topbar)
  const pr = player.getBoundingClientRect(), tr = topbar.getBoundingClientRect()
  const view = document.querySelector('#view'), vr = view.getBoundingClientRect()
  const grid = document.querySelector('.grid')
  const btns = document.querySelector('.page-head .btns')
  const br = btns ? btns.getBoundingClientRect() : null
  const taps = [...document.querySelectorAll('#topbar button, #topbar a, #player button, #player .np')]
    .map(e => e.getBoundingClientRect())
    .filter(r => r.height > 0)
    .map(r => Math.round(Math.min(r.width, r.height)))
  return {
    vw: de.clientWidth, vh: window.innerHeight,
    docOverflow: de.scrollWidth - de.clientWidth,
    mainOverflow: main.scrollWidth - main.clientWidth,
    padX: Math.round(parseFloat(getComputedStyle(main).paddingLeft)),
    gridCol: grid ? Math.round(parseFloat(getComputedStyle(grid).gridTemplateColumns)) : 0,
    gridMin: (() => { const d = document.createElement('div')
      d.style.cssText = 'position:absolute;left:-9999px;top:0;width:var(--grid-min)'
      document.body.appendChild(d); const w = Math.round(d.getBoundingClientRect().width); d.remove(); return w })(),
    sidebarRight: Math.round(document.getElementById('sidebar').getBoundingClientRect().right),
    sideMinTap: (() => { const rs = [...document.querySelectorAll('#sidebar a, #sidebar button')]
        .map(e => e.getBoundingClientRect()).filter(r => r.height > 0).map(r => Math.round(Math.min(r.width, r.height)))
      return rs.length ? Math.min(...rs) : 0 })(),
    viewMax: Math.round(parseFloat(getComputedStyle(view).maxWidth)) || null,
    playerVisible: ps.display !== 'none' && pr.height > 0,
    playerH: Math.round(pr.height),
    playerBottom: Math.round(pr.bottom),
    topbarVisible: ts.display !== 'none' && tr.height > 0,
    topbarH: Math.round(tr.height),
    mainPadTop: Math.round(parseFloat(getComputedStyle(main).paddingTop)),
    contentTop: Math.round(vr.top),
    sidebarW: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
    progDisplay: getComputedStyle(document.getElementById('np-progress')).display,
    inputFs: parseFloat(getComputedStyle(document.getElementById('dlg-input')).fontSize),
    minTap: taps.length ? Math.min(...taps) : 0,
    shellH: Math.round(document.querySelector('.shell').getBoundingClientRect().height),
    btnsW: br ? Math.round(br.width) : 0,
    btnsScrollW: btns ? btns.scrollWidth : 0,
    btnsClientW: btns ? btns.clientWidth : 0,
    /* 操作按钮组每行最多几个：两列网格下应为 2，横滑/换行布局下会更多 */
    btnsPerRow: (() => { if (!btns) return 0
      const c = {}
      ;[...btns.children].forEach(e => { const t = Math.round(e.getBoundingClientRect().top); c[t] = (c[t] || 0) + 1 })
      return Math.max(0, ...Object.values(c)) })(),
    npMetaW: (() => { const m = document.querySelector('.np-meta'); return m ? Math.round(m.getBoundingClientRect().width) : 0 })(),
    npCoverW: (() => { const e = document.querySelector('.np-cover'); return e ? Math.round(e.getBoundingClientRect().width) : 0 })(),
    npLoveVisible: (() => { const e = document.getElementById('np-love'); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })(),
    avail: Math.round(view.getBoundingClientRect().width),
  }
}"""

# 歌单页只有一个侧栏入口，四个 tab 逐个覆盖（?tab= 是它的深链语法）
PAGES = [('home', '#/home'), ('tracks', '#/tracks'), ('albums', '#/albums'),
         ('albums-artists', '#/albums?tab=artists'), ('albums-album', '#/albums?tab=albums'),
         ('albums-import', '#/albums?tab=import'),
         ('online', '#/online'), ('downloads', '#/downloads'),
         ('trash', '#/trash'), ('settings', '#/settings')]


def goto(page, hash_, wait=1000):
    page.evaluate("h => { if (location.hash !== h) location.hash = h }", hash_)
    page.wait_for_timeout(wait)


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(900)


def main():
    seed_account()
    try:
        return _run()
    finally:
        cleanup_account()


def _run():
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--autoplay-policy=no-user-gesture-required'])
        errs = []

        mob = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2.75,
                            is_mobile=True, has_touch=True)
        page = mob.new_page()
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
        login(page)

        # 先载入一首，让底栏真实存在（否则底栏高度恒为 0，测不出问题）
        goto(page, '#/tracks', wait=1600)
        rows = page.query_selector_all('.tracks tr.row')
        if rows:
            rows[0].click()
            page.wait_for_timeout(1200)
            page.click('#btn-play')      # 载入即播放 → 暂停，保持底栏存在
            page.wait_for_timeout(400)
        state = page.evaluate(METRICS)
        check('底栏已出现（进入尺寸矩阵前）', state['playerVisible'] and state['playerH'] >= 55,
              'h=%s' % state['playerH'])

        print('\n— 1. 手机尺寸矩阵 —')
        for w, h, label in [(320, 568, '320x568 窄屏'), (360, 640, '360x640 小安卓'),
                            (390, 844, '390x844 iPhone14'), (414, 896, '414x896 大屏手机'),
                            (844, 390, '844x390 横屏')]:
            page.set_viewport_size({'width': w, 'height': h})
            page.wait_for_timeout(700)
            goto(page, '#/tracks', wait=900)
            m = page.evaluate(METRICS)
            check('%s 无横向溢出' % label, m['docOverflow'] <= 0 and m['mainOverflow'] <= 1,
                  'doc=%s main=%s' % (m['docOverflow'], m['mainOverflow']))
            check('%s 操作按钮组不超宽' % label, m['btnsW'] <= m['avail'] + 1,
                  'btns=%s avail=%s' % (m['btnsW'], m['avail']))
            if w <= 560:
                check('%s 操作按钮组不横向滚动（改回两列网格）' % label,
                      m['btnsScrollW'] <= m['btnsClientW'] + 1,
                      'scroll=%s client=%s' % (m['btnsScrollW'], m['btnsClientW']))
                check('%s 操作按钮每行最多两个（等宽两列）' % label, m['btnsPerRow'] <= 2,
                      'perRow=%s' % m['btnsPerRow'])
            check('%s 底栏不出屏' % label, m['playerBottom'] <= m['vh'] + 1 and m['playerH'] >= 55,
                  'bottom=%s vh=%s h=%s' % (m['playerBottom'], m['vh'], m['playerH']))
            check('%s 内容不被顶栏压住' % label, m['contentTop'] >= m['topbarH'] - 2,
                  'contentTop=%s topbar=%s' % (m['contentTop'], m['topbarH']))
            check('%s 移动端进度线可见' % label, m['progDisplay'] == 'block', m['progDisplay'])
            check('%s 输入框字号 ≥16px' % label, m['inputFs'] >= 16, str(m['inputFs']))
            check('%s 顶栏/底栏触控目标 ≥34px' % label, m['minTap'] >= 34, 'min=%s' % m['minTap'])
            check('%s 抽屉关闭时完全离屏（不挡汉堡键）' % label, m['sidebarRight'] <= 1,
                  'sidebarRight=%s' % m['sidebarRight'])
            check('%s 抽屉内触控目标 ≥36px' % label, m['sideMinTap'] >= 36, 'min=%s' % m['sideMinTap'])
            check('%s shell 高度铺满视口（dvh）' % label, abs(m['shellH'] - m['vh']) <= 2,
                  'shell=%s vh=%s' % (m['shellH'], m['vh']))
            # 底栏方案（2026-09-15 主人决定）：收藏/下载保留在底栏，靠压缩封面 + 收紧间距
            # 给歌名让位。所以下面同时盯「按钮在」「封面被压缩」「歌名够宽」三件事，
            # 免得以后有人为了歌名宽度又把按钮藏掉。
            check('%s 底栏保留收藏/下载入口' % label, m['npLoveVisible'], 'love=%s' % m['npLoveVisible'])
            if w <= 340:
                # 320px：4 个传输键 + 2 个功能键 + 封面 + 歌名，横向是物理硬约束
                check('%s 底栏歌名区宽 ≥38px（320 物理下限）' % label, m['npMetaW'] >= 38,
                      'meta=%s' % m['npMetaW'])
                check('%s 超窄屏封面已压缩 ≤32px' % label, 0 < m['npCoverW'] <= 32,
                      'cover=%s' % m['npCoverW'])
            elif w <= 380:
                check('%s 底栏歌名区宽 ≥74px' % label, m['npMetaW'] >= 74, 'meta=%s' % m['npMetaW'])
                check('%s 窄屏封面已压缩 ≤32px' % label, 0 < m['npCoverW'] <= 32,
                      'cover=%s' % m['npCoverW'])
            elif w <= 480:
                check('%s 底栏歌名区宽 ≥80px（压缩封面方案）' % label, m['npMetaW'] >= 80,
                      'meta=%s' % m['npMetaW'])
                check('%s 手机封面已压缩 ≤36px' % label, 0 < m['npCoverW'] <= 36,
                      'cover=%s' % m['npCoverW'])
            else:
                check('%s 底栏歌名区宽 ≥150px（横屏/平板）' % label, m['npMetaW'] >= 150,
                      'meta=%s' % m['npMetaW'])
            page.screenshot(path='tools/resp-%dx%d.png' % (w, h))
            print('      %s: padX=%s 卡片=%s 底栏=%s 侧栏=%s' %
                  (label, m['padX'], m['gridCol'], m['playerH'], m['sidebarW']))

        print('\n— 2. 流式缩放（令牌随视口连续变化）—')
        series = []
        for w in (320, 390, 480, 600, 768, 900, 1024, 1280, 1600, 2100, 2560):
            page.set_viewport_size({'width': w, 'height': 900})
            page.wait_for_timeout(380)
            goto(page, '#/albums', wait=600)
            series.append((w, page.evaluate(METRICS)))
        pads = [m['padX'] for _, m in series]
        cols = [m['gridMin'] for _, m in series]
        check('左右留白随视口放大（14→34px）', all(b >= a for a, b in zip(pads, pads[1:])) and len(set(pads)) >= 4,
              ' → '.join(str(p) for p in pads))
        check('卡片最小宽度令牌随视口放大', all(b >= a for a, b in zip(cols, cols[1:])) and len(set(cols)) >= 3,
              ' → '.join(str(c) for c in cols))
        for w, m in series:
            print('      %4dpx  留白=%-3s 卡片最小宽=%-4s 内容区=%-4s 底栏=%-3s 侧栏=%-4s' %
                  (w, m['padX'], m['gridMin'], m['avail'], m['playerH'], m['sidebarW']))

        print('\n— 3. 抽屉导航 —')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(500)
        goto(page, '#/home', wait=900)
        before = page.evaluate("() => document.querySelector('.main').clientWidth")
        page.click('#menu-btn')
        page.wait_for_timeout(450)
        opened = page.evaluate("""() => { const s = document.getElementById('sidebar'); const r = s.getBoundingClientRect()
            return { open: s.classList.contains('open'), left: Math.round(r.left), w: Math.round(r.width) } }""")
        check('点汉堡 → 抽屉展开且左对齐', opened['open'] and abs(opened['left']) <= 2,
              'left=%s w=%s' % (opened['left'], opened['w']))
        check('抽屉宽 280-310px（可点区域够大）', 280 <= opened['w'] <= 310, 'w=%s' % opened['w'])
        check('抽屉展开不挤压主内容', abs(before - 390) <= 1, 'mainW=%s' % before)
        page.mouse.click(360, 500)   # 点抽屉外侧的遮罩区域
        page.wait_for_timeout(450)
        check('点遮罩 → 抽屉收起',
              not page.evaluate("() => document.getElementById('sidebar').classList.contains('open')"))

        print('\n— 4. 页面巡检 @320 / @390 —')
        for w in (320, 390):
            page.set_viewport_size({'width': w, 'height': 780})
            page.wait_for_timeout(500)
            for name, h in PAGES:
                goto(page, h)
                m = page.evaluate(METRICS)
                check('%dpx · %s 无横向溢出' % (w, name),
                      m['docOverflow'] <= 0 and m['mainOverflow'] <= 1,
                      'doc=%s main=%s' % (m['docOverflow'], m['mainOverflow']))

        print('\n— 5. 平板 / 桌面 / 2K —')
        page.set_viewport_size({'width': 768, 'height': 1024})
        page.wait_for_timeout(600)
        goto(page, '#/tracks', wait=900)
        m = page.evaluate(METRICS)
        check('768px 平板无横向溢出', m['docOverflow'] <= 0 and m['mainOverflow'] <= 1,
              'doc=%s main=%s' % (m['docOverflow'], m['mainOverflow']))
        check('768px 平板仍为抽屉结构', m['topbarVisible'] and m['playerH'] >= 55,
              'topbar=%s' % m['topbarH'])
        page.screenshot(path='tools/resp-768x1024.png')

        desk = b.new_context(viewport={'width': 1280, 'height': 800})
        dp = desk.new_page()
        dp.on('pageerror', lambda e: errs.append('desktop pageerror: ' + str(e)))
        login(dp)
        goto(dp, '#/tracks', wait=1600)
        for w, h, label in [(1280, 800, '1280x800 笔记本'), (1920, 1080, '1920x1080 FHD'),
                            (2560, 1440, '2560x1440 2K')]:
            dp.set_viewport_size({'width': w, 'height': h})
            dp.wait_for_timeout(700)
            goto(dp, '#/tracks', wait=800)
            m = dp.evaluate(METRICS)
            check('%s 无横向溢出' % label, m['docOverflow'] <= 0 and m['mainOverflow'] <= 1,
                  'doc=%s main=%s' % (m['docOverflow'], m['mainOverflow']))
            check('%s 桌面隐藏移动端进度线' % label, m['progDisplay'] == 'none', m['progDisplay'])
            check('%s 桌面侧栏常驻（顶栏隐藏）' % label,
                  m['sidebarW'] >= 200 and not m['topbarVisible'],
                  'sidebar=%s topbar=%s' % (m['sidebarW'], m['topbarH']))
            check('%s 底栏不出屏' % label,
                  (not m['playerVisible']) or m['playerBottom'] <= m['vh'] + 1,
                  '%s/%s' % (m['playerBottom'], m['vh']))
            dp.screenshot(path='tools/resp-%dx%d.png' % (w, h))
            print('      %s: 留白=%s 卡片最小宽=%s 侧栏=%s 内容区=%s' %
                  (label, m['padX'], m['gridMin'], m['sidebarW'], m['avail']))

        print('\n— 6. 功能：移动端底栏进度线 —')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(500)
        goto(page, '#/tracks', wait=1600)
        rows = page.query_selector_all('.tracks tr.row')
        check('曲目表有可点行', len(rows) > 0, '%d 行' % len(rows))
        if rows:
            rows[0].click()
            page.wait_for_timeout(1200)
            # 前面的步骤为保持底栏存在点过暂停：这里自行确认已处于播放态
            p0 = page.evaluate("() => parseFloat(document.getElementById('np-progress').style.width) || 0")
            page.wait_for_timeout(1200)
            if (page.evaluate("() => parseFloat(document.getElementById('np-progress').style.width) || 0")) <= p0:
                page.click('#btn-play')
            page.wait_for_timeout(1500)
            # 「在推进」改成连续采样：曲子放完了会自动切下一首（进度归零），
            # 只比对首尾两个点会误判成「没在走」。这里只在同一首曲目内看是否有一对相邻采样递增。
            samples = []
            for _ in range(12):
                samples.append(page.evaluate("""() => ({ p: parseFloat(document.getElementById('np-progress').style.width) || 0,
                                                          n: document.getElementById('np-name').textContent })"""))
                page.wait_for_timeout(250)
            grew = [(a, b) for a, b in zip(samples, samples[1:])
                    if a['n'] == b['n'] and a['p'] > 0 and b['p'] > a['p']]
            play = page.evaluate("""() => {
              const bar = document.getElementById('np-progress')
              const fill = document.getElementById('seek-fill')
              return { barW: bar.style.width, fillW: fill.style.width,
                       pct: parseFloat(bar.style.width) || 0,
                       barPx: Math.round(bar.getBoundingClientRect().width),
                       barTop: Math.round(bar.getBoundingClientRect().top),
                       playerTop: Math.round(document.getElementById('player').getBoundingClientRect().top),
                       npName: document.getElementById('np-name').textContent }
            }""")
            check('播放推进（3s 内进度持续增长）', bool(grew),
                  '采样 %s 次，递增 %s 对，末尾 %s%% 曲目=%s'
                  % (len(samples), len(grew), samples[-1]['p'], samples[-1]['n']))
            check('底栏进度线随播放前进', play['barPx'] > 0, 'width=%s' % play['barW'])
            check('进度线与 seek 轴同源同步', play['barW'] == play['fillW'],
                  'bar=%s seek=%s' % (play['barW'], play['fillW']))
            check('进度线贴在底栏顶边', abs(play['barTop'] - play['playerTop']) <= 1,
                  'bar=%s player=%s' % (play['barTop'], play['playerTop']))
            page.screenshot(path='tools/resp-390-playing.png')

        check('全程无 JS 运行时错误', len(errs) == 0, ' | '.join(errs[:3]))
        mob.close()
        desk.close()
        b.close()

    print('\n== %d passed, %d failed ==' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
