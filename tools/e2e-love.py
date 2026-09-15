#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「喜欢」功能（本地 + 在线曲目都能加进「我喜欢」）验证（真实 Chromium + localhost:20059）

用法：
    python3 tools/e2e-love.py

覆盖：
  1. 服务端 /web/api/love/toggle 在线分支：落库成洛雪 MusicInfo（id=<source>_<rid>、meta.songId/picUrl）
  2. 参数校验：未知音源 / 非法 rid / 不存在的本地曲目 一律 400，不会写脏数据
  3. /web/api/love-ids 同时返回本地与在线两种 id；取消后立即消失
  4. /web/api/love/add 批量收藏本地曲目（去重、无效 id 跳过）
  5. /web/api/playlists/love 里在线曲目带 source/id（前端据此解析直链，可播）
  6. 桌面 #/search 在线结果行：心形可点 → 变红 → 接口状态一致
  7. 桌面 在线音乐页（酷我单曲结果）心形列可点
  8. 桌面 #/playlist/love：在线曲目出现在「我喜欢」里、可播（player.cur 起播）、取消后行消失
  9. 底栏与全屏播放页心形：在线曲目不再隐藏，点击能收藏
 10. 移动端 390x844：#/playlist/love 不横向溢出、心形可点且 ≥34px
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = os.environ.get('GS_APP_USER', 'Slceleto'), os.environ.get('GS_APP_PASS', 'REDACTED')
PASS = FAIL = SKIP = 0

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__('%s %s' % (code, msg))
        self.code = code
        self.msg = msg


def call(method, path, token=None, body=None, timeout=60):
    """返回 data；HTTP 错误抛 HttpError（带服务端文案）"""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + '/web' + path, method=method, data=data)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('X-Web-Token', token)
    try:
        with _opener.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode()).get('data')
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
        raise HttpError(e.code, payload.get('msg') or payload.get('message') or raw[:120])


def login_token():
    return call('POST', '/login', body={'name': USER, 'password': PASSWORD})['token']


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(600)


def goto(page, h, wait=1000):
    page.evaluate("h => { if (location.hash !== h) location.hash = h }", h)
    page.wait_for_timeout(wait)


def love_ids(token):
    return set(call('GET', '/api/love-ids', token)['ids'])


def love_tracks(token):
    return call('GET', '/api/playlists/love', token)['tracks']


def search_online(token, q, size=30):
    return call('GET', '/api/downloads/search?q=%s&size=%d' % (urllib.parse.quote(q), size), token)


def untoggle(token, key):
    """按 <source>_<rid> 取消收藏（测试自清用）"""
    if not key or '_' not in key:
        return
    src, rid = key.split('_', 1)
    try:
        call('POST', '/api/love/toggle', token, {'source': src, 'rid': rid})
    except HttpError:
        pass


def main():
    global SKIP
    token = login_token()

    # ---------------- 1. 服务端：在线曲目收藏 ----------------
    print('\n— 1. 服务端：在线曲目 toggle / 落库形状 —')
    d = search_online(token, '周杰伦')
    rows = d.get('list') or []
    if not rows:
        skip('在线搜索可用', '搜索无结果（音源可能临时不可用）')
        return 0
    r0 = rows[0]
    src, rid = r0['source'], r0['id']
    key = src + '_' + str(rid).replace('MUSIC_', '')
    before = love_ids(token)
    if key in before:
        call('POST', '/api/love/toggle', token, {'source': src, 'rid': rid})
    base_count = len(love_tracks(token))

    res = call('POST', '/api/love/toggle', token, {
        'source': src, 'rid': rid, 'name': r0.get('name'), 'singer': r0.get('singer'),
        'album': r0.get('album'), 'intervalMs': r0.get('intervalMs'), 'pic': r0.get('pic'),
    })
    check('在线曲目 toggle → loved=true', res.get('loved') is True, json.dumps(res, ensure_ascii=False))
    ids = love_ids(token)
    check('love-ids 含 <source>_<rid>（MUSIC_ 前缀已归一）', key in ids, 'key=%s' % key)

    tracks = love_tracks(token)
    check('「我喜欢」条目数 +1', len(tracks) == base_count + 1, '%d -> %d' % (base_count, len(tracks)))
    item = next((m for m in tracks if m.get('id') == key), None)
    check('列表里能找到该条目', item is not None, 'key=%s' % key)
    if item:
        check('条目形状 = 洛雪 MusicInfo（source / trackId=null / missing=false）',
              item.get('source') == src and item.get('trackId') is None and item.get('missing') is False,
              json.dumps({k: item.get(k) for k in ('source', 'trackId', 'missing')}, ensure_ascii=False))
        check('meta.songId 为 rid 且曲名/歌手已快照',
              str((item.get('meta') or {}).get('songId')) == str(rid).replace('MUSIC_', '')
              and item.get('name') == r0.get('name'),
              json.dumps({'songId': (item.get('meta') or {}).get('songId'), 'name': item.get('name')}, ensure_ascii=False))

    # 再点一次 = 取消
    res = call('POST', '/api/love/toggle', token, {'source': src, 'rid': rid})
    check('再 toggle → loved=false', res.get('loved') is False, json.dumps(res, ensure_ascii=False))
    check('取消后 love-ids 不再包含', key not in love_ids(token), 'key=%s' % key)
    check('取消后条目数回到初始', len(love_tracks(token)) == base_count, '%d' % len(love_tracks(token)))

    # ---------------- 2. 参数校验 ----------------
    print('\n— 2. 参数校验（不写脏数据） —')
    for name, body in [
        ('未知音源 400', {'source': 'nope', 'rid': '123', 'name': 'x'}),
        ('非法 rid 400', {'source': src, 'rid': 'bad id!!', 'name': 'x'}),
    ]:
        try:
            call('POST', '/api/love/toggle', token, body)
            check(name, False, '竟然成功了')
        except HttpError as e:
            check(name, e.code == 400, 'got %s %s' % (e.code, e.msg))
    try:
        call('POST', '/api/love/toggle', token, {'trackId': 'definitely-not-a-track'})
        check('不存在的本地曲目 400', False, '竟然成功了')
    except HttpError as e:
        check('不存在的本地曲目 400', e.code == 400, 'got %s %s' % (e.code, e.msg))
    check('校验失败没有污染列表', len(love_tracks(token)) == base_count, '%d' % len(love_tracks(token)))

    # ---------------- 3. 批量收藏接口 ----------------
    print('\n— 3. /web/api/love/add 批量收藏（本地曲目） —')
    res = call('POST', '/api/love/add', token, {'trackIds': ['no-such-track-1', 'no-such-track-2']})
    check('无效 id 全部跳过 → added=0', res.get('added') == 0, json.dumps(res, ensure_ascii=False))
    try:
        call('POST', '/api/love/add', token, {'trackIds': []})
        check('空列表 400', False, '竟然成功了')
    except HttpError as e:
        check('空列表 400', e.code == 400, 'got %s %s' % (e.code, e.msg))

    # ---------------- 4. 桌面 UI ----------------
    errs = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        desk = b.new_context(viewport={'width': 1440, 'height': 900})
        page = desk.new_page()
        page.on('pageerror', lambda e: errs.append('desk pageerror: ' + str(e)))
        page.on('console', lambda m: errs.append('desk console: ' + m.text) if m.type == 'error' else None)
        login(page)
        page.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(token))

        # 回归：boot() 在没有 token 时会提前 return，登录页输密码进来的用户
        # 只能靠 enterApp() 里的 loadUserState() 取收藏 —— 只在 boot 里拉过一次的话，
        # 首次登录后所有心形都会是灰的，得手动刷新才对。
        print('\n— 3b. 桌面：刚登录（未刷新）就拿到收藏状态 —')
        call('POST', '/api/love/toggle', token, {'source': src, 'rid': rid})
        check('（前置）接口已收藏 %s' % key, key in love_ids(token))
        fresh = b.new_context(viewport={'width': 1440, 'height': 900})
        fpage = fresh.new_page()
        login(fpage)   # 完整走一遍登录表单，不注入 token、不刷新
        goto(fpage, '#/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6', 1200)
        fpage.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
        fpage.wait_for_timeout(600)
        n_loved = fpage.locator('.sr-tbl .love-btn.loved').count()
        check('刚登录（未刷新）心形就是已收藏态', n_loved >= 1, 'loved=%d' % n_loved)
        check('与「我喜欢」接口状态一致（未刷新）', n_loved == len(love_ids(token)), 'loved=%d ids=%d' % (n_loved, len(love_ids(token))))
        fresh.close()
        untoggle(token, key)
        check('（后置）清理前置收藏', key not in love_ids(token))

        print('\n— 4. 桌面 #/search：在线结果行心形可收藏 —')
        goto(page, '#/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6', 1200)
        page.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
        page.wait_for_timeout(400)
        n = page.locator('.sr-tbl tbody tr').count()
        check('搜索结果表有行', n > 0, 'rows=%d' % n)
        heart = page.locator('.sr-tbl tbody tr').first.locator('.love-btn')
        check('结果行带心形按钮', heart.count() == 1)
        heart.click()
        page.wait_for_timeout(900)
        check('点击后心形变红（.loved）', 'loved' in (heart.get_attribute('class') or ''), heart.get_attribute('class') or '')
        first_key = page.evaluate("() => { const b = document.querySelector('.sr-tbl tbody tr .love-btn'); return b.classList.contains('loved') }")
        ids = love_ids(token)
        check('服务端 love-ids 至少有 1 条在线收藏', len(ids) >= 1, 'ids=%s' % list(ids)[:3])
        added_key = sorted(ids)[0] if ids else ''
        check('UI 与服务端状态一致（心形红 ↔ 列表有该 id）', first_key and bool(added_key), 'loved=%s key=%s' % (first_key, added_key))

        print('\n— 5. 桌面 #/online：在线音乐页心形列 —')
        goto(page, '#/online', 1500)
        page.wait_for_selector('.onl-tools', timeout=20000)
        page.wait_for_timeout(1000)
        # 在线音乐页默认是「歌单广场」（卡片），要拿到单曲表得切到「搜索」tab 再搜
        page.evaluate("() => { const t = [...document.querySelectorAll('.otabs button')].find(b => /搜索/.test(b.textContent)); if (t) t.click() }")
        page.wait_for_selector('#view .search-box input', timeout=20000)
        page.fill('#view .search-box input', '周杰伦')
        page.press('#view .search-box input', 'Enter')
        page.wait_for_selector('#view .tracks tbody tr', timeout=45000)
        page.wait_for_timeout(500)
        head_love = page.locator('#view .tracks thead th.love').count()
        check('在线音乐页表头有收藏列', head_love == 1, 'th.love=%d' % head_love)
        onl_hearts = page.locator('#view .tracks tbody tr td.love .love-btn')
        check('在线音乐页表格行有收藏列', onl_hearts.count() > 0, 'count=%d' % onl_hearts.count())
        if onl_hearts.count():
            h0 = onl_hearts.first
            before_loved = 'loved' in (h0.get_attribute('class') or '')
            h0.click()
            page.wait_for_timeout(1000)
            after_loved = 'loved' in (h0.get_attribute('class') or '')
            check('在线音乐页点心形 → 收藏态切换', before_loved != after_loved,
                  'before=%s after=%s' % (before_loved, after_loved))
            check('切换已落库（love-ids 同步变化）', (added_key in love_ids(token)) == after_loved,
                  'ids=%s' % sorted(love_ids(token))[:3])
            h0.click()
            page.wait_for_timeout(1000)
            check('在线音乐页再点一次回到原状态', ('loved' in (h0.get_attribute('class') or '')) == before_loved)
            for k in list(love_ids(token)):
                if k != added_key:
                    untoggle(token, k)
            check('在线音乐页测试自清', love_ids(token) == {added_key}, 'ids=%s' % sorted(love_ids(token))[:3])

        print('\n— 6. 桌面 #/playlist/love：在线曲目可在网页端播放 —')
        goto(page, '#/playlist/love', 1400)
        page.wait_for_selector('#view table.tracks', timeout=20000)
        page.wait_for_timeout(500)
        love_rows = page.locator('#view table.tracks tbody tr')
        rc = love_rows.count()
        check('「我喜欢」列表里有条目', rc >= 1, 'rows=%d' % rc)
        check('该行不是置灰行（可播）', 'disabled' not in (love_rows.first.get_attribute('class') or ''),
              love_rows.first.get_attribute('class') or '')
        check('该行心形为已收藏态', 'loved' in (love_rows.first.locator('.love-btn').get_attribute('class') or ''))
        love_rows.first.click()
        page.wait_for_timeout(1600)
        cur = page.evaluate("() => { const p = window.__player; return p && p.cur ? { name: p.cur.name, kind: p.cur.kind } : null }")
        check('点行起播（kind=online）', bool(cur) and cur.get('kind') == 'online', json.dumps(cur, ensure_ascii=False))
        check('底栏心形对在线曲目可见', page.evaluate(
            "() => { const e = document.getElementById('lf-love'); return !!e && getComputedStyle(e).visibility !== 'hidden' }"))

        print('\n— 7. 底栏 / 全屏播放页心形：在线曲目能取消收藏 —')
        check('底栏心形对在线曲目可见（原为隐藏）', page.evaluate(
            "() => { const e = document.getElementById('np-love'); return getComputedStyle(e).visibility !== 'hidden' }"))
        page.click('#np-love')
        page.wait_for_timeout(900)
        ids_after = love_ids(token)
        check('底栏心形点击 → 该曲目已取消收藏', added_key not in ids_after, 'key=%s ids=%s' % (added_key, sorted(ids_after)[:3]))
        page.click('#np-love')
        page.wait_for_timeout(900)
        check('再点一次 → 重新收藏', added_key in love_ids(token), 'key=%s' % added_key)
        # 全屏播放页（#btn-lyric 切到的歌词层里那颗心）
        page.evaluate("() => document.getElementById('btn-lyric').click()")
        page.wait_for_timeout(900)
        vis = page.evaluate("() => { const e = document.getElementById('lf-love'); return { vis: getComputedStyle(e).visibility, color: getComputedStyle(e).color } }")
        check('全屏播放页心形对在线曲目可见', vis['vis'] != 'hidden', json.dumps(vis, ensure_ascii=False))
        check('全屏播放页心形已收藏时为红色', 'rgb(255, 95, 109)' in vis['color'] or 'danger' in vis['color'], vis['color'])
        page.click('#lf-love')
        page.wait_for_timeout(1000)
        check('全屏播放页心形可取消收藏', added_key not in love_ids(token), 'key=%s' % added_key)
        page.click('#lf-love')
        page.wait_for_timeout(1000)
        check('全屏播放页再点一次恢复收藏', added_key in love_ids(token), 'key=%s' % added_key)
        page.click('#lf-close')
        page.wait_for_timeout(600)

        print('\n— 8. 取消喜欢后：列表页重绘、条目消失 —')
        goto(page, '#/playlist/love', 1200)
        page.wait_for_selector('#view table.tracks', timeout=20000)
        page.wait_for_timeout(400)
        before_rows = page.locator('#view table.tracks tbody tr').count()
        page.locator('#view table.tracks tbody tr').first.locator('.love-btn').click()
        page.wait_for_timeout(1600)
        after_rows = page.locator('#view table.tracks tbody tr').count()
        check('取消喜欢后该行从「我喜欢」消失', after_rows == before_rows - 1, '%d -> %d' % (before_rows, after_rows))
        check('服务端同步（love-ids 少了一条）', added_key not in love_ids(token), 'key=%s' % added_key)
        # 清场：不留测试数据
        if added_key in love_ids(token):
            call('POST', '/api/love/toggle', token, {'source': added_key.split('_')[0], 'rid': added_key.split('_', 1)[1]})
        check('测试自清：我喜欢列表回到初始条数', len(love_tracks(token)) == base_count, '%d (base %d)' % (len(love_tracks(token)), base_count))

        print('\n— 9. 移动端 390x844 —')
        mob = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        mp = mob.new_page()
        mp.on('pageerror', lambda e: errs.append('mob pageerror: ' + str(e)))
        login(mp)
        goto(mp, '#/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6', 1200)
        mp.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
        mp.wait_for_timeout(400)
        heart = mp.locator('.sr-tbl tbody tr').first.locator('.love-btn')
        box = heart.bounding_box()
        check('390px 搜索结果心形可点（≥28px 触控区）', bool(box) and box['width'] >= 28 and box['height'] >= 28,
              json.dumps(box, ensure_ascii=False))
        ovf = mp.evaluate("() => { const t = document.querySelector('.sr-tbl'); return t ? t.scrollWidth - t.clientWidth : -1 }")
        check('390px 结果表无横向溢出', ovf <= 1, 'overflow=%s' % ovf)
        heart.click()
        mp.wait_for_timeout(1200)
        m_ids = love_ids(token)
        check('手机端点心形 → 服务端已收藏', len(m_ids) >= 1, 'ids=%s' % list(m_ids)[:3])
        goto(mp, '#/playlist/love', 1400)
        mp.wait_for_selector('#view table.tracks', timeout=20000)
        mp.wait_for_timeout(500)
        m_rows = mp.locator('#view table.tracks tbody tr')
        check('手机端「我喜欢」能看到刚收藏的在线曲目', m_rows.count() >= 1, 'rows=%d' % m_rows.count())
        m_love_box = m_rows.first.locator('.love-btn').bounding_box()
        check('手机端行内心形 ≥28px', bool(m_love_box) and m_love_box['width'] >= 28, json.dumps(m_love_box, ensure_ascii=False))
        movf = mp.evaluate("() => { const t = document.querySelector('#view table.tracks'); return t ? t.scrollWidth - t.clientWidth : -1 }")
        check('390px 「我喜欢」表无横向溢出', movf <= 1, 'overflow=%s' % movf)
        mp.screenshot(path='tools/shot-love-mobile.png')
        if m_ids:
            k = sorted(m_ids)[0]
            call('POST', '/api/love/toggle', token, {'source': k.split('_')[0], 'rid': k.split('_', 1)[1]})
        check('手机端测试自清完成', len(love_tracks(token)) == base_count, '%d' % len(love_tracks(token)))
        mob.close()
        desk.close()
        b.close()

    check('全程无 JS 运行时错误', len(errs) == 0, ' | '.join(errs[:3]))
    print('\n== %d passed, %d failed, %d skipped ==' % (PASS, FAIL, SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    import urllib.parse
    sys.exit(main())
