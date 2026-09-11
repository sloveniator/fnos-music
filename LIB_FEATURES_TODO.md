# LIB_FEATURES — NAS 曲库/下载/音源脚本/元数据功能包

## 架构决定（源码已确认，勿改）
- **承载源 = `local`**：mobile 音源脚本白名单 `['kw','kg','tx','wy','mg','local']`（user-api-preload.js），不能注册自定义源 ID。
  local 歌曲本地文件不存在时走 `apis('local').getMusicUrl` → 自定义脚本接管 → 返回 NAS HTTP 流 URL（music/utils.ts:168）。
- **第三方源代理**：`common.apiSource` 为 user_api 时，kw/kg/tx/wy/mg 的 getMusicUrl 全部走 `global.lx.apis[source]`（api-source.js）→ 脚本可转发到服务端配置的上游 API。
- **NAS 歌曲结构** = `MusicInfoLocal`：`{id:'local_<hash>', name, singer, source:'local', interval, meta:{songId:<nasId>, albumName, picUrl, filePath:<nasId>, ext}}`
- **歌单导入**：`.lxmc` = `{type:'playListPart_v2', data:{name, list:[MusicInfoLocal]}}`（listAction.ts readListData）
- **脚本协议 v2**：`lx.on(EVENT_NAMES.request)` / `lx.send('inited', {sources:{local:{type:'music',actions:['musicUrl','lyric','pic'],qualitys:[]}}})`；musicUrl 返回必须 `^https?://` ≤2048 字符；HTTP 用 `lx.request(url, opts, cb)`
- **流播放**：`/api/stream/<id>?k=<token>` Range 流式（播放/下载/进度条全兼容）
- **元数据优先级**：文件夹结构 `艺人/专辑/NN - 标题` > 文件名 `艺人 - 标题` > 内嵌标签补全（ID3v2/FLAC/MP4 纯 JS）

## 服务端（fnos-music/server/src/library + admin）
- [x] metadata.ts：路径解析 + ID3v2.3/2.4 + FLAC(VorbisComment/Picture) + MP4(ilst) + 时长(mp3 Xing/flac STREAMINFO/mvhd) + 封面/歌词提取（修了 2 个解析 bug：GENERIC_DIRS 误杀 Album* 目录、音轨号被 artist 切分吞掉）
- [x] scan.ts：递归扫描（跳过 .*/#recycle/@eaDir），增量（size+mtime），并发池，进度状态
- [x] index.ts：曲库存储 data/library.json（原子写）、settings（dirs/proxyUrl/proxySources）、secret+streamToken、搜索/分页
- [x] stream.ts：Range 流 + MIME 映射 + attachment 下载
- [x] admin/library.ts：公开 /api/stream|cover|lyric|proxy|search|download（token 鉴权）+ /admin/api/library/*（settings/scan/tracks/stats/export/source-script/stream-token reset）
- [x] admin.ts 接线（handleAdminRequest 顶部插 /api/，handleApi 认证后插 library）；index.ts 启动 loadLibrary + listenPort
- [x] tsc 构建通过

## 音源脚本
- [x] 服务端动态生成 buildSourceScript(base, token, proxySources)（local 直接返回签名 URL 零额外请求；第三方源走 /api/proxy）
- [ ] 手机实测导入 + 播放（用户动作）

## Web 管理后台（ui/dist 原生 JS，无构建）
- [x] 「音乐库」页：目录增删、扫描+进度轮询、搜索/分页表格、试听、下载、勾选导出 .lxmc
- [x] 「音源脚本」页：脚本下载/复制/预览、代理源勾选、上游 API 配置、token 重置
- [x] 浏览器实测（playwright kernel 起服务）：登录→建库→中文解析渲染→脚本生成→代理配置持久化 全通过

## 验证与打包
- [x] smoke-test.ps1 增补 17 项 library 断言，37/37 全过
- [x] UI 契约测试 19/19（含中文文件夹解析 周杰伦/范特西/01-可爱女人）
- [x] fpk 重打 56.9MB checksum ddcfb59c0f45ad41e4f1094fc1598c4c（旧 e086912d 废弃）
- [ ] fnOS 真机装包（用户动作）
- [ ] 手机导入脚本+.lxmc 实测播放/下载（用户动作）

## 后续可做（本轮未含）
- 曲库封面缩略图列表展示（extractCover 已就绪，UI 未接）
- 专辑/歌手分组浏览视图
- 扫描时长文件（ape/wma 无内嵌时长解析）

---

# 追加：服务端下载到指定存储（DOWNLOAD_TARGETS，2026-09-07）

用户要求：下载时可选 本地 / WebDAV 挂载点 / Docker 远端网盘（文件夹）。
抽象为两类后端全覆盖：`local`（写文件系统，含 fnOS 已挂载的 WebDAV/网盘）+ `webdav`（服务端 MKCOL+PUT 直传远端，含 AList/CloudDrive2）。

- [x] settings 扩展 `downloadTargets[]`（local:path / webdav:url+user+pass），含密码文件 chmod 600
- [x] `library/download.ts`：任务队列（并发 2）+ 进度字节计数 + 取消；源=曲库文件/直链/第三方代理解析；目标=local 写(tmp+rename)/webdav PUT(逐级 MKCOL，Basic 认证)
- [x] 路径安全：subdir/filename 逐段清洗剔除 `..`/分隔符，local 目标 resolve 后前缀校验防逃逸
- [x] 代理重构 `resolveProxyUrl` 供下载复用（第三方歌曲也能下到 NAS）
- [x] admin 路由：targets CRUD（GET 掩码密码、POST 空密码保留旧值）+ downloads 增/列/取消/移除/清除
- [x] Web UI「下载中心」页签：目标管理（本地/WebDAV 表单切换）+ 任务表（进度条/取消/清除）；曲目行「下载到NAS」+ 批量；对话框子目录预填 歌手/专辑
- [x] `verify-download.mjs`：模拟 WebDAV 服务端到端 20/20（本地写/WebDAV PUT+MKCOL+认证/直链/取消/密码保留/路径穿越）
- [x] 浏览器实测：加目标→下载到NAS→嵌套子目录落盘 `周杰伦/范特西/…mp3` 全通过
- [x] smoke-test 37/37 回归不破坏
- [x] fpk 重打 56.9MB checksum `fb321a46c03b51c344d1f75a80c165c2`（旧 ddcfb59c 废弃）
- [ ] fnOS 真机 + 手机实测（用户动作）

## 追加：自动扫描 + 目标剩余空间（2026-09-07）
- [x] `library/usage.ts`：local 用 `fs.statfs` 取 free/total；webdav 用 PROPFIND 取 DAV 配额（quota-available/used-bytes，不支持则 null）
- [x] settings 加 `autoScanAfterDownload`（默认 true）；`scheduleAutoScan(resultPath)` 防抖 4s、仅当落盘在扫描目录内触发增量 startScan
- [x] download.ts done 分支调用 scheduleAutoScan（local 目标）
- [x] admin 路由 `GET /admin/api/library/targets/usage`（并行探测）；targets GET 返回 autoScanAfterDownload；settings POST 接收该字段
- [x] UI：下载中心「下载后自动扫描入库」开关；目标列表 + 任务表新增「目标剩余」列；增删目标后即时刷新用量（修了新增后 id 变更致用量滞后 20s 的时序 bug）
- [x] verify-download.mjs 扩到 23/23（+local 用量数字 +自动扫描入库 trackCount 增长）
- [x] 浏览器实测：目标显示「剩余 178.8G/256.0G」、任务表目标剩余列、自动扫描开关默认勾选
- [x] fpk 重打 checksum `4fd64f666f32695874ff3f50d6a2548d`（旧 fb321a46 废弃）
