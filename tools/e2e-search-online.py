#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「搜索页 = 一次搜全部在线平台」+ 移动端底栏（模式键/两行）验证（真实 Chromium + localhost:20059）

用法：
    python3 tools/e2e-search-online.py

覆盖：
  1. 服务端聚合搜索 /web/api/downloads/search：跨源合并去重 + perSource 命中
  2. 桌面 #/search：搜索框改为全平台搜索，本地曲库的 歌曲/专辑/歌手 三个 tab 已不存在
  3. 结果表：行数、平台命中摘要、行内 ▶ 起播（kind=online）、播放全部入队、行内 ⬇ 弹出下载方式
  4. 移动端顶栏搜索图标落到 #/search，结果表 390px 无横向溢出
  5. 移动端底栏：模式键回到缩小的播放条里，且底栏按钮全部 ≥34px、无重叠、不超出视口
  6. 移动端底栏两行布局：信息行在上、控制行在下，歌名区宽 ≥150px（单行方案只有 42px）
  7. 移动端底栏 上一曲/下一曲 真实点击真的换歌（顺带回归）
  8. 320px 极窄屏：底栏不横向溢出、所有传输键都在视口内
"""
import json
import os
import sys
import urllib.request
from playwright.sync_api import sync_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = 'http://localhost:20059'
USER, PASSWORD = os.environ.get('GS_APP_USER', 'Slceleto'), _APP_PASS
PASS = FAIL = SKIP = 0


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


def skip(name, why):
    global SKIP
    SKIP += 1
    print('  [SKIP] %s  -- %s' % (name, why))


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, token=None):
    req = urllib.request.Request(BASE + '/web' + path)
    if token:
        req.add_header('X-Web-Token', token)
    with _opener.open(req, timeout=60) as r:
        return json.loads(r.read().decode())


def login_token():
    req = urllib.request.Request(BASE + '/web/login', method='POST')
    req.add_header('Content-Type', 'application/json')
    with _opener.open(req, json.dumps({'name': USER, 'password': PASSWORD}).encode(), timeout=30) as r:
        return json.loads(r.read().decode())['data']['token']


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(600)


def goto(page, h, wait=900):
    page.evaluate("h => { if (location.hash !== h) location.hash = h }", h)
    page.wait_for_timeout(wait)


def search(page, q):
    """在搜索页输入关键词并回车（走真实交互，不改 hash）"""
    page.wait_for_selector('#view .search-box input', timeout=20000)
    page.fill('#view .search-box input', q)
    page.press('#view .search-box input', 'Enter')
    page.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
    page.wait_for_timeout(300)


BAR_PROBE = """() => {
  const box = id => { const e = document.getElementById(id); if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { disp: cs.display, w: Math.round(r.width), h: Math.round(r.height),
             x: Math.round(r.x), y: Math.round(r.y), top: Math.round(r.top), bottom: Math.round(r.bottom),
             title: e.getAttribute('title') || '' }; };
  const ctr = document.querySelector('#player .ctrls');
  const np = document.querySelector('#player .np');
  const meta = document.querySelector('#player .np-meta');
  return {
    mode: box('btn-mode'), prev: box('btn-prev'), play: box('btn-play'), next: box('btn-next'),
    queue: box('btn-queue'), love: box('np-love'), dl: box('np-download'),
    npBottom: np ? Math.round(np.getBoundingClientRect().bottom) : null,
    ctrTop: ctr ? Math.round(ctr.getBoundingClientRect().top) : null,
    metaW: meta ? Math.round(meta.getBoundingClientRect().width) : null,
    playerOverflow: (() => { const p = document.getElementById('player'); return p.scrollWidth - p.clientWidth; })(),
    vw: window.innerWidth, vh: window.innerHeight,
  };
}"""

CENTER = "id => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }"


def click_id(page, el_id, wait=1200):
    x, y = page.evaluate(CENTER, el_id)
    page.mouse.click(x, y)
    page.wait_for_timeout(wait)


def main():
    token = login_token()
    d = api('/api/downloads/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6&size=30', token)['data']
    rows = d.get('list') or []
    per = d.get('perSource') or []
    print('\n— 1. 服务端聚合搜索 —')
    check('跨源合并结果非空', len(rows) > 0, 'rows=%d' % len(rows))
    check('perSource 给出各平台命中数', sum(x.get('count', 0) for x in per) >= len(rows),
          json.dumps(per, ensure_ascii=False)[:120])
    keys = set()
    dup = False
    for r in rows:
        k = (r.get('name') or '').strip() + '|' + (r.get('singer') or '').strip()
        if k in keys:
            dup = True
        keys.add(k)
        if not (r.get('source') and r.get('id') and r.get('choices')):
            dup = True
    check('同一首（歌名+歌手）只占一行且字段完整', not dup, 'unique=%d/%d' % (len(keys), len(rows)))

    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        # ---------------- 桌面 ----------------
        print('\n— 2. 桌面 1440：搜索页 = 全平台搜索 —')
        desk = b.new_context(viewport={'width': 1440, 'height': 900})
        page = desk.new_page()
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errs.append('console.' + m.type + ': ' + m.text) if m.type == 'error' else None)
        login(page)
        goto(page, '#/search', 1200)
        ph = page.evaluate("() => document.querySelector('#view .search-box input').getAttribute('placeholder')")
        check('搜索框存在且提示语是全平台', '全部平台' in (ph or ''), ph)
        check('本地曲库 tab（歌曲/专辑/歌手）已移除',
              not page.evaluate("() => [...document.querySelectorAll('#view .tab')].some(e => ['歌曲', '专辑', '歌手'].includes(e.textContent.trim()))"),
              'tabs=%s' % page.evaluate("() => [...document.querySelectorAll('#view .tab')].map(e => e.textContent.trim())"))
        search(page, '周杰伦')
        n = page.evaluate("() => document.querySelectorAll('.sr-tbl tbody tr').length")
        check('搜索后出现合并结果表', n > 0, 'rows=%d' % n)
        check('平台命中摘要可见', '平台命中' in page.inner_text('#view'))
        check('地址栏带上关键词（刷新/分享可复现）', '周杰伦' in page.evaluate("() => decodeURIComponent(location.hash)"),
              page.evaluate("() => decodeURIComponent(location.hash)"))

        print('\n— 3. 结果表交互 —')
        page.eval_on_selector_all('.sr-tbl tbody tr',
                                  "els => els[0].querySelector('td.acts button').click()")
        page.wait_for_selector('body.has-player', timeout=15000)
        page.wait_for_timeout(1500)
        st = page.evaluate("() => ({ kind: window.__player.cur && window.__player.cur.kind, name: document.getElementById('np-name').textContent })")
        check('行内 ▶ 起播在线曲目（kind=online）', st['kind'] == 'online', json.dumps(st, ensure_ascii=False))
        page.evaluate("() => document.querySelector('#view .row-head .btns button').click()")
        page.wait_for_timeout(1200)
        q = page.evaluate("() => window.__player.queue.length")
        check('播放全部把整张结果表入队', q >= n, 'queue=%d rows=%d' % (q, n))
        idx_has_sel = page.evaluate("() => document.querySelectorAll('.sr-tbl select.dl-src-sel').length")
        if idx_has_sel:
            before = page.evaluate("() => document.querySelector('.sr-tbl select.dl-src-sel').value")
            page.select_option('.sr-tbl select.dl-src-sel', index=1)
            page.wait_for_timeout(300)
            after = page.evaluate("() => document.querySelector('.sr-tbl select.dl-src-sel').value")
            check('多平台行可切源', before != after, '%s -> %s' % (before, after))
        else:
            skip('多平台行可切源', '本次搜索结果里没有多平台重叠行')
        page.eval_on_selector_all('.sr-tbl tbody tr',
                                  "els => els[1].querySelectorAll('td.acts button')[1].click()")
        page.wait_for_timeout(700)
        menu = page.evaluate("() => [...document.querySelectorAll('.menu.pop button')].map(b => b.textContent.trim())")
        check('行内 ⬇ 弹出下载方式（本机/云盘）', any('本机' in x for x in menu) and any('云盘' in x for x in menu), str(menu)[:100])
        page.keyboard.press('Escape')
        ov = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check('1440px 无横向溢出', ov <= 0, 'overflow=%s' % ov)
        page.screenshot(path='tools/shot-search-online.png')
        desk.close()

        # ---------------- 移动端 390 ----------------
        print('\n— 4. 移动端 390x844：顶栏搜索 + 底栏两行 + 模式键 —')
        mob = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        mp = mob.new_page()
        mp.on('pageerror', lambda e: errs.append('mob pageerror: ' + str(e)))
        login(mp)
        mp.click('#topbar .top-search')
        mp.wait_for_selector('#view .search-box input', timeout=20000)
        check('顶栏搜索图标落到搜索页', mp.evaluate("() => location.hash") == '#/search',
              mp.evaluate("() => location.hash"))
        search(mp, '周杰伦')
        mrows = mp.evaluate("() => document.querySelectorAll('.sr-tbl tbody tr').length")
        check('移动端搜索结果表可用', mrows > 0, 'rows=%d' % mrows)
        ov = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check('390px 搜索结果无横向溢出', ov <= 0, 'overflow=%s' % ov)
        mp.evaluate("() => document.querySelector('.sr-tbl tbody tr').click()")
        mp.wait_for_selector('body.has-player', timeout=15000)
        mp.wait_for_timeout(1500)
        bar = mp.evaluate(BAR_PROBE)
        check('底栏模式键可见（缩小的播放条也能切模式）', bar['mode'] and bar['mode']['disp'] != 'hidden' and bar['mode']['w'] >= 34,
              json.dumps(bar['mode'], ensure_ascii=False) if bar['mode'] else 'null')
        check('底栏两行布局：信息行在控制行之上', bar['npBottom'] is not None and bar['ctrTop'] is not None and bar['npBottom'] <= bar['ctrTop'] + 1,
              'npBottom=%s ctrTop=%s' % (bar['npBottom'], bar['ctrTop']))
        check('歌名区宽度 ≥150px（单行方案只有 42px）', (bar['metaW'] or 0) >= 150, 'metaW=%s' % bar['metaW'])
        tapmin = min(v['w'] for k, v in bar.items() if isinstance(v, dict) and v and v['disp'] != 'hidden' and v['h'] > 0)
        check('底栏所有可见按钮 ≥34px 触控下限', tapmin >= 34, 'min=%s' % tapmin)
        check('底栏不横向溢出', bar['playerOverflow'] <= 1, 'overflow=%s' % bar['playerOverflow'])
        check('底栏所有可视按钮在视口内',
              all((v['x'] >= 0 and v['x'] + v['w'] <= bar['vw'] + 1) for k, v in bar.items() if isinstance(v, dict) and v and v['disp'] != 'hidden'),
              json.dumps({k: v['x'] for k, v in bar.items() if isinstance(v, dict) and v and v['disp'] != 'hidden'}, ensure_ascii=False))

        print('\n— 5. 移动端底栏交互（模式 / 上一曲 / 下一曲 真实点击）—')
        mode0 = mp.evaluate("() => window.__player.mode")
        click_id(mp, 'btn-mode', 700)
        mode1 = mp.evaluate("() => ({ mode: window.__player.mode, title: document.getElementById('btn-mode').getAttribute('title') })")
        check('点模式键切换播放顺序模式', mode1['mode'] != mode0, '%s -> %s (%s)' % (mode0, mode1['mode'], mode1['title']))
        idx0 = mp.evaluate("() => window.__player.index")
        click_id(mp, 'btn-next', 1400)
        idx1 = mp.evaluate("() => window.__player.index")
        check('移动端底栏「下一曲」真的换歌', idx1 != idx0, 'index %s -> %s，name=%s' % (idx0, idx1, mp.text_content('#np-name')))
        t0 = mp.evaluate("() => Math.round(window.__player.audio.currentTime * 10) / 10")
        click_id(mp, 'btn-prev', 900)
        st = mp.evaluate("() => ({ idx: window.__player.index, t: Math.round(window.__player.audio.currentTime * 10) / 10, name: document.getElementById('np-name').textContent })")
        check('移动端底栏「上一曲」有效（回上一首 或 回到开头，不是无响应）',
              st['idx'] != idx1 or st['t'] < 0.6,
              'index %s -> %s / t %s -> %s' % (idx1, st['idx'], t0, st['t']))
        mp.screenshot(path='tools/shot-search-online-mobile.png')
        mp.screenshot(path='tools/shot-mobile-bar-2row.png', clip={'x': 0, 'y': 844 - 110, 'width': 390, 'height': 110})
        mob.close()

        # ---------------- 320 极窄屏 ----------------
        print('\n— 6. 320x568 极窄屏 —')
        tiny = b.new_context(viewport={'width': 320, 'height': 568}, is_mobile=True, has_touch=True)
        tp = tiny.new_page()
        tp.on('pageerror', lambda e: errs.append('320 pageerror: ' + str(e)))
        login(tp)
        # 曲库默认是空的（主人有意清库），所以极窄屏也走在线搜索起播
        goto(tp, '#/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6', 1200)
        tp.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
        tp.evaluate("() => document.querySelector('.sr-tbl tbody tr').click()")
        tp.wait_for_timeout(1500)
        bar = tp.evaluate(BAR_PROBE)
        vis = {k: v for k, v in bar.items() if isinstance(v, dict) and v and v['disp'] != 'hidden' and v['h'] > 0}
        check('320px 模式键仍在底栏且 ≥34px', vis.get('mode') and vis['mode']['w'] >= 34, json.dumps(vis.get('mode'), ensure_ascii=False))
        check('320px 底栏不横向溢出', bar['playerOverflow'] <= 1, 'overflow=%s' % bar['playerOverflow'])
        check('320px 传输键都在视口内', all(v['x'] >= 0 and v['x'] + v['w'] <= bar['vw'] + 1 for v in vis.values()),
              json.dumps({k: [v['x'], v['w']] for k, v in vis.items()}, ensure_ascii=False))
        # 两行布局：只能同行比重叠（上行 vs 下行的横向区间本来就会重叠）
        rows = {}
        for k, v in vis.items():
            rows.setdefault(round(v['y'] / 8), []).append((v['x'], v['x'] + v['w'], k))
        overlap = []
        for _, items in rows.items():
            items.sort()
            overlap += [items[i][2] + '/' + items[i + 1][2] for i in range(len(items) - 1) if items[i][1] > items[i + 1][0] + 1]
        check('320px 底栏同行按钮互不重叠', not overlap, str(overlap))
        check('320px 歌名区仍可读 ≥38px', (bar['metaW'] or 0) >= 38, 'metaW=%s' % bar['metaW'])
        tp.screenshot(path='tools/shot-mobile-bar-320.png')
        tiny.close()

        b.close()

    check('全程无 JS 运行时错误', len(errs) == 0, ' | '.join(errs[:3]))
    print('\n== %d passed, %d failed, %d skipped ==' % (PASS, FAIL, SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
