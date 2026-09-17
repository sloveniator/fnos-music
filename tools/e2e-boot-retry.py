#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2026-09-17 主人：「每次关闭后台再打开，还要输入账号密码」的定向验证。

安卓壳冷启动那一两秒里，`/web/me` 失败太常见了（Wi‑Fi 刚醒、服务端在忙、WebView 刚起来），
而旧代码把「请求失败」和「会话过期」混为一谈：

    try { const d = await api('/me') } catch { return showLogin() }   // 旧写法

于是每次打开都可能被踢到登录页 —— 看着就是「又要重新输账号密码」。现在：
  · 只有服务端明确回 401（会话真的没了）才回登录页，并清掉 token；
  · 其它错（网络直接抛、5xx）退避重试 4 次（0/400/1000/2200ms），重试完还不行就
    显示「连不上服务器 + 重试」界面，**token 不动**，网络一恢复点重试就进去。

验证项（390×844，SW 屏蔽以免影响请求拦截）：
  R1 token 在 + /me 前两次 500、第三次 200 → 直接进应用，全程没出现过登录页
  R2 token 在 + /me 一直 500 → 出「连不上服务器」而不是登录页；token 仍在 localStorage
  R3 token 在 + /me 回 401（会话真过期）→ 回登录页，token 被清、不显示「连不上」
  R4 R2 之后点「重试」（网络恢复）→ 不输密码直接进应用
  R5 没有 token（全新设备）→ 照旧是登录页（不能把登录入口弄丢）

用法：python3 tools/e2e-boot-retry.py     （BASE 可用 GS_BASE 覆盖）
"""
import json, os, random, shutil, string, sys, time, urllib.request

BASE = os.environ.get('GS_BASE', 'http://localhost:20059')
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'bootrt' + RND, 'Btr' + RND + '!9'
P = F = 0
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def check(name, cond, detail=''):
    global P, F
    if cond:
        P += 1; print('  [PASS] %s  -- %s' % (name, detail))
    else:
        F += 1; print('  [FAIL] %s  -- %s' % (name, detail))


def post(path, body, t=None):
    r = urllib.request.Request(BASE + '/web' + path, method='POST')
    r.add_header('Content-Type', 'application/json')
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, json.dumps(body).encode(), timeout=60) as x:
        return json.loads(x.read().decode())


STATE = """() => {
  const q = (s) => document.querySelector(s);
  return {
    login: !q('#login').hidden, shell: !q('#shell').hidden, net: !q('#net-err').hidden,
    detail: q('#net-err-detail') ? q('#net-err-detail').textContent : '',
    token: localStorage.getItem('gusi-web-token') || '',
    btn: q('#net-retry') ? q('#net-retry').textContent.trim() : '',
  };
}"""


def main():
    tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
    print('临时用户 %s（token %s…）' % (USER, tok[:8]))

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

        def new_page(tokv, me_plan):
            """me_plan: 每次 /me 请求的响应 —— ('500', n) 前 n 次 500 后放行 / 'always500' / '401' / None"""
            ctx = b.new_context(viewport={'width': 390, 'height': 844}, service_workers='block',
                                user_agent='Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 '
                                           '(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 GusiMusicApp/1.0.30')
            hits = {'n': 0}
            if me_plan:
                def handler(route):
                    if route.request.url.endswith('/web/me'):
                        hits['n'] += 1
                        if me_plan == 'always500' or (isinstance(me_plan, tuple) and hits['n'] <= me_plan[1]):
                            route.fulfill(status=500, content_type='application/json',
                                          body=json.dumps({'code': -1, 'msg': 'mock 500'}))
                            return
                        if me_plan == '401':
                            route.fulfill(status=401, content_type='application/json',
                                          body=json.dumps({'code': -1, 'msg': 'mock 未登录'}))
                            return
                    route.continue_()
                ctx.route('**/web/me', handler)
            pg = ctx.new_page()
            if tokv:
                pg.add_init_script("localStorage.setItem('gusi-web-token', %s)" % json.dumps(tokv))
            pg.goto(BASE + '/#/tracks')
            return ctx, pg, hits

        # R1：前两次 500，第三次成功
        print('\n== R1 /me 前两次 500、第三次 200（Wi‑Fi 刚醒那种抖动）==')
        ctx, pg, hits = new_page(tok, (500, 2))
        try:
            pg.wait_for_selector('#shell:not([hidden])', timeout=20000)
            s = pg.evaluate(STATE)
            check('R1a 直接进应用（#shell 可见）', s['shell'], s)
            check('R1b 结束时也不是登录页', not s['login'] and not s['net'], s)
            check('R1c 重试次数符合预期（≥3 次请求 /me）', hits['n'] >= 3, 'hits=%s' % hits['n'])
            check('R1d token 没被清掉', s['token'] == tok, s['token'][:8])
        finally:
            ctx.close()

        # R2：一直 500
        print('\n== R2 /me 一直 500（服务端在忙）==')
        ctx, pg, hits = new_page(tok, 'always500')
        try:
            pg.wait_for_selector('#net-err:not([hidden])', timeout=25000)
            s = pg.evaluate(STATE)
            check('R2a 显示「连不上服务器」而不是登录页', s['net'] and not s['login'], s)
            check('R2b 界面上有重试按钮', '重' in s['btn'], s['btn'])
            check('R2c token 仍在 localStorage（没有把人登出）', s['token'] == tok, s['token'][:8])
            check('R2d 退避重试确实发生了（/me ≥4 次）', hits['n'] >= 4, 'hits=%s' % hits['n'])
            # R4：网络恢复 → 点重试直接进
            print('\n== R4 网络恢复后点「重试」==')
            ctx.unroute('**/web/me')
            pg.click('#net-retry')
            pg.wait_for_selector('#shell:not([hidden])', timeout=15000)
            s2 = pg.evaluate(STATE)
            check('R4a 不输密码直接进应用', s2['shell'] and not s2['login'] and not s2['net'], s2)
            check('R4b token 还是原来那个（没有被换掉）', s2['token'] == tok, s2['token'][:8])
        finally:
            ctx.close()

        # R3：401
        print('\n== R3 /me 回 401（会话真的过期）==')
        ctx, pg, hits = new_page(tok, '401')
        try:
            pg.wait_for_selector('#login:not([hidden])', timeout=15000)
            s = pg.evaluate(STATE)
            check('R3a 回登录页', s['login'] and not s['net'], s)
            check('R3b 过期 token 被清掉', s['token'] == '', s['token'][:8])
        finally:
            ctx.close()

        # R5：没有 token
        print('\n== R5 没有 token（全新设备）==')
        ctx, pg, hits = new_page('', None)
        try:
            pg.wait_for_selector('#login:not([hidden])', timeout=15000)
            s = pg.evaluate(STATE)
            check('R5 照旧显示登录页（登录入口没弄丢）', s['login'] and not s['shell'] and not s['net'], s)
        finally:
            ctx.close()
        b.close()

    print('\n== 结果：%d 通过 / %d 失败 ==' % (P, F))
    return 1 if F else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
        shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
        ap = os.environ.get('GS_ADMIN_PASSWORD', '')
        if not ap:
            print('未设 GS_ADMIN_PASSWORD，临时账号 %s 未清理（曲库目录已删）' % USER)
        else:
            try:
                r = urllib.request.Request(BASE + '/admin/login', method='POST')
                r.add_header('Content-Type', 'application/json')
                with op.open(r, json.dumps({'password': ap}).encode(), timeout=30) as x:
                    at = json.loads(x.read().decode())['token']
                r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
                r.add_header('X-Admin-Token', at)
                with op.open(r, timeout=30) as x:
                    print('临时账号 %s 已清理：HTTP %s' % (USER, x.status))
            except Exception as e:
                print('清理 %s 失败：%s' % (USER, e))
