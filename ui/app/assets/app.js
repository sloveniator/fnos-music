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
    const headers = {}
    if (token && !opt.skipAuth) headers['X-Web-Token'] = token
    if (opt.body) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + '/web' + path, {
      method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined,
    })
    if (res.status === 401 && !opt.skipAuth) { logout(); throw new Error('登录已过期') }
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
    $('#login-name').focus()
    loadLoginState()
  }
  /** 拉取注册开关，决定 UI 分支：registerOpen=true 时只显示注册表单 */
  async function loadLoginState() {
    try {
      const d = await api('/login-state', { skipAuth: true })
      const open = !!(d && d.registerOpen)
      $('#login-form').hidden = open
      $('#register-form').hidden = !open
      $('#login-hint').textContent = open ? '首次使用？请先创建账户' : ''
      if (!open) { $('#login-name').focus() } else { $('#reg-name').focus() }
    } catch {
      $('#login-form').hidden = false
      $('#register-form').hidden = true
    }
  }
  async function enterApp() {
    $('#login').hidden = true
    $('#shell').hidden = false
    $('#who').textContent = me.name
    await refreshPlaylists()
    route()
    // 打开网页/APP 自动开台（FM 电台）：等首屏渲染落地后再起播，不抢首屏
    setTimeout(maybeFmAutoplay, 400)
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    $('#login-err').textContent = ''
    $('#login-btn').disabled = true
    try {
      const d = await api('/login', { method: 'POST', body: { name: $('#login-name').value.trim(), password: $('#login-pass').value } })
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
      if (pw !== cf) throw new Error('两次输入的密码不一致')
      const d = await api('/register', { method: 'POST', body: { name, password: pw, confirm: cf }, skipAuth: true })
      token = d.token
      localStorage.setItem('gusi-web-token', token)
      me = { name: d.name }
      $('#reg-name').value = ''
      $('#reg-pass').value = ''
      $('#reg-pass2').value = ''
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
    player.stopAll()
    showLogin()
  }
  $('#logout').onclick = async () => {
    try { await api('/logout', { method: 'POST' }) } catch {}
    logout()
  }

  // ---------------- 侧栏 / 路由 ----------------
  const TITLES = { home: '首页', tracks: '全部歌曲', albums: '专辑', artists: '歌手', search: '搜索', online: '在线音乐', fm: 'FM 电台', downloads: '下载中心', playlists: '我的歌单', settings: '设置' }
  function setActiveNav(name) {
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === name))
    $('#top-title').textContent = TITLES[name] || '古四音乐'
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
  function trackRow(t, musics, idx, opts) {
    opts = opts || {}
    const tr = el('tr', 'row')
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    // 首页推荐类列表不做勾选下载，故可省去多选列
    if (opts.noSelect !== true) tr.appendChild(selRowCell(t))
    tr.appendChild(el('td', 'num', String(idx + 1)))
    // NAS 曲库行内封面（hasCover 时懒加载；在线源行走 t.pic）
    const tdCov = el('td', 'cov')
    if (t.online) {
      const im = el('img')
      im.loading = 'lazy'
      im.alt = ''
      tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
      tr.appendChild(tdCov)
    } else {
      tdCov.appendChild(coverImg(t, null, (t.singer || '') + (t.album || '') + (t.name || '')))
      tr.appendChild(tdCov)
    }
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    if (opts.showSinger !== false) tdName.appendChild(el('div', 'sub', t.singer || '未知歌手'))
    tr.appendChild(tdName)
    if (opts.showAlbum !== false) {
      const tdAlbum = el('td', 'album-col ell', t.album || '—')
      tr.appendChild(tdAlbum)
    }
    const love = el('td', 'love')
    if (t.online) {
      // 第三方音源歌曲：Web 端无音源解析能力，置灰并提示去手机端播放
      tr.classList.add('disabled')
      tr.onclick = () => toast('「' + t.name + '」来自第三方音源，请在手机洛雪 App 中播放', true)
      love.appendChild(el('span', 'iconbtn', '·'))
      tr.appendChild(love)
      tr.appendChild(el('td', 'dur', t.interval || ''))
      if (opts.order) appendOrderBtns(tr, t, musics, idx)
      if (opts.menu) {
        // 空 acts 容器：供歌单移除按钮挂载
        const acts = el('td', 'acts')
        const wrap = el('span', 'more-wrap')
        acts.appendChild(wrap)
        tr.appendChild(acts)
      }
      return tr
    }
    const lb = el('button', 'iconbtn' + (loveIds.has('local_' + t.id) ? ' loved' : ''))
    lb.innerHTML = SVG.heart
    lb.onclick = async (e) => {
      e.stopPropagation()
      try {
        const d = await api('/api/love/toggle', { method: 'POST', body: { trackId: t.id } })
        if (d.loved) loveIds.add('local_' + t.id); else loveIds.delete('local_' + t.id)
        lb.classList.toggle('loved', d.loved)
      } catch (err) { toast(err.message, true) }
    }
    // 死引用（歌单里指向已被删/改名的曲库文件）：灰显，只留菜单里的「从歌单移除」
    love.appendChild(t.missing ? el('span', 'iconbtn', '·') : lb)
    if (t.missing) tr.classList.add('disabled')
    tr.appendChild(love)
    tr.appendChild(el('td', 'dur', t.interval || ''))
    if (opts.order && !t.missing) appendOrderBtns(tr, t, musics, idx)
    if (opts.menu) {
      const acts = el('td', 'acts')
      const wrap = el('span', 'more-wrap')
      const mb = el('button', 'iconbtn', '…')
      mb.onclick = (e) => { e.stopPropagation(); openTrackMenu(mb, t, musics, idx) }
      wrap.appendChild(mb)
      acts.appendChild(wrap)
      tr.appendChild(acts)
    }
    if (t.missing) {
      tr.onclick = () => toast('「' + t.name + '」的文件已不在曲库，用右侧「…」→「从歌单移除」清理', true)
      return tr
    }
    tr.ondblclick = () => player.play(musics, idx)
    tr.onclick = () => { player.play(musics, idx) }
    return tr
  }

  /** 歌单排序按钮（↑↓）：交换后整表提交 order API */
  function appendOrderBtns(tr, t, musics, idx) {
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
    tr.appendChild(td)
  }

  function trackTable(musics, opts) {
    const table = el('table', 'tracks' + (opts.compact ? ' compact' : ''))
    const thead = el('thead')
    const htr = el('tr')
    if (opts.noSelect !== true) htr.appendChild(selHeadCell())
    htr.appendChild(el('th', 'num', '#'))
    htr.appendChild(el('th', 'cov', ''))
    htr.appendChild(el('th', null, '歌曲'))
    if (opts.showAlbum !== false) htr.appendChild(el('th', 'album-col', '专辑'))
    htr.appendChild(el('th', 'love', ''))
    htr.appendChild(el('th', 'dur', '时长'))
    if (opts.order) htr.appendChild(el('th', 'order-col', ''))
    if (opts.menu) htr.appendChild(el('th', 'acts', ''))
    thead.appendChild(htr)
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
    mk('加入我喜欢', async () => {
      if (loveIds.has('local_' + track.id)) return toast('已在我喜欢中')
      try { await api('/api/love/toggle', { method: 'POST', body: { trackId: track.id } }); loveIds.add('local_' + track.id); toast('已收藏'); route() } catch (e) { toast(e.message, true) }
    })
    // 歌单目前只能存曲库内的曲目，所以只对本地曲目显示（与「删除…」一致）
    if (!track.online && track.id) mk('添加到歌单…', () => askAddToPlaylist([track]))
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

    // 骨架屏占位（只等统计——推荐区单独异步填，在线补歌要等第三方，别拖住整页）
    v.appendChild(skeletonRows(3))

    const stats = await api('/api/stats')

    // 清除骨架屏
    v.querySelectorAll('.sk-wrap').forEach(s => s.remove())

    // 统计条（专辑 27 张 / 歌手 22 位 / 全部歌曲 32 首 / 我喜欢 0 首）已按需求下线：
    // 专辑·歌手·全部歌曲 在侧边栏，「我喜欢」在「专辑/歌单 → 我的歌单」里，
    // 首屏直接进「为你推荐」更干净。

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

    if (!stats.tracks) {
      const tip = el('div', 'empty', '曲库还是空的。到管理后台「音乐库」添加目录并扫描，或把音乐放进 NAS 共享目录后授权给本应用。')
      const a = el('a', 'btn primary')
      a.href = BASE + '/admin/'
      a.textContent = '去管理后台 →'
      a.style.display = 'inline-block'
      a.style.marginTop = '12px'
      tip.style.textAlign = 'center'
      tip.appendChild(el('br'))
      tip.appendChild(a)
      v.appendChild(tip)
    }
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
    rh.appendChild(el('div', 'fy-tip', '按本账户的收听习惯生成 · 每日更新'))
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
    const thead = el('thead')
    const htr = el('tr')
    htr.appendChild(el('th', 'num', '#'))
    htr.appendChild(el('th', 'cov', ''))
    htr.appendChild(el('th', null, '歌曲'))
    htr.appendChild(el('th', 'album-col', '专辑'))
    htr.appendChild(el('th', 'love', ''))
    htr.appendChild(el('th', 'dur', '时长'))
    htr.appendChild(el('th', 'acts', ''))
    thead.appendChild(htr)
    table.appendChild(thead)
    const tbody = el('tbody')
    tracks.forEach((t, i) => {
      tbody.appendChild(t.kind === 'online'
        ? mixOnlineRow(t, tracks, i)
        : trackRow(t, tracks, i, { noSelect: true, compact: true, menu: true }))
    })
    table.appendChild(tbody)
    return table
  }

  /** 在线行：本地行右侧是「…」菜单，这里同样给「…」，列结构才对得齐 */
  function mixOnlineRow(t, list, idx) {
    const tr = el('tr', 'row')
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    tr.appendChild(el('td', 'num', String(idx + 1)))
    const tdCov = el('td', 'cov')
    tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
    tr.appendChild(tdCov)
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    tdName.appendChild(el('div', 'sub', (t.singer || '未知歌手') + ' · 在线'))
    tr.appendChild(tdName)
    tr.appendChild(el('td', 'album-col ell', t.album || '—'))
    const love = el('td', 'love off')
    const lb = el('button', 'iconbtn')
    lb.innerHTML = SVG.heart
    lb.title = '在线曲目暂不支持收藏'
    lb.onclick = (e) => { e.stopPropagation(); toast('在线歌曲暂不支持收藏，可到手机端添加') }
    love.appendChild(lb)
    tr.appendChild(love)
    tr.appendChild(el('td', 'dur', t.interval ? fmtDur(Number(t.interval) / 1000) : ''))
    const acts = el('td', 'acts')
    const wrap = el('span', 'more-wrap')
    const mb = el('button', 'iconbtn', '…')
    mb.onclick = (e) => {
      e.stopPropagation()
      popMenu(mb, [
        ['▶ 立即播放', () => player.play(list, idx)],
        ['⏭ 下一首播放', () => player.insertNext(t)],
        ['💻 下载到本机', () => askDownload(asOnlineRows([t]), mb)],
        ['☁️ 保存到云盘', () => saveToCloud(asOnlineRows([t]))],
      ])
    }
    wrap.appendChild(mb)
    acts.appendChild(wrap)
    tr.appendChild(acts)
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
    btns.appendChild(selDelBtn())
    btns.appendChild(selPlBtn())
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
  routes.albums = async () => {
    setActiveNav('albums')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '专辑 / 歌单'))
    let abTab = 'albums'
    const tabs = el('div', 'tabs')
    const mk = (key, label) => {
      const b = el('button', key === abTab ? 'on' : '', label)
      b.onclick = () => { abTab = key; paint() }
      return b
    }
    const area = el('div')
    v.appendChild(tabs)
    v.appendChild(area)
    function paint() {
      tabs.innerHTML = ''
      tabs.appendChild(mk('albums', '专辑'))
      tabs.appendChild(mk('playlists', '我的歌单'))
      tabs.appendChild(mk('import', '导入歌单'))
      area.innerHTML = ''
      if (abTab === 'albums') paintAlbums()
      else if (abTab === 'playlists') renderPlaylistsView(area)
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
          rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i)))
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

  routes.artists = async () => {
    setActiveNav('artists')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '歌手'))
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
    setActiveNav('albums')
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
    v.appendChild(heroBlock(cover, album, metaParts.join(''), () => player.play(d.tracks, 0), [shuf, addAll]))
    v.appendChild(trackTable(d.tracks, { showSinger: false, showAlbum: false, menu: true, autoScroll: true }))
  }

  routes.artist = async (args, query) => {
    const q = new URLSearchParams(query)
    const singer = q.get('singer') || ''
    setActiveNav('artists')
    const v = $('#view')
    const d = await api('/api/artist?singer=' + encodeURIComponent(singer))
    const cover = d.tracks.find(hasCoverOf)
    const addAll = el('button', 'btn')
    addAll.textContent = '＋ 全部加到队列'
    addAll.onclick = () => { player.enqueue(d.tracks); toast('已加入 ' + d.tracks.length + ' 首') }
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => player.shufflePlay(d.tracks)
    v.appendChild(heroBlock(cover, singer, d.tracks.length + ' 首 · ' + d.albums.length + ' 专辑', () => player.play(d.tracks, 0), [shuf, addAll]))

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
  const renderPlaylistsView = async (v) => {
    const head = el('div', 'page-head')
    head.appendChild(el('h2', 'page', '我的歌单'))
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
    setActiveNav('playlists')
    const v = $('#view')
    await renderPlaylistsView(v)
  }

  routes.playlist = async (args) => {
    const id = decodeURIComponent(args.join('/'))
    setActiveNav('')
    const v = $('#view')
    const d = await api('/api/playlists/' + encodeURIComponent(id))
    const isFixed = id === 'default' || id === 'love'
    const tracks = d.tracks.map(m => ({
      id: m.trackId || m.id,
      name: m.name, singer: m.singer, album: (m.meta && m.meta.albumName) || '',
      interval: m.interval,
      online: !m.trackId, // 非 NAS 曲库曲目（第三方音源）：Web 不可播
      // 曲库里已没有这个 id（文件被删/改名/外部移动后重扫）：引用失效，只能从歌单移除
      missing: !!m.missing,
      hasCover: !!m.trackId && !m.missing,
      _musicId: m.id,
      _listId: id,
    }))
    const playable = tracks.filter(t => !t.online && !t.missing)
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
      + (thirdCount > 0 ? '（' + thirdCount + ' 首在线源歌曲需手机端播放）' : '')
      + (deadCount > 0 ? '（' + deadCount + ' 首引用已失效，可从行内 × 移除）' : '')
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => { if (playable.length) player.shufflePlay(playable); else toast('歌单里没有可在网页端播放的曲目', true) }
    v.appendChild(heroBlock(tracks.find(hasCoverOf), d.name, metaText, () => playable.length && player.play(playable, 0), [shuf, ...extra]))
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
  routes.search = async (args, query) => {
    setActiveNav('search')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '搜索'))
    const box = el('div', 'search-box')
    const input = el('input')
    input.placeholder = '搜索歌曲、歌手、专辑…'
    const btn = el('button', 'btn primary', '搜索')
    box.appendChild(input)
    box.appendChild(btn)
    v.appendChild(box)
    const hist = histChips('gusi-lh', (q) => { input.value = q; doSearch() })
    v.appendChild(hist)
    const result = el('div')
    v.appendChild(result)
    let tab = 'tracks'
    const q0 = new URLSearchParams(query).get('q') || ''
    const doSearch = async () => {
      const q = input.value.trim()
      if (!q) return
      pushHist('gusi-lh', q)
      location.hash = '#/search?q=' + encodeURIComponent(q)
      result.innerHTML = ''
      const tabs = el('div', 'tabs')
      for (const [key, label] of [['tracks', '歌曲'], ['albums', '专辑'], ['artists', '歌手']]) {
        const b = el('button', key === tab ? 'on' : '', label)
        b.onclick = () => { tab = key; doSearch() }
        tabs.appendChild(b)
      }
      result.appendChild(tabs)
      const enc = encodeURIComponent(q)
      if (tab === 'tracks') {
        const d = await api('/api/tracks?q=' + enc + '&size=100')
        if (!d.tracks.length) return result.appendChild(el('div', 'empty', '没有匹配的歌曲'))
        const rh = el('div', 'row-head')
        rh.appendChild(el('h3', null, '歌曲 · ' + d.total))
        const btns = el('div', 'btns')
        const bAll = el('button', 'btn ghost')
        bAll.innerHTML = SVG.play + '<span>播放全部</span>'
        bAll.onclick = () => player.play(d.tracks, 0)
        const bShuf = el('button', 'btn ghost')
        bShuf.innerHTML = SVG.shuffle + '<span>随机播放</span>'
        bShuf.onclick = () => player.shufflePlay(d.tracks)
        btns.appendChild(bAll); btns.appendChild(bShuf)
        rh.appendChild(btns)
        result.appendChild(rh)
        result.appendChild(trackTable(d.tracks, { menu: true }))
      } else if (tab === 'albums') {
        const d = await api('/api/albums?q=' + enc + '&size=100')
        const grid = el('div', 'grid')
        for (const a of d.albums) {
          const c = el('div', 'card')
          c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover'))
          c.appendChild(el('div', 't', a.name))
          c.appendChild(el('div', 's', a.singer))
          c.onclick = () => { location.hash = '#/album?singer=' + encodeURIComponent(a.singer) + '&album=' + encodeURIComponent(a.name) }
          grid.appendChild(c)
        }
        result.appendChild(grid)
      } else {
        const d = await api('/api/artists?q=' + enc + '&size=100')
        const grid = el('div', 'grid')
        for (const a of d.artists) {
          const c = el('div', 'card')
          c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover round'))
          c.appendChild(el('div', 't', a.name))
          c.appendChild(el('div', 's', a.count + ' 首'))
          c.onclick = () => { location.hash = '#/artist?singer=' + encodeURIComponent(a.name) }
          grid.appendChild(c)
        }
        result.appendChild(grid)
      }
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
  let ostate = { view: 'search', type: 'song', q: '', source: 'kw', page: 0, size: 20, total: 0, list: [], boards: [], bid: '', loading: false }

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
  const onlineRow = (t, idx) => {
    const tr = el('tr', 'row')
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    tr.appendChild(selRowCell(t))
    tr.appendChild(el('td', 'num', String(idx + 1)))
    const tdCov = el('td', 'cov')
    const im = el('img')
    im.loading = 'lazy'
    tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || '')))
    tr.appendChild(tdCov)
    const tdName = el('td')
    tdName.appendChild(el('div', null, t.name))
    tdName.appendChild(el('div', 'sub', t.singer || '未知歌手'))
    tr.appendChild(tdName)
    const tdAlbum = el('td', 'album-col ell', t.album || '—')
    tr.appendChild(tdAlbum)
    const tdB = el('td', 'dur')
    const pbtn = el('button', 'iconbtn')
    pbtn.innerHTML = SVG.play
    pbtn.title = '播放'
    pbtn.onclick = (e) => { e.stopPropagation(); player.play(ostate.list, idx) }
    const nbtn = el('button', 'iconbtn')
    nbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4.5v15"/><path d="M10.5 5.5 19 12l-8.5 6.5Z"/></svg>'
    nbtn.title = '下一首播放'
    nbtn.onclick = (e) => { e.stopPropagation(); player.insertNext(ostate.list[idx]) }
    const dbtn = el('button', 'iconbtn dl')
    dbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3.5v10"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4.5 16.5v2.8c0 .6.5 1.2 1.2 1.2h12.6c.7 0 1.2-.6 1.2-1.2v-2.8"/></svg>'
    dbtn.title = '下载'
    dbtn.onclick = (e) => {
      e.stopPropagation()
      askDownload(asOnlineRows([t]), dbtn)
    }
    tdB.appendChild(pbtn)
    tdB.appendChild(nbtn)
    tdB.appendChild(dbtn)
    tdB.appendChild(el('span', 'd', fmtDur(t.interval / 1000)))
    tr.appendChild(tdB)
    tr.onclick = () => { player.play(ostate.list, idx) }
    return tr
  }
  const onTableHead = (thead) => {
    const htr = el('tr')
    htr.appendChild(selHeadCell())
    htr.appendChild(el('th', 'num', '#'))
    htr.appendChild(el('th', 'cov', ''))
    htr.appendChild(el('th', null, '歌曲'))
    htr.appendChild(el('th', 'album-col', '专辑'))
    htr.appendChild(el('th', 'dur', '时长'))
    thead.appendChild(htr)
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
    ostate.list.forEach((t, i) => tbody.appendChild(onlineRow(t, i)))
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
      const d = await api('/api/online/search?source=' + encodeURIComponent(ostate.source) +
        '&q=' + encodeURIComponent(ostate.q) + '&type=' + ostate.type +
        '&page=' + (ostate.page + 1) + '&size=' + ostate.size)
      ostate.page++
      ostate.total = d.total
      if (isColl) {
        ostate.list = ostate.page === 1 ? d.list : ostate.list.concat(d.list)
        if (ostate.page === 1) initSel(ostate.list); else rebindSel(ostate.list)
        paintCollectionGrid(container)
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
    ostate.list.forEach((t, i) => tbody.appendChild(onlineRow(t, i)))
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
  // ---- 歌单广场：直接浏览在线推荐歌单（不用先搜索） ----
  let plazaCache = null
  let plazaPage = 0
  const renderPlaza = async () => {
    onlArea.innerHTML = ''
    const head = el('div', 'res-head')
    head.appendChild(el('span', 'res-info', '推荐歌单 · 直接点开即可播放 / 批量下载'))
    const bMore = el('button', 'btn ghost mini', '换一批')
    bMore.onclick = () => { plazaPage += 1; paint() }
    head.appendChild(bMore)
    onlArea.appendChild(head)
    const result = el('div', 'res')
    onlArea.appendChild(result)
    const PER = 24
    let total = 0
    function paint() {
      result.innerHTML = ''
      if (!plazaCache) { result.appendChild(skeletonGrid(8)); return }
      total = plazaCache.length
      if (!total) { result.appendChild(el('div', 'empty', '暂时拿不到推荐歌单，稍后再试')); return }
      const grid = el('div', 'grid coll-grid')
      for (let i = 0; i < Math.min(PER, total); i++) {
        const rp = plazaCache[(plazaPage * PER + i) % total]
        const card = el('div', 'card coll-card')
        const cov = el('div', 'cover')
        cov.appendChild(picImg(rp.pic, null, rp.name))
        card.appendChild(cov)
        card.appendChild(el('div', 't', rp.name))
        card.appendChild(el('div', 's', (rp.creator ? rp.creator + ' · ' : '') + (rp.trackCount ? rp.trackCount + ' 首' : '歌单')))
        card.onclick = () => openCollection('wy', 'playlist', rp)
        grid.appendChild(card)
      }
      result.appendChild(grid)
    }
    paint()
    if (!plazaCache) {
      try {
        const d = await api('/api/online/rec-playlists?source=wy&limit=60')
        plazaCache = d.list || []
      } catch (e) { plazaCache = []; toast(e.message, true) }
      paint()
    }
  }

  const renderSearch = () => {
    onlArea.innerHTML = ''
    const typeBox = el('div', 'chips mini type-chips')
    const src = onlineSourcesCache.find(x => x.id === ostate.source)
    const canAlbums = src && (src.abilities || []).includes('albums')
    const canPlaylists = src && (src.abilities || []).includes('playlists')
    const typeDefs = [['song', '单曲']]
    if (canAlbums) typeDefs.push(['album', '专辑'])
    if (canPlaylists) typeDefs.push(['playlist', '歌单'])
    for (const [key, label] of typeDefs) {
      const c = el('button', 'chip' + (ostate.type === key ? ' on' : ''), label)
      c.onclick = () => { ostate.type = key; ostate.page = 0; ostate.list = []; ostate.total = 0; renderSearch() }
      typeBox.appendChild(c)
    }
    onlArea.appendChild(typeBox)
    const box = el('div', 'search-box')
    const input = el('input')
    input.placeholder = ostate.type === 'song' ? '搜索在线歌曲…' : ostate.type === 'album' ? '搜索在线专辑…' : '搜索在线歌单…'
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
    if (ostate.list.length) {
      if (ostate.type === 'song') paintSearchTable(onlArea)
      else paintCollectionGrid(onlArea)
    }
    input.focus()
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
      c.onclick = () => { ostate.source = s.id; ostate.boards = []; ostate.view = 'search'; ostate.q = ''; ostate.list = []; ostate.page = 0; ostate.total = 0; onlColl = null; renderChips(); renderTabs(); renderArea() }
      onlChips.appendChild(c)
    }
  }
  const renderTabs = () => {
    onlTabs.innerHTML = ''
    const st = el('button', 'otab' + (ostate.view === 'search' ? ' on' : ''), '搜索')
    st.onclick = () => { ostate.view = 'search'; renderArea() }
    onlTabs.appendChild(st)
    const src = onlineSourcesCache.find(s => s.id === ostate.source)
    if (src && src.boards) {
      const bt = el('button', 'otab' + (ostate.view === 'boards' || ostate.view === 'board' ? ' on' : ''), '排行榜')
      bt.onclick = () => loadBoards()
      onlTabs.appendChild(bt)
    }
    const ab = src && (src.abilities || [])
    if (ab && ab.includes('playlists') && ab.includes('detail')) {
      const pt = el('button', 'otab' + (ostate.view === 'plaza' ? ' on' : ''), '歌单广场')
      pt.onclick = () => { ostate.view = 'plaza'; renderArea() }
      onlTabs.appendChild(pt)
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
    if (src && !(src.abilities || []).includes('detail')) {
      toast('该源暂不支持展开详情，试试网易云音源', true)
      return
    }
    onlColl = null
    const fromView = ostate.view === 'plaza' ? 'plaza' : 'search'
    onlArea.innerHTML = ''
    const hd = el('div', 'board-head')
    const back = el('button', 'btn ghost mini', fromView === 'plaza' ? '← 返回歌单广场' : '← 返回搜索结果')
    back.onclick = () => { ostate.view = fromView; renderArea() }
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
    rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i)))
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
咪咕：music.migu.cn/v3/music/playlist/...（暂不支持展开）</pre>
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
        rows.forEach((t, i) => tbody.appendChild(onlineRow(t, i)))
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
    // 顶部信息卡：同时充当页面标题，避免「标题 + 副标题 + tab 栏」三层重复
    const banner = el('div', 'online-banner')
    banner.appendChild(el('div', 'ob-t', '在线音乐'))
    banner.appendChild(el('div', 'ob-s', '多源搜索 · 排行榜 · 歌单广场 · 一键入库到本机曲库'))
    v.appendChild(banner)

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

  function shortDir(p) {
    if (!p) return ''
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
  }
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
  /** 拉取队列统计 / 配额 / 下载目录，渲染成单行 meta */
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
    const add = (cls, txt, title) => {
      const n = el('span', cls, txt)
      if (title) n.title = title
      box.appendChild(n)
      return n
    }
    if (stats) {
      add('dm-i dm-strong', stats.total + ' 首')
      if (stats.downloading) add('dm-i dm-run', stats.downloading + ' 下载中')
      if (stats.done) add('dm-i dm-ok', stats.done + ' 完成')
      if (stats.failed) add('dm-i dm-bad', stats.failed + ' 失败')
      add('dm-i', fmtBytes(stats.bytes))
    } else {
      add('dm-i', '统计不可用')
    }
    const dirPath = dlDir.current || dlDir.userDir || ''
    if (dirPath) add('dm-i dm-dir', '📁 ' + shortDir(dirPath), '下载目录：' + dirPath + (dlDir.autoAssigned ? '（自动分配）' : ''))
    if (quota && quota.effectiveGb) {
      const gb = 1024 * 1024 * 1024
      const pct = Math.min(100, (quota.usedBytes / gb) / Math.max(quota.effectiveGb, 0.0001) * 100)
      const q = el('span', 'dm-quota')
      const bar = el('span', 'dm-q-bar')
      const fill = el('i')
      if (pct >= 90) fill.className = 'full'
      else if (pct >= 70) fill.className = 'warn'
      fill.style.width = pct.toFixed(1) + '%'
      bar.appendChild(fill)
      q.appendChild(bar)
      q.appendChild(el('span', 'dm-q-txt', (quota.usedBytes / gb).toFixed(2) + ' / ' + quota.effectiveGb + ' GB'))
      q.title = quota.note || '存储配额'
      box.appendChild(q)
    }
    paintDlBadge()
  }

  const renderDlCenter = async (v) => {
    if (dlSse) { try { dlSse.close() } catch {} dlSse = null }
    v.innerHTML = ''
    v.appendChild(el('h2', 'page', '下载中心'))

    // ---- 顶部：搜索 Hero（搜索框常驻，不再有「搜索」Tab 与平台 Tab） ----
    const hero = el('div', 'dl-hero')
    const bar = el('div', 'dl-hero-bar')
    bar.appendChild(el('span', 'dl-hero-ic', '🔍'))
    const inp = el('input')
    inp.type = 'search'
    inp.placeholder = '搜索歌曲 / 歌手，自动搜全平台并合并'
    inp.value = dlState.q
    inp.maxLength = 100
    const btn = el('button', 'btn primary dl-hero-btn', '搜索')
    bar.appendChild(inp); bar.appendChild(btn)
    hero.appendChild(bar)
    const tip = el('div', 'dl-hero-tip'); tip.id = 'dl-hero-tip'
    hero.appendChild(tip)
    const metaBar = el('div', 'dl-meta'); metaBar.id = 'dl-meta'
    hero.appendChild(metaBar)
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
      const enabled = onlineSourcesCache.filter(s => s.enabled)
      tip.textContent = enabled.length
        ? '一次搜索覆盖 ' + enabled.map(s => s.name).join(' · ') + '；同一首歌自动合并成一行，可在曲目上切换下载源'
        : '⚠ 全部在线源已在管理后台停用，请到「音源与代理」页开启'
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
      if (!dlState.q) {
        res.appendChild(el('div', 'dl-res-empty', '输入关键词，一次搜遍全部已启用平台；同一首歌只占一行，可在曲目上切换下载源'))
        return
      }
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
      const thead = el('thead'); const htr = el('tr')
      const thChk = el('th', 'num')
      const thChkCb = document.createElement('input'); thChkCb.type = 'checkbox'; thChkCb.title = '全选'
      thChkCb.onchange = () => {
        if (thChkCb.checked) { for (const t of dlState.list) dlSearchSelected.add(t.key) }
        else dlSearchSelected = new Set()
        paintDlResults()
      }
      thChk.appendChild(thChkCb); htr.appendChild(thChk)
      htr.appendChild(el('th', 'cov', ''))
      htr.appendChild(el('th', null, '歌曲'))
      htr.appendChild(el('th', 'album-col', '专辑'))
      htr.appendChild(el('th', 'dur', '时长'))
      htr.appendChild(el('th', 'acts', '操作'))
      thead.appendChild(htr); tbl.appendChild(thead)
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
      const tr = el('tr', 'row')
      const tdChk = el('td', 'num')
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
      tdChk.appendChild(chk); tr.appendChild(tdChk)

      const tdCov = el('td', 'cov')
      const paintCov = () => { tdCov.innerHTML = ''; tdCov.appendChild(picImg(t.pic, null, (t.name || '') + (t.singer || ''))) }
      paintCov(); tr.appendChild(tdCov)

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
      tr.appendChild(tdName)

      tdAlbum = el('td', 'album-col ell', t.album || '—'); tr.appendChild(tdAlbum)
      tdDur = el('td', 'dur', fmtDur((t.intervalMs || 0) / 1000)); tr.appendChild(tdDur)

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
      tdAct.appendChild(bAdd); tr.appendChild(tdAct)
      return tr
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

  /** 开台：拉首批曲目交给播放器（FM 语义：顺序播放、队列见底自动续、按频道变速） */
  async function startFm(key, opts) {
    const o = opts || {}
    if (!fmSourceEnabled()) { toast('汽水音乐源未启用，请先在管理后台开启', true); return }
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
    const banner = el('div', 'fm-banner')
    banner.appendChild(el('div', 'fm-b-title', 'FM 电台'))
    banner.appendChild(el('div', 'fm-b-sub', '汽水「听歌模式」频道 · 打开即播 · 队列见底自动续播'))
    v.appendChild(banner)

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
      $('#np-love').onclick = () => {
        if (!this.cur) return
        const t = this.cur
        if (t.kind === 'online') { toast('在线歌曲暂不支持收藏，可到手机端添加'); return }
        api('/api/love/toggle', { method: 'POST', body: { trackId: t.id } }).then(d => {
          if (d.loved) loveIds.add('local_' + t.id); else loveIds.delete('local_' + t.id)
          this.renderNp()
        }).catch(e => toast(e.message, true))
      }
      $('#np-download').onclick = (e) => downloadCurrent(e.currentTarget)
      // 播放页（歌词全屏）收藏/下载：与底栏共用逻辑
      $('#lf-love').onclick = () => {
        if (!this.cur) return
        const t = this.cur
        if (t.kind === 'online') { toast('在线歌曲暂不支持收藏，可到手机端添加'); return }
        api('/api/love/toggle', { method: 'POST', body: { trackId: t.id } }).then(d => {
          if (d.loved) loveIds.add('local_' + t.id); else loveIds.delete('local_' + t.id)
          this.renderNp()
        }).catch(e => toast(e.message, true))
      }
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
      const npBar = document.getElementById('np-progress')
      if (npBar) npBar.style.width = (d ? (c / d * 100) : 0) + '%'
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
        npLove.style.visibility = 'hidden'
        npLove.style.pointerEvents = 'none'
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
        npDl.style.visibility = t.id ? '' : 'hidden'
        npDl.style.pointerEvents = t.id ? '' : 'none'
      }
      const loved = loveIds.has('local_' + t.id)
      $('#np-love').style.color = loved ? 'var(--danger)' : ''
      // 播放页同步：红心状态随底栏；在线/本地同规则显隐
      const lfLove = $('#lf-love')
      const lfDl = $('#lf-download')
      if (lfLove) {
        lfLove.style.color = loved && t.kind !== 'online' ? 'var(--danger)' : ''
        lfLove.style.visibility = t.kind === 'online' ? 'hidden' : ''
        lfLove.style.pointerEvents = t.kind === 'online' ? 'none' : ''
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
    try {
      const d = await api('/api/love-ids')
      loveIds = new Set(d.ids)
    } catch {}
    try {
      const d = await api('/api/online/sources')
      if (d.sources && d.sources.length) onlineSourcesCache = d.sources
    } catch {}
    enterApp()
  }
  bindGlobalKeys()
  boot()
})()
