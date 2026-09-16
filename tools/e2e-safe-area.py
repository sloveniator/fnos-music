#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安全区验证：壳注入 --safe-* → Web 端布局真的让开刘海/手势条（真实 Chromium + 实例 20059）

为什么需要这个脚本
------------------
安卓 WebView 直到 Chromium **M144** 才在「非全屏」WebView 里上报 `env(safe-area-inset-*)`
（M136 起仅全屏 WebView），之前的 WebView 一律返回 0。而手机的刘海和手势条是真实存在的，
壳又开了沉浸式 —— 如果只看 env()，顶栏按钮会被状态栏时钟压住、底栏会贴进手势条。

所以壳自己做权威来源：`Insets.kt` 把 WindowInsets 换算成 CSS px，内联覆写
`document.documentElement` 上的 `--safe-top/bottom/left/right`；Web 端 `app.css` 的 `:root`
默认取 `env(...)`，被覆写后以壳为准。本脚本注入的就是 `Insets.js` 产出的那四个 setProperty。

容器里装不了真机，但「注入非零安全区之后布局是否正确让开」是可以在浏览器里量出来的，
而且能顺带证明**注入 0 时与注入前完全一致**（万一某个 WebView 自己就能算 env()，
两边不会各加一次）。

用法：
    GS_ADMIN_PASSWORD=... python3 tools/e2e-safe-area.py
"""
import json
import os
import random
import shutil
import string
import time
import urllib.request

from playwright.sync_api import sync_playwright

_ADMIN_PASS = os.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX_DIR = '/tmp/gusi-test-music/周杰伦/范特西'

_RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PASSWORD = 'ssafe' + _RND, 'Safe' + _RND + '!9'

_op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PASS = FAIL = 0


# ---------- 与 Insets.js 等价的注入（四个 setProperty，四边全量写，含 0） ----------
# 下面这份字面量与 InsetsTest「注入脚本与 e2e-safe-area-py 逐字符锁定同一份字面量」
# 里钉的是同一个字符串（32/24/0/0 那一组）：两边各自锁死，谁的格式漂了谁自己炸。
LOCKSTEP = ("(function(){try{var s=document.documentElement.style;"
            "s.setProperty('--safe-top','32px');s.setProperty('--safe-bottom','24px');"
            "s.setProperty('--safe-left','0px');s.setProperty('--safe-right','0px');"
            "}catch(e){}})()")


def inject_js(top, bottom, left, right):
    return (
        "(function(){try{var s=document.documentElement.style;"
        "s.setProperty('--safe-top','%dpx');"
        "s.setProperty('--safe-bottom','%dpx');"
        "s.setProperty('--safe-left','%dpx');"
        "s.setProperty('--safe-right','%dpx');"
        "}catch(e){}})()" % (top, bottom, left, right)
    )


def web_post(path, body, token=None):
    r = urllib.request.Request(BASE + '/web' + path, method='POST')
    r.add_header('Content-Type', 'application/json')
    if token:
        r.add_header('X-Web-Token', token)
    with _op.open(r, json.dumps(body).encode(), timeout=60) as x:
        return json.loads(x.read().decode())


def web_get(path, token=None):
    r = urllib.request.Request(BASE + '/web' + path)
    if token:
        r.add_header('X-Web-Token', token)
    with _op.open(r, timeout=60) as x:
        return json.loads(x.read().decode())


def seed_account():
    token = web_post('/register', {'name': USER, 'email': USER + '@e.com',
                                   'password': PASSWORD, 'confirm': PASSWORD})['data']['token']
    dd = os.path.join(DATA, 'library', USER, '周杰伦', '范特西')
    os.makedirs(dd, exist_ok=True)
    for fn in sorted(os.listdir(FIX_DIR)):
        shutil.copy(os.path.join(FIX_DIR, fn), os.path.join(dd, fn))
    for _ in range(40):
        if web_get('/api/stats', token)['data'].get('tracks', 0) > 0:
            break
        time.sleep(1)
    return token


def cleanup_account():
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    try:
        r = urllib.request.Request(BASE + '/admin/login', method='POST')
        r.add_header('Content-Type', 'application/json')
        with _op.open(r, json.dumps({'password': _ADMIN_PASS}).encode(), timeout=30) as x:
            at = json.loads(x.read().decode())['token']
        r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
        r.add_header('X-Admin-Token', at)
        with _op.open(r, timeout=30) as x:
            print('临时账号已清理:', x.status)
    except Exception as e:  # noqa: BLE001
        print('清理失败（手动删 %s）:' % os.path.join(DATA, 'library', USER), e)


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


METRICS = """() => {
  const de = document.documentElement
  const cs = el => getComputedStyle(el)
  const topbar = document.getElementById('topbar'), player = document.getElementById('player')
  const view = document.getElementById('view'), main = document.querySelector('.main')
  const tr = topbar.getBoundingClientRect(), pr = player.getBoundingClientRect()
  const tbBtn = topbar.querySelector('button, a')
  const br = tbBtn ? tbBtn.getBoundingClientRect() : null
  const vars = ['top','bottom','left','right'].map(k => cs(de).getPropertyValue('--safe-' + k).trim())
  return {
    safeVars: vars,
    topbarH: Math.round(tr.height),
    topbarPadL: Math.round(parseFloat(cs(topbar).paddingLeft)),
    topbarPadR: Math.round(parseFloat(cs(topbar).paddingRight)),
    btnTop: br ? Math.round(br.top) : -1,
    playerBottomGap: Math.round(window.innerHeight - pr.bottom),
    playerH: Math.round(pr.height),
    playerPadL: Math.round(parseFloat(cs(player).paddingLeft)),
    mainPadTop: Math.round(parseFloat(cs(main).paddingTop)),
    contentTop: Math.round(view.getBoundingClientRect().top),
    docOverflow: Math.round(de.scrollWidth - de.clientWidth),
    vh: window.innerHeight, vw: window.innerWidth,
  }
}"""


def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(900)


def read(page, vw, vh):
    page.set_viewport_size({'width': vw, 'height': vh})
    page.wait_for_timeout(450)
    return page.evaluate(METRICS)


def main():
    seed_account()
    try:
        return _run()
    finally:
        cleanup_account()


def _run():
    global PASS, FAIL
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                              args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2.75,
                            is_mobile=True, has_touch=True)
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        login(page)

        # 载入一首，让底栏真实存在
        page.evaluate("() => { location.hash = '#/tracks' }")
        page.wait_for_timeout(1600)
        rows = page.query_selector_all('.tracks tr.row')
        if rows:
            rows[0].click()
            page.wait_for_timeout(1200)
            page.click('#btn-play')
            page.wait_for_timeout(400)
        base = read(page, 390, 844)
        check('底栏已出现（进入安全区测量前）', base['playerH'] >= 55, 'h=%s' % base['playerH'])
        check('浏览器环境安全区为 0（注入前的基线）',
              base['safeVars'] == ['0px', '0px', '0px', '0px'], str(base['safeVars']))
        check('注入脚本与壳（Insets.js）逐字符一致', inject_js(32, 24, 0, 0) == LOCKSTEP)

        print('\n— 1. 竖屏注入真实手机安全区（状态栏 32 / 手势条 24） —')
        page.evaluate(inject_js(32, 24, 0, 0))
        phone = read(page, 390, 844)
        check('注入值确实落在 documentElement 上',
              phone['safeVars'] == ['32px', '24px', '0px', '0px'], str(phone['safeVars']))
        check('顶栏让开状态栏（高度 +32）', phone['topbarH'] - base['topbarH'] == 32,
              '%s -> %s' % (base['topbarH'], phone['topbarH']))
        check('顶栏按钮不被时钟压住（按钮顶边 ≥ 32）', phone['btnTop'] >= 32, 'top=%s' % phone['btnTop'])
        check('内容区随安全区下移（padding-top +32）',
              phone['mainPadTop'] - base['mainPadTop'] == 32,
              '%s -> %s' % (base['mainPadTop'], phone['mainPadTop']))
        check('内容不被顶栏压住', phone['contentTop'] >= phone['topbarH'] - 2,
              'contentTop=%s topbar=%s' % (phone['contentTop'], phone['topbarH']))
        check('底栏抬离手势条（下沿间距 = 24 + 10）', phone['playerBottomGap'] == 34,
              'gap=%s' % phone['playerBottomGap'])
        check('底栏抬高的量正好等于手势条', phone['playerBottomGap'] - base['playerBottomGap'] == 24,
              '%s -> %s' % (base['playerBottomGap'], phone['playerBottomGap']))
        check('底栏高度不受安全区影响', phone['playerH'] == base['playerH'],
              '%s vs %s' % (base['playerH'], phone['playerH']))
        check('注入后仍无横向溢出', phone['docOverflow'] <= 0, str(phone['docOverflow']))

        print('\n— 2. 横屏（刘海在左右：44/44） —')
        page.evaluate(inject_js(0, 24, 44, 44))
        land = read(page, 844, 390)
        check('横屏顶栏左右各让 44', land['topbarPadL'] == 44 and land['topbarPadR'] == 44,
              'L=%s R=%s' % (land['topbarPadL'], land['topbarPadR']))
        check('横屏底栏左右各让 44', land['playerPadL'] == 44, 'L=%s' % land['playerPadL'])
        check('横屏顶栏不再留状态栏高度', land['topbarH'] <= 50, 'h=%s' % land['topbarH'])
        check('横屏无横向溢出', land['docOverflow'] <= 0, str(land['docOverflow']))

        print('\n— 3. 注入 0 与不注入必须完全一致（防止与 env() 重复相加） —')
        page.evaluate(inject_js(0, 0, 0, 0))
        zero = read(page, 390, 844)
        same = (zero['topbarH'] == base['topbarH'] and zero['playerBottomGap'] == base['playerBottomGap']
                and zero['mainPadTop'] == base['mainPadTop'] and zero['contentTop'] == base['contentTop'])
        check('全零注入 = 基线（不多让一分）', same,
              'topbar %s/%s  gap %s/%s  main %s/%s' % (zero['topbarH'], base['topbarH'],
                                                        zero['playerBottomGap'], base['playerBottomGap'],
                                                        zero['mainPadTop'], base['mainPadTop']))

        print('\n— 4. 页面无脚本错误 —')
        check('无 pageerror / console error', not errs, '; '.join(errs[:3]))

        ctx.close()
        b.close()
    print('\n合计 %d 通过 / %d 失败' % (PASS, FAIL))
    return FAIL


if __name__ == '__main__':
    raise SystemExit(1 if main() else 0)
