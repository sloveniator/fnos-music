// ---------------------------------------------------------------------------
// 分享页 HTML（服务端渲染骨架，交互逻辑在 ui/share/share.js）
//   - 页面无内联脚本：CSP 用 script-src 'self'，JS/CSS 走 /s/assets/*
//   - 头部信息（标题/作者/有效期/提取码/下载）在服务端渲染，客户端 JS 只负责列表与播放
// ---------------------------------------------------------------------------

export const esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// 图标统一用内联 SVG（与主 App 同一套 path）：emoji 字形在缺 emoji 字体的系统上会渲染成豆腐块，
// 分享页是「没有账号的人看到的门面」，不能靠访问者的系统字体赌运气
const ICON: Record<string, string> = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.2 5.4v13.2L19.5 12Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h3.8v14H7Z"/><path d="M13.2 5H17v14h-3.8Z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h2.6v14H7Z"/><path d="M19 5v14L9.6 12Z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14.4 5H17v14h-2.6Z"/><path d="M5 5v14L14.4 12Z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3.6c1.5 0 2.9.8 3.6 2.1l1.5 2.7c.7 1.3 2.1 2.1 3.6 2.1H21"/><path d="M17.5 4.5 21 7l-3.5 2.5"/><path d="M3 17h3.6c1.5 0 2.9-.8 3.6-2.1l1.5-2.7c.7-1.3 2.1-2.1 3.6-2.1H21"/><path d="M17.5 14.5 21 17l-3.5 2.5"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4Z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.8a7.6 7.6 0 0 1 0 10.4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M9 18.5V5.5L21 3.2v13"/><circle cx="6.5" cy="18.5" r="2.8"/><circle cx="18.5" cy="16.2" r="2.8"/></svg>',
}

const BASE_CSS = `<link rel="stylesheet" href="/s/assets/share.css">`

export interface SharePageInfo {
  code: string
  title: string
  subtitle: string
  owner: string
  typeText: string
  /** 可播放曲目数 */
  playable: number
  /** 链接内曲目总数 */
  total: number
  /** 有效期文案（如「7 天后失效」「永久有效」） */
  expireText: string
  hasPassword: boolean
  allowDownload: boolean
  /** og:image 用的绝对/相对地址（无封面时不输出该标签） */
  coverPath: string
}

export const sharePageHtml = (info: SharePageInfo): string => {
  const ogImage = info.coverPath
    ? `<meta property="og:image" content="${esc(info.coverPath)}">`
    : ''
  const desc = `${info.typeText} · ${info.total} 首${info.subtitle ? ' · ' + info.subtitle : ''}`
  const title = info.title || '音乐分享'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#12141b">
<title>${esc(title)} · 古四音乐分享</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="music.playlist">
${ogImage}
<link rel="icon" href="/favicon.ico">
${BASE_CSS}
</head>
<body>
<div id="s-root" data-code="${esc(info.code)}">
  <header class="s-hero">
    <div class="s-hero-art" id="s-art">♪</div>
    <div class="s-hero-txt">
      <div class="s-type">${esc(info.typeText)}</div>
      <h1 class="s-title">${esc(title)}</h1>
      <div class="s-sub">${esc(info.subtitle || '')}</div>
      <div class="s-meta">
        <span>${info.playable} 首可播放${info.total > info.playable ? `（共 ${info.total} 首）` : ''}</span>
        <span class="s-dot">·</span>
        <span>${esc(info.expireText)}</span>
        ${info.hasPassword ? '<span class="s-tag">需要提取码</span>' : ''}
        ${info.allowDownload ? '<span class="s-tag ok">可下载</span>' : '<span class="s-tag">仅在线收听</span>'}
      </div>
      <div class="s-by">来自 ${esc(info.owner)} 的分享</div>
    </div>
  </header>

  <main class="s-main">
    <div class="s-toolbar">
      <button id="s-playall" class="s-btn primary" type="button">${ICON.play}<span>播放全部</span></button>
      <button id="s-shuffle" class="s-btn" type="button">${ICON.shuffle}<span>随机播放</span></button>
      <button id="s-more" class="s-btn ghost" type="button" aria-label="更多">${ICON.more}</button>
    </div>
    <ol id="s-list" class="s-list"><li class="s-loading">正在载入曲目…</li></ol>
  </main>

  <div id="s-gate" class="s-gate" hidden>
    <div class="s-gate-box">
      <h2>需要提取码</h2>
      <p>分享者给这个链接设了提取码，请输入后继续。</p>
      <input id="s-pass" inputmode="text" autocomplete="off" placeholder="提取码">
      <p id="s-gate-msg" class="s-err" hidden></p>
      <div class="s-gate-btns">
        <button id="s-gate-ok" class="s-btn primary" type="button">进入</button>
      </div>
    </div>
  </div>

  <div id="s-bar" class="s-bar" hidden>
    <div class="s-np">
      <div class="s-np-art" id="s-np-art">${ICON.note}</div>
      <div class="s-np-txt"><div class="s-np-name" id="s-np-name">未播放</div><div class="s-np-sub" id="s-np-sub"></div></div>
    </div>
    <div class="s-ctrls">
      <button id="s-prev" class="s-ic" type="button" aria-label="上一首">${ICON.prev}</button>
      <button id="s-toggle" class="s-ic big" type="button" aria-label="播放/暂停">${ICON.play}</button>
      <button id="s-next" class="s-ic" type="button" aria-label="下一首">${ICON.next}</button>
    </div>
    <div class="s-prog">
      <span id="s-cur">0:00</span>
      <div class="s-track" id="s-track"><div class="s-fill" id="s-fill"></div></div>
      <span id="s-dur">0:00</span>
    </div>
    <div class="s-vol">
      <button id="s-mute" class="s-ic" type="button" aria-label="音量">${ICON.vol}</button>
      <input id="s-vol" type="range" min="0" max="100" value="80" aria-label="音量">
    </div>
  </div>

  <div id="s-lyric" class="s-lyric" hidden></div>
  <div id="s-toast" class="s-toast" hidden></div>
</div>
<script src="/s/assets/share.js" defer></script>
</body>
</html>
`
}

export interface ErrorPageInfo {
  status: number
  title: string
  message: string
  hint?: string
}

export const errorPageHtml = (info: ErrorPageInfo): string => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.title)} · 古四音乐分享</title>
<meta name="robots" content="noindex">
${BASE_CSS}
</head>
<body class="s-err-body">
<div class="s-errwrap">
  <div class="s-errcode">${info.status}</div>
  <h1>${esc(info.title)}</h1>
  <p>${esc(info.message)}</p>
  ${info.hint ? `<p class="s-hint">${esc(info.hint)}</p>` : ''}
</div>
</body>
</html>
`
