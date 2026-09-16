#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""移动端逐页截图（默认 390x844），用来审「封面/UI 是否过大」。

用法：python3 tools/shot-pages-mobile.py [tag] [w] [h]
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
TAG = sys.argv[1] if len(sys.argv) > 1 else 'm'
W = int(sys.argv[2]) if len(sys.argv) > 2 else 390
H = int(sys.argv[3]) if len(sys.argv) > 3 else 844
PAGES = [('home', '#/home', 2200), ('online', '#/online', 3500), ('fm', '#/fm', 3500),
         ('albums', '#/albums', 1500), ('tracks', '#/tracks', 1500),
         ('downloads', '#/downloads', 1500), ('settings', '#/settings', 1200)]


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=2)
        page.on('pageerror', lambda e: print('[pageerror]', e))
        page.goto(BASE + '/', wait_until='domcontentloaded')
        page.wait_for_selector('#login', state='visible', timeout=20000)
        page.fill('#login-name', USER)
        page.fill('#login-pass', PASSWORD)
        page.click('#login-btn')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        page.wait_for_timeout(900)
        for name, hash_, wait in PAGES:
            page.evaluate("(h) => { location.hash = h }", hash_)
            page.wait_for_timeout(wait)
            page.screenshot(path='tools/page-%dx%d-%s-%s.png' % (W, H, name, TAG))
            print('shot tools/page-%dx%d-%s-%s.png' % (W, H, name, TAG))
        b.close()


if __name__ == '__main__':
    main()
