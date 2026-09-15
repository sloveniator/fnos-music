#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断表格列结构：表头/每行单元格数量、每格 x/宽、table-layout 计算值。"""
import json
import os
import sys
import urllib.request

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
HASH = sys.argv[1] if len(sys.argv) > 1 else '#/tracks'
ONLINE_PL = os.environ.get('GS_MEASURE_PL', '221603627')

req = urllib.request.Request(BASE + '/web/login', method='POST')
req.add_header('Content-Type', 'application/json')
with urllib.request.urlopen(req, json.dumps({'name': USER, 'password': PASSWORD}).encode(), timeout=30) as r:
    token = json.loads(r.read().decode())['data']['token']

from playwright.sync_api import sync_playwright  # noqa: E402

DUMP = """() => {
  const tbl = document.querySelector('table.tracks')
  if (!tbl) return { err: 'no table' }
  const cs = getComputedStyle(tbl)
  const info = (row, tag) => [...row.children].map(td => {
    const r = td.getBoundingClientRect()
    return { tag, cls: (td.className || '-'), x: Math.round(r.left), w: Math.round(r.width), pad: getComputedStyle(td).padding, ta: getComputedStyle(td).textAlign }
  })
  return {
    tableLayout: cs.tableLayout, tableW: Math.round(tbl.getBoundingClientRect().width),
    tableX: Math.round(tbl.getBoundingClientRect().left),
    thead: [...tbl.tHead.rows].map(r => ({ n: r.children.length, cells: info(r, 'th') })),
    tbody: [...tbl.tBodies[0].rows].slice(0, 3).map(r => ({ n: r.children.length, cells: info(r, 'td') })),
  }
}"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1440, 'height': 950})
    page.goto(BASE + '/#/home')
    page.evaluate("t => localStorage.setItem('gusi-web-token', t)", token)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    if HASH == '#/online-detail':
        page.evaluate("""() => {
          window.__pendingRec = { source: 'mg', type: 'playlist', item: { id: '%s', name: '排版测量歌单' } }
          location.hash = '#/online'
        }""" % ONLINE_PL)
    else:
        page.evaluate("h => { location.hash = h }", HASH)
    page.wait_for_selector('table.tracks tbody tr', timeout=45000)
    page.mouse.move(4, 4)
    page.wait_for_timeout(300)
    print(json.dumps(page.evaluate(DUMP), ensure_ascii=False, indent=0))
    b.close()
