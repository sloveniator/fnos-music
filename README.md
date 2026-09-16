# 古四音乐（GuSi Music）— 飞牛 fnOS 音乐应用 + 安卓 App

基于 [洛雪音乐](https://github.com/lyswhut/lx-music-mobile)（lx-music-sync-server v2.1.2 / lx-music-mobile v1.8.4，Apache-2.0 + 非商业附加条款）二次开发的私有云音乐中心：NAS 曲库在线播放、多端歌单同步、Web 消费者应用与管理后台，配合洛雪音乐移动版使用。

> 版权说明：本项目保留上游 LICENSE；同步协议（握手/认证/消息格式）与上游完全兼容，可直接使用官方洛雪音乐客户端。

## 结构

```
fnos-music/
├── server/          # Node.js 服务端：同步协议 + 曲库 + 管理 API + Web 消费者 API（TypeScript）
├── ui/
│   ├── dist/        # 管理后台（零构建原生三件套，挂载 /admin/）
│   └── app/         # 消费者音乐应用（零构建 SPA，挂载 /，桌面图标直达）
├── mobile/          # 安卓客户端（品牌化改造自 lx-music-mobile，com.gusi.music）
├── build/           # fpk 模板：manifest/cmd 生命周期/config/wizard
└── packaging/       # 打包器、logo 生成器、冒烟/回归测试
```

## 功能面

| 入口 | 说明 |
|---|---|
| `/`（桌面图标） | 消费者音乐应用：登录（同步用户账号）、专辑墙/歌手/搜索、播放队列、LRC 歌词、MediaSession 锁屏、歌单管理、收藏、最近播放、移动端自适应 |
| `/admin/` | 管理后台：运行状态、同步用户 CRUD（用户名=连接码）、音乐库（扫描/授权目录一键添加/试听/导出 .lxmc）、下载中心（本地/WebDAV 目标、自动扫描、剩余空间）、音源脚本生成 |
| TCP `:43000` | 洛雪音乐移动版同步服务（自建服务：地址=NAS IP，端口=安装向导端口，连接码=后台用户）+ 音源脚本流媒体直连 |
| fnOS 网关 | 微应用入口经 Unix socket `app.sock` 转发（`gatewayPrefix=/app/gusi-music`），TCP 与 socket 双监听互不影响 |

## 构建

```powershell
cd server && npm run build          # tsc + tsc-alias
node packaging/gen-icon.js          # 图标（设计实现 packaging/logo.js：外圆内方古钱+唱片纹+播放三角）
node packaging/rebrand-mobile.js    # 安卓品牌化（幂等，可重复执行）
node packaging/build-fpk.js         # 组装 fpk
```

打包前置：`server/offline/node-linux-x64.tar.gz` 必须存在（fpk 捆绑的 Node 运行时，不入库）。首次或升级运行时：

```bash
mkdir -p server/offline && curl -fL -o server/offline/node-linux-x64.tar.gz \
  https://npmmirror.com/mirrors/node/v20.19.4/node-v20.19.4-linux-x64.tar.gz
# 校验和比对 https://nodejs.org/dist/v20.19.4/SHASUMS256.txt
```

### 交付前验证（Linux，需 root）

```bash
sudo bash packaging/verify-fpk.sh          # 结构+校验和+完整生命周期（自动挑一个不存在的 /volN）
sudo bash packaging/verify-fpk.sh --keep   # 保留现场排查
```

它在临时存储空间里真实跑一遍：安装 → 启动（确认用的是**捆绑** Node）→ HTTP 自检 → 状态/停止 → 升级（数据与运行时复用）→ 卸载保留 → 重装沿用端口 → 卸载彻底删除 → 路径动态解析与删除白名单单测，共 67 项断言。`--vol-root` 指向的路径已存在时会自动换号，绝不动真实存储空间。

## 生命周期与运行时（cmd/）

- fpk 捆绑 Node v20.19.4 linux-x64（`server/offline/`），`cmd/main` 启动时按 md5 stamp 增量解压到 `PKGVAR/runtime/node/`，无捆绑包回退系统 node——目标机无需预装 Node
- **路径全动态适配**：安装目录用 `TRIM_APPDEST`、数据目录用 `TRIM_PKGVAR`、挂载/媒体目录用 fnOS 下发的授权路径（`TRIM_DATA_ACCESSIBLE_PATHS`，写快照热生效）。存储空间编号一律不假定——`cmd/runtime_paths.sh` 从 fnOS 变量或脚本自身位置推导，**推导不出就什么都不做**（不猜 `/volN` 去写或删），因此装在 `/vol1`…`/volN` 行为完全一致
- 服务端配置读包内 `server/config.json`（`CONFIG_PATH` 可覆盖）；安装/卸载脚本各自以包专属用户运行，root 调用时自动降权重入
- `cmd/runtime_*.sh`（对齐道理鱼工程层）：日志轮转（10MB×4）、包身份校验（拒 root）、授权目录逐路径权限诊断（中/繁/英）、数据目录可写探测、升级就绪标记
- 向导字段：`wizard_app_port`（端口，占用即失败）、`wizard_admin_password`（留空自动生成，存 `app-config.env` chmod 600）
- 应用中心「授权目录」经 `config_callback` 写入 `accessible-paths.env` 快照，服务端 `system-dirs` 接口**读文件热生效**（无需重启）
- 关键环境变量（cmd/main → server）：`GS_HTTP_UNIX_SOCKET`（网关 socket）、`GS_HTTP_UNIX_SOCKET_ACL_USERS`（默认 www-data，setfacl 授权）、`GS_PUBLIC_BASE_PATH`（网关前缀剥离）、`GS_ACCESSIBLE_PATHS_FILE`、`GS_ADMIN_PASSWORD`、`GS_WEB_STATIC_DIR`、`GS_APP_STATIC_DIR`

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File packaging\smoke-test.ps1 -Port 19530   # 冒烟：协议/管理/Web API 全链路
node packaging\verify-download.mjs                                              # 下载引擎（含模拟 WebDAV 服务端）
```

冒烟覆盖：v4 握手、管理登录/限流、用户 CRUD、鉴权边界（401/403）、路径穿越、持久化、曲库扫描/流/Range/歌词/封面、.lxmc 导出、音源脚本生成（直连 base）、下载目标、系统授权目录、**Web 消费者 API**（登录限流/会话/歌单增删改/收藏/排序/媒体鉴权）。

## 产物

- `packaging/out/gusi-music-<version>-fnos-cn-x86_64.fpk`（约 47 MB，含 Node 运行时）
- manifest `checksum` = app.tgz 的 MD5；包结构与道理鱼原包逐条目对齐（28 entries，多一条 `cmd/runtime_paths.sh`）

## 已知边界

- 第三方音源歌曲（kw/wy 等）Web 端置灰不可播（音源解析在手机 App 侧），NAS 曲库曲目全端可播
- 同步数据走明文 HTTP（局域网定位，勿公网暴露；同步内容本身有端到端加密）
- 消费者端无注册入口：账号 = 管理后台创建的同步用户（私人 NAS 场景）

## 安全与 HTTPS 部署

局域网内明文 HTTP 属预期设计；**如需公网/跨网段访问，务必在服务前加 HTTPS 反向代理**：

```caddyfile
# Caddy 示例（自动签发证书；fnOS 亦可装 OpenResty/Nginx 实现）
music.example.com {
    reverse_proxy 127.0.0.1:9527
}
```

- 反代需透传 WebSocket（洛雪同步协议）与流媒体 Range 请求
- 手机端同步地址保持 `http://NAS内网IP:端口` 直连（TCP 通道不经反代）
- 管理后台会在非 localhost 的 HTTP 访问时于「概览」页顶部显示该提示
