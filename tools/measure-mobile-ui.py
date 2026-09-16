#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量手机端关键视觉尺寸（封面 / 字号），用于「等比缩放」前后对比。

用法：python3 tools/measure-mobile-ui.py [w] [h]
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
W = int(sys.argv[1]) if len(sys.argv) > 1 else 390
H = int(sys.argv[2]) if len(sys.argv) > 2 else 844

JS = """() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null
    const b = e.getBoundingClientRect(); return Math.round(b.width * 10) / 10 }
  const fs = (sel) => { const e = document.querySelector(sel); if (!e) return null
    return Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10 }
  const gcols = (sel) => { const e = document.querySelector(sel); if (!e) return null
    return getComputedStyle(e).gridTemplateColumns.split(' ').length }
  return {
    vw: document.documentElement.clientWidth,
    gridCols: gcols('.grid'), gridMin: getComputedStyle(document.documentElement).getPropertyValue('--grid-min').trim(),
    cardCover: r('.grid .card .cover'), cardT: fs('.grid .card .t'), recCover: r('.rec-grid .card .cover'),
    recCols: gcols('.rec-grid'),
    fyCov: r('.fy-cov'), fyName: fs('.fy-name'), fyReason: fs('.fy-reason'),
    h2: fs('h2.page'), h3: fs('.row-head h3'), body: fs('body'),
    chipFs: fs('.chip'), chipH: r('.chip'), otabFs: fs('.otab'), otabH: r('.otab'),
    tdFs: fs('.tracks td'), btnFs: fs('.btn'), collHeroCover: r('.coll-hero .cover'), heroCover: r('.hero .cover'),
    fmCard: r('.fm-card'), fmNm: fs('.fm-nm'), fmDs: fs('.fm-ds'),
  }
}"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=2)
        page.goto(BASE + '/', wait_until='domcontentloaded')
        page.wait_for_selector('#login', state='visible', timeout=20000)
        page.fill('#login-name', USER)
        page.fill('#login-pass', PASSWORD)
        page.click('#login-btn')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        page.wait_for_timeout(600)
        print('== %dx%d：首页 ==' % (W, H))
        page.evaluate("() => { location.hash = '#/home' }")
        page.wait_for_timeout(2600)
        m = page.evaluate(JS)
        print('  推荐歌单 列数=%s 封面=%s 卡标题字号=%s | 为你推荐 封面=%s 标题=%s 说明=%s' %
              (m['recCols'], m['recCover'], m['cardT'], m['fyCov'], m['fyName'], m['fyReason']))
        print('  页面标题=%s 区块标题=%s body=%s' % (m['h2'], m['h3'], m['body']))
        print('== %dx%d：在线音乐 ==' % (W, H))
        page.evaluate("() => { location.hash = '#/online' }")
        page.wait_for_timeout(3500)
        m = page.evaluate(JS)
        print('  歌单卡 列数=%s 封面=%s 卡标题字号=%s | chip=%s/%s otab=%s/%s | 集合页头封面=%s' %
              (m['gridCols'], m['cardCover'], m['cardT'], m['chipFs'], m['chipH'], m['otabFs'], m['otabH'],
               m['collHeroCover']))
        print('== %dx%d：FM ==' % (W, H))
        page.evaluate("() => { location.hash = '#/fm' }")
        page.wait_for_timeout(3500)
        m = page.evaluate(JS)
        print('  频道卡=%s 标题字号=%s 说明字号=%s' % (m['fmCard'], m['fmNm'], m['fmDs']))
        print('== %dx%d：全部歌曲 ==' % (W, H))
        page.evaluate("() => { location.hash = '#/tracks' }")
        page.wait_for_timeout(1600)
        m = page.evaluate(JS)
        print('  列表字号=%s 按钮字号=%s' % (m['tdFs'], m['btnFs']))
        b.close()


if __name__ == '__main__':
    main()
