# UPGRADE_0016 — Web 播放器移动端显示优化 ✅

## 背景
用户反馈网页版在手机上显示不佳。iPhone 视口（390×844，isMobile+hasTouch）Playwright 实测 +
视觉走查确认根因，共修复一个布局级 P0 缺陷 + 一组体验适配。

## P0 根因：侧栏抽屉挤压整个内容区（.shell flex 布局缺陷）
- 旧实现：`@media ≤900px` 下 `.sidebar { position:fixed; transform:translateX(-102%) }`。
  **transform 移出屏幕但不释放 flex 文档流空间**，238px 侧栏继续占据布局，导致：
  `.main` 被压到 194px 宽（视口 390 的一半）、曲目表歌名逐字竖排、时长列截断、
  topbar 被挤到 x=226 悬在半空——视觉上「右半屏空白 + 内容窄条」。
- 修复（双重）：
  1. `.sidebar` 收起态 `margin-left: -238px`（负 margin 抵消占位，flex 空间真正释放），
     展开 `.open` 时 `position: fixed` 覆盖在内容之上（不挤压）；保留 transform 过渡动画。
  2. `.topbar` 移动端 `position: fixed` 全宽置顶（原先作为 .shell 的 flex 子项排在 sidebar 之后，
     横向占位 164px），`.main` 顶部相应留白 `62px + safe-area`。

## 移动端适配清单（@media ≤900px 新增）
- **曲目表**：内边距/触控目标放大（行点击区、收藏/菜单按钮 ≥38px）、封面列 48px、
  歌名 ell 上限、时长列字号微调；队列行「×移除」与在线行播放按钮常显（触屏无 hover）
- **播放器底栏**：隐藏「播放模式」键（移入歌词全屏），仅留 上一首/播放/下一首/队列；
  播放键 `flex-shrink:0` 修复被压缩为 0 宽的缺陷；触控目标 38-44px；
  高度含 `env(safe-area-inset-bottom)`（iPhone 全面屏安全区）
- **歌词全屏 = 移动端主控台**：点击底栏信息区/封面展开歌词全屏（新交互，`.np` 点击委托，
  排除收藏按钮）；全屏底部新增控制条 `#lf-ctrls`（进度条可拖动定位 + 上一首/播放/下一首 +
  音量滑块），与底栏控制状态实时双向同步（tick/setPlayIcon 双写）；安全区 padding
- **在线页**：横幅压缩（padding/字号/装饰音符缩小）、源 chips 改横向滚动不换行、otab 收窄
- **队列/Toast**：安全区避让、max-height 56vh、Toast 宽度限制居中
- **歌词全屏**：head/body 安全区 padding、字号节奏下调（15/18px）
- **桌面端零影响**：全部改动限于 ≤900px 媒体查询与新增 `.lf-ctrls`（桌面 `display:none`）

## 管理后台（admin）小补
- `@media ≤640px`：header 折行、tabs 换行、表格字号/内边距压缩、封面列 30px

## 验证
- 布局断言（Playwright DOM）：`.main` 194→390 全宽、行高 151→62、topbar x=0 全宽、
  底栏 4 按钮全部可见（play 48px）、歌词全屏控制条 78px 高可见、抽屉 overlay 不挤压
- 视觉走查（4 张 3x 视口截图）：全宽铺满 ✅ 单行曲目 ✅ 底栏完整 ✅ 歌词控制条 ✅ 抽屉覆盖 ✅
- 横向溢出检查：home/tracks/lyric/queue/drawer/online/albums 全部 0px 溢出
- 回归：smoke ALL PASSED、ui-us-check 9/9、check-ids 92、JS 语法校验通过
- **打包**：`gusi-music-1.0.0-0016-fnos-cn-x86_64.fpk`（45.8MB / 27 entries / app.tgz md5
  `d0032f96d3be04746faeaecf99c6539b`）已拷 `deliverable\`；包内核对全部新 CSS 在位
- [ ] 真机（iOS Safari / 安卓 Chrome）人工走查（用户动作）

## 踩坑记录
- transform:translateX 不释放 flex 空间：抽屉类布局应使用负 margin 抵消占位 + 展开 fixed 覆盖
- Playwright `page.click/tap` 对 `<tr>`（display:table-row）在 touch 语境下报 element not visible，
  需用 `page.evaluate(() => tr.click())` 触发；真实手机 click 事件正常，非产品缺陷
- `page.$eval` 时歌词全屏内 `#lf-play` 与底栏 `.icon-btn.play` 同选择器会取到隐藏元素（w=0），
  断言要按容器范围取
