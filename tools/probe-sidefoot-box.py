#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后台侧栏底部「← 应用 / 退出」方框版：量尺寸、量悬停/按下/聚焦的动画状态，并截图。

用法: python3 tools/probe-sidefoot-box.py [tag]        # 默认 tag=box
产物: tools/sidefoot-<tag>.json、sidefoot-<tag>-normal.png / -hover-app.png / -hover-quit.png / -sidebar.png
"""
import asyncio, json, sys
from playwright.async_api import async_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_ADMIN_PASS = _os_secret.environ.get('GS_ADMIN_PASSWORD', '')
if not _ADMIN_PASS:
    raise SystemExit('缺少环境变量 GS_ADMIN_PASSWORD（仓库不保存口令）')

BASE = "http://127.0.0.1:20059"
PW = _ADMIN_PASS
TAG = sys.argv[1] if len(sys.argv) > 1 else "box"

BOX = """e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
  const pl = parseFloat(c.paddingLeft), pr = parseFloat(c.paddingRight);
  return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1),
           w: +r.width.toFixed(1), h: +r.height.toFixed(1),
           textLeft: +(r.left + pl).toFixed(1), textRight: +(r.right - pr).toFixed(1),
           fontSize: c.fontSize, color: c.color, bg: c.backgroundColor,
           border: c.borderTopWidth + ' ' + c.borderTopColor, radius: c.borderTopLeftRadius,
           transform: c.transform, shadow: c.boxShadow, transition: c.transitionProperty }; }"""

JS = """() => {
  const side = document.querySelector('.sidebar');
  const foot = document.querySelector('.side-foot');
  const who = document.getElementById('who');
  const a1 = document.querySelector('.side-links a');
  const a2 = document.querySelector('.side-links button');
  const box = e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
    const pl = parseFloat(c.paddingLeft), pr = parseFloat(c.paddingRight);
    return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1),
             w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             textLeft: +(r.left + pl).toFixed(1), textRight: +(r.right - pr).toFixed(1),
             fontSize: c.fontSize, color: c.color, bg: c.backgroundColor,
             border: c.borderTopWidth + ' ' + c.borderTopColor, radius: c.borderTopLeftRadius,
             transform: c.transform, shadow: c.boxShadow, transition: c.transitionProperty }; };
  const sb = side.getBoundingClientRect();
  const fb = foot.getBoundingClientRect();
  const wb = who.getBoundingClientRect();
  return {
    sidebarRight: +sb.right.toFixed(1),
    footBorder: +(fb.right - fb.left).toFixed(1),
    footLineSpan: [+fb.left.toFixed(1), +fb.right.toFixed(1)],
    who: { textLeft: +(wb.left + parseFloat(getComputedStyle(who).paddingLeft)).toFixed(1),
           bottom: +wb.bottom.toFixed(1), fontSize: getComputedStyle(who).fontSize,
           color: getComputedStyle(who).color },
    app: box(a1), quit: box(a2),
    gapWhoToBoxes: +(a1.getBoundingClientRect().top - wb.bottom).toFixed(1),
    gapBetweenBoxes: +(a2.getBoundingClientRect().left - a1.getBoundingClientRect().right).toFixed(1),
    overlap: a1.getBoundingClientRect().right > a2.getBoundingClientRect().left,
    overflowFootX: foot.scrollWidth - foot.clientWidth,
    overflowSideX: side.scrollWidth - side.clientWidth,
    hidden: getComputedStyle(who).display,
  };
}"""


async def login(pg):
    await pg.goto(BASE + "/admin/")
    tok = await pg.evaluate(
        """async pw => (await (await fetch('/admin/login', {method:'POST', headers:{'Content-Type':'application/json'},
           body: JSON.stringify({password: pw})})).json()).token""", PW)
    await pg.evaluate("t => localStorage.setItem('gusi-admin-token', t)", tok)
    await pg.reload()
    await pg.wait_for_timeout(900)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        out = {}
        for w, h, dsf in [(1440, 900, 1.333), (1280, 800, 1), (900, 800, 1), (390, 844, 1)]:
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dsf)
            pg = await ctx.new_page()
            await login(pg)
            info = await pg.evaluate(JS)
            info["_interaction"] = {}
            if w >= 1280:  # 交互态只在桌面侧栏有方框可言
                clip = {"x": 8, "y": h - 175, "width": 253, "height": 175}
                try:
                    await pg.locator(".sidebar").screenshot(path=f"tools/sidefoot-{TAG}-sidebar.png")
                except Exception as e:
                    print("  (sidebar 截图跳过: %s)" % type(e).__name__)
                await pg.mouse.move(4, 4)
                await pg.wait_for_timeout(200)
                await pg.screenshot(path=f"tools/sidefoot-{TAG}-normal.png", clip=clip)
                await pg.locator(".side-links a").hover()
                await pg.wait_for_timeout(400)
                info["_interaction"]["hoverApp"] = await pg.evaluate(f"() => {{ const b = ({BOX})(document.querySelector('.side-links a')); return b; }}")
                await pg.screenshot(path=f"tools/sidefoot-{TAG}-hover-app.png", clip=clip)
                await pg.locator(".side-links button").hover()
                await pg.wait_for_timeout(400)
                info["_interaction"]["hoverQuit"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-links button'))")
                await pg.screenshot(path=f"tools/sidefoot-{TAG}-hover-quit.png", clip=clip)
                # 按下态：mouse down 不松手
                r = await pg.locator(".side-links button").bounding_box()
                await pg.mouse.move(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2)
                await pg.mouse.down()
                await pg.wait_for_timeout(300)
                info["_interaction"]["activeQuit"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-links button'))")
                # 松手前先把指针移开方框：否则这次 mouseup 会被当成点击，真的退出登录
                await pg.mouse.move(120, 300)
                await pg.mouse.up()
                await pg.wait_for_timeout(200)
                info["_interaction"]["stillLoggedIn"] = await pg.evaluate("() => document.getElementById('shell').hidden === false")
                # 键盘聚焦（:focus-visible 只认键盘触发，用 Tab 真走到那个链接，别用 .focus()）
                await pg.mouse.move(4, 4)
                await pg.evaluate("() => document.body.focus()")
                hit = None
                for _ in range(15):
                    await pg.keyboard.press("Tab")
                    await pg.wait_for_timeout(60)
                    hit = await pg.evaluate("() => { const a = document.activeElement; return a && a.classList && a.classList.contains('side-links') === false && a.parentElement && a.parentElement.classList.contains('side-links') ? a.tagName + ':' + a.textContent.trim() : (a ? a.tagName : null); }")
                    if hit and hit.startswith(('A:', 'BUTTON:')):
                        break
                info["_interaction"]["tabReached"] = hit
                info["_interaction"]["focusVisible"] = await pg.evaluate(
                    f"() => {{ const e = document.activeElement; return {{ el: e.tagName + ':' + e.textContent.trim(), matches: e.matches(':focus-visible'), "
                    f"box: ({BOX})(e), outline: getComputedStyle(e).outlineStyle }}; }}")
                await pg.screenshot(path=f"tools/sidefoot-{TAG}-focus.png", clip=clip)
            out[f"{w}x{h}@{dsf}"] = info
            print(f"--- {w}x{h} dsf={dsf} ---")
            print(json.dumps(info, ensure_ascii=False))
            await ctx.close()

        # 无障碍：reduce motion 下不应有位移
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        pg = await ctx.new_page()
        await login(pg)
        await pg.locator(".side-links button").hover()
        await pg.wait_for_timeout(300)
        out["reducedMotion"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-links button'))")
        print("--- reduced-motion ---")
        print(json.dumps(out["reducedMotion"], ensure_ascii=False))
        await ctx.close()
        await b.close()
        with open(f"tools/sidefoot-{TAG}.json", "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)


asyncio.run(main())
