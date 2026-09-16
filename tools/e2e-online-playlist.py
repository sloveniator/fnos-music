#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在线歌单详情验证：咪咕歌单能打开 + 行内只留下载按钮 + 整行点击播放的是这一行。

用法：
    python3 tools/e2e-online-playlist.py

覆盖：
  1. 服务端能力位：mg 有 playlist-detail
  2. 服务端 /web/api/online/collection?source=mg&type=playlist：元信息 + 曲目数对上
  3. 服务端咪咕歌单曲目字段完整（source/id/name/singer/intervalMs）
  4. 服务端导入：咪咕歌单链接能被 importOnlineUrl 识别并拉全量
  5. UI：咪咕广场卡片可点开，详情页出曲目行
  6. UI：曲目行右侧只剩 1 个按钮，且 title=下载
  7. UI：行内没有「播放」「下一首播放」按钮
  8. UI：点第 3 行 → 底栏正在播放的就是第 3 行那首歌（回归：原来播的是搜索列表）
  9. UI：下载按钮与歌曲名垂直居中对齐（|ΔcenterY| <= 3px）
 10. UI：酷我歌单同样「点哪行播哪行」（同一 bug 的回归）
 11. UI：点下载按钮不会顺带播放（stopPropagation 生效）
"""
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', _APP_PASS
PASS = FAIL = SKIP = 0


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


def skip(name, why):
    global SKIP
    SKIP += 1
    print('  [SKIP] %s  -- %s' % (name, why))


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, token=None):
    req = urllib.request.Request(BASE + '/web' + path)
    if token:
        req.add_header('X-Web-Token', token)
    with _opener.open(req, timeout=90) as r:
        return json.loads(r.read().decode())


def login_token():
    req = urllib.request.Request(BASE + '/web/login', method='POST')
    req.add_header('Content-Type', 'application/json')
    with _opener.open(req, json.dumps({'name': USER, 'password': PASSWORD}).encode(), timeout=30) as r:
        return json.loads(r.read().decode())['data']['token']


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(600)


def goto(page, h, wait=1200):
    page.evaluate("h => { if (location.hash !== h) location.hash = h }", h)
    page.wait_for_timeout(wait)


def switch_source(page, label):
    page.click('#view .onl-tools .chips .chip:has-text("%s")' % label)
    page.wait_for_timeout(1500)


def open_first_playlist(page):
    """点开广场第一张卡片，返回详情页曲目行数"""
    page.wait_for_selector('#view .onl-area .coll-card', timeout=45000)
    page.wait_for_timeout(500)
    page.click('#view .onl-area .coll-card')
    page.wait_for_selector('#view .tracks tbody tr', timeout=45000)
    page.wait_for_timeout(500)
    return page.eval_on_selector_all('#view .tracks tbody tr', 'els => els.length')


def rows_info(page):
    """每行：歌名 + 行内按钮的 title 列表"""
    return page.evaluate("""() => Array.from(document.querySelectorAll('#view .tracks tbody tr')).map(tr => {
      const tds = tr.querySelectorAll('td');
      const nameTd = tds[3];
      return {
        name: nameTd ? (nameTd.querySelector('div') || {}).textContent.trim() : '',
        btns: Array.from(tr.querySelectorAll('td.dl-col button')).map(b => b.title),
      };
    })""")


def now_playing(page):
    return page.evaluate("""() => ({
      name: (document.getElementById('np-name') || {}).textContent || '',
      singer: (document.getElementById('np-singer') || {}).textContent || '',
      cur: (window.__player && window.__player.cur) ? window.__player.cur.name : null,
      paused: (window.__player && window.__player.audio) ? window.__player.audio.paused : null,
    })""")


def click_row(page, idx):
    """点第 idx 行（1 起）的歌曲名单元格，避开按钮与复选框"""
    page.eval_on_selector('#view .tracks tbody tr:nth-child(%d) td:nth-child(4)' % idx, 'el => el.click()')
    page.wait_for_timeout(1500)


def main():
    token = login_token()

    print('\n== 1. 能力位 ==')
    try:
        srcs = {x['id']: x for x in api('/api/online/sources', token)['data']['sources']}
        ab = (srcs.get('mg') or {}).get('abilities') or []
        check('mg 有 playlist-detail 能力', 'playlist-detail' in ab, ','.join(ab))
    except Exception as e:
        check('能力位检查', False, repr(e)[:160])

    print('\n== 2. 服务端：咪咕歌单详情 ==')
    mg_id = '221603627'
    try:
        d = api('/api/online/collection?source=mg&type=playlist&id=%s' % mg_id, token)['data']
        info, lst = d['info'], d['list']
        check('歌单元信息完整', bool(info.get('name')) and info.get('source') == 'mg',
              '%s | %s | %s 首' % (info.get('name'), info.get('creator'), info.get('trackCount')))
        check('曲目数 >= 20', len(lst) >= 20, 'n=%d / 声明 %s' % (len(lst), info.get('trackCount')))
        check('曲目字段完整', all(x.get('id') and x.get('name') and x.get('singer') and x.get('intervalMs') for x in lst),
              json.dumps(lst[0], ensure_ascii=False)[:120])
        check('曲目 id 是咪咕数字 songId', all(x['id'].isdigit() for x in lst))
    except Exception as e:
        check('咪咕歌单详情', False, repr(e)[:200])

    print('\n== 3. 服务端：咪咕歌单链接导入 ==')
    try:
        d = api('/api/online/import?url=%s' % urllib.request.quote('https://music.migu.cn/v3/music/playlist/%s' % mg_id), token)['data']
        check('导入识别为咪咕歌单', d.get('source') == 'mg' and d.get('type') == 'playlist', '%s/%s' % (d.get('source'), d.get('type')))
        check('导入拉到全量曲目', len(d.get('list') or []) >= 20, 'n=%d' % len(d.get('list') or []))
    except Exception as e:
        check('咪咕歌单链接导入', False, repr(e)[:200])

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium',
                                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        login(page)

        print('\n== 4. UI：咪咕歌单能点开 ==')
        goto(page, '#/online', 2000)
        switch_source(page, '咪咕音乐')
        try:
            n = open_first_playlist(page)
            check('咪咕广场卡片可点开（无「暂不支持展开」）', n >= 10, 'rows=%d' % n)
            locked = page.eval_on_selector_all('#view .onl-area .coll-lock', 'els => els.length')
            check('广场卡片无锁定角标', locked == 0, 'locked=%d' % locked)
        except Exception as e:
            check('咪咕歌单点开', False, repr(e)[:200])
            browser.close()
            print('\n===== 汇总：%d 通过 / %d 失败 / %d 跳过 =====' % (PASS, FAIL, SKIP))
            return 1

        print('\n== 5. UI：行内按钮只剩下载（下载键独立成 dl-col 列） ==')
        rows = rows_info(page)
        check('详情页有曲目行', len(rows) >= 10, 'rows=%d' % len(rows))
        titles = [t for r in rows for t in r['btns']]
        check('每行恰好 1 个按钮', all(len(r['btns']) == 1 for r in rows),
              '每行按钮数=%s' % sorted(set(len(r['btns']) for r in rows)))
        check('按钮 title 全是「下载」', all(t == '下载' for t in titles), ','.join(sorted(set(titles))))
        check('没有「播放」/「下一首播放」按钮', not any('播放' in t for t in titles))

        print('\n== 6. UI：点哪行播哪行（咪咕） ==')
        target = rows[2]['name']
        click_row(page, 3)
        np = now_playing(page)
        check('底栏正在播放 = 第 3 行那首', np['cur'] == target or np['name'] == target,
              'row3=%s | np=%s | cur=%s' % (target, np['name'], np['cur']))

        print('\n== 7. UI：下载按钮与歌曲对齐 ==')
        try:
            geo = page.evaluate("""() => {
              const tr = document.querySelector('#view .tracks tbody tr:nth-child(3)');
              const nameTd = tr.querySelector('td.name-col') || tr.children[3];
              const btn = tr.querySelector('td.dl-col button');
              // 歌名格是两行（歌名 + 歌手 sub），拿「第一行」去比会天然差半行；
              // 要比的是按钮在整格内容块里是否垂直居中。
              const kids = [...nameTd.children].map(k => k.getBoundingClientRect());
              const top = Math.min(...kids.map(r => r.top));
              const bottom = Math.max(...kids.map(r => r.bottom));
              const nameCy = (top + bottom) / 2;
              const b = btn.getBoundingClientRect();
              const btnCy = b.top + b.height / 2;
              return { nameCy, btnCy, dh: Math.abs(nameCy - btnCy), lines: kids.length };
            }""")
            check('下载按钮在歌名格内容里垂直居中', geo['dh'] <= 3,
                  'ΔcenterY=%.1fpx (歌名格中心 %.1f / 按钮 %.1f / %d 行)' % (geo['dh'], geo['nameCy'], geo['btnCy'], geo['lines']))
        except Exception as e:
            check('对齐测量', False, repr(e)[:160])

        print('\n== 8. UI：点下载不触发播放 ==')
        before = now_playing(page)
        try:
            page.eval_on_selector('#view .tracks tbody tr:nth-child(5) td.dl-col button', 'el => el.click()')
            page.wait_for_timeout(1200)
            after = now_playing(page)
            check('点下载后没有换成第 5 行', after['cur'] == before['cur'],
                  'before=%s after=%s' % (before['cur'], after['cur']))
            # 关掉可能弹出的下载面板，避免影响后续步骤
            page.evaluate("""() => { document.querySelectorAll('.menu.pop, .modal').forEach(e => e.remove()) }""")
            page.wait_for_timeout(300)
        except Exception as e:
            check('点下载不播放', False, repr(e)[:160])

        print('\n== 9. UI：酷我歌单回归（同一 bug） ==')
        try:
            page.evaluate("""() => { document.querySelectorAll('.menu.pop').forEach(e => e.remove()) }""")
            switch_source(page, '酷我音乐')
            n = open_first_playlist(page)
            rows = rows_info(page)
            check('酷我歌单详情出曲目行', n >= 5 and len(rows) >= 5, 'rows=%d' % n)
            target = rows[1]['name']
            click_row(page, 2)
            np = now_playing(page)
            check('酷我点第 2 行播的是第 2 行', np['cur'] == target or np['name'] == target,
                  'row2=%s | np=%s | cur=%s' % (target, np['name'], np['cur']))
        except Exception as e:
            check('酷我回归', False, repr(e)[:200])

        page.screenshot(path='tools/shot-online-playlist-rows.png')
        browser.close()

    print('\n===== 汇总：%d 通过 / %d 失败 / %d 跳过 =====' % (PASS, FAIL, SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
