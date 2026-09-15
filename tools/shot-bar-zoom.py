#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把底栏单独放大截图（2x），用来肉眼审质感。

用法：python3 tools/shot-bar-zoom.py <tag>
"""
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
TAG = sys.argv[1] if len(sys.argv) > 1 else 'z'
CASES = [(320, 640, 130), (390, 844, 130), (430, 932, 130), (768, 1024, 110), (1280, 800, 96)]


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        page.goto(BASE + '/', wait_until='domcontentloaded')
        page.wait_for_selector('#login', state='visible', timeout=20000)
        page.fill('#login-name', USER)
        page.fill('#login-pass', PASSWORD)
        page.click('#login-btn')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        page.wait_for_timeout(900)
        page.evaluate("() => { location.hash = '#/online' }")
        page.wait_for_timeout(1200)
        page.click('.otabs .otab:has-text("搜索")')
        page.wait_for_selector('#view .search-box input', timeout=20000)
        page.fill('#view .search-box input', '告白气球')
        page.press('#view .search-box input', 'Enter')
        page.wait_for_selector('#view .tracks tbody tr', timeout=60000)
        page.wait_for_timeout(600)
        page.query_selector_all('#view .tracks tbody tr')[0].click()
        page.wait_for_timeout(5000)
        for w, h, clip_h in CASES:
            page.set_viewport_size({'width': w, 'height': h})
            page.wait_for_timeout(1000)
            page.screenshot(path='tools/zoom-%dx%d-%s.png' % (w, h, TAG),
                            clip={'x': 0, 'y': h - clip_h, 'width': w, 'height': clip_h})
            print('shot tools/zoom-%dx%d-%s.png' % (w, h, TAG))
        b.close()


if __name__ == '__main__':
    main()
