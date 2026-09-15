#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后台排版体检：登录管理后台，截侧栏与整页，量 brand/side-foot/nav 的几何。"""
import json
import os
import sys
import urllib.request

BASE = 'http://localhost:20059'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PWD = os.environ.get('GS_ADMIN_PASSWORD', 'REDACTED')

data = json.dumps({'password': PWD}).encode()
req = urllib.request.Request(BASE + '/admin/login', data=data, method='POST')
req.add_header('Content-Type', 'application/json')
with OPENER.open(req, data, timeout=30) as r:
    tok = json.loads(r.read().decode())['token']
print('admin token ok')

from playwright.sync_api import sync_playwright

VIEWS = [(1440, 950), (1280, 800), (900, 800), (390, 844)]
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for w, h in VIEWS:
        page = b.new_page(viewport={'width': w, 'height': h})
        page.goto(BASE + '/admin/', wait_until='domcontentloaded')
        page.evaluate("t => localStorage.setItem('gusi-admin-token', t)", tok)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(1500)
        info = page.evaluate("""() => {
          const q = (s) => document.querySelector(s)
          const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) } }
          const sb = q('#sidebar'), sf = q('.side-foot'), links = q('.side-foot .side-links')
          const who = q('#who'), app = q('.side-foot a'), out = q('.side-foot button')
          const overflow = (el) => el ? { scrollW: el.scrollWidth, clientW: el.clientWidth } : null
          return {
            sidebar: r(sb), brand: r(q('.brand')), nav: r(q('#nav')),
            who: Object.assign(r(who) || {}, { txt: who ? who.textContent : null, hidden: who ? getComputedStyle(who).display : null }),
            whoOverflow: overflow(who),
            sideFoot: Object.assign(r(sf) || {}, overflow(sf) || {}),
            links: Object.assign(r(links) || {}, overflow(links) || {}),
            app: Object.assign(r(app) || {}, { txt: app ? app.textContent : null }),
            out: Object.assign(r(out) || {}, { txt: out ? out.textContent : null }),
            sidebarOverflowY: sb ? { scrollH: sb.scrollHeight, clientH: sb.clientHeight } : null,
            docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
          }
        }""")
        print('\n=== %dx%d ===' % (w, h))
        print(json.dumps(info, ensure_ascii=False, indent=1))
        if os.environ.get('GS_ADMIN_TAB'):
            page.evaluate('t => document.querySelector("[data-tab=\'" + t + "\']").click()', os.environ["GS_ADMIN_TAB"])
            page.wait_for_timeout(2000)
        tag = os.environ.get('GS_ADMIN_TAG', 'side')
        page.screenshot(path='/app/working/workspaces/fnos-music/project/fnos-music/tools/shot-admin-%s-%d.png' % (tag, w))
        page.close()
    b.close()
print('截图: tools/shot-admin-side-1440.png / -1280 / -900 / -390')
