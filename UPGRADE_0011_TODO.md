# UPGRADE_0011 — 综合升级：在线发现(榜单) + UI 美化 + 体验补强 ✅

## 综合分析结论（功能矩阵短板）
- 在线音乐只有「搜索」单入口；洛雪 SDK 有榜单能力未用（weapi 通道 POC 已验证可用）
- 网易云播放 URL 已可 128k 试听；搜索排序命中原版不确定属平台侧，本版不处理
- 播放器/列表 UI 已 v2 精致化；在线页相对朴素（纯表格），缺"发现感"
- 播放队列刷新即失；在线歌无法批量播放

## 升级清单
- [x] 服务端 wy.ts：weapi 加密（AES-CBC+RSA NO_PADDING 照抄 desktop crypto.js）+ WY_BOARDS 17 榜 + 榜单详情（weapi playlist/detail→song/detail 映射 OnlineItem，含封面）
- [x] 服务端：/web/api/online/boards?source=（目录）、/web/api/online/board?source=&bid=（曲目）；sources 带 boards 能力位
- [x] 前端在线页 v2：品牌渐变横幅 + 「搜索/排行榜」胶囊 Tab（wy 双 tab、kw 仅搜索）
- [x] 榜单视图：封面卡片网格（渐变底+序号水印+hover 上浮），点击入榜 → 表格复用现有播放（含封面列）
- [x] 「播放全部」：榜单详情与搜索结果一键入队播放
- [x] 队列持久化：localStorage gusi-q 存 queue/index/进度，刷新恢复（restore+toast+loadedmetadata seek 断点续播）
- [x] 回归：smoke 62 PASS 0 FAIL + UI 契约（check-ids 74 selectors 无 missing）+ 浏览器 E2E（榜单 50 行可播、播放全部、搜索封面列、刷新恢复、kw 无榜 tab、返回网格）全过
- [x] 打包 0011 交付桌面（57.0MB / 27 entries / checksum ba17f75f…dd26696，旧 0010 废弃）
