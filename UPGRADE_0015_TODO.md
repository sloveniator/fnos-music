# UPGRADE_0015 — 多平台探测结论 + 跨源歌词兜底 ✅

## 背景（用户诉求与边界）
用户提出接入汽水/酷狗/QQ/网易/咪咕五平台并「VIP 突破」。**VIP 突破不做**：绕过付费授权获取内容
不因「个人不传播」改变性质，且与项目自 0005 起「仅公开内容试听」的设计红线冲突。
本轮在免费公开内容框架内完成全部平台的可行性探测，探通者接入。

## 平台探测结论（2026-09-08 实测，均非猜测）

| 平台 | 搜索 | 免费试听取链 | 歌词 | 结论 |
|---|---|---|---|---|
| 汽水（抖音） | ❌ | ❌ | ❌ | **排除**：music.douyin.com 匿名 = 「汽水音乐合作平台」（音乐人后台，Playwright 实测）；C 端需抖音登录态+字节签名（X-Bogus/msToken），无免费通道 |
| 酷狗 | ✅ `songsearch.kugou.com/song_search_v2` 免签可用（晴天 480 条） | ❌ m.kugou playInfo 回空 url、wwwapi err_code 30020、tracker「Empty key」；infSign.min.js 仅签歌单接口且依赖浏览器指纹，Node 不可用 | ✅ lyrics.kugou.com search+download（KG-RC 通道）实测 LRC 到手 | **不接入播放源**（不能播）；歌词通道转为兜底源 |
| QQ 音乐 | ✅ `musicu.fcg` DoSearchForQQMusicDesktop 可用（注意 comm 需 `ct:19,cv:1845` 旧结构+完整浏览器头，否则风控回 0） | ❌ GetVkeyServerBase/unifiedPlay 均 code 500003、fcg_music_express_mobile3 104003——vkey 体系全部收口 | ✅ `music.musichallSong.PlayLyricInfo` 免登录返回 base64 LRC 实测到手 | **不接入播放源**；歌词通道转为兜底源 |
| 网易/咪咕 | 已接入（0014） | ✅ | ✅ | 保持 |

> 三平台取链均收口到登录态/签名体系——与 lx-music-desktop 官方把 kg/tx 的 URL 通道外置成 userApi 脚本的现象互为印证。
> 用户如需这些平台的播放能力，仍走既有「第三方 JS 音源（服务端承载）」功能导入社区脚本（0013 已交付）。

## 本轮改动
- [x] **跨源歌词兜底** `server/src/online/lyric-fallback.ts`：
  - 链路：NAS 内嵌/.lrc（extractLyric）→ 酷狗免费歌词通道（kgLyricByText）→ QQ 免费歌词通道（txLyricByText）
  - 酷狗：lyrics.kugou.com search（keyword+hash+duration）→ download（base64 lrc, decode=1）
  - QQ：musicu 搜索拿 songMID（歌手名优先匹配）→ PlayLyricInfo base64 LRC；`TX_SEARCH_COMM={ct:'19',cv:'1845',uin:'0'}` + 完整浏览器头（否则风控回 0 条，本轮实测踩坑）
  - 全部未命中回空，前端展示原「暂无歌词」空态；`provider` 字段标识来源（nas/kg/tx）
- [x] `/web/media/lyric/<id>` 接入兜底链（响应新增 `provider`）
- [x] 端到端实测：无歌词曲目「逆光」→ provider=tx 拿到完整 LRC；带内嵌歌词曲目 NAS 优先链正常
- [x] 回归：smoke ALL PASSED；user-source-smoke 17/17；e2e-user-sources 13/13；verify-download ALL PASSED；ui-us-check 9/9；tsc 零错
- [x] **打包**：`gusi-music-1.0.0-0015-fnos-cn-x86_64.fpk`（45.8MB / 27 entries / app.tgz md5 `9a80be56a92f2fa53b906839953e32db`）已拷 `deliverable\`；包内核对 lyric-fallback.js 在位
- [ ] fnOS 真机装包 + 手机实测（用户动作）

## 遗留
- 酷狗歌词兜底在无 hash 时 candidates 常为空（按 keyword 匹配命中率低），当前实测兜底命中以 QQ 通道为主；酷狗通道保留作冗余
- QQ 搜索接口对短时间高频调用有风控（回 0 条），兜底链每次播放歌词缺失才触发一二次请求，正常使用强度下无感知
