#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""底栏（缩小的播放导航）截图：跑一组视口，播放一首歌后各截一张。

用法：python3 tools/shot-player-bar.py [after]   # 输出 tools/bar-<w>x<h>-<tag>.png
"""
import sys
from playwright.sync_api import sync_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', _APP_PASS
TAG = sys.argv[1] if len(sys.argv) > 1 else 'before'
VIEWPORTS = [(320, 640), (360, 640), (390, 844), (430, 932), (1280, 800)]


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(900)


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 390, 'height': 844})
        page.on('pageerror', lambda e: print('[pageerror]', e))
        login(page)
        # 本地曲库是空的（主人有意清库），所以用在线单曲把底栏叫出来
        page.evaluate("() => { location.hash = '#/online' }")
        page.wait_for_timeout(1200)
        page.click('.otabs .otab:has-text("搜索")')
        page.wait_for_selector('#view .search-box input', timeout=20000)
        page.fill('#view .search-box input', '告白气球')
        page.press('#view .search-box input', 'Enter')
        page.wait_for_selector('#view .tracks tbody tr', timeout=60000)
        page.wait_for_timeout(600)
        rows = page.query_selector_all('#view .tracks tbody tr')
        print('rows =', len(rows))
        if rows:
            rows[0].click()
            page.wait_for_timeout(5000)
        vis = page.evaluate("() => { const p = document.getElementById('player'); const r = p.getBoundingClientRect(); return r.height }")
        print('player height =', vis)
        for w, h in VIEWPORTS:
            page.set_viewport_size({'width': w, 'height': h})
            page.wait_for_timeout(900)
            m = page.evaluate("""() => {
              const p = document.getElementById('player')
              const r = p.getBoundingClientRect()
              const np = document.querySelector('.np-meta').getBoundingClientRect()
              const btn = (id) => { const e = document.getElementById(id).getBoundingClientRect()
                                    return Math.round(e.width) + 'x' + Math.round(e.height) }
              return { h: Math.round(r.height), bottom: Math.round(window.innerHeight - r.bottom),
                       meta: Math.round(np.width), love: btn('np-love'), dl: btn('np-download'),
                       mode: btn('btn-mode'), prev: btn('btn-prev'), play: btn('btn-play'),
                       next: btn('btn-next'), q: btn('btn-queue'),
                       cover: Math.round(document.querySelector('.np-cover').getBoundingClientRect().width) }
            }""")
            print('%4dx%-4d bar h=%-3d gap下=%-3d meta=%-4d cover=%-3d love=%s dl=%s mode=%s prev=%s play=%s next=%s q=%s'
                  % (w, h, m['h'], m['bottom'], m['meta'], m['cover'], m['love'], m['dl'],
                     m['mode'], m['prev'], m['play'], m['next'], m['q']))
            page.screenshot(path='tools/bar-%dx%d-%s.png' % (w, h, TAG))
        b.close()


if __name__ == '__main__':
    main()
