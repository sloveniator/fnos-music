#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在线音乐页改版验证：默认「平台歌单广场」（不显示搜索框）+ 点「搜索」tab 出搜索框，
搜索支持 单曲 / 专辑 / 歌单 / 歌手（真实 Chromium + localhost:20059）

用法：
    python3 tools/e2e-online-plaza.py

覆盖：
  1. 服务端平台歌单 /web/api/online/rec-playlists：四个音源都有内容，且带 hint
  2. 「换一批」（batch）真的换内容：kw batch=0 与 batch=1 重叠率 < 80%
  3. 服务端歌手搜索 /web/api/online/search?type=artist：四个音源都返回歌手
  4. 酷我歌单详情 /web/api/online/collection?source=kw&type=playlist：曲目可解析
  5. 能力位：artist 四源齐全，playlist-detail 四源齐全（含咪咕）
  6. UI 默认视图：进 #/online 落在「歌单广场」tab，页面上没有搜索框，卡片 > 0
  7. UI 点「搜索」tab：出现搜索框 + 类型 chips（单曲/专辑/歌单/歌手）
  8. UI 搜歌手：歌手卡片渲染，点卡片自动按歌手名搜单曲并出结果行
  9. UI 歌单广场卡片可展开：点第一张进详情，出曲目行
 10. UI 换一批：点「换一批」后卡片集合变化
 11. UI 切音源（咪咕）：广场跟着换源，卡片可点开（无「暂不支持展开」角标）
"""
import json
import sys
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
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


def online_state(page):
    return page.evaluate("""() => {
      const tabs = Array.from(document.querySelectorAll('.otabs .otab')).map(b => ({
        t: b.textContent.trim(), on: b.classList.contains('on') }));
      const chips = Array.from(document.querySelectorAll('#view .onl-tools .chips .chip')).map(b => ({
        t: b.textContent.trim(), on: b.classList.contains('on') }));
      const typeChips = Array.from(document.querySelectorAll('#view .type-chips .chip')).map(b => ({
        t: b.textContent.trim(), on: b.classList.contains('on') }));
      return {
        tabs, chips, typeChips,
        hasSearchBox: !!document.querySelector('#view .search-box input'),
        plazaCards: document.querySelectorAll('#view .onl-area .coll-card').length,
        locked: document.querySelectorAll('#view .onl-area .coll-card .coll-lock').length,
        resInfo: (document.querySelector('#view .res-info') || {}).textContent || '',
        trackRows: document.querySelectorAll('#view .tracks tbody tr').length,
        artistCards: document.querySelectorAll('#view .artist-grid .artist-card').length,
      };
    }""")


def plaza_ids(page):
    return page.evaluate("""() => Array.from(document.querySelectorAll('#view .onl-area .coll-card .t'))
      .map(e => e.textContent.trim())""")


def main():
    token = login_token()

    print('\n== 1. 服务端：平台歌单（四源） ==')
    plaza = {}
    for s in ('kw', 'wy', 'mg', 'soda'):
        try:
            d = api('/api/online/rec-playlists?source=%s&limit=12&batch=0' % s, token)['data']
            plaza[s] = d
            names = [x['name'] for x in d['list']]
            check('%s 平台歌单有内容' % s, len(d['list']) >= 6, 'n=%d hint=%s | %s' % (
                len(d['list']), d.get('hint'), ' / '.join(names[:2])))
            check('%s 歌单字段完整' % s, all(x.get('id') and x.get('name') for x in d['list']))
        except Exception as e:
            plaza[s] = {'list': []}
            check('%s 平台歌单有内容' % s, False, repr(e)[:160])

    print('\n== 2. 「换一批」batch 真的换内容（kw） ==')
    try:
        a = [x['id'] for x in api('/api/online/rec-playlists?source=kw&limit=12&batch=0', token)['data']['list']]
        b = [x['id'] for x in api('/api/online/rec-playlists?source=kw&limit=12&batch=1', token)['data']['list']]
        inter = len(set(a) & set(b))
        check('kw batch0/batch1 内容不同', len(a) and len(b) and inter < 0.8 * max(len(a), 1),
              'overlap=%d/%d' % (inter, len(a)))
    except Exception as e:
        check('kw batch0/batch1 内容不同', False, repr(e)[:160])

    print('\n== 3. 服务端：歌手搜索（四源） ==')
    for s in ('kw', 'wy', 'mg', 'soda'):
        try:
            d = api('/api/online/search?source=%s&q=%s&type=artist&size=4' % (s, urllib.parse.quote('周杰伦')), token)['data']
            hit = [x['name'] for x in d['list']]
            check('%s 歌手搜索有结果' % s, len(d['list']) > 0, 'total=%s %s' % (d.get('total'), hit[:3]))
            check('%s 歌手字段完整' % s, all(x.get('id') and x.get('name') for x in d['list']))
        except Exception as e:
            check('%s 歌手搜索有结果' % s, False, repr(e)[:160])

    print('\n== 4. 服务端：酷我歌单详情（nplserver 通道） ==')
    kw_pl_id = next((x['id'] for x in plaza.get('kw', {}).get('list', []) if x.get('id')), '')
    if kw_pl_id:
        try:
            d = api('/api/online/collection?source=kw&type=playlist&id=%s' % kw_pl_id, token)['data']
            rows = d.get('list') or []
            check('酷我歌单可展开', len(rows) > 0, 'info=%s tracks=%s rows=%d' % (
                (d.get('info') or {}).get('name'), (d.get('info') or {}).get('trackCount'), len(rows)))
            check('酷我歌单曲目字段完整', all(r.get('id') and r.get('name') and r.get('singer') for r in rows),
                  (rows[0]['id'] + ' / ' + rows[0]['name']) if rows else '')
        except Exception as e:
            check('酷我歌单可展开', False, repr(e)[:200])
    else:
        skip('酷我歌单可展开', '平台歌单里没拿到 kw 歌单 id')

    print('\n== 5. 能力位 ==')
    try:
        srcs = {x['id']: x for x in api('/api/online/sources', token)['data']['sources']}
        for s in ('kw', 'wy', 'mg', 'soda'):
            ab = (srcs.get(s) or {}).get('abilities') or []
            check('%s 有 artists 能力' % s, 'artists' in ab, ','.join(ab))
        pl_detail = {s: ('playlist-detail' in ((srcs.get(s) or {}).get('abilities') or [])) for s in ('kw', 'wy', 'mg', 'soda')}
        # 咪咕歌单详情已接通（resourceinfo.do + resource/playlist/song/v2.0，两个通道都免签名），
        # 所以四源现在都该有 playlist-detail；咪咕专辑仍无公开通道，不影响这一位。
        check('playlist-detail 四源齐全（含咪咕）', all(pl_detail.values()), str(pl_detail))
    except Exception as e:
        check('能力位检查', False, repr(e)[:160])

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium',
                                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.on('pageerror', lambda e: print('      [pageerror]', e))
        login(page)
        goto(page, '#/online', 1500)

        print('\n== 6. UI 默认视图：歌单广场（无搜索框） ==')
        st = online_state(page)
        check('默认 tab 是「歌单广场」', any(t['t'] == '歌单广场' and t['on'] for t in st['tabs']), str(st['tabs']))
        check('tab 顺序：歌单广场 / 搜索', [t['t'] for t in st['tabs']][:2] == ['歌单广场', '搜索'], str([t['t'] for t in st['tabs']]))
        check('默认不显示搜索框', not st['hasSearchBox'])
        check('默认显示平台歌单卡片', st['plazaCards'] >= 6, 'cards=%d info=%s' % (st['plazaCards'], st['resInfo']))
        check('默认音源是酷我', any(c['t'] == '酷我音乐' and c['on'] for c in st['chips']), str(st['chips']))
        ids0 = plaza_ids(page)

        print('\n== 7. 点「搜索」tab：出搜索框 + 四类 chips ==')
        page.click('.otabs .otab:has-text("搜索")')
        page.wait_for_selector('#view .search-box input', timeout=15000)
        page.wait_for_timeout(400)
        st = online_state(page)
        check('搜索 tab 显示搜索框', st['hasSearchBox'])
        labels = [c['t'] for c in st['typeChips']]
        check('搜索类型 chips = 单曲/专辑/歌单/歌手', labels == ['单曲', '专辑', '歌单', '歌手'], str(labels))
        check('搜索 tab 不再显示歌单卡片', st['plazaCards'] == 0, 'cards=%d' % st['plazaCards'])

        print('\n== 8. 搜歌手 → 歌手卡片 → 点卡片出单曲 ==')
        page.click('#view .type-chips .chip:has-text("歌手")')
        page.wait_for_timeout(300)
        page.fill('#view .search-box input', '周杰伦')
        page.press('#view .search-box input', 'Enter')
        page.wait_for_selector('#view .artist-grid .artist-card', timeout=45000)
        page.wait_for_timeout(400)
        st = online_state(page)
        check('歌手卡片渲染', st['artistCards'] >= 1, 'cards=%d info=%s' % (st['artistCards'], st['resInfo']))
        check('歌手 tab 结果文案是「位歌手」', '位歌手' in st['resInfo'], st['resInfo'])
        first_name = page.eval_on_selector('#view .artist-grid .artist-card .t', 'e => e.textContent.trim()')
        page.click('#view .artist-grid .artist-card')
        page.wait_for_selector('#view .tracks tbody tr', timeout=45000)
        page.wait_for_timeout(500)
        st = online_state(page)
        check('点歌手卡片后自动搜出单曲', st['trackRows'] >= 3, 'rows=%d 歌手=%s' % (st['trackRows'], first_name))
        check('切回单曲 tab', any(c['t'] == '单曲' and c['on'] for c in st['typeChips']), str(st['typeChips']))

        print('\n== 9. 歌单广场卡片可展开（酷我） ==')
        page.click('.otabs .otab:has-text("歌单广场")')
        page.wait_for_selector('#view .onl-area .coll-card', timeout=30000)
        page.wait_for_timeout(500)
        pl_name = page.eval_on_selector('#view .onl-area .coll-card .t', 'e => e.textContent.trim()')
        page.click('#view .onl-area .coll-card')
        page.wait_for_selector('#view .tracks tbody tr', timeout=45000)
        page.wait_for_timeout(600)
        st = online_state(page)
        check('酷我歌单详情出曲目', st['trackRows'] >= 3, '歌单=%s rows=%d' % (pl_name, st['trackRows']))
        # 返回广场
        page.click('.board-head .btn')
        page.wait_for_timeout(1200)

        print('\n== 10. 换一批（UI） ==')
        page.wait_for_selector('#view .onl-area .coll-card', timeout=30000)
        page.wait_for_timeout(400)
        before = plaza_ids(page)
        page.click('#view .onl-area .res-head .btn:has-text("换一批")')
        page.wait_for_timeout(3000)
        after = plaza_ids(page)
        check('换一批后卡片集合变化', bool(before) and bool(after) and before != after,
              'before=%s -> after=%s' % (before[:2], after[:2]))

        print('\n== 11. 切音源（咪咕）广场跟着换 ==')
        page.click('#view .onl-tools .chips .chip:has-text("咪咕音乐")')
        page.wait_for_selector('#view .onl-area .coll-card', timeout=45000)
        page.wait_for_timeout(800)
        st = online_state(page)
        check('切到咪咕后仍有平台歌单', st['plazaCards'] >= 6, 'cards=%d info=%s' % (st['plazaCards'], st['resInfo']))
        check('咪咕歌单卡可点开（不再有「暂不支持展开」角标）', st['locked'] == 0,
              'locked=%d/%d' % (st['locked'], st['plazaCards']))
        check('页头说明跟着换源', '咪咕' in st['resInfo'], st['resInfo'])

        browser.close()

    print('\n===== 汇总：%d 通过 / %d 失败 / %d 跳过 =====' % (PASS, FAIL, SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
