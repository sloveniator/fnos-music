# ONLINE_SOURCE — 古四 Web 在线源（内置搜索，方案 B）

- [x] P0 探平台：网易/酷我/咪咕/酷狗/QQ 五家实测 → 仅酷我 r.s 老接口免签名可用（咪咕/酷狗需签名或已改版、网易需加密参数），MVP 平台集 = 酷我
- [x] 服务端 online 模块：server/src/online/kw.ts（objStr2JSON 抄官方）+ registry index.ts
- [x] REST：/web/api/online/sources + /search（参数/来源白名单/大小页）
- [x] 代理流：/web/media/online/{source}/{rid}?k=（resolve anti URL → pipeHttpStream Range 透传 206）+ /web/api/online/url 查询
- [x] Web 播放器在线曲目类型（kind=online → 走 NAS 中转流；跳过 played/收藏；歌词空态；封面直链/兜底 icon）
- [x] Web「在线音乐」页（#/online 导航 + chips + 结果表 + 加载更多，浏览器实测 20 行渲染/点击播放/无报错）
- [x] 后台「音源与代理」页新增「Web 在线搜索源」说明卡（浏览器实测显示）
- [x] smoke 61/61 回归通过；浏览器 E2E：sources/search(晴天MUSIC_228908)/url/media 206 Range 全通
- [x] build server + fpk 0008 打包交付桌面（57.0MB checksum 991f7b48…）
- [x] 在线结果行级「下一首播放」按钮（player.insertNext，不打断当前播放即插队列）
- [x] 播放队列在线曲目「在线」标识（.q-badge 渐变小徽章）
- [x] 在线源开关 settings 化：LibrarySettings.onlineSources（默认 ['kw']）、admin settings patch 白名单、后台「音源与代理」页勾选+保存；关闭后播放器在线页显示停用提示（非报错）；进入在线页刷新 sources
- [x] build server + fpk 0009 打包交付桌面（57.0MB checksum dec662ae1e7714af3f9b1d10af2d9044）
- [x] **逆向 lx-music-desktop v2.12.2 musicSdk**：官方 desktop/mobile 的 URL 通道已外置 userApi（api-test/temp 全注释），确认官方代码库无内置 URL 算法 → 网易云走自研 eapi 移植
- [x] **新增网易云音乐源（wy）**：server/src/online/wy.ts（eapi AES-ECB 密文照抄 desktop wy/utils/crypto.js；eapi/batch 网关）：搜索 /api/search/song/list/page、试听 /api/song/enhance/player/url（standard 128k，music.126.net 直链）、歌词 /api/song/lyric（lrc+tlyric）
- [x] 双源 registry：kw（酷我）+ wy（网易云）；onlineSources() 报告 lyric 能力；settings 白名单/default 扩为 ['kw','wy']；后台说明卡与勾选更新为双源
- [x] /web/api/online/lyric?source=&rid=（LRC 明文 {lyric,tlyric}，源不支持/失败回空）
- [x] 前端在线歌词：loadLyric 在线分支按 source 拉歌词（kw →「暂不支持歌词」空态；wy → LRC 渲染 + 翻译行 .tr 跟随主行高亮，±300ms 对齐）
- [x] 播放器 source/rid 映射改 x.source 前缀（原硬编码 kw_ 前缀会与 wy 数字 id 混淆）
- [x] 验证：wy 搜索/URL/歌词/206 中转全链路 + 浏览器 E2E（晴天 20 行、播放「晴天(原唱 周杰伦)」、Love Story 歌词 65 行+翻译 61 行）；smoke 61/61
- [x] build server + fpk 0010 打包交付桌面（app.tgz md5 db4285ee4d51071a1739d987b998018c）

## 已知限制 / 已排除（后续候选保留的仅以下）
- [ ] 在线歌词只覆盖网易云（酷我 newlyric 2025 起 TP=DENY 服务器端不可达）；咪咕 mrc 直链需搜到带 mrcUrl 结果才可（未接源）
- [ ] 咪咕/酷狗/QQ 平台：无官方内置 URL 算法（userApi 外置）；如需接需逆向第三方 lx-music-api-server 或实现其签名（kg infSign/tx vkey/mg 付费签名），registry 已预留 lyric/其它能力位
- [ ] 网易云版权/VIP 曲目匿名 eapi 返回空 URL → 播放器提示「暂无可播放地址」；匿名搜索对版权原版有过滤（常返回 cover/翻唱优先）
- [ ] 封面统一代理：已评估可省——kw 封面直链 img1.kuwo.cn 无防盗链且播放界面为 http（无 mixed-content），现直链可用；wy 封面为 https p1.music.126.net 直链
- [ ] 在线收藏替代：在线曲目进歌单会同步到手机端（无对应源时播不了），故有意不做；保持收藏点击提示
