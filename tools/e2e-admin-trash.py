#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理后台「音乐库」删除 / 回收站 UI 全链路 e2e。

覆盖：勾选行 → 删除所选（软删除）→ 进回收站 → 恢复所选 → 回到曲目表 → 彻底删除 → 回收站空。
前提：扫描目录里至少有一首可索引的曲目（脚本自己准备/清理测试文件）。

用法：python3 tools/e2e-admin-trash.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = 'http://localhost:20059'
ADMIN_PASS = _ADMIN_PASS
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 本机 urllib 会被 HTTP_PROXY 带着走（代理会 POST 打成 400），一律走无代理 opener
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LIB = os.environ.get('GS_LIB_DIR', os.path.join(ROOT, 'server/data/libraries/Slceleto'))
TEST_DIR = os.path.join(LIB, '回收站测试歌手', '测试专辑')
TEST_FILE = os.path.join(TEST_DIR, '回收站测试.mp3')
# 测试用音频源：任取一个本地存在的 mp3（都是环境里现成的测试产物）
SRC_CANDIDATES = ['/tmp/live-browser-dl.mp3', '/tmp/id3test.mp3', '/root/Downloads/new2.mp3']

passed = failed = skipped = 0
results = []


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  [PASS] %s  %s' % (name, extra))
    else:
        failed += 1
        print('  [FAIL] %s  %s' % (name, extra))
    results.append((name, bool(cond)))


def api(path, method='GET', body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('X-Admin-Token', token)
    data = json.dumps(body).encode() if body is not None else None
    with OPENER.open(req, data, timeout=60) as r:
        return json.loads(r.read().decode())


def prepare():
    """放一个可索引的测试曲目，并触发扫描"""
    os.makedirs(TEST_DIR, exist_ok=True)
    if not os.path.exists(TEST_FILE):
        src = next((s for s in SRC_CANDIDATES if os.path.exists(s)), None)
        if not src:
            raise SystemExit('缺少测试音频源：%s 都不存在' % SRC_CANDIDATES)
        subprocess.run(['cp', src, TEST_FILE], check=True)
    return api('/admin/api/library/scan', 'POST', {}, TOKEN)


def cleanup():
    """清掉测试目录与残留（彻底删除后目录会空，顺手删掉）"""
    if os.path.exists(TEST_FILE):
        os.remove(TEST_FILE)
    for d in (TEST_DIR, os.path.dirname(TEST_DIR)):
        try:
            os.rmdir(d)
        except OSError:
            pass


TOKEN = api('/admin/login', 'POST', {'password': ADMIN_PASS})['token']

print('\n== 0. 准备：放入测试曲目并扫描 ==')
prepare()
deadline = time.time() + 60
n = 0
while time.time() < deadline:
    st = api('/admin/api/library/stats', token=TOKEN)['data']
    if not st['scan'].get('scanning'):
        n = st['tracks']
        break
    time.sleep(2)
check('扫描后曲库里有测试曲目', n >= 1, 'tracks=%d' % n)
if n < 1:
    print('\n无法继续（曲库为空）')
    cleanup()
    sys.exit(1)

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1440, 'height': 1000})
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)[:200]))
    page.on('console', lambda m: errs.append('[console:error] ' + m.text[:150]) if m.type == 'error' else None)
    page.on('dialog', lambda d: d.accept())          # confirm() 一律确认
    bad = []
    page.on('response', lambda r: bad.append('%d %s' % (r.status, r.url)) if r.status >= 400 else None)

    page.goto(BASE + '/admin/', wait_until='domcontentloaded')
    page.evaluate("([p, t]) => { localStorage.setItem('gusi-admin-token', t); }", [ADMIN_PASS, TOKEN])
    page.reload(wait_until='domcontentloaded')
    # 注意：音乐库 tab 默认 hidden，里面的 .stat / 表格都不可见；
    # 必须先切 tab 再等元素可见，否则 wait_for_selector 会一直等 visible
    page.wait_for_selector('#shell', state='visible', timeout=15000)
    page.click('.tab[data-tab="library"]')
    page.wait_for_selector('.tab-page:not([hidden]) #lib-stats .stat', timeout=15000)
    page.wait_for_timeout(1000)
    # 注入 token 之前那次加载必然带几个 401（页面还不知道 token），与本流程无关：
    # 清空后再开始断言，只认测试期间真正冒出来的错误
    errs.clear(); bad.clear()

    print('\n== 1. 音乐库页 UI 元素齐全 ==')
    ui = page.evaluate("""() => ({
      removeSel: !!document.querySelector('#btn-remove-sel'),
      rowDel: document.querySelectorAll('#track-tbody .act-del').length,
      trashCard: !!document.querySelector('#trash-tbody'),
      purgeAll: !!document.querySelector('#btn-trash-purge-all'),
      refresh: !!document.querySelector('#btn-trash-refresh'),
      rows: document.querySelectorAll('#track-tbody tr[data-id]').length,
    })""")
    check('批量栏有「删除所选」', ui['removeSel'], str(ui))
    check('行内操作有「删除」按钮', ui['rowDel'] >= 1, 'act-del=%d' % ui['rowDel'])
    check('回收站卡片已渲染', ui['trashCard'] and ui['purgeAll'] and ui['refresh'], str(ui))
    check('曲目表有行可操作', ui['rows'] >= 1, 'rows=%d' % ui['rows'])
    page.screenshot(path=os.path.join(ROOT, 'tools/shot-admin-library-trash.png'), full_page=False)

    print('\n== 2. 勾选 → 删除所选（软删除） ==')
    page.click('#chk-all')
    page.wait_for_timeout(300)
    check('批量栏显示已选数量', page.inner_text('#sel-count').strip() == '已选 %d 项' % ui['rows'],
          page.inner_text('#sel-count').strip())
    page.click('#btn-remove-sel')
    page.wait_for_timeout(2000)
    after = page.evaluate("""() => ({
      rows: document.querySelectorAll('#track-tbody tr[data-id]').length,
      empty: (document.querySelector('#track-tbody .empty') || {}).textContent || '',
      trash: document.querySelectorAll('#trash-tbody tr[data-path]').length,
      tname: (document.querySelector('#trash-tbody tr[data-path] .t-name') || {}).textContent || '',
    })""")
    check('曲目表已清空', after['rows'] == 0, 'rows=%d empty=%s' % (after['rows'], after['empty']))
    check('回收站出现该曲目', after['trash'] >= 1, 'trash=%d name=%s' % (after['trash'], after['tname']))
    trash_root = os.path.join(LIB, '.gusi-trash')
    check('文件已移到 .gusi-trash（原路径已空）', (not os.path.exists(TEST_FILE)) and os.path.exists(trash_root),
          '原文件存在=%s 回收站目录存在=%s' % (os.path.exists(TEST_FILE), os.path.exists(trash_root)))

    print('\n== 3. 回收站勾选 → 恢复所选 ==')
    page.click('#trash-all')
    page.wait_for_timeout(300)
    page.click('#btn-trash-restore')
    page.wait_for_timeout(2500)
    # 恢复会触发重扫，等曲目回到表里
    back = {'rows': 0}
    for _ in range(20):
        back = page.evaluate("""() => ({
          rows: document.querySelectorAll('#track-tbody tr[data-id]').length,
          trash: document.querySelectorAll('#trash-tbody tr[data-path]').length,
        })""")
        if back['rows'] >= 1 and back['trash'] == 0:
            break
        page.wait_for_timeout(1000)
    check('曲目回到曲目表', back['rows'] >= 1, 'rows=%d' % back['rows'])
    check('回收站已清空', back['trash'] == 0, 'trash=%d' % back['trash'])
    check('文件已回到原路径', os.path.exists(TEST_FILE), TEST_FILE)

    print('\n== 4. 再次删除 → 彻底删除所选 ==')
    page.click('#chk-all')
    page.wait_for_timeout(300)
    page.click('#btn-remove-sel')
    page.wait_for_timeout(2000)
    page.click('#trash-all')
    page.wait_for_timeout(300)
    page.click('#btn-trash-purge-sel')
    page.wait_for_timeout(2000)
    gone = page.evaluate("""() => ({
      trash: document.querySelectorAll('#trash-tbody tr[data-path]').length,
      empty: (document.querySelector('#trash-tbody .empty') || {}).textContent || '',
    })""")
    check('回收站已排空', gone['trash'] == 0, 'trash=%d empty=%s' % (gone['trash'], gone['empty']))
    check('文件已从磁盘真正删除', not os.path.exists(TEST_FILE), '存在=%s' % os.path.exists(TEST_FILE))
    check('.gusi-trash 空目录已清理', not os.listdir(os.path.join(LIB, '.gusi-trash')) if os.path.exists(os.path.join(LIB, '.gusi-trash')) else True,
          '存在=%s' % os.path.exists(os.path.join(LIB, '.gusi-trash')))
    check('全程无 JS 运行时错误', not errs, str(errs[-3:]))
    check('测试期间无 4xx/5xx 请求', not bad, str(bad[:4]))
    b.close()

cleanup()
print('\n===== 汇总：%d 通过 / %d 失败 =====' % (passed, failed))
sys.exit(1 if failed else 0)
