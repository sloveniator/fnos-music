#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FM 电台 E2E（真实 Chromium + 线上实例 localhost:20059）

用法：
    python3 tools/e2e-fm.py

覆盖：
  A. HTTP 接口层：/web/api/fm/modes 频道目录、/web/api/fm/next 取曲与 exclude 去重、参数校验
  B. 页面层：#/fm 频道墙渲染（汽水听歌模式实时拉取）、开台、底栏标出 FM 频道
  C. 续播：队列见底自动取下一批（真实 next() 路径），不重复且只增不减
  D. 倍速：沉浸 0.8x 频道 audio.playbackRate=0.8；退出电台态复位 1x
  E. 退出电台态：播放本地曲目 → fm 置空、频道卡标记清除、倍速复位
  F. 断点持久化：刷新后 FM 频道与队列恢复，并按设置自动续播
  G. 无手势兜底：autoplay 被浏览器拦截时出现「继续收听」浮条

注：站点 CSP 为 script-src 'self'，不能用字符串形式的 wait_for_function
    （会被页内 eval 触发 CSP 拦截），统一走 page.evaluate 轮询（CDP 不受 CSP 限制）。
"""
import json
import os
import subprocess
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:20059'
USER, PASSWORD = 'Slceleto', 'REDACTED'
SHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))

PASS = FAIL = SKIP = 0


def skip(name, why):
    global SKIP
    SKIP += 1
    print('  [SKIP] %s  -- %s' % (name, why))


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        print('  [PASS] %s%s' % (name, ('  -- ' + detail) if detail else ''))
    else:
        FAIL += 1
        print('  [FAIL] %s%s' % (name, ('  -- ' + detail) if detail else ''))


def wait_for(page, expr, timeout=30000, every=400):
    """轮询 page.evaluate（CDP 不受 CSP 限制）；返回是否在超时前为真"""
    waited = 0
    while waited < timeout:
        try:
            if page.evaluate(expr):
                return True
        except Exception:
            pass
        page.wait_for_timeout(every)
        waited += every
    return False


# ---------------------------------------------------------------- HTTP 层

def curl_json(url, method='GET', body=None, headers=None):
    cmd = ['curl', '-s', '--noproxy', '*', '--max-time', '90', '-X', method, url]
    for k, v in (headers or {}).items():
        cmd += ['-H', '%s: %s' % (k, v)]
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        j = json.loads(out)
    except Exception:
        return {'_raw': out[:300]}
    # 成功响应统一包一层 {code:0,data:...}，拆开便于断言（错误响应原样返回）
    return j.get('data', j) if isinstance(j, dict) else j


def api_layer():
    print('\n== A. HTTP 接口层 ==')
    login = curl_json(BASE + '/web/login', 'POST', {'name': USER, 'password': PASSWORD})
    tok = (login or {}).get('token')
    check('POST /web/login 取得令牌', bool(tok), 'token=%s…' % str(tok)[:8])
    if not tok:
        return
    h = {'X-Web-Token': tok}

    d = curl_json(BASE + '/web/api/fm/modes', headers=h)
    chans = (d or {}).get('list') or []
    check('GET /web/api/fm/modes 返回频道目录', len(chans) >= 40, '%d 个频道' % len(chans))
    names = [c.get('name', '') for c in chans]
    keys = [c.get('key', '') for c in chans]
    check('含「深夜 EMO」模式', any('深夜' in n for n in names), ','.join([n for n in names if '深夜' in n]))
    check('含「沉浸 0.8x」模式', any('0.8' in n for n in names), ','.join([n for n in names if '0.8' in n]))
    slow = next((c for c in chans if '0.8' in (c.get('name') or '')), None)
    check('0.8x 频道带 playbackRate=0.8', bool(slow) and slow.get('playbackRate') == 0.8,
          str(slow and slow.get('playbackRate')))
    check('每个频道都有名称（可渲染）', all(c.get('name') for c in chans))
    check('频道 key 均为上游 sub_queue_type 形态',
          all(k.startswith('scene_mode_') for k in keys), keys[0] if keys else '')

    emo = next((k for k in keys if 'emo' in k), keys[0] if keys else 'scene_mode_emo')
    r1 = curl_json(BASE + '/web/api/fm/next?key=%s&limit=20' % emo, headers=h)
    l1 = (r1 or {}).get('list') or []
    check('GET /web/api/fm/next 取到曲目', len(l1) == 20, '%d 首 / 池 %s' % (len(l1), (r1 or {}).get('poolSize')))
    check('曲目带 source/id 字段', all(x.get('source') and x.get('id') for x in l1),
          str(l1[0].get('source') if l1 else ''))
    check('曲目均为汽水源且只留免费全曲（服务端过滤）',
          all(x.get('source') == 'soda' for x in l1))
    ids1 = [str(x.get('id')) for x in l1]
    r2 = curl_json(BASE + '/web/api/fm/next?key=%s&limit=20&exclude=%s' % (emo, ','.join(ids1)), headers=h)
    ids2 = [str(x.get('id')) for x in ((r2 or {}).get('list') or [])]
    check('exclude 去重生效（两批零交集）', not (set(ids1) & set(ids2)), '重复 %d 首' % len(set(ids1) & set(ids2)))
    check('第二批仍取满 20 首', len(ids2) == 20, '%d 首' % len(ids2))

    bad = curl_json(BASE + '/web/api/fm/next?key=../../etc/passwd&limit=20', headers=h)
    check('非法 key 被拒（安全边界）', bad.get('code') not in (None, 0) or bad.get('msg'),
          json.dumps(bad, ensure_ascii=False)[:90])


# ---------------------------------------------------------------- 页面层

def login(page):
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_selector('#login', state='visible', timeout=20000)
    page.fill('#login-name', USER)
    page.fill('#login-pass', PASSWORD)
    page.click('#login-btn')
    page.wait_for_selector('#shell:not([hidden])', timeout=20000)
    page.wait_for_timeout(800)


def ui_layer(pw):
    print('\n== B. 频道墙与开台 ==')
    errs = []
    b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                           args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
    login(page)
    page.evaluate("localStorage.setItem('gusi-fm-auto','0'); localStorage.removeItem('gusi-fm-key')")

    check('侧栏/抽屉含 FM 电台入口', page.locator('[data-nav="fm"]').count() >= 1)
    page.evaluate("location.hash = '#/fm'")
    ok = wait_for(page, "!!document.querySelector('.fm-card')", timeout=45000)
    check('#/fm 渲染频道墙', ok)
    cards = page.locator('.fm-card')
    n = cards.count()
    check('频道数量与接口一致', n >= 40, '%d 个频道卡' % n)
    check('频道卡有名称与说明', page.locator('.fm-card .fm-nm').count() == n)
    # 主人 2026-09-15 决定：频道卡转纯文字。上游 pic 是 300×300 近纯白图（最暗 253/255），
    # 深色卡片上只是块白方块，所以头像整体去掉；这条断言防止以后有人又把它加回来。
    check('频道卡为纯文字（不含头像）',
          page.locator('.fm-card .fm-ic, .fm-card img').count() == 0,
          '头像节点 %d 个' % page.locator('.fm-card .fm-ic, .fm-card img').count())
    check('沉浸 0.8x 频道带「慢放」标签', page.locator('.fm-card .fm-tag').count() >= 1,
          '%d 个标签' % page.locator('.fm-card .fm-tag').count())
    page.screenshot(path=os.path.join(SHOT_DIR, 'fm-channels.png'))

    # 开台：点「深夜 EMO」
    page.locator('.fm-card', has_text='深夜').first.click()
    ok = wait_for(page, "window.__player && window.__player.fm && window.__player.queue.length >= 15", timeout=60000)
    check('点频道后开台（进入 FM 态且队列就绪）', ok)
    st = page.evaluate("""() => { const p = window.__player
      return { key: p.fm && p.fm.key, name: p.fm && p.fm.name, rate: p.fm && p.fm.rate,
               qlen: p.queue.length, pool: p.fm && p.fm.poolSize, mode: p.mode,
               cur: p.cur && p.cur.kind, singer: document.querySelector('#np-singer').textContent,
               playing: !p.audio.paused, badge: document.querySelectorAll('.fm-card.on .fm-playing').length } }""")
    check('队列均为在线曲目', st['cur'] == 'online' and page.evaluate("window.__player.queue.every(t => t.kind === 'online')"),
          json.dumps({k: st[k] for k in ('key', 'qlen', 'pool')}, ensure_ascii=False))
    check('底栏标出 FM 频道名', 'FM' in st['singer'] and st['name'][:2] in st['singer'], st['singer'])
    check('默认顺序播放（电台语义）', st['mode'] == 'order', st['mode'])
    check('开台即播放', st['playing'])
    check('频道卡标记「播放中」', st['badge'] == 1, '%d 个标记' % st['badge'])
    page.screenshot(path=os.path.join(SHOT_DIR, 'fm-playing.png'))

    print('\n== C. 队列见底自动续播 ==')
    before = page.evaluate("() => { const p = window.__player; p.fm.playedCount = p.queue.length - 1; return p.queue.length }")
    ids_before = page.evaluate("window.__player.queue.map(t => String(t.rid))")
    page.evaluate("window.__player.next(true)")
    grew = wait_for(page, "window.__player.queue.length > %d" % before, timeout=90000)
    after = page.evaluate("window.__player.queue.length")
    check('自动续播：队列增长', grew and after > before, '%d → %d 首' % (before, after))
    ids_after = page.evaluate("window.__player.queue.map(t => String(t.rid))")
    added = ids_after[len(ids_before):]
    dup = set(added) & set(ids_before)
    check('续播曲目与已播零重复', len(dup) == 0, '新增 %d 首，重复 %d 首' % (len(added), len(dup)))
    check('续播后仍在播放', page.evaluate("!window.__player.audio.paused"))

    print('\n== D. 沉浸 0.8x 倍速 ==')
    page.evaluate("window.__player.stopAll()")
    page.evaluate("location.hash = '#/tracks'")
    page.wait_for_timeout(700)
    page.evaluate("location.hash = '#/fm'")
    wait_for(page, "!!document.querySelector('.fm-card')", timeout=30000)
    page.locator('.fm-card', has_text='0.8').first.click()
    ok = wait_for(page, "window.__player.fm && window.__player.fm.rate === 0.8 && window.__player.queue.length >= 10", timeout=60000)
    check('0.8x 频道开台', ok, page.evaluate("window.__player.fm && window.__player.fm.name"))
    page.wait_for_timeout(1800)
    rate = page.evaluate("window.__player.audio.playbackRate")
    check('播放速率 = 0.8', abs(rate - 0.8) < 0.001, 'playbackRate=%s' % rate)
    singer = page.evaluate("document.querySelector('#np-singer').textContent")
    check('底栏显示频道与 0.8× 标记', '0.8' in singer and 'FM' in singer, singer)

    print('\n== E. 退出电台态（播放非 FM 曲目）==')
    page.evaluate("location.hash = '#/tracks'")
    page.wait_for_timeout(1500)
    if page.locator('.tracks tr.row').count():
        page.locator('.tracks tr.row').first.click()
        via = '本地曲库'
        local_ok = True
    else:
        # 曲库为空是主人有意清库后的常态，不能让整条用例挂掉：
        # 用在线搜索结果行替代「非 FM 曲目」，断言的是同一件事（退出 FM 态、倍速复位）
        skip('播放本地曲目退出 FM 态', '本地曲库为空（0 首），改用在线曲目验证同一条语义')
        local_ok = False
        page.evaluate("location.hash = '#/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6'")
        page.wait_for_selector('.sr-tbl tbody tr', timeout=45000)
        page.evaluate("() => document.querySelector('.sr-tbl tbody tr .iconbtn').click()")
        via = '在线搜索结果'
    page.wait_for_timeout(2200)
    # 注意：曲目判别统一用 kind === 'online'（见 asOnlineRows / start() / renderNp），
    # 本地曲库条目天生没有 kind 字段，断言必须用「非 online」，不能写 == 'local'。
    st2 = page.evaluate("""() => { const p = window.__player
      return { fm: p.fm, rate: p.audio.playbackRate, kind: p.cur && p.cur.kind,
               curId: p.cur && p.cur.id, playing: !p.audio.paused,
               bar: document.querySelectorAll('#fm-unlock.show').length } }""")
    check('播放%s曲目后退出 FM 态' % ('本地' if local_ok else '非 FM'), 
          st2['fm'] is None and bool(st2['curId']) and st2['playing']
          and (st2['kind'] != 'online' if local_ok else st2['kind'] == 'online'),
          json.dumps(st2, ensure_ascii=False) + ' via=' + via)
    check('退出电台后浮条不再显示', st2['bar'] == 0, '%d 个' % st2['bar'])
    check('倍速复位为 1x', abs(st2['rate'] - 1) < 0.001, 'playbackRate=%s' % st2['rate'])
    page.evaluate("location.hash = '#/fm'")
    wait_for(page, "!!document.querySelector('.fm-card')", timeout=30000)
    check('频道卡「播放中」标记已清除', page.locator('.fm-card.on').count() == 0)

    print('\n== F. 断点持久化 + 自动开台 ==')
    page.evaluate("localStorage.setItem('gusi-fm-auto','1')")
    page.locator('.fm-card', has_text='深夜').first.click()
    ok = wait_for(page, "window.__player.fm && window.__player.queue.length >= 15", timeout=60000)
    check('再次开台（用于持久化用例）', ok)
    key_before = page.evaluate("window.__player.fm.key")
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('#shell:not([hidden])', timeout=25000)
    ok = wait_for(page, "window.__player && window.__player.fm && window.__player.queue.length >= 10", timeout=40000)
    check('刷新后恢复 FM 频道态与队列', ok)
    st3 = page.evaluate("""() => { const p = window.__player
      return { key: p.fm && p.fm.key, name: p.fm && p.fm.name, qlen: p.queue.length,
               paused: p.audio.paused, saved: JSON.parse(localStorage.getItem('gusi-q') || '{}').fm } }""")
    check('恢复的频道与刷新前一致', st3['key'] == key_before, '%s → %s' % (key_before, st3['key']))
    check('localStorage 持久化频道信息（含倍速）', bool(st3['saved']) and st3['saved'].get('key') == key_before,
          json.dumps(st3['saved'], ensure_ascii=False))
    ok = wait_for(page, "window.__player && !window.__player.audio.paused", timeout=20000)
    check('打开即自动续播（未点击即出声）', ok, 'paused=%s' % st3['paused'])

    check('页面无 JS 报错', len(errs) == 0, ' | '.join(errs[:3]))
    ctx.close()
    b.close()


def blocked_layer(pw):
    """G 层坑点（务必保留注释）：CDP 的 Runtime.evaluate —— 也就是 page.evaluate ——
    会给当前文档授予 user activation（实测 ua {active:False} → {active:True}）。
    reload 会清空该状态，但只要在应用 play() 之前跑过一次 evaluate，autoplay 拦截就
    不会发生，本层会假绿。因此「是否弹浮条」全部由页内旁观者记录，测试只在事后读一次。
    """
    print('\n== G. 无手势自动播放被拦截时的兜底 ==')
    b = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                           args=['--autoplay-policy=document-user-activation-required'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    # add_init_script 不掉用 evaluate：页内自建旁观者（不授予激活）+ 记录 play() 成败
    page.add_init_script("""
      window.__fmBar = { seen: false, text: '', playErr: [] };
      const _play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        const r = _play.apply(this, arguments);
        if (r && r.catch) r.catch((e) => { window.__fmBar.playErr.push((e && e.name) || 'err'); });
        return r;
      };
      setInterval(() => {
        const b = document.getElementById('fm-unlock');
        if (b && b.classList.contains('show')) { window.__fmBar.seen = true; window.__fmBar.text = b.textContent; }
      }, 150);
    """)
    login(page)
    page.evaluate("""
      localStorage.setItem('gusi-fm-auto','1')
      localStorage.setItem('gusi-fm-key','scene_mode_emo')
      localStorage.setItem('gusi-fm-name','深夜 EMO')
      localStorage.removeItem('gusi-q')
    """)
    # 刷新 → 新文档、无用户手势（sticky activation 实测被 reload 清空）→ play() 应被拒绝
    page.reload(wait_until='domcontentloaded')
    # 关键：这段时间内不做任何 evaluate/wait_for，把「无手势」保持到应用 play() 之后
    page.wait_for_timeout(15000)
    st = page.evaluate('window.__fmBar')
    check('无手势刷新后 play() 被浏览器拒绝', any('NotAllowedError' in e for e in st['playErr']),
          'play() 结果 %s' % (st['playErr'] or '无调用'))
    check('被拦截时出现「继续收听」浮条', st['seen'], st['text'])
    if st['seen']:
        check('浮条文案含频道名', 'FM' in st['text'], st['text'])
        page.screenshot(path=os.path.join(SHOT_DIR, 'fm-blocked.png'))
        page.click('#fm-unlock')
        ok = wait_for(page, "window.__player && !window.__player.audio.paused", timeout=25000)
        check('点击浮条后开始播放', ok)
        check('浮条已隐藏', page.locator('#fm-unlock.show').count() == 0)
    ctx.close()
    b.close()


def main():
    api_layer()
    with sync_playwright() as pw:
        ui_layer(pw)
        blocked_layer(pw)
    print('\n===== 结果 =====')
    print('通过 %d 项，失败 %d 项（跳过 %d）' % (PASS, FAIL, SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
