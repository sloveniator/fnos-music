# UPGRADE_0017 — 性能热点清理 + 播放器交互增强 ✅

## 背景
0015/0016 落地后曲库能起量了，但一屏 60 行歌曲列表把两个热点全触发：
1. 每行封面各自做一次完整 ID3/m4a 解析 + open fd（列表页一屏 60 次）；
2. 无内嵌歌词的曲目每播一遍打一次 QQ/酷狗外部接口，QQ 搜索还有风控。
同一轮用户反馈 Web 端"随机播放"入口稀薄、洗牌会连续重复、歌词全屏里改音量/切模式无反馈、快捷键覆盖不全。

本轮不改协议、不接新源、不加第三方依赖，只把上面这些点收掉。

## 服务端
- [x] **封面 LRU 缓存** `server/src/library/metadata.ts`
  - `extractCover` 结果按 `filePath + mtime + size` 键控 LRU（256 项 / 32 MB）；负结果也缓存（miss 哨兵）避免反复失败解析
  - **顺带修一个 P0**：`sizeCalculation` 在 miss 条目上返回 0，lru-cache v10 抛 `sizeCalculation return invalid (expect positive integer)`，导致**所有**封面/歌词请求报错——已改为 `('miss' in v ? 1 : v.data.length)`
- [x] **歌词兜底双层缓存** `server/src/online/lyric-fallback.ts`
  - 内存 LRU + 磁盘 `data/lyric-cache.json`（原子写），provider 一并缓存
  - NAS 内嵌歌词命中仍走原快路径；外部源结果持久化后不再重放请求
- [x] **grouping 索引化** `server/src/web/grouping.ts`
  - `rebuild()` 内同步构建 `albumTrackIdx` / `artistTrackIdx` 两个 `Map<string, TrackInfo[]>`，按 `trackNum ?? 9999` 排序
  - `albumTracks` / `artistTracks` 由全库 filter 两次改为 O(1) 命中索引
  - 缓存键已含 `scannedAt + length + max(mtime)`，重命名文件也会失效

## Web
- [x] **随机播放入口铺开**（`ui/app/assets/app.js`）
  - 首页「最近播放」区块：播放全部 + 随机播放
  - 全部歌曲页：新增顶部工具条（共 N 首 · 已加载 M + 播放全部 + 随机播放）
  - 专辑页 hero：随机播放 + 全部加到队列
  - 歌手页 / 歌单详情页：随机播放（原本已有）
  - 搜索页 tracks 结果：播放全部 + 随机播放
- [x] **我的歌单页加"新建歌单"按钮**（原先只能从侧栏 `＋` 触发）
- [x] **`.page-head` 布局**（`ui/app/assets/app.css`）：标题 + meta + 操作按钮的一行式布局
- [x] **无放回洗牌**：`_nextShuffle()` 用 `Set` 记录已播下标，播完一轮自动重置——修掉了"随机播放连续重复 + 单曲列表 no-op"
- [x] **跨控件状态同步**（0016 遗留）：`setModeIcon` 双写 `#btn-mode` / `#lf-mode`；`setVolume` 双写 `#vol` / `#lf-vol`；`syncMuteIcon` 双写 `#vol-ico` / `#lf-vol-ico`——移动端在歌词全屏里改模式/音量有正确反馈
- [x] **快捷键补 L/Q/S**：L=歌词全屏、Q=播放队列、S=循环模式切换；`?` 帮助面板同步列出这三条
- [x] **最近播放写入防抖** `server/src/web/playlists.ts`
  - `recordPlayed` 由每次 read+write 整个 JSON 改为内存 `Map` + 2 秒防抖持久化；`getPlayed` 直读内存

## 验证
- [x] `npm run build`（server）：tsc + tsc-alias 零错
- [x] `packaging/smoke-test.ps1`：**ALL PASSED**（含 0017 新增歌词缓存命中 + 随机播放接口断言，额外耗时 +0.08 s）
- [x] `tools/e2e-0017.mjs`（Playwright Chromium headless-shell，真起 server + 消费者 Web）：**21 passed / 0 failed**
  - 全部歌曲顶部工具条：共 N 首 · 已加载 M + 播放全部 + 随机播放 均在位
  - 随机播放切 shuffle：`localStorage.gusi-mode=shuffle`、`#btn-mode`/`#lf-mode` title 双写为「随机播放」
  - 快捷键：L 打开歌词全屏、Q 打开队列、S 在 shuffle 与 order 间切换、Esc 关闭任一面板
  - `?` 帮助面板已列出 L/Q/S 三条
  - 队列面板 ≥ 4 项；首页「最近播放」与搜索页 tracks 结果工具条随机播放按钮均在位
  - 无 JS 运行时错误（测试曲目是随机字节无内嵌封面，封面 404 不计）
- [x] **打包**：`gusi-music-1.0.0-0017-fnos-cn-x86_64.fpk`
  - 45.8 MB / 27 entries
  - `app.tgz` md5 `10d482136c1fa00b9775d562907deade`
  - `packaging/build-fpk.js` 的 `build` 由 `0016` 升 `0017`

## 遗留
- 歌词兜底缓存按 trackId 键控，同一首歌被重命名/换文件后 trackId 变化会失效重取——可接受
- fpk 装机 + 手机实测为下一步用户动作
