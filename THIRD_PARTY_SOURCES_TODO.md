# THIRD_PARTY_SOURCES — 第三方 JS 音源服务端承载（完整版，非 POC）

目标：5 个真实脚本（Flower/Huibq/LX/QDY/SixYin）可在服务端以 worker 沙箱完整承载，
Web/移动端经既有源解析链自动使用（先第三方脚本、后内置/旧代理回退）。

- [x] 盘点：5 脚本宿主协议一致（request/on/send/EVENT_NAMES + inited{sources} + musicUrl），
      差异仅在混淆/自更新/中央 API；SixYin/LX 为重度混淆整包但外壳同协议
- [x] S1 worker 运行时：user-source-worker.ts（node:http 自持 + vm 沙箱 + header 清洗 +
      超时/体上限/死循环掐断/禁 process-eval-Function）
- [x] S2 管理器：user-source.ts（脚本 0600 落盘 data/user-sources/{id}.js + meta.json、
      懒启动/后台预热、capabilities 采集、invoke 看门狗 20s→terminate 重建、resolve 链 15s 总预算）
- [x] S3 接入：online/index.ts onlineResolvePlayUrl 先第三方再内置；
      admin/library.ts resolveProxyUrl（/api/proxy）先第三方再旧代理模板（错误文案已更新）
- [x] S4 admin 端点：GET list / POST save(启用即后台预热) / enable / test(草稿或已保存) /
      GET 单条含脚本 / DELETE，大脚本 reader 900KB
- [x] S5 UI：音源与代理 tab → 「第三方 JS 音源（服务端执行）」卡：清单表(名称/能力chips/状态/启停) +
      添加/编辑对话框(名称+脚本 textarea+载入文件+草稿测活) + 行内测活/编辑/删除
- [x] S6 验证：tsc 零错；tools/user-source-smoke.mjs 17/17（协议闭环+护栏+header清洗）；
      tools/e2e-user-sources.mjs 13/13（真实起服 HTTP CRUD/启停/测活/401）；tools/ui-us-check.mjs 9/9
      （真实 Chromium 渲染+保存+测活+开关）；真实源 live：QDY wy 1.2s 出 URL、LX 采 6 平台、
      Huibq/Flower/Grass 上游服务状态问题（非本侧）
- [x] S7 打包 fpk 0013 交付：gusi-music-1.0.0-0013-fnos-cn-x86_64.fpk（48.1MB，
      桌面；app.tgz md5 b8d3ea6999be79ef744e4da7a39cd8a3，manifest 已核对 version=1.0.0-0013）；
      解包复核：server/server/online/user-source*.js、online/index.js 的 resolveFromUserSources
      回退链、ui/dist/assets/admin.js 的 us-table 管理 UI 均在包内。旧 USER_SOURCE_TODO.md 的
      POC 切片描述已被本文件完整版取代（切片0-2 全部落地），旧文件不再维护。

## 遗留（不在本任务范围）
- 装机回归：LX kg/tx/mg 走移动端 /api/proxy 需装 0013 后真机验证；artists=3 等 0005 起修复仍未真机回归
- 真实源 live 上游问题（Huibq onrender 503 / Flower+Grass 97.64.37.235 镜像不可达 / SixYin 官网更新）非本侧可解

约束（沿用）：不动 LX_USER_ 命名；脚本落盘 0600 不进 summary；resource 护栏；服务端不内置抓取；
不做 VIP/无损。真实源 live 结论：LX kg/tx/mg 走移动端 /api/proxy 仍需装包后真机验证。
