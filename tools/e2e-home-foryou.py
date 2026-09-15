#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
首页改版 + 「为你推荐」验证（真实 Chromium + 线上实例 localhost:20059）

用法：
    python3 tools/e2e-home-foryou.py

覆盖：
  1. 首页统计条（专辑/歌手/全部歌曲/我喜欢）与新入库/热门歌手/最近播放全部不出现，入口留在侧边栏
  2. 「为你推荐」两张入口卡片：单图封面 + 推荐依据文案 + 数量说明
  3. 点开卡片进详情（#/mix/daily、#/mix/guess）：封面页头 + 混排曲目表 + 播放全部
  4. 详情页播放走正常链路（底栏起播 + 服务端播放历史记到这一首）
  5. 在线行有「在线」标记与「…」菜单（下载到本机 / 保存到云盘）
  6. 桌面两卡并排、窄屏单列，无横向溢出
"""
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
PASS = FAIL = 0


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


# 绕开 HTTP_PROXY（环境里有代理，直连 127.0.0.1 必须禁用它）
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, token=None, method='GET', body=None):
    req = urllib.request.Request(BASE + '/web' + path, method=method)
    if token:
        req.add_header('X-Web-Token', token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    with _opener.open(req, data, timeout=30) as r:
        return json.loads(r.read().decode())


def web_token():
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
    page.wait_for_timeout(800)


def goto(page, h, wait=900):
    page.evaluate("h => { if (location.hash !== h) location.hash = h }", h)
    page.wait_for_timeout(wait)


VIEW_TEXT = "() => document.querySelector('#view').innerText"


def main():
    token = web_token()
    stats = api('/api/stats', token)['data']
    fy = api('/api/for-you', token)['data']
    print('服务端画像: cold=%s signals=%s top=%s' % (
        fy['profile']['cold'], fy['profile']['signals'],
        [s['name'] for s in fy['profile']['singers'][:3]]))
    print('今日推荐: %s | 本地 %d + 在线 %d' % (fy['daily']['reason'], fy['daily']['localCount'], fy['daily']['onlineCount']))
    print('猜你喜欢: %s | 本地 %d + 在线 %d' % (fy['guess']['reason'], fy['guess']['localCount'], fy['guess']['onlineCount']))

    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--autoplay-policy=no-user-gesture-required'])
        errs = []
        desk = b.new_context(viewport={'width': 1440, 'height': 900})
        page = desk.new_page()
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
        login(page)

        print('\n— 1. 首页结构 —')
        goto(page, '#/home', 1200)
        check('首页统计条（专辑/歌手/全部歌曲/我喜欢）已下线',
              page.query_selector('.stat-row') is None and page.query_selector('.stat-pill') is None)
        check('首页不再出现统计数字（如「%d 张」）' % stats['albums'],
              ('%d 张' % stats['albums']) not in page.evaluate(VIEW_TEXT))
        side = page.evaluate("() => document.querySelector('#sidebar').innerText")
        check('入口没丢：侧边栏仍有 全部歌曲 / 专辑歌单 / 歌手',
              '全部歌曲' in side and '专辑/歌单' in side and '歌手' in side)
        goto(page, '#/albums', 1200)
        page.evaluate("() => [...document.querySelectorAll('#view .tabs button')]"
                      ".find(t => t.textContent.trim() === '我的歌单').click()")
        page.wait_for_timeout(1200)
        check('入口没丢：「专辑/歌单 → 我的歌单」里能找到「我喜欢」',
              '我喜欢' in page.evaluate(VIEW_TEXT))
        goto(page, '#/home', 1200)
        body = page.evaluate(VIEW_TEXT)
        for gone in ('新入库', '热门歌手', '最近播放'):
            check('首页已删掉「%s」' % gone, gone not in body)
        check('推荐歌单保留', '推荐歌单' in body)

        print('\n— 2. 为你推荐卡片 —')
        try:
            page.wait_for_selector('.foryou-slot .fy-card', timeout=25000)
        except Exception:
            pass
        cards = page.query_selector_all('.foryou-slot .fy-card')
        check('为你推荐渲染出两张卡片', len(cards) == 2, 'cards=%d' % len(cards))
        names = page.eval_on_selector_all('.foryou-slot .fy-name', 'els => els.map(e => e.textContent.trim())')
        check('卡片标题 = 今日推荐 / 猜你喜欢', names == ['今日推荐', '猜你喜欢'], ' | '.join(names))
        reasons = page.eval_on_selector_all('.foryou-slot .fy-reason', 'els => els.map(e => e.textContent.trim())')
        check('卡片写明推荐依据（不是空文案）', all(len(r) >= 4 for r in reasons) and len(reasons) == 2,
              ' / '.join(reasons))
        metas = page.eval_on_selector_all('.foryou-slot .fy-meta', 'els => els.map(e => e.textContent.trim())')
        check('卡片写明数量并提示可点开', all('点开看详情' in m for m in metas), ' | '.join(metas))
        imgs = page.eval_on_selector_all('.foryou-slot .fy-card .fy-cov img',
                                         'els => els.map(e => ({ w: e.naturalWidth, n: e.naturalWidth > 0 }))')
        peers = page.eval_on_selector_all('.foryou-slot .fy-card',
                                          "els => els.map(e => e.querySelectorAll('.fy-cov img').length)")
        check('每张卡片封面只有一张图（不是拼图）', len(cards) == 2 and peers == [1, 1],
              'per-card=%s' % peers)
        check('封面是真图而不是空壳',
              len(imgs) == 2 and all(i['n'] for i in imgs),
              'imgs=%d loaded=%d' % (len(imgs), sum(1 for i in imgs if i['n'])))
        check('卡片里没有残留拼图占位符（♪）',
              page.query_selector('.foryou-slot .fy-cov-ph') is None)
        check('首页推荐区有说明（按账户口味 · 每日更新）', '按本账户的收听习惯生成' in body)
        page.screenshot(path='tools/home-foryou-desktop.png')

        print('\n— 3. 点开 → 歌曲详情 —')
        page.click('.foryou-slot .fy-card')
        page.wait_for_timeout(1500)
        check('点卡片进入今日推荐详情', page.evaluate('() => location.hash') == '#/mix/daily',
              page.evaluate('() => location.hash'))
        check('详情页有封面页头', page.query_selector('.fy-hero .fy-cov.big') is not None)
        check('详情页封面也只有一张图',
              page.eval_on_selector_all('.fy-hero .fy-cov.big img', 'els => els.length') == 1,
              'imgs=%s' % page.eval_on_selector_all('.fy-hero .fy-cov.big img', 'els => els.length'))
        h2 = page.eval_on_selector('.fy-hero h2', 'e => e.textContent.trim()')
        check('详情页标题 = 今日推荐', h2 == '今日推荐', h2)
        rows = page.query_selector_all('.fy-hero ~ table.tracks tbody tr.row')
        check('详情页列出曲目（与接口一致）', len(rows) == len(fy['daily']['tracks']),
              'DOM=%d API=%d' % (len(rows), len(fy['daily']['tracks'])))
        check('详情页有播放全部 / 随机播放 / 加到队列三个入口',
              page.query_selector('.fy-hero .btn.primary') is not None and '随机播放' in page.evaluate(VIEW_TEXT)
              and '加到队列' in page.evaluate(VIEW_TEXT))
        page.screenshot(path='tools/home-mix-daily.png')

        print('\n— 4. 播放链路 —')
        first_name = page.eval_on_selector('table.tracks tbody tr.row .cell-name, table.tracks tbody tr.row td:nth-child(3) div',
                                          'e => e.textContent.trim()')
        page.click('.fy-hero .btn.primary')
        page.wait_for_timeout(2200)
        check('点「播放全部」底栏起播', page.evaluate("() => { const p = document.getElementById('player'); return getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 40 }"))
        np_name = page.evaluate("() => document.getElementById('np-name').textContent.trim()")
        check('底栏曲名 = 列表第一首', np_name == first_name, '底栏=%s 首行=%s' % (np_name, first_name))
        played = api('/api/played', token)['data']['tracks']
        check('服务端播放历史记到这一首（口味画像的输入）',
              bool(played) and played[0]['name'] == first_name and played[0]['singer'],
              (played[0]['name'] + ' — ' + played[0]['singer']) if played else '无')

        print('\n— 5. 猜你喜欢 + 在线行 —')
        goto(page, '#/mix/guess', 1500)
        h2g = page.eval_on_selector('.fy-hero h2', 'e => e.textContent.trim()')
        rowsg = page.query_selector_all('table.tracks tbody tr.row')
        check('猜你喜欢详情可用', h2g == '猜你喜欢' and len(rowsg) >= 4, '%s / %d 行' % (h2g, len(rowsg)))
        online_rows = [r for r in rowsg if '在线' in r.inner_text()]
        if online_rows:
            check('在线行标注「在线」', True, '在线行 %d 行' % len(online_rows))
            page.eval_on_selector_all('table.tracks tbody tr.row', """els => {
              const row = els.find(e => e.innerText.includes('在线'))
              row.querySelector('td.acts button').click()
            }""")
            page.wait_for_timeout(400)
            menu = page.evaluate("() => [...document.querySelectorAll('.menu.pop button')].map(b => b.textContent.trim())")
            check('在线行「…」菜单有播放/队列/下载', any('下一首' in m for m in menu) and any('下载到本机' in m for m in menu),
                  ' | '.join(menu))
            page.keyboard.press('Escape')
            page.evaluate("() => document.querySelectorAll('.menu.pop').forEach(m => m.remove())")
        else:
            check('在线行标注「在线」（本次在线源未回数据，跳过）', True, '在线 0 行')
        page.screenshot(path='tools/home-mix-guess.png')

        print('\n— 6. 窄屏 —')
        mob = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        mp = mob.new_page()
        mp.on('pageerror', lambda e: errs.append('mobile pageerror: ' + str(e)))
        login(mp)
        goto(mp, '#/home', 2000)
        try:
            mp.wait_for_selector('.foryou-slot .fy-card', timeout=25000)
        except Exception:
            pass
        ov = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check('390px 首页无横向溢出', ov <= 0, 'overflow=%s' % ov)
        tops = mp.eval_on_selector_all('.foryou-slot .fy-card', 'els => els.map(e => Math.round(e.getBoundingClientRect().top))')
        check('窄屏两张卡片单列堆叠', len(tops) == 2 and tops[0] != tops[1], 'tops=%s' % tops)
        w = mp.eval_on_selector('.foryou-slot .fy-card', 'e => Math.round(e.getBoundingClientRect().width)')
        check('卡片不超出视口', w <= 390, 'w=%s' % w)
        mp.click('.foryou-slot .fy-card')
        mp.wait_for_timeout(1500)
        ov2 = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check('390px 详情页无横向溢出', ov2 <= 0, 'overflow=%s' % ov2)
        mp.screenshot(path='tools/home-foryou-390.png')
        mob.close()

        print('\n— 7. 桌面并排 —')
        goto(page, '#/home', 2000)
        # 鼠标必须停在中性位置：.fy-card:hover 有 translateY(-3px)，
        # 前面点过卡片、指针留在第一张上会让两张卡 top 差 3px（脚手架假失败）
        page.mouse.move(4, 4)
        page.wait_for_timeout(300)
        try:
            page.wait_for_selector('.foryou-slot .fy-card', timeout=25000)
        except Exception:
            pass
        tops = page.eval_on_selector_all('.foryou-slot .fy-card', 'els => els.map(e => Math.round(e.getBoundingClientRect().top))')
        check('桌面两张卡片并排', len(tops) == 2 and tops[0] == tops[1], 'tops=%s' % tops)

        check('全程无 JS 运行时错误', len(errs) == 0, ' | '.join(errs[:3]))
        desk.close()
        b.close()

    print('\n== %d passed, %d failed ==' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
