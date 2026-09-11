# UPGRADE_0019 — 播放页：CD 唱片旋转 + 歌词

## 背景
- UPGRADE_0016/0017 已有底栏播放器、快捷键 L、`#lyric-full` 歌词全屏、`updateLfBg()` 动态封面背景。
- 本次用户诉求：**播放音乐时，点击歌曲封面，可以拉起播放页面（CD 唱片旋转 + 歌词）**。
- 把 `#lyric-full` 从纯歌词容器升级为完整播放页：左侧 CD 唱片（随播放态旋转） + 右侧滚动歌词；由底栏封面或快捷键 L 拉起。

## 变更清单

### 1. `ui/app/index.html`
把 `#lyric-full` 内部结构改为「背景 + 顶栏 + 舞台 + 底部控件」：
- `#lf-bg`：动态封面模糊背景（保留原实现）
- `.lf-head`：返回按钮（`#lf-close`，title="返回（Esc）"） + 当前曲目 `#lf-title`
- `.lf-stage`：两列网格舞台
  - `.lf-disc-wrap > #lf-disc > .lf-disc-inner > #lf-disc-cover`：CD 唱片（中心为封面），`.lf-disc-label` 作高光扫过，`.lf-disc-hub` 作中心小孔
  - `#lf-body`：滚动歌词容器
- `.lf-ctrls`：进度 + 播放/切歌/循环/音量（保持 UPGRADE_0017 已有）

### 2. `ui/app/assets/app.css`
新增/覆盖：
- `.lf-stage`：`display: grid; grid-template-columns: minmax(280px, 40%) minmax(0, 1fr);`
- `.lf-disc`：`width: min(360px, 68vh); height: min(360px, 68vh); border-radius: 50%;` 多层 radial-gradient 模拟 CD 环纹 + 反光
- `@keyframes lf-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`
- `.lf-disc { animation: lf-spin 22s linear infinite; animation-play-state: paused; }`
- `.lf-disc.playing { animation-play-state: running; }`
- `.lf-disc-inner`：CD 中心 22% 圆，内放 `<img id="lf-disc-cover">`
- `.lf-disc-label`：`conic-gradient` 高光扫过，`mix-blend-mode: screen`
- `.lf-disc-hub`：6% 黑色小孔
- 移动端 `@media (max-width: 900px)`：
  - `.lf-stage { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }`
  - `.lf-disc { width: min(220px, 42vh); height: min(220px, 42vh); }`

### 3. `ui/app/assets/app.js`
- `updateLfBg()`：除 `#lf-bg` 外，同步 `#lf-disc-cover.src`；加载失败回退到 `assets/icon.png`
- 新增 `togglePlayPage(force?)`：统一开关播放页，打开时刷新背景
- `setPlayIcon(playing)`：同步 `#lf-disc.playing` 类，驱动动画暂停/播放
- 快捷键 `KeyL`：改为调用 `togglePlayPage()`
- 绑定：
  - `#btn-lyric` → `togglePlayPage()`
  - `#lf-close` → `togglePlayPage(false)`
  - `#np-cover` → `togglePlayPage()`，cursor/pointer + title="打开播放页"
  - `.np-art` → 同上（扩大命中区，包含封面圆角阴影）
- 移动端 `.np` 已存在整块点击（0016），事件冒泡到 `.np-art` 会先被 `stopPropagation` 拦下走同一路径，行为一致

## 验证
- `npm run build` 零错误
- `node tools/e2e-0017.mjs` 全 35 项 PASS，新增/覆盖：
  - 底栏封面带 title="打开播放页" + pointer cursor
  - 点击封面拉起 `#lyric-full`
  - 播放页含完整 CD 结构：disc / stage / wrap / inner / discCover / label / hub / body / bg
  - `.lf-disc` 有 `lf-spin` 关键帧，`animationDuration: 22s`，`animationIterationCount: infinite`
  - `animation-play-state` 与 `.playing` 类同步（paused ↔ running）
  - `#lf-close` 关闭、`KeyL` 重新打开
  - 移动端 CSS 覆盖存在（`min(220px, 42vh)` + grid-template-rows）
- 无 JS 运行时错误

## 交互
- **入口**：点击底栏封面 / 按 L 键 / 点击底部播放器的歌词图标（`#btn-lyric`）
- **退出**：点击"返回（Esc）" / 按 Esc
- **旋转**：正在播放 → CD 22 秒转一圈；暂停 → 定格
- **移动端**：CD 变小居中，下方滚动歌词

## 遗留 / 不做
- CD 高光扫过目前是纯 CSS `conic-gradient` + `mix-blend-mode: screen`，与旋转共用一个动画。若要单独扫光，需要再拆一层独立动画（未做，视觉已足够）
- 底栏封面点击在移动端会先被 `.np` 整块监听捕获；由于两者都调 `togglePlayPage()`，效果一致，不冲突
- 播放页目前无"背景虚化"独立控制；沿用 `#lf-bg` 现有背景图
