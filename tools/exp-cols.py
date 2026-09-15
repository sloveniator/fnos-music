#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""注入式实验：对比三种列模板在同一张本地曲目表上的几何结果。

A 现状（auto 布局）
B table-layout:fixed + 歌曲/专辑百分比
C fixed + 尾部 pad 吸收列
只改浏览器里的样式/DOM，不改源码；用来定方案。
"""
import json
import urllib.request

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'

req = urllib.request.Request(BASE + '/web/login', method='POST')
req.add_header('Content-Type', 'application/json')
with urllib.request.urlopen(req, json.dumps({'name': USER, 'password': PASSWORD}).encode(), timeout=30) as r:
    token = json.loads(r.read().decode())['data']['token']

CSS_B = """
table.tracks { table-layout: fixed; }
table.tracks thead th:nth-child(4) { width: 32%; }
table.tracks thead th:nth-child(5) { width: 18%; }
table.tracks thead th:nth-child(6) { width: 48px; }
table.tracks thead th:nth-child(7) { width: 64px; }
table.tracks thead th:nth-child(8) { width: 48px; }
table.tracks .dur { text-align: right; }
"""

GEOM = """() => {
  const tbl = document.querySelector('table.tracks')
  const r = tbl.getBoundingClientRect()
  const cells = [...tbl.tBodies[0].rows[0].children].map(td => {
    const b = td.getBoundingClientRect()
    return { cls: td.className || '-', x: Math.round(b.left), w: Math.round(b.width) }
  })
  // 空洞：相邻单元格右边与下一个左边之间的空隙
  let gaps = []
  for (let i = 1; i < cells.length; i++) {
    const g = cells[i].x - (cells[i-1].x + cells[i-1].w)
    if (Math.abs(g) > 1) gaps.push((cells[i-1].cls||'?') + '→' + (cells[i].cls||'?') + ':' + g)
  }
  return { tableW: Math.round(r.width), cells, gaps, sumW: cells.reduce((s,c)=>s+c.w,0) }
}"""

with_sync = None
from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1440, 'height': 950})
    page.goto(BASE + '/#/home')
    page.evaluate("t => localStorage.setItem('gusi-web-token', t)", token)
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.evaluate("() => { location.hash = '#/tracks' }")
    page.wait_for_selector('table.tracks tbody tr', timeout=30000)

    def show(tag):
        page.mouse.move(4, 4)
        page.wait_for_timeout(200)
        d = page.evaluate(GEOM)
        print('--- %s --- 表宽 %d 列宽合计 %d' % (tag, d['tableW'], d['sumW']))
        print('   ', ' '.join('%s[x=%d,w=%d]' % (c['cls'][:10], c['x'], c['w']) for c in d['cells']))
        print('    空洞:', d['gaps'] or '无')

    show('A 现状 auto')

    page.add_style_tag(content=CSS_B)
    show('B fixed + 百分比')

    # C：在 B 基础上给表头/每行补一个尾部 pad 单元格
    page.evaluate("""() => {
      const tbl = document.querySelector('table.tracks')
      const th = document.createElement('th'); th.className = 'pad-col'
      tbl.tHead.rows[0].appendChild(th)
      for (const tr of tbl.tBodies[0].rows) {
        const td = document.createElement('td'); td.className = 'pad-col'
        tr.appendChild(td)
      }
      const st = document.createElement('style')
      st.textContent = 'table.tracks .pad-col { width: auto }'
      document.head.appendChild(st)
    }""")
    show('C fixed + pad 吸收列')

    # D：pad 列改到「操作」之前（让操作组贴住内容）
    page.evaluate("""() => {
      const tbl = document.querySelector('table.tracks')
      const move = (row) => {
        const pad = row.lastElementChild
        const acts = pad.previousElementSibling
        row.insertBefore(pad, acts)
      }
      move(tbl.tHead.rows[0])
      for (const tr of tbl.tBodies[0].rows) move(tr)
    }""")
    show('D pad 移到 acts 之前')

    page.screenshot(path='tools/shot-exp-cols.png')
    b.close()
