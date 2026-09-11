# UPGRADE_0014 — 曲库浏览升级 + 稳健性 + 咪咕在线源 ✅

## 评审定位（0013 交付后的功能矩阵补强）
- 曲库封面缩略图：`extractCover` 已就绪但两端列表 UI 均未接（LIB_FEATURES_TODO 遗留）
- ape/wma 扫描无时长（`interval=null`，仅元数据补全覆盖 mp3/flac/m4a）
- 检索每次请求对全库做正则归一化，万首曲库搜索开销大
- 同步明文 HTTP 仅在 README 提及，后台无提示
- 在线源仅 kw/wy；咪咕 v3 搜索接口（免登录+md5 签名头）经 POC 实测可用

## 本轮清单
- [x] **曲库封面缩略图列表**
  - 管理后台「音乐库」表新增「封面」列（`/api/cover/<id>?k=` 懒加载，404 隐藏，`.lib-cover` 36px 圆角）
  - Web 播放器 `trackRow` 行内封面（NAS 曲库走 `/web/media/cover`，在线源走 `t.pic`；无封面显示渐变占位块）
  - 覆盖全部曲目表：全部歌曲/搜索/最近播放/歌单/专辑详情/歌手详情
- [x] **专辑/歌手分组浏览**：盘点确认 0013 已内置（`grouping.ts` + Web `#/albums` `#/artists`），TODO 文档条目过时，本轮关账
- [x] **ape/wma 时长解析**（`metadata.ts`）
  - `parseApe`：APE v3980+ APE_DESCRIPTOR/APE_HEADER，时长 = ((totalFrames-1)×blocksPerFrame + finalFrameBlocks) / sampleRate
  - `parseAsf`：ASF Header 遍历 → File Properties Object，Play Duration(100ns) − Preroll(ms)
  - GUID 磁盘混合端序（`30 26 B2 75…`），非常见 hex 字符串序
  - `tools/metadata-ape-wma.mjs` 单测：合成头解析 + 非法输入全过；端到端实测 ape→0:30 / wma→3:05
- [x] **检索性能**（`library/index.ts`）
  - 归一化索引 `normIndex`（loadLibrary / startScan 完成时重建），listTracks/searchTracks 检索零正则
  - `persist()` 改异步原子写（串行链防乱序），万首级 library.json 落盘不阻塞事件循环
- [x] **HTTPS 部署指引**
  - 管理后台「概览」页安全提示卡：非 HTTPS 且非回环访问时显示（Caddy 反代示例 + WebSocket/Range 透传要点）
  - 本地判定 `hostname==='localhost' || startsWith('127.') || '::1'`
  - README 新增「安全与 HTTPS 部署」章节
- [x] **咪咕音乐在线源（mg）**（`server/src/online/mg.ts`，POC 全链路实测后实现）
  - 搜索：`jadeite.migu.cn music_search/v3`，签名照抄 lx-music-desktop mg/musicSearch.js（md5(keyword+salt+deviceId+time)）
  - 试听：`app.c.nf.migu.cn listen-url`（songId，toneFlag=PQ）→ freetyst 直链；部分曲目为官方 60s 试听片段
  - 歌词：listen-url 响应内 `songItem.lrcUrl` 直取 LRC
  - registry/默认 settings 白名单/admin settings patch/后台开关 UI/Web srcName 均扩为三源
  - 前端 `loadLyric` 在线歌词支持 wy+mg（原硬编码仅 wy）
  - E2E：搜索「晴天」33 行全带封面、播放、歌词渲染（tools/mg-e2e.png → 截图/走查_咪咕在线源.png）
- [x] **打包修复**：`build-fpk.js` [5/5] 校验命令 Windows GNU tar 盘符路径误判为远程主机 → 改 `-C`/相对路径
- [x] **回归**：smoke ALL PASSED；verify-download ALL PASSED；user-source-smoke 17/17；e2e-user-sources 13/13；ui-us-check 9/9；check-ids 92 selectors（`toast` 为 0013 起既有误报，动态创建）；tsc 零错
- [x] **打包**：`gusi-music-1.0.0-0014-fnos-cn-x86_64.fpk`（45.8MB / 27 entries / app.tgz md5 `7fca1526c9c6af5f341822ec7542f16c`），已拷 `deliverable\`；包内核对 mg.js/parseApe/parseAsf/封面列/HTTPS 卡均在位
- [ ] fnOS 真机装包 + 手机导入实测（用户动作）

## 已知边界
- 咪咕部分版权曲 listen-url 返回 60s 试听片段（auditionsLength），与官方免费策略一致，不做 VIP 突破
- 第三方 JS 音源（如 QDY）声明 mg 能力时取链优先于内置源；其上游失效（如 haitangw 404）会导致该源播放失败——既有「脚本优先、失败回退」语义，用户可在后台停用对应脚本
- 咪咕在线歌词为纯 LRC（trcUrl 翻译暂未接）；酷我歌词仍不可用（newlyric TP=DENY）
- Web 播放器在线页源 chips 在 sources 接口返回前点击存在既有竞态（renderChips 被回调覆盖），偶发，后续可修
