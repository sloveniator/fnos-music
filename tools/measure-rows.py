#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""曲目行对齐测量脚手架：量表头与各行的列起止 x、按钮位置、行高。

用途：改「歌曲/专辑/时长」列宽与喜欢/下载按钮位置前后，量同一批几何值做对比。
默认量本地「全部歌曲」页；加 --online 量在线歌单详情页。
"""
import json
import os
import sys
import urllib.request

BASE = 'http://localhost:20059'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER, PASSWORD = os.environ.get('GS_APP_USER', 'Slceleto'), os.environ.get('GS_APP_PASS', 'REDACTED')
ONLINE = '--online' in sys.argv

MEASURE = """() => {
  const tbl = document.querySelector('table.tracks')
  if (!tbl) return { err: 'no table' }
  const ths = [...tbl.querySelectorAll('thead th')]
  const head = ths.map(th => ({ cls: th.className, label: th.textContent.trim().slice(0,6),
                                x: Math.round(th.getBoundingClientRect().left), w: Math.round(th.getBoundingClientRect().width) }))
  const rows = [...tbl.querySelectorAll('tbody tr')].slice(0, 3).map(tr => {
    const tds = [...tr.children].map(td => ({ cls: td.className, x: Math.round(td.getBoundingClientRect().left),
                                              w: Math.round(td.getBoundingClientRect().width),
                                              txt: td.textContent.trim().slice(0,4) }))
    const pick = (sel) => { const e = tr.querySelector(sel); if (!e) return null
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height/2) } }
    const nameEl = tr.querySelector('td:nth-child(4) div')
    const nr = nameEl ? nameEl.getBoundingClientRect() : null
    return { tds, love: pick('.love .iconbtn'), dl: pick('.dl'),
             nameY: nr ? Math.round(nr.top + nr.height/2) : null,
             nameX: nr ? Math.round(nr.left) : null,
             h: Math.round(tr.getBoundingClientRect().height) }
  })
  const table = tbl.getBoundingClientRect()
  return { head, rows, tableW: Math.round(table.width), tableX: Math.round(table.left) }
}"""

req = urllib.request.Request(BASE + '/web/login', method='POST')
req.add_header('Content-Type', 'application/json')
with urllib.request.urlopen(req, json.dumps({'name': USER, 'password': PASSWORD}).encode(), timeout=30) as r:
    token = json.loads(r.read().decode())['data']['token']

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1440, 'height': 950})
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.evaluate("t => localStorage.setItem('gusi-web-token', t)", token)
    if ONLINE:
        # 在线歌单详情：走首页推荐用的同一个内部入口（__pendingRec），
        # 直接给咪咕那份 32 首歌单，拿到的就是用户看到的真实在线行
        page.goto(BASE + '/#/home')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        page.evaluate("""() => {
          window.__pendingRec = { source: 'mg', type: 'playlist', item: { id: '%s', name: '排版测量歌单' } }
          location.hash = '#/online'
        }""" % os.environ.get('GS_MEASURE_PL', '221603627'))
        page.wait_for_selector('table.tracks tbody tr', timeout=45000)
    else:
        page.goto(BASE + '/#/tracks')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_selector('table.tracks tbody tr', timeout=30000)
    page.mouse.move(4, 4)          # 移开鼠标，避免 hover 位移污染测量
    page.wait_for_timeout(200)
    data = page.evaluate(MEASURE)
    print(json.dumps(data, ensure_ascii=False, indent=1))
    shot = os.path.join(ROOT, 'tools/shot-align-%s.png' % ('online' if ONLINE else 'local'))
    page.screenshot(path=shot)
    print('截图:', shot)
    # 悬停第一行：行内下载键平时 opacity 0，只有 hover 才现形，位置要单独看一眼
    row = page.query_selector('table.tracks tbody tr')
    if row:
        box = row.bounding_box()
        page.mouse.move(box['x'] + box['width'] * 0.75, box['y'] + box['height'] / 2)
        page.wait_for_timeout(400)
        shot2 = os.path.join(ROOT, 'tools/shot-align-%s-hover.png' % ('online' if ONLINE else 'local'))
        page.screenshot(path=shot2)
        print('悬停截图:', shot2)
    b.close()
