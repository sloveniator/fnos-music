/* 古四音乐 · 消费者端 */
(function () {
  'use strict'

  // ---------------- 基础 ----------------
  const SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.2 5.4v13.2L19.5 12Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h3.8v14H7Z"/><path d="M13.2 5H17v14h-3.8Z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 20.6s-7.9-5-7.9-10.3A4.5 4.5 0 0 1 12 7.5a4.5 4.5 0 0 1 7.9 2.8c0 5.3-7.9 10.3-7.9 10.3Z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h3.6c1.5 0 2.9.8 3.6 2.1l1.5 2.7c.7 1.3 2.1 2.1 3.6 2.1H21"/><path d="M17.5 4.5 21 7l-3.5 2.5"/><path d="M3 17h3.6c1.5 0 2.9-.8 3.6-2.1l1.5-2.7c.7-1.3 2.1-2.1 3.6-2.1H21"/><path d="M17.5 14.5 21 17l-3.5 2.5"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M9 18.5V5.5L21 3.2v13"/><circle cx="6.5" cy="18.5" r="2.8"/><circle cx="18.5" cy="16.2" r="2.8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.2 7l.9 12c.05.66.6 1.17 1.26 1.17h7.28c.66 0 1.21-.51 1.26-1.17l.9-12"/><path d="M10.3 10.8v6.2"/><path d="M13.7 10.8v6.2"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2v11.4"/><path d="m7.8 7.4 4.2-4.2 4.2 4.2"/><path d="M5.2 13.6v5.4c0 .9.7 1.6 1.6 1.6h10.4c.9 0 1.6-.7 1.6-1.6v-5.4"/></svg>',
  }
  const $ = (s) => document.querySelector(s)
  // 网关前缀自适应：页面部署在 <base>/ 下（'/' → ''；'/app/xxx/' → '/app/xxx'）
  const BASE = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '')
  let token = localStorage.getItem('gusi-web-token') || ''

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  let toastTimer = null
  function toast(msg, isErr) {
    const t = $('#toast')
    t.textContent = msg
    t.hidden = false
    t.style.color = isErr ? 'var(--danger)' : ''
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { t.hidden = true }, 2600)
  }

  function prompt2(title, def, okText) {
    return new Promise((resolve) => {
      const box = $('#dialog')
      $('#dlg-title').textContent = title
      const input = $('#dlg-input')
      input.value = def || ''
      input.hidden = false
      $('#dlg-msg').hidden = true
      $('#dlg-ok').textContent = okText || '确定'
      box.hidden = false
      input.focus()
      input.select()
      const done = (v) => { box.hidden = true; $('#dlg-ok').onclick = $('#dlg-cancel').onclick = null; resolve(v) }
      $('#dlg-ok').onclick = () => done(input.value.trim() || null)
      $('#dlg-cancel').onclick = () => done(null)
    })
  }
  function confirm2(title, msg) {
    return new Promise((resolve) => {
      const box = $('#dialog')
      $('#dlg-title').textContent = title
      $('#dlg-input').hidden = true
      $('#dlg-msg').textContent = msg
      $('#dlg-msg').hidden = false
      $('#dlg-ok').textContent = '确定'
      box.hidden = false
      const done = (v) => { box.hidden = true; $('#dlg-ok').onclick = $('#dlg-cancel').onclick = null; resolve(v) }
      $('#dlg-ok').onclick = () => done(true)
      $('#dlg-cancel').onclick = () => done(false)
    })
  }

  async function api(path, opt) {
    opt = opt || {}
    // 没会话就别发鉴权请求：退出登录后残留的页面渲染不该再往服务端打一串 401
    if (!token && !opt.skipAuth) throw new Error('未登录')
    const headers = {}
    if (token && !opt.skipAuth) headers['X-Web-Token'] = token
    if (opt.body) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + '/web' + path, {
      method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined,
    })
    // 401 只在「这次确实带着 token」时才当会话过期：登录页没有 token，
    // 那里的 401 是业务错误（用户名或密码错误），得把服务端文案原样透出去
    if (res.status === 401 && token && !opt.skipAuth) { logout(); throw new Error('登录已过期') }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.code === -1) throw new Error(data.msg || data.message || ('HTTP ' + res.status))
    return data.data
  }
  const mediaUrl = (kind, id) => BASE + '/web/media/' + kind + '/' + encodeURIComponent(id) + '?k=' + encodeURIComponent(token)

  const fmtDur = (sec) => {
    if (!sec || sec < 0 || !isFinite(sec)) return '0:00'
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
    return m + ':' + String(s).padStart(2, '0')
  }
  const fmtBytes = (b) => {
    b = Number(b) || 0
    if (b < 1024) return b + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }
  const parseInterval = (v) => {
    if (v == null) return 0
    if (typeof v == 'number') return v
    const m = /^(\d+):(\d{1,2})$/.exec(String(v))
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0
  }

  // ---------------- 「我喜欢」收藏 ----------------
  // 一个列表同时装本地曲目与在线曲目，所以「这个 id 长什么样」「怎么切」只在这里定义一次。
  const isOnlineTrack = (t) => !!(t && (t.kind === 'online' || t.online === true))
  /**
   * 曲目 → 服务端「我喜欢」列表里的 MusicInfo id：
   *   本地曲库 local_<trackId>（服务端 trackToMusicInfo）
   *   在线音源 <source>_<rid>（服务端 onlineToMusicInfo，酷我 id 去掉 MUSIC_ 前缀）
   */
  const loveKeyOf = (t) => {
    if (!t) return ''
    if (isOnlineTrack(t)) {
      const rid = t.rid != null && t.rid !== '' ? t.rid : String(t.id || '').replace(/^[A-Za-z][A-Za-z0-9]*_/, '')
      if (!t.source || rid === '') return ''
      return t.source + '_' + String(rid).replace(/^MUSIC_/, '')
    }
    return t.id ? 'local_' + t.id : ''
  }
  const isLoved = (t) => { const k = loveKeyOf(t); return !!k && loveIds.has(k) }
  /** 在线行时长字段名不统一（intervalMs / interval），取值统一定义为毫秒 */
  const loveIntervalMs = (t) => {
    const n = Number(t.intervalMs != null ? t.intervalMs : t.interval)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  }
  /** 切换喜欢；返回切换后的收藏状态（服务端为准，失败时保持原状态） */
  async function toggleLoveOf(t) {
    if (!t) return false
    const k = loveKeyOf(t)
    if (!k) { toast('该曲目无法收藏', true); return false }
    const body = isOnlineTrack(t)
      ? {
        source: t.source, rid: t.rid != null && t.rid !== '' ? t.rid : String(t.id || '').replace(/^[A-Za-z][A-Za-z0-9]*_/, ''),
        name: t.name, singer: t.singer, album: t.album, intervalMs: loveIntervalMs(t), pic: t.pic,
      }
      : { trackId: t.id }
    const d = await api('/api/love/toggle', { method: 'POST', body })
    if (d.loved) loveIds.add(k); else loveIds.delete(k)
    return !!d.loved
  }
  /** 心形按钮：初始态取自 loveIds，点完就地换样式并在「我喜欢」页重绘列表。
   *  target 可以是曲目，也可以是返回曲目的函数——切源下拉会改行内 source/rid，
   *  用函数取「当前行」，心形状态才跟得上。 */
  const loveBtn = (target, cls) => {
    const get = typeof target === 'function' ? target : () => target
    const b = el('button', 'iconbtn love-btn' + (isLoved(get()) ? ' loved' : ''))
    b.innerHTML = SVG.heart
    b.title = isLoved(get()) ? '取消喜欢' : '加入我喜欢'
    b.onclick = async (e) => {
      e.stopPropagation()
      const t = get()
      const before = isLoved(t)
      try {
        const loved = await toggleLoveOf(t)
        b.classList.toggle('loved', loved)
        b.title = loved ? '取消喜欢' : '加入我喜欢'
        toast(loved ? '已加入我喜欢' : '已取消喜欢')
        // 「我喜欢」列表页：移除后必须重绘（否则取消喜欢只是心形变灰，行还赖在那）
        if (location.hash.indexOf('#/playlist/love') === 0 && before && !loved) route()
      } catch (err) { toast(err.message, true) }
    }
    if (cls) b.classList.add(cls)
    return b
  }
  /** 菜单项文案随收藏状态变（菜单是快照，打开那一刻的状态就够用） */
  const loveMenuLabel = (t) => (isLoved(t) ? '取消喜欢' : '加入我喜欢')
  /** 菜单里的收藏动作：切换 + 重绘当前页（列表里心形状态/「我喜欢」页要跟着变） */
  const loveMenuAction = async (t) => {
    try {
      const loved = await toggleLoveOf(t)
      toast(loved ? '已加入我喜欢' : '已取消喜欢')
      route()
      refreshPlaylists()
    } catch (e) { toast(e.message, true) }
  }

  // ---------------- 状态 ----------------
  let me = null
  let loveIds = new Set()
  let playlistsCache = []
  let onlineSourcesCache = [{ id: 'kw', name: '酷我音乐' }]
  const coverCache = new Set() // 已知有封面的 trackId（来自曲库 hasCover）

  // ---------------- 登录 ----------------
  function showLogin() {
    $('#login').hidden = false
    $('#shell').hidden = true
    loadLoginState()
  }
  /** 登录 ⇄ 注册 两个表单互切 */
  function authForm(mode) {
    const reg = mode === 'register'
    $('#login-form').hidden = reg
    $('#register-form').hidden = !reg
    $('#to-login-wrap').hidden = !reg
    if (reg) $('#reg-name').focus()
    else $('#login-name').focus()
  }
  /**
   * 拉取注册开关，决定 UI 分支：
   *   firstRun（还没有任何用户）→ 直接进注册表单，登录无处可登；
   *   registerOpen（默认开放）→ 登录页 + 「立即注册」入口；
   *   都不满足 → 只留登录表单。
   */
  async function loadLoginState() {
    try {
      const d = await api('/login-state', { skipAuth: true })
      const open = !!(d && d.registerOpen)
      const first = !!(d && d.firstRun)
      $('#to-register-wrap').hidden = !open || first
      $('#login-hint').textContent = first ? '首次使用，请先创建账户' : ''
      authForm(open && first ? 'register' : 'login')
    } catch {
      authForm('login')
    }
  }
  $('#to-register').onclick = () => { $('#login-err').textContent = ''; authForm('register') }
  $('#to-login').onclick = () => { $('#reg-err').textContent = ''; authForm('login') }
  /**
   * 登录态相关的全局缓存：喜欢 id 集合 + 在线音源能力表。
   * boot() 与「登录/注册成功」都必须走一遍 —— 只在 boot 里拉的话，首次在登录页
   * 输密码进来的用户拿到的是空 loveIds（boot 没 token 时提前 return，压根没请求），
   * 于是所有心形都显示成未收藏，得刷新一次才对，这是个真 bug。
   */
  async function loadUserState() {
    try {
      const d = await api('/api/love-ids')
      loveIds = new Set(d.ids || [])
    } catch {}
    try {
      const d = await api('/api/online/sources')
      if (d.sources && d.sources.length) onlineSourcesCache = d.sources
    } catch {}
  }
  async function enterApp() {
    $('#login').hidden = true
    $('#shell').hidden = false
    $('#who').textContent = me.name
    await Promise.all([loadUserState(), refreshPlaylists()])
    route()
    // 打开网页/APP 自动开台（FM 电台）：等首屏渲染落地后再起播，不抢首屏
    setTimeout(maybeFmAutoplay, 400)
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    $('#login-err').textContent = ''
    $('#login-btn').disabled = true
    try {
      const d = await api('/login', { method: 'POST', body: { name: $('#login-name').value.trim(), password: $('#login-pass').value }, skipAuth: true })
      token = d.token
      localStorage.setItem('gusi-web-token', token)
      me = { name: d.name }
      await enterApp()
    } catch (err) {
      $('#login-err').textContent = err.message
    } finally {
      $('#login-btn').disabled = false
    }
  })
  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    $('#reg-err').textContent = ''
    $('#reg-btn').disabled = true
    try {
      const name = $('#reg-name').value.trim()
      const pw = $('#reg-pass').value
      const cf = $('#reg-pass2').value
      const email = $('#reg-email').value.trim()
      if (pw !== cf) throw new Error('两次输入的密码不一致')
      // 与后端同规则的前置校验：早提示，别等服务端绕一圈
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确')
      if (pw.length < 6) throw new Error('密码至少 6 位')
      const d = await api('/register', { method: 'POST', body: { name, password: pw, confirm: cf, email }, skipAuth: true })
      token = d.token
      localStorage.setItem('gusi-web-token', token)
      me = { name: d.name }
      $('#reg-name').value = ''
      $('#reg-pass').value = ''
      $('#reg-pass2').value = ''
      $('#reg-email').value = ''
      await enterApp()
    } catch (err) {
      $('#reg-err').textContent = err.message || '注册失败'
    } finally {
      $('#reg-btn').disabled = false
    }
  })
  function logout() {
    localStorage.removeItem('gusi-web-token')
    token = ''
    me = null
    // 用户态缓存必须清：换个人登录不能看到上一位的收藏与音源配置
    loveIds = new Set()
    onlineSourcesCache = [{ id: 'kw', name: '酷我音乐' }]
    player.stopAll()
    showLogin()
  }
  $('#logout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }) } catch {}
    logout()
  }

  // ---------------- 侧栏 / 路由 ----------------
  const TITLES = { home: '首页', tracks: '全部歌曲', albums: '歌单', artists: '歌手', search: '搜索', online: '在线音乐', fm: 'FM 电台', downloads: '下载中心', playlists: '我的歌单', settings: '设置' }
  /**
   * 高亮侧边栏项 + 顶栏标题。
   * title 可选：侧边栏收成「歌单」一个入口后，歌手/专辑/我的歌单这些页面
   * 仍然要顶栏显示自己的名字，但高亮的还是「歌单」那一项。
   */
  function setActiveNav(name, title) {
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === name))
    $('#top-title').textContent = title || TITLES[name] || '古四音乐'
  }
  function closeDrawer() { $('#sidebar').classList.remove('open'); $('#mask').hidden = true }
  $('#menu-btn').onclick = () => { $('#sidebar').classList.add('open'); $('#mask').hidden = false }
  $('#mask').onclick = closeDrawer
  window.addEventListener('hashchange', () => { closeDrawer(); route() })

  async function refreshPlaylists() {
    try {
      const d = await api('/api/playlists')
      playlistsCache = d.playlists
    } catch {}
  }

  const routes = {}
  function route() {
    const hash = location.hash || '#/home'
    const [pathPart, queryPart] = hash.substring(2).split('?')
    const seg = pathPart.split('/')
    const fn = routes[seg[0]]
    // 每次导航都换成全新节点：上一页未完成的异步渲染持有的是旧节点引用，
    // 其后续 append 会落在已脱离文档的节点上，不再串进新页面
    //（此前首页数据晚到时会把自己的区块混进当前页）
    const oldView = $('#view')
    const view = oldView.cloneNode(false)
    oldView.replaceWith(view)
    // 路由切换淡入动画
    view.classList.remove('route-in')
    void view.offsetWidth // 强制 reflow 重启动画
    view.classList.add('route-in')
    if (!fn) {
      // 404：未知路由
      view.appendChild(el('div', 'empty nf404', ''))
      const icon = el('div', 'nf404-icon', '404')
      view.querySelector('.nf404').appendChild(icon)
      view.querySelector('.nf404').appendChild(el('p', 'nf404-msg', '页面不存在'))
      const a = el('a', 'btn primary')
      a.href = '#/home'
      a.textContent = '回到首页'
      a.style.display = 'inline-block'
      a.style.marginTop = '16px'
      view.querySelector('.nf404').appendChild(a)
      return
    }
    fn(seg.slice(1), queryPart || '').catch(err => {
      if (String(err.message).includes('登录')) return
      view.appendChild(el('div', 'empty', '加载失败：' + err.message))
    })
  }

  // 骨架屏：在数据到达前展示占位
  function skeletonRows(n) {
    const wrap = el('div', 'sk-wrap')
    for (let i = 0; i < n; i++) {
      const row = el('div', 'sk-row')
      row.appendChild(el('div', 'sk-cov'))
      const lines = el('div', 'sk-lines')
      lines.appendChild(el('div', 'sk-line'))
      lines.appendChild(el('div', 'sk-line short'))
      row.appendChild(lines)
      row.appendChild(el('div', 'sk-dur'))
      wrap.appendChild(row)
    }
    return wrap
  }
  function skeletonGrid(n) {
    const wrap = el('div', 'grid')
    for (let i = 0; i < n; i++) {
      const c = el('div', 'card sk-card')
      c.appendChild(el('div', 'sk-cov'))
      c.appendChild(el('div', 'sk-line'))
      c.appendChild(el('div', 'sk-line short'))
      wrap.appendChild(c)
    }
    return wrap
  }

  // ---------------- 曲目表渲染（共享） ----------------
  // ---------------- 曲目表统一列模板 ----------------
  // 五处曲目表（全部歌曲 / 歌单详情 / 在线音源 / 推荐详情 / 下载中心）以前各自手写表头，
  // 列集合与顺序稍有不一致就错列；宽度又靠 auto 布局分配，结果「歌曲」被撑到几百像素，
  // 而末列被推到最右边、在它前面凭空留出一段空隙（量出来 156px）。
  // 现在列定义只有这一份：表头与每一行都按同一份 colKeys 拼，缺的列补空单元格；
  // 表格用 table-layout:fixed（宽度只认表头那一行），末列 pad 吃掉剩余宽度，因此必然逐列对齐。
  const COLS = {
    sel: { cls: 'sel-col' },
    num: { cls: 'num', label: '#' },
    cov: { cls: 'cov' },
    name: { cls: 'name-col', label: '歌曲' },
    album: { cls: 'album-col ell', label: '专辑' },
    love: { cls: 'love' },
    dl: { cls: 'dl-col' },
    dur: { cls: 'dur', label: '时长' },
    order: { cls: 'order-col' },
    acts: { cls: 'acts' },
    pad: { cls: 'pad-col' },   // 空列，只用来吃剩余宽度
  }
  /** 本表要哪些列：表头与行必须用同一份结果，否则一定错列 */
  function colKeys(opts) {
    opts = opts || {}
    const ks = []
    if (opts.noSelect !== true) ks.push('sel')
    if (opts.noNum !== true) ks.push('num')
    ks.push('cov', 'name')
    if (opts.showAlbum !== false) ks.push('album')
    if (opts.showLove !== false) ks.push('love')
    if (opts.dl) ks.push('dl')
    ks.push('dur')
    if (opts.order) ks.push('order')
    if (opts.menu) ks.push('acts')
    ks.push('pad')
    return ks
  }
  /** 表头行（宽度全由 th 类名决定，所以表头必须由它生成） */
  function trackHead(opts) {
    const htr = el('tr')
    colKeys(opts).forEach((k) => {
      // 勾选列的复选框只对「.row-sel」这套勾选上下文有效；下载中心另有一套批量勾选
      // （它自己把全选框挂在批量条上），那里传 onSelHead 自己往格子里塞控件。
      if (k === 'sel') {
        const th = (opts && opts.plainSelHead) ? el('th', 'sel-col', '') : selHeadCell()
        if (opts && opts.onSelHead) opts.onSelHead(th)
        htr.appendChild(th)
        return
      }
      const c = COLS[k]
      const label = (k === 'acts' && opts && opts.actsLabel) ? opts.actsLabel : (c.label || '')
      htr.appendChild(el('th', c.cls, label))
    })
    return htr
  }
  /** 按同一份列模板拼一行；cells 里没给的列补空单元格（宁可空着，也不错列） */
  function trackRowEl(opts, cells) {
    const tr = el('tr', 'row')
    colKeys(opts).forEach((k) => tr.appendChild(cells[k] || el('td', COLS[k].cls, '')))
    return tr
  }
  /** 行尾「…」菜单单元格（歌单移除 / 删除 / 分享等都在这个菜单里） */
  function trackMenuCell(t, musics, idx) {
    const td = el('td', 'acts')
    const wrap = el('span', 'more-wrap')
    const mb = el('button', 'iconbtn', '…')
    mb.onclick = (e) => { e.stopPropagation(); openTrackMenu(mb, t, musics, idx) }
    wrap.appendChild(mb)
    td.appendChild(wrap)
    return td
  }

  function trackRow(t, musics, idx, opts) {
    opts = opts || {}
    const cells = {}
    // 首页推荐类列表不做勾选下载，故可省去多选列
    if (opts.noSelect !== true) cells.sel = selRowCell(t)
    cells.num = el('td', 'num', String(idx + 1))
    // NAS 曲库行内封面（hasCover 时懒加载；在线源行走 t.pic）
    const tdCov = el('td', 'cov')
    if (t.online) {
      tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
    } else {
      tdCov.appendChild(coverImg(t, null, (t.singer || '') + (t.album || '') + (t.name || '')))
    }
    cells.cov = tdCov
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    if (opts.showSinger !== false) tdName.appendChild(el('div', 'sub', t.singer || '未知歌手'))
    cells.name = tdName
    if (opts.showAlbum !== false) cells.album = el('td', 'album-col ell', t.album || '—')
    const love = el('td', 'love')
    cells.love = love
    const dur = el('td', 'dur')
    cells.dur = dur
    if (t.online) {
      // 在线音源行（手机端同步进歌单的，或 Web 端刚收藏进「我喜欢」的）：
      // 现在服务端能解析在线直链，所以这些行与在线音乐页一致——可播、可收藏、可移除。
      // 只有连 source/rid 都没有的残项才置灰（历史数据 / 导入的坏条目）。
      const broken = !t.source || !(t.rid || t.id)
      love.appendChild(broken ? el('span', 'iconbtn', '·') : loveBtn(t))
      dur.textContent = broken ? (t.interval || '') : fmtDur(loveIntervalMs(t) / 1000)
      if (opts.order) cells.order = orderCell(t, musics, idx)
      if (opts.menu) cells.acts = trackMenuCell(t, musics, idx)
      const tr = trackRowEl(opts, cells)
      if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
      if (broken) {
        tr.classList.add('disabled')
        tr.onclick = () => toast('「' + t.name + '」缺少音源信息，无法播放', true)
        return tr
      }
      tr.onclick = () => player.play(musics, idx)
      return tr
    }
    // 死引用（歌单里指向已被删/改名的曲库文件）：灰显，只留菜单里的「从歌单移除」
    love.appendChild(t.missing ? el('span', 'iconbtn', '·') : loveBtn(t))
    dur.textContent = t.interval || ''
    if (opts.order && !t.missing) cells.order = orderCell(t, musics, idx)
    if (opts.menu) cells.acts = trackMenuCell(t, musics, idx)
    const tr = trackRowEl(opts, cells)
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    if (t.missing) {
      tr.classList.add('disabled')
      tr.onclick = () => toast('「' + t.name + '」的文件已不在曲库，用右侧「…」→「从歌单移除」清理', true)
      return tr
    }
    tr.ondblclick = () => player.play(musics, idx)
    tr.onclick = () => { player.play(musics, idx) }
    return tr
  }

  /** 歌单排序按钮（↑↓）：交换后整表提交 order API。返回单元格（列模板要按序拼） */
  function orderCell(t, musics, idx) {
    const td = el('td', 'order-col')
    const up = el('button', 'iconbtn', '↑')
    up.title = '上移'
    const dn = el('button', 'iconbtn', '↓')
    dn.title = '下移'
    const move = async (from, to) => {
      if (to < 0 || to >= musics.length) return
      const ids = musics.map(m => m._musicId || ('local_' + m.id))
      const [item] = ids.splice(from, 1)
      ids.splice(to, 0, item)
      try {
        await api('/api/playlists/' + encodeURIComponent(musics[0]._listId) + '/order', { method: 'POST', body: { musicIds: ids } })
        route()
      } catch (e) { toast(e.message, true) }
    }
    up.onclick = (e) => { e.stopPropagation(); move(idx, idx - 1) }
    dn.onclick = (e) => { e.stopPropagation(); move(idx, idx + 1) }
    td.appendChild(up)
    td.appendChild(dn)
    return td
  }

  function trackTable(musics, opts) {
    const table = el('table', 'tracks' + (opts.compact ? ' compact' : ''))
    const thead = el('thead')
    thead.appendChild(trackHead(opts))
    table.appendChild(thead)
    const tbody = el('tbody')
    musics.forEach((t, i) => tbody.appendChild(trackRow(t, musics, i, opts)))
    table.appendChild(tbody)
    // 当前播放曲目滚动到可见（主列表页开启；避免打断用户浏览，仅在渲染完成后一次性执行）
    if (opts.autoScroll) {
      const playingTr = table.querySelector('tr.playing')
      if (playingTr) setTimeout(() => playingTr.scrollIntoView({ block: 'nearest' }), 60)
    }
    return table
  }

  /**
   * 首页推荐区块列表：默认 8 首紧凑行，多余部分原地「展开全部」（不跳页）。
   * 这类列表不参与勾选下载，因此去掉多选列。
   */
  function sectionTracks(list, opts) {
    opts = Object.assign({}, opts, { noSelect: true, compact: true })
    const box = el('div', 'sec-tracks')
    const LIMIT = 8
    let expanded = false
    const paint = () => {
      box.innerHTML = ''
      box.appendChild(trackTable(expanded ? list : list.slice(0, LIMIT), opts))
      if (list.length > LIMIT) {
        const b = el('button', 'btn ghost more-inline', expanded ? '收起' : `展开全部 ${list.length} 首`)
        b.onclick = () => { expanded = !expanded; paint() }
        box.appendChild(b)
      }
    }
    paint()
    return box
  }

  function openTrackMenu(btn, track, musics, idx) {
    document.querySelectorAll('.menu').forEach(m => m.remove())
    const menu = el('div', 'menu')
    // fn 收到点击坐标（程序化 .click() 时 clientX/Y 为 0，回退到按钮自身位置）
    const mk = (label, fn) => {
      const b = el('button', null, label)
      b.onclick = (e) => {
        e.stopPropagation()
        const r = b.getBoundingClientRect()
        const pt = (e.clientX > 1 || e.clientY > 1) ? { x: e.clientX, y: e.clientY + 4 } : { x: r.left, y: r.bottom + 4 }
        menu.remove()
        fn(pt)
      }
      menu.appendChild(b)
    }
    const mount = () => {
      const wrap = btn.parentElement
      wrap.appendChild(menu)
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off) } }
      setTimeout(() => document.addEventListener('click', off), 0)
    }
    // 死引用（曲库已无这首）：播放/收藏/下载/删除全是死路，只给「从歌单移除」
    if (track.missing) {
      if (track._listId && track._musicId) {
        mk('从歌单移除', async () => {
          try {
            await api('/api/playlists/' + encodeURIComponent(track._listId) + '/remove', { method: 'POST', body: { musicIds: [track._musicId] } })
            toast('已从歌单移除')
            route()
            refreshPlaylists()
          } catch (e) { toast(e.message, true) }
        })
      } else {
        menu.appendChild(el('div', 'menu-note', '该曲目已不在曲库'))
      }
      mount()
      return
    }
    mk('立即播放', () => player.play(musics, idx))
    mk('下一首播放', () => { player.insertNext(track); toast('已插入下一首') })
    // 收藏：本地与在线同一份「我喜欢」列表，文案随当前状态变
    if (loveKeyOf(track)) mk(loveMenuLabel(track), () => loveMenuAction(track))
    // 歌单目前只能存曲库内的曲目，所以只对本地曲目显示（与「删除…」一致）
    if (!track.online && track.id) mk('添加到歌单…', () => askAddToPlaylist([track]))
    // 分享这首（免登录可听的公开链接，默认 7 天、默认允许下载）
    if (!track.online && track.id) {
      mk('分享这首…', () => shareDialog({
        type: 'track', ids: [String(track.id)], count: 1,
        title: track.name, subtitle: (track.singer && track.singer !== '未知歌手') ? track.singer : '',
      }))
    }
    // 下载到本地：
    //   本地曲目（track.id）走 /web/media/download/<id>
    //   在线曲目（kind==='online' 且有 rid）走 /web/media/online/<source>/<rid>?dl=1
    //   若曲目既无本地 id 又无在线 rid（如从第三方客户端同步过来的歌单项）则不显示
    const canDl = track.id || (track.kind === 'online' && track.rid) || (track.online === true && track.rid)
    if (canDl) {
      mk('下载…', (pt) => askDownload([track], pt))
    }
    // 重命名 / 编辑标签：改的是磁盘文件名与内嵌标签，只对本地曲库曲目有意义
    if (!track.online && track.id) {
      mk('重命名…', () => askRenameTrack(track))
      mk('编辑标签…', () => askEditTags(track))
    }
    // 删除：仅本地曲库曲目（在线曲目属于音源，服务端无对应文件）
    if (!track.online && track.id) mk('删除…', () => askDeleteTracks([track]))
    mount()
  }

  // 无内嵌封面时的占位配色（按标题哈希取色，同一专辑颜色稳定）
  const PH_TONES = [
    ['#4f63e8', '#8b5cf6'], ['#e8548b', '#f0894f'], ['#2aa79b', '#4f8ff9'],
    ['#e8894f', '#e25c5c'], ['#6d5cd6', '#b95cf6'], ['#33a866', '#2aa79b'],
  ]
  const hashStr = (x) => {
    let h = 0
    const str = String(x ?? '')
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
    return Math.abs(h)
  }
  /** 该曲目是否可显示封面：文件内嵌 或 在线回填缓存 */
  const hasCoverOf = (t) => !!(t && (t.hasCover || t.coverCache))

  /** 第三方图片地址 → 本机代理地址（图床多为 http，直连会被浏览器拦） */
  const picProxy = (url) => (url && /^https?:\/\//.test(url))
    ? BASE + '/web/media/pic?u=' + encodeURIComponent(url) + '&k=' + encodeURIComponent(token)
    : ''

  /** 在线图片：经 NAS 代理加载（第三方图床多为 http，直连会被浏览器拦），失败回退渐变占位 */
  const picImg = (url, cls, seed) => {
    const img = el('img', cls)
    img.loading = 'lazy'
    img.alt = ''
    const ph = () => {
      const [a, b] = PH_TONES[hashStr(seed || url || '') % PH_TONES.length]
      img.classList.add('ph')
      img.style.setProperty('--ph-a', a)
      img.style.setProperty('--ph-b', b)
      img.removeAttribute('src')
      img.onerror = null
    }
    if (url && /^https?:\/\//.test(url)) {
      img.src = picProxy(url)
      img.onerror = ph
    } else {
      ph()
    }
    return img
  }

  /** 封面图：有内嵌封面走 /media/cover，否则输出渐变 + 音符占位（seed 决定配色） */
  function coverImg(track, cls, seed) {
    const img = el('img', cls)
    img.loading = 'lazy'
    img.alt = ''
    const placeholder = () => {
      const key = seed || (track && (track.id || track.name)) || ''
      const [a, b] = PH_TONES[hashStr(key) % PH_TONES.length]
      img.classList.add('ph')
      img.style.setProperty('--ph-a', a)
      img.style.setProperty('--ph-b', b)
      img.removeAttribute('src')
      img.onerror = null
    }
    if (track && hasCoverOf(track)) {
      img.src = mediaUrl('cover', track.id)
      img.onerror = placeholder
    } else {
      placeholder()
    }
    return img
  }

  // 下载当前曲目：
  //   本地曲目走 /web/media/download/<id>（服务端按 track.name+ext 生成 Content-Disposition）
  //   在线曲目走 /web/media/online/<source>/<rid>?dl=1&name=... 由服务端附加
  //   Content-Disposition: attachment 让浏览器触发下载（照抄洛雪/六音的在线下载模式）
  // 用锚点触发浏览器原生下载，避免 fetch+blob 把大文件整个拉进内存
  function downloadUrl(t) {
    const token = localStorage.getItem('gusi-web-token') || ''
    if (t.kind === 'online') {
      const name = encodeURIComponent((t.name || '') + (t.singer ? ' - ' + t.singer : ''))
      // name 仍是下载文件名；title/singer/album/pic/dur 是给服务端写内嵌封面+歌词用的
      const q = [
        'dl=1', 'name=' + name,
        'title=' + encodeURIComponent(t.name || ''),
        'singer=' + encodeURIComponent(t.singer || ''),
        'album=' + encodeURIComponent(t.album || ''),
        'dur=' + encodeURIComponent(String(t.interval || '')),
        'k=' + encodeURIComponent(token),
      ]
      if (t.pic) q.push('pic=' + encodeURIComponent(t.pic))
      return BASE + '/web/media/online/' + encodeURIComponent(t.source) + '/' + encodeURIComponent(t.rid) + '?' + q.join('&')
    }
    return mediaUrl('download', t.id)
  }
  function downloadCurrent(anchor) {
    const t = player.cur
    if (!t) return toast('当前无曲目', true)
    askDownload([t], anchor)
  }
  /** 通用浮层小菜单：anchor 为元素（跟随其位置）、坐标对象 {x,y}，或 null（屏幕中上） */
  function popMenu(anchor, items) {
    document.querySelectorAll('.menu.pop').forEach(m => m.remove())
    const menu = el('div', 'menu pop')
    for (const [label, fn] of items) {
      const b = el('button', null, label)
      b.onclick = (e) => { e.stopPropagation(); close(); fn() }
      menu.appendChild(b)
    }
    const close = () => { menu.remove(); document.removeEventListener('click', onDoc, true) }
    const onDoc = (e) => { if (!menu.contains(e.target)) close() }
    document.body.appendChild(menu)
    let x, y
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect()
      x = r.left; y = r.bottom + 6
    } else if (anchor && typeof anchor.x === 'number') {
      x = anchor.x; y = anchor.y
    } else {
      x = window.innerWidth / 2 - 95; y = Math.max(80, window.innerHeight / 3)
    }
    menu.style.position = 'fixed'
    menu.style.right = 'auto'
    // 此刻菜单已挂进 DOM，能量到真实尺寸
    const mh = menu.offsetHeight, mw = menu.offsetWidth
    // 锚点在视口下半部（底部播放栏、全屏歌词页）时向上弹，
    // 否则菜单只会被 clamp 到贴底，压住播放栏点不到
    if (anchor && anchor.getBoundingClientRect) {
      const ar = anchor.getBoundingClientRect()
      if (ar.bottom + 6 + mh > window.innerHeight - 8 && ar.top - 6 - mh > 8) y = ar.top - mh - 6
    }
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 10)) + 'px'
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 10)) + 'px'
    setTimeout(() => document.addEventListener('click', onDoc, true), 0)
    return menu
  }

  /** 云盘（NAS 用户网盘，默认 1GB 配额）：把本地曲目复制进网盘目录 */
  async function saveToCloud(tracks) {
    const all = (tracks || []).filter(Boolean)
    const list = all.filter(t => t.kind !== 'online' && t.id)
    const online = all.filter(t => t.kind === 'online' && t.rid)
    // 在线曲目：走下载入队（服务端拉取后落进云盘目录）
    if (online.length) {
      try {
        const r = await api('/api/downloads/enqueue', { method: 'POST', body: { items: online.map(toEnqueueItem) } })
        toast('☁️ 已加入下载队列 ' + (r.accepted || 0) + ' 首' + (list.length ? '，另有 ' + list.length + ' 首待复制' : ''), !(r.accepted || 0))
      } catch (e) { toast(e.message, true) }
      if (!list.length) return
    }
    if (!list.length) { toast('没有可保存的曲目', true); return }
    try {
      const r = await api('/api/cloud/save', { method: 'POST', body: { trackIds: list.map(t => t.id) } })
      const parts = ['已存 ' + (r.saved || 0) + ' 首']
      if (r.skipped) parts.push('已在云盘 ' + r.skipped)
      if (r.missing) parts.push('未找到 ' + r.missing)
      if (r.failed) parts.push('失败 ' + r.failed)
      const mb = r.bytes ? '（' + (r.bytes / 1048576).toFixed(1) + ' MB）' : ''
      toast('☁️ ' + parts.join('、') + mb + (r.reason ? ' · ' + r.reason : ''), !r.saved)
    } catch (e) { toast(e.message, true) }
  }

  /** 浏览器原生下载（原有行为），批量时逐个触发 */
  function downloadLocal(tracks) {
    const list = (tracks || []).filter(Boolean)
    let n = 0
    for (const t of list) {
      if (t.kind === 'online' ? !t.rid : !t.id) continue
      const a = document.createElement('a')
      a.href = downloadUrl(t)
      a.download = ''
      document.body.appendChild(a)
      a.click()
      a.remove()
      n++
    }
    if (!n) return toast('该曲目无法下载', true)
    if (n > 1) toast('已开始下载 ' + n + ' 个文件')
  }

  /** 在线曲目原始 API 数据 → 在线行。幂等：已是在线行则原样返回。
   *  在线列表存在两种形态（/api/online/* 的原始数据、toOnlineRows 转换后的行），
   *  而 downloadLocal/saveToCloud/downloadUrl 都靠 kind+rid 判定在线，
   *  故所有下载入口统一先过这里，避免把 source_id 当本地曲目 id 去下载。 */
  function asOnlineRows(list) {
    return (list || []).map(x => (x && x.kind === 'online' && x.rid) ? x : {
      id: x.source + '_' + String(x.id == null ? '' : x.id).replace(/^MUSIC_/, ''),
      kind: 'online', source: x.source, rid: x.id,
      name: x.name, singer: x.singer, album: x.album,
      interval: x.intervalMs, pic: x.pic,
    })
  }

  /** 点击下载 → 选择下载方式（本机 / 云盘） */
  function askDownload(tracks, anchor) {
    const list = (tracks || []).filter(Boolean)
    if (!list.length) return toast('无可用曲目', true)
    // 本机与云盘支持的能力集一致：本地曲目直接直链/复制，在线曲目由服务端拉取后落盘。
    // 此前云盘计数排除了在线曲目，批量在线下载时菜单会显示「保存到云盘（0 首）」。
    const n = list.filter(t => (t.kind === 'online' ? !!t.rid : !!t.id)).length
    if (!n) return toast('该曲目无法下载', true)
    const tail = list.length > 1 ? (k) => '（' + k + ' 首）' : () => ''
    popMenu(anchor, [
      ['💻 下载到本机' + tail(n), () => downloadLocal(list)],
      ['☁️ 保存到云盘' + tail(n), () => saveToCloud(list)],
    ])
  }

  function downloadTrack(t, anchor) {
    if (!t) return toast('该曲目无法下载', true)
    askDownload([t], anchor)
  }

  // ---------------- 视图：首页 ----------------
  routes.home = async () => {
    setActiveNav('home')
    const v = $('#view')
    const hour = new Date().getHours()
    v.appendChild(el('h2', 'page', hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'))

    // 统计条（专辑 27 张 / 歌手 22 位 / 全部歌曲 32 首 / 我喜欢 0 首）已按需求下线：
    // 专辑·歌手·全部歌曲 在侧边栏，「我喜欢」在「专辑/歌单 → 我的歌单」里，
    // 首屏直接进「为你推荐」更干净。空曲库提示与「去管理后台」引导也已按需求删除（首页只留内容）。

    // 为你推荐：按账户口味生成的两份歌单（今日推荐 / 猜你喜欢）。
    // 这里是「UI 封面」形态 —— 只给封面 + 推荐依据，点开才进详情（#/mix/daily、#/mix/guess）。
    const fyBox = el('div', 'foryou-slot')
    fyBox.appendChild(forYouSkeleton())
    v.appendChild(fyBox)
    paintForYou(fyBox).catch(() => { fyBox.remove() })

    // 推荐歌单（网易云推荐歌单 · 横向滚动卡片）
    try {
      const rec = await api('/api/online/rec-playlists?source=wy&limit=12')
      if (rec.list && rec.list.length) {
        const rh = el('div', 'row-head')
        rh.appendChild(el('h3', null, '推荐歌单'))
        const btns = el('div', 'btns')
        const bMore = el('button', 'btn ghost', '去在线音乐 ›')
        bMore.onclick = () => { location.hash = '#/online' }
        btns.appendChild(bMore)
        rh.appendChild(btns)
        v.appendChild(rh)
        // 自适应网格：去掉横向滚动容器（原底部滑动框会截断内容）
        const sc = el('div', 'rec-grid')
        for (const rp of rec.list) {
          const card = el('div', 'card mini')
          const cov = el('div', 'cover')
          cov.appendChild(picImg(rp.pic, null, rp.name))
          card.appendChild(cov)
          card.appendChild(el('div', 't', rp.name))
          card.appendChild(el('div', 's', (rp.trackCount ? rp.trackCount + ' 首' : '歌单')))
          card.onclick = () => {
            window.__pendingRec = { source: 'wy', type: 'playlist', item: { id: rp.id, name: rp.name, pic: rp.pic, creator: rp.creator, trackCount: rp.trackCount } }
            location.hash = '#/online'
          }
          sc.appendChild(card)
        }
        v.appendChild(sc)
      }
    } catch (e) { /* 推荐歌单失败不阻塞首页 */ }
  }

  // ---------------- 为你推荐（首页入口卡片 + 详情页） ----------------
  /**
   * 推荐封面：一个格子只放一张图（本地曲目走封面接口、在线曲目走源图）。
   * 接口给的是一个候选序列，这里按顺序顶替 —— 第一张挂了（封面文件缺失 / 图床失效）
   * 就换下一张，界面上始终只有一张图，不会退回占满格子的拼图。
   */
  function fyCover(items, cls) {
    const box = el('div', cls || 'fy-cov')
    const list = (items || []).slice(0, 4)
    if (!list.length) {
      box.appendChild(el('div', 'fy-cov-ph', '♪'))
      return box
    }
    const img = el('img')
    img.alt = ''
    img.loading = 'lazy'
    let i = 0
    const giveUp = () => {
      if (!img.parentNode) return
      box.removeChild(img)
      box.appendChild(el('div', 'fy-cov-ph', '♪'))
    }
    const swap = () => {
      const t = list[i]
      if (!t || (t.kind === 'online' ? !t.pic : !hasCoverOf(t))) { i++; return i < list.length ? swap() : giveUp() }
      if (t.kind === 'online') img.src = picProxy(t.pic)
      else img.src = mediaUrl('cover', t.id)
    }
    img.onerror = () => { i++; if (i < list.length) swap(); else giveUp() }
    box.appendChild(img)
    swap()
    return box
  }

  /** 首页推荐区加载占位（与卡片同尺寸，数据到达后原地替换） */
  function forYouSkeleton() {
    const wrap = el('div', 'foryou')
    for (let i = 0; i < 2; i++) {
      const card = el('div', 'fy-card sk')
      card.appendChild(el('div', 'fy-cov'))
      const body = el('div', 'fy-body')
      body.appendChild(el('div', 'sk-line'))
      body.appendChild(el('div', 'sk-line short'))
      card.appendChild(body)
      wrap.appendChild(card)
    }
    return wrap
  }

  /** 渲染「为你推荐」两张入口卡片：表面是 UI 封面 + 推荐依据，点开进详情 */
  async function paintForYou(box) {
    const d = await api('/api/for-you')
    box.innerHTML = ''
    const rh = el('div', 'row-head')
    rh.appendChild(el('h3', null, '为你推荐'))
    box.appendChild(rh)
    const grid = el('div', 'foryou')
    for (const mix of [d.daily, d.guess]) {
      if (!mix || !(mix.tracks || []).length) continue
      const card = el('div', 'fy-card')
      card.appendChild(fyCover(mix.cover))
      const body = el('div', 'fy-body')
      body.appendChild(el('div', 'fy-name', mix.name))
      body.appendChild(el('div', 'fy-reason', mix.reason || ''))
      const meta = []
      if (mix.localCount) meta.push(mix.localCount + ' 首本地')
      if (mix.onlineCount) meta.push(mix.onlineCount + ' 首在线')
      body.appendChild(el('div', 'fy-meta', (meta.join(' · ') || '—') + ' · 点开看详情'))
      card.appendChild(body)
      card.onclick = () => { location.hash = '#/mix/' + mix.id }
      grid.appendChild(card)
    }
    box.appendChild(grid)
  }

  /** 推荐详情表：本地行与在线行混排（列结构一致，避免错列） */
  function mixTable(tracks) {
    const table = el('table', 'tracks compact')
    const opts = { noSelect: true, compact: true, menu: true }
    const thead = el('thead')
    thead.appendChild(trackHead(opts))
    table.appendChild(thead)
    const tbody = el('tbody')
    tracks.forEach((t, i) => {
      tbody.appendChild(t.kind === 'online'
        ? mixOnlineRow(t, tracks, i, opts)
        : trackRow(t, tracks, i, opts))
    })
    table.appendChild(tbody)
    return table
  }

  /** 在线行：本地行右侧是「…」菜单，这里同样给「…」，列结构才对得齐 */
  function mixOnlineRow(t, list, idx, opts) {
    opts = opts || { noSelect: true, compact: true, menu: true }
    const cells = {}
    cells.num = el('td', 'num', String(idx + 1))
    const tdCov = el('td', 'cov')
    tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
    cells.cov = tdCov
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    tdName.appendChild(el('div', 'sub', (t.singer || '未知歌手') + ' · 在线'))
    cells.name = tdName
    cells.album = el('td', 'album-col ell', t.album || '—')
    const love = el('td', 'love')
    love.appendChild(loveBtn(t))
    cells.love = love
    cells.dur = el('td', 'dur', t.interval ? fmtDur(Number(t.interval) / 1000) : '')
    const acts = trackMenuCell(t, list, idx)
    cells.acts = acts
    const wrap = acts.querySelector('.more-wrap')
    const mb = wrap.querySelector('button')
    mb.onclick = (e) => {
      e.stopPropagation()
      popMenu(mb, [
        ['▶ 立即播放', () => player.play(list, idx)],
        ['⏭ 下一首播放', () => player.insertNext(t)],
        [isLoved(t) ? '💔 取消喜欢' : '❤ 加入我喜欢', () => toggleLoveOf(t).then(v => { toast(v ? '已加入我喜欢' : '已取消喜欢'); route() }).catch(err => toast(err.message, true))],
        ['💻 下载到本机', () => askDownload(asOnlineRows([t]), mb)],
        ['☁️ 保存到云盘', () => saveToCloud(asOnlineRows([t]))],
      ])
    }
    const tr = trackRowEl(opts, cells)
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    tr.onclick = () => player.play(list, idx)
    return tr
  }

  // ---------------- 视图：推荐详情（今日推荐 / 猜你喜欢） ----------------
  routes.mix = async (args) => {
    setActiveNav('home')
    const v = $('#view')
    const kind = args[0] === 'guess' ? 'guess' : 'daily'
    v.appendChild(skeletonRows(4))
    const d = await api('/api/for-you')
    v.querySelectorAll('.sk-wrap').forEach(s => s.remove())
    const mix = (kind === 'guess' ? d.guess : d.daily) || { tracks: [] }
    const tracks = mix.tracks || []

    const hero = el('div', 'fy-hero')
    hero.appendChild(fyCover(mix.cover, 'fy-cov big'))
    const box = el('div')
    const crumb = el('div', 'crumb', '‹ 为你推荐')
    crumb.onclick = () => { location.hash = '#/home' }
    box.appendChild(crumb)
    box.appendChild(el('h2', null, mix.name))
    const bits = []
    if (mix.reason) bits.push(mix.reason)
    bits.push(tracks.length + ' 首（本地 ' + (mix.localCount || 0) + (mix.onlineCount ? ' + 在线 ' + mix.onlineCount : '') + '）')
    box.appendChild(el('div', 'meta', bits.join(' · ')))
    const btns = el('div', 'btns')
    const pb = el('button', 'btn primary')
    pb.innerHTML = SVG.play + '<span>播放全部</span>'
    pb.onclick = () => player.play(tracks, 0)
    const sb = shuffleBtn('随机播放')
    sb.onclick = () => player.shufflePlay(tracks)
    const ab = el('button', 'btn')
    ab.textContent = '＋ 全部加到队列'
    ab.onclick = () => { player.enqueue(tracks); toast('已加入 ' + tracks.length + ' 首') }
    btns.appendChild(pb); btns.appendChild(sb); btns.appendChild(ab)
    box.appendChild(btns)
    hero.appendChild(box)
    v.appendChild(hero)

    if (!tracks.length) {
      v.appendChild(el('div', 'empty', '还没有足够的数据生成推荐。多听几首（本地或在线的都算），这里会跟着变准。'))
      return
    }
    v.appendChild(mixTable(tracks))
    if (kind === 'daily') v.appendChild(el('div', 'fy-note', '今日推荐每天换一批，同一天内保持不变；「猜你喜欢」更贴近你最近在听的内容。'))
  }

  // ---------------- 视图：全部歌曲 ----------------
  let tracksPage = { page: 0, size: 60, total: 0, list: [], loading: false }
  routes.tracks = async () => {
    setActiveNav('tracks')
    const v = $('#view')
    const head = el('div', 'page-head')
    head.appendChild(el('h2', 'page', '全部歌曲'))
    const meta = el('span', 'meta', '…')
    const btns = el('div', 'btns')
    const btnAll = el('button', 'btn', '播放全部')
    btnAll.title = '从第一首开始顺序播放当前已加载的曲目'
    const btnShuf = el('button', 'btn ghost')
    btnShuf.innerHTML = SVG.shuffle + '<span>随机播放</span>'
    btnShuf.title = '打乱当前已加载的曲目顺序播放'
    btnAll.onclick = () => { if (tracksPage.list.length) player.play(tracksPage.list, 0); else toast('暂无曲目', true) }
    btnShuf.onclick = () => { if (tracksPage.list.length) player.shufflePlay(tracksPage.list); else toast('暂无曲目', true) }
    btns.appendChild(btnAll); btns.appendChild(btnShuf)
    // 勾选列一直存在，但此前没有任何批量操作接上去；补齐「下载/删除选中」
    btns.appendChild(selDlBtn())
    btns.appendChild(selLoveBtn())
    btns.appendChild(selDelBtn())
    btns.appendChild(selPlBtn())
    btns.appendChild(selShareBtn())
    head.appendChild(meta); head.appendChild(btns)
    v.appendChild(head)
    tracksPage = { page: 0, size: 60, total: 0, list: [], loading: false }
    // 本页此前从未绑定多选上下文，勾选框形同虚设（批量按钮读不到列表）
    initSel([])
    const table = trackTable([], { menu: true, autoScroll: true })
    const tbody = table.querySelector('tbody')
    const more = el('button', 'load-more', '加载更多')
    v.appendChild(table)
    v.appendChild(more)
    const load = async () => {
      if (tracksPage.loading) return
      tracksPage.loading = true
      try {
        const d = await api('/api/tracks?page=' + (tracksPage.page + 1) + '&size=' + tracksPage.size)
        tracksPage.page++
        tracksPage.total = d.total
        tracksPage.list = tracksPage.list.concat(d.tracks)
        tbody.innerHTML = ''
        tracksPage.list.forEach((t, i) => tbody.appendChild(trackRow(t, tracksPage.list, i, { menu: true })))
        rebindSel(tracksPage.list)
        more.hidden = tracksPage.list.length >= d.total
        more.textContent = '加载更多（已加载 ' + tracksPage.list.length + ' / ' + d.total + '）'
        meta.textContent = '共 ' + d.total + ' 首 · 已加载 ' + tracksPage.list.length
      } catch (e) { toast(e.message, true) }
      tracksPage.loading = false
    }
    more.onclick = load
    // 首次加载骨架屏
    const sk = skeletonRows(8)
    sk.id = 'tracks-skeleton'
    v.insertBefore(sk, table)
    await load()
    sk.remove()
  }

  // ---------------- 视图：专辑 / 歌手 ----------------
  // 侧边栏只留「歌单」一个入口，里面四个 tab；顺序按主人的说法排：
  // 我的歌单 / 歌手 / 专辑 / 导入歌单。tab 与 hash 双向绑定，刷新或分享链接能回到同一页。
  const LIB_TABS = [['playlists', '我的歌单'], ['artists', '歌手'], ['albums', '专辑'], ['import', '导入歌单']]
  routes.albums = async (args, query) => {
    setActiveNav('albums', '歌单')
    const v = $('#view')
    const want = new URLSearchParams(query || '').get('tab') || ''
    let abTab = LIB_TABS.some(t => t[0] === want) ? want : 'playlists'
    const tabs = el('div', 'tabs')
    const area = el('div')
    v.appendChild(tabs)
    v.appendChild(area)
    function paint() {
      tabs.innerHTML = ''
      for (const [key, label] of LIB_TABS) {
        const b = el('button', key === abTab ? 'on' : '', label)
        b.onclick = () => {
          if (abTab === key) return
          abTab = key
          // replaceState：切 tab 不塞历史记录，也不会触发 hashchange 重渲染整个页面
          try { history.replaceState(null, '', '#/albums?tab=' + key) } catch {}
          paint()
        }
        tabs.appendChild(b)
      }
      area.innerHTML = ''
      if (abTab === 'playlists') renderPlaylistsView(area, { title: false })
      else if (abTab === 'artists') paintArtistsInto(area)
      else if (abTab === 'albums') paintAlbums()
      else paintImport()
    }
    async function paintAlbums() {
      const d = await api('/api/albums?size=200')
      if (!d.albums.length) return area.appendChild(el('div', 'empty', '暂无专辑'))
      const grid = el('div', 'grid')
      for (const a of d.albums) {
        const c = el('div', 'card')
        const cover = coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover', (a.singer || '') + (a.name || ''))
        c.appendChild(cover)
        c.appendChild(el('div', 't', a.name))
        c.appendChild(el('div', 's', a.singer + ' · ' + a.count + ' 首'))
        const fab = el('button', 'play-fab')
        fab.innerHTML = SVG.play
        fab.onclick = async (e) => {
          e.stopPropagation()
          const t = await api('/api/album?singer=' + encodeURIComponent(a.singer) + '&album=' + encodeURIComponent(a.name))
          player.play(t.tracks, 0)
        }
        c.appendChild(fab)
        c.onclick = () => { location.hash = '#/album?singer=' + encodeURIComponent(a.singer) + '&album=' + encodeURIComponent(a.name) }
        grid.appendChild(c)
      }
      area.appendChild(grid)
    }
    function paintImport() {
      const guide = el('div', 'dl-paste-guide')
      guide.innerHTML = `
        <div class="pg-title">一键导入外部歌单</div>
        <div class="pg-desc">粘贴网易云/酷我的歌单或专辑分享链接，拉取全量曲目后可直接播放或下载，不会写入本地曲库。</div>
        <pre class="pg-sample">music.163.com/#/playlist?id=12557423433
kuwo.cn/playlist_detail/280301309</pre>
      `
      area.appendChild(guide)
      const bar = el('div', 'dl-search-bar')
      const inp = el('input')
      inp.type = 'text'
      inp.placeholder = '粘贴歌单/专辑分享链接…'
      inp.maxLength = 512
      const btn = el('button', 'btn primary', '🚀 一键导入')
      bar.appendChild(inp); bar.appendChild(btn)
      area.appendChild(bar)
      const result = el('div', 'dl-import-result')
      area.appendChild(result)
      const run = async () => {
        const url = inp.value.trim()
        if (!url) { toast('请先粘贴链接', true); return }
        btn.disabled = true; btn.textContent = '导入中…'
        result.innerHTML = ''; result.appendChild(el('p', 'hint', '🔍 正在解析并拉取曲目…'))
        try {
          const d = await api('/api/online/import?url=' + encodeURIComponent(url))
          const info = d.info || {}
          const list = d.list || []
          result.innerHTML = ''
          result.appendChild(el('div', 'coll-type', (d.type === 'album' ? '专辑' : '歌单') + ' · ' + (srcName(d.source) || d.source)))
          result.appendChild(el('div', 'coll-name', info.name || ''))
          result.appendChild(el('div', 'coll-sub', (info.creator || '') + ' · 共 ' + list.length + ' 首'))
          const btns = el('div', 'btns')
          const bPlay = el('button', 'btn primary')
          bPlay.innerHTML = SVG.play + '<span>播放全部</span>'
          bPlay.onclick = () => { if (list.length) player.play(toOnlineRows(list), 0) }
          const bDl = el('button', 'btn')
          bDl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg><span>下载全部</span>'
          bDl.onclick = () => {
            if (!list.length) { toast('无可下载曲目', true); return }
            askDownload(asOnlineRows(list), bDl)
          }
          btns.appendChild(bPlay); btns.appendChild(bDl)
          btns.appendChild(selDlBtn('btn'))
          result.appendChild(btns)
          if (!list.length) { result.appendChild(el('div', 'empty', '该歌单暂无曲目')); return }
          const rows = toOnlineRows(list)
          initSel(rows)
          const tbl = el('table', 'tracks')
          const thead = el('thead'); onTableHead(thead); tbl.appendChild(thead)
          const tbody = el('tbody')
          rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i, rows)))
          tbl.appendChild(tbody)
          result.appendChild(tbl)
        } catch (e) {
          result.innerHTML = ''
          result.appendChild(el('div', 'empty', e.message))
        }
        btn.disabled = false; btn.textContent = '🚀 一键导入'
      }
      btn.onclick = run
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    }
    paint()
  }

  /** 歌手网格：歌单页的「歌手」tab 与 #/artists 深链共用同一份渲染 */
  const paintArtistsInto = async (v) => {
    const d = await api('/api/artists?size=200')
    if (!d.artists.length) return v.appendChild(el('div', 'empty', '暂无歌手'))
    const grid = el('div', 'grid')
    for (const a of d.artists) {
      const c = el('div', 'card')
      c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover round', a.name || ''))
      c.appendChild(el('div', 't', a.name))
      c.appendChild(el('div', 's', a.count + ' 首 · ' + a.albumCount + ' 专辑'))
      c.onclick = () => { location.hash = '#/artist?singer=' + encodeURIComponent(a.name) }
      grid.appendChild(c)
    }
    v.appendChild(grid)
  }

  routes.artists = async () => {
    // 侧边栏的「歌手」已经并进歌单页：老链接一律重定向到那个 tab，只保留一个真相
    location.replace('#/albums?tab=artists')
  }

  function heroBlock(coverTrack, title, metaText, onPlayAll, extraBtns) {
    const hero = el('div', 'hero')
    hero.appendChild(coverImg(coverTrack, 'cover'))
    const box = el('div')
    box.appendChild(el('h2', null, title))
    box.appendChild(el('div', 'meta', metaText))
    const btns = el('div', 'btns')
    const pb = el('button', 'btn primary')
      pb.innerHTML = SVG.play + '<span>播放全部</span>'
    pb.onclick = onPlayAll
    btns.appendChild(pb)
    for (const b of (extraBtns || [])) btns.appendChild(b)
    box.appendChild(btns)
    hero.appendChild(box)
    return hero
  }

  /** 随机播放：打乱当前曲目列表后从头播放（在线源歌曲已在调用侧过滤） */
  const SHUFFLE_ICON = '<svg viewBox="0 0 24 24"><path d="M3 7h3.6c1.5 0 2.9.8 3.6 2.1l1.5 2.7c.7 1.3 2.1 2.1 3.6 2.1H21"/><path d="M17.5 4.5 21 7l-3.5 2.5"/><path d="M3 17h3.6c1.5 0 2.9-.8 3.6-2.1l1.5-2.7c.7-1.3 2.1-2.1 3.6-2.1H21"/><path d="M17.5 14.5 21 17l-3.5 2.5"/></svg>'
  const shuffleBtn = (label) => {
    const b = el('button', 'btn')
    b.innerHTML = SHUFFLE_ICON + '<span>' + label + '</span>'
    return b
  }

  routes.album = async (args, query) => {
    const q = new URLSearchParams(query)
    const singer = q.get('singer') || ''
    const album = q.get('album') || ''
    setActiveNav('albums', '专辑')
    const v = $('#view')
    const d = await api('/api/album?singer=' + encodeURIComponent(singer) + '&album=' + encodeURIComponent(album))
    const cover = d.tracks.find(hasCoverOf)
    const addAll = el('button', 'btn')
    addAll.textContent = '＋ 全部加到队列'
    addAll.onclick = () => { player.enqueue(d.tracks); toast('已加入 ' + d.tracks.length + ' 首') }
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => player.shufflePlay(d.tracks)
    // 总时长：累加 intervalMs（毫秒，可能有缺失，跳过缺失项）
    let durSec = 0
    for (const t of d.tracks) if (t.intervalMs) durSec += t.intervalMs
    const durStr = durSec ? ' · 总时长 ' + fmtDur(durSec / 1000) : ''
    const metaParts = [singer + ' · ' + d.tracks.length + ' 首', durStr]
    if (d.tracks[0] && d.tracks[0].year) metaParts.push(' · ' + d.tracks[0].year)
    const shareB = el('button', 'btn')
    shareB.innerHTML = SVG.share + '<span>分享专辑</span>'
    shareB.onclick = () => shareDialog({ type: 'album', album, artist: singer, title: album, subtitle: singer, count: d.tracks.length })
    v.appendChild(heroBlock(cover, album, metaParts.join(''), () => player.play(d.tracks, 0), [shuf, addAll, shareB]))
    v.appendChild(trackTable(d.tracks, { showSinger: false, showAlbum: false, menu: true, autoScroll: true }))
  }

  routes.artist = async (args, query) => {
    const q = new URLSearchParams(query)
    const singer = q.get('singer') || ''
    setActiveNav('albums', '歌手')
    const v = $('#view')
    const d = await api('/api/artist?singer=' + encodeURIComponent(singer))
    const cover = d.tracks.find(hasCoverOf)
    const addAll = el('button', 'btn')
    addAll.textContent = '＋ 全部加到队列'
    addAll.onclick = () => { player.enqueue(d.tracks); toast('已加入 ' + d.tracks.length + ' 首') }
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => player.shufflePlay(d.tracks)
    const shareB = el('button', 'btn')
    shareB.innerHTML = SVG.share + '<span>分享歌手</span>'
    shareB.onclick = () => shareDialog({ type: 'artist', artist: singer, title: singer, count: d.tracks.length })
    v.appendChild(heroBlock(cover, singer, d.tracks.length + ' 首 · ' + d.albums.length + ' 专辑', () => player.play(d.tracks, 0), [shuf, addAll, shareB]))

    // 标签页：热门歌曲 / 专辑
    let aTab = 'hot'
    const tabWrap = el('div', 'tabs')
    const tabHot = el('button', 'on', '热门歌曲')
    const tabAlbums = el('button', '', '专辑 (' + d.albums.length + ')')
    tabWrap.appendChild(tabHot); tabWrap.appendChild(tabAlbums)
    v.appendChild(tabWrap)
    const tabContent = el('div')
    v.appendChild(tabContent)

    const renderHot = () => {
      tabContent.innerHTML = ''
      // 热门歌曲：同曲目数排序不够（全部同歌手），改为按名称字母序取前 20 作为"热门"
      const hot = d.tracks.slice(0, 20)
      tabContent.appendChild(trackTable(hot, { showSinger: false, menu: true, autoScroll: true }))
    }
    const renderAlbums = () => {
      tabContent.innerHTML = ''
      if (!d.albums.length) { tabContent.appendChild(el('div', 'empty', '暂无专辑')); return }
      const grid = el('div', 'grid')
      grid.style.marginBottom = '24px'
      for (const a of d.albums) {
        const c = el('div', 'card')
        c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover'))
        c.appendChild(el('div', 't', a.name))
        c.appendChild(el('div', 's', a.count + ' 首'))
        c.onclick = () => { location.hash = '#/album?singer=' + encodeURIComponent(singer) + '&album=' + encodeURIComponent(a.name) }
        grid.appendChild(c)
      }
      tabContent.appendChild(grid)
    }
    tabHot.onclick = () => { aTab = 'hot'; tabHot.classList.add('on'); tabAlbums.classList.remove('on'); renderHot() }
    tabAlbums.onclick = () => { aTab = 'albums'; tabAlbums.classList.add('on'); tabHot.classList.remove('on'); renderAlbums() }
    renderHot()
  }

  // ---------------- 视图：歌单 ----------------
  /**
   * 「我的歌单」区块。作为歌单页的 tab 使用时传 { title: false }：
   * tab 名已经写着「我的歌单」，再来一个同名大标题就是两层重复，只留右上角的操作按钮。
   */
  const renderPlaylistsView = async (v, opt) => {
    const head = el('div', 'page-head')
    if (!opt || opt.title !== false) head.appendChild(el('h2', 'page', '我的歌单'))
    else head.classList.add('acts-only')
    const btns = el('div', 'btns')
    const newBtn = el('button', 'btn primary')
    newBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建歌单</span>'
    newBtn.title = '新建歌单'
    newBtn.onclick = async () => {
      const name = await prompt2('新建歌单', '')
      if (!name) return
      try {
        const d = await api('/api/playlists', { method: 'POST', body: { name } })
        await refreshPlaylists()
        location.hash = '#/playlist/' + encodeURIComponent(d.id)
      } catch (e) { toast(e.message, true) }
    }
    btns.appendChild(newBtn)
    head.appendChild(btns)
    v.appendChild(head)
    await refreshPlaylists()
    const grid = el('div', 'grid')
    for (const pl of playlistsCache) {
      const c = el('div', 'card')
      const cov = el('div', 'cover')
      cov.innerHTML = pl.id === 'love'
        ? '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.8-5-7.8-10.2A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.8 2.7C19.8 15.5 12 20.5 12 20.5Z"/></svg>'
        : pl.id === 'default'
          ? '<svg viewBox="0 0 24 24"><path d="M9 18.5V5.5L21 3.2v13"/><circle cx="6.5" cy="18.5" r="2.8"/><circle cx="18.5" cy="16.2" r="2.8"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4V20.5H6Z"/><path d="M14 3.5v4h4"/><path d="M9.5 12h5M9.5 16h5"/></svg>'
      c.appendChild(cov)
      c.appendChild(el('div', 't', pl.name))
      c.appendChild(el('div', 's', pl.count + ' 首'))
      c.onclick = () => { location.hash = '#/playlist/' + encodeURIComponent(pl.id) }
      grid.appendChild(c)
    }
    v.appendChild(grid)
  }

  routes.playlists = async () => {
    setActiveNav('albums', '我的歌单')
    const v = $('#view')
    await renderPlaylistsView(v)
  }

  routes.playlist = async (args) => {
    const id = decodeURIComponent(args.join('/'))
    const v = $('#view')
    const d = await api('/api/playlists/' + encodeURIComponent(id))
    // 歌单详情属于「歌单」这一段：侧边栏高亮它，顶栏换成歌单自己的名字
    setActiveNav('albums', d.name || '歌单')
    const isFixed = id === 'default' || id === 'love'
    // 歌单里的曲目有两种：本地曲库项（source=local）与在线音源项（手机端同步进来的、
    // 以及 Web 端「加入我喜欢」存进来的）。后者带着 source + id，Web 端能解析直链播放，
    // 所以这里必须把 source/rid 保留下来，不能一律当成「不可播的第三方项」。
    const tracks = d.tracks.map(m => {
      const src = m.source || 'local'
      if (!m.trackId && src !== 'local') {
        return {
          id: m.id, kind: 'online', source: src,
          // 存的 id 是 <source>_<rid>；rid 用于拼 /web/media/online/<source>/<rid>
          rid: String(m.id || '').replace(/^[A-Za-z][A-Za-z0-9]*_/, ''),
          name: m.name, singer: m.singer, album: (m.meta && m.meta.albumName) || '',
          interval: parseInterval(m.interval) * 1000,
          pic: (m.meta && m.meta.picUrl) || '',
          online: true, missing: false, hasCover: false,
          _musicId: m.id,
          _listId: id,
        }
      }
      return {
        id: m.trackId || m.id,
        name: m.name, singer: m.singer, album: (m.meta && m.meta.albumName) || '',
        interval: m.interval,
        online: false,
        // 曲库里已没有这个 id（文件被删/改名/外部移动后重扫）：引用失效，只能从歌单移除
        missing: !!m.missing,
        hasCover: !!m.trackId && !m.missing,
        _musicId: m.id,
        _listId: id,
      }
    })
    const playable = tracks.filter(t => !t.missing && (t.kind === 'online' ? !!t.rid : true))
    const deadCount = tracks.filter(t => t.missing).length
    const rmBtn = el('button', 'btn')
    rmBtn.textContent = '🗑 删除歌单'
    rmBtn.onclick = async () => {
      if (await confirm2('删除歌单', '确定删除「' + d.name + '」？所有设备上同步移除。')) {
        try {
          await api('/api/playlists/remove', { method: 'POST', body: { ids: [id] } })
          toast('已删除')
          location.hash = '#/home'
          refreshPlaylists()
        } catch (e) { toast(e.message, true) }
      }
    }
    const clrBtn = el('button', 'btn')
    clrBtn.textContent = '清空'
    clrBtn.onclick = async () => {
      if (await confirm2('清空歌单', '确定清空「' + d.name + '」里的 ' + tracks.length + ' 首歌？')) {
        await api('/api/playlists/' + encodeURIComponent(id) + '/clear', { method: 'POST' })
        toast('已清空')
        route()
        refreshPlaylists()
      }
    }
    const rnBtn = el('button', 'btn')
    rnBtn.textContent = '✎ 重命名'
    rnBtn.onclick = async () => {
      const name = await prompt2('重命名歌单', d.name)
      if (!name) return
      await api('/api/playlists/' + encodeURIComponent(id) + '/rename', { method: 'POST', body: { name } })
      toast('已重命名')
      refreshPlaylists()
    }
    const extra = []
    if (!isFixed) extra.push(rnBtn)
    extra.push(clrBtn)
    if (!isFixed) extra.push(rmBtn)
    const thirdCount = tracks.length - playable.length - deadCount
    const metaText = tracks.length + ' 首'
      + (thirdCount > 0 ? '（' + thirdCount + ' 首缺少音源信息，无法播放）' : '')
      + (deadCount > 0 ? '（' + deadCount + ' 首引用已失效，可从行内 × 移除）' : '')
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => { if (playable.length) player.shufflePlay(playable); else toast('歌单里没有可播放的曲目', true) }
    // 分享歌单：快照当前歌单内容（之后改歌单不影响已发出的链接）；在线源曲目服务端会自动跳过
    const shareB = el('button', 'btn')
    shareB.innerHTML = SVG.share + '<span>分享歌单</span>'
    shareB.onclick = () => shareDialog({ type: 'playlist', listId: id, title: d.name, count: playable.length })
    v.appendChild(heroBlock(tracks.find(hasCoverOf), d.name, metaText, () => playable.length && player.play(playable, 0), [shuf, shareB, ...extra]))
    if (!tracks.length) {
      v.appendChild(el('div', 'empty', '歌单还是空的，去曲库添加喜欢的歌吧'))
      return
    }
    const table = trackTable(tracks, { menu: true, order: !isFixed, autoScroll: true })
    // 内置歌单（我的歌单/我喜欢）平时不给移除按钮，但失效引用必须能清掉：
    // 否则它是一行永远删不掉的幽灵曲目（点「删除」只会得到「曲目不存在」）
    if (!isFixed || deadCount > 0) {
      const tbody = table.querySelector('tbody')
      tbody.querySelectorAll('tr').forEach((tr, i) => {
        if (isFixed && !tracks[i].missing) return
        const acts = tr.querySelector('.acts .more-wrap')
        if (!acts) return
        const b = el('button', 'iconbtn', '×')
        b.title = tracks[i].missing ? '从歌单移除此失效引用' : '从歌单移除'
        b.style.marginLeft = '4px'
        b.onclick = async (e) => {
          e.stopPropagation()
          await api('/api/playlists/' + encodeURIComponent(id) + '/remove', { method: 'POST', body: { musicIds: [tracks[i]._musicId] } })
          toast('已移除')
          route()
          refreshPlaylists()
        }
        acts.appendChild(b)
      })
    }
    v.appendChild(table)
  }

  // 侧边栏「歌单」区（列表 + 新建）已删除：歌单全部收进「专辑 / 歌单」页的「我的歌单」tab，
  // 新建入口就在那个 tab 里，不再有两套入口各自为政。

  // ---------------- 视图：搜索 ----------------
  // ---------------- 视图：搜索（一次搜全部在线平台） ----------------
  // 主人 2026-09-15 决定：搜索框不再查本地曲库，改为一次并发查全部已启用在线源。
  // 服务端 /web/api/downloads/search 已按「歌名 + 歌手」跨源合并去重（含 &nbsp; 解码、
  // 默认挑有封面且优先级高的源），前端只负责渲染 + 切源 + 播放 + 下载。
  routes.search = async (args, query) => {
    setActiveNav('search')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '搜索'))
    const box = el('div', 'search-box')
    const input = el('input')
    input.placeholder = '搜索歌曲、歌手…（一次搜全部平台）'
    input.autocomplete = 'off'
    const btn = el('button', 'btn primary', '搜索')
    box.appendChild(input)
    box.appendChild(btn)
    v.appendChild(box)
    v.appendChild(histChips('gusi-lh', (q) => { input.value = q; doSearch() }))
    const result = el('div')
    v.appendChild(result)

    const SRC_LABEL = { kw: '酷我', wy: '网易云', mg: '咪咕', soda: '汽水' }
    const srcLabel = (id) => SRC_LABEL[id] || srcName(id) || id
    const st = { q: '', list: [], perSource: [], loading: false }
    const q0 = new URLSearchParams(query).get('q') || ''

    /** 合并行 → 播放行：队列/歌词/媒体流全靠 kind=online + source + rid 解析 */
    const toRows = (list) => list.map(r => ({
      id: r.source + '_' + String(r.id == null ? '' : r.id).replace(/^MUSIC_/, ''), kind: 'online',
      source: r.source, rid: r.id,
      name: r.name, singer: r.singer, album: r.album,
      interval: r.intervalMs, pic: r.pic,
    }))

    /** 单行：封面 / 歌名（多平台时给切源下拉）/ 专辑 / 时长 / 播放·下载 */
    const SEARCH_TBL_OPTS = { noSelect: true, showLove: false, menu: true, actsLabel: '操作' }
    const buildRow = (r, i) => {
      const cells = {}
      cells.num = el('td', 'num', String(i + 1))
      const tdCov = el('td', 'cov')
      const paintCov = () => { tdCov.innerHTML = ''; tdCov.appendChild(picImg(r.pic, null, (r.name || '') + (r.singer || ''))) }
      paintCov()
      cells.cov = tdCov

      const tdName = el('td')
      tdName.appendChild(el('div', 'dl-nm', r.name || '未知曲目'))
      const sub = el('div', 'dl-sub')
      sub.appendChild(el('span', 'dl-sg', r.singer || '未知歌手'))
      let tdAlbum = null, tdDur = null
      if ((r.choices || []).length > 1) {
        const sel = el('select', 'dl-src-sel')
        sel.title = '这首歌在 ' + r.choices.length + ' 个平台都有，可切换来源'
        for (const c of r.choices) {
          const o = document.createElement('option')
          o.value = c.source
          o.textContent = srcLabel(c.source)
          sel.appendChild(o)
        }
        sel.value = r.source
        sel.onclick = (e) => e.stopPropagation()
        sel.onchange = () => {
          const c = (r.choices || []).find(x => x.source === sel.value)
          if (!c) return
          r.source = c.source; r.id = c.id; r.intervalMs = c.intervalMs
          if (c.pic && c.pic !== r.pic) { r.pic = c.pic; paintCov() }
          if (c.album) { r.album = c.album; if (tdAlbum) tdAlbum.textContent = c.album }
          if (tdDur) tdDur.textContent = fmtDur((r.intervalMs || 0) / 1000)
          // 换了平台就是另一首歌：收藏态跟着重算
          bLove.classList.toggle('loved', isLoved(loveTarget()))
          bLove.title = isLoved(loveTarget()) ? '取消喜欢' : '加入我喜欢'
        }
        sub.appendChild(sel)
      } else if (r.source) {
        sub.appendChild(el('span', 'dl-src-tag', srcLabel(r.source)))
      }
      tdName.appendChild(sub)
      cells.name = tdName

      tdAlbum = el('td', 'album-col ell', r.album || '—')
      cells.album = tdAlbum
      tdDur = el('td', 'dur', fmtDur((r.intervalMs || 0) / 1000))
      cells.dur = tdDur

      const tdAct = el('td', 'acts')
      // 行内数据是「搜索结果」（source + 原始 id），而收藏要的是「播放行」（kind/rid）；
      // 用函数取当前行：切源下拉改了 source/id 后，心形的收藏态跟着重算
      const loveTarget = () => asOnlineRows([r])[0]
      const bLove = loveBtn(loveTarget)
      const bPlay = el('button', 'iconbtn')
      // el() 的第三个参数是 textContent：图标必须走 innerHTML，否则 SVG 源码会被转义成文本显示
      bPlay.innerHTML = SVG.play
      bPlay.title = '播放'
      bPlay.onclick = (e) => { e.stopPropagation(); player.play(toRows(st.list), i) }
      const bDl = el('button', 'iconbtn dl')
      bDl.innerHTML = SVG.dl
      bDl.title = '下载'
      bDl.onclick = (e) => { e.stopPropagation(); askDownload(asOnlineRows([r]), bDl) }
      // 顺序固定为 ▶ ⬇ ♥：起播/下载仍是行内头两个动作，收藏排在最后（与既有操作习惯一致）
      tdAct.appendChild(bPlay)
      tdAct.appendChild(bDl)
      tdAct.appendChild(bLove)
      cells.acts = tdAct

      const tr = trackRowEl(SEARCH_TBL_OPTS, cells)
      tr.onclick = (e) => {
        if (e.target.closest('select, button, input, a')) return
        player.play(toRows(st.list), i)
      }
      return tr
    }

    const paint = () => {
      result.innerHTML = ''
      if (!st.q) return
      const head = el('div', 'row-head')
      head.appendChild(el('h3', null, '「' + st.q + '」· ' + st.list.length + ' 首'))
      const btns = el('div', 'btns')
      const bAll = el('button', 'btn ghost')
      bAll.innerHTML = SVG.play + '<span>播放全部</span>'
      bAll.disabled = !st.list.length
      bAll.onclick = () => player.play(toRows(st.list), 0)
      const bShuf = el('button', 'btn ghost')
      bShuf.innerHTML = SVG.shuffle + '<span>随机播放</span>'
      bShuf.disabled = !st.list.length
      bShuf.onclick = () => player.shufflePlay(toRows(st.list))
      btns.appendChild(bAll)
      btns.appendChild(bShuf)
      head.appendChild(btns)
      result.appendChild(head)

      const hit = (st.perSource || []).filter(x => x.count > 0).map(x => srcLabel(x.id) + ' ' + x.count)
      const bad = (st.perSource || []).filter(x => x.error).map(x => srcLabel(x.id))
      if (hit.length || bad.length) {
        result.appendChild(el('div', 'sr-meta',
          '平台命中：' + (hit.join(' · ') || '无') + (bad.length ? ' · 未响应：' + bad.join('、') : '')))
      }
      if (!st.list.length) {
        result.appendChild(el('div', 'empty', st.perSource.length
          ? '没有找到相关歌曲，换个关键词试试'
          : '在线音源已在管理后台停用，请到「音源与代理」页开启后再搜索'))
        return
      }
      const tbl = el('table', 'tracks sr-tbl')
      const thead = el('thead')
      thead.appendChild(trackHead(SEARCH_TBL_OPTS))
      tbl.appendChild(thead)
      const tbody = el('tbody')
      st.list.forEach((r, i) => tbody.appendChild(buildRow(r, i)))
      tbl.appendChild(tbody)
      result.appendChild(tbl)
    }

    const doSearch = async () => {
      const q = input.value.trim()
      if (!q || st.loading) return
      pushHist('gusi-lh', q)
      // 写进地址栏，刷新/分享能回到同一结果；已经是这个关键词就不再改（避免 hashchange 重跑一遍）
      if (new URLSearchParams(query).get('q') !== q) location.hash = '#/search?q=' + encodeURIComponent(q)
      st.q = q
      st.loading = true
      st.list = []
      st.perSource = []
      result.innerHTML = ''
      result.appendChild(el('div', 'dl-loading', '正在搜索全部平台…'))
      try {
        const d = await api('/api/downloads/search?q=' + encodeURIComponent(q) + '&size=30')
        st.list = d.list || []
        st.perSource = d.perSource || []
      } catch (e) {
        st.loading = false
        result.innerHTML = ''
        result.appendChild(el('div', 'empty', '搜索失败：' + e.message))
        return
      }
      st.loading = false
      paint()
    }

    btn.onclick = doSearch
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch() })
    if (q0) { input.value = q0; doSearch() }
    else input.focus()
  }

  // ---------------- 视图：在线音乐 v2（搜索 / 榜单） ----------------
  let onlChips = null
  let onlTabs = null
  let onlArea = null
  // view 默认 'plaza'（平台歌单广场）：进在线音乐先看歌单，想看搜索框点「搜索」tab
  let ostate = { view: 'plaza', type: 'song', q: '', source: 'kw', page: 0, size: 20, total: 0, list: [], boards: [], bid: '', loading: false, autoRun: false }
  // 歌单广场缓存（按音源各存一份 batch/list/hint），切回来不必重放请求
  const plazaState = new Map()

  // ---- 在线列表：多选 + 批量下载 ----
  // selCtx.list 绑定当前渲染的在线列表，sel 存 rid（切换视图时重置）
  let selCtx = { list: [], sel: new Set() }
  const initSel = (rows) => {
    selCtx = { list: rows || [], sel: new Set() }
    setTimeout(syncSel, 0)
  }
  /**
   * 列表原地扩容/刷新时重新绑定引用，保留已勾选项。
   * initSel 会清空选中，只适合切换视图；而 list.concat() 会产生新数组，
   * 不重绑的话批量按钮的 filter 会落在旧数组上（表现为「勾了却说没勾」）。
   */
  const rebindSel = (rows) => { selCtx.list = rows || []; syncSel() }
  const selRid = (t) => String(t.rid || t.id || '')
  const syncSel = () => {
    const n = selCtx.sel.size
    document.querySelectorAll('.dl-sel').forEach(b => {
      b.disabled = n === 0
      const sp = b.querySelector('span')
      if (sp) sp.textContent = '下载选中 (' + n + ')'
    })
    // 删除只对本地曲目有效（在线曲目属于音源，删不了），故单独计数
    const nLocal = selCtx.list.filter(t => selCtx.sel.has(selRid(t)) && !t.online).length
    document.querySelectorAll('.del-sel').forEach(b => {
      b.disabled = nLocal === 0
      const sp = b.querySelector('span')
      if (sp) sp.textContent = '删除选中 (' + nLocal + ')'
    })
    // 加入歌单同样只认本地曲目，与删除共用一个计数
    document.querySelectorAll('.pl-sel').forEach(b => {
      b.disabled = nLocal === 0
      const sp = b.querySelector('span')
      if (sp) sp.textContent = '加入歌单 (' + nLocal + ')'
    })
    // 分享也只认本地曲目（在线曲目没有可打包的文件）
    document.querySelectorAll('.share-sel').forEach(b => {
      b.disabled = nLocal === 0
      const sp = b.querySelector('span')
      if (sp) sp.textContent = '分享选中 (' + nLocal + ')'
    })
    // 收藏同样只认本地曲目（本页的在线行不在列表里，无从勾选）
    document.querySelectorAll('.love-sel').forEach(b => {
      b.disabled = nLocal === 0
      const sp = b.querySelector('span')
      if (sp) sp.textContent = '喜欢选中 (' + nLocal + ')'
    })
    const boxes = document.querySelectorAll('.row-sel')
    const hdr = document.querySelector('.all-sel')
    if (hdr) {
      hdr.checked = boxes.length > 0 && n === boxes.length
      hdr.indeterminate = n > 0 && n < boxes.length
    }
  }
  const selHeadCell = () => {
    const th = el('th', 'sel-col')
    const box = el('input')
    box.type = 'checkbox'
    box.className = 'all-sel'
    box.title = '全选 / 取消全选'
    box.onchange = () => {
      selCtx.sel.clear()
      document.querySelectorAll('.row-sel').forEach(b => {
        b.checked = box.checked
        if (box.checked && b.dataset.rid) selCtx.sel.add(b.dataset.rid)
      })
      syncSel()
    }
    th.appendChild(box)
    return th
  }
  const selRowCell = (t) => {
    const td = el('td', 'sel-col')
    const rid = selRid(t)
    const box = el('input')
    box.type = 'checkbox'
    box.className = 'row-sel'
    box.dataset.rid = rid
    box.checked = selCtx.sel.has(rid)
    box.onclick = (e) => e.stopPropagation()
    box.onchange = () => {
      if (box.checked) selCtx.sel.add(rid)
      else selCtx.sel.delete(rid)
      syncSel()
    }
    td.appendChild(box)
    return td
  }
  const toEnqueueItem = (t) => ({
    source: t.source, id: t.rid || t.id, name: t.name, singer: t.singer,
    intervalMs: t.interval, pic: t.pic, album: t.album,
  })
  /** 「下载选中 (n)」按钮：读取当前列表的勾选项 */
  const selDlBtn = (cls) => {
    const b = el('button', (cls || 'btn mini ghost') + ' dl-sel')
    b.innerHTML = SVG.dl + '<span>下载选中 (0)</span>'
    b.disabled = true
    b.onclick = () => {
      const items = selCtx.list.filter(t => selCtx.sel.has(selRid(t)))
      if (!items.length) { toast('请先勾选要下载的歌曲', true); return }
      askDownload(asOnlineRows(items), b)
    }
    return b
  }
  /** 「删除选中 (n)」按钮：只对本地曲目生效（在线曲目属于音源，删不了） */
  const selDelBtn = (cls) => {
    const b = el('button', (cls || 'btn mini ghost') + ' del-sel')
    b.innerHTML = SVG.trash + '<span>删除选中 (0)</span>'
    b.disabled = true
    b.onclick = () => {
      const items = selCtx.list.filter(t => selCtx.sel.has(selRid(t)) && !t.online)
      if (!items.length) { toast('请先勾选要删除的本地歌曲', true); return }
      askDeleteTracks(items)
    }
    return b
  }
  /** 「加入歌单 (n)」按钮：歌单目前只存曲库内曲目，故与删除共用「本地曲目」计数 */
  const selPlBtn = (cls) => {
    const b = el('button', (cls || 'btn mini ghost') + ' pl-sel')
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 17.5V6.2l10-2v11.3"/><circle cx="6.6" cy="17.5" r="2.6"/><circle cx="16.6" cy="15.5" r="2.6"/></svg><span>加入歌单 (0)</span>'
    b.disabled = true
    b.onclick = () => askAddToPlaylist(selCtx.list.filter(t => selCtx.sel.has(selRid(t)) && !t.online))
    return b
  }
  /** 「喜欢选中 (n)」按钮：批量把本地曲目收进「我喜欢」（已在列表里的服务端会跳过） */
  const selLoveBtn = (cls) => {
    const b = el('button', (cls || 'btn mini ghost') + ' love-sel')
    b.innerHTML = SVG.heart + '<span>喜欢选中 (0)</span>'
    b.disabled = true
    b.onclick = async () => {
      const items = selCtx.list.filter(t => selCtx.sel.has(selRid(t)) && !t.online && !t.missing && t.id)
      if (!items.length) { toast('请先勾选要收藏的本地歌曲', true); return }
      try {
        const r = await api('/api/love/add', { method: 'POST', body: { trackIds: items.map(t => String(t.id)) } })
        const rel = await api('/api/love-ids').catch(() => null)
        if (rel) loveIds = new Set(rel.ids)
        toast(r.added ? '已加入我喜欢 ' + r.added + ' 首' : '这些曲目都已经在我喜欢里了')
        route()
      } catch (e) { toast(e.message, true) }
    }
    return b
  }
  /** 「分享选中 (n)」按钮：只分享云盘曲目（在线曲目没有稳定文件，服务端会跳过） */
  const selShareBtn = (cls) => {
    const b = el('button', (cls || 'btn mini ghost') + ' share-sel')
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v11"/><path d="M8 7l4-4 4 4"/><path d="M5 14v5.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V14"/></svg><span>分享选中 (0)</span>'
    b.disabled = true
    b.onclick = () => {
      const items = selCtx.list.filter(t => selCtx.sel.has(selRid(t)) && !t.online && t.id && !t.missing)
      if (!items.length) { toast('请先勾选要分享的云盘歌曲', true); return }
      shareDialog({
        type: 'track',
        ids: items.map(t => String(t.id)),
        title: items.length === 1 ? items[0].name : '分享 ' + items.length + ' 首歌曲',
        subtitle: items.length === 1 ? (items[0].singer || '') : '',
        count: items.length,
      })
    }
    return b
  }

  /**
   * 分享弹窗：免登录可听，默认 7 天有效期、可选提取码、默认允许下载。
   * target: { type: 'track'|'playlist'|'album'|'artist', title, subtitle, count, ids?|listId?|album?|artist? }
   */
  function shareDialog(target) {
    const box = $('#share-dialog')
    if (!box) return
    const what = $('#share-what'), daysSel = $('#share-days'), passOn = $('#share-pass-on')
    const passInput = $('#share-pass'), dlCb = $('#share-dl')
    const result = $('#share-result'), link = $('#share-link'), tip = $('#share-tip')
    const msg = $('#share-msg'), okBtn = $('#share-ok'), cancelBtn = $('#share-cancel')
    const typeText = { track: '单曲', playlist: '歌单', album: '专辑', artist: '歌手' }[target.type] || '音乐'
    what.innerHTML = ''
    what.appendChild(el('div', 'share-w-title', target.title || '未命名分享'))
    what.appendChild(el('div', 'share-w-sub', typeText + ' · ' + target.count + ' 首曲目' + (target.subtitle ? ' · ' + target.subtitle : '')))
    // 每次打开都回到初始态：7 天 / 无提取码 / 允许下载
    daysSel.value = '7'
    passOn.checked = false
    passInput.value = ''
    passInput.disabled = true
    dlCb.checked = true
    result.hidden = true
    link.value = ''
    msg.hidden = true
    okBtn.textContent = '生成链接'
    okBtn.disabled = false
    box.hidden = false
    passOn.onchange = () => {
      passInput.disabled = !passOn.checked
      if (passOn.checked) passInput.focus()
    }
    $('#share-copy').onclick = async () => {
      if (!link.value) return
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(link.value)
        else { link.select(); document.execCommand('copy') }
        toast('链接已复制')
      } catch { link.select(); toast('请手动复制链接') }
    }
    const close = () => {
      box.hidden = true
      okBtn.onclick = cancelBtn.onclick = null
    }
    cancelBtn.onclick = close
    okBtn.onclick = async () => {
      // 已生成 → 按钮变「完成」，关闭即可
      if (!result.hidden) { close(); return }
      const days = parseInt(daysSel.value, 10)
      const password = passOn.checked ? passInput.value.trim() : ''
      if (passOn.checked && (password.length < 4 || password.length > 16)) {
        msg.textContent = '提取码需 4-16 位'
        msg.hidden = false
        return
      }
      okBtn.disabled = true
      try {
        const d = await api('/api/share/create', {
          method: 'POST',
          body: {
            type: target.type, ids: target.ids, listId: target.listId,
            album: target.album, artist: target.artist,
            title: target.title, subtitle: target.subtitle,
            days, password, allowDownload: dlCb.checked,
          },
        })
        link.value = d.url
        const expire = d.expiresAt ? new Date(d.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '永久有效'
        tip.textContent = '链接有效期至 ' + expire + '，拿到链接的人免登录即可收听'
          + (dlCb.checked ? '、可下载' : '（已关闭下载）')
          + (d.skipped ? '；' + d.skipped + ' 首无法分享已跳过（仅支持云盘曲目）' : '')
          + '。可在「设置 → 我的分享」里随时撤销。'
        result.hidden = false
        msg.hidden = true
        okBtn.textContent = '完成'
        try { link.select() } catch {}
      } catch (e) {
        msg.textContent = e.message
        msg.hidden = false
      } finally {
        okBtn.disabled = false
      }
    }
  }

  /**
   * 删除本地曲目。
   * 服务端做的是软删除：文件被移入所在曲库目录下的 .gusi-trash/，并非抹除。
   * 应用内有「回收站」页可恢复/彻底删除，文案如实说明去向，而不是含糊的「已删除」。
   */
  async function askDeleteTracks(items, onDone) {
    if (!items || !items.length) return
    const head = items.slice(0, 3).map(t => '「' + t.name + '」').join('、')
    const rest = items.length > 3 ? ' 等 ' + items.length + ' 首' : ''
    const okDel = await confirm2(
      '删除 ' + items.length + ' 首歌曲',
      head + rest + ' —— 文件将移入「回收站」，可在应用内随时恢复（也可以从 NAS 手动找回）。'
    )
    if (!okDel) return
    let r
    try {
      r = await api('/api/tracks/delete', { method: 'POST', body: { ids: items.map(t => t.id) } })
    } catch (e) { toast(e.message, true); return }
    if (r.removed) {
      let msg = '已删除 ' + r.removed + ' 首，可在「回收站」恢复'
      if (r.playlists && r.playlists.length) msg += '，并已从「' + r.playlists.join('」「') + '」移除引用'
      if (r.failed && r.failed.length) msg += '，' + r.failed.length + ' 首已跳过'
      toast(msg)
    } else {
      const why = (r.failed && r.failed[0] && r.failed[0].reason) || '未知原因'
      toast('未能删除：' + why, true)
    }
    selCtx.sel.clear()
    if (onDone) onDone(r); else route()
  }
  /** 选一个目标歌单（排除内置的「我喜欢」）；取消返回 null */
  async function pickPlaylist() {
    await refreshPlaylists()
    const targets = playlistsCache.filter(p => p.id !== 'love')
    if (!targets.length) { toast('还没有歌单，先在侧栏新建一个', true); return null }
    const names = targets.map((p, i) => (i + 1) + '. ' + p.name).join('\n')
    const input = await prompt2('添加到歌单（输入序号）\n' + names, '1')
    const n = parseInt(input || '0', 10) - 1
    if (n < 0 || n >= targets.length) return null
    return targets[n]
  }
  /** 把若干本地曲目加入歌单；行内单曲入口与页头批量入口共用 */
  async function askAddToPlaylist(items) {
    const list = (items || []).filter(t => !t.online && t.id)
    if (!list.length) { toast('请先勾选要加入歌单的本地歌曲', true); return }
    const target = await pickPlaylist()
    if (!target) return
    try {
      await api('/api/playlists/' + encodeURIComponent(target.id) + '/add', { method: 'POST', body: { trackIds: list.map(t => String(t.id)) } })
      toast('已把 ' + list.length + ' 首加入「' + target.name + '」')
      refreshPlaylists()
    } catch (e) { toast(e.message, true) }
  }
  /**
   * 重命名曲目文件。服务端会把新名字同步写回 title 标签（列表显示名优先取标签，
   * 只改文件名的话看着像没生效），并迁移歌单/我喜欢/最近播放里对旧 id 的引用。
   */
  async function askRenameTrack(track) {
    const def = track.name || ''
    const name = await prompt2('重命名（改文件名，并同步写回标题标签）', def, '重命名')
    if (!name || name === def) return
    let r
    try {
      r = await api('/api/tracks/rename', { method: 'POST', body: { id: track.id, name } })
    } catch (e) { toast(e.message, true); return }
    const parts = ['已重命名为「' + (r.renamed || name) + '」']
    const pls = r.playlists || []
    if (pls.length) parts.push('已同步 ' + pls.length + ' 个歌单的引用')
    if (r.warning) toast(parts.join('，') + '；' + r.warning, true)
    else toast(parts.join('，'))
    route()
  }
  /** 标签编辑表单：返回各字段值对象，取消返回 null */
  function tagForm(init) {
    return new Promise((resolve) => {
      const box = $('#tag-dialog')
      const map = { title: '#tag-title', artist: '#tag-artist', album: '#tag-album', year: '#tag-year', trackNum: '#tag-track' }
      Object.keys(map).forEach(k => { $(map[k]).value = init[k] || '' })
      const msg = $('#tag-msg')
      msg.hidden = true
      box.hidden = false
      $('#tag-title').focus()
      $('#tag-title').select()
      const done = (v) => {
        box.hidden = true
        $('#tag-ok').onclick = $('#tag-cancel').onclick = null
        resolve(v)
      }
      $('#tag-ok').onclick = () => {
        const out = {}
        Object.keys(map).forEach(k => { out[k] = $(map[k]).value.trim() })
        // 留空 = 不修改；全空则没有可提交的内容
        if (!Object.keys(out).some(k => out[k])) {
          msg.textContent = '请至少填写一项（留空表示不修改）'
          msg.hidden = false
          return
        }
        done(out)
      }
      $('#tag-cancel').onclick = () => done(null)
    })
  }
  /** 编辑标签：留空 = 不修改，服务端合并式写入，内嵌封面等未提交字段原样保留 */
  async function askEditTags(track) {
    const v = await tagForm({
      title: track.name || '',
      artist: (track.singer && track.singer !== '未知歌手') ? track.singer : '',
      album: (!track.album || track.album === '未知专辑') ? '' : track.album,
      year: track.year || '',
      trackNum: track.trackNum ? String(track.trackNum) : '',
    })
    if (!v) return
    try {
      await api('/api/tracks/tags', { method: 'POST', body: { id: track.id, tags: v } })
      toast('标签已保存')
    } catch (e) { toast(e.message, true); return }
    route()
  }
  // 在线集合（专辑/歌单）详情缓存：{ source,type,id } -> OnlineCollectionDetail
  let onlColl = null
  /** 集合详情是从哪个 tab 点进来的（'plaza' / 'search'）——详情页的「返回」要回到原处 */
  let onlFrom = 'plaza'
  const onlineRow = (t, idx, list) => {
    const opts = ONLINE_TABLE_OPTS
    const cells = {}
    cells.sel = selRowCell(t)
    cells.num = el('td', 'num', String(idx + 1))
    const tdCov = el('td', 'cov')
    const im = el('img')
    im.loading = 'lazy'
    im.alt = ''
    tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
    cells.cov = tdCov
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    tdName.appendChild(el('div', 'sub', t.singer || '未知歌手'))
    cells.name = tdName
    cells.album = el('td', 'album-col ell', t.album || '—')
    // 收藏列：在线曲目与本地曲目共用「我喜欢」列表（服务端按 source+rid 存 MusicInfo）
    const tdLove = el('td', 'love')
    tdLove.appendChild(loveBtn(t))
    cells.love = tdLove
    // 下载独立成列（原来塞在「时长」格里，把时长列撑变形、表头也对不上）：
    // 操作键成组停在专辑右边，不再孤零零挂在表格最右侧。
    const tdDl = el('td', 'dl-col')
    const dbtn = el('button', 'iconbtn dl')
    dbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg>'
    dbtn.title = '下载'
    dbtn.setAttribute('aria-label', '下载')
    dbtn.onclick = (e) => {
      e.stopPropagation()
      askDownload(asOnlineRows([t]), dbtn)
    }
    tdDl.appendChild(dbtn)
    cells.dl = tdDl
    cells.dur = el('td', 'dur', fmtDur(t.interval / 1000))
    // 播放不再单独给按钮：整行点击就是播放（原来的行内「播放」按钮在歌单详情里
    // 传的是搜索列表 ostate.list，点下去播的不是这一行），行内只留下载。
    const tr = trackRowEl(opts, cells)
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    // list 必须是「当前渲染的这一份列表」——歌单详情里它与 ostate.list 不是同一个数组
    tr.onclick = () => { if (list && list.length) player.play(list, idx) }
    return tr
  }
  /** 在线曲目表的列配置：表头与行必须共用同一份，改这里两处一起变 */
  const ONLINE_TABLE_OPTS = { dl: true }
  /** 下载中心结果表：勾选列 + 操作列，没有收藏列（收藏按钮在操作格里） */
  const DL_TBL_OPTS = { noNum: true, showLove: false, menu: true, actsLabel: '操作' }
  const onTableHead = (thead) => {
    thead.appendChild(trackHead(ONLINE_TABLE_OPTS))
  }
  const srcName = (id) => id === 'wy' ? '网易云音乐' : id === 'kw' ? '酷我音乐' : id === 'mg' ? '咪咕音乐' : id || ''
  const paintSearchTable = (container) => {
    const info = container.querySelector('.res-info')
    const allBtn = container.querySelector('.play-all')
    if (info) info.textContent = ostate.q ? '「' + ostate.q + '」 · ' + srcName(ostate.source) + ' · 共 ' + ostate.total + ' 首' : ''
    if (allBtn) allBtn.hidden = !ostate.list.length
    const result = container.querySelector('.res')
    result.innerHTML = ''
    const tbl = el('table', 'tracks')
    const thead = el('thead'); onTableHead(thead); tbl.appendChild(thead)
    const tbody = el('tbody')
    ostate.list.forEach((t, i) => tbody.appendChild(onlineRow(t, i, ostate.list)))
    tbl.appendChild(tbody)
    result.appendChild(tbl)
    const more = el('button', 'load-more')
    more.hidden = ostate.total <= ostate.list.length
    more.textContent = '加载更多（' + ostate.list.length + ' / ' + ostate.total + '）'
    more.onclick = () => loadSearch(container)
    result.appendChild(more)
  }
  const loadSearch = async (container) => {
    if (ostate.loading || !ostate.q) return
    ostate.loading = true
    try {
      const isColl = ostate.type === 'album' || ostate.type === 'playlist'
      const isArtist = ostate.type === 'artist'
      const d = await api('/api/online/search?source=' + encodeURIComponent(ostate.source) +
        '&q=' + encodeURIComponent(ostate.q) + '&type=' + ostate.type +
        '&page=' + (ostate.page + 1) + '&size=' + ostate.size)
      ostate.page++
      ostate.total = d.total
      if (isColl || isArtist) {
        ostate.list = ostate.page === 1 ? d.list : ostate.list.concat(d.list)
        if (ostate.page === 1) initSel(ostate.list); else rebindSel(ostate.list)
        if (isArtist) paintArtistGrid(container)
        else paintCollectionGrid(container)
      } else {
        const rows = d.list.map(x => ({
          id: x.source + '_' + x.id.replace(/^MUSIC_/, ''),
          kind: 'online', source: x.source, rid: x.id,
          name: x.name, singer: x.singer, album: x.album,
          interval: x.intervalMs, pic: x.pic,
        }))
        ostate.list = ostate.page === 1 ? rows : ostate.list.concat(rows)
        if (ostate.page === 1) initSel(ostate.list); else rebindSel(ostate.list)
        paintSearchTable(container)
      }
    } catch (e) { toast(e.message, true) }
    ostate.loading = false
  }
  const openBoard = async (b) => {
    ostate.view = 'board'
    ostate.bid = b.id
    ostate.list = []
    renderBoardDetail()
    try {
      const d = await api('/api/online/board?source=' + encodeURIComponent(ostate.source) + '&bid=' + encodeURIComponent(b.id) + '&limit=50')
      const rows = (d.list || []).map(x => ({
        id: x.source + '_' + x.id,
        kind: 'online', source: x.source, rid: x.id,
        name: x.name, singer: x.singer, album: x.album,
        interval: x.intervalMs, pic: x.pic,
      }))
      ostate.list = rows
      renderBoardDetail()
    } catch (e) { toast(e.message, true) }
  }
  const renderBoardDetail = () => {
    onlArea.innerHTML = ''
    const hd = el('div', 'board-head')
    const back = el('button', 'btn ghost mini', '← 全部榜单')
    back.onclick = () => { ostate.view = 'boards'; loadBoards() }
    hd.appendChild(back)
    const bname = (ostate.boards.find(b => b.id === ostate.bid) || {}).name || ''
    hd.appendChild(el('span', 'bh-name', bname || '排行榜'))
    const allBtn = el('button', 'btn primary mini play-all', '▶ 播放全部')
    allBtn.hidden = !ostate.list.length
    allBtn.onclick = () => { if (ostate.list.length) player.play(ostate.list, 0) }
    hd.appendChild(allBtn)
    const bDl = el('button', 'btn mini play-all dl-all')
    bDl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg>下载全部'
    bDl.hidden = !ostate.list.length
    bDl.onclick = () => {
      if (!ostate.list.length) return
      askDownload(asOnlineRows(ostate.list), bDl)
    }
    hd.appendChild(bDl)
    hd.appendChild(selDlBtn('btn mini ghost'))
    onlArea.appendChild(hd)
    initSel(ostate.list)
    if (!ostate.list.length) { onlArea.appendChild(skeletonRows(8)); return }
    const tbl = el('table', 'tracks')
    const thead = el('thead'); onTableHead(thead); tbl.appendChild(thead)
    const tbody = el('tbody')
    ostate.list.forEach((t, i) => tbody.appendChild(onlineRow(t, i, ostate.list)))
    tbl.appendChild(tbody)
    onlArea.appendChild(tbl)
  }
  const loadBoards = async () => {
    ostate.view = 'boards'
    renderArea()
    if (ostate.boards.length) return
    try {
      const d = await api('/api/online/boards?source=' + encodeURIComponent(ostate.source))
      ostate.boards = d.list || []
      renderArea()
    } catch (e) { toast(e.message, true) }
  }
  const renderArea = () => {
    if (ostate.source === '') { onlArea.innerHTML = ''; return }
    if (ostate.view === 'search') return renderSearch()
    if (ostate.view === 'plaza') return renderPlaza()
    if (ostate.view === 'boards') {
      onlArea.innerHTML = ''
      if (!ostate.boards.length) { onlArea.appendChild(skeletonGrid(8)); return }
      const grid = el('div', 'board-grid')
      ostate.boards.forEach((b, i) => {
        const card = el('div', 'bcard')
        card.appendChild(el('span', 'bnum', String(i + 1).padStart(2, '0')))
        const cap = el('div', 'bcap')
        cap.appendChild(el('div', 'bt', b.name))
        cap.appendChild(el('div', 'bs', '网易云音乐 · 官方榜'))
        card.appendChild(cap)
        card.onclick = () => openBoard(b)
        grid.appendChild(card)
      })
      onlArea.appendChild(grid)
      return
    }
    renderBoardDetail()
  }
  // ---- 歌单广场：默认视图，直接浏览当前音源的在线歌单（不用先搜索） ----
  const PLAZA_PER = 24

  /** 该音源的歌单能不能点开（详情接口受限的源只能看卡片） */
  const canOpenPlaylist = (source) => {
    const s = onlineSourcesCache.find(x => x.id === source)
    return !!s && (s.abilities || []).includes('playlist-detail')
  }

  /** 歌单卡片网格（歌单广场 / 歌单搜索共用同一套渲染） */
  const paintPlaylistCards = (source, list, container) => {
    const grid = el('div', 'grid coll-grid')
    for (const p of list) {
      const card = el('div', 'card coll-card')
      const cov = el('div', 'cover')
      if (p.pic) cov.appendChild(picImg(p.pic, null, p.name))
      else cov.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>'
      card.appendChild(cov)
      card.appendChild(el('div', 't', p.name))
      card.appendChild(el('div', 's', (p.creator ? p.creator + ' · ' : '') + (p.trackCount ? p.trackCount + ' 首' : '歌单')))
      if (!canOpenPlaylist(source)) card.appendChild(el('span', 'coll-lock', '暂不支持展开'))
      card.onclick = () => openCollection(source, 'playlist', p)
      grid.appendChild(card)
    }
    container.appendChild(grid)
  }

  const renderPlaza = async () => {
    const source = ostate.source
    const st = plazaState.get(source) || { batch: 0, list: [], hint: '' }
    plazaState.set(source, st)
    const src = onlineSourcesCache.find(x => x.id === source) || {}
    onlArea.innerHTML = ''
    const head = el('div', 'res-head')
    const info = el('span', 'res-info', (src.name || source) + ' · ' + (st.hint || '平台歌单'))
    head.appendChild(info)
    const more = el('button', 'btn ghost mini', '换一批')
    head.appendChild(more)
    onlArea.appendChild(head)
    const result = el('div', 'res')
    onlArea.appendChild(result)
    let busy = false
    const paint = () => {
      result.innerHTML = ''
      if (st.list.length) return paintPlaylistCards(source, st.list, result)
      if (busy) return result.appendChild(skeletonGrid(8))
      result.appendChild(el('div', 'empty', canOpenPlaylist(source)
        ? '这个音源现在拿不到平台歌单，点「换一批」或换个音源再试试'
        : '这个音源现在拿不到平台歌单（上游没有公开的推荐/分类接口）'))
    }
    const load = async (batch) => {
      if (busy) return
      busy = true
      if (batch != null) st.batch = batch
      more.disabled = true
      paint()
      try {
        const d = await api('/api/online/rec-playlists?source=' + encodeURIComponent(source) +
          '&limit=' + PLAZA_PER + '&batch=' + st.batch)
        st.list = d.list || []
        st.hint = d.hint || st.hint
      } catch (e) {
        st.list = []
        toast(e.message, true)
      }
      busy = false
      more.disabled = false
      // 请求期间用户可能已经切音源/切视图，别往别人的页面上画
      if (ostate.view === 'plaza' && ostate.source === source) {
        info.textContent = (src.name || source) + ' · ' + (st.hint || '平台歌单')
        paint()
      }
    }
    more.onclick = () => load(st.batch + 1)
    if (st.list.length) paint()
    else await load(null)
  }

  const renderSearch = () => {
    onlArea.innerHTML = ''
    const typeBox = el('div', 'chips mini type-chips')
    const src = onlineSourcesCache.find(x => x.id === ostate.source)
    const ab = (src && src.abilities) || []
    const canAlbums = ab.includes('albums')
    const canPlaylists = ab.includes('playlists')
    const canArtists = ab.includes('artists')
    const typeDefs = [['song', '单曲']]
    if (canAlbums) typeDefs.push(['album', '专辑'])
    if (canPlaylists) typeDefs.push(['playlist', '歌单'])
    if (canArtists) typeDefs.push(['artist', '歌手'])
    // 当前源不支持的类型（换源后残留）：回落到单曲
    if (!typeDefs.some(t => t[0] === ostate.type)) ostate.type = 'song'
    for (const [key, label] of typeDefs) {
      const c = el('button', 'chip' + (ostate.type === key ? ' on' : ''), label)
      c.onclick = () => { ostate.type = key; ostate.page = 0; ostate.list = []; ostate.total = 0; renderSearch() }
      typeBox.appendChild(c)
    }
    onlArea.appendChild(typeBox)
    const box = el('div', 'search-box')
    const input = el('input')
    const PH = { song: '搜索在线歌曲…', album: '搜索在线专辑…', playlist: '搜索在线歌单…', artist: '搜索在线歌手…' }
    input.placeholder = PH[ostate.type] || '搜索在线内容…'
    const btn = el('button', 'btn primary', '搜索')
    box.appendChild(input); box.appendChild(btn)
    onlArea.appendChild(box)
    const run = () => {
      const q = input.value.trim()
      if (!q) return
      ostate.q = q; ostate.page = 0; ostate.list = []
      pushHist('gusi-oh', ostate.source + ':' + ostate.type + ':' + q)
      const old = onlArea.querySelector('.s-hist')
      if (old) old.remove()
      const fresh = histChips('gusi-oh', onHist, ostate.source)
      box.after(fresh)
      loadSearch(onlArea)
    }
    const onHist = (q) => {
      input.value = q
      run()
    }
    const hw = histChips('gusi-oh', onHist, ostate.source)
    onlArea.appendChild(hw)
    const head = el('div', 'res-head')
    head.appendChild(el('span', 'res-info'))
    const allBtn = el('button', 'btn ghost mini play-all', '▶ 播放全部')
    allBtn.hidden = true
    allBtn.onclick = () => { if (ostate.list.length) player.play(ostate.list, 0) }
    head.appendChild(allBtn)
    head.appendChild(selDlBtn('btn ghost mini'))
    onlArea.appendChild(head)
    const result = el('div', 'res')
    onlArea.appendChild(result)
    btn.onclick = run
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    if (ostate.q) input.value = ostate.q
    if (ostate.autoRun) {
      // 点歌手卡片进来：直接按歌手名搜该源的歌曲（不需要用户再按一次搜索）
      ostate.autoRun = false
      loadSearch(onlArea)
    } else if (ostate.list.length) {
      if (ostate.type === 'song') paintSearchTable(onlArea)
      else if (ostate.type === 'artist') paintArtistGrid(onlArea)
      else paintCollectionGrid(onlArea)
    }
    input.focus()
  }

  // ---- 歌手卡片（歌手搜索 / 点击进该歌手的在线单曲） ----
  const paintArtistGrid = (container) => {
    const info = container.querySelector('.res-info')
    const allBtn = container.querySelector('.play-all')
    if (info) info.textContent = ostate.q ? '「' + ostate.q + '」 · ' + srcName(ostate.source) + ' · 共 ' + ostate.total + ' 位歌手' : ''
    if (allBtn) allBtn.hidden = true
    const result = container.querySelector('.res')
    if (!result) return
    result.innerHTML = ''
    const grid = el('div', 'grid artist-grid')
    for (const a of ostate.list) {
      const card = el('div', 'card artist-card')
      const cov = el('div', 'cover round')
      if (a.pic) cov.appendChild(picImg(a.pic, null, a.name))
      else cov.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="3.6"/><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6"/></svg>'
      card.appendChild(cov)
      card.appendChild(el('div', 't', a.name))
      card.appendChild(el('div', 's', (a.trackCount ? a.trackCount + ' 首歌' : '歌手') + (a.creator ? ' · ' + a.creator : '')))
      card.onclick = () => {
        ostate.type = 'song'
        ostate.q = a.name
        ostate.page = 0; ostate.total = 0; ostate.list = []
        ostate.autoRun = true
        renderSearch()
      }
      grid.appendChild(card)
    }
    result.appendChild(grid)
    const more = el('button', 'load-more')
    more.hidden = ostate.total <= ostate.list.length
    more.textContent = '加载更多（' + ostate.list.length + ' / ' + ostate.total + '）'
    more.onclick = () => loadSearch(container)
    result.appendChild(more)
  }
  const renderChips = () => {
    onlChips.innerHTML = ''
    const enabled = onlineSourcesCache.filter(s => s.enabled)
    if (!enabled.length) {
      onlChips.appendChild(el('span', 'online-disabled', '⚠ 在线搜索源已在管理后台停用，请到「音源与代理」页开启。'))
      ostate.source = ''
      onlArea.innerHTML = ''
      onlTabs.innerHTML = ''
      return
    }
    if (!enabled.some(s => s.id === ostate.source)) { ostate.source = enabled[0].id; ostate.boards = [] }
    for (const s of enabled) {
      const c = el('button', 'chip' + (s.id === ostate.source ? ' on' : ''), s.name)
      c.onclick = () => {
        if (s.id === ostate.source) return
        ostate.source = s.id
        ostate.boards = []
        ostate.bid = ''
        // 榜单是按源注册的，切源后榜单视图没有意义，退回默认的「歌单广场」
        if (ostate.view === 'boards' || ostate.view === 'board') ostate.view = 'plaza'
        if (ostate.view === 'search') { ostate.q = ''; ostate.type = 'song' }
        ostate.list = []; ostate.page = 0; ostate.total = 0; ostate.autoRun = false
        onlColl = null
        renderChips(); renderTabs(); renderArea()
      }
      onlChips.appendChild(c)
    }
  }
  const renderTabs = () => {
    onlTabs.innerHTML = ''
    // 默认 tab 是「歌单广场」：进页面先看平台歌单，搜索框只在「搜索」tab 里出现
    const pt = el('button', 'otab' + (ostate.view === 'plaza' ? ' on' : ''), '歌单广场')
    pt.onclick = () => { ostate.view = 'plaza'; renderTabs(); renderArea() }
    onlTabs.appendChild(pt)
    const st = el('button', 'otab' + (ostate.view === 'search' ? ' on' : ''), '搜索')
    st.onclick = () => { ostate.view = 'search'; renderTabs(); renderArea() }
    onlTabs.appendChild(st)
    const src = onlineSourcesCache.find(s => s.id === ostate.source)
    if (src && src.boards) {
      const bt = el('button', 'otab' + (ostate.view === 'boards' || ostate.view === 'board' ? ' on' : ''), '排行榜')
      bt.onclick = () => loadBoards()
      onlTabs.appendChild(bt)
    }
  }
  // ---- 专辑/歌单集合卡片与详情 ----
  const paintCollectionGrid = (container) => {
    const info = container.querySelector('.res-info')
    const allBtn = container.querySelector('.play-all')
    if (info) info.textContent = ostate.q ? '「' + ostate.q + '」 · ' + srcName(ostate.source) + ' · 共 ' + ostate.total + ' 个' : ''
    if (allBtn) allBtn.hidden = true
    const result = container.querySelector('.res')
    if (!result) return
    result.innerHTML = ''
    const grid = el('div', 'grid coll-grid')
    for (const c0 of ostate.list) {
      const card = el('div', 'card coll-card')
      const cov = el('div', 'cover')
      if (c0.pic) cov.appendChild(picImg(c0.pic, null, c0.name))
      else cov.innerHTML = ostate.type === 'playlist'
        ? '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.1"/></svg>'
      card.appendChild(cov)
      card.appendChild(el('div', 't', c0.name))
      card.appendChild(el('div', 's', (c0.creator ? c0.creator + ' · ' : '') + (c0.trackCount ? c0.trackCount + ' 首' : '歌单/专辑')))
      card.onclick = () => openCollection(ostate.source, ostate.type, c0)
      grid.appendChild(card)
    }
    result.appendChild(grid)
    const more = el('button', 'load-more')
    more.hidden = ostate.total <= ostate.list.length
    more.textContent = '加载更多（' + ostate.list.length + ' / ' + ostate.total + '）'
    more.onclick = () => loadSearch(container)
    result.appendChild(more)
  }
  const openCollection = async (source, type, c0) => {
    const src = onlineSourcesCache.find(x => x.id === source)
    const ab = (src && src.abilities) || []
    // 详情能力按类型判定：酷我能开歌单但专辑接口反爬，咪咕两者都开不了
    const need = type === 'album' ? 'album-detail' : 'playlist-detail'
    if (!ab.includes(need)) {
      toast(type === 'album'
        ? '该源暂不支持展开专辑详情，试试网易云音乐源'
        : '该源暂不支持展开歌单详情（接口受限），试试酷我或网易云音乐源', true)
      return
    }
    onlColl = null
    onlFrom = ostate.view === 'search' ? 'search' : 'plaza'
    onlArea.innerHTML = ''
    const hd = el('div', 'board-head')
    const back = el('button', 'btn ghost mini', onlFrom === 'plaza' ? '← 返回歌单广场' : '← 返回搜索结果')
    back.onclick = () => { ostate.view = onlFrom; renderTabs(); renderArea() }
    hd.appendChild(back)
    const name = el('span', 'bh-name', c0.name)
    hd.appendChild(name)
    onlArea.appendChild(hd)
    onlArea.appendChild(skeletonRows(8))
    try {
      const d = await api('/api/online/collection?source=' + encodeURIComponent(source) + '&type=' + type + '&id=' + encodeURIComponent(c0.id))
      onlColl = d
      renderCollectionDetail()
    } catch (e) {
      onlArea.innerHTML = ''
      onlArea.appendChild(hd)
      onlArea.appendChild(el('div', 'empty', e.message))
    }
  }
  const renderCollectionDetail = () => {
    if (!onlColl) return
    onlArea.innerHTML = ''
    const info = onlColl.info || {}
    const tracks = onlColl.list || []
    // 详情页自己带返回按钮：openCollection 的临时头会被这里清掉，
    // 默认视图改成歌单广场后「点进歌单出不来」会很难受
    const hd = el('div', 'board-head')
    const back = el('button', 'btn ghost mini', onlFrom === 'search' ? '← 返回搜索结果' : '← 返回歌单广场')
    back.onclick = () => { ostate.view = onlFrom; renderTabs(); renderArea() }
    hd.appendChild(back)
    hd.appendChild(el('span', 'bh-name', info.name || ''))
    onlArea.appendChild(hd)
    const hero = el('div', 'coll-hero')
    const cov = el('div', 'cover big')
    if (info.pic) cov.appendChild(picImg(info.pic, null, info.name))
    else cov.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.1"/></svg>'
    hero.appendChild(cov)
    const meta = el('div', 'coll-meta')
    meta.appendChild(el('div', 'coll-type', (ostate.type === 'album' ? '专辑' : '歌单') + ' · ' + srcName(info.source || ostate.source)))
    meta.appendChild(el('div', 'coll-name', info.name || ''))
    meta.appendChild(el('div', 'coll-sub', (info.creator || '') + (info.trackCount ? ' · ' + info.trackCount + ' 首' : '')))
    const btns = el('div', 'btns')
    const bPlay = el('button', 'btn primary')
    bPlay.innerHTML = SVG.play + '<span>播放全部</span>'
    bPlay.disabled = !tracks.length
    bPlay.onclick = () => { if (tracks.length) player.play(toOnlineRows(tracks), 0) }
    const bDl = el('button', 'btn')
    bDl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg><span>下载全部</span>'
    bDl.disabled = !tracks.length
    bDl.onclick = () => {
      if (!tracks.length) return
      askDownload(asOnlineRows(tracks), bDl)
    }
    btns.appendChild(bPlay); btns.appendChild(bDl)
    btns.appendChild(selDlBtn('btn'))
    meta.appendChild(btns)
    hero.appendChild(meta)
    onlArea.appendChild(hero)
    if (!tracks.length) { onlArea.appendChild(el('div', 'empty', '暂无曲目')); return }
    const rows = toOnlineRows(tracks)
    initSel(rows)
    const tbl = el('table', 'tracks')
    const thead = el('thead'); onTableHead(thead); tbl.appendChild(thead)
    const tbody = el('tbody')
    rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i, rows)))
    tbl.appendChild(tbody)
    onlArea.appendChild(tbl)
  }
  const toOnlineRows = (list) => list.map(x => ({
    id: x.source + '_' + x.id.replace(/^MUSIC_/, ''),
    kind: 'online', source: x.source, rid: x.id,
    name: x.name, singer: x.singer, album: x.album,
    interval: x.intervalMs, pic: x.pic,
  }))
  // ---- 歌单链接一键导入 ----
  const renderImport = (container) => {
    container.innerHTML = ''
    container.appendChild(el('h3', 'sub-h', '粘贴分享链接 · 一键导入歌单/专辑'))
    const guide = el('div', 'dl-paste-guide')
    guide.innerHTML = `
      <div class="pg-title">支持平台与链接格式</div>
      <div class="pg-desc">粘贴后自动识别平台并拉取全量曲目，可立即播放或批量下载（不会写入本地曲库）。</div>
      <pre class="pg-sample">网易云：music.163.com/#/playlist?id=12557423433
酷我：kuwo.cn/playlist_detail/280301309
咪咕：music.migu.cn/v3/music/playlist/221603627（咪咕专辑暂不支持）</pre>
    `
    container.appendChild(guide)
    const bar = el('div', 'dl-search-bar')
    const inp = el('input')
    inp.type = 'text'
    inp.placeholder = '粘贴网易云/酷我 歌单或专辑分享链接…'
    inp.maxLength = 512
    const btn = el('button', 'btn primary', '🚀 一键导入')
    bar.appendChild(inp); bar.appendChild(btn)
    container.appendChild(bar)
    const result = el('div', 'dl-import-result'); container.appendChild(result)
    const run = async () => {
      const url = inp.value.trim()
      if (!url) { toast('请先粘贴链接', true); return }
      btn.disabled = true; btn.textContent = '导入中…'
      result.innerHTML = ''; result.appendChild(el('p', 'hint', '🔍 正在解析并拉取曲目…'))
      try {
        const d = await api('/api/online/import?url=' + encodeURIComponent(url))
        const info = d.info || {}
        const list = d.list || []
        result.innerHTML = ''
        const hero = el('div', 'coll-hero')
        const cov = el('div', 'cover')
        if (info.pic) cov.appendChild(picImg(info.pic, null, info.name))
        else cov.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>'
        hero.appendChild(cov)
        const meta = el('div', 'coll-meta')
        meta.appendChild(el('div', 'coll-type', (d.type === 'album' ? '专辑' : '歌单') + ' · ' + srcName(d.source)))
        meta.appendChild(el('div', 'coll-name', info.name || ''))
        meta.appendChild(el('div', 'coll-sub', (info.creator || '') + ' · 共 ' + list.length + ' 首'))
        const btns = el('div', 'btns')
        const bPlay = el('button', 'btn primary')
        bPlay.innerHTML = SVG.play + '<span>播放全部</span>'
        bPlay.onclick = () => { if (list.length) player.play(toOnlineRows(list), 0) }
        const bDl = el('button', 'btn')
        bDl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg><span>下载全部</span>'
        bDl.onclick = () => {
          if (!list.length) return
          askDownload(asOnlineRows(list), bDl)
        }
        btns.appendChild(bPlay); btns.appendChild(bDl)
        btns.appendChild(selDlBtn('btn'))
        meta.appendChild(btns)
        hero.appendChild(meta)
        result.appendChild(hero)
        if (!list.length) { result.appendChild(el('div', 'empty', '该歌单暂无曲目')); return }
        const rows = toOnlineRows(list)
        initSel(rows)
        const tbl = el('table', 'tracks')
        const thead = el('thead'); onTableHead(thead); tbl.appendChild(thead)
        const tbody = el('tbody')
        rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i, rows)))
        tbl.appendChild(tbody)
        result.appendChild(tbl)
      } catch (e) {
        result.innerHTML = ''
        result.appendChild(el('div', 'empty', e.message))
      }
      btn.disabled = false; btn.textContent = '🚀 一键导入'
    }
    btn.onclick = run
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
  }
  routes.online = async () => {
    setActiveNav('online')
    const v = $('#view')
    // 顶部介绍横幅已删除（2026-09-15 主人：点开后不要介绍标签，直接显示内容）
    // 顶栏已经写着「在线音乐」，再挂一张标题+副标题的卡就是三层重复

    // 一行工具栏：左音源切换，右视图切换
    const tools = el('div', 'onl-tools')
    onlChips = el('div', 'chips')
    onlTabs = el('div', 'otabs')
    tools.appendChild(onlChips)
    tools.appendChild(onlTabs)
    v.appendChild(tools)

    onlArea = el('div', 'onl-area')
    v.appendChild(onlArea)
    window.__onlineArea = onlArea
    window.__onlineTabs = onlTabs

    api('/api/online/sources').then((d) => {
      if (d.sources && d.sources.length) onlineSourcesCache = d.sources
      renderChips(); renderTabs(); renderArea()
      const pend = window.__pendingRec
      if (pend) {
        window.__pendingRec = null
        ostate.source = pend.source
        ostate.type = pend.type
        renderChips(); renderTabs()
        openCollection(pend.source, pend.type, pend.item)
      }
    }).catch(() => { renderChips(); renderTabs(); renderArea() })
  }

  // ---------------- 下载中心（MVP） ----------------
  let dlState = {
    q: '', size: 20, list: [], perSource: [], loading: false, filter: '',
  }
  let dlSse = null, dlQueue = []
  let dlDir = { current: '', dirs: [], authed: [], userDir: '', autoAssigned: false }
  // 头部信息统一收敛到一行 meta（替代原 banner/目录条/容量卡/统计卡，原占视口 46%）
  let dlQuota = null
  let dlStatsCache = null
  let dlMetaLast = 0

  /** 队列区块统计（共 N 项 · N 下载中 · N 失败） */
  function paintDlBadge() {
    const box = document.getElementById('dl-qcount')
    if (!box) return
    const s = dlStatsCache
    if (!s) { box.textContent = ''; return }
    const bits = ['共 ' + (s.total || 0) + ' 项']
    if (s.downloading) bits.push(s.downloading + ' 下载中')
    if (s.failed) bits.push(s.failed + ' 失败')
    box.textContent = bits.join(' · ')
    box.className = 'dl-qcount' + (s.downloading ? ' busy' : '') + (s.failed ? ' has-bad' : '')
  }
  /**
   * 拉取队列统计 / 配额 / 下载目录。
   * 页头（#dl-meta）只显示**云盘空间容量**一项 —— 队列数量在「下载队列」标题上、
   * 下载目录放进容量条的 tooltip，别的信息不往页头堆。
   */
  async function refreshDlMeta() {
    dlMetaLast = Date.now()
    const box = document.getElementById('dl-meta')
    if (!box) return
    const [stats, quota, dir] = await Promise.all([
      api('/api/downloads/stats').catch(() => null),
      api('/api/quota').catch(() => null),
      api('/api/downloads/dir').catch(() => null),
    ])
    if (stats) dlStatsCache = stats
    if (dir) dlDir = { current: dir.current || '', dirs: dir.dirs || [], authed: dir.authed || [], userDir: dir.userDir || '', autoAssigned: !!dir.autoAssigned }
    dlQuota = quota
    box.innerHTML = ''
    if (quota && quota.effectiveGb) {
      const gb = 1024 * 1024 * 1024
      const used = (quota.usedBytes / gb).toFixed(2)
      const pct = Math.min(100, (quota.usedBytes / gb) / Math.max(quota.effectiveGb, 0.0001) * 100)
      const q = el('span', 'dm-quota')
      const bar = el('span', 'dm-q-bar')
      const fill = el('i')
      if (pct >= 90) fill.className = 'full'
      else if (pct >= 70) fill.className = 'warn'
      fill.style.width = pct.toFixed(1) + '%'
      bar.appendChild(fill)
      q.appendChild(bar)
      q.appendChild(el('span', 'dm-q-txt', used + ' / ' + quota.effectiveGb + ' GB'))
      const dirPath = dlDir.current || dlDir.userDir || ''
      q.title = '云盘空间 ' + used + ' / ' + quota.effectiveGb + ' GB'
        + (dirPath ? '\n下载保存到：' + dirPath + (dlDir.autoAssigned ? '（自动分配）' : '') : '')
        + (quota.note ? '\n' + quota.note : '')
      box.appendChild(q)
    } else {
      box.appendChild(el('span', 'dm-q-txt', '容量不可用'))
    }
    paintDlBadge()
  }

  const renderDlCenter = async (v) => {
    if (dlSse) { try { dlSse.close() } catch {} dlSse = null }
    v.innerHTML = ''
    // ---- 页头：标题 + 云盘空间容量（页头只有这一项信息） ----
    const head = el('div', 'page-head')
    head.appendChild(el('h2', 'page', '下载中心'))
    const metaBar = el('div', 'dl-head-quota'); metaBar.id = 'dl-meta'
    head.appendChild(metaBar)
    v.appendChild(head)

    // ---- 搜索框：平时一小条，点进来（focus）才展开 ----
    const hero = el('div', 'dl-hero')
    const bar = el('div', 'dl-hero-bar')
    bar.appendChild(el('span', 'dl-hero-ic', '🔍'))
    const inp = el('input')
    inp.type = 'search'
    inp.placeholder = '搜索歌曲 / 歌手'
    inp.title = '一次搜索覆盖全部已启用平台；同一首歌自动合并成一行，可在曲目上切换下载源'
    inp.value = dlState.q
    inp.maxLength = 100
    const btn = el('button', 'btn primary dl-hero-btn', '搜索')
    bar.appendChild(inp); bar.appendChild(btn)
    hero.appendChild(bar)
    // 只在「所有在线源都被停用」时才出现的一行告警，平时不占位
    const tip = el('div', 'dl-hero-tip'); tip.id = 'dl-hero-tip'; tip.hidden = true
    hero.appendChild(tip)
    v.appendChild(hero)

    const res = el('div', 'dl-res'); res.id = 'dl-res'
    v.appendChild(res)

    // ---- 下载队列（常驻区块，不再是 Tab） ----
    const qsec = el('section', 'dl-qsec')
    const qhead = el('div', 'dl-qhead')
    qhead.appendChild(el('h3', 'dl-qtitle', '下载队列'))
    const qcount = el('span', 'dl-qcount'); qcount.id = 'dl-qcount'
    qhead.appendChild(qcount)
    qsec.appendChild(qhead)
    const area = el('div', 'dl-area'); qsec.appendChild(area)
    v.appendChild(qsec)

    function paintHeroTip() {
      // 平台清单这类说明不占版面：只在全部源被停用时提示一句
      const list = onlineSourcesCache || []
      const none = list.length > 0 && !list.some(s => s.enabled)
      tip.hidden = !none
      tip.textContent = none ? '⚠ 全部在线源已在管理后台停用，请到「音源与代理」页开启' : ''
    }
    paintHeroTip()
    // 进页面时刷新在线源（init 快照不可靠）
    api('/api/online/sources').then(d => {
      if (d.sources && d.sources.length) { onlineSourcesCache = d.sources; paintHeroTip() }
    }).catch(() => {})

    const SRC_SHORT = { kw: '酷我', wy: '网易', mg: '咪咕', soda: '汽水' }
    const srcShort = (id) => SRC_SHORT[id] || srcName(id) || id
    let dlSearchSelected = new Set()   // 勾选的行 key（跨源合并不受影响）

    async function runDlSearch() {
      const q = inp.value.trim()
      if (!q) { toast('请输入关键词', true); inp.focus(); return }
      if (dlState.loading) return
      dlState.q = q; dlState.loading = true; dlState.list = []; dlState.perSource = []
      dlSearchSelected = new Set()
      res.innerHTML = ''
      res.appendChild(el('div', 'dl-loading', '正在搜索全部平台…'))
      try {
        const d = await api('/api/downloads/search?q=' + encodeURIComponent(q) + '&size=' + dlState.size)
        dlState.list = d.list || []
        dlState.perSource = d.perSource || []
        paintDlResults()
      } catch (e) {
        res.innerHTML = ''
        res.appendChild(el('div', 'dl-res-empty', '搜索失败：' + e.message))
      }
      dlState.loading = false
    }
    inp.onkeydown = (e) => { if (e.key === 'Enter') runDlSearch() }
    btn.onclick = runDlSearch

    function paintDlResults() {
      res.innerHTML = ''
      // 未搜索时不放任何说明文案：搜索框的 placeholder + tooltip 已经说清楚了
      if (!dlState.q) return
      const info = el('div', 'dl-res-info')
      info.appendChild(el('span', 'dl-res-q', '「' + dlState.q + '」'))
      info.appendChild(el('span', 'dl-res-n', dlState.list.length + ' 首'))
      const counts = (dlState.perSource || []).filter(x => x.count > 0).map(x => x.name + ' ' + x.count).join(' · ')
      if (counts) info.appendChild(el('span', 'dl-res-src', counts))
      const failed = (dlState.perSource || []).filter(x => x.error)
      if (failed.length) info.appendChild(el('span', 'dl-res-warn', '⚠ ' + failed.map(f => f.name + ' 失败').join('、')))
      res.appendChild(info)
      if (!dlState.list.length) { res.appendChild(el('div', 'dl-res-empty', '没有找到匹配的歌曲，换个关键词试试')); return }

      const batchBar = el('div', 'dl-search-batch-bar')
      batchBar.innerHTML = `
        <label class="dl-sel-all" title="全选"><input type="checkbox" id="dl-search-check-all"><span>全选</span></label>
        <span class="dl-sel-count">已选 0 首</span>
        <span class="dl-batch-spacer"></span>
        <button class="btn primary mini" data-op="enqueue" disabled>⬇ 批量下载</button>
      `
      batchBar.addEventListener('click', (e) => { if (e.target.closest('[data-op]')) batchEnqueueSearch() })
      const checkAll = batchBar.querySelector('#dl-search-check-all')
      if (checkAll) checkAll.onchange = () => {
        if (checkAll.checked) { for (const t of dlState.list) dlSearchSelected.add(t.key) }
        else dlSearchSelected = new Set()
        paintDlResults()
      }
      res.appendChild(batchBar)

      const tbl = el('table', 'tracks dl-res-tbl')
      const thead = el('thead')
      // 勾选列走统一模板，全选框由本页自己提供（它另有一套批量勾选状态）
      thead.appendChild(trackHead(Object.assign({}, DL_TBL_OPTS, {
        onSelHead: (th) => {
          const cb = document.createElement('input')
          cb.type = 'checkbox'
          cb.title = '全选'
          cb.onchange = () => {
            if (cb.checked) { for (const t of dlState.list) dlSearchSelected.add(t.key) }
            else dlSearchSelected = new Set()
            paintDlResults()
          }
          th.appendChild(cb)
        },
      })))
      tbl.appendChild(thead)
      const tbody = el('tbody')
      for (const t of dlState.list) tbody.appendChild(dlRow(t))
      tbl.appendChild(tbody)
      res.appendChild(tbl)
      updateSearchBatchBar()
      const checkAllEl = panel => { /* noop 占位，保持结构清晰 */ }
      checkAllEl()
    }

    function updateSearchBatchBar() {
      const bar2 = document.querySelector('.dl-search-batch-bar')
      if (!bar2) return
      const count = dlSearchSelected.size
      bar2.querySelector('.dl-sel-count').textContent = '已选 ' + count + ' 首'
      const b = bar2.querySelector('[data-op="enqueue"]')
      if (b) b.disabled = count === 0
    }

    async function batchEnqueueSearch() {
      const items = dlState.list.filter(t => dlSearchSelected.has(t.key))
      if (!items.length) { toast('请先勾选要下载的曲目', true); return }
      const b0 = document.querySelector('.dl-search-batch-bar [data-op="enqueue"]')
      if (b0) { b0.disabled = true; b0.textContent = '加入中…' }
      try {
        const r = await api('/api/downloads/enqueue', {
          method: 'POST',
          body: { items: items.map(t => ({ source: t.source, id: t.id, name: t.name, singer: t.singer, intervalMs: t.intervalMs, pic: t.pic, album: t.album })) },
        })
        const okN = r.accepted || 0
        const failN = (r.reasons || []).length
        if (okN > 0) toast(`已加入 ${okN} 首到下载队列`)
        if (failN > 0) {
          const r0 = (r.reasons || [])[0]
          if (r0) toast(`${failN} 首入队失败：${r0.reason || ''}`, true)
        }
        if (!okN && !failN) toast('入队失败', true)
        dlSearchSelected = new Set()
        paintDlResults()
        refreshDlMeta()
      } catch (e) {
        toast(e.message, true)
        if (b0) { b0.disabled = false; b0.textContent = '⬇ 批量下载' }
      }
    }

    /** 单行：跨源合并后的歌曲，choices 多于一个时给出源切换下拉 */
    function dlRow(t) {
      const cells = {}
      const tdChk = el('td', 'sel-col')
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.title = '勾选下载'
      chk.checked = dlSearchSelected.has(t.key)
      chk.onchange = () => {
        if (chk.checked) dlSearchSelected.add(t.key); else dlSearchSelected.delete(t.key)
        updateSearchBatchBar()
        const allCb = document.querySelector('#dl-search-check-all')
        const thCb = res.querySelector('table.tracks thead input[type="checkbox"]')
        const allChecked = dlState.list.length > 0 && dlState.list.every(x => dlSearchSelected.has(x.key))
        if (allCb) allCb.checked = allChecked
        if (thCb) thCb.checked = allChecked
      }
      tdChk.appendChild(chk); cells.sel = tdChk

      const tdCov = el('td', 'cov')
      const paintCov = () => { tdCov.innerHTML = ''; tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || ''))) }
      paintCov(); cells.cov = tdCov

      const tdName = el('td')
      tdName.appendChild(el('div', 'dl-nm', t.name))
      const sub = el('div', 'dl-sub')
      sub.appendChild(el('span', 'dl-sg', t.singer || '未知歌手'))
      let tdAlbum = null, tdDur = null
      if (t.choices && t.choices.length > 1) {
        const sel = el('select', 'dl-src-sel')
        sel.title = '这首歌在 ' + t.choices.length + ' 个平台都有，可切换下载源'
        for (const c of t.choices) {
          const o = document.createElement('option')
          o.value = c.source; o.textContent = srcShort(c.source)
          sel.appendChild(o)
        }
        sel.value = t.source
        sel.onchange = () => {
          const c = (t.choices || []).find(x => x.source === sel.value)
          if (!c) return
          t.source = c.source; t.id = c.id; t.intervalMs = c.intervalMs
          if (c.pic && c.pic !== t.pic) { t.pic = c.pic; paintCov() }
          if (c.album) { t.album = c.album; if (tdAlbum) tdAlbum.textContent = c.album }
          if (tdDur) tdDur.textContent = fmtDur((t.intervalMs || 0) / 1000)
        }
        sub.appendChild(sel)
      } else if (t.source) {
        sub.appendChild(el('span', 'dl-src-tag', srcShort(t.source)))
      }
      tdName.appendChild(sub)
      cells.name = tdName

      tdAlbum = el('td', 'album-col ell', t.album || '—'); cells.album = tdAlbum
      tdDur = el('td', 'dur', fmtDur((t.intervalMs || 0) / 1000)); cells.dur = tdDur

      const tdAct = el('td', 'acts')
      const bAdd = el('button', 'btn primary mini', '⬇ 下载')
      bAdd.onclick = async () => {
        bAdd.disabled = true; bAdd.textContent = '加入中…'
        try {
          const r = await api('/api/downloads/enqueue', {
            method: 'POST',
            body: { items: [{ source: t.source, id: t.id, name: t.name, singer: t.singer, intervalMs: t.intervalMs, pic: t.pic, album: t.album }] },
          })
          const reasons = Array.isArray(r.reasons) ? r.reasons : []
          if (r.accepted > 0) {
            bAdd.textContent = '✓ 已加入'; bAdd.classList.remove('primary'); bAdd.classList.add('ghost')
            toast('已加入下载队列'); refreshDlMeta()
          } else if (reasons.length) {
            toast(reasons[0].reason || '入队失败', true)
            bAdd.disabled = false; bAdd.textContent = '⬇ 下载'
          } else {
            toast('入队失败', true)
            bAdd.disabled = false; bAdd.textContent = '⬇ 下载'
          }
        } catch (e) { toast(e.message, true); bAdd.disabled = false; bAdd.textContent = '⬇ 下载' }
      }
      tdAct.appendChild(bAdd); cells.acts = tdAct
      return trackRowEl(DL_TBL_OPTS, cells)
    }

    // ---- 队列 ----
    let dlSelected = new Set()  // 当前勾选的任务 id
    let lastBatchBar = null

    function renderQueue(box) {
      box.innerHTML = ''
      const chips = el('div', 'chips')
      const filters = [['', '全部'], ['downloading', '下载中'], ['pending', '等待中'], ['done', '已完成'], ['failed', '失败']]
      for (const [k, label] of filters) {
        const c = el('button', 'chip' + (dlState.filter === k ? ' on' : ''), label)
        c.onclick = () => { dlState.filter = k; dlSelected = new Set(); loadQueue() }
        chips.appendChild(c)
      }
      box.appendChild(chips)
      const bar = el('div', 'dl-batch-bar')
      bar.id = 'dl-batch-bar'
      bar.innerHTML = `
        <label class="dl-sel-all" title="全选当前筛选"><input type="checkbox" id="dl-check-all"><span>全选</span></label>
        <span class="dl-sel-count">已选 0 项</span>
        <span class="dl-batch-spacer"></span>
        <button class="btn ghost mini" data-op="retry" disabled>↻ 批量重试</button>
        <button class="btn ghost mini" data-op="remove" disabled>✕ 批量移除</button>
        <button class="btn ghost mini danger" data-op="delete-file" disabled>🗑 删除文件</button>
      `
      bar.style.display = 'none'
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-op]')
        if (b) batchOperate(b.dataset.op)
      })
      const checkAll = bar.querySelector('#dl-check-all')
      if (checkAll) checkAll.onchange = () => {
        if (checkAll.checked) {
          for (const t of dlQueue) if (t.status !== 'downloading') dlSelected.add(t.id)
        } else dlSelected = new Set()
        paintQueue(document.getElementById('dl-queue'))
      }
      lastBatchBar = bar
      box.appendChild(bar)
      const qbox = el('div', 'dl-queue-box'); qbox.id = 'dl-queue'
      box.appendChild(qbox)
      loadQueue()
    }
    async function loadQueue() {
      try {
        const url = '/api/downloads/tasks' + (dlState.filter ? '?status=' + encodeURIComponent(dlState.filter) : '')
        const d = await api(url)
        dlQueue = d.tasks || []
        // 清理已不存在或下载中的选择
        const valid = new Set(dlQueue.filter(t => t.status !== 'downloading').map(t => t.id))
        for (const id of Array.from(dlSelected)) if (!valid.has(id)) dlSelected.delete(id)
        paintQueue(document.getElementById('dl-queue'))
      } catch (e) { toast(e.message, true) }
    }
    function paintQueue(box) {
      if (!box) return
      // 更新批量工具条状态
      if (lastBatchBar) {
        lastBatchBar.style.display = dlQueue.length ? 'flex' : 'none'
        const cnt = dlSelected.size
        const cntEl = lastBatchBar.querySelector('.dl-sel-count')
        if (cntEl) cntEl.textContent = '已选 ' + cnt + ' 项'
        lastBatchBar.querySelectorAll('[data-op]').forEach(b => { b.disabled = cnt === 0 })
        const checkAll = lastBatchBar.querySelector('#dl-check-all')
        if (checkAll) {
          const eligible = dlQueue.filter(t => t.status !== 'downloading')
          checkAll.checked = eligible.length > 0 && eligible.every(t => dlSelected.has(t.id))
          checkAll.indeterminate = cnt > 0 && !checkAll.checked
        }
      }
      box.innerHTML = ''
      if (!dlQueue.length) { box.appendChild(el('p', 'hint', '暂无下载任务。在上方搜索并加入歌曲。')); return }
      for (const t of dlQueue) {
        const row = el('div', 'dl-task ' + t.status)
        // 多选列（下载中禁止选择）
        const chkWrap = el('label', 'dl-check-wrap')
        const chk = el('input', 'dl-check')
        chk.type = 'checkbox'
        chk.checked = dlSelected.has(t.id)
        chk.disabled = t.status === 'downloading'
        chk.onchange = () => {
          if (chk.checked) dlSelected.add(t.id); else dlSelected.delete(t.id)
          paintQueue(document.getElementById('dl-queue'))
        }
        chkWrap.appendChild(chk); row.appendChild(chkWrap)
        const cov = el('div', 'dl-cov')
        const im = el('img'); im.loading = 'lazy'
        im.replaceWith(picImg(t.pic, null, t.name || ''))
        cov.appendChild(im); row.appendChild(cov)
        const main = el('div', 'dl-main')
        const title = el('div', 'dl-title')
        title.appendChild(el('span', null, t.name || '未命名'))
        title.appendChild(el('span', 'dl-singer', ' - ' + (t.singer || '未知')))
        main.appendChild(title)
        const pct = t.size > 0 ? Math.min(100, Math.round(t.bytes / t.size * 100)) : (t.status === 'downloading' ? 30 : (t.status === 'done' ? 100 : 0))
        const bar = el('div', 'dl-bar')
        const fill = el('div', 'dl-fill'); fill.style.width = pct + '%'
        bar.appendChild(fill); main.appendChild(bar)
        const statusText = {
          pending: '⏳ 等待中', downloading: '⬇ 下载中 ' + pct + '%',
          done: '✓ 已完成 · ' + fmtBytes(t.size) + (t.error ? ' · ' + t.error : ''),
          failed: '✗ 失败' + (t.error ? '：' + t.error : ''),
        }[t.status] || ''
        main.appendChild(el('div', 'dl-status ' + t.status, statusText))
        row.appendChild(main)
        const acts = el('div', 'dl-acts')
        if (t.status === 'failed') {
          const bRetry = el('button', 'btn ghost mini', '↻ 重试')
          bRetry.onclick = () => retryDl(t.id)
          acts.appendChild(bRetry)
        }
        if (t.status === 'done') {
          const bPlay = el('button', 'btn ghost mini', '▶ 播放')
          bPlay.onclick = () => player.play([{
            id: t.source + '_' + t.rid, kind: 'online', source: t.source, rid: t.rid,
            name: t.name, singer: t.singer, pic: t.pic, interval: t.duration,
          }], 0)
          acts.appendChild(bPlay)
        }
        const bDel = el('button', 'btn ghost mini dl-del', '删除')
        bDel.onclick = () => delDl(t.id)
        acts.appendChild(bDel); row.appendChild(acts)
        box.appendChild(row)
      }
    }
    async function retryDl(id) {
      try { await api('/api/downloads/retry', { method: 'POST', body: { id } }); toast('已加入重试'); loadQueue() }
      catch (e) { toast(e.message, true) }
    }
    async function delDl(id) {
      try { await api('/api/downloads/remove', { method: 'POST', body: { id } }); dlSelected.delete(id); loadQueue() }
      catch (e) { toast(e.message, true) }
    }
    async function batchOperate(op) {
      const ids = Array.from(dlSelected)
      if (!ids.length) return
      const labelMap = { remove: '移除', retry: '重试', 'delete-file': '删除文件' }
      const confirmText = op === 'delete-file'
        ? `确认删除已选 ${ids.length} 个已完成任务的物理 MP3 文件？此操作不可撤销。`
        : `确认对已选 ${ids.length} 个任务执行「${labelMap[op]}」？`
      if (!(await confirm2('批量操作', confirmText))) return
      try {
        const r = await api('/api/downloads/batch', { method: 'POST', body: { ids, op } })
        const okN = r.ok || 0
        const skipN = r.skipped || 0
        const note = op === 'delete-file' && r.deletedFiles?.length
          ? `，删除文件 ${r.deletedFiles.length} 个` : ''
        toast(`处理 ${okN} 项${skipN ? '，跳过 ' + skipN + ' 项' : ''}${note}`)
        dlSelected = new Set()
        loadQueue()
      } catch (e) { toast(e.message, true) }
    }

    // ---- 歌单导入 ----
    renderQueue(area); paintDlResults(); refreshDlMeta()

    // SSE（指数退避重连）
    let dlSseRetry = 0
    const dlSseMaxRetry = 5
    function connectDlSse() {
      try {
        const token = localStorage.getItem('gusi-web-token') || ''
        dlSse = new EventSource(BASE + '/web/api/downloads/events' + (token ? '?k=' + encodeURIComponent(token) : ''))
        dlSseRetry = 0
        dlSse.addEventListener('task', (ev) => {
          let t; try { t = JSON.parse(ev.data) } catch { return }
          if (document.getElementById('dl-queue')) {
            const idx = dlQueue.findIndex(x => x.id === t.id)
            if (idx >= 0) dlQueue[idx] = t
            else dlQueue.unshift(t)
            paintQueue(document.getElementById('dl-queue'))
          }
          // 任意 tab 下都刷新顶部统计（节流 2s：进度事件很密集）
          if (Date.now() - dlMetaLast > 2000) refreshDlMeta()
        })
        dlSse.onerror = () => {
          dlSse.close()
          dlSseRetry++
          if (dlSseRetry <= dlSseMaxRetry) {
            const delay = Math.min(30000, 1000 * Math.pow(2, dlSseRetry))
            setTimeout(connectDlSse, delay)
          }
        }
      } catch {}
    }
    connectDlSse()
  }

  routes.downloads = async () => {
    setActiveNav('downloads')
    await renderDlCenter($('#view'))
  }

  // ---------------- 设置 ----------------
  // 回收站：软删除的文件都在这，可恢复（搬回原路径并重扫）或彻底删除（不可恢复）
  routes.trash = async () => {
    setActiveNav('trash')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '回收站'))
    v.appendChild(el('p', 'trash-hint', '在「全部歌曲」删除的歌曲会先移到这里，可随时恢复；彻底删除后无法找回。'))

    const box = el('div', 'trash-box')
    v.appendChild(box)
    const sel = new Set()
    let rows = []
    let items = []

    const fmtSize = (n) => {
      if (!n || n < 0) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }
    const fmtTime = (ts) => {
      if (!ts) return '-'
      const d = new Date(ts)
      const p2 = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
    }

    const selAll = el('input')
    selAll.type = 'checkbox'
    const cnt = el('span', 'trash-count', '')
    const bRes = el('button', 'btn', '↩ 恢复选中')
    const bPurge = el('button', 'btn danger', '✕ 彻底删除选中')
    const bClear = el('button', 'btn ghost', '清空回收站')

    function sync() {
      for (const r of rows) r.cb.checked = sel.has(r.relPath)
      selAll.checked = items.length > 0 && sel.size === items.length
      const bytes = items.reduce((s, x) => s + (x.size || 0), 0)
      cnt.textContent = items.length
        ? '共 ' + items.length + ' 个文件 · ' + fmtSize(bytes) + (sel.size ? ' · 已选 ' + sel.size : '')
        : '回收站是空的'
      bRes.disabled = !sel.size
      bPurge.disabled = !sel.size
      bClear.disabled = !items.length
    }

    async function load() {
      let d
      try { d = await api('/api/trash') } catch (e) {
        box.innerHTML = ''
        box.appendChild(el('div', 'empty', '加载失败：' + e.message))
        return
      }
      items = (d && d.list) || []
      // 已被外部清理的条目要从选中集合摘掉，否则会去恢复/删除一个幽灵路径
      const alive = new Set(items.map(x => x.relPath))
      for (const p2 of [...sel]) if (!alive.has(p2)) sel.delete(p2)

      box.innerHTML = ''
      rows = []
      const bar = el('div', 'trash-bar')
      const allWrap = el('label', 'trash-selall')
      allWrap.appendChild(selAll)
      allWrap.appendChild(document.createTextNode('全选'))
      allWrap.hidden = !items.length
      bar.appendChild(bRes)
      bar.appendChild(bPurge)
      bar.appendChild(bClear)
      bar.appendChild(cnt)
      box.appendChild(bar)
      if (!items.length) {
        box.appendChild(el('div', 'empty', '回收站是空的。删除歌曲后可以在这里找回。'))
        sync()
        return
      }
      bar.insertBefore(allWrap, bar.firstChild)

      const tbl = el('table', 'trash-tbl')
      const thead = el('thead')
      const htr = el('tr')
      htr.appendChild(el('th', 't-sel', ''))
      htr.appendChild(el('th', null, '歌曲'))
      htr.appendChild(el('th', 't-artist', '歌手'))
      htr.appendChild(el('th', 't-album', '专辑'))
      htr.appendChild(el('th', 't-size', '大小'))
      htr.appendChild(el('th', 't-time', '文件时间'))
      htr.appendChild(el('th', 't-acts', '操作'))
      thead.appendChild(htr)
      tbl.appendChild(thead)
      const tbody = el('tbody')
      for (const it of items) {
        const tr = el('tr')
        const tdSel = el('td', 't-sel')
        const cb = el('input')
        cb.type = 'checkbox'
        cb.onchange = () => { if (cb.checked) sel.add(it.relPath); else sel.delete(it.relPath); sync() }
        tdSel.appendChild(cb)
        tr.appendChild(tdSel)
        const tdName = el('td', 't-name', it.name || it.relPath)
        tdName.title = it.relPath
        tr.appendChild(tdName)
        tr.appendChild(el('td', 't-artist', it.singer || '-'))
        tr.appendChild(el('td', 't-album', it.album || '-'))
        tr.appendChild(el('td', 't-size', fmtSize(it.size || 0)))
        tr.appendChild(el('td', 't-time', fmtTime(it.mtime)))
        const tdActs = el('td', 't-acts')
        const bR = el('button', 'btn', '恢复')
        bR.onclick = async () => {
          bR.disabled = true
          try {
            const r = await api('/api/trash/restore', { method: 'POST', body: { paths: [it.relPath] } })
            if (r.ok) { toast('已恢复「' + it.name + '」，曲库正在重新扫描'); sel.delete(it.relPath); await load() }
            else { toast('恢复失败：' + ((r.failed && r.failed[0] && r.failed[0].reason) || '未知原因'), true); bR.disabled = false }
          } catch (e) { toast('恢复失败：' + e.message, true); bR.disabled = false }
        }
        const bD = el('button', 'btn danger', '删除')
        bD.onclick = async () => {
          if (!await confirm2('彻底删除', '将永久删除「' + it.name + '」，无法恢复。确定继续？')) return
          bD.disabled = true
          try {
            const r = await api('/api/trash/purge', { method: 'POST', body: { paths: [it.relPath] } })
            sel.delete(it.relPath)
            if (r.ok) toast('已彻底删除')
            await load()
          } catch (e) { toast('删除失败：' + e.message, true); bD.disabled = false }
        }
        tdActs.appendChild(bR)
        tdActs.appendChild(bD)
        tr.appendChild(tdActs)
        tbody.appendChild(tr)
        rows.push({ relPath: it.relPath, cb })
      }
      tbl.appendChild(tbody)
      box.appendChild(tbl)
      sync()
    }

    selAll.onchange = () => {
      sel.clear()
      if (selAll.checked) for (const x of items) sel.add(x.relPath)
      sync()
    }
    bRes.onclick = async () => {
      const paths = [...sel]
      if (!paths.length) return
      bRes.disabled = true
      try {
        const r = await api('/api/trash/restore', { method: 'POST', body: { paths } })
        const bad = (r.failed && r.failed.length) || 0
        toast('已恢复 ' + r.ok + ' 个文件，曲库正在重新扫描' + (bad ? '（' + bad + ' 个失败）' : ''), r.ok === 0)
        sel.clear()
        await load()
      } catch (e) { toast('恢复失败：' + e.message, true); sync() }
    }
    bPurge.onclick = async () => {
      const paths = [...sel]
      if (!paths.length) return
      if (!await confirm2('彻底删除', '将永久删除选中的 ' + paths.length + ' 个文件，无法恢复。确定继续？')) return
      bPurge.disabled = true
      try {
        const r = await api('/api/trash/purge', { method: 'POST', body: { paths } })
        sel.clear()
        toast('已彻底删除 ' + r.ok + ' 个文件')
        await load()
      } catch (e) { toast('删除失败：' + e.message, true); sync() }
    }
    bClear.onclick = async () => {
      if (!items.length) return
      if (!await confirm2('清空回收站', '将永久删除回收站里的 ' + items.length + ' 个文件，无法恢复。确定继续？')) return
      bClear.disabled = true
      try {
        const r = await api('/api/trash/purge', { method: 'POST', body: { paths: ['*'] } })
        sel.clear()
        toast('已清空回收站（' + r.ok + ' 个文件）')
        await load()
      } catch (e) { toast('清空失败：' + e.message, true); sync() }
    }

    await load()
  }

  // ---------------- FM 电台（汽水「听歌模式」→ 自动续播频道） ----------------
  // 频道来自汽水 /luna/pc/feed/mode（45 个听歌模式，服务端实时拉取并缓存 1h）；
  // 每个频道的曲目由服务端按「频道名 + 配方词」从汽水歌单/搜索合成，仅保留免登录可播的免费全曲。
  let fmChannelsCache = []

  const fmAutoOn = () => localStorage.getItem('gusi-fm-auto') !== '0'

  async function loadFmChannels(force) {
    if (fmChannelsCache.length && !force) return fmChannelsCache
    const d = await api('/api/fm/modes')
    fmChannelsCache = Array.isArray(d.list) ? d.list : []
    return fmChannelsCache
  }

  /** 可选音源校验：汽水源被关掉时 FM 不可用（避免开台后整队播不出来） */
  function fmSourceEnabled() {
    const s = onlineSourcesCache.find(x => x.id === 'soda')
    return !s || s.enabled
  }

  /** 重拉在线源清单：主人在后台刚打开汽水开关时，不必整页刷新就能开台 */
  async function refreshOnlineSources() {
    try {
      const d = await api('/api/online/sources')
      if (d.sources && d.sources.length) onlineSourcesCache = d.sources
    } catch {}
  }

  /**
   * 汽水源被关掉时的可操作提示条。
   * FM 全部频道都来自汽水，「源未启用」光提示一句用户找不到开关在哪儿
   * （后台「音源与代理 → 在线音乐源」），所以这里直接给一条能点走的深链。
   */
  function fmWarnBar() {
    const w = el('div', 'fm-warn')
    w.appendChild(el('span', 'fm-warn-tx', '⚠ 汽水音乐源未启用，FM 电台无法开台。'))
    const a = el('a', 'btn', '去管理后台开启 →')
    a.href = BASE + '/admin/#sources'
    a.target = '_blank'
    a.rel = 'noopener'
    w.appendChild(a)
    return w
  }

  /** 开台：拉首批曲目交给播放器（FM 语义：顺序播放、队列见底自动续、按频道变速） */
  async function startFm(key, opts) {
    const o = opts || {}
    if (!fmSourceEnabled()) {
      // 可能只是本地缓存旧（后台刚开启）：重拉一次再判，真没开才拦 + 撤掉提示条
      await refreshOnlineSources()
      if (!fmSourceEnabled()) { toast('汽水音乐源未启用，请到管理后台「音源与代理」开启', true); return }
      const w = document.querySelector('.fm-warn')
      if (w) w.remove()
    }
    try {
      if (!o.silent) toast('正在接入频道…')
      const d = await api('/api/fm/next?key=' + encodeURIComponent(key) + '&limit=20')
      const rows = asOnlineRows(d.list)
      if (!rows.length) { toast('该频道暂时取不到可播放曲目', true); return }
      player.playFm({ key: d.key, name: d.name, rate: d.playbackRate || 1, poolSize: d.poolSize }, rows)
      localStorage.setItem('gusi-fm-key', d.key)
      localStorage.setItem('gusi-fm-name', d.name)
      toast('FM 已开台 · ' + d.name + '（池 ' + d.poolSize + ' 首' + ((d.playbackRate || 1) !== 1 ? ' · ' + d.playbackRate + ' 倍速' : '') + '）')
    } catch (e) {
      toast('开台失败：' + (e.message || e), true)
    }
  }

  /**
   * 频道卡 = 纯文字（主人 2026-09-15 决定去掉头像）。
   * 上游 feed/mode 确实给了 pic，但那是**近纯白图**：实测 300×300、最暗像素 253/255、
   * 约 2.1KB —— 原始 PNG 带透明通道，被 `~tplv-…resize:300:300.jpg` 这条图片处理参数
   * 压成了白底，深色卡片上就是一块白方块（不是代理挂了、也不是 CORS，直连上游同样是白的）。
   * 所以这里不渲染头像；哪天觉得卡片太素，先换内容源，别把 pic 加回来。
   */
  function fmCard(ch) {
    const c = el('div', 'fm-card')
    c.dataset.key = ch.key
    c.appendChild(el('div', 'fm-nm', ch.name))
    c.appendChild(el('div', 'fm-ds', ch.desc || ''))
    if (ch.playbackRate && ch.playbackRate !== 1) c.appendChild(el('span', 'fm-tag', ch.playbackRate + '× 慢放'))
    c.onclick = () => { startFm(ch.key) }
    return c
  }

  /** 频道卡「播放中」标记（开台/换台后调用；页面不在 #/fm 时自然无操作） */
  function paintFmCurrent() {
    const cur = player.fm ? player.fm.key : ''
    document.querySelectorAll('.fm-card').forEach((c) => {
      const on = !!cur && c.dataset.key === cur
      c.classList.toggle('on', on)
      const badge = c.querySelector('.fm-playing')
      if (on && !badge) c.insertBefore(el('span', 'fm-playing', '播放中'), c.firstChild)
      if (!on && badge) badge.remove()
    })
  }

  /** 无手势自动播放被浏览器拦截时的「继续收听」浮条（点一下即恢复，符合 autoplay 策略） */
  function showFmBlocked(fm) {
    let bar = document.getElementById('fm-unlock')
    if (!bar) {
      bar = el('button', 'fm-unlock')
      bar.id = 'fm-unlock'
      bar.onclick = () => {
        const a = player.audio
        if (a && a.src) a.play().catch(() => {})
        else player.start()
        bar.classList.remove('show')
      }
      document.body.appendChild(bar)
    }
    bar.textContent = '▶ 点击继续收听 FM · ' + (fm && fm.name ? fm.name : '电台')
    bar.classList.add('show')
  }
  function hideFmBlocked() {
    const b = document.getElementById('fm-unlock')
    if (b) b.classList.remove('show')
  }

  /** 打开网页/APP 自动开台：优先接着上次的 FM 队列（含播放位置），否则重开上次频道 */
  function maybeFmAutoplay() {
    if (!fmAutoOn()) return
    if (player.fm && player.queue.length) { player.start(); return }
    const key = localStorage.getItem('gusi-fm-key')
    if (key) void startFm(key, { silent: true })
  }

  routes.fm = async () => {
    setActiveNav('fm')
    const v = $('#view')
    // 顶部介绍横幅已删除（同上）：进来直接是「自动播放开关 + 频道网格」
    // 汽水源没开时先摆提示条（否则用户只会看到一排开不了台的频道卡）；
    // 进页面重拉一次源清单，后台刚改完开关不必整页刷新
    await refreshOnlineSources()
    if (!fmSourceEnabled()) v.appendChild(fmWarnBar())

    const row = el('div', 'fm-autorow')
    const lbl = el('label', 'set-toggle')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = fmAutoOn()
    cb.onchange = () => {
      localStorage.setItem('gusi-fm-auto', cb.checked ? '1' : '0')
      toast(cb.checked ? '已开启：打开应用自动播放 FM' : '已关闭：打开应用自动播放 FM')
    }
    lbl.appendChild(cb)
    lbl.appendChild(el('span', 'set-toggle-track'))
    row.appendChild(lbl)
    row.appendChild(el('span', 'fm-auto-hint', '打开网页/APP 自动播放（无手势时浏览器会拦截，点一下浮条「继续收听」即可）'))
    v.appendChild(row)

    const grid = el('div', 'fm-grid')
    v.appendChild(grid)
    grid.appendChild(el('div', 'fm-loading', '正在拉取汽水「听歌模式」…'))
    try {
      const list = await loadFmChannels()
      grid.innerHTML = ''
      if (!list.length) {
        grid.appendChild(el('div', 'fm-empty', '未取到频道（汽水接口可能已变更）'))
        return
      }
      for (const ch of list) grid.appendChild(fmCard(ch))
      paintFmCurrent()
    } catch (e) {
      grid.innerHTML = ''
      grid.appendChild(el('div', 'fm-empty', '频道拉取失败：' + (e.message || e)))
    }
  }

  routes.settings = async () => {
    setActiveNav('settings')
    const v = $('#view')

    // 标题
    v.appendChild(el('h2', 'page', '设置'))

    // 关于
    const about = el('section', 'set-section')
    about.appendChild(el('h3', 'set-sec-h', '关于'))
    const aboutGrid = el('div', 'set-grid')
    const aboutItems = [
      ['应用名称', '古四音乐'],
      ['定位', 'NAS 私人音乐库'],
      ['项目', 'github.com/sloveniator/fnos-music'],
    ]
    for (const [k, val] of aboutItems) {
      aboutGrid.appendChild(el('span', 'set-k', k))
      const valEl = el('span', 'set-v', val)
      if (val.startsWith('github.com')) {
        valEl.innerHTML = ''
        const a = el('a', null, val)
        a.href = 'https://' + val
        a.target = '_blank'
        a.rel = 'noopener'
        valEl.appendChild(a)
      }
      aboutGrid.appendChild(valEl)
    }
    about.appendChild(aboutGrid)
    v.appendChild(about)
    // 服务端版本（异步）
    api('/version').then(d => {
      if (!d.version) return
      const row = el('span', 'set-v', d.version)
      aboutGrid.appendChild(el('span', 'set-k', '服务端版本'))
      aboutGrid.appendChild(row)
    }).catch(() => {})

    // 播放偏好
    const pbPref = el('section', 'set-section')
    pbPref.appendChild(el('h3', 'set-sec-h', '播放偏好'))
    const pbGrid = el('div', 'set-grid')

    // 默认音量
    pbGrid.appendChild(el('span', 'set-k', '默认音量'))
    const volRow = el('label', 'set-vol-row')
    const volSlider = document.createElement('input')
    volSlider.type = 'range'; volSlider.min = '0'; volSlider.max = '100'
    volSlider.value = parseInt(localStorage.getItem('gusi-vol') ?? '80', 10)
    const volLabel = el('span', 'set-vol-val', volSlider.value + '%')
    volSlider.oninput = () => {
      volLabel.textContent = volSlider.value + '%'
      localStorage.setItem('gusi-vol', volSlider.value)
      if (player.audio) { player.audio.volume = volSlider.value / 100; $('#vol').value = volSlider.value }
    }
    volRow.appendChild(volSlider)
    volRow.appendChild(volLabel)
    pbGrid.appendChild(volRow)

    // 自动播放
    pbGrid.appendChild(el('span', 'set-k', '点击即播放'))
    const autoToggle = el('label', 'set-toggle')
    const autoCb = document.createElement('input')
    autoCb.type = 'checkbox'
    autoCb.checked = localStorage.getItem('gusi-autoplay') !== 'off'
    autoCb.onchange = () => localStorage.setItem('gusi-autoplay', autoCb.checked ? 'on' : 'off')
    autoToggle.appendChild(autoCb)
    autoToggle.appendChild(el('span', 'set-toggle-track'))
    pbGrid.appendChild(autoToggle)

    pbPref.appendChild(pbGrid)
    v.appendChild(pbPref)

    // FM 电台
    const fmSec = el('section', 'set-section')
    fmSec.appendChild(el('h3', 'set-sec-h', 'FM 电台'))
    const fmGrid = el('div', 'set-grid')
    fmGrid.appendChild(el('span', 'set-k', '打开自动播放'))
    const fmToggle = el('label', 'set-toggle')
    const fmCb = document.createElement('input')
    fmCb.type = 'checkbox'
    fmCb.checked = fmAutoOn()
    fmCb.onchange = () => {
      localStorage.setItem('gusi-fm-auto', fmCb.checked ? '1' : '0')
      toast(fmCb.checked ? '已开启：打开应用自动播放 FM' : '已关闭：打开应用自动播放 FM')
    }
    fmToggle.appendChild(fmCb)
    fmToggle.appendChild(el('span', 'set-toggle-track'))
    fmGrid.appendChild(fmToggle)
    fmGrid.appendChild(el('span', 'set-k', '上次频道'))
    fmGrid.appendChild(el('span', 'set-v', localStorage.getItem('gusi-fm-name') || '未开台'))
    fmGrid.appendChild(el('span', 'set-k', '频道目录'))
    const fmGo = el('span', 'set-v')
    const fmGoBtn = el('button', 'btn btn-sm', '前往 FM 电台 →')
    fmGoBtn.onclick = () => { location.hash = '#/fm' }
    fmGo.appendChild(fmGoBtn)
    fmGrid.appendChild(fmGo)
    fmSec.appendChild(fmGrid)
    v.appendChild(fmSec)

    // 数据管理
    const dataSec = el('section', 'set-section')
    dataSec.appendChild(el('h3', 'set-sec-h', '数据管理'))
    const dataGrid = el('div', 'set-grid')

    dataGrid.appendChild(el('span', 'set-k', '搜索历史'))
    const clearHist = el('button', 'btn')
    clearHist.textContent = '清除搜索历史'
    clearHist.onclick = () => {
      localStorage.removeItem('gusi-lh')
      toast('搜索历史已清除')
    }
    dataGrid.appendChild(el('span', 'set-v', ''))
    dataGrid.lastChild.appendChild(clearHist)

    dataGrid.appendChild(el('span', 'set-k', '播放队列'))
    const clearQ = el('button', 'btn')
    clearQ.textContent = '清除保存的队列'
    clearQ.onclick = () => {
      localStorage.removeItem('gusi-queue')
      localStorage.removeItem('gusi-mode')
      toast('播放队列已清除')
    }
    dataGrid.appendChild(el('span', 'set-v', ''))
    dataGrid.lastChild.appendChild(clearQ)

    dataSec.appendChild(dataGrid)
    v.appendChild(dataSec)

    // 我的分享（公开链接：免登录可听、有效期、提取码、允许下载）
    const shareSec = el('section', 'set-section')
    shareSec.appendChild(el('h3', 'set-sec-h', '我的分享'))
    const shareBox = el('div', 'share-list')
    shareBox.appendChild(el('div', 'share-empty', '正在载入…'))
    shareSec.appendChild(shareBox)
    const shareRefresh = el('button', 'btn btn-sm', '刷新')
    shareRefresh.onclick = () => paintShares()
    shareSec.appendChild(shareRefresh)
    v.appendChild(shareSec)

    async function paintShares() {
      shareBox.innerHTML = ''
      let list = []
      try {
        const d = await api('/api/share/list')
        list = d.shares || []
      } catch (e) {
        shareBox.appendChild(el('div', 'share-empty', '载入失败：' + e.message))
        return
      }
      if (!list.length) {
        shareBox.appendChild(el('div', 'share-empty', '还没有分享。在歌曲行菜单、专辑页、歌手页或歌单页点「分享」即可生成免登录链接。'))
        return
      }
      for (const s of list) {
        const row = el('div', 'share-item' + (s.expired ? ' dead' : ''))
        const main = el('div', 'share-item-main')
        main.appendChild(el('div', 'share-item-t', s.title || '(未命名)'))
        const bits = [s.typeText, s.count + ' 首', s.hasPassword ? '有提取码' : '无提取码', s.allowDownload ? '可下载' : '仅收听']
        const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '永久有效'
        bits.push((s.expired ? '已过期 ' : '有效至 ') + exp)
        bits.push('访问 ' + (s.visits || 0) + ' 次')
        main.appendChild(el('div', 'share-item-s', bits.join(' · ')))
        const ln = el('input', 'share-item-url')
        ln.value = s.url
        ln.readOnly = true
        ln.onclick = () => ln.select()
        main.appendChild(ln)
        row.appendChild(main)
        const acts = el('div', 'share-item-acts')
        const cp = el('button', 'btn btn-sm', '复制链接')
        cp.onclick = async () => {
          try {
            if (navigator.clipboard) await navigator.clipboard.writeText(s.url)
            else { ln.select(); document.execCommand('copy') }
            toast('链接已复制')
          } catch { ln.select(); toast('请手动复制') }
        }
        const revoke = el('button', 'btn btn-sm danger-btn', '撤销')
        revoke.onclick = async () => {
          if (!await confirm2('撤销分享', '撤销后这条链接立刻失效（已经拿到链接的人也听不了）。')) return
          try {
            await api('/api/share/remove', { method: 'POST', body: { codes: [s.code] } })
            toast('已撤销')
            paintShares()
          } catch (e) { toast(e.message, true) }
        }
        acts.appendChild(cp)
        acts.appendChild(revoke)
        row.appendChild(acts)
        shareBox.appendChild(row)
      }
    }
    paintShares()

    // 账户
    const acctSec = el('section', 'set-section')
    acctSec.appendChild(el('h3', 'set-sec-h', '账户'))
    const acctGrid = el('div', 'set-grid')
    acctGrid.appendChild(el('span', 'set-k', '当前用户'))
    acctGrid.appendChild(el('span', 'set-v', me ? me.name : '—'))
    acctGrid.appendChild(el('span', 'set-k', '管理后台'))
    const adminLink = el('a', 'btn')
    adminLink.href = BASE + '/admin/'
    adminLink.textContent = '打开管理后台 →'
    adminLink.target = '_blank'
    adminLink.rel = 'noopener'
    acctGrid.appendChild(el('span', 'set-v', ''))
    acctGrid.lastChild.appendChild(adminLink)
    acctGrid.appendChild(el('span', 'set-k', '退出登录'))
    const logoutBtn = el('button', 'btn danger-btn')
    logoutBtn.textContent = '退出登录'
    logoutBtn.onclick = async () => {
      try { await api('/logout', { method: 'POST' }) } catch {}
      logout()
    }
    acctGrid.appendChild(el('span', 'set-v', ''))
    acctGrid.lastChild.appendChild(logoutBtn)
    acctSec.appendChild(acctGrid)
    v.appendChild(acctSec)

    // 键盘快捷键提示
    const kbSec = el('section', 'set-section')
    kbSec.appendChild(el('h3', 'set-sec-h', '键盘快捷键'))
    const kbHint = el('div', 'set-kb-hint')
    const kbs = [
      ['Space', '播放/暂停'], ['← →', '快退/快进 5 秒'],
      ['↑ ↓', '音量 ±5'], ['N / P', '下一首/上一首'],
      ['L', '歌词全屏'], ['Q', '播放队列'],
      ['S', '播放模式'], ['M', '静音'],
      ['D', '下载当前曲目'], ['?', '快捷键面板'],
    ]
    for (const [k, desc] of kbs) {
      const r = el('div', 'set-kb-row')
      r.appendChild(el('kbd', null, k))
      r.appendChild(el('span', null, desc))
      kbHint.appendChild(r)
    }
    kbSec.appendChild(kbHint)
    v.appendChild(kbSec)
  }

  // ---------------- 播放器 ----------------
  const MODES = ['order', 'single', 'shuffle']
  const SVG_LOOP = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v4h-4"/><text x="12" y="15.5" font-size="9.5" text-anchor="middle" fill="currentColor">1</text></svg>'
  const SVG_SHUFFLE = '<svg viewBox="0 0 24 24"><path d="M3 7h3.6c1.5 0 2.9.8 3.6 2.1l1.5 2.7c.7 1.3 2.1 2.1 3.6 2.1H21"/><path d="M17.5 4.5 21 7l-3.5 2.5"/><path d="M3 17h3.6c1.5 0 2.9-.8 3.6-2.1l1.5-2.7c.7-1.3 2.1-2.1 3.6-2.1H21"/><path d="M17.5 14.5 21 17l-3.5 2.5"/></svg>'
  const MODE_ICONS = {
    order: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3v4h-4"/></svg>',
    single: SVG_LOOP,
    shuffle: SVG_SHUFFLE,
  }
  function setModeIcon(mode) {
    // 底栏与歌词全屏（移动端主控台）两处模式图标双写，避免只在歌词全屏内操作时反馈缺失
    const html = MODE_ICONS[mode] || MODE_ICONS.order
    const labels = { order: '顺序播放', single: '单曲循环', shuffle: '随机播放' }
    for (const id of ['btn-mode', 'lf-mode']) {
      const b = document.getElementById(id)
      if (!b) continue
      b.innerHTML = html
      b.classList.toggle('on', mode !== 'order')
      b.title = labels[mode] || '播放模式'
    }
  }

  // 音量滑块/静音图标跨控件双写（底栏 #vol 与歌词全屏 #lf-vol）
  function setVolume(v) {
    const a = player.audio
    if (!a) return
    v = Math.max(0, Math.min(100, Math.round(v * 100)))
    a.volume = v / 100
    localStorage.setItem('gusi-vol', String(v))
    for (const id of ['vol', 'lf-vol']) {
      const s = document.getElementById(id)
      if (s) s.value = String(v)
    }
  }
  function toggleMute() {
    if (!player.audio) return
    player.audio.muted = !player.audio.muted
    syncMuteIcon()
  }
  function syncMuteIcon() {
    const muted = !!(player.audio && player.audio.muted)
    for (const id of ['vol-ico', 'lf-vol-ico']) {
      const b = document.getElementById(id)
      if (b) b.classList.toggle('on', muted)
    }
  }

  // ---------------- 全局小工具：搜索历史 / 键盘 / 帮助面板 ----------------
  function loadHist(key) { try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] } }
  function saveHist(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr.slice(0, 10))) } catch {} }
  function pushHist(key, v) {
    if (!v) return
    const a = loadHist(key).filter(x => x !== v)
    a.unshift(v)
    saveHist(key, a)
  }
  function histChips(key, onClick, src) {
    let list = loadHist(key)
    if (src) list = list.filter(x => x.indexOf(src + ':') === 0).map(x => x.slice(src.length + 1))
    const wrap = el('div', 's-hist')
    if (!list.length) { wrap.hidden = true; return wrap }
    wrap.appendChild(el('span', 'sh-t', '历史'))
    list.forEach((q) => {
      const c = el('button', 'chip hchip', q)
      c.onclick = () => onClick(q)
      wrap.appendChild(c)
    })
    const clr = el('button', 'chip hchip clr', '清空')
    clr.onclick = (e) => { e.stopPropagation(); saveHist(key, src ? loadHist(key).filter(x => x.indexOf(src + ':') !== 0) : []); wrap.remove() }
    wrap.appendChild(clr)
    return wrap
  }
  function changeVol(delta) {
    const a = player.audio
    if (!a) return
    const v = Math.max(0, Math.min(100, Math.round((a.volume || 0) * 100) + delta))
    setVolume(v / 100)
  }
  const HELP_HTML = '' +
    '<div id="help-panel" class="modal" hidden><div class="modal-card help-card">' +
    '<div class="modal-head"><span>键盘快捷键</span><button id="help-close" class="iconbtn">×</button></div>' +
    '<div class="hp-grid">' +
    '<div><span class="kbd">Space</span><span>播放 / 暂停</span></div>' +
    '<div><span class="kbd">←</span><span>快退 5 秒</span></div>' +
    '<div><span class="kbd">→</span><span>快进 5 秒</span></div>' +
    '<div><span class="kbd">↑</span><span>音量 +5</span></div>' +
    '<div><span class="kbd">↓</span><span>音量 −5</span></div>' +
    '<div><span class="kbd">N</span><span>下一首</span></div>' +
    '<div><span class="kbd">P</span><span>上一首</span></div>' +
    '<div><span class="kbd">L</span><span>歌词全屏</span></div>' +
    '<div><span class="kbd">Q</span><span>播放队列</span></div>' +
    '<div><span class="kbd">S</span><span>播放模式（顺序/单曲/随机）</span></div>' +
    '<div><span class="kbd">M</span><span>静音开关</span></div>' +
    '<div><span class="kbd">D</span><span>下载当前曲目</span></div>' +
    '<div><span class="kbd">?</span><span>本面板</span></div>' +
    '<div><span class="kbd">Esc</span><span>关闭面板</span></div>' +
    '</div></div></div>'
  let helpBound = false
  function ensureHelpPanel() {
    if (document.getElementById('help-panel')) return
    const holder = el('div')
    holder.innerHTML = HELP_HTML
    document.body.appendChild(holder.firstElementChild)
    const close = document.getElementById('help-close')
    if (close) close.onclick = () => { $('#help-panel').hidden = true }
  }
  function toggleHelp() {
    ensureHelpPanel()
    const p = $('#help-panel')
    p.hidden = !p.hidden
  }
  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.code === 'Escape') t.blur()
        return
      }
      const seekBy = (s) => {
        const a = player.audio
        if (a && a.duration) a.currentTime = Math.max(0, Math.min(a.duration - 0.1, a.currentTime + s))
      }
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          // 空格 = 全局播放/暂停：即使焦点在按钮上也接管，避免误触发按钮原生 click（如焦点在“上一首”时被 prev() 重置回 0 重头播）
          if (e.repeat) break // 长按只切换一次，避免连续 toggle 抖动
          if (t && t.closest && t.closest('button')) t.blur()
          player.toggle()
          break
        case 'ArrowLeft': e.preventDefault(); seekBy(-5); break
        case 'ArrowRight': e.preventDefault(); seekBy(5); break
        case 'ArrowUp': e.preventDefault(); changeVol(5); break
        case 'ArrowDown': e.preventDefault(); changeVol(-5); break
        case 'KeyN': player.next(false); break
        case 'KeyP': player.prev(); break
        case 'KeyL':
          if ($('#player').hidden) return
          e.preventDefault()
          togglePlayPage()
          break
        case 'KeyQ':
          if ($('#player').hidden) return
          e.preventDefault()
          const qpanel = $('#queue')
          if (qpanel.hidden) { qpanel.hidden = false; player.renderQueue() }
          else qpanel.hidden = true
          break
        case 'KeyS':
          if ($('#player').hidden) return
          e.preventDefault()
          $('#btn-mode').click()
          break
        case 'KeyM': toggleMute(); break
        case 'KeyD':
          if ($('#player').hidden) return
          e.preventDefault()
          downloadCurrent()
          break
        case 'Slash': if (e.shiftKey) { e.preventDefault(); toggleHelp() } break
        case 'Escape':
          const hp = $('#help-panel')
          if (hp && !hp.hidden) hp.hidden = true
          const q2 = $('#queue')
          if (q2 && !q2.hidden) q2.hidden = true
          const lp = $('#lyric-full')
          if (lp && !lp.hidden) lp.hidden = true
          break
      }
    })
    helpBound = true
  }
  function updateLfBg() {
    const bg = document.getElementById('lf-bg')
    const discCover = document.getElementById('lf-disc-cover')
    if (!bg && !discCover) return
    const t = player.cur
    let url = 'assets/icon.png'
    if (t && t.kind === 'online') url = picProxy(t.pic) || 'assets/icon.png'
    else if (hasCoverOf(t)) url = mediaUrl('cover', t.id)
    if (bg) bg.style.backgroundImage = "url('" + url + "')"
    if (discCover) {
      discCover.src = url
      discCover.onerror = () => { discCover.src = 'assets/icon.png' }
    }
  }

  // 打开/关闭播放页（歌词全屏 + CD 旋转）；返回时同步刷新背景
  function togglePlayPage(force) {
    const page = $('#lyric-full')
    const show = (typeof force === 'boolean') ? force : page.hidden
    page.hidden = !show
    if (show) {
      updateLfBg()
      // 保持 CD 播放态：playing 由 setPlayIcon 同步
    }
  }

  const player = {
    audio: null, queue: [], index: -1, mode: localStorage.getItem('gusi-mode') || 'order',
    cur: null, lyric: null, lyricIdx: -1,
    // FM 电台状态：{ key, name, rate, played:Set<rid>, playedCount, refilling, poolSize }
    // 非 FM 播放（本地曲库/搜索列表）时为 null
    fm: null,
    // 随机播放无放回：已播过的下标，遍历完自动重置（避免连续重复）
    _visited: null,

    init() {
      this.audio = new Audio()
      // E2E 探针：音频元素未挂载 DOM，自动化测试需要读队列/倍速/FM 态（与 window.__onlineArea 同风格）
      window.__player = this
      this.audio.volume = (parseInt(localStorage.getItem('gusi-vol') ?? '80', 10)) / 100
      $('#vol').value = Math.round(this.audio.volume * 100)
      this.audio.addEventListener('timeupdate', () => this.tick())
      this.audio.addEventListener('ended', () => this.next(true))
      this.audio.addEventListener('pause', () => this.setPlayIcon(false))
      this.audio.addEventListener('playing', () => { this.setPlayIcon(true); this.applyFmRate(); this.onPlayOk() })
      this.audio.addEventListener('error', () => this.onPlayError())
      // 断点恢复：元数据就绪后跳回上次位置（仅一次）
      this.audio.addEventListener('loadedmetadata', () => {
        if (this._pendingAt && this.audio.duration && this._pendingAt > 1 && this._pendingAt < this.audio.duration - 1) {
          this.audio.currentTime = this._pendingAt
        }
        this._pendingAt = 0
        this.saveQ(this.audio.currentTime)
      })
      $('#btn-play').onclick = () => this.toggle()
      $('#btn-prev').onclick = () => this.prev()
      $('#btn-next').onclick = () => this.next(false)
      $('#btn-mode').onclick = () => {
        this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]
        localStorage.setItem('gusi-mode', this.mode)
        setModeIcon(this.mode)
      }
      setModeIcon(this.mode)
      $('#btn-queue').onclick = () => { $('#queue').hidden = !$('#queue').hidden; this.renderQueue() }
      $('#queue-close').onclick = () => { $('#queue').hidden = true }
      $('#btn-lyric').onclick = () => { togglePlayPage() }
      $('#lf-close').onclick = () => { togglePlayPage(false) }
      // 收藏当前曲目：本地与在线同一份「我喜欢」，只要行内有 source/rid 就能收藏
      const loveCur = () => {
        const t = this.cur
        if (!t) return
        toggleLoveOf(t).then(v => {
          toast(v ? '已加入我喜欢' : '已取消喜欢')
          this.renderNp()
        }).catch(e => toast(e.message, true))
      }
      $('#np-love').onclick = loveCur
      $('#np-download').onclick = (e) => downloadCurrent(e.currentTarget)
      // 播放页（歌词全屏）收藏/下载：与底栏共用逻辑
      $('#lf-love').onclick = loveCur
      $('#lf-download').onclick = (e) => downloadCurrent(e.currentTarget)
      // UPGRADE_0019: 点击底栏封面拉起播放页（CD 旋转 + 歌词）
      const npCover = $('#np-cover')
      if (npCover) {
        npCover.style.cursor = 'pointer'
        npCover.title = '打开播放页'
        npCover.onclick = (e) => { e.stopPropagation(); togglePlayPage() }
        const npArt = npCover.closest('.np-art')
        if (npArt) {
          npArt.style.cursor = 'pointer'
          npArt.onclick = (e) => { e.stopPropagation(); togglePlayPage() }
        }
      }
      $('#vol').oninput = (e) => setVolume(e.target.value / 100)
      $('#vol-ico').onclick = toggleMute
      const seek = $('#seek')
      const seekTo = (e) => {
        const r = seek.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
        if (this.audio.duration) this.audio.currentTime = ratio * this.audio.duration
      }
      seek.addEventListener('click', seekTo)
      seek.addEventListener('dragstart', e => e.preventDefault())
      // 2026-09-17 主人：「播放导航缩小时，歌曲进度条用不了」。
      // 窄屏底栏（≤900px）没有 seek 轴，只有贴顶边那条 2.5px 进度线 —— 以前它纯粹是反馈，
      // 点不动也拖不动，等于底栏里没有进度入口。现在把这条线本身做成可拖的轴：
      // 按住即定位预览、拖动跟手（拖动期间 tick 不回写，免得和手指打架）、松手才落 currentTime。
      // 命中区是覆盖在线上的一层透明条（#np-seek，宽高见 CSS），所以线上看到的宽度百分比
      // 与命中区的比例天然同源，不用担心 padding 偏移。
      const npSeek = document.getElementById('np-seek')
      if (npSeek) {
        const npRatioAt = (e) => {
          const r = npSeek.getBoundingClientRect()
          return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)))
        }
        const npPaint = (ratio) => {
          const bar = document.getElementById('np-progress')
          if (bar) bar.style.width = (ratio * 100) + '%'
        }
        let npDragging = false
        const npEnd = (e) => {
          if (!npDragging) return
          npDragging = false
          this._seeking = false
          const pl = document.getElementById('player')
          if (pl) pl.classList.remove('seeking')
          try { npSeek.releasePointerCapture(e.pointerId) } catch {}
          // 拖动中只预览；松手才真正 seek（拖动时反复写 currentTime 会让部分在线流重连）
          const d = this.audio.duration
          if (d) this.audio.currentTime = npRatioAt(e) * d
        }
        npSeek.addEventListener('pointerdown', (e) => {
          if (!this.audio.duration) return
          npDragging = true
          this._seeking = true
          const pl = document.getElementById('player')
          if (pl) pl.classList.add('seeking')
          npPaint(npRatioAt(e))
          try { npSeek.setPointerCapture(e.pointerId) } catch {}
          e.preventDefault()
        })
        npSeek.addEventListener('pointermove', (e) => { if (npDragging) npPaint(npRatioAt(e)) })
        npSeek.addEventListener('pointerup', npEnd)
        npSeek.addEventListener('pointercancel', npEnd)
        npSeek.addEventListener('dragstart', e => e.preventDefault())
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', () => this.toggle())
        navigator.mediaSession.setActionHandler('pause', () => this.toggle())
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prev())
        navigator.mediaSession.setActionHandler('nexttrack', () => this.next(false))
      }
      // 0016 移动端：点播放器信息区/封面 → 展开歌词全屏（进度/音量入口在全屏内）；收藏按钮不触发
      document.querySelector('.np').addEventListener('click', (e) => {
        if (e.target.closest('#np-love')) return
        if (window.matchMedia('(max-width: 900px)').matches && this.cur) {
          $('#lyric-full').hidden = false
          updateLfBg()
        }
      })
      // 0016 歌词全屏控制条：与底栏控制共用同一状态
      const lfSeek = $('#lf-seek')
      const lfSeekTo = (e) => {
        const r = lfSeek.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
        if (this.audio.duration) this.audio.currentTime = ratio * this.audio.duration
      }
      lfSeek.addEventListener('click', lfSeekTo)
      lfSeek.addEventListener('dragstart', e => e.preventDefault())
      $('#lf-mode').onclick = () => $('#btn-mode').click()
      $('#lf-prev').onclick = () => this.prev()
      $('#lf-next').onclick = () => this.next(false)
      $('#lf-play').onclick = () => this.toggle()
      $('#lf-vol').oninput = (e) => setVolume(e.target.value / 100)
      $('#lf-vol-ico').onclick = toggleMute
      this.restore()
    },

    // ---------- 队列 / 断点持久化 ----------
    saveQ(atSec) {
      try {
        const slim = this.queue.map(t => ({
          id: t.id, kind: t.kind, source: t.source, rid: t.rid, name: t.name, singer: t.singer,
          album: t.album, interval: t.interval, pic: t.pic, hasCover: hasCoverOf(t),
        }))
        localStorage.setItem('gusi-q', JSON.stringify({ queue: slim, index: this.index, at: atSec || 0, fm: this.fm ? { key: this.fm.key, name: this.fm.name, rate: this.fm.rate } : null }))
      } catch {}
    },
    restore() {
      try {
        const saved = JSON.parse(localStorage.getItem('gusi-q') || 'null')
        if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return
        this.queue = saved.queue
        this.index = Math.max(0, Math.min(saved.index ?? 0, this.queue.length - 1))
        const t = this.queue[this.index]
        if (!t) return
        this.cur = t
        // FM 队列恢复：频道信息（名称/倍速/已播集合）一并还原，后续续播才知道从哪个频道取
        if (saved.fm && saved.fm.key) {
          this.fm = {
            key: saved.fm.key, name: saved.fm.name || 'FM', rate: Number(saved.fm.rate) || 1,
            played: new Set(this.queue.filter(x => x.kind === 'online' && x.rid).map(x => String(x.rid))),
            playedCount: this.index + 1, refilling: false, poolSize: 0,
          }
        }
        this._pendingAt = Number(saved.at) || 0
        $('#player').hidden = false
        document.body.classList.add('has-player')
        this.renderNp()
        this.renderQueue()
        toast('已恢复上次播放队列 · 共 ' + this.queue.length + ' 首')
      } catch {}
    },

    play(list, idx) {
      this.fm = null // 非 FM 入口：退出电台态（倍速随之复位为 1x）
      this.queue = list.slice()
      this.index = idx
      this._visited = null
      this._errSeq = 0
      this._skips = []
      this.saveQ(0)
      this.start()
      paintFmCurrent()
    },
    enqueue(list) {
      if (!this.queue.length) return this.play(list, 0)
      this.queue.push(...list)
      this.renderQueue()
      this.saveQ(0)
    },
    // ---------- FM 电台 ----------
    /** 开台：接管队列，走 FM 语义（顺序播放 · 队列见底自动续 · 按频道变速） */
    playFm(info, rows) {
      this.fm = {
        key: info.key, name: info.name, rate: Number(info.rate) || 1,
        played: new Set(rows.map(r => String(r.rid))), playedCount: 1,
        refilling: false, poolSize: info.poolSize || 0,
      }
      this.queue = rows.slice()
      this.index = 0
      this._visited = null
      this._errSeq = 0
      this._skips = []
      this.mode = 'order'
      localStorage.setItem('gusi-mode', this.mode)
      setModeIcon(this.mode)
      this.saveQ(0)
      this.start()
      paintFmCurrent()
    },
    /** 续播：向服务端要下一批（带 exclude 去重），追加到队列尾部 */
    fmRefill() {
      const fm = this.fm
      if (!fm || fm.refilling) return
      fm.refilling = true
      const ex = Array.from(fm.played).slice(-600).join(',')
      api('/api/fm/next?key=' + encodeURIComponent(fm.key) + '&limit=20&exclude=' + encodeURIComponent(ex))
        .then((d) => {
          if (!this.fm || this.fm.key !== fm.key) return
          if (d.reset) fm.played.clear()
          const rows = asOnlineRows(d.list)
          rows.forEach(r => fm.played.add(String(r.rid)))
          if (d.poolSize) fm.poolSize = d.poolSize
          if (!rows.length) { toast('FM 取不到新曲目了（频道池可能已空）', true); return }
          this.queue.push(...rows)
          this.renderQueue()
          this.saveQ(0)
          toast('FM 续播 ' + rows.length + ' 首 · ' + fm.name + (d.reset ? '（已开启新一轮）' : ''))
        })
        .catch((e) => { toast('FM 续播失败：' + (e.message || e), true) })
        .finally(() => { fm.refilling = false })
    },
    /** 频道倍速（沉浸 0.8x = 0.8）；非 FM 时复位 1x */
    applyFmRate() {
      const rate = this.fm ? (Number(this.fm.rate) || 1) : 1
      if (this.audio && this.audio.playbackRate !== rate) {
        this.audio.playbackRate = rate
        this.renderNp()
      }
    },
    // 随机播放：打乱列表从头播，并切换洗牌模式（队列变更重置无放回记录）
    shufflePlay(list) {
      if (!list.length) return
      this.fm = null // 打乱播放属于非电台入口
      const arr = list.slice()
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp
      }
      this.queue = arr
      this.index = 0
      this.mode = 'shuffle'
      localStorage.setItem('gusi-mode', this.mode)
      setModeIcon(this.mode)
      this._errSeq = 0
      this._skips = []
      this.saveQ(0)
      this.start()
    },
    // 随机无放取下标：优先未播过；全播完自动重置
    _nextShuffle() {
      const n = this.queue.length
      if (!this._visited || this._visited.size >= n) {
        this._visited = new Set([this.index])
        return this.index
      }
      let next = -1
      const remaining = n - this._visited.size
      if (remaining === 1) {
        for (let i = 0; i < n; i++) if (!this._visited.has(i)) { next = i; break }
      } else {
        const step = Math.floor(Math.random() * remaining)
        for (let i = 0; i < n; i++) {
          if (this._visited.has(i)) continue
          if (step === 0) { next = i; break }
          step--
        }
      }
      if (next < 0) { // 兜底：顺序推进
        next = (this.index + 1) % n
        this._visited = null
      } else {
        this._visited.add(next)
      }
      return next
    },
    insertNext(track) {
      if (this.index < 0) return this.play([track], 0)
      this.queue.splice(this.index + 1, 0, track)
      this._visited = null
      this.renderQueue()
      this.saveQ(0)
    },
    stopAll() {
      this.audio.pause()
      this.queue = []
      this.index = -1
      this.cur = null
      this.fm = null
      hideFmBlocked()
      $('#player').hidden = true
      this.saveQ(0)
      paintFmCurrent()
    },
    // 播放失败自动跳过（VIP/版权在线曲、损坏文件不卡队列）；单曲循环也跳过坏曲
    onPlayError() {
      const t = this.cur
      if (!t) return
      if (!this._skips) this._skips = []
      if (this._skips.length < 6) this._skips.push(t.name)
      if (this.queue.length <= 1) {
        this.audio.pause()
        toast((t.kind === 'online' ? '在线歌曲暂不可播：' : '播放出错：') + t.name, true)
        return
      }
      this.index = (this.index + 1) % this.queue.length
      if (++this._errSeq >= this.queue.length) {
        this.audio.pause()
        this._errSeq = 0
        this._skips = []
        toast('队列里没有可播放的曲目（已尝试全部）', true)
        return
      }
      this.start()
    },
    onPlayOk() {
      hideFmBlocked()
      if (this._skips && this._skips.length) {
        toast('已跳过不可播 ' + this._skips.length + ' 首：' + this._skips.join('、'))
      }
      this._skips = []
      this._errSeq = 0
    },
    start() {
      const t = this.queue[this.index]
      if (!t) return
      this.cur = t
      $('#player').hidden = false
      document.body.classList.add('has-player')
      if (t.kind === 'online') {
        // 在线源：经 NAS 中转拉流（第三方直链不暴露给浏览器）
        this.audio.src = BASE + '/web/media/online/' + encodeURIComponent(t.source) + '/' + encodeURIComponent(t.rid) + '?k=' + encodeURIComponent(token)
        // 听在线歌也算口味信号：曲库索引里没有这些曲目，单独记一份给推荐用
        api('/api/played/online', { method: 'POST', body: { source: t.source, rid: t.rid, name: t.name, singer: t.singer, album: t.album } }).catch(() => {})
      } else {
        this.audio.src = mediaUrl('stream', t.id)
        api('/api/played', { method: 'POST', body: { trackId: t.id } }).catch(() => {})
      }
      this.applyFmRate()
      // 浏览器 autoplay 策略：无手势时 play() 会被拒 —— FM 场景给一条「继续收听」浮条兜底
      this.audio.play().catch(() => { if (this.fm) showFmBlocked(this.fm) })
      // FM：队列见底前预取下一批（顺序播放看 index 进度，随机播放靠已播计数兜底）
      if (this.fm) {
        this.fm.playedCount = (this.fm.playedCount || 0) + 1
        if (this.fm.playedCount >= this.queue.length - 4) this.fmRefill()
      }
      this.renderNp()
      this.renderQueue()
      this.saveQ(0)
      loadLyric(this, t)
    },
    toggle() {
      if (!this.cur) return
      if (!this.audio.src) { this.start(); return }
      if (this.audio.paused) this.audio.play().catch(() => {})
      else this.audio.pause()
    },
    next(auto) {
      if (!this.queue.length) return
      if (this.mode === 'single' && auto) { this.audio.currentTime = 0; this.audio.play(); return }
      let ni
      if (this.mode === 'shuffle') ni = this._nextShuffle()
      else ni = (this.index + 1) % this.queue.length
      if (!auto && ni === this.index && this.queue.length === 1) return
      this.index = ni
      this.start()
    },
    prev() {
      if (!this.queue.length) return
      if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return }
      this.index = (this.index - 1 + this.queue.length) % this.queue.length
      this.start()
    },
    setPlayIcon(playing) {
      $('#btn-play').innerHTML = playing ? SVG.pause : SVG.play
      const lfp = document.getElementById('lf-play')
      if (lfp) lfp.innerHTML = playing ? SVG.pause : SVG.play
      const eq = $('#np-eq')
      if (eq) eq.classList.toggle('on', playing)
      // UPGRADE_0019: CD 唱片随播放态旋转
      const disc = document.getElementById('lf-disc')
      if (disc) disc.classList.toggle('playing', playing)
    },
    tick() {
      const d = this.audio.duration || 0
      const c = this.audio.currentTime || 0
      $('#t-cur').textContent = fmtDur(c)
      $('#t-dur').textContent = fmtDur(d)
      $('#seek-fill').style.width = (d ? (c / d * 100) : 0) + '%'
      // v3：移动端底栏没有 seek 轴，用顶栏进度线给反馈（同源百分比）
      // 2026-09-17：这条线现在同时是底栏的进度轴（#np-seek 命中区拖动中），
      // 手指按住期间 tick 不回写，否则时间每 250ms 会把手拖到的位置拉回去。
      const npBar = document.getElementById('np-progress')
      if (npBar && !this._seeking) npBar.style.width = (d ? (c / d * 100) : 0) + '%'
      const lfFill = document.getElementById('lf-seek-fill')
      if (lfFill && !document.getElementById('lyric-full').hidden) {
        lfFill.style.width = (d ? (c / d * 100) : 0) + '%'
        document.getElementById('lf-t-cur').textContent = fmtDur(c)
        document.getElementById('lf-t-dur').textContent = fmtDur(d)
      }
      if ('mediaSession' in navigator && d) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d) }) } catch {}
      }
      if (!this._lastSaveT || c - this._lastSaveT > 15) { this._lastSaveT = c; this.saveQ(c) }
      syncLyric(this)
    },
    renderNp() {
      const t = this.cur
      if (!t) return
      $('#np-name').textContent = t.name
      // FM 播放时在歌手行尾标注频道来源（含倍速），电台态一眼可辨
      const fmTag = this.fm ? ' · FM ' + this.fm.name + (Number(this.fm.rate) !== 1 ? ' ' + this.fm.rate + '×' : '') : ''
      $('#np-singer').textContent = (t.singer || '未知歌手') + fmTag
      const img = $('#np-cover')
      const npLove = $('#np-love')
      const npDl = $('#np-download')
      if (t.kind === 'online') {
        img.src = picProxy(t.pic) || 'assets/icon.png'
        img.onerror = () => { img.src = 'assets/icon.png' }
        // 在线曲目也能收藏（服务端按 source+rid 存进「我喜欢」），只有拿不到 rid 时才禁掉
        const canLove = !!loveKeyOf(t)
        npLove.style.visibility = canLove ? '' : 'hidden'
        npLove.style.pointerEvents = canLove ? '' : 'none'
        npLove.title = canLove ? '加入我喜欢 / 取消喜欢' : '该曲目无法收藏'
        // 在线曲目支持下载（服务端 ?dl=1 附加 Content-Disposition: attachment）
        const canOnlineDl = !!t.rid
        npDl.style.visibility = canOnlineDl ? '' : 'hidden'
        npDl.style.pointerEvents = canOnlineDl ? '' : 'none'
        npDl.title = canOnlineDl ? '下载当前曲目（在线）' : '在线源暂不可下载'
      } else {
        if (hasCoverOf(t)) {
          img.src = mediaUrl('cover', t.id)
          img.onerror = () => { img.src = 'assets/icon.png' }
        } else img.src = 'assets/icon.png'
        npLove.style.visibility = ''
        npLove.style.pointerEvents = ''
        npLove.title = '加入我喜欢 / 取消喜欢'
        npDl.style.visibility = t.id ? '' : 'hidden'
        npDl.style.pointerEvents = t.id ? '' : 'none'
      }
      const loved = isLoved(t)
      $('#np-love').style.color = loved ? 'var(--danger)' : ''
      // 播放页同步：红心状态随底栏；在线/本地同规则显隐
      const lfLove = $('#lf-love')
      const lfDl = $('#lf-download')
      if (lfLove) {
        lfLove.style.color = loved ? 'var(--danger)' : ''
        const canLove = !!loveKeyOf(t)
        lfLove.style.visibility = canLove ? '' : 'hidden'
        lfLove.style.pointerEvents = canLove ? '' : 'none'
      }
      if (lfDl) {
        const canDl = t.kind === 'online' ? !!t.rid : !!t.id
        lfDl.style.visibility = canDl ? '' : 'hidden'
        lfDl.style.pointerEvents = canDl ? '' : 'none'
      }
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: t.name, artist: t.singer || '', album: t.album || (t.kind === 'online' ? '在线音乐' : '古四音乐'),
            artwork: [{ src: t.kind === 'online' ? (picProxy(t.pic) || 'assets/icon.png') : (hasCoverOf(t) ? mediaUrl('cover', t.id) : 'assets/icon.png'), sizes: '256x256' }],
          })
        } catch {}
      }
      document.title = t.name + ' - 古四音乐'
      updateLfBg()
    },
    renderQueue() {
      $('#queue-count').textContent = this.queue.length ? (this.index + 1) + '/' + this.queue.length : ''
      const body = $('#queue-body')
      body.innerHTML = ''
      if (!this.queue.length) {
        const empty = el('div', 'q-empty')
        empty.textContent = '队列空空 · 去曲库或「在线音乐」添加歌曲'
        body.appendChild(empty)
        return
      }
      this.queue.forEach((t, i) => {
        const r = el('div', 'q-row' + (i === this.index ? ' on' : ''))
        r.appendChild(el('span', 'qn', String(i + 1)))
        const nm = el('span', 'qt', t.name)
        if (t.kind === 'online') nm.appendChild(el('em', 'q-badge', '在线'))
        r.appendChild(nm)
        r.appendChild(el('span', 'qs', t.singer || ''))
        const x = el('button', 'iconbtn q-x', '×')
        x.title = '从队列移除'
        x.onclick = (e) => {
          e.stopPropagation()
          this.queue.splice(i, 1)
          this._visited = null
          if (this.index > i) this.index--
          else if (this.index === i) { this.index = Math.max(0, i - 1); if (this.queue.length) this.start(); else this.stopAll() }
          this.renderQueue()
          this.saveQ(0)
        }
        r.appendChild(x)
        r.onclick = () => { this.index = i; this.start() }
        body.appendChild(r)
      })
    },
  }
  player.init()

  // ---------------- 歌词 ----------------
  function parseLrc(text) {
    const lines = []
    for (const raw of String(text || '').split(/\r?\n/)) {
      const times = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
      if (!times.length) continue
      const content = raw.replace(/\[[^\]]*\]/g, '').trim()
      if (!content) continue
      for (const m of times) {
        const ms = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) * 1000 : 0)
        lines.push({ t: ms, text: content })
      }
    }
    return lines.sort((a, b) => a.t - b.t)
  }

  // 主歌词行 → 最近时间戳（±300ms 内）的翻译文本
  function matchTr(lines, tlText) {
    const trs = parseLrc(tlText)
    if (!trs.length) return {}
    const map = {}
    const used = new Array(trs.length).fill(false)
    for (let i = 0; i < lines.length; i++) {
      let best = -1
      let bestD = 301
      for (let j = 0; j < trs.length; j++) {
        if (used[j]) continue
        const d = Math.abs(trs[j].t - lines[i].t)
        if (d < bestD) { bestD = d; best = j }
      }
      if (best >= 0) { used[best] = true; map[i] = trs[best].text }
    }
    return map
  }

  async function loadLyric(pl, track) {
    pl.lyric = null
    pl.lyricIdx = -1
    $('#lf-title').textContent = track.name + ' - ' + (track.singer || '')
    const body = $('#lf-body')
    body.innerHTML = ''
    let d
    if (track.kind === 'online') {
      // wy（歌词+翻译）与 mg（歌词）支持在线歌词；其它源显示空态
      if (track.source !== 'wy' && track.source !== 'mg') {
        body.appendChild(el('p', 'none', '♪ 该在线源暂不支持歌词 ♪'))
        return
      }
      try {
        d = await api('/api/online/lyric?source=' + encodeURIComponent(track.source) + '&rid=' + encodeURIComponent(track.rid))
      } catch {
        d = null
      }
    } else {
      try {
        d = await api('/media/lyric/' + encodeURIComponent(track.id))
      } catch {
        d = null
      }
    }
    if (pl.cur !== track) return
    if (!d) { body.appendChild(el('p', 'none', '♪ 暂无歌词 ♪')); return }
    const lines = parseLrc(d.lyric)
    if (!lines.length) { body.appendChild(el('p', 'none', '♪ 暂无歌词 ♪')); return }
    pl.lyric = lines
    const trMap = track.kind === 'online' ? matchTr(lines, d.tlyric || '') : {}
    lines.forEach((ln, i) => {
      const p = el('p', null, ln.text)
      p.dataset.i = String(i)
      p.onclick = () => { pl.audio.currentTime = ln.t }
      body.appendChild(p)
      if (trMap[i]) {
        const tp = el('p', 'tr', trMap[i])
        tp.dataset.i = String(i)
        tp.onclick = () => { pl.audio.currentTime = ln.t }
        body.appendChild(tp)
      }
    })
  }

  function syncLyric(pl) {
    if (!pl.lyric || !pl.lyric.length) return
    const t = pl.audio.currentTime
    let idx = -1
    for (let i = 0; i < pl.lyric.length; i++) {
      if (pl.lyric[i].t <= t + 0.2) idx = i
      else break
    }
    if (idx === pl.lyricIdx) return
    pl.lyricIdx = idx
    const body = $('#lf-body')
    if ($('#lyric-full').hidden) return
    body.querySelectorAll('p').forEach(p => p.classList.toggle('on', Number(p.dataset.i) === idx))
    const on = body.querySelector('p[data-i="' + idx + '"]')
    if (on) on.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // ---------------- 启动 ----------------
  async function boot() {
    // PWA：Service Worker 注册（外部脚本，不受 CSP script-src 限制；失败静默）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {})
    }
    if (!token) return showLogin()
    try {
      const d = await api('/me')
      me = { name: d.name }
    } catch {
      return showLogin()
    }
    enterApp()
  }
  bindGlobalKeys()
  boot()
})()
