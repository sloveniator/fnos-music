#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断底栏控件：位置/尺寸/颜色/可见性（默认 390x844）。"""
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
W = int(sys.argv[1]) if len(sys.argv) > 1 else 390
H = int(sys.argv[2]) if len(sys.argv) > 2 else 844

PROBE = """() => {
  const bar = document.getElementById('player').getBoundingClientRect()
  const info = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return sel + ': MISSING'
    const s = getComputedStyle(e), r = e.getBoundingClientRect()
    return sel + ': ' + Math.round(r.left - bar.left) + '+' + Math.round(r.width) + 'x' + Math.round(r.height)
      + ' color=' + s.color + ' bg=' + s.backgroundColor + ' op=' + s.opacity
      + ' disp=' + s.display + ' vis=' + s.visibility
  }
  return [info('#np-love'), info('#np-download'), info('.np-cover'), info('.np-meta'),
          info('.np'), info('.ctrls'), info('#btn-mode'), info('#btn-play'), info('#btn-queue'),
          'bar=' + Math.round(bar.left) + '+' + Math.round(bar.width) + 'x' + Math.round(bar.height)
            + ' bottomGap=' + Math.round(window.innerHeight - bar.bottom),
          'loveHTML=' + (document.getElementById('np-love').innerHTML || '').slice(0, 80)]
}"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': W, 'height': H})
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
    for line in page.evaluate(PROBE):
        print(line)
    b.close()
