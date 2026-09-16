#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公开源仓库批量抓取 / 入库升级 e2e（服务端接口 + 管理后台 UI）。

覆盖：
  1) GET  /admin/api/library/source-registries?refresh=1  列目录 + 下载 + 版本比较
  2) 缓存命中（不带 refresh 走缓存）
  3) 仓库增删（非法输入 / 重复 / 内置不可删）
  4) 升级链路：把 ikun 降级成仓库里的 v6 → 清单显示「可升级」→ apply 升回 v22
     → 二次 apply 变 skip；全程保留启用状态；结束时脚本内容与快照一致
  5) 管理后台 UI：清单/药丸/版本列 → 再降一次 v6 → 勾选批量入库 → 列表立刻不再显示未安装
  6) 收尾核对：ikun 与快照逐字节一致（含启用状态）
  5) UI：音源与代理页渲染清单、状态药丸、勾选 → 导入/升级所选 → 完成提示

用法：python3 tools/e2e-admin-registry.py
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = 'http://localhost:20059'
ADMIN_PASS = _ADMIN_PASS
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
OBSERVED_KEYS = ['qdy', 'lx', 'sixyin', 'flower', 'grass', 'huibq', 'ikun', 'juhe']

passed = failed = skipped = 0


def check(name, cond, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  [PASS] %s  %s' % (name, extra))
    else:
        failed += 1
        print('  [FAIL] %s  %s' % (name, extra))


def api(path, method='GET', body=None, token=None, timeout=120):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('X-Admin-Token', token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with OPENER.open(req, data, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def sha(s):
    return hashlib.sha256((s or '').encode()).hexdigest()


def registry(token, refresh=True, timeout=300):
    st, d = api('/admin/api/library/source-registries' + ('?refresh=1' if refresh else ''), token=token, timeout=timeout)
    return st, (d.get('data') or {})


def main():
    global passed, failed, skipped
    st, d = api('/admin/login', 'POST', {'password': ADMIN_PASS})
    token = (d.get('data') or d).get('token')
    if not token:
        raise SystemExit('管理后台登录失败: %r' % d)
    print('管理后台登录 OK')

    # 快照：ikun 的脚本与元信息（测完要一模一样）
    st, d = api('/admin/api/library/user-sources/ikun', token=token)
    snap_script = (d.get('data') or {}).get('script') or ''
    snap_meta = d.get('data') or {}
    check('起始快照：本地存在 ikun 源', bool(snap_script), '%dB enabled=%s' % (len(snap_script), snap_meta.get('enabled')))

    print('\n== 1. 抓取公开源仓库清单 ==')
    st, data = registry(token, True)
    lst = data.get('list') or []
    keys = [x['key'] for x in lst]
    check('接口 200', st == 200, 'HTTP %s' % st)
    check('至少列出 8 个音源', len(lst) >= 8, 'n=%d %s' % (len(lst), keys))
    check('内置仓库标记 ok', any(r.get('ok') for r in (data.get('registries') or [])),
          json.dumps(data.get('registries'), ensure_ascii=False)[:120])
    missing = [k for k in OBSERVED_KEYS if k not in keys]
    check('本地已装的 8 个源都在清单里', not missing, 'missing=%s' % missing)
    by_key = {x['key']: x for x in lst}
    aligned = [k for k in OBSERVED_KEYS if by_key.get(k, {}).get('installed', {}).get('id') == k]
    check('已装源按目录名与本地 id 对齐', len(aligned) == len(OBSERVED_KEYS),
          'aligned=%d/%d' % (len(aligned), len(OBSERVED_KEYS)))
    check('脚本头 @version 解析正确（qdy 9.3 / sixyin 1.2.1 / ikun v22 / huibq v1.2.0）',
          '9.3' in by_key['qdy']['versionRaw'] and '1.2.1' in by_key['sixyin']['versionRaw']
          and '22' in by_key['ikun']['versionRaw'] and '1.2.0' in by_key['huibq']['versionRaw'],
          ' | '.join('%s=%s' % (k, by_key[k]['versionRaw']) for k in ('qdy', 'sixyin', 'ikun', 'huibq')))
    same = [x['key'] for x in lst if x['state'] == 'same']
    check('内容一致的已装源判为「已是最新」', len(same) >= 6, 'same=%s' % same[:12])
    check('清单体积与仓库文件一致（qdy=31090B）', by_key['qdy']['bytes'] == 31090, '%dB' % by_key['qdy']['bytes'])
    new_keys = [x['key'] for x in lst if x['state'] == 'new']
    print('  [info] 未安装的源：%s' % (new_keys or '（已经全部入库）'))

    print('\n== 2. 缓存 ==')
    st, data2 = registry(token, False, timeout=60)
    check('不带 refresh 走缓存', data2.get('cached') is True, 'cached=%s' % data2.get('cached'))
    check('缓存清单与在线抓取一致', len(data2.get('list') or []) == len(lst), 'n=%d' % len(data2.get('list') or []))

    print('\n== 3. 仓库增删 ==')
    st, d = api('/admin/api/library/source-registries/add', 'POST', {'repo': 'not-a-repo'}, token=token)
    check('非法仓库被拒（400）', st == 400, 'HTTP %s %s' % (st, d.get('msg')))
    st, d = api('/admin/api/library/source-registries/add', 'POST', {'repo': 'https://github.com/e2etest/lx-music-source-fake'}, token=token)
    added = (d.get('data') or {}).get('registry') or {}
    check('按 GitHub 地址添加仓库', st == 200 and added.get('repo') == 'e2etest/lx-music-source-fake', json.dumps(added, ensure_ascii=False))
    st, d = api('/admin/api/library/source-registries/add', 'POST', {'repo': 'e2etest/lx-music-source-fake'}, token=token)
    check('重复仓库被拒（400）', st == 400, d.get('msg'))
    st, d = api('/admin/api/library/source-registries/remove', 'POST', {'id': 'pdone'}, token=token)
    check('内置仓库不可删', (d.get('data') or {}).get('removed') is False, json.dumps(d.get('data'), ensure_ascii=False))
    st, d = api('/admin/api/library/source-registries/remove', 'POST', {'id': added.get('id')}, token=token)
    check('移除自定义仓库', (d.get('data') or {}).get('removed') is True, 'id=%s' % added.get('id'))
    st, d = api('/admin/api/library/source-registries/apply', 'POST', {'keys': []}, token=token)
    check('空选择被拒（400）', st == 400, d.get('msg'))

    print('\n== 4. 升级链路：ikun v6 → v22 ==')
    old_url = 'https://cdn.jsdelivr.net/gh/pdone/lx-music-source@main/ikun/6.js'
    st, d = api('/admin/api/library/user-sources/fetch', 'POST', {'url': old_url}, token=token)
    old_script = (d.get('data') or {}).get('script') or ''
    check('取到仓库里的历史版本 ikun/6.js', st == 200 and 'v6' in old_script[:200], '%dB' % len(old_script))
    st, d = api('/admin/api/library/user-sources', 'POST', {'id': 'ikun', 'name': snap_meta.get('name') or 'ikun音源', 'script': old_script, 'enabled': bool(snap_meta.get('enabled'))}, token=token)
    check('把本地 ikun 降级为 v6', st == 200, 'HTTP %s' % st)
    st, data3 = registry(token, True)
    ik = next((x for x in (data3.get('list') or []) if x['key'] == 'ikun'), None) or {}
    check('清单识别为「可升级」', ik.get('state') == 'upgrade', 'state=%s 本地=%s 仓库=%s' % (ik.get('state'), (ik.get('installed') or {}).get('version'), ik.get('versionRaw')))
    # 缓存里存的是远端清单 + 当时的本地状态；本地刚被改过，命中缓存也必须立刻反映（回归：曾要等 TTL 过期）
    st, data3c = registry(token, False, timeout=60)
    ikc = next((x for x in (data3c.get('list') or []) if x['key'] == 'ikun'), None) or {}
    check('本地改过之后，不带 refresh 的缓存也反映新状态', data3c.get('cached') is True and ikc.get('state') == 'upgrade',
          'cached=%s state=%s 本地=%s' % (data3c.get('cached'), ikc.get('state'), (ikc.get('installed') or {}).get('version')))
    st, d = api('/admin/api/library/source-registries/apply', 'POST', {'keys': ['ikun']}, token=token, timeout=180)
    results = (d.get('data') or {}).get('results') or []
    check('apply 执行升级', results and results[0].get('action') == 'upgrade', json.dumps(results, ensure_ascii=False)[:200])
    st, d = api('/admin/api/library/user-sources/ikun', token=token)
    now = d.get('data') or {}
    check('升级后脚本内容回到最新版（与快照 sha 一致）', sha(now.get('script')) == sha(snap_script),
          'sha %s… / %s…' % (sha(now.get('script'))[:10], sha(snap_script)[:10]))
    check('升级保留原有启用状态', bool(now.get('enabled')) == bool(snap_meta.get('enabled')),
          'before=%s after=%s' % (snap_meta.get('enabled'), now.get('enabled')))
    check('升级写入脚本头版本', '22' in str(now.get('version')), 'version=%s' % now.get('version'))
    st, d = api('/admin/api/library/source-registries/apply', 'POST', {'keys': ['ikun']}, token=token, timeout=180)
    results = (d.get('data') or {}).get('results') or []
    check('已是最新时 apply 直接跳过（不重复下载写盘）', results and results[0].get('action') == 'skip', json.dumps(results, ensure_ascii=False)[:160])
    # 升级完再读缓存：installed 必须已经是仓库版本（回归：曾一直显示「未安装 / 可升级」）
    st, data4 = registry(token, False, timeout=60)
    ik4 = next((x for x in (data4.get('list') or []) if x['key'] == 'ikun'), None) or {}
    check('apply 之后缓存里的 installed 已更新', data4.get('cached') is True and ik4.get('state') in ('same',) and '22' in str((ik4.get('installed') or {}).get('version')),
          'cached=%s state=%s 本地=%s' % (data4.get('cached'), ik4.get('state'), (ik4.get('installed') or {}).get('version')))
    check('列表接口带上脚本版本', any((x.get('version') or '') for x in ((d.get('data') or {}).get('list') or [])), '')

    print('\n== 5. 管理后台 UI ==')
    # 让 UI 段有真活干：把 ikun 再降级成 v6，UI 勾选 → 批量入库 会把它升回仓库版本，
    # 这样「导入后不再显示未安装」这条（缓存即时性的用户路径）才真正被执行到。
    st, _ = api('/admin/api/library/user-sources', 'POST',
                {'id': 'ikun', 'name': snap_meta.get('name') or 'ikun音源', 'script': old_script,
                 'enabled': bool(snap_meta.get('enabled'))}, token=token)
    check('UI 前把 ikun 再降级为 v6（给批量入库留活干）', st == 200, 'HTTP %s' % st)
    ui_ok = run_ui(token)
    if not ui_ok:
        skipped += 1

    print('\n== 6. 收尾核对 ==')
    st, d = api('/admin/api/library/user-sources/ikun', token=token)
    final = d.get('data') or {}
    check('结束时 ikun 与快照一致（未污染主人环境）', sha(final.get('script')) == sha(snap_script) and bool(final.get('enabled')) == bool(snap_meta.get('enabled')),
          'enabled=%s bytes=%s' % (final.get('enabled'), final.get('bytes')))

    print('\n===== 汇总：%d 通过 / %d 失败 / %d 跳过 =====' % (passed, failed, skipped))
    return 1 if failed else 0


def run_ui(token):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = b.new_page(viewport={'width': 1440, 'height': 1000})
        page.on('dialog', lambda d: d.accept())
        page.goto(BASE + '/admin/', wait_until='domcontentloaded')
        page.evaluate("t => localStorage.setItem('gusi-admin-token', t)", token)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_timeout(1200)
        page.eval_on_selector('[data-tab="sources"]', 'el => el.click()')
        try:
            page.wait_for_selector('#reg-tbody tr', timeout=90000)
        except Exception as e:
            check('音源页渲染公开源仓库清单', False, repr(e)[:140])
            b.close()
            return False
        page.wait_for_timeout(1500)
        rows = page.eval_on_selector_all('#reg-tbody tr', """els => els.map(tr => ({
          key: tr.dataset.key,
          name: (tr.querySelector('.t-name') || {}).textContent || '',
          cells: [...tr.children].map(td => (td.innerText || '').trim()),
          can: tr.classList.contains('reg-can'),
          checked: !!tr.querySelector('input.reg-ck'),
        }))""")
        check('UI 渲染出音源清单', len(rows) >= 8, 'rows=%d' % len(rows))
        pills = page.eval_on_selector_all('#reg-tbody .reg-pill', 'els => els.map(e => e.textContent.trim())')
        check('状态药丸有「已是最新」', '已是最新' in pills, ','.join(sorted(set(pills)))[:120])
        check('本地版本列有内容', any('9.3' in r['cells'][2] or 'v' in r['cells'][2] for r in rows),
              ' | '.join(r['cells'][2].replace('\n', ' ')[:18] for r in rows[:3]))
        check('未安装/可升级的行可勾选', any(r['checked'] for r in rows) or not any(r['can'] for r in rows),
              'selectable=%d' % sum(1 for r in rows if r['checked']))
        note = page.inner_text('#reg-note')
        check('页脚显示抓取时间与可处理数量', '抓取时间' in note, note[:80])
        # 第三方音源表已带上版本
        us_sub = page.eval_on_selector_all('#us-tbody .t-sub', 'els => els.map(e => e.textContent.trim())')
        check('第三方音源表显示脚本版本', any('v' in (t or '') for t in us_sub), ' | '.join(t[:32] for t in us_sub[:3]))
        page.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shot-admin-registry.png'), full_page=True)

        selectable = [r for r in rows if r['can']]
        if not selectable:
            print('  [info] 当前没有可入库/升级的源（都已是最新），跳过 UI 批量导入')
            b.close()
            return True
        page.eval_on_selector('#reg-all', 'el => { el.checked = true; el.dispatchEvent(new Event("change")) }')
        page.wait_for_timeout(300)
        n_checked = page.eval_on_selector_all('#reg-tbody input.reg-ck:checked', 'els => els.length')
        check('全选勾中可处理的源', n_checked == len(selectable), 'checked=%d 期望=%d' % (n_checked, len(selectable)))
        page.eval_on_selector('#btn-reg-apply', 'el => el.click()')
        try:
            page.wait_for_selector('.toast:not([hidden])', timeout=120000)
            txt = page.inner_text('.toast')
            check('UI 批量导入返回完成提示', '完成' in txt or '入库' in txt, txt[:80])
        except Exception as e:
            check('UI 批量导入返回完成提示', False, repr(e)[:120])
        page.wait_for_timeout(2500)
        pills2 = page.eval_on_selector_all('#reg-tbody .reg-pill', 'els => els.map(e => e.textContent.trim())')
        check('导入后这些源不再显示「未安装」', '未安装' not in pills2, ','.join(sorted(set(pills2)))[:120])
        page.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shot-admin-registry-after.png'), full_page=True)
        b.close()
        return True


if __name__ == '__main__':
    sys.exit(main())
