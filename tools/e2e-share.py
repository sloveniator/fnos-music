#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音乐分享（公开链接 /s/<code>）验证 —— 线上实例 localhost:20059

用法：
    python3 tools/e2e-share.py

覆盖：
  1. 准备：注册独立测试账号 → 放一首 fixture 进其云盘目录 → 扫描 → 曲库 1 首
  2. 接口层：创建分享（默认 7 天 / 无提取码 / 允许下载）、曲目快照、link 结构
  3. 匿名访问：分享页 200（含标题）、清单 200、Range 流媒体 206、封面、歌词、下载（带 Content-Disposition）
  4. 提取码：未解锁 401(need) → 错误提取码 401 → 正确 → cookie → 清单/流媒体放行
  5. 有效期：1 天 → 永久；人为过期 → 页面 410、清单 410
  6. 允许下载开关：关闭 → 下载 403，改回 → 200
  7. 粒度：单曲 / 歌单 / 专辑 / 歌手 四种都能建，曲目数正确
  8. 撤销：页面 404、流媒体 404、管理后台列表消失、审计日志有记录
  9. 界面：行菜单「分享这首…」→ 生成链接 → 设置页「我的分享」可见 → 撤销
 10. 清理：删除测试账号（含目录）+ 撤销全部分享

设计说明：所有操作都在独立测试账号内完成，不碰真实账号的曲库与分享。
"""
import json
import os
import random
import shutil
import string
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = 'http://localhost:20059'
ADMIN_PASS = _ADMIN_PASS
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA = os.path.join(ROOT, 'server', 'data')
FIXTURE_SRC = '/tmp/gusi-test-music/周杰伦/范特西/01 可爱女人.mp3'
FIXTURE_NAME = '01 可爱女人.mp3'

PASS = FAIL = 0
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER = 'e2eshr' + RND
PW = 'E2e' + RND + '!9'
EMAIL = USER + '@example.com'

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
WEB_TOKEN = ''
ADMIN_TOKEN = ''


class ApiError(Exception):
    def __init__(self, msg, code=0):
        super().__init__(msg)
        self.msg = msg
        self.code = code


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


# ---------------- HTTP ----------------
def api(path, method='GET', body=None, token=None):
    req = urllib.request.Request(BASE + '/web' + path, method=method)
    token = token if token is not None else WEB_TOKEN
    if token:
        req.add_header('X-Web-Token', token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        with _opener.open(req, data, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            raise ApiError(json.loads(raw).get('msg', ''), e.code)
        except ValueError:
            raise ApiError('HTTP %d %s' % (e.code, raw[:120]), e.code)


def admin_api(path, method='GET', body=None):
    req = urllib.request.Request(BASE + '/admin' + path, method=method)
    req.add_header('X-Admin-Token', ADMIN_TOKEN)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    with _opener.open(req, data, timeout=30) as r:
        return json.loads(r.read().decode())


def raw(path, headers=None, method='GET'):
    """匿名原始请求：返回 (status, headers, body_bytes)；HTTPError 也当结果返回"""
    req = urllib.request.Request(BASE + path, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with _opener.open(req, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


def err_of(fn, *a, **kw):
    try:
        fn(*a, **kw)
        return ''
    except ApiError as e:
        return e.msg


def link_of(code):
    return '%s/s/%s' % (BASE, code)


# ---------------- 准备 ----------------
def setup():
    global WEB_TOKEN, ADMIN_TOKEN
    r = api('/register', method='POST', body={'name': USER, 'email': EMAIL, 'password': PW, 'confirm': PW},
            token='')
    WEB_TOKEN = r['data']['token']
    req = urllib.request.Request(BASE + '/admin/login', method='POST')
    req.add_header('Content-Type', 'application/json')
    with _opener.open(req, json.dumps({'password': ADMIN_PASS}).encode(), timeout=30) as rr:
        ADMIN_TOKEN = json.loads(rr.read().decode())['token']
    # fixture 放进该用户的云盘（也是其曲库扫描目录）
    dest_dir = os.path.join(DATA, 'library', USER)
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy(FIXTURE_SRC, os.path.join(dest_dir, FIXTURE_NAME))
    # /web/api/stats 会自愈补扫（scannedAt 为空时触发）
    for _ in range(30):
        st = api('/api/stats')['data']
        if st.get('tracks', 0) > 0:
            return st
        time.sleep(1)
    raise SystemExit('fixture 未被扫描进曲库，测试无法继续')


def cleanup():
    for s in (api('/api/share/list') or {}).get('data', {}).get('shares', []) if WEB_TOKEN else []:
        try:
            api('/api/share/remove', method='POST', body={'codes': [s['code']]})
        except Exception:
            pass
    if ADMIN_TOKEN:
        try:
            admin_api('/api/users/' + urllib.parse.quote(USER) + '?purge=1', method='DELETE')
        except Exception as e:
            print('  清理测试账号失败: %s' % e)
    try:
        shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
        shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    except Exception:
        pass


# ---------------- 用例 ----------------
def run_api_cases():
    print('\n— 1. 曲库与单曲分享 —')
    st = api('/api/stats')['data']
    check('测试曲库已就绪（1 首）', st.get('tracks') == 1, json.dumps(st, ensure_ascii=False))
    tracks = api('/api/tracks?size=5')['data']['tracks']
    t = tracks[0]
    print('    曲目：%s / %s / %s' % (t['name'], t['singer'], t['album']))

    d = api('/api/share/create', method='POST', body={'type': 'track', 'ids': [t['id']], 'days': 7})['data']
    code = d['code']
    check('创建单曲分享返回 code', bool(code) and len(code) == 10, code)
    check('链接形态 /s/<code>', d['url'].endswith('/s/' + code), d['url'])
    check('默认允许下载', d['allowDownload'] is True)
    check('默认无提取码', d['hasPassword'] is False)
    left = d['expiresAt'] - int(time.time() * 1000)
    check('默认有效期 7 天', 6.9 * 86400000 < left <= 7 * 86400000, '%.2f 天' % (left / 86400000))

    print('\n— 2. 匿名访问（免登录） —')
    s, h, body = raw('/s/' + code)
    html = body.decode('utf-8', 'ignore')
    check('分享页 200', s == 200, str(s))
    check('页面含曲目标题', '可爱女人' in html)
    check('页面含分享者', USER in html)
    check('页面无内联脚本（CSP script-src self）', '<script>' not in html and 'onclick=' not in html)
    check('页面声明 7 天后失效', '天后失效' in html)

    s2, _, b2 = raw('/s/%s/api' % code)
    m = json.loads(b2.decode())
    check('清单 200', s2 == 200 and m['code'] == 0, str(s2))
    check('清单曲目数 1（快照）', len(m['data']['items']) == 1)
    check('清单标记 allowDownload', m['data']['allowDownload'] is True)

    s3, h3, b3 = raw('/s/%s/stream/0' % code, {'Range': 'bytes=0-1023'})
    check('Range 流媒体 206', s3 == 206, str(s3))
    check('返回 1024 字节', len(b3) == 1024, str(len(b3)))
    check('Content-Type=audio/*', h3.get('Content-Type', '').startswith('audio/'), h3.get('Content-Type', ''))

    s4, h4, _ = raw('/s/%s/download/0' % code)
    check('下载 200（默认允许）', s4 == 200, str(s4))
    check('下载带 Content-Disposition', 'attachment' in h4.get('Content-Disposition', ''), h4.get('Content-Disposition', ''))

    s5, h5, _ = raw('/s/%s/cover/0' % code)
    check('封面接口可用（200 或 404）', s5 in (200, 404), str(s5))

    s6, _, b6 = raw('/s/%s/lyric/0' % code)
    check('歌词接口 200', s6 == 200, str(s6))
    check('歌词返回 JSON', json.loads(b6.decode())['code'] == 0)

    s7, _, _ = raw('/s/%s/stream/9' % code)
    check('越界索引 404', s7 == 404, str(s7))
    s8, _, _ = raw('/s/zzzzzzzzzz')
    check('不存在的 code → 404', s8 == 404, str(s8))
    s9, _, _ = raw('/s/' + code, method='POST')
    check('非 GET 方法不被当成页面', s9 in (404, 405), str(s9))

    print('\n— 3. 提取码 —')
    d2 = api('/api/share/create', method='POST',
            body={'type': 'track', 'ids': [t['id']], 'days': 7, 'password': 'a1b2'})['data']
    c2 = d2['code']
    check('创建带提取码分享', d2['hasPassword'] is True)
    check('提取码太短被拒', '4-16' in err_of(api, '/api/share/create', method='POST',
                                        body={'type': 'track', 'ids': [t['id']], 'password': 'ab'}))
    s, _, b = raw('/s/%s/api' % c2)
    check('未解锁清单 401', s == 401 and json.loads(b.decode()).get('need') is True, str(s))
    s, _, _ = raw('/s/%s/stream/0' % c2)
    check('未解锁流媒体 401', s == 401, str(s))
    s, _, b = raw('/s/%s/unlock' % c2, headers={'Content-Type': 'application/json'},
                  method='POST')
    check('空提取码 401', s == 401, str(s))
    req = urllib.request.Request(BASE + '/s/%s/unlock' % c2, method='POST')
    req.add_header('Content-Type', 'application/json')
    try:
        with _opener.open(req, json.dumps({'password': 'wrong'}).encode(), timeout=30) as r:
            wrong_status = r.status
    except urllib.error.HTTPError as e:
        wrong_status = e.code
    check('错误提取码 401', wrong_status == 401, str(wrong_status))
    req = urllib.request.Request(BASE + '/s/%s/unlock' % c2, method='POST')
    req.add_header('Content-Type', 'application/json')
    with _opener.open(req, json.dumps({'password': 'a1b2'}).encode(), timeout=30) as r:
        ok_status = r.status
        ck = r.headers.get('Set-Cookie', '')
    check('正确提取码 200', ok_status == 200, str(ok_status))
    check('下发 HttpOnly Cookie', 'HttpOnly' in ck and 'gusi_s_' + c2 in ck, ck[:80])
    cookie = ck.split(';')[0]
    s, _, b = raw('/s/%s/api' % c2, {'Cookie': cookie})
    check('带 Cookie 清单 200', s == 200, str(s))
    s, _, _ = raw('/s/%s/stream/0' % c2, {'Cookie': cookie, 'Range': 'bytes=0-99'})
    check('带 Cookie 流媒体 206', s == 206, str(s))

    print('\n— 4. 有效期与下载开关 —')
    d3 = api('/api/share/create', method='POST', body={'type': 'track', 'ids': [t['id']], 'days': 1})['data']
    c3 = d3['code']
    left = d3['expiresAt'] - int(time.time() * 1000)
    check('1 天有效', 0.9 * 86400000 < left <= 86400000, '%.2f 天' % (left / 86400000))
    u = api('/api/share/update', method='POST', body={'code': c3, 'days': 0})['data']
    check('改为永久有效', u['expiresAt'] == 0, str(u['expiresAt']))
    u2 = api('/api/share/update', method='POST', body={'code': c3, 'allowDownload': False})['data']
    check('关闭下载', u2['allowDownload'] is False)
    s, _, _ = raw('/s/%s/download/0' % c3)
    check('关闭下载后 403', s == 403, str(s))
    s, _, _ = raw('/s/%s/stream/0' % c3, {'Range': 'bytes=0-99'})
    check('关闭下载不影响在线听', s == 206, str(s))
    api('/api/share/update', method='POST', body={'code': c3, 'allowDownload': True})
    s, _, _ = raw('/s/%s/download/0' % c3)
    check('改回允许后 200', s == 200, str(s))
    u3 = api('/api/share/update', method='POST', body={'code': c3, 'password': 'pass1234'})['data']
    check('事后加提取码', u3['hasPassword'] is True)
    s, _, _ = raw('/s/%s/api' % c3)
    check('加码后匿名清单 401', s == 401, str(s))
    u4 = api('/api/share/update', method='POST', body={'code': c3, 'clearPassword': True})['data']
    check('清除提取码', u4['hasPassword'] is False)

    print('\n— 5. 人为过期（直接改运行时数据） —')
    f = os.path.join(DATA, 'shares.json')
    with open(f, 'r', encoding='utf-8') as fh:
        js = json.load(fh)
    backup = json.dumps(js, ensure_ascii=False)
    for s_ in js['shares']:
        if s_['code'] == c3:
            s_['expiresAt'] = int(time.time() * 1000) - 1000
    with open(f, 'w', encoding='utf-8') as fh:
        json.dump(js, fh, ensure_ascii=False, indent=2)
    s, _, body = raw('/s/' + c3)
    check('过期页面 410', s == 410, str(s))
    check('过期文案正确', '已过期' in body.decode('utf-8', 'ignore'))
    s, _, _ = raw('/s/%s/api' % c3)
    check('过期清单也不可用', s in (410, 404), str(s))
    s, _, _ = raw('/s/%s/stream/0' % c3)
    check('过期流媒体不可用', s in (410, 404), str(s))
    with open(f, 'w', encoding='utf-8') as fh:
        fh.write(backup)
    s, _, _ = raw('/s/' + c3)
    check('还原后 200', s == 200, str(s))

    print('\n— 6. 粒度：歌单 / 专辑 / 歌手 —')
    lst = api('/api/playlists/default')['data']
    if not lst['tracks']:
        api('/api/playlists/default/add', method='POST', body={'trackIds': [t['id']]})
    dp = api('/api/share/create', method='POST', body={'type': 'playlist', 'listId': 'default'})['data']
    check('歌单分享曲目数 ≥1', dp['count'] >= 1, str(dp['count']))
    s, _, b = raw('/s/%s/api' % dp['code'])
    check('歌单分享匿名可读', s == 200 and len(json.loads(b.decode())['data']['items']) == dp['count'])
    da = api('/api/share/create', method='POST',
             body={'type': 'album', 'album': t['album'], 'artist': t['singer']})['data']
    check('专辑分享 1 首', da['count'] == 1, str(da['count']))
    check('专辑分享标题=专辑名（空标签时用占位名）', da['title'] in (t['album'] or '', '专辑', '未知专辑'), da['title'] + ' / album=' + repr(t['album']))
    dr = api('/api/share/create', method='POST', body={'type': 'artist', 'artist': t['singer']})['data']
    check('歌手分享 1 首', dr['count'] == 1, str(dr['count']))
    check('歌手分享类型文案', dr['typeText'] == '歌手分享', dr['typeText'])

    print('\n— 7. 列表与访问计数 —')
    ml = api('/api/share/list')['data']['shares']
    codes = [x['code'] for x in ml]
    check('列表包含本次全部分享（6 条）', len(ml) == 6, str(len(ml)))
    check('列表带 url', all(x['url'].endswith('/s/' + x['code']) for x in ml))
    raw('/s/' + d['code'])
    raw('/s/' + d['code'])
    ml2 = api('/api/share/list')['data']['shares']
    v = [x for x in ml2 if x['code'] == d['code']][0]['visits']
    check('访问计数递增（10 分钟窗口内只记一次）', v >= 1, str(v))

    print('\n— 8. 撤销 —')
    removed = api('/api/share/remove', method='POST', body={'codes': [c2]})['data']
    check('撤销 1 条', removed['removed'] == 1, str(removed))
    s, _, _ = raw('/s/' + c2)
    check('撤销后页面 404', s == 404, str(s))
    s, _, _ = raw('/s/%s/stream/0' % c2, {'Cookie': cookie})
    check('撤销后流媒体 404（旧 Cookie 也无效）', s == 404, str(s))
    check('撤销后不在我的列表', c2 not in [x['code'] for x in api('/api/share/list')['data']['shares']])
    adm = admin_api('/api/shares')
    check('管理后台能看到分享', adm['totals']['all'] >= 4, json.dumps(adm['totals']))
    check('管理后台能看到分享者', any(x['owner'] == USER for x in adm['shares']))
    admin_api('/api/shares/remove', method='POST', body={'codes': [dr['code']]})
    check('后台撤销生效', dr['code'] not in [x['code'] for x in admin_api('/api/shares')['shares']])
    log = os.path.join(ROOT, 'server', 'logs', 'audit.log')
    if os.path.exists(log):
        txt = open(log, 'r', encoding='utf-8', errors='ignore').read()
        check('审计日志记录 share.create', 'share.create' in txt)
        check('审计日志记录 share.remove', 'share.remove' in txt)
        check('审计日志记录提取码失败', 'share.unlock_fail' in txt)
    else:
        check('审计日志存在', False, log)

    print('\n— 9. 权限边界 —')
    check('不能撤销别人的分享（用不存在的 code）',
          '不存在' in err_of(api, '/api/share/update', method='POST', body={'code': 'aaaaaaaaaa', 'days': 1}))
    check('分享不支持在线曲目', '没有可分享的曲目' in err_of(
        api, '/api/share/create', method='POST', body={'type': 'track', 'ids': ['wy_123456']}))
    return code, t


def run_ui_cases():
    print('\n— 10. 界面（真实 Chromium） —')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1280, 'height': 900})
        pg.goto(BASE + '/')
        pg.evaluate("localStorage.clear()")
        pg.wait_for_selector('#login', state='visible', timeout=20000)
        pg.fill('#login-name', USER)
        pg.fill('#login-pass', PW)
        pg.click('#login-btn')
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
        # 进「全部歌曲」，用行菜单发起分享
        pg.goto(BASE + '/#/tracks')
        pg.wait_for_selector('table.tracks tbody tr .acts .more-wrap button', timeout=20000)
        pg.wait_for_timeout(700)
        # 行菜单是 openTrackMenu 建的 .menu（不是 popMenu 的 .menu.pop），挂在 .more-wrap 里；
        # 用 DOM click 触发，避开骨架行整表替换带来的点击竞态
        opened = False
        for _try in range(4):
            pg.evaluate("() => { const b = document.querySelector('table.tracks tbody tr .acts .more-wrap button'); if (b) b.click(); }")
            pg.wait_for_timeout(400)
            if pg.eval_on_selector_all('.more-wrap .menu button', 'e => e.length'):
                opened = True
                break
        check('行菜单可打开', opened)
        items = pg.eval_on_selector_all('.more-wrap .menu button', 'els => els.map(e => e.textContent)')
        check('行菜单有「分享这首…」', any('分享这首' in x for x in items), str(items)[:160])
        pg.evaluate("() => { const b = [...document.querySelectorAll('.more-wrap .menu button')].find(e => e.textContent.includes('分享这首')); if (b) b.click(); }")
        pg.wait_for_selector('#share-dialog:not([hidden])', timeout=8000)
        check('分享弹窗打开', pg.is_visible('#share-dialog'))
        check('默认有效期 7 天', pg.input_value('#share-days') == '7', pg.input_value('#share-days'))
        check('默认允许下载勾选', pg.is_checked('#share-dl'))
        check('默认不设提取码', not pg.is_checked('#share-pass-on'))
        pg.click('#share-ok')
        pg.wait_for_selector('#share-result:not([hidden])', timeout=15000)
        url = pg.input_value('#share-link')
        check('弹窗生成链接', '/s/' in url, url)
        ui_code = url.rsplit('/s/', 1)[-1]
        check('提示含有效期', '有效期' in pg.text_content('#share-tip'))
        pg.click('#share-cancel')
        # 公开分享页：未登录的独立上下文（必须在撤销之前验证，撤销删的就是最新一条）
        pub = b.new_context().new_page()
        pub.goto(BASE + '/s/' + ui_code)
        pub.wait_for_selector('.s-item', timeout=15000)
        check('分享页渲染出曲目行', pub.eval_on_selector_all('.s-item', 'e => e.length') >= 1)
        check('分享页标题为曲名', '可爱女人' in pub.inner_text('.s-title'))
        check('分享页显示「可下载」标签', '可下载' in pub.inner_text('.s-meta'))
        pub.click('#s-playall')
        pub.wait_for_timeout(1500)
        check('点「播放全部」后播放条出现', pub.is_visible('#s-bar'))
        check('播放条显示当前曲目', '可爱女人' in pub.inner_text('#s-np-name'))
        pub.screenshot(path=os.path.join(ROOT, 'tools', 'shot-share-page.png'))
        pub.close()
        # 手机端（分享链接大多在手机上打开）：390×844 不能横向溢出，播放条要点得到
        mob = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
        mob.goto(BASE + '/s/' + ui_code)
        mob.wait_for_selector('.s-item', timeout=15000)
        mob.wait_for_timeout(500)
        ov = mob.evaluate("() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})")
        check('手机端分享页无横向溢出', ov['sw'] <= ov['cw'] + 1, '%d > %d' % (ov['sw'], ov['cw']))
        fit = mob.evaluate("() => [...document.querySelectorAll('.s-btn, .s-acts .s-ic')].every(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; })")
        check('手机端按钮都在视口内', fit)
        mob.click('#s-playall')
        mob.wait_for_timeout(1200)
        check('手机端播放条出现且不遮住列表', mob.is_visible('#s-bar'))
        mob.screenshot(path=os.path.join(ROOT, 'tools', 'shot-share-mobile.png'))
        mob.close()
        # 设置页「我的分享」
        pg.goto(BASE + '/#/settings')
        pg.wait_for_selector('.share-item', timeout=15000)
        n = pg.eval_on_selector_all('.share-item', 'els => els.length')
        check('设置页列出分享', n >= 1, str(n))
        pg.screenshot(path=os.path.join(ROOT, 'tools', 'shot-settings-shares.png'))
        pg.click('.share-item .danger-btn')
        # 撤销走应用内确认弹窗 confirm2（#dialog / #dlg-ok），不是浏览器原生 confirm
        pg.wait_for_selector('#dialog:not([hidden])', timeout=8000)
        pg.click('#dlg-ok')
        # 撤销是异步的（请求回来才重渲染），固定等待会偶发假失败 → 轮询到列表变短为止
        # 撤销后重渲染会先经过一帧「空列表/加载中」，只判「变短」会撞上这帧假数据
        # （曾偶发报 5 → 0）→ 必须轮询到 == n-1 为止，真的少错一条仍然会失败
        n2 = n
        for _i in range(30):
            pg.wait_for_timeout(300)
            n2 = pg.eval_on_selector_all('.share-item', 'els => els.length')
            if n2 == n - 1:
                break
        check('设置页撤销后列表减少', n2 == n - 1, '%d → %d' % (n, n2))
        # 专辑页：分享入口 + 弹窗
        pg.goto(BASE + '/#/albums?tab=albums')
        pg.wait_for_selector('.card', timeout=15000)
        pg.click('.card')
        pg.wait_for_selector('.hero .btn', timeout=15000)
        pg.wait_for_timeout(600)
        btns = pg.eval_on_selector_all('.hero .btn', 'els => els.map(e => e.textContent)')
        check('专辑页有「分享专辑」按钮', any('分享专辑' in x for x in btns), str(btns)[:160])
        pg.screenshot(path=os.path.join(ROOT, 'tools', 'shot-album-share.png'))
        b.close()


def main():
    global ADMIN_TOKEN
    print('== 分享链接验证 (%s) ==' % USER)
    try:
        setup()
        run_api_cases()
        run_ui_cases()
    finally:
        cleanup()
    print('\n===== 结果：%d 通过 / %d 失败 =====' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
