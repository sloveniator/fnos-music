#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主音乐应用侧栏底部（#who + 管理后台/退出 两个图标方框）几何与交互态测量。

用法: python3 tools/probe-appfoot.py <tag>
产物: tools/appfoot-<tag>.json、appfoot-<tag>-desk.png / -hover-admin.png / -hover-logout.png /
      -focus.png / -player.png / -drawer390.png
"""
import asyncio, json, sys
from playwright.async_api import async_playwright
# 口令一律从环境变量读取，仓库不保存任何真实口令（2026-09-16 安全清理）
import os as _os_secret
_APP_PASS = _os_secret.environ.get('GS_APP_PASS', '')
if not _APP_PASS:
    raise SystemExit('缺少环境变量 GS_APP_PASS（仓库不保存口令）')

BASE = "http://127.0.0.1:20059"
USER, PWD = "Slceleto", _APP_PASS
TAG = sys.argv[1] if len(sys.argv) > 1 else "v1"

BOX = """e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
  return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
           w: +r.width.toFixed(1), h: +r.height.toFixed(1), radius: c.borderTopLeftRadius,
           border: c.borderTopColor, borderW: c.borderTopWidth, bg: c.backgroundColor, color: c.color,
           transform: c.transform, shadow: c.boxShadow, transition: c.transitionProperty,
           outline: c.outlineStyle, fontSize: c.fontSize }; }"""

JS = """() => {
  const side = document.querySelector('.sidebar'), foot = document.querySelector('.side-foot');
  const who = document.getElementById('who');
  const sLinks = document.querySelector('.side-links');
  const a1 = sLinks.querySelector('a'), a2 = sLinks.querySelector('button');
  const box = %s;
  const sb = side.getBoundingClientRect(), fb = foot.getBoundingClientRect();
  const cs = getComputedStyle(foot), cw = getComputedStyle(who);
  const wb = who.getBoundingClientRect();
  return {
    sidebar: { left: +sb.left.toFixed(1), right: +sb.right.toFixed(1), w: +sb.width.toFixed(1),
               pad: [cs.__p = getComputedStyle(side).paddingLeft, getComputedStyle(side).paddingRight].join('/'),
               padBottom: getComputedStyle(side).paddingBottom },
    foot: { borderBox: [+fb.left.toFixed(1), +fb.right.toFixed(1)], w: +fb.width.toFixed(1),
            pad: [cs.paddingLeft, cs.paddingRight, cs.paddingTop, cs.paddingBottom].join('/'),
            borderTop: cs.borderTopWidth + ' ' + cs.borderTopColor, bg: cs.backgroundImage === 'none' ? 'none' : 'gradient',
            h: +fb.height.toFixed(1) },
    who: { left: +wb.left.toFixed(1), right: +wb.right.toFixed(1), bottom: +wb.bottom.toFixed(1),
           fontSize: cw.fontSize, color: cw.color, ellipsis: cw.textOverflow, overflow: cw.overflow,
           minWidth: cw.minWidth, text: who.textContent, clipped: who.scrollWidth > who.clientWidth + 1 },
    sideLinks: { box: box(sLinks), gap: getComputedStyle(sLinks).gap, shrink: getComputedStyle(sLinks).flexShrink },
    admin: box(a1), logout: box(a2),
    svg: getComputedStyle(a1.querySelector('svg')).width,
    gapBetween: +(a2.getBoundingClientRect().left - a1.getBoundingClientRect().right).toFixed(1),
    gapWhoToLinks: +(sLinks.getBoundingClientRect().left - wb.right).toFixed(1),
    overlapWhoLinks: a1.getBoundingClientRect().left < wb.right,
    footBottomGap: +(getComputedStyle(side).paddingBottom === '0px' ? 0 : 0),
    overflow: { foot: foot.scrollWidth - foot.clientWidth, side: side.scrollWidth - side.clientWidth },
  };
}""" % (BOX)


async def login(page):
    await page.goto(BASE + "/", wait_until="domcontentloaded")
    await page.wait_for_selector("#login", state="visible", timeout=20000)
    await page.fill("#login-name", USER)
    await page.fill("#login-pass", PWD)
    await page.click("#login-btn")
    await page.wait_for_selector("#shell:not([hidden])", timeout=20000)
    await page.wait_for_timeout(900)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        out = {}
        for w, h, dsf in [(1440, 900, 1.333), (1280, 800, 1), (1024, 768, 1), (390, 844, 1)]:
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dsf)
            pg = await ctx.new_page()
            await login(pg)
            if w <= 900:
                await pg.click("#menu-btn")
                await pg.wait_for_timeout(500)
            info = await pg.evaluate(JS)
            info["_states"] = {}

            # 长服务器名压力：图标不该被挤扁（历史上 390px 就把图标挤到 19px）
            info["_states"]["longName"] = await pg.evaluate(
                "() => { const w = document.getElementById('who'); const old = w.textContent;"
                " w.textContent = '这是一台名字特别长的音乐服务器-forge-测试机';"
                " const r = (%s)(document.querySelector('.side-links a'));"
                " const o = { adminW: r.w, clipped: w.scrollWidth > w.clientWidth + 1, footOverflow: document.querySelector('.side-foot').scrollWidth - document.querySelector('.side-foot').clientWidth };"
                " w.textContent = old; return o; }" % BOX)

            clip = {"x": 0, "y": h - 190, "width": 300, "height": 190}
            await pg.mouse.move(4, 4)
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=f"tools/appfoot-{TAG}-desk.png", clip=clip)

            if w >= 1280:
                await pg.locator(".side-links a").hover()
                await pg.wait_for_timeout(400)
                info["_states"]["hoverAdmin"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-links a'))")
                await pg.screenshot(path=f"tools/appfoot-{TAG}-hover-admin.png", clip=clip)
                await pg.locator(".side-foot button").hover()
                await pg.wait_for_timeout(400)
                info["_states"]["hoverLogout"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-foot button'))")
                await pg.screenshot(path=f"tools/appfoot-{TAG}-hover-logout.png", clip=clip)
                # 按下（松手前移开指针，别真的登出/跳转）
                r = await pg.locator(".side-foot button").bounding_box()
                await pg.mouse.move(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2)
                await pg.mouse.down()
                await pg.wait_for_timeout(260)
                info["_states"]["activeLogout"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-foot button'))")
                await pg.mouse.move(600, 400)
                await pg.mouse.up()
                await pg.wait_for_timeout(200)
                info["_states"]["stillLoggedIn"] = await pg.evaluate("() => document.getElementById('shell').hidden === false")
                # 键盘 Tab 走到侧栏底部链接
                await pg.mouse.move(4, 4)
                reached = None
                for _ in range(20):
                    await pg.keyboard.press("Tab")
                    await pg.wait_for_timeout(50)
                    reached = await pg.evaluate(
                        "() => { const a = document.activeElement; return a ? (a.closest('.side-links') ? a.tagName + ':' + (a.title || '') : a.tagName) : null }")
                    if reached and reached.startswith(("A:", "BUTTON:")):
                        break
                info["_states"]["tabReached"] = reached
                info["_states"]["focus"] = await pg.evaluate(
                    f"() => {{ const e = document.activeElement; return {{ el: e.tagName, matches: e.matches(':focus-visible'), box: ({BOX})(e) }}; }}")
                await pg.screenshot(path=f"tools/appfoot-{TAG}-focus.png", clip=clip)

            # 播放器出现时的变体（has-player：侧栏底部让位 + 渐变底）
            info["_states"]["withPlayer"] = await pg.evaluate(
                "() => { document.body.classList.add('has-player');"
                " const f = document.querySelector('.side-foot').getBoundingClientRect();"
                " const s = document.querySelector('.sidebar').getBoundingClientRect();"
                " return { footTop: +f.top.toFixed(1), footBottom: +f.bottom.toFixed(1), sideBottom: +s.bottom.toFixed(1),"
                " gapToSideBottom: +(s.bottom - f.bottom).toFixed(1), sidePadBottom: getComputedStyle(document.querySelector('.sidebar')).paddingBottom,"
                " footBg: getComputedStyle(document.querySelector('.side-foot')).backgroundImage !== 'none' }; }")
            await pg.wait_for_timeout(200)
            await pg.screenshot(path=f"tools/appfoot-{TAG}-player.png", clip=clip)
            await pg.evaluate("() => document.body.classList.remove('has-player')")

            out[f"{w}x{h}@{dsf}"] = info
            print(f"--- {w}x{h} dsf={dsf} ---")
            print(json.dumps(info, ensure_ascii=False))
            await ctx.close()

        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
        pg = await ctx.new_page()
        await login(pg)
        await pg.locator(".side-foot button").hover()
        await pg.wait_for_timeout(250)
        out["reducedMotionHover"] = await pg.evaluate(f"() => ({BOX})(document.querySelector('.side-foot button'))")
        print("--- reduced-motion ---")
        print(json.dumps(out["reducedMotionHover"], ensure_ascii=False))
        await ctx.close()
        await b.close()
        with open(f"tools/appfoot-{TAG}.json", "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)


asyncio.run(main())
