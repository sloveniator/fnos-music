# -*- coding: utf-8 -*-
"""下载中心界面验收（真实 Chromium + 线上实例 localhost:20059）

本次改动：去掉「搜索/下载队列」两个 Tab 与四个平台 Tab，搜索框常驻在顶部 Hero，
跨源聚合搜索（同一首歌合并成一行，行内下拉可切换下载源），队列改为常驻区块。

验证：
  1. 平台 Tab / 页内 Tab 全部消失，搜索框只此一个
  2. Hero：搜索框 + 已启用平台提示 + 容量统计行
  3. 回车搜索走跨源聚合：结果行 > 0，统计行含「N 首」与各平台命中数
  4. 同曲多源行出现「源切换下拉」，切换后时长/源随之变化（不重绘整表）
  5. 全选 → 已选计数 = 行数、批量下载按钮可用（不真入队，避免污染队列）
  6. 队列区块常驻可见（无 Tab 也能看到）
  7. 桌面 + 390x844 截图，无 JS 报错
用法：
    python3 tools/e2e-dl-ui.py
"""
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
SHOT_DESK = '/tmp/dl-desktop.png'
SHOT_MOB = '/tmp/dl-mobile.png'

PASS = FAIL = 0


def check(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  ' + extra) if extra else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  ' + extra) if extra else ''))


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

        print('一、页面骨架：无 Tab、搜索框常驻')
        page.goto(BASE + '/#/downloads', wait_until='domcontentloaded')
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.dl-hero-bar input', timeout=15000)
        page.wait_for_timeout(1200)
        sk = page.evaluate("""() => {
          const v = document.querySelector('#view')
          const txt = v.textContent
          return {
            h2: (v.querySelector('h2.page') || {}).textContent,
            otabs: v.querySelectorAll('.otabs, .otab').length,
            dlOtabs: v.querySelectorAll('.dl-otabs').length,
            inputs: v.querySelectorAll('.dl-hero-bar input').length,
            allText: v.querySelectorAll('input[type=text], input[type=search]').length,
            chips: [...v.querySelectorAll('.chip, .chips button')].map(c => c.textContent.trim()),
            hasQueue: !!v.querySelector('.dl-qsec') && !!v.querySelector('#dl-queue'),
            tip: (v.querySelector('.dl-hero-tip') || {}).textContent || '',
            meta: (v.querySelector('#dl-meta') || {}).textContent || '',
            qhead: (v.querySelector('.dl-qtitle') || {}).textContent || '',
            qcount: (v.querySelector('#dl-qcount') || {}).textContent || '',
            platformMentions: ['酷我', '网易', '咪咕', '汽水'].filter(n => txt.includes(n)).length,
            oldTabLabels: /⏬ 下载队列|🔍 搜索/.test(txt),
          }
        }""")
        check('页面标题为「下载中心」', sk['h2'] == '下载中心', 'h2=%s' % sk['h2'])
        check('页内 Tab 已移除（.otabs/.otab = 0）', sk['otabs'] == 0 and sk['dlOtabs'] == 0,
              'otabs=%s dl-otabs=%s' % (sk['otabs'], sk['dlOtabs']))
        check('搜索框唯一（1 个）', sk['inputs'] == 1 and sk['allText'] == 1,
              'hero=%s 全页=%s' % (sk['inputs'], sk['allText']))
        check('旧的「搜索 / 下载队列」Tab 文案已消失', sk['oldTabLabels'] is False)
        check('平台 Tab 已移除（搜索区无 chip 按钮）', '酷我' not in sk['chips'] and '网易云音乐' not in sk['chips'],
              'chips=%s' % sk['chips'])
        check('已启用平台改为提示文案', all(n in sk['tip'] for n in ['酷我', '网易', '咪咕', '汽水']),
              sk['tip'][:80])
        check('容量/统计行仍在', ('首' in sk['meta']) and ('GB' in sk['meta']), sk['meta'][:80])
        check('队列区块常驻可见', sk['hasQueue'] and sk['qhead'] == '下载队列', sk['qcount'])
        check('页面无 JS 报错', not errs, str(errs)[:160])
        page.screenshot(path=SHOT_DESK, full_page=False)

        print('二、跨源聚合搜索')
        page.fill('.dl-hero-bar input', '告白气球')
        page.press('.dl-hero-bar input', 'Enter')
        page.wait_for_selector('.dl-res-tbl tbody tr', timeout=20000)
        page.wait_for_timeout(400)
        r = page.evaluate("""() => {
          const rows = [...document.querySelectorAll('.dl-res-tbl tbody tr')]
          const sels = [...document.querySelectorAll('.dl-res-tbl .dl-src-sel')]
          const info = (document.querySelector('.dl-res-info') || {}).textContent || ''
          const tags = [...document.querySelectorAll('.dl-res-tbl .dl-src-tag')].map(x => x.textContent.trim())
          return {
            n: rows.length, sels: sels.length, info,
            first: rows[0] ? rows[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) : '',
            tags: tags.slice(0, 6),
            firstSelOptions: sels[0] ? [...sels[0].options].map(o => o.textContent) : [],
            firstSelValue: sels[0] ? sels[0].value : '',
            firstDur: rows[0] ? (rows[0].querySelector('.dur') || {}).textContent : '',
          }
        }""")
        check('搜索结果非空', r['n'] > 0, 'rows=%d 首行=%s' % (r['n'], r['first']))
        check('统计行含关键词/总数/平台命中数',
              all(k in r['info'] for k in ['告白气球', '首', '酷我']) and len(r['info']) > 12, r['info'][:110])
        check('同曲多源行给出源切换下拉', r['sels'] > 0,
              '下拉=%d 选项=%s 单源标签=%s' % (r['sels'], r['firstSelOptions'], r['tags']))
        if r['sels'] > 0:
            other = [o for o in r['firstSelOptions'] if o != r['firstSelValue']]
            page.select_option('.dl-res-tbl .dl-src-sel', index=1)
            page.wait_for_timeout(250)
            after = page.evaluate("""() => {
              const row = document.querySelector('.dl-res-tbl tbody tr')
              const sel = row.querySelector('.dl-src-sel')
              return { val: sel.value, dur: (row.querySelector('.dur') || {}).textContent,
                       rows: document.querySelectorAll('.dl-res-tbl tbody tr').length }
            }""")
            check('切换下载源后就地更新（行数不变、源已变）',
                  after['val'] != r['firstSelValue'] and after['rows'] == r['n'],
                  '%s → %s  时长 %s → %s' % (r['firstSelValue'], after['val'], r['firstDur'], after['dur']))
            check('切换后时长单元格同步', bool(after['dur']) and len(after['dur']) == len(r['firstDur']),
                  '%s vs %s' % (r['firstDur'], after['dur']))

        print('三、批量条（只校验状态，不真入队）')
        page.click('#dl-search-check-all')
        page.wait_for_timeout(300)
        bt = page.evaluate("""() => {
          const bar = document.querySelector('.dl-search-batch-bar')
          return { cnt: bar.querySelector('.dl-sel-count').textContent,
                   disabled: bar.querySelector('[data-op="enqueue"]').disabled }
        }""")
        check('全选计数 = 结果行数', bt['cnt'] == '已选 %d 首' % r['n'], bt['cnt'])
        check('批量下载按钮变为可用', bt['disabled'] is False)
        page.click('#dl-search-check-all')
        page.wait_for_timeout(200)

        print('四、手机端布局')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(500)
        m = page.evaluate("""() => {
          const v = document.querySelector('#view')
          const hero = document.querySelector('.dl-hero-bar')
          const btn = document.querySelector('.dl-hero-btn')
          return {
            heroW: Math.round(hero.getBoundingClientRect().width),
            btnW: Math.round(btn.getBoundingClientRect().width),
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            qsecVisible: !!v.querySelector('.dl-qsec'),
            rowW: Math.round((document.querySelector('.dl-res-tbl tbody tr') || {getBoundingClientRect: () => ({width: 0})}).getBoundingClientRect().width),
          }
        }""")
        check('390px 无横向溢出', m['overflowX'] is False, 'heroW=%s btnW=%s' % (m['heroW'], m['btnW']))
        check('窄屏队列区块仍在', m['qsecVisible'])
        page.screenshot(path=SHOT_MOB, full_page=False)

        check('全程无 JS 报错', not errs, str(errs)[:200])
        b.close()

    print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
    print('截图：%s  %s' % (SHOT_DESK, SHOT_MOB))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
