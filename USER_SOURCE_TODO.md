# USER_SOURCE — 已由 THIRD_PARTY_SOURCES_TODO.md 完整取代（本文件停用）

> 本文件是最早期「切片0 POC」草案；实际交付远超此范围且已全部完成并打包进
> **gusi-music-1.0.0-0013**（桌面 fpk，app.tgz md5 b8d3ea6999be79ef744e4da7a39cd8a3）。
> 最新规划与完成状态见 **THIRD_PARTY_SOURCES_TODO.md**。本文件保留仅为追溯旧决策。

## 背景与拍板语义（仍有效）
- tab-source → 「音源清单」表：预置(曲库/local、在线wy/kw) + 可新增第三方JS源；行内启停/测活/编辑脚本/删除。
- 做法2 = 服务端在 Node 沙箱执行用户确认过的第三方 JS 音源脚本（脚本跑在古四服务端，Web/洛雪都可经它拿 URL）。
- 用户：不需要 S1 逐域白名单那种谨慎（源已确认安全）。保留**资源护栏**（超时/上限/禁eval/防卡死），不做防攻网关。

## 完成状态（0013 已交付）
- 切片0（服务端执行器）：user-source-worker.ts 完整 worker 运行时 + user-source.ts 管理器
- 切片1（registry 动态化）：onlineResolvePlayUrl 与 resolveProxyUrl 先第三方后回退；settings/端点/启停全落地
- 切片2（UI）：音源与代理 tab → 第三方 JS 音源管理卡（清单表+对话框+测活+启停+导入）
- 验证：离线 17/17、HTTP E2E 13/13、真实 Chromium UI 9/9；真实源 live：QDY wy 1.2s 直链、LX 采 6 平台

## 约束（沿用）
- 不改 LX_USER_ 协议命名；不裸奔服务端对不可信脚本；server 逻辑零已有功能回归
- user-api-preload.js 协议是唯一宿主角本（lx-music-mobile/android/.../assets/script/user-api-preload.js）
