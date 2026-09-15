#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证空格键 = 播放/暂停（焦点在按钮上时不再误触发按钮原生 click 导致重头播放）。
场景：播放中 → 焦点移到「上一首」按钮 → 按 Space：
  修复前：按钮原生激活 → prev() → currentTime 清零重头播放（且仍在播放）
  修复后：全局接管 → 暂停且播放位置保持
探针走 UI（new Audio() 不在 DOM）：#np-eq.on=播放中、#t-cur=当前秒、#np-name=当前曲名
"""
import time
from playwright.sync_api import sync_playwright

BASE = "http://localhost:20059"
USER = "Slceleto"
PASS = "REDACTED"
CHROME = "/usr/bin/chromium"

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True,
                                    args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded")
        token = page.evaluate(
            """async ({base, u, pw}) => {
                const r = await fetch(base + '/web/login', {method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({name:u, password:pw})})
                const d = await r.json()
                const tok = (d.data && d.data.token) || d.token
                if (!tok) throw new Error('login fail: ' + JSON.stringify(d))
                return tok
            }""", {"base": BASE, "u": USER, "pw": PASS})
        page.evaluate("(t) => localStorage.setItem('gusi-web-token', t)", token)
        page.reload(wait_until="domcontentloaded")
        page.goto(BASE + "/#/home", wait_until="domcontentloaded")

        def st():
            return page.evaluate("""() => {
                const sec = (s) => { const p = s.split(':'); return (+p[0]) * 60 + (+p[1]) }
                const eq = document.querySelector('#np-eq')
                const n = document.querySelector('#np-name')
                return {
                    playing: !!(eq && eq.classList.contains('on')),
                    cur: sec(document.querySelector('#t-cur').textContent),
                    name: n ? n.textContent : '',
                    focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : ''
                }
            }""")

        page.wait_for_selector("#view .row", timeout=20000)
        page.click("#view .row")
        t0 = time.time()
        while True:
            s = st()
            if s["playing"] and s["cur"] >= 3:
                break
            if time.time() - t0 > 30:
                raise SystemExit("FAIL: 未进入播放状态(需>=3s)，当前 " + str(s))
            time.sleep(0.3)
        print("播放中:", s)

        # 场景1：焦点在「上一首」按钮 → 空格应暂停且不重头
        page.focus("#btn-prev")
        page.keyboard.press("Space")
        time.sleep(0.9)
        s1 = st()
        print("场景1(焦点#btn-prev + Space):", s1)
        if s1["playing"]:
            raise SystemExit("FAIL 场景1: 空格未暂停（可能被按钮 click 吃掉）")
        if s1["cur"] < s["cur"] or s1["cur"] < 3:
            raise SystemExit("FAIL 场景1: 播放位置被重置 → 重头播放, cur=%s" % s1["cur"])
        print("PASS 场景1: 按钮焦点下空格=暂停，位置保持 %ss" % s1["cur"])

        # 场景2：清焦点后再按空格 → 应恢复播放、位置连续
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Space")
        time.sleep(1.2)
        s2 = st()
        print("场景2(无焦点 + Space):", s2)
        if not s2["playing"]:
            raise SystemExit("FAIL 场景2: 第二次空格未恢复播放")
        if s2["cur"] < s1["cur"]:
            raise SystemExit("FAIL 场景2: 恢复后位置回退 cur=%s < %s" % (s2["cur"], s1["cur"]))
        print("PASS 场景2: 空格恢复播放且位置连续")

        # 场景3：焦点在「下一首」按钮 → 空格仍为暂停，不得切歌
        page.focus("#btn-next")
        page.keyboard.press("Space")
        time.sleep(0.9)
        s3 = st()
        print("场景3(焦点#btn-next + Space):", s3)
        if s3["playing"]:
            raise SystemExit("FAIL 场景3: 空格未暂停")
        if s3["name"] != s2["name"]:
            raise SystemExit("FAIL 场景3: 切歌了 %s → %s" % (s2["name"], s3["name"]))
        print("PASS 场景3: 空格在下一首按钮焦点下仍为暂停、未切歌")

        # 场景4：焦点在「播放/暂停」按钮 → 空格=暂停（且不得双触发 toggle）
        page.focus("#btn-play")
        page.keyboard.press("Space")
        time.sleep(1.0)
        s4 = st()
        print("场景4(焦点#btn-play + Space):", s4)
        if not s4["playing"]:
            raise SystemExit("FAIL 场景4: 空格未恢复播放（可能被双触发 toggle 抵消）")
        print("PASS 场景4: 播放按钮焦点下空格有效且无双重触发")

        # 场景5：长按空格（repeat keydown）只切换一次，不得抖动
        n0 = st()
        page.evaluate("""() => {
            for (let i = 0; i < 4; i++) {
                document.body.dispatchEvent(new KeyboardEvent('keydown', {code:'Space', key:' ', bubbles:true, repeat: i > 0}))
            }
        }""")
        time.sleep(0.6)
        s5 = st()
        print("场景5(长按 repeat x4):", n0["playing"], "->", s5["playing"])
        if s5["playing"] == n0["playing"]:
            raise SystemExit("FAIL 场景5: repeat keydown 未生效或被全部吞掉")
        # repeat 事件若未被过滤，会 toggle 4 次 → 回到原状态
        print("PASS 场景5: 长按只切换一次（未抖动）")

        browser.close()
        print("ALL PASS")

if __name__ == "__main__":
    main()
