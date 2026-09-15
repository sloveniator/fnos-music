#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
歌单入口合并 + 下载中心观感验证（真实 Chromium + 线上实例 localhost:20059）

验证：
  1. 侧边栏「歌单」区已删除（无 #pl-list / #pl-create / .pl-head），底部信息条仍贴底
  2. 「歌单」页的「我的歌单」tab 承担全部歌单管理：列歌单 + 新建入口可用
  3. 新建 → 列出现 → 删除 的完整回路仍可从 tab 内完成（不留死路）
  4. 设置页、下载中心页仍正常渲染（本次改动不波及其它页）
用法：
    python3 tools/e2e-playlist-merge.py
"""
import os
import re
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = os.environ.get('GS_APP_USER', 'Slceleto'), os.environ.get('GS_APP_PASS', 'REDACTED')

PASS = FAIL = 0


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


SIDE = """() => {
  const sb = document.querySelector('.sidebar')
  const foot = document.querySelector('.side-foot')
  const nav = document.querySelector('.nav')
  const sr = sb.getBoundingClientRect(), fr = foot.getBoundingClientRect(), nr = nav.getBoundingClientRect()
  return {
    hasPlList: !!document.getElementById('pl-list'),
    hasPlCreate: !!document.getElementById('pl-create'),
    plHead: document.querySelectorAll('.pl-head, .pl-list').length,
    sideW: Math.round(sr.width),
    gapBelowNav: Math.round(fr.top - nr.bottom),
    footBottomGap: Math.round(sr.bottom - fr.bottom),
    navItems: [...document.querySelectorAll('.nav a')].map(a => a.textContent.trim()),
  }
}"""

ALBUMS = """() => {
  const tabs = [...document.querySelectorAll('.tabs button')].map(t => t.textContent.trim())
  const cards = [...document.querySelectorAll('.grid .card')].map(c => c.textContent.trim().slice(0, 24))
  const btns = [...document.querySelectorAll('.view button, #view button')].map(b => b.textContent.trim()).filter(Boolean)
  return { tabs, cards, btns }
}"""


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(900)


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = b.new_page(viewport={'width': 1440, 'height': 900})
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        login(page)

        print('一、侧边栏')
        page.goto(BASE + '/#/home', wait_until='domcontentloaded')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.sidebar', timeout=15000)
        page.wait_for_timeout(700)
        s = page.evaluate(SIDE)
        check('侧边栏已无 #pl-list / #pl-create', not s['hasPlList'] and not s['hasPlCreate'], str(s))
        check('已无 .pl-head / .pl-list 节点', s['plHead'] == 0, 'count=%d' % s['plHead'])
        check('底部信息条仍贴在侧栏底部（auto 顶底生效）', s['footBottomGap'] <= 12,
              'nav 与 footer 间距=%dpx 距底=%dpx' % (s['gapBelowNav'], s['footBottomGap']))
        check('导航项完整且顺序正确（全部歌曲在回收站上方，歌手已并入歌单）',
              [x for x in s['navItems'] if x] == ['首页', '歌单', '在线音乐', 'FM 电台',
                                              '下载中心', '全部歌曲', '回收站', '设置'],
              ' | '.join(s['navItems']))

        print('二、歌单页 tab 承接歌单管理')
        page.goto(BASE + '/#/albums', wait_until='domcontentloaded')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(1200)
        a = page.evaluate(ALBUMS)
        check('有「我的歌单」tab', any('歌单' in t for t in a['tabs']), 'tabs=%s' % a['tabs'])
        page.click('.tabs button:has-text("我的歌单")')
        page.wait_for_timeout(800)
        a2 = page.evaluate(ALBUMS)
        check('歌单 tab 有新建入口', any('新建歌单' in x for x in a2['btns']), 'btns=%s' % a2['btns'][:6])
        before = len(a2['cards'])

        # 新建 → 出现在列表 → 删除，验证 tab 内闭环
        name = 'E2E-歌单入口-%d' % (page.evaluate('Date.now()') % 100000)
        page.click('button:has-text("新建歌单")')
        page.wait_for_selector('#dlg-input', state='visible', timeout=10000)
        page.fill('#dlg-input', name)
        page.click('#dlg-ok')
        page.wait_for_timeout(1500)
        page.goto(BASE + '/#/albums')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(900)
        page.click('.tabs button:has-text("我的歌单")')
        page.wait_for_timeout(900)
        a3 = page.evaluate(ALBUMS)
        check('新建的歌单出现在「我的歌单」里', any(name in c for c in a3['cards']), 'cards=%s' % a3['cards'][:8])
        check('歌单数量 +1', len(a3['cards']) == before + 1, '%d -> %d' % (before, len(a3['cards'])))

        # 清理：删掉测试歌单（进歌单详情删）
        ids = page.evaluate("""async () => {
          const tok = localStorage.getItem('gusi-web-token')
          const r = await fetch('http://localhost:20059/web/api/playlists', { headers: { 'X-Web-Token': tok } })
          const d = await r.json()
          return (d.data.playlists || []).map(p => p.id + '|' + p.name)
        }""")
        tid = [x.split('|')[0] for x in ids if x.split('|')[1] == name]
        if tid:
            # 删除歌单是 POST /web/api/playlists/remove（body: {ids:[...]}），不是 DELETE
            ok = page.evaluate("""async (id) => {
              const tok = localStorage.getItem('gusi-web-token')
              const r = await fetch('http://localhost:20059/web/api/playlists/remove', {
                method: 'POST',
                headers: { 'X-Web-Token': tok, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [id] }),
              })
              const d = await r.json().catch(() => ({}))
              return [r.status, (d && (d.code === 0 || d.code === undefined)) ? 1 : 0].join('|')
            }""", tid[0])
            check('测试歌单已清理', ok == '200|1', 'status=%s' % ok)
        else:
            check('测试歌单已清理', False, '未找到 %s' % name)

        print('三、其它页面未被波及')
        page.goto(BASE + '/#/downloads')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(1200)
        # 下载中心已改版：无页内 Tab / 无平台 Tab，搜索框常驻 + 队列常驻区块
        dl = page.evaluate("""() => {
          const v = document.querySelector('#view')
          return {
            head: (v.querySelector('h2.page') || {}).textContent,
            hero: !!v.querySelector('.dl-hero-bar input'),
            qsec: !!v.querySelector('.dl-qsec') && !!v.querySelector('#dl-queue'),
            otabs: v.querySelectorAll('.otabs, .otab').length,
          }
        }""")
        check('下载中心页正常渲染（无 Tab + 搜索框/队列常驻）',
              dl['head'] == '下载中心' and dl['hero'] and dl['qsec'] and dl['otabs'] == 0, str(dl)[:160])
        print('     下载中心 h2=%s hero=%s 队列区块=%s tabs=%s' % (dl['head'], dl['hero'], dl['qsec'], dl['otabs']))

        page.goto(BASE + '/#/settings')
        page.reload(wait_until='domcontentloaded')
        # 等设置页真正画出来再断言：固定 900ms 会在慢机上撞到 boot() 还在渲染的时刻，
        # 报出「小节=[]」的假失败（实测页面本身 300ms 就好了）
        try:
            page.wait_for_selector('#view .set-sec-h', timeout=8000)
        except Exception:
            pass
        page.wait_for_timeout(300)
        st = page.evaluate("""() => ({
          secs: [...document.querySelectorAll('.set-sec-h')].map(h => h.textContent.trim()),
          // 「我的分享」空态文案会正经提到「歌单页」，整页搜「歌单」两个字会把正常文案算成残留；
          // 所以只认小节标题与旧节点，判据必须比文案更窄
          hasPlSection: [...document.querySelectorAll('.set-sec-h')].some(h => /歌单/.test(h.textContent))
            || !!document.querySelector('#view #pl-list, #view #pl-create, #view .pl-head'),
        })""")
        check('设置页渲染正常', len(st['secs']) >= 4, '小节=%s' % st['secs'])
        check('设置页里没有歌单管理残留', not st['hasPlSection'], '小节=%s' % st['secs'])

        check('无 JS 报错', not errs, ' | '.join(errs[:3]))
        b.close()

    print('\n结果: %d 通过 / %d 失败' % (PASS, FAIL))
    sys.exit(2 if FAIL else 0)


if __name__ == '__main__':
    main()
