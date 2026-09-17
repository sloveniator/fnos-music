#!/usr/bin/env node
/**
 * LXM Cloud — fpk 打包脚本
 * 产出：<name>-<version>-fnos-<arch>.fpk（gzip 压缩的 tar，格式逆向自道理鱼 fpk）
 *
 * 用法：node packaging/build-fpk.js
 * 前置：server 已构建（server/server/index.js），UI 就绪（ui/dist）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'packaging', 'out')
const STAGE = path.join(OUT_DIR, 'stage')

// ---------------------------------------------------------------------------

const pkg = {
  appname: 'gusi.music',
  display_name: '古四音乐',
  desc: '基于洛雪音乐的私有云音乐中心：NAS 曲库在线播放、Web 在线音乐搜索（内置源，NAS 中转）、多端歌单同步、Web 消费者应用与管理后台，配合洛雪音乐移动版使用。',
  changelog: '歌词时间轴对齐修复（0034→0035）：修掉「歌词和播放进程没对齐」的真因 —— 客户端解析 LRC 时间标签时单位串了：分钟×60 + 秒 算出来是**秒**，却把小数部分再 ×1000 当**毫秒**加了进去，于是 [00:12.50] 被解析成 512 秒。带小数的时间标签是绝大多数 LRC 的常态，所以整篇歌词的假时间被放大上千倍；更糟的是随后按这个假时间排序，把歌词整体打乱（实测 [00:12.50] 的第一句排到了 [01:02.00] 的第三句后面，[00:15.35] 排到了 6 分钟后），表现就是「高亮乱跳、和进度条对不上」。现在按「分钟×60 + 秒 + 小数补足三位/1000」算秒，与服务端写内嵌歌词那份 parseLrc（分钟×60000 + 秒×1000 + 毫秒）同一口径。连带修掉两处同类错位：(1) 歌词页关着时只记行号不写 DOM，重新打开时屏幕上是上次关页那一刻的旧高亮 —— 而手机上点底栏进歌词页正是最常走的路；现在打开第一帧强制重新对齐，并给相邻行以上/反向的跳转直接落位，另外把绕过统一入口直接 hidden=false 的那条手机路径收回 togglePlayPage。(2) 换行滚动不再用 scrollIntoView（它会连带把页面一起滚，而且 .lf-body 上有 scroll-behavior: smooth，快歌 1~2 秒就换行、容器还在上一段动画里就被下一行叫走，屏中间停的常是上一行）：改为自己算落点，相邻换行平滑、拖进度条或刚打开歌词页这类跳转立即落位（behavior 必须写 instant，写 auto 会回落到 CSS 里的 smooth，等于没改）。顺带：翻译行不再和主行一起被点亮（两者共用 data-i，之前当前行的译文会抢主行的 20px/650 当前行样式，比主行还显眼）。 上一版：全屏进度条可拖 + 冷启动不再误踢登录页（0033→0034）：(1) 修掉「安卓 app 全屏播放，进度条无法滑动」的真因 —— 不是样式而是事件：歌词全屏那条进度轴只挂了 click，点一下能跳、按住拖完全没反应；触摸下更糟，浏览器把手势判给页面滚动，只发两个 pointermove 就补一个 pointercancel（实测计数 pointerdown:1 / pointermove:2 / pointercancel:1），所以连「拖到哪算哪」的错觉都没有。现在三条进度轴（桌面底栏、窄屏贴顶边细线、歌词全屏）共用同一套 pointer 拖动：pointerdown 里 preventDefault + setPointerCapture 把手势从滚动手里扣下来，两条 .seek 轴补上 touch-action: none 防被抢；拖动中只画界面（tick 不回写被拖的轴与时间标签）、松手才落 currentTime，点按照旧能跳，桌面底栏顺带变成实时跟手。(2) 修掉「每次关闭后台再打开，还要输入账号密码」：旧逻辑把「冷启动时 /me 请求失败」和「会话过期」当成一回事（catch 住就 showLogin()），而冷启动那一两秒里请求失败太常见（Wi‑Fi 刚醒、服务端在忙、WebView 刚起来），于是每次打开都可能被踢到登录页。现在只有服务端明确回 401 才算会话过期（api() 顺手清 token 再回登录页），其它错误按 0/400/1000/2200ms 退避重试；重试完还连不上就显示「连不上服务器 + 重试」界面，token 原样留着，网络恢复点重试直接进，不再要求重输密码。 上一版：全部歌曲页密度 + 推荐 35 首 + 后台入口收紧（0032→0033）：(1) 手机端「全部歌曲」页头从三行压回两行 —— 窄屏媒体查询里那条 .btns .btn { width: 100% } 把 5 枚批量按钮各撑成一整行；列表首行上移约 103px、行高 55.7→47.3px、表头 31.5→27.5px、一屏从 7.4 行到 10.9 行，320px 宽不溢出，桌面端布局不变。(2)「今日推荐 / 猜你喜欢」每份目标量提到 35 首（此前 20 / 14）：本地不够就在线补，卡片上直接写总量「35 首（本地 N + 在线 M）」；为避免被在线源限流，同一位歌手的候选一天只抓一次、两份推荐共用同一候选池，单歌手在一份推荐里最多 8 首；口味面很窄（画像里只有两三位歌手）时凑不满就如实少给，不硬凑。(3) 侧栏「管理后台」齿轮入口与设置页那一行只对站长账户显示，其他账户既看不到也点不到。 上一版：进度条修复（0031→0032）：修掉「播放页收起后（手机 / 窄窗口）歌曲进度条点不动也拖不动」的真因 —— 窄屏媒体查询里那条无前缀的 `.seek-row { display: none }` 把歌词全屏页的进度轴（class 里也带 seek-row）一并隐藏了；1.0.31 曾把它误判成「被手势条盖住」，实际不是遮挡而是整条被 display:none。(1) 现在只隐藏底栏那一条，全屏进度轴恢复正常显示；(2) 窄屏把进度线做成 29px 高的透明命中区（视觉线宽仍是 5px，只有拖动中才加粗到 4px + 圆点），按住即定位、拖动跟手、松手才落点，点按 30% 也能跳；(3) 桌面行为完全不变。上一版：安全区修复 + 推荐补量（0030→0031）：(1) 消费者端页面改用安卓壳注入的 --safe-* 安全区变量（此前直接用 env(safe-area-inset-*)，而安卓 WebView 在 Chromium M144 之前恒为 0）—— 修掉「沉浸式下顶栏被状态栏压住、顶部按钮点不到」与「歌词全屏页进度条被手势条盖住」。App 壳无需升级。(2) 「今日推荐 / 猜你喜欢」在本地曲库为空或很小时自动把在线部分补到约 20 / 14 首（此前固定 8 首），本地曲库充足时在线仍只补 8 / 10 首，行为不变。 上一版：密码规范简化 + FM 电台可用性修复（0028→0030）：(1) 账号密码只要求 6 位以上（上限 128 位仅为哈希/传输的工程边界），不再强制「大小写字母 + 数字 + 特殊符号」组合；网页注册、接口注册、后台新建用户/重置密码全部统一。注册页与后台弹窗文案同步改为「至少 6 位」。(2) 管理后台「音源与代理 → 在线音乐源」的勾选项改为从服务端下发，补上此前遗漏的「汽水音乐」—— 之前 FM 提示「汽水音乐源未启用，请先在管理后台开启」，而后台里根本没有汽水开关，用户找不到设置入口（新增 GET /admin/api/library/online-sources）。(3) 后台支持 tab 深链（/admin/#sources 直达音源页）。(4) 消费者端 FM 页在汽水源未启用时给出可点提示条（直链后台音源页），并在开台时重拉一次源清单，后台改完开关无需整页刷新。',
  arch: 'x86_64',
  os_min_version: '1.1.31',
  version: '1.0.35',
  build: '0035',
  service_port: '43000',
  maintainer: '古四',
  maintainer_url: 'https://github.com/lyswhut/lx-music-mobile',
  server_dist: path.join(ROOT, 'server', 'server'),
  // offline/ = 捆绑的 Node linux-x64 运行时（cmd/main 按 md5 stamp 增量解压）
  server_files: ['index.js', 'package.json', 'node_modules', 'config.json', 'server', 'offline'],
  ui_dist: path.join(ROOT, 'ui', 'dist'),
}

// ---------------------------------------------------------------------------

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true })

/** 递归收集文件（相对路径 + 绝对路径） */
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(dirent => {
  const full = path.join(dir, dirent.name)
  return dirent.isDirectory()
    ? walk(full, base)
    : [{ rel: path.relative(base, full), abs: full }]
})

/** 递归统计目录内文件数（缺失目录返回 0） */
const countFiles = (dir) => {
  if (!fs.existsSync(dir)) return 0
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const de of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, de.name)
      if (de.isDirectory()) stack.push(f)
      else n++
    }
  }
  return n
}

/** Unix 文件内容（统一 \n） */
const unix = (s) => s.replace(/\r\n/g, '\n')

/**
 * 权限与软链接规整。
 *
 * 为什么必须做：本仓库工作区（共享卷）创建文件时强制 rwxrwxrwx，chmod 显式调用才生效，
 * 于是打包出的 fpk 曾出现「28 条目全 0777 / app.tgz 内 125 个目录全 0777」，
 * 而飞牛官方打包器（fnpack 1.2.3）产物从无世界可写条目（目录 0755、文件 0644、
 * config/resource 600）—— 这是与官方产物的唯一实质差异，也是安装时报
 * 「解压tgz失败」时第一个要排除的项。
 *
 * 同时剔除指向打包机绝对路径的软链接（npm 在本工作区生成的 node_modules/.bin
 * 指向 /app/working/... 构建目录，装到 NAS 上是悬空链接，且泄漏构建路径）。
 */
function normalizeTree(dir, opts = {}) {
  const dirMode = opts.dirMode ?? 0o755
  const fileMode = opts.fileMode ?? 0o644
  const execPrefixes = opts.execPrefixes ?? [] // 需要保留可执行位的相对路径前缀
  const stats = { dirs: 0, files: 0, execs: 0, droppedLinks: [] }

  const walkAndFix = (d) => {
    for (const de of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, de.name)
      if (de.isSymbolicLink()) {
        const target = fs.readlinkSync(p)
        if (path.isAbsolute(target)) {
          fs.unlinkSync(p)
          stats.droppedLinks.push({ path: path.relative(dir, p), target })
        }
        continue
      }
      if (de.isDirectory()) {
        fs.chmodSync(p, dirMode)
        stats.dirs++
        walkAndFix(p)
        continue
      }
      if (de.isFile()) {
        const rel = path.relative(dir, p)
        const keepExec = execPrefixes.some(pre => rel === pre || rel.startsWith(pre + '/'))
        fs.chmodSync(p, keepExec ? 0o755 : fileMode)
        keepExec ? stats.execs++ : stats.files++
      }
    }
    fs.chmodSync(d, dirMode)
  }

  walkAndFix(dir)
  return stats
}

// ---------------------------------------------------------------------------

function writeManifest(dir) {
  const m = [
    `appname               = ${pkg.appname}`,
    'micro_app             = true',
    `version               = ${pkg.version}`,
    `display_name          = ${pkg.display_name}`,
    `desc                  = ${pkg.desc}`,
    `changelog             = ${pkg.changelog}`,
    `arch                  = ${pkg.arch}`,
    'platform              = x86',
    'source                = thirdparty',
    `os_min_version        = ${pkg.os_min_version}`,
    `maintainer            = ${pkg.maintainer}`,
    `maintainer_url        = ${pkg.maintainer_url}`,
    `distributor           = ${pkg.maintainer}`,
    `distributor_url       = ${pkg.maintainer_url}`,
    'desktop_uidir         = ui',
    'desktop_applaunchname = ' + pkg.appname + '.main',
    `service_port          = ${pkg.service_port}`,
    'checkport             = false',
  ]
  fs.writeFileSync(path.join(dir, 'manifest'), m.join('\n') + '\n')
}

function writeLicense(dir) {
  const src = path.join(ROOT, 'server', 'LICENSE')
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dir, 'LICENSE'))
    return
  }
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'Apache-2.0\n')
}

function writeIcons(dir) {
  // 若项目提供了图标则使用；否则生成占位图标（fnOS 要求存在 ICON.PNG / ICON_256.PNG）
  const icon256 = path.join(ROOT, 'build', 'ICON_256.PNG')
  const icon = path.join(ROOT, 'build', 'ICON.PNG')
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(dir, 'ICON.PNG'))
  else fs.copyFileSync(icon256, path.join(dir, 'ICON.PNG')) // 退化：同图
  fs.copyFileSync(icon256, path.join(dir, 'ICON_256.PNG'))
}

function copyCmd(dir) {
  const src = path.join(ROOT, 'build', 'cmd')
  for (const f of walk(src)) {
    const target = path.join(dir, 'cmd', f.rel)
    ensureDir(path.dirname(target))
    fs.writeFileSync(target, unix(fs.readFileSync(f.abs, 'utf8')), { mode: 0o755 })
  }
}

function copyConfig(dir) {
  const src = path.join(ROOT, 'build', 'config')
  for (const f of walk(src)) {
    const target = path.join(dir, 'config', f.rel)
    ensureDir(path.dirname(target))
    fs.writeFileSync(target, unix(fs.readFileSync(f.abs, 'utf8')), { mode: 0o755 })
  }
}

function copyWizard(dir) {
  const src = path.join(ROOT, 'build', 'wizard')
  for (const f of walk(src)) {
    const target = path.join(dir, 'wizard', f.rel)
    ensureDir(path.dirname(target))
    fs.writeFileSync(target, unix(fs.readFileSync(f.abs, 'utf8')), { mode: 0o644 })
  }
}

/** 组装 app.tgz：server/ + ui/ + config/（与道理鱼一致：成员无 ./ 前缀，config 在包内冗余一份） */
function buildAppTgz(dir) {
  const appDir = path.join(dir, '_app')
  rmrf(appDir)
  ensureDir(path.join(appDir, 'ui'))

  // server 运行时
  ensureDir(path.join(appDir, 'server'))
  for (const name of pkg.server_files) {
    const src = path.join(pkg.server_dist, '..', name)
    if (!fs.existsSync(src)) throw new Error(`缺少 server 构件: ${src}（先在 server/ 下 npm run build）`)
    fs.cpSync(src, path.join(appDir, 'server', name), { recursive: true })
  }
  // 剔除 Windows 平台原生模块（.node 为 Windows 编译产物，Linux 上不可用；
  // ws 对 bufferutil/utf-8-validate 缺失是 fail-soft，仅损失少量性能）
  const nm = path.join(appDir, 'server', 'node_modules')
  for (const nativeMod of ['bufferutil', 'utf-8-validate']) {
    rmrf(path.join(nm, nativeMod))
  }
  // 瘦身：devDependencies（typescript/eslint/ts-node/nodemon 等）只服务编译，
  // 不应进入最终 app。注意这里作用在 cpSync 出的 app 副本（上一行循环把原始 server/
  // node_modules 拷进了 appDir），因此绝不污染开发树。npm prune --omit=dev 官方保证
  // 只移除 devDeps 专享包、保留与运行时共享的传递依赖，不会破坏运行逻辑。
  // prune 失败仅告警、不阻断打包（瘦身属优化而非必需）。
  {
    const appServerDir = path.join(appDir, 'server') // 含 node_modules 与 package.json
    const before = countFiles(nm)
    try {
      execSync('npm prune --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: appServerDir, stdio: 'pipe' })
    } catch (e) {
      console.warn(`  [warn] 生产依赖裁剪失败（保留完整 node_modules）: ${(e && e.message) || e}`)
    }
    const after = countFiles(nm)
    if (after < before) console.log(`  node_modules: ${before} -> ${after} 文件（剪切 ${before - after} 个开发/编译依赖)`)
  }

  // 发行元数据（对齐道理鱼 server/distribution.json）
  fs.writeFileSync(path.join(appDir, 'server', 'distribution.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'gusi-music',
    packageFormat: 'fpk',
    platform: 'fnos',
    region: 'cn',
    updatePlatform: 'fnos-cn',
    version: pkg.version,
    packageVersion: pkg.version,
    packageBuild: pkg.version,
    serviceRunAs: 'package',
    channel: 'stable',
    architecture: pkg.arch,
  }, null, 2) + '\n')

  // Web UI（管理后台 ui/dist + 消费者应用 ui/app）
  if (!fs.existsSync(pkg.ui_dist)) throw new Error(`缺少 UI 构件: ${pkg.ui_dist}`)
  fs.cpSync(pkg.ui_dist, path.join(appDir, 'ui', 'dist'), { recursive: true })
  const uiApp = path.join(ROOT, 'ui', 'app')
  if (!fs.existsSync(uiApp)) throw new Error(`缺少消费者端构件: ${uiApp}`)
  fs.cpSync(uiApp, path.join(appDir, 'ui', 'app'), { recursive: true })
  // 分享页构件（ui/share/share.js|css）：shareStaticDir() 解析到 ui/app 的同级 share/，
  // 漏拷会让 /s/assets/* 在安装后全部 404（页面能开、样式与播放器全废）
  const uiShare = path.join(ROOT, 'ui', 'share')
  if (!fs.existsSync(uiShare)) throw new Error(`缺少分享页构件: ${uiShare}`)
  fs.cpSync(uiShare, path.join(appDir, 'ui', 'share'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'ui', 'README.txt'), 'Place frontend build output here (from frontend/dist).\n')

  // 桌面入口图标资源（ui/config 的 icon 字段引用 images/icon_{0}.png，对齐道理鱼命名）
  ensureDir(path.join(appDir, 'ui', 'images'))
  fs.copyFileSync(path.join(ROOT, 'build', 'ICON_256.PNG'), path.join(appDir, 'ui', 'images', 'icon_256.png'))
  fs.copyFileSync(path.join(ROOT, 'build', 'ICON.PNG'), path.join(appDir, 'ui', 'images', 'icon_64.png'))

  // 桌面入口配置：必须用 type=iframe + url=网关前缀（觅音实测格式）。
  // type=url+port 会让控制台开直连端口新标签，远程访问（fnConnect/反代）时端口不通=打不开；
  // iframe 走控制台同源 /app/ 网关 → trim_http_cgi → app.sock，本地远程通吃。
  const uiConfig = {
    '.url': {
      [pkg.appname + '.main']: {
        title: pkg.display_name,
        icon: 'images/icon_{0}.png',
        type: 'iframe',
        protocol: '',
        gatewayPrefix: '/app/gusi-music',
        gatewaySocket: 'app.sock',
        url: '/app/gusi-music',
        allUsers: true,
      },
    },
  }
  fs.writeFileSync(path.join(appDir, 'ui', 'config'), JSON.stringify(uiConfig, null, 2))

  // config 副本（道理鱼在 app.tgz 内同样冗余一份 privilege/resource）
  fs.cpSync(path.join(dir, 'config'), path.join(appDir, 'config'), { recursive: true })

  // 权限/软链接规整（原因见 normalizeTree 注释）：载荷内无文件需要可执行位
  // （服务端 start = node ./index.js，不 spawn 包内可执行文件；捆绑 Node 由 runtime_bootstrap.sh 自行 chmod +x）
  const fixed = normalizeTree(appDir, { dirMode: 0o755, fileMode: 0o644 })
  if (fixed.droppedLinks.length > 0) {
    console.log(`  剔除 ${fixed.droppedLinks.length} 个指向打包机的绝对软链接：${fixed.droppedLinks.map(x => x.path).join(', ')}`)
  }

  const cwd = dir
  // --mode 兜底：即便某些环境 chmod 不生效，也不让世界可写位进包
  execSync("tar --mode='a-st,go-w' -czf app.tgz server ui config", { cwd: appDir })
  fs.cpSync(path.join(appDir, 'app.tgz'), path.join(cwd, 'app.tgz'))
  rmrf(appDir)
  return path.join(cwd, 'app.tgz')
}

// ---------------------------------------------------------------------------

/**
 * 交付前合规审计：世界可写位、指向打包机的绝对软链接、绝对/穿越条目名、manifest 校验和。
 * 任一不通过就中断打包（宁可不交付，也不交付装不上的包）。
 */
function auditFpk(fpkPath, appTgzMd5) {
  const name = path.basename(fpkPath)
  const sh = (cmd) => execSync(cmd, { cwd: OUT_DIR, encoding: 'utf8' })
  const rows = (s) => s.trim().split('\n').filter(Boolean)

  const outer = rows(sh(`tar -tvzf "${name}"`))
  const inner = rows(sh(`tar -xzOf "${name}" app.tgz | tar -tvzf -`))
  const outerNames = rows(sh(`tar -tzf "${name}"`))
  const innerNames = rows(sh(`tar -xzOf "${name}" app.tgz | tar -tzf -`))

  const worldWritable = (rs) => rs.filter(r => !r.startsWith('l') && r.length > 9 && (r[5] === 'w' || r[8] === 'w'))
  const absLinks = (rs) => rs.filter(r => / -> \//.test(r))
  const illegalName = (ns) => ns.filter(n => n.startsWith('/') || n.split('/').includes('..'))

  const problems = []
  const outerWW = worldWritable(outer)
  const innerWW = worldWritable(inner)
  const links = absLinks(inner)
  const badOuter = illegalName(outerNames)
  const badInner = illegalName(innerNames)
  const declared = (sh(`tar -xzOf "${name}" manifest`).match(/^checksum\s*=\s*(\w+)/m) || [])[1]

  if (outerWW.length) problems.push(`外壳存在世界可写条目 ${outerWW.length} 个，如 ${outerWW[0]}`)
  if (innerWW.length) problems.push(`app.tgz 内存在世界可写条目 ${innerWW.length} 个，如 ${innerWW[0]}`)
  if (links.length) problems.push(`app.tgz 内含指向打包机的绝对软链接 ${links.length} 个，如 ${links[0]}`)
  if (badOuter.length) problems.push(`外壳条目名非法（绝对/穿越）：${badOuter[0]}`)
  if (badInner.length) problems.push(`app.tgz 条目名非法（绝对/穿越）：${badInner[0]}`)
  if (!outerNames.includes('app.tgz') || !outerNames.includes('manifest')) problems.push('外壳缺少 app.tgz 或 manifest')
  if (declared !== appTgzMd5) problems.push(`manifest checksum 与 app.tgz 实测 md5 不一致：${declared} ≠ ${appTgzMd5}`)

  console.log(`  合规审计：外壳 ${outer.length} 条目 / app.tgz ${inner.length} 条目；` +
    `世界可写 ${outerWW.length + innerWW.length}；绝对软链接 ${links.length}；` +
    `校验和${declared === appTgzMd5 ? '一致' : '不一致'}`)
  if (problems.length) throw new Error('包体合规审计未通过：\n  - ' + problems.join('\n  - '))
}

function main() {
  // 不清整个 OUT_DIR（历史交付包可能被系统句柄锁定），只重建 stage，产物文件名含版本号天然不冲突
  rmrf(STAGE)
  ensureDir(OUT_DIR)
  ensureDir(STAGE)

  console.log('[1/5] 组装包体...')
  writeManifest(STAGE)
  writeLicense(STAGE)
  writeIcons(STAGE)
  copyCmd(STAGE)
  copyConfig(STAGE)
  copyWizard(STAGE)

  console.log('[2/5] 打包 app.tgz...')
  const appTgz = buildAppTgz(STAGE)

  console.log('[3/5] 计算 checksum...')
  const md5 = crypto.createHash('md5').update(fs.readFileSync(appTgz)).digest('hex')
  const manifestPath = path.join(STAGE, 'manifest')
  fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8') + `checksum              = ${md5}\n`)

  console.log('[4/5] tar.gz 外壳...')
  const fpkName = `gusi-music-${pkg.version}-fnos-cn-${pkg.arch}.fpk`
  const fpkPath = path.join(OUT_DIR, fpkName)
  // 条目顺序对齐道理鱼：app.tgz LICENSE cmd config ICON* manifest wizard
  // 外壳同样规整权限（官方产物：目录 0755 / 文件 0644，cmd 脚本保留可执行位）
  normalizeTree(STAGE, { dirMode: 0o755, fileMode: 0o644, execPrefixes: ['cmd'] })
  execSync("tar --mode='a-st,go-w' -czf ../out.fpk app.tgz LICENSE cmd config ICON.PNG ICON_256.PNG manifest wizard", { cwd: STAGE })
  fs.renameSync(path.join(OUT_DIR, 'out.fpk'), fpkPath)

  console.log('[5/5] 校验...')
  const size = fs.statSync(fpkPath).size
  // Windows GNU tar 把 "F:\..." 当作远程主机，用 -C 进入目录 + 相对路径规避
  const verify = execSync(`tar -tzf "${fpkName}"`, { cwd: OUT_DIR }).toString().trim().split('\n')
  console.log(`  ${fpkName}`)
  console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB, ${verify.length} entries`)
  console.log(`  checksum(md5 of app.tgz) = ${md5}`)
  auditFpk(fpkPath, md5)
  console.log('DONE → ' + fpkPath)
}

main()
