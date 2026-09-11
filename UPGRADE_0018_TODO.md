# UPGRADE_0018 — Web 播放器下载功能 ✅

## 背景
0017 清理完性能热点 + 交互增强后，用户反馈：网页版播放器界面没有下载当前曲目的入口。
服务端 `/web/media/download/<id>` 早就在（0008 那轮加的，`serveAudio` 带 attachment header），
只是前端一直没挂入口——本次把它补齐。

## 改动
- [x] **底栏下载按钮**（`ui/app/index.html` + `ui/app/assets/app.js`）
  - `#player .np` 里 `#np-love` 旁新增 `#np-download`，图标为通用「下箭头 + 托盘」
  - `renderNp()` 联动：本地曲库曲目（`t.id` 存在）显示；在线源曲目隐藏 + 禁用指针
- [x] **曲目菜单"下载…"**（`ui/app/assets/app.js` `openTrackMenu`）
  - 在"添加到歌单…"后追加 `下载…` 项，仅对非 `online` 曲目显示
  - 与底栏共用同一个 `downloadTrack(t)` 实现
- [x] **快捷键 D**（`bindGlobalKeys`）
  - 播放器可见时按 `D` 触发 `downloadCurrent()`
  - 与 `Space`/`←→`/`↑↓`/`N`/`P`/`L`/`Q`/`S`/`M`/`?`/`Esc` 一起
- [x] **帮助面板同步**（`HELP_HTML`）
  - 在 `M` 之后追加 `D = 下载当前曲目`
- [x] **实现细节**：`downloadCurrent()` / `downloadTrack(t)` 用 `<a href="...">+click()+remove()`
  走浏览器原生下载，不把整个文件读进 `fetch+blob` 内存（曲库歌曲几十 MB 常态）；
  在线源曲目直接 `toast` 提示去手机 App，不发起请求

## 验证
- [x] `npm run build`（server）：tsc + tsc-alias 零错
- [x] `packaging/smoke-test.ps1`：**ALL PASSED**
- [x] `tools/e2e-0017.mjs`（Playwright Chromium headless-shell）：**27 passed / 0 failed**（比 0017 多 6 项下载相关断言）
  - 底栏 `#np-download` 存在、`title=下载当前曲目`、`visibility=visible`、`pointerEvents` 开启
  - `GET /web/media/download/<id>?k=<token>` 返回 `200` + `Content-Disposition: attachment; filename*=UTF-8''…` + 响应体非空
  - 快捷键 `KeyD` 拦截到 `<a>` click，`href` 含 `/web/media/download/`
  - 曲目菜单展开后 items 列表含 `下载…`
  - `?` 帮助面板文本含 `D` + `下载当前曲目`
- [x] **打包**：`gusi-music-1.0.0-0018-fnos-cn-x86_64.fpk`
  - 45.8 MB / 27 entries
  - `app.tgz` md5 `bff96fd2620acae645f13fc83cf3c872`
  - `packaging/build-fpk.js` 的 `build` 由 `0017` 升 `0018`

## 遗留
- 下载文件名由服务端 `serveAudio` 的 `track.name + path.extname(track.filePath)` 决定；如果文件名含 `/ \ " < > | ? * :` 等特殊字符，浏览器下载对话框会显示服务端 `encodeURIComponent` 后的字符串——不影响文件内容，仅是 UI 观感
- 移动端下载对话框在部分浏览器里会直接进"下载完成"而非弹窗；这是浏览器行为，非本应用问题
- fpk 装机 + 手机实测为下一步用户动作
