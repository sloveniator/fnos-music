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
   前者接受 `toggle|play|pause|next|prev|seek`，后者返回是否有浮层被关掉。
4. `--safe-top` / `--safe-bottom` / `--safe-left` / `--safe-right` —— 壳内联写到
   `<html>` 上的安全区（CSS px）。Web 端 `app.css` 的 `:root` 里默认取
   `env(safe-area-inset-*)`，**被壳覆写后以壳为准**，所以新写的布局请用
   `var(--safe-*)` 而不是直接写 `env()`。

> 这四样一旦改名/删掉，App 不会崩，只会「通知栏不动了 / 返回键行为不对了 / 顶栏被时钟压住」——
> 属于静默失效，改 Web 端底栏和安全区时请留心。

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
│   └── CookieStore.kt       # 拉封面时复用 WebView 的 cookie
├── app/src/test/java/com/gusi/music/*.kt   # 75 个纯逻辑单测（见第 3 节）
└── tools/make-icons.py      # 从 packaging/assets 生成各密度启动图（幂等）
```

## 3. 构建

环境（本机已就位）：JDK 17、Android SDK 34（`/opt/android-sdk`）、Gradle 8.7（`/opt/gradle-8.7`）。
`app/build.gradle.kts`：AGP 8.5.2 / Kotlin 1.9.24 / compileSdk 34 / minSdk 24 / targetSdk 34。

```sh
sh tools/build-android.sh            # 等价于：单测 + debug + release（release 无密钥时出未签名包）
sh tools/build-android.sh test       # 只跑单测（75 个纯逻辑用例，秒级）
sh tools/build-android.sh lint       # lint 报告 → app/build/reports/lint-results-debug.html
sh tools/build-android.sh debug      # 只出 debug 包（可直接装手机，debug 密钥签名）
python3 tools/e2e-safe-area.py       # 安全区注入 → Web 布局让开（真实 Chromium，18 项断言）
```

`tools/e2e-safe-area.py` 补的是「壳注入安全区」这一层：容器里装不了真机，但把与
`Insets.js` 逐字符相同的脚本注入真实 Chromium，就能量出顶栏是否让开状态栏、底栏是否
抬离手势条、横屏刘海左右是否留白，以及**注入 0 时与不注入完全一致**（防止与 `env()` 双算）。
它需要实例在 20059 跑着，并且要 `GS_ADMIN_PASSWORD`（清临时账号用）。

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

版本号规则：**已与服务端/安装包版本对齐 —— `versionCode 27` / `versionName 1.0.27`**。
每次要发新包，把 `app/build.gradle.kts` 里的 `versionCode` +1（否则系统认为「没变化」，
同包名装不上去），`versionName` 同步改。debug 变体自动带 `-debug` 后缀、包名 `.debug`，可与正式版共存。

## 5. 真机自测清单

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

## 6. 已知 lint 警告（有意保留，不是漏改）

`lintDebug` 目前 **0 Error / 10 Warning**。剩下这些是刻意的：

| 警告 | 为什么保留 |
|---|---|
| `WebViewClientOnReceivedSslError`、`AcceptsUserCertificates` | 自建 NAS 常用自签证书。壳不静默放行，而是弹框把选择权交给用户（`MainActivity.onReceivedSslError`） |
| `InsecureBaseConfiguration` | 局域网明文 HTTP 是主场景，不可能有公网证书 |

已修掉的（曾经是 23 个问题，含 7 个 Error）：`NewApi`（`NotificationChannel` 在 minSdk 24
上没做版本守卫，Android 7 会崩）、`WakelockTimeout`（WakeLock 改成 10 分钟租期 + 播放中续租）、
`ObsoleteSdkInt`、`UnusedResources`、`Autofill`、`MonochromeLauncherIcon`。

剩余两个**无法通过 lint 结论**的项，属于美术资源：`Overdraw`（壳的背景与主题背景重了一笔）、
`IconLauncherShape`（启动图四角填满，Material 建议留白）。想改需要重画图标，功能无影响。

## 7. 与 Web 端一起改的注意事项

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
