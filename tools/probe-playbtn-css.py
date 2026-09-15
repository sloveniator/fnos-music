#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打印底栏播放键与歌词页播放键的计算样式原文（写断言用）。"""
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'

PROBE = """() => {
  const b = document.getElementById('btn-play'), cs = getComputedStyle(b)
  const lf = document.getElementById('lf-play'), lcs = getComputedStyle(lf)
  return {
    barBg: cs.backgroundImage, barColor: cs.color, barShadow: cs.boxShadow,
    barBorder: cs.borderTopWidth + ' ' + cs.borderTopColor, barFilter: getComputedStyle(b.querySelector('svg')).filter,
    lfBg: lcs.backgroundImage, lfColor: lcs.color,
  }
}"""

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    pg = br.new_page(viewport={'width': 390, 'height': 844})
    pg.goto(BASE + '/', wait_until='domcontentloaded')
    pg.wait_for_selector('#login', state='visible', timeout=20000)
    pg.fill('#login-name', USER)
    pg.fill('#login-pass', PASSWORD)
    pg.click('#login-btn')
    pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
    pg.wait_for_timeout(800)
    pg.evaluate("() => { location.hash = '#/online' }")
    pg.wait_for_timeout(1200)
    pg.click('.otabs .otab:has-text("搜索")')
    pg.wait_for_selector('#view .search-box input', timeout=20000)
    pg.fill('#view .search-box input', '告白气球')
    pg.press('#view .search-box input', 'Enter')
    pg.wait_for_selector('#view .tracks tbody tr', timeout=60000)
    pg.wait_for_timeout(600)
    pg.query_selector_all('#view .tracks tbody tr')[0].click()
    pg.wait_for_timeout(4000)
    for k, v in pg.evaluate(PROBE).items():
        print('%s = %s' % (k, v))
    br.close()
