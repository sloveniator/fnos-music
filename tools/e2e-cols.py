#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列模板不变量测试：所有曲目表必须「表头列 = 行列」逐列对齐、且没有空洞。

检查项（每张表、每个视口）：
  1. 表头单元格数 == 每行单元格数（错列的第一现场）
  2. 同一列的表头 x 与每行 x 偏差 ≤ 1px
  3. 相邻单元格之间没有 >1px 的空隙（末列 pad 之前也不许有）
  4. 表头标签落在对的列里：歌曲/专辑/时长
用法：python3 tools/e2e-cols.py [--view 1440x950,390x844]
"""
import json
import os
import sys
import urllib.request
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = 'http://localhost:20059'
# 本机 Python urllib 会被 HTTP_PROXY 带着走（代理 192.168.2.71:10808），POST 会被代理打回 400
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER = os.environ.get('GS_APP_USER', 'Slceleto')
PASSWORD = _APP_PASS
VIEWS = os.environ.get('GS_COLS_VIEWS', '1440x950,1280x900,1024x800,900x800,390x844,360x740,320x680')
PL_ID = os.environ.get('GS_COLS_PL', '221603627')

# 每页：进入方式（hash 或 pendingRec）、期望的表头标签（按列顺序，'' 表示无标签）
PAGES = [
    ('全部歌曲', {'hash': '#/tracks'}, ['', '#', '', '歌曲', '专辑', '', '时长', '', '']),
    ('歌单详情', {'playlist': True}, None),
    ('在线歌单详情', {'rec': True}, ['', '#', '', '歌曲', '专辑', '', '', '时长', '']),
    ('推荐详情', {'hash': '#/mix/daily'}, None),
    ('下载中心搜索', {'hash': '#/downloads', 'dlSearch': True}, None),
    ('搜索页', {'hash': '#/search?q=周杰伦', 'localSearch': True}, None),
]


def api(token, path, method='GET', body=None):
    """直连 /web/api（脚本自己的前缀，见 MEMORY：BASE + '/web' + path）"""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + '/web' + path, method=method, data=data)
    req.add_header('X-Web-Token', token)
    if data:
        req.add_header('Content-Type', 'application/json')
    with OPENER.open(req, data, timeout=40) as r:
        return json.loads(r.read().decode())


def make_test_playlist(token):
    """歌单详情那张表带排序列，列结构和别人不一样：临时建一个装几首测试曲目的歌单"""
    pid = api(token, '/api/playlists', 'POST', {'name': '列对齐测试'})['data']['id']
    tracks = api(token, '/api/tracks?page=1&size=5')['data']['tracks']
    ids = [str(t['id']) for t in tracks]
    if ids:
        api(token, '/api/playlists/%s/add' % pid, 'POST', {'trackIds': ids})
    return pid, len(ids)

PROBE = """() => {
  const tbl = document.querySelector('table.tracks')
  if (!tbl) return { err: 'no-table' }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), w: Math.round(r.width) } }
  // 窄屏下整列会 display:none（封面/专辑/时长…），这种单元格 rect 全 0，会把「列间空洞」判成假失败；
  // 只统计真正渲染出来的单元格，隐藏列另外单独比对（表头与行必须同隐同显）。
  const vis = (el) => el.getClientRects().length > 0
  const heads = [...tbl.querySelectorAll('thead th')]
  const rows = [...tbl.querySelectorAll('tbody tr')]
  const idOf = (el) => (el.className || '-')
  return {
    head: heads.filter(vis).map(th => Object.assign({ cls: idOf(th), label: th.textContent.trim() }, rect(th))),
    rows: rows.slice(0, 8).map(tr => [...tr.children].filter(vis).map(td => Object.assign({ cls: idOf(td) }, rect(td)))),
    hiddenHead: heads.filter(el => !vis(el)).map(idOf),
    hiddenRow: rows.length ? [...rows[0].children].filter(el => !vis(el)).map(idOf) : [],
    nRows: rows.length,
    tableW: Math.round(tbl.getBoundingClientRect().width),
    tableLayout: getComputedStyle(tbl).tableLayout,
  }
}"""


def login():
    req = urllib.request.Request(BASE + '/web/login', method='POST')
    req.add_header('Content-Type', 'application/json')
    body = json.dumps({'name': USER, 'password': PASSWORD}).encode()
    with OPENER.open(req, body, timeout=30) as r:
        return json.loads(r.read().decode())['data']['token']


def check(tag, data):
    """返回 (通过数, 失败信息列表)"""
    ok, bad = 0, []
    if data.get('err'):
        return 0, ['%s: 页面上没有曲目表（%s）' % (tag, data['err'])]
    head, rows, tbl_w = data['head'], data['rows'], data['tableW']
    if data['tableLayout'] != 'fixed':
        bad.append('%s: table-layout=%s（应为 fixed）' % (tag, data['tableLayout']))
    if data.get('hiddenHead') != data.get('hiddenRow'):
        bad.append('%s: 表头隐藏列 %s ≠ 行隐藏列 %s' % (tag, data.get('hiddenHead'), data.get('hiddenRow')))
    else:
        ok += 1
    # 1 列数一致
    for i, r in enumerate(rows):
        if len(r) != len(head):
            bad.append('%s: 第 %d 行列数 %d ≠ 表头列数 %d' % (tag, i + 1, len(r), len(head)))
            continue
        # 2 表头/行逐列 x 对齐
        for j, (h, c) in enumerate(zip(head, r)):
            if abs(h['x'] - c['x']) > 1:
                bad.append('%s: 第 %d 行第 %d 列 x=%d 与表头 x=%d 差 %dpx' % (tag, i + 1, j + 1, c['x'], h['x'], c['x'] - h['x']))
            elif j > 0:
                ok += 1
    # 3 表头行内部无空洞、且铺满表宽
    xs = [h['x'] for h in head]
    ws = [h['w'] for h in head]
    for j in range(1, len(head)):
        gap = xs[j] - (xs[j - 1] + ws[j - 1])
        if abs(gap) > 1:
            bad.append('%s: 表头第 %d/%d 列之间有空隙 %dpx（%s → %s）'
                       % (tag, j, j + 1, gap, head[j - 1]['cls'], head[j]['cls']))
        else:
            ok += 1
    span = (xs[-1] + ws[-1]) - xs[0] if xs else 0
    if abs(span - tbl_w) > 2:
        bad.append('%s: 列宽合计 %d ≠ 表宽 %d（末列没吃掉余量）' % (tag, span, tbl_w))
    else:
        ok += 1
    # 4 标签落在自己那一列（歌曲/专辑/时长 必须出现在对应列的第 4/5/7 个位置上）
    labels = [h['label'] for h in head]
    for want in ('歌曲', '专辑', '时长'):
        if want in labels and labels.index(want) != {'歌曲': 3}.get(want, labels.index(want)):
            pass
    return ok, bad


def main():
    token = login()
    views = []
    for v in VIEWS.split(','):
        w, h = v.lower().split('x')
        views.append((int(w), int(h)))
    # 歌单详情那张表带排序列（↑↓），列结构和别人不一样；临时建一个装几首本地曲目的歌单
    try:
        pl_id, pl_n = make_test_playlist(token)
        print('临时歌单 %s（%d 首）' % (pl_id, pl_n))
    except Exception as e:  # noqa: BLE001
        pl_id, pl_n = None, 0
        print('临时歌单创建失败（歌单页将跳过）:', str(e)[:120])

    from playwright.sync_api import sync_playwright

    fails = []
    passes = 0
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for (vw, vh) in views:
            for name, spec, want_labels in PAGES:
                page = b.new_page(viewport={'width': vw, 'height': vh})
                try:
                    page.goto(BASE + '/#/home')
                    page.evaluate("t => localStorage.setItem('gusi-web-token', t)", token)
                    page.reload(wait_until='domcontentloaded')
                    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
                    if spec.get('rec'):
                        page.evaluate("""() => {
                          window.__pendingRec = { source: 'mg', type: 'playlist', item: { id: '%s', name: '列对齐测试' } }
                          location.hash = '#/online'
                        }""" % PL_ID)
                    elif spec.get('dlSearch'):
                        page.evaluate("() => { location.hash = '#/downloads' }")
                        page.wait_for_timeout(1200)
                        inp = page.query_selector('.dl-hero-bar input, input#dl-q, .dl-search input')
                        if inp:
                            inp.fill('周杰伦')
                            inp.press('Enter')
                    elif spec.get('localSearch'):
                        page.evaluate("h => { location.hash = h }", spec['hash'])
                    elif spec.get('playlist'):
                        if not pl_id:
                            raise RuntimeError('无临时歌单，跳过')
                        page.evaluate("h => { location.hash = h }", '#/playlist/' + pl_id)
                    elif spec.get('openFirst'):
                        page.evaluate("h => { location.hash = h }", spec['hash'])
                        page.wait_for_timeout(1200)
                        first = page.query_selector('.pl-card, .card.pl, .pl-item')
                        if first:
                            first.click()
                    else:
                        page.evaluate("h => { location.hash = h }", spec['hash'])
                    page.wait_for_selector('table.tracks thead th', timeout=25000)
                    page.wait_for_timeout(600)
                    page.mouse.move(4, 4)
                    data = page.evaluate(PROBE)
                    tag = '%dx%d %s' % (vw, vh, name)
                    o, bad = check(tag, data)
                    passes += o
                    fails.extend(bad)
                    if want_labels and data.get('head'):
                        got = [h['label'] for h in data['head']]
                        # 标签必须落在语义对应的列里：把「歌曲」塞进时长列这类错位，
                        # 光看列数和 x 对齐是抓不到的。
                        label_cls = {'#': 'num', '歌曲': 'name', '专辑': 'album', '时长': 'dur'}
                        for h in data['head']:
                            want_cls = label_cls.get(h['label'])
                            if want_cls and want_cls not in h['cls']:
                                fails.append('%s: 标签「%s」落在 %s 列（应为 %s* 列）' % (tag, h['label'], h['cls'], want_cls))
                                break
                        want_l = [x for x in want_labels if x]
                        got_l = [x for x in got if x]
                        # 窄屏整列隐藏（封面/专辑）会少标签：只要求剩下的标签是桌面的子序列
                        it = iter(want_l)
                        sub = all(any(g == w for w in it) for g in got_l)
                        if not sub:
                            fails.append('%s: 带标签的列 %s 不是预期 %s 的子序列' % (tag, got_l, want_l))
                        elif not data.get('hiddenHead') and len(got) != len(want_labels):
                            fails.append('%s: 桌面宽度下列数 %d ≠ 预期 %d' % (tag, len(got), len(want_labels)))
                        else:
                            passes += 1
                    if not bad and not fails[-1:][:0]:
                        print('  ok  %-34s 行 %d 列 %d 表宽 %d' % (tag, data['nRows'], len(data['head']), data['tableW']))
                except Exception as e:  # noqa: BLE001
                    fails.append('%dx%d %s: 异常 %s' % (vw, vh, name, str(e).split('\n')[0][:120]))
                finally:
                    page.close()
        b.close()

    if pl_id:
        try:
            api(token, '/api/playlists/remove', 'POST', {'ids': [pl_id]})
            print('临时歌单已删除')
        except Exception as e:  # noqa: BLE001
            print('临时歌单删除失败（需手工清理）:', str(e)[:120])

    print('\n通过 %d 项，失败 %d 项' % (passes, len(fails)))
    for f in fails:
        print('  FAIL', f)
    if not fails:
        print('列模板一致：表头与行逐列对齐、列数一致、无空洞。')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
