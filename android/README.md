# 古四音乐 · Android 客户端

把 NAS 上已经跑着的那套 Web 应用（`ui/app`）装进一个原生壳里，并补齐 WebView
自己给不了的能力：后台播放保活、通知栏/锁屏/耳机线控控制、系统下载、外部存储落盘。

包名 `com.gusi.music`（debug 变体是 `com.gusi.music.debug`，可与正式版共存）。

---

## 1. 设计取舍：为什么是「WebView 壳」而不是原生重写

| 选择 | 理由 |
|---|---|
| 界面不重写，直接加载 NAS 上的 Web UI | 手机上的界面就是 Web 那套。**改 Web 即改 App**，不存在两套 UI 需要同步 |
| 壳只注入脚本、不改 Web 端代码 | Web 端可以继续独立演进，壳不会因为一次前端重构就编译不过 |
| 播放状态只有一个真相（Web 端 `window.__player`） | 通知栏按钮不另造一套播放器，只调 Web 端同一个播放器对象的方法 |
| 服务器地址由用户填，不内置 | 每台 NAS 的地址/端口/网关前缀都不一样（fnOS 应用中心可能带 `/app/gusi-music` 前缀） |

### 壳与 Web 端的契约（Web 端改动时别破坏这三样）

1. `window.__player` —— 播放器对象，壳调用它的 `toggle()` / `next(false)` / `prev()`，
   以及 `player.audio`（`paused` / `currentTime` / `duration`）。
2. `#np-name` / `#np-singer` / `#np-cover` —— 底栏正在播放的曲目信息（壳读 `textContent` 与 `src`）。
3. `window.__gusiCmd(cmd, arg)` 与 `window.__gusiEscape()` —— 壳注入的入口；
   前者接受 `toggle|play|pause|next|prev|seek|playlist`（`playlist` 是车机点播：
   `arg` 形如 `{i, list}`，`list` 是**服务端原样返回**的曲目对象数组），
   后者返回是否有浮层被关掉。
4. `--safe-top` / `--safe-bottom` / `--safe-left` / `--safe-right` —— 壳内联写到
   `<html>` 上的安全区（CSS px）。Web 端 `app.css` 的 `:root` 里默认取
   `env(safe-area-inset-*)`，**被壳覆写后以壳为准**，所以新写的布局请用
   `var(--safe-*)` 而不是直接写 `env()`。
5. `localStorage['gusi-web-token']` —— 登录令牌。壳轮询它并推给原生（`GusiBridge.setToken`），
   车机取曲库时带 `X-Web-Token`；登出会推空串。

> 这五样一旦改名/删掉，App 不会崩，只会「通知栏不动了 / 返回键行为不对了 / 顶栏被时钟压住 /
> 车机曲库空着」—— 属于静默失效，改 Web 端底栏、安全区和登录态时请留心。
>
> 另外：底栏 `#np-name` / `#np-singer` 在**没放过任何曲目**时是占位符「—」。
> 壳只能靠「title 为空」判断「没在放歌」，占位符不是空字符串 —— 所以壳侧的 `state()`
> 会等 `window.__player.cur` 有值才上报，否则通知栏会挂一个标题是「—」的空壳通知。

### 数据流

```
WebView(ui/app)  --window.GusiBridge.setState(json)-->  JsBridge  -->  PlaybackService
                                                                        |  前台服务 + MediaSession
                                                                        |  + 通知栏/锁屏控制条
通知栏/锁屏/耳机按键  --MediaSessionCompat.Callback-->  BridgeHolder  -->  web.evaluateJavascript
                                                                          window.__gusiCmd(...)
```

## 2. 目录

```
android/
├── app/src/main/java/com/gusi/music/
│   ├── MainActivity.kt      # WebView 宿主：加载页面、返回键语义、SSL 询问、下载拦截、桥注册、系统栏/安全区
│   ├── GusiApp.kt           # 进程启动：夜间模式恒为深色（必须在 Application 里设，见文件注释）
│   ├── Insets.kt            # WindowInsets → CSS px，生成注入 --safe-* 的脚本（纯 JDK，可单测）
│   ├── SetupActivity.kt     # 首次配置：填服务器地址 + 连通性探测
│   ├── ServerAddress.kt     # 地址规范化/相对地址解析（纯 JDK，可单测）
│   ├── Prefs.kt             # 只存服务器地址；登录态归 WebView 的 localStorage
│   ├── BridgeScript.kt      # 注入到页面的 JS（状态采集 + 指令入口 + 浮层关闭）
│   ├── JsBridge.kt          # Web → 原生（含 BridgeHolder：原生 → Web 的指令通道）
│   ├── PlaybackService.kt   # 前台服务 + MediaSession + 通知栏 + WakeLock + 封面拉取
│   ├── Transport.kt         # 播放状态 → MediaSession（进度条/±30 秒），纯逻辑可单测
│   ├── PlaybackMemory.kt    # 续播位置记忆（每设备每曲一条）
│   ├── Tsv.kt               # PlaybackMemory 的落盘格式（可单测）
│   ├── MediaKey.kt          # 「哪首歌算同一首」的归一化（本地文件 ↔ 远端 id 对齐）
│   ├── MediaSource.kt       # 播放来源抽象（远端 URL / 本地回环）
│   ├── UriMediaSource.kt    # 走 content:// 的本地文件源
│   ├── LocalIndex.kt        # 扫描已下载曲目，建「曲目 → 本地文件」索引
│   ├── LocalMediaServer.kt  # 本地回环 HTTP 服务（WebView 不能直接吃 content://）
│   ├── LocalPlayback.kt     # 把命中本地文件的曲目接进播放链路
│   ├── AudioSniff.kt        # 音频嗅探（识别 Web 端给的曲目、避开广告/提示音）
│   ├── DownloadHelper.kt    # DownloadManager 接管下载，解析 filename*=UTF-8'' 中文名
│   ├── CookieStore.kt       # 拉封面时复用 WebView 的 cookie
│   ├── CarLibrary.kt        # 车机曲库树与播放计划（纯逻辑，可单测）
│   ├── CarSource.kt         # 车机取数层：带登录令牌取 /web/api/*、内存缓存、失败退化
│   ├── CarMediaService.kt   # 车机浏览入口（MediaBrowserServiceCompat 协议翻译）
│   └── WebSession.kt        # WebView localStorage 里的登录令牌（车机取曲库要用）
├── app/src/test/java/com/gusi/music/*.kt   # 104 个纯逻辑单测（见第 3 节）
└── tools/make-icons.py      # 从 packaging/assets 生成各密度启动图（幂等）
```

## 3. 构建

环境（本机已就位）：JDK 17、Android SDK 34（`/opt/android-sdk`）、Gradle 8.7（`/opt/gradle-8.7`）。
`app/build.gradle.kts`：AGP 8.5.2 / Kotlin 1.9.24 / compileSdk 34 / minSdk 24 / targetSdk 34。

```sh
sh tools/build-android.sh            # 等价于：单测 + debug + release（release 无密钥时出未签名包）
sh tools/build-android.sh test       # 只跑单测（104 个纯逻辑用例，秒级）
sh tools/build-android.sh lint       # lint 报告 → app/build/reports/lint-results-debug.html
sh tools/build-android.sh debug      # 只出 debug 包（可直接装手机，debug 密钥签名）
python3 tools/e2e-safe-area.py       # 安全区注入 → Web 布局让开（真实 Chromium，18 项断言）
python3 tools/e2e-car.py             # 车机桥接（真实 Chromium，15 项断言，见第 5 节）
```

单测跑在 JVM 上，而 android.jar 里的 `org.json` 只是返回默认值的桩 —— 所以
`app/build.gradle.kts` 额外给测试配了一份真的 `org.json`，否则 `CarLibrary` 的 JSON
解析在单测里会「静默解析出空曲库」，测试全绿却什么都没验证。

`tools/e2e-safe-area.py` 补的是「壳注入安全区」这一层：容器里装不了真机，但把与
`Insets.js` 逐字符相同的脚本注入真实 Chromium，就能量出顶栏是否让开状态栏、底栏是否
抬离手势条、横屏刘海左右是否留白，以及**注入 0 时与不注入完全一致**（防止与 `env()` 双算）。
它需要实例在 20059 跑着，并且要 `GS_ADMIN_PASSWORD`（清临时账号用）。

`tools/e2e-car.py` 补的是「车机桥接」这一层，注入的脚本是**直接从 `BridgeScript.kt` 里抠出来的**
（不是另抄一份），所以它挂了就等于壳里那份挂了。它验四件事：登录令牌会推给原生、
`__gusiCmd('playlist', {i, list})` 能带着后端原样返回的队列从正确的下标开始放（越界会夹住、
空队列不假装在播）、点播后原生确实收到播放状态、全程无 JS 报错。
它抓出过一个真 bug：底栏占位符「—」被当成曲名推给原生，通知栏会挂一个标题是「—」的空壳。

产物：

| 文件 | 说明 |
|---|---|
| `app/build/outputs/apk/debug/app-debug.apk` | debug 密钥签名，**可以直接装机**；applicationId 带 `.debug` 后缀，可与正式版共存 |
| `app/build/outputs/apk/release/app-release-unsigned.apk` | 未签名，**不能直接安装**；配好签名密钥后 `sh tools/build-android.sh release` 会产出已签名包 |

> 直接 `./gradlew` 会去 `services.gradle.org` 下载 Gradle 发行版（约 130MB）。
> 构建脚本默认用本机已有的 `/opt/gradle-8.7/bin/gradle`，需要时用 `GRADLE_BIN=` 覆盖。

## 4. 签名（发布前必读）

密钥**已生成**（2026-09-16，本地 `android/keystore/`，**不入 git**）：

| 项 | 值 |
|---|---|
| 库文件 | `android/keystore/gusi-music.jks`（PKCS12，RSA 2048，0600） |
| 别名 | `gusi` |
| 主题 | `CN=Gusi Music, OU=fnos-music, O=gusi-music, L=Beijing, C=CN` |
| 有效期 | 2026-09-16 → 2054-02-01（10000 天） |
| 证书 SHA-256 | `38:16:0F:48:A7:45:DC:71:10:32:BB:A1:78:9C:47:AF:79:42:20:CF:84:C5:8D:39:E4:ED:A0:94:63:38:56:C7` |
| 口令 | 在 `android/keystore/keystore.properties`（0600），由主人单独备份 |

复现命令（同参数重签可校验指纹；**别覆盖已生效的库文件**）：

```sh
mkdir -p android/keystore && cd android/keystore
keytool -genkeypair -v -keystore gusi-music.jks -alias gusi -keyalg RSA -keysize 2048 \
        -validity 10000 -storetype PKCS12
cat > keystore.properties <<'EOF'
storeFile=keystore/gusi-music.jks
storePassword=<你设的库口令>
keyAlias=gusi
keyPassword=<你设的 key 口令>
EOF
```

`android/keystore/` 已被 `.gitignore` 排除（本仓库是公开仓库，口令明文绝不入库）。

**为什么这件事必须认真对待**：同一个包名的 App 只能用**同一把密钥**升级。
密钥或口令丢了，已装机的版本就再也装不上新版本（只能卸载重装，用户数据与登录态一起没）。
所以：`gusi-music.jks` 与 `keystore.properties` 要单独备份（NAS 之外再存一份，例如密码管理器 + 加密压缩包）。

版本号规则：**已与服务端/安装包版本对齐 —— `versionCode 30` / `versionName 1.0.30`**。
每次要发新包，把 `app/build.gradle.kts` 里的 `versionCode` +1（否则系统认为「没变化」，
同包名装不上去），`versionName` 同步改。debug 变体自动带 `-debug` 后缀、包名 `.debug`，可与正式版共存。

## 5. 车机（Android Auto / Android Automotive）

车机不认我们的 Web 界面 —— 它只认 `MediaBrowserService`：车机连上来要一棵可浏览的树，
用户点某一项，我们**转手让手机上的 Web 播放器去放**。出声的始终是同一个播放器，
所以通知栏/锁屏（C2）、续播记忆（C3）、离线本地文件替换（C1）全都照旧生效，
不会冒出第二套播放状态。

| 文件 | 干什么 |
|---|---|
| `CarLibrary.kt` | 纯逻辑：服务端曲目/专辑 JSON → 车机要的树 + 「点某一项从第几首放起」 |
| `CarSource.kt` | 取数层：带登录令牌取 `/web/api/*`、内存缓存、失败退化；IO 走单独线程 |
| `CarMediaService.kt` | 浏览：`MediaBrowserServiceCompat` 的协议翻译（根 / 全部歌曲 / 专辑 / 专辑内曲目） |
| `WebSession.kt` + `BridgeScript` 里的 `pushToken()` | 令牌从 WebView 的 localStorage 推给原生，车机取曲库时带 `X-Web-Token` |
| `PlaybackService.sessionToken()` | 把自己的 `MediaSession` 交给浏览服务（车机据此拿到播放状态、上报点播） |
| `PlaybackService.onPlayFromMediaId` | 点播入口：`CarSource` 出计划 → `__gusiCmd('playlist', {i, list})` 送进 WebView |
| `res/xml/automotive_app_desc.xml` | 声明本应用在车机上提供「媒体」能力 |

清单里缺一条车机就不列我们：

```xml
<service android:name=".CarMediaService" android:exported="true">
    <intent-filter><action android:name="android.media.browse.MediaBrowserService" /></intent-filter>
</service>
<meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc" />
```

**没上架 Google Play 的包（就是我们）还要在手机上手动开一次开关**，否则车机的媒体列表里
根本没有这个应用（这是 Google 的现行策略，且会随 Android Auto 版本变动）：

1. 设置 → 应用 → Android Auto → 应用内「附加设置」→ 最下面「版本和权限信息」连点 10 次 → 确认；
2. 右上角三点 → 开发者设置 → 最下面打开「未知来源」；
3. 回到 Android Auto 设置 → 「自定义启动器（Customize launcher）」→ 勾上「古四音乐」。

已知限制（都**不打算**在近期改，写在 `CarMediaService` 的类注释里）：

- **不带封面**：车机拿 `MediaDescription` 里的图片 Uri 自己去取图，而封面接口要登录 cookie，车机侧没有；
- **单页 200 首**（服务端单页上限）：不做翻页、不做搜索；
- **不支持车机语音**（「播放某某」）：那要另接 `onPlayFromSearch`；
- **点播时 WebView 不在**（进程刚被重建、页面还没起来）：指令无处可送，表现为「点了没反应」，
  需要先在手机上打开一次应用；
- **还没点过第一首歌之前**，车机侧没有播放会话（方向盘按键不响应）—— 播放会话是 Web 端
  开始播放后才注册的。

## 6. 真机自测清单

**构建级证据不等于运行级证据。** 本项目的开发容器没有 `/dev/kvm`，跑不了模拟器，
下面这些**从没在真机/模拟器上验证过**，第一次装到手机上请逐条走：

- [ ] 首启进配置页，填 `192.168.x.x:20059`，点「测试连接」→ 显示 HTTP 200
- [ ] 进主界面能看到 Web UI，底栏能放歌（外层音频正常出声）
- [ ] 切到后台/锁屏 → 声音继续；通知栏出现控制条，封面/曲名/歌手正确
- [ ] 通知栏「上一首/播放暂停/下一首」三键都能驱动 Web 端播放器
- [ ] 耳机线控（或蓝牙耳机）按键能播放/暂停
- [ ] 通知栏 X（取消）→ 通知消失、服务收摊
- [ ] 暂停后超过 5 分钟 → 通知自动消失（`PAUSE_KEEP_MS`）
- [ ] Web 端「下载到本机」→ 文件出现在系统「下载」目录，中文名 `歌名 - 歌手.mp3` 正确
- [ ] 返回键：先关浮层 → 再退页面 → 连按两次退出
- [ ] 自签 HTTPS 的 NAS：出现证书询问框，「取消」不加载、「仍然继续」才加载
- [ ] 旋转屏幕不重载页面；输入法弹出时底栏不被遮住
- [ ] 申请通知权限被拒绝时：提示语正确、后台播放仍在
- [ ] 沉浸式：顶栏按钮**不被状态栏时钟压住**（刘海/挖孔机尤其明显）
- [ ] 沉浸式：底栏胶囊**不贴进手势条**（全面屏手势导航下应离底约 10px）
- [ ] 横屏：顶栏/底栏左右不被刘海或挖孔压住
- [ ] 深色：状态栏/导航栏图标是浅色；把系统切到浅色模式后**页面不变浅**、底栏不闪白
- [ ] 键盘：点搜索框输入时，输入框与底栏整体抬起，不被键盘盖住
- [ ] **车机**：按第 5 节开好「未知来源」并勾进启动器后，车机媒体列表里出现「古四音乐」
- [ ] **车机**：能展开「全部歌曲 / 专辑 / 专辑内曲目」，标题与「歌手 · 专辑」副标题正确
- [ ] **车机**：点一首歌 → 手机上出声，车机显示曲名，通知栏同时出现（同一份播放状态）
- [ ] **车机**：方向盘上一首/下一首/播放暂停能驱动 Web 端播放器
- [ ] **车机**：在专辑页点第 3 首，放完接第 4 首（队列＝这张专辑，不是全库）
- [ ] **车机**：手机上先退出登录 → 车机曲库显示「请先在手机上打开古四音乐」而不是空白
- [ ] **车机**：什么都不放就启动应用 → **通知栏不该出现标题是「—」的空壳通知**

## 7. 已知 lint 警告（有意保留，不是漏改）

`lintDebug` 目前 **0 Error / 11 Warning**（lint 按「规则 × 命中处」分别计数，所以资源类规则会各记多条）。
剩下这些是刻意的：

| 警告 | 为什么保留 |
|---|---|
| `WebViewClientOnReceivedSslError`、`AcceptsUserCertificates` | 自建 NAS 常用自签证书。壳不静默放行，而是弹框把选择权交给用户（`MainActivity.onReceivedSslError`） |
| `InsecureBaseConfiguration` | 局域网明文 HTTP 是主场景，不可能有公网证书 |
| `ExportedService`（`CarMediaService`） | 车机（Google Play 服务所在进程）必须能跨进程连上来，不导出门禁就进不来；它只读曲库、写不了任何东西 |
| `MissingIntentFilterForMediaSearch`、`MissingOnPlayFromSearch` | 车机语音搜索（「播放某某」）有意不做（第 5 节）。在 `app/build.gradle.kts` 的 `lint {}` 里显式 disable，而不是让它常驻 —— 这样「lint 报 Error」永远等于「真出问题了」 |

已修掉的（曾经是 23 个问题，含 7 个 Error）：`NewApi`（`NotificationChannel` 在 minSdk 24
上没做版本守卫，Android 7 会崩）、`WakelockTimeout`（WakeLock 改成 10 分钟租期 + 播放中续租）、
`ObsoleteSdkInt`、`UnusedResources`、`Autofill`、`MonochromeLauncherIcon`。

剩余两个**无法通过 lint 结论**的项属于美术资源，占 11 条里的 7 条：`Overdraw` 2 条
（`activity_main.xml`、`activity_setup.xml` 各一，壳的背景与主题背景重了一笔）、
`IconLauncherShape` 5 条（5 个 mipmap 密度，启动图四角填满，Material 建议留白）。
想改需要重画图标，功能无影响。

## 8. 与 Web 端一起改的注意事项

- 壳依赖的 DOM/JS 契约见第 1 节，改底栏结构或播放器方法名时同步这三样。
- **安全区一律写 `var(--safe-*)`，不要在 Web 端新写 `env(safe-area-inset-*)`。**
  安卓 WebView 到 Chromium M144 才在非全屏场景上报 `env()`，更老的恒为 0；壳会注入
  `--safe-*` 覆盖它，`env()` 只作为浏览器/PWA 的兜底默认值留在 `:root` 里。
- 沉浸式（内容画到状态栏/导航栏底下）是**壳单方面开的**：`MainActivity` 里
  `setDecorFitsSystemWindows(false)` + 透明系统栏 + 注入安全区。Web 端不需要（也不该）
  自己去猜状态栏高度。
- Web 端新增「页内跳转」不用改壳（`http/https` 一律留在 WebView 内）。
- Web 端要用系统相册/文件选择器（`<input type="file">`）已支持（`onShowFileChooser`）。
- 别在 Web 端用 `target="_blank"` 指望新窗口 —— 非 http(s) 协议才会走系统浏览器。
