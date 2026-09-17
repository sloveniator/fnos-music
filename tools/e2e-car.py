#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""车机（C5）桥接的端到端验证 —— 真实 Chromium，注入的就是壳里那份脚本。

注入源不是本脚本另抄的一份，而是**直接从 android/.../BridgeScript.kt 里抠出来的字符串**，
所以这里挂了就等于壳里那份脚本挂了（改脚本忘了改文档也不会两边漂开）。

验证四件事：
  ① 登录令牌推给原生（车机靠它取曲库）：注入即推一次；值变了 2 秒内再推一次；登出推空串；
     同一个值不重复推。壳侧对应 WebSession/JsBridge.setToken。
  ② 车机点播指令 `__gusiCmd('playlist', {i, list})`：队列＝后端原样返回的那批（壳不改造对象），
     起点＝i；i 越界夹到范围内而不是不响应；空列表不假装在播。
  ③ 点播之后原生会收到一份播放状态（通知栏/车机据此显示在放什么）。
  ④ 全程无 JS 报错。
"""
import json, os, random, re, shutil, string, sys, time, urllib.request, urllib.error

# 口令一律从环境变量读取，仓库不保存任何真实口令
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = 'http://localhost:20059'
ROOT = '/app/working/workspaces/fnos-music/project/fnos-music'
DATA = os.path.join(ROOT, 'server', 'data')
FIX = '/tmp/gusi-test-music/周杰伦/范特西'
BRIDGE_KT = os.path.join(ROOT, 'android/app/src/main/java/com/gusi/music/BridgeScript.kt')
RND = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
USER, PW = 'scar' + RND, 'Car' + RND + '!9'
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


def get(path, t=None):
    r = urllib.request.Request(BASE + '/web' + path)
    if t: r.add_header('X-Web-Token', t)
    with op.open(r, timeout=60) as x:
        return json.loads(x.read().decode())


def bridge_js():
    """从 Kotlin 源里抠出注入脚本（Kotlin 里 `$` 要写成 ${'$'}，这里还原）。"""
    src = open(BRIDGE_KT, encoding='utf-8').read()
    m = re.search(r'val JS: String = """(.*?)""".trimIndent\(\)', src, re.S)
    if not m:
        raise SystemExit('没能从 %s 里找到 val JS: String 的三引号字面量' % BRIDGE_KT)
    js = m.group(1) if m.group(1).strip().startswith('(function') else m.group(1).lstrip('\n')
    js = js.replace("${'$'}", '$')
    if '__gusiCmd' not in js:
        raise SystemExit('抠出来的脚本里没有 __gusiCmd，抠错了')
    return js


# ---- 测试账号 + 3 首夹具曲目（与车机曲库测试用的同一批）----
tok = post('/register', {'name': USER, 'email': USER + '@e.com', 'password': PW, 'confirm': PW})['data']['token']
dd = os.path.join(DATA, 'library', USER)
os.makedirs(dd, exist_ok=True)
for fn in ['00 长轨静音.wav', '01 可爱女人.mp3', '02 完美主义.mp3']:
    shutil.copy(os.path.join(FIX, fn), os.path.join(dd, fn))
for _ in range(40):
    if get('/api/stats', tok)['data'].get('tracks', 0) >= 3: break
    time.sleep(1)

# 壳交给播放器的那份队列：就是 /web/api/tracks 原样返回的对象
# （get() 自己会补 /web 前缀，所以这里写 /api/tracks）
tracks = get('/api/tracks?size=200', tok)['data']['tracks']
print('临时用户 %s，曲目 %d 首：%s' % (USER, len(tracks), [t['name'] for t in tracks]))
names = [t['name'] for t in tracks]

STUB = """() => {
  window.__gusiCalls = { state: [], token: [] };
  window.GusiBridge = {
    setState: function (json) { window.__gusiCalls.state.push(json); },
    setToken: function (t) { window.__gusiCalls.token.push(t); },
    localFor: function (url) { return null; }   // 离线本地文件：这条线由 C1 自己验证
  };
}"""

# 在同一次 evaluate 里发指令并立刻读回结果：不靠 sleep 等界面反应，
# 也就不受「夹具音频太短、放完自动跳下一首」的干扰
CMD = """(arg) => {
  const before = window.__gusiCalls.state.length;
  window.__gusiCmd('playlist', arg);
  return {
    index: window.__player.index,
    count: window.__player.queue.length,
    ids: window.__player.queue.map(t => t.id),
    name: document.querySelector('#np-name').textContent,
    before: before
  };
}"""

try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/chromium',
                              args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 900, 'height': 800})
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/')
        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)
        pg.reload()
        pg.wait_for_selector('#shell:not([hidden])', timeout=20000)

        # ============ A 令牌推送 ============
        print('\n== A 登录令牌推给原生 ==')
        pg.evaluate(STUB)
        pg.evaluate(bridge_js())
        calls = pg.evaluate("() => window.__gusiCalls.token")
        check('A 注入即推一次当前令牌', calls == [tok], '收到 %d 次' % len(calls))

        pg.wait_for_timeout(2400)          # 轮询 2s 一次
        calls = pg.evaluate("() => window.__gusiCalls.token")
        check('A 值没变就不重复推', calls == [tok], '收到 %d 次' % len(calls))

        pg.evaluate("() => localStorage.setItem('gusi-web-token', 'TOKEN-2')")
        pg.wait_for_timeout(2400)
        calls = pg.evaluate("() => window.__gusiCalls.token")
        check('A 值变了会在下个轮询推出去', calls == [tok, 'TOKEN-2'], calls)

        # 登出：Web 端会清掉 localStorage，这里必须推空串（壳侧才知道该说「请先登录」）
        pg.evaluate("() => localStorage.removeItem('gusi-web-token')")
        pg.wait_for_timeout(2400)
        calls = pg.evaluate("() => window.__gusiCalls.token")
        check('A 登出（清空）推空串', calls[-1] == '' and len(calls) == 3, calls)

        pg.evaluate("t => localStorage.setItem('gusi-web-token', t)", tok)   # 复原，别影响后续取流
        pg.wait_for_timeout(2400)

        # ============ B 点播指令 ============
        print('\n== B 车机点播 __gusiCmd(\'playlist\', {i, list}) ==')
        before_state = pg.evaluate("() => window.__gusiCalls.state.length")
        check('B 还没放东西时不乱推状态（否则通知栏会挂一个标题是「—」的空壳）',
              before_state == 0, '状态推送 %d 次' % before_state)

        r = pg.evaluate(CMD, {'i': 1, 'list': tracks})
        check('B 队列＝后端原样返回的那批（壳不改造对象）',
              r['count'] == len(tracks) and r['ids'] == [t['id'] for t in tracks],
              '%d 首 %s' % (r['count'], r['ids']))
        check('B 起点＝i', r['index'] == 1 and r['name'] == names[1],
              'index=%d name=%s（应 %s）' % (r['index'], r['name'], names[1]))
        pg.wait_for_timeout(800)
        pushed = pg.evaluate("() => window.__gusiCalls.state")[before_state:]
        check('B 点播后原生收到播放状态', len(pushed) > 0, '收到 %d 次' % len(pushed))
        if pushed:
            d = json.loads(pushed[0])
            check('B 状态里就是在放的那首', d.get('title') == names[1],
                  'title=%s（应 %s）' % (d.get('title'), names[1]))

        r = pg.evaluate(CMD, {'i': 99, 'list': tracks})
        check('B i 越界（99）夹到最后一首，而不是不响应',
              r['index'] == len(tracks) - 1 and r['name'] == names[-1],
              'index=%d name=%s' % (r['index'], r['name']))

        r = pg.evaluate(CMD, {'i': -5, 'list': tracks})
        check('B i 为负夹到第一首', r['index'] == 0 and r['name'] == names[0],
              'index=%d name=%s' % (r['index'], r['name']))

        r = pg.evaluate(CMD, {'i': 0, 'list': []})
        check('B 空队列不假装在播（保持原状、不报错）',
              r['count'] == len(tracks) and r['index'] == 0,
              'index=%d count=%d' % (r['index'], r['count']))

        # ============ C 回归：原有指令没被碰坏 ============
        print('\n== C 原有指令回归 ==')
        pg.evaluate("() => window.__gusiCmd('pause')")
        pg.wait_for_timeout(300)
        check('C pause 仍能暂停', pg.evaluate("() => window.__player.audio.paused") is True)
        pg.evaluate("() => window.__gusiCmd('play')")
        pg.wait_for_timeout(300)
        check('C play 仍能继续', pg.evaluate("() => window.__player.audio.paused") is False)

        print('\n== D JS 报错 ==')
        check('D 全程无 JS 报错', not errs, errs[:3])

        ctx.close()
        b.close()
    print('\n== %d passed, %d failed ==' % (P, F))
    sys.exit(1 if F else 0)
finally:
    shutil.rmtree(os.path.join(DATA, 'library', USER), ignore_errors=True)
    shutil.rmtree(os.path.join(DATA, 'libraries', USER), ignore_errors=True)
    try:
        r = urllib.request.Request(BASE + '/admin/login', method='POST')
        r.add_header('Content-Type', 'application/json')
        with op.open(r, json.dumps({'password': _ADMIN_PASS}).encode(), timeout=30) as x:
            at = json.loads(x.read().decode())['token']
        r = urllib.request.Request(BASE + '/admin/api/users/' + USER + '?purge=1', method='DELETE')
        r.add_header('X-Admin-Token', at)
        with op.open(r, timeout=30) as x:
            print('临时账号已清理:', x.status)
    except urllib.error.HTTPError as e:
        print('清理失败:', e.code)
