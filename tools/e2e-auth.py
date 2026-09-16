#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
登录 / 注册（账号 + 密码 + 邮箱）验证 —— 真实 Chromium + 线上实例 localhost:20059

用法：
    python3 tools/e2e-auth.py

覆盖：
  1. 接口层：/web/login-state 的 registerOpen / firstRun；注册校验（缺邮箱 / 邮箱格式 / 密码不足 6 位 /
     邮箱重复 / 用户名重复）；注册成功即发 token；密码错误文案为「用户名或密码错误」（不再是「连接码」）
     密码规范只要求 6 位以上，不强制大小写 / 数字 / 符号组合
  2. 登录页：字段标签为「用户名 / 密码」、页面不再出现「连接码」、「立即注册」入口可见
  3. 注册表单：邮箱为必填 email 输入（原生校验拦非法格式，JS 前置校验拦「缺 TLD」这类漏网格式）
  4. 注册成功自动登录：#shell 出现、#who 为新账号、刷新后仍登录（token 落 localStorage）
  5. 退出登录 → 错密码报错文案（必须透出服务端文案，不能被「登录已过期」吃掉）→ 正确密码可登录
  6. 管理后台：用户列表能看到网页注册用户（邮箱 + 「网页注册」标记），操作为「重置密码」，
     重置密码弹窗与接口都只要求 6 位以上（不足 6 位被拒、6 位简单密码可用）
  7. 清理：删除本次所有测试账号并确认删后无法登录

关于限流：注册失败是「每 IP 3 次 / 15 分钟」的内存桶，成功注册会清零。
    所以本脚本把连续失败数压到 ≤2，并在每组失败后插一次真实注册来清零，
    最后一次注册放在界面注册（Phase B）里，保证脚本跑完桶是干净的、可以连着重跑。
    界面里那两处格式校验走前端前置校验，不会打到接口、不占失败额度。
"""
import json
import random
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', _APP_PASS
ADMIN_PASS = _ADMIN_PASS
PASS = FAIL = 0

# 每次跑用独立账号，避免与上一轮的残留冲突
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
NEW_USER = 'e2e' + RND            # 接口层注册的账号
NEW_PASS = 'E2e' + RND + '!9'
NEW_EMAIL = NEW_USER + '@example.com'
RESET_USER = NEW_USER + 'r'       # 用来把「注册失败计数」清零的中转账号
SIMPLE_USER = NEW_USER + 's'      # 只用「6 位小写字母+数字」注册：新规范不要求大小写/符号
SIMPLE_PASS = 'abc123'
UI_USER = NEW_USER + 'ui'         # 界面注册的账号
UI_EMAIL = UI_USER + '@example.com'

CREATED = []      # 本次跑出来的测试账号（供清理）
AT = ''           # 管理后台 token

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def api(path, token=None, method='GET', body=None):
    """成功返回解析后的包；失败抛 ApiError(msg)"""
    req = urllib.request.Request(BASE + '/web' + path, method=method)
    if token:
        req.add_header('X-Web-Token', token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    try:
        with _opener.open(req, data, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            raise ApiError(json.loads(e.read().decode()).get('msg', ''), e.code)
        except ValueError:
            raise ApiError('HTTP %d' % e.code, e.code)


def admin_api(path, token, method='GET', body=None):
    req = urllib.request.Request(BASE + '/admin' + path, method=method)
    req.add_header('X-Admin-Token', token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
    with _opener.open(req, data, timeout=30) as r:
        return json.loads(r.read().decode())


def admin_token():
    req = urllib.request.Request(BASE + '/admin/login', method='POST')
    req.add_header('Content-Type', 'application/json')
    with _opener.open(req, json.dumps({'password': ADMIN_PASS}).encode(), timeout=30) as r:
        return json.loads(r.read().decode())['token']


def admin_err(path, body, method='POST'):
    """后台接口预期失败时取错误文案（成功返回空串）"""
    try:
        admin_api(path, AT, method=method, body=body)
        return ''
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()).get('message', '')
        except ValueError:
            return 'HTTP %d' % e.code


def cleanup():
    """删除本次创建的测试账号（幂等，崩溃路径也会被 finally 调到）。返回残留名单。"""
    if not AT:
        return list(CREATED)
    for _ in range(3):
        left = [u['name'] for u in admin_api('/api/users', AT)['users']]
        todo = [n for n in CREATED if n in left]
        if not todo:
            return []
        for n in todo:
            try:
                admin_api('/api/users/' + urllib.parse.quote(n) + '?purge=1', AT, method='DELETE')
            except Exception as e:
                print('  清理 %s 失败: %s' % (n, e))
    left = [u['name'] for u in admin_api('/api/users', AT)['users']]
    return [n for n in CREATED if n in left]


def reg_body(name, email, pw=None):
    pw = pw or NEW_PASS
    return {'name': name, 'email': email, 'password': pw, 'confirm': pw}


def reg_ok(name, email, pw=None):
    """注册成功（同时清零失败计数），登记到清理名单"""
    r = api('/register', method='POST', body=reg_body(name, email, pw))['data']
    CREATED.append(name)
    return r


def err_of(fn, *a, **kw):
    try:
        fn(*a, **kw)
        return ''
    except ApiError as e:
        return e.msg


def run_all():
    print('\n— 1. 接口层：注册开关与校验 —')
    st = api('/login-state')['data']
    check('注册默认开放（registerOpen=true）', st.get('registerOpen') is True, json.dumps(st, ensure_ascii=False))
    check('已有账号时 firstRun=false（登录页是默认视图）', st.get('firstRun') is False)

    # 失败 1-2（限流上限 3，压到 2）
    m = err_of(api, '/register', method='POST', body={'name': NEW_USER, 'password': NEW_PASS, 'confirm': NEW_PASS})
    check('缺邮箱被拒', m == '请填写邮箱', m)
    m = err_of(api, '/register', method='POST', body=reg_body(NEW_USER, 'not-an-email'))
    check('邮箱格式错被拒', m == '邮箱格式不正确', m)

    r = reg_ok(NEW_USER, NEW_EMAIL)
    check('注册成功并直接发 token', bool(r.get('token')) and r.get('name') == NEW_USER)
    check('新账号可登录', bool(api('/login', method='POST',
                              body={'name': NEW_USER, 'password': NEW_PASS})['data']['token']))
    m = err_of(api, '/login', method='POST', body={'name': NEW_USER, 'password': 'wrong-pass'})
    check('密码错误文案为「用户名或密码错误」', m == '用户名或密码错误', m)
    check('文案里没有「连接码」', '连接码' not in m)

    # 失败 3-4，随后插一次成功注册清零
    m = err_of(api, '/register', method='POST', body=reg_body(NEW_USER + 'w', NEW_USER + 'w@example.com', '12345'))
    check('不足 6 位的密码被拒', m == '密码需 6-128 位', m)
    m = err_of(api, '/register', method='POST', body=reg_body(NEW_USER + '2', NEW_EMAIL))
    check('同邮箱不可重复注册', m == '该邮箱已被注册', m)
    reg_ok(RESET_USER, RESET_USER + '@example.com')
    # 密码规范：只要 6 位以上 —— 6 位纯小写字母+数字必须能注册（不再强制大小写/数字/符号组合）
    check('6 位简单密码可注册（不要求大小写/符号）', bool(reg_ok(SIMPLE_USER, SIMPLE_USER + '@example.com', SIMPLE_PASS).get('token')))
    check('简单密码可登录', bool(api('/login', method='POST',
                               body={'name': SIMPLE_USER, 'password': SIMPLE_PASS})['data']['token']))

    # 失败 5（后面界面注册成功会把桶清零）
    m = err_of(api, '/register', method='POST', body=reg_body(NEW_USER, 'dup-' + NEW_EMAIL))
    check('同名不可重复注册', m == '用户名已被占用', m)

    users = admin_api('/api/users', AT)['users']
    me = [u for u in users if u['name'] == NEW_USER]
    check('管理后台用户列表含网页注册用户', len(me) == 1, json.dumps(users, ensure_ascii=False)[:200])
    check('列表带出邮箱与来源标记', bool(me) and me[0]['email'] == NEW_EMAIL and me[0]['source'] == 'web')

    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                               args=['--autoplay-policy=no-user-gesture-required'])
        errs = []      # 未捕获的 JS 异常 / 真正的 console.error
        bad = []       # >=400 的响应（带 URL），用来判断是不是预期内的那次错密码
        ctx = b.new_context(viewport={'width': 1440, 'height': 900})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        # 「Failed to load resource」是失败响应的回声，单独用 bad 统计，避免重复计数
        page.on('console', lambda m: errs.append('console: ' + m.text)
                if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        page.on('response', lambda r: bad.append('%d %s' % (r.status, r.url)) if r.status >= 400 else None)

        print('\n— 2. 登录页 —')
        page.goto(BASE + '/', wait_until='domcontentloaded')
        page.wait_for_selector('#login', state='visible', timeout=20000)
        page.wait_for_timeout(700)
        labels = page.eval_on_selector_all('#login-form label', 'els => els.map(e => e.textContent.trim())')
        check('登录字段为「用户名 / 密码」', labels == ['用户名', '密码'], ' | '.join(labels))
        check('页面上不再出现「连接码」', '连接码' not in page.evaluate("() => document.body.innerText"))
        check('登录页有「立即注册」入口',
              page.is_visible('#to-register') and '立即注册' in page.inner_text('#to-register-wrap'))

        print('\n— 3. 注册表单 —')
        page.click('#to-register')
        page.wait_for_timeout(300)
        check('切到注册表单（登录表单收起）',
              page.is_visible('#register-form') and not page.is_visible('#login-form'))
        check('邮箱字段存在且为 email 类型', page.get_attribute('#reg-email', 'type') == 'email')
        check('注册表单有「返回登录」',
              page.is_visible('#to-login') and '返回登录' in page.inner_text('#to-login-wrap'))
        check('注册表单字段齐全（用户名 / 邮箱 / 密码 / 确认密码）',
              page.eval_on_selector_all('#register-form label',
                                        "els => els.map(e => e.textContent.trim())")
              == ['用户名（1-32 位字母/数字/_）', '邮箱',
                  '密码（至少 6 位）', '确认密码'])

        page.fill('#reg-name', UI_USER)
        page.fill('#reg-email', 'bad@@mail')
        page.fill('#reg-pass', NEW_PASS)
        page.fill('#reg-pass2', NEW_PASS)
        page.click('#reg-btn')
        page.wait_for_timeout(400)
        check('非法邮箱被拦下（原生校验：输入框 invalid、未提交）',
              page.eval_on_selector('#reg-email', 'e => !e.checkValidity()')
              and page.inner_text('#reg-err').strip() == '' and page.is_visible('#register-form'))

        page.fill('#reg-email', 'bad@mail')
        page.click('#reg-btn')
        page.wait_for_timeout(400)
        e1 = page.inner_text('#reg-err')
        check('缺 TLD 的邮箱被前端前置校验拦下', '邮箱' in e1, e1)

        page.fill('#reg-email', UI_EMAIL)
        page.fill('#reg-pass2', NEW_PASS + 'x')
        page.click('#reg-btn')
        page.wait_for_timeout(400)
        e2 = page.inner_text('#reg-err')
        check('两次密码不一致被拦下', '不一致' in e2, e2)

        print('\n— 4. 注册成功即登录 —')
        page.fill('#reg-pass', NEW_PASS)
        page.fill('#reg-pass2', NEW_PASS)
        page.click('#reg-btn')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        CREATED.append(UI_USER)
        page.wait_for_timeout(1200)
        check('注册后自动进入应用', page.is_visible('#shell'))
        check('左下角显示新账号名', page.inner_text('#who').strip() == UI_USER, page.inner_text('#who'))
        check('token 落在 localStorage', bool(page.evaluate("() => localStorage.getItem('gusi-web-token')")))
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        check('刷新后仍保持登录', page.is_visible('#shell'))

        print('\n— 5. 退出 / 错密码 / 重登 —')
        page.click('#logout')
        page.wait_for_selector('#login', state='visible', timeout=20000)
        page.wait_for_timeout(700)
        check('退出后回到登录页', page.is_visible('#login') and not page.is_visible('#shell'))
        page.fill('#login-name', UI_USER)
        page.fill('#login-pass', 'definitely-wrong')
        page.click('#login-btn')
        page.wait_for_timeout(800)
        e3 = page.inner_text('#login-err').strip()
        check('错密码提示「用户名或密码错误」（不再被「登录已过期」吃掉）',
              e3 == '用户名或密码错误', e3)
        page.fill('#login-pass', NEW_PASS)
        page.click('#login-btn')
        page.wait_for_selector('#shell:not([hidden])', timeout=20000)
        check('正确密码可登录', page.is_visible('#shell'))

        print('\n— 6. 管理后台用户列表 —')
        ap = ctx.new_page()
        ap.on('pageerror', lambda e: errs.append('admin pageerror: ' + str(e)))
        ap.goto(BASE + '/admin/', wait_until='domcontentloaded')
        ap.wait_for_selector('#login', state='visible', timeout=20000)
        ap.fill('#login-pass', ADMIN_PASS)
        ap.click('#login-btn')
        # 登录后默认停在「概览」页，用户表在 #tab-users 里（默认 hidden），必须先切页签
        ap.wait_for_selector('button.tab[data-tab="users"]', state='visible', timeout=20000)
        ap.click('button.tab[data-tab="users"]')
        ap.wait_for_selector('#user-tbody tr', state='visible', timeout=20000)
        ap.wait_for_timeout(1200)
        rows = ap.eval_on_selector_all('#user-tbody tr', 'els => els.map(e => e.innerText)')
        row = [r for r in rows if UI_USER in r]
        check('后台列出网页注册用户', len(row) == 1, ' | '.join(r.replace('\n', ' / ') for r in rows)[:240])
        check('后台显示邮箱', bool(row) and UI_EMAIL in row[0])
        check('后台标出「网页注册」', bool(row) and '网页注册' in row[0])
        check('操作按钮为「重置密码」而不是「重置连接码」',
              bool(row) and '重置密码' in row[0] and '连接码' not in row[0])
        check('后台页面文案不再出现「连接码」',
              '连接码' not in ap.evaluate("() => document.body.innerText"))
        # 密码规范（要求只有「6 位以上」）：后台重置密码弹窗要写明规则
        ap.click('#user-tbody tr:has-text("%s") button.act-pwd' % UI_USER)
        ap.wait_for_selector('#modal:not([hidden])', timeout=10000)
        modal = ap.inner_text('#modal')
        check('重置密码弹窗写明「至少 6 位」', '至少 6 位' in modal, modal.replace('\n', ' / ')[:120])
        ap.click('#modal-close')
        ap.wait_for_timeout(300)

        # 接口层同一套规范：不足 6 位被拒、6 位简单密码可重置并可登录
        m = admin_err('/api/users/' + urllib.parse.quote(UI_USER) + '/password', {'password': '12345'})
        check('后台重置密码：不足 6 位被拒', m == '密码至少 6 位', m)
        admin_api('/api/users/' + urllib.parse.quote(UI_USER) + '/password', AT,
                  method='POST', body={'password': SIMPLE_PASS})
        check('后台重置密码：6 位简单密码可用', bool(api('/login', method='POST',
                                                body={'name': UI_USER, 'password': SIMPLE_PASS})['data']['token']))

        leftover = [x for x in bad if not (x.startswith('401 ') and x.endswith('/web/login'))]
        check('无未捕获的 JS 异常 / console.error', not errs, ' | '.join(errs[:4]))
        check('除预期的错密码 401 外没有失败请求', not leftover, ' | '.join(leftover[:4]) + '（全部失败请求: ' + ' | '.join(bad) + '）')
        b.close()

    print('\n— 7. 清理与边界 —')
    left = cleanup()
    check('测试账号已删除', not left, ' | '.join(left))
    m = err_of(api, '/login', method='POST', body={'name': NEW_USER, 'password': NEW_PASS})
    check('删号后无法登录（文案一致，不泄漏账号是否存在）', m == '用户名或密码错误', m)

    print('\n结果：%d 通过 / %d 失败' % (PASS, FAIL))
    return 0 if FAIL == 0 else 1


def main():
    global AT
    print('接口注册账号: %s（%s）' % (NEW_USER, NEW_EMAIL))
    print('界面注册账号: %s（%s）' % (UI_USER, UI_EMAIL))
    AT = admin_token()
    try:
        return run_all()
    finally:
        left = cleanup()
        print('\n[清理] ' + ('测试账号已全部删除' if not left else '仍有残留: ' + ' | '.join(left)))


if __name__ == '__main__':
    sys.exit(main())
