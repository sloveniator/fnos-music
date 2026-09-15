#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：观察底栏播放状态随时间的真实变化（进度 % / 曲名 / 播放暂停图标 / 已放完切换）。

用来判断 e2e-responsive.py 第 6 段「播放推进」为什么会采样到 0%。
用法：python3 tools/probe-play-state.py [采样秒数]
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('resp', os.path.join(ROOT, 'tools', 'e2e-responsive.py'))
resp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resp)

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 40

from playwright.sync_api import sync_playwright  # noqa: E402

resp.seed_account()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: print('[pageerror]', e))
        resp.login(page)
        resp.goto(page, '#/tracks', wait=1600)
        rows = page.query_selector_all('.tracks tr.row')
        print('rows =', len(rows))
        rows[0].click()
        t = 0.0
        while t < SECONDS:
            d = page.evaluate("""() => {
              const bar = document.getElementById('np-progress')
              const btn = document.getElementById('btn-play')
              const eq = document.querySelector('.np-eq')
              return { p: parseFloat(bar.style.width) || 0, n: document.getElementById('np-name').textContent,
                       svg: btn ? btn.querySelector('svg').innerHTML.length : -1,
                       eq: eq ? eq.classList.contains('on') : null,
                       hasPlayer: document.body.classList.contains('has-player') }
            }""")
            print('%5.1fs  %6.2f%%  svg=%-3s eq=%-5s %s' % (t, d['p'], d['svg'], d['eq'], d['n']))
            page.wait_for_timeout(1000)
            t += 1
        b.close()
finally:
    resp.cleanup_account()
