# UPGRADE_0020 — 每用户独立物理曲库（方案 C）

## 目标
让 Web 消费者端（`/web/*`）按用户隔离曲目：每个已存在的用户可有独立的扫描目录、索引、统计与扫描状态。移动端 `/api/*` 协议与全局曲库保持不变，向后兼容。

## 关键设计

### 数据落盘
- `data/libraries/<safeUser>/library.json` —— 该用户的曲目索引（结构与全局 `data/library.json` 一致）
- `data/libraries/<safeUser>/library-settings.json` —— 该用户的扫描目录 `{dirs: string[]}`
- `safeUser` 由用户名经 `[A-Za-z0-9_.-]` 白名单过滤 + 64 字符截断得到；无合法字符时退化到 `default`
- 目录权限 `0o700`，写文件走 `write → rename` 原子替换，落盘在 `persistChain` Promise 队列上串行

### 内存注册表
- `Map<safeUser, TenantState>`，首次访问懒加载（读文件 → 建 `tracksById` 索引 → 计算 `maxMtime`）
- 扫描用与全局共享的 `runScanWithState(dirs, oldTracksById, state)`：把原来 `scan.ts` 里 `runScan` 对模块级 `scanState` 的引用抽出为参数，多租户并发扫描互不干扰
- 扫描结束后原子替换 `t.tracks` / `t.tracksById` / `t.scannedAt` / `t.maxMtime`，并 `persistTenant`

### 分组缓存
- 抽出纯函数 `buildGroupings(tracks, scannedAt, maxMtime)`：一次性建 `albums / artists / albumTrackIdx / artistTrackIdx`
- 全局版（`listAlbums/listArtists/albumTracks/artistAlbums/artistTracks`）保留原签名，供 admin UI 与 lx-music-mobile 继续调用
- 租户版（`tenantListAlbums/tenantListArtists/tenantAlbumTracks/tenantArtistAlbums/tenantArtistTracks`）以 `cacheKeyUser` 为键做独立缓存，键值 `scannedAt:length:maxMtime` 变化时自动重建

## 修改清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `server/src/library/tenant.ts` | **新增** | 租户曲库核心：`getTenantSettings/saveTenantSettings/tenantLibraryStats/startTenantScan/getTenantScanState/listTenantTracks/searchTenantTracks/getTenantTrack/getTenantTracks/tenantGroupingSeed/listTenants/removeTenant` |
| `server/src/library/scan.ts` | 改 | `runScan` 拆成 wrapper + `runScanWithState(dirs, oldTracks, state)`，多租户共用逻辑但各自持 ScanState |
| `server/src/web/grouping.ts` | 重写 | 抽出 `buildGroupings` 核心，新增 5 个 `tenantXxx` 变体（独立缓存） |
| `server/src/admin/library.ts` | 改 | 新增 6 个租户管理端点（见下） |
| `server/src/web/api.ts` | 改 | `/web/api/*` 与 `/web/media/*` 全部改走 `getTenantTrack(userName, ...)` / `listTenantTracks(userName, ...)` / `tenantLibraryStats(userName)` / `getTenantScanState(userName)`；分组接口改为传 `tenantGroupingSeed(userName)` 结果 |
| `server/src/web/playlists.ts` | 改 | 所有 `getTrack(trackId)` 换成 `getTenantTrack(userName, trackId)`；跨租户添加曲目静默过滤为「无有效曲目」 |
| `server/src/online/lyric-fallback.ts` | 改 | `lyricWithFallback(trackId, preResolved?)`：Web 端传入已解析的租户 track；缓存键加 `filePath` 隔离跨租户 id 重叠 |
| `packaging/build-fpk.js` | 改 | `build: '0019'` → `'0020'`；更新 changelog |
| `tools/e2e-0020.mjs` | 新增 | 34 项 API 层断言（双用户隔离 + 全局兼容 + 跨租户 404） |

## 新增管理端点
均在 `server/src/admin/library.ts`，需要 `X-Admin-Token`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/library/users` | 列出所有用户的租户概况（settings/stats/scan/tenants） |
| GET | `/admin/api/library/user-settings/:name` | 单个用户租户设置与统计 |
| POST | `/admin/api/library/user-settings/:name` | 保存 `{dirs: string[]}`（最多 32 个） |
| POST | `/admin/api/library/user-scan/:name` | 触发该用户扫描（已扫描中或无目录时 409） |
| GET | `/admin/api/library/user-scan/:name` | 轮询扫描进度 |
| GET | `/admin/api/library/user-stats/:name` | 该用户租户统计 |

所有端点校验目标用户存在于 `global.lx.config.users`；不存在返回 404。

## 兼容性
- **移动端 lx-music-mobile 协议 `/api/*`**：完全不变，仍走全局 `library.json`
- **Admin UI 与全局曲库**：`/admin/api/library/*` 中除新增的租户端点外，全部原样保留
- **第三方音源代理（UPGRADE_0013）**：在线源通道 `onlineResolvePlayUrl / onlineSearch / onlineBoards / onlineBoardList / onlineLyric` 不受影响；`/web/media/online/*` 代理流不变
- **歌词兜底**：全局 `lyricWithFallback(trackId)` 仍可用（admin UI、移动端兜底），仅 Web 端改为传入租户 track

## E2E 结果（tools/e2e-0020.mjs）
```
== 34 passed, 0 failed ==
```

覆盖：
- 建两个用户 userA/userB
- 分别设置不同扫描目录 → 分别扫描 → 各自 tracks=3 / tracks=2
- 未配置用户扫描被拒（404）
- Web 登录 → `/web/api/stats/tracks/albums/artists` 各自只见自己的曲目
- 跨租户取流/封面/歌词 → 404
- 同租户取流 → 200
- 跨租户加入歌单 → 400「没有有效曲目」
- 全局 `/admin/api/library/stats` 仍可达
- 未登录 `/web/api/stats` → 401

## 打包
- 产物：`packaging/out/gusi-music-1.0.20-fnos-cn-x86_64.fpk`
- 桌面副本：`C:\Users\Administrator\Desktop\gusi-music-1.0.20-fnos-cn-x86_64.fpk`
- 大小：45.8 MB（48,045,141 bytes），27 entries
- checksum(md5 of app.tgz) = `8fade5ebdef0642f6609d0c2b00e917a`
- node_modules 裁剪：9940 → 229 文件

## 已知限制
1. Admin UI 前端尚未提供租户曲库配置界面；本轮仅落地后端 API，前端可视化可放在 UPGRADE_0021
2. `removeTenant` 只清内存、不删文件（安全默认），需手动清理磁盘请走 admin 硬删端点（尚未实现）
3. 租户 id 空间独立，两个用户可能拿到相同的 trackId；歌词缓存已通过 `trackId|filePath` 复合键隔离，其他调用方（如 playlist 里的 `local_<id>`）也在写入侧就走租户解析，不会跨租户

## 下一步建议
- UPGRADE_0021：Admin UI 加「用户曲库」面板（列用户 → 选目录 → 扫描 → 查看 stats），复用 admin SPA 的 modal/form 风格
- 若需要硬删租户磁盘，加 `DELETE /admin/api/library/user/:name?purge=1`（清理 `data/libraries/<safeUser>/` 目录）
