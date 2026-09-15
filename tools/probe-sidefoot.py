#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测量后台侧栏底部（服务器名 / 应用 / 退出）的水平基线与行距，并截取与用户反馈同尺度的区域图。
用法: python3 tools/probe-sidefoot.py <before|after>
"""
import asyncio, json, sys
from playwright.async_api import async_playwright
BASE = "http://127.0.0.1:20059"
PW = "REDACTED"
TAG = sys.argv[1] if len(sys.argv) > 1 else "probe"
JS = """() => {
  const box = e => { const r = e.getBoundingClientRect(); return {x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1), right:+r.right.toFixed(1), bottom:+r.bottom.toFixed(1)}; };
  const sb = document.querySelector('.sidebar'), foot = document.querySelector('.side-foot');
  const who = document.getElementById('who'), links = document.querySelector('.side-links');
  const a1 = links.querySelector('a'), a2 = links.querySelector('button');
  const tabs = [...document.querySelectorAll('.nav .tab')];
  const t = tabs[tabs.length - 1];
  const tb = box(t), cs = getComputedStyle(t);
  // 导航文字左基线（tab 左内边距）
  const navTextLeft = tb.x + parseFloat(cs.paddingLeft);
  const lcs = getComputedStyle(a1);
  const sbcs = getComputedStyle(sb);
  return {
    sidebar: box(sb), foot: box(foot), who: box(who), links: box(links), a1: box(a1), a2: box(a2),
    navTextLeft: +navTextLeft.toFixed(1),
    whoTextLeft: +(box(who).x + parseFloat(getComputedStyle(who).paddingLeft)).toFixed(1),
    a1TextLeft: +(box(a1).x + parseFloat(lcs.paddingLeft)).toFixed(1),
    a2TextLeft: +(box(a2).x + parseFloat(getComputedStyle(a2).paddingLeft)).toFixed(1),
    gapWhoToLinks: +(box(links).y - box(who).bottom).toFixed(1),
    footPadTop: getComputedStyle(foot).paddingTop,
    sidebarPadBottom: sbcs.paddingBottom,
    overflowFoot: foot.scrollWidth - foot.clientWidth,
    overflowSide: sb.scrollWidth - sb.clientWidth,
    linksRightInside: +(sb.getBoundingClientRect().right - parseFloat(sbcs.paddingRight) - box(links).right).toFixed(1),
    whoText: who.textContent, hidden: getComputedStyle(who).display,
  };
}"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        out = {}
        for w, h, dsf, crop in [(1440, 900, 1.333, True), (1280, 800, 1, False), (900, 800, 1, False), (390, 844, 1, False)]:
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=dsf)
            pg = await ctx.new_page()
            await pg.goto(BASE + "/admin/")
            tok = await pg.evaluate("""async (pw) => (await (await fetch('/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw})})).json()).token""", PW)
            await pg.evaluate("t => localStorage.setItem('gusi-admin-token', t)", tok)
            await pg.reload(); await pg.wait_for_timeout(900)
            info = await pg.evaluate(JS)
            out[f"{w}x{h}@{dsf}"] = info
            print(f"--- {w}x{h} dsf={dsf} ---")
            print(json.dumps(info, ensure_ascii=False))
            if crop:
                await pg.locator(".sidebar").screenshot(path=f"tools/sidefoot-{TAG}-sidebar.png")
                await pg.screenshot(path=f"tools/sidefoot-{TAG}-region.png",
                                    clip={"x": 8, "y": h - 155, "width": 253, "height": 155})
            await ctx.close()
        await b.close()
        with open(f"tools/sidefoot-{TAG}.json", "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
asyncio.run(main())
