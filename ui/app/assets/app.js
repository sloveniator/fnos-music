/* 古四音乐 · 消费者端 */
(function () {
  'use strict'

  // ---------------- 基础 ----------------
  const SVG = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.2 5.4v13.2L19.5 12Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 5h3.8v14H7Z"/><path d="M13.2 5H17v14h-3.8Z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 20.6s-7.9-5-7.9-10.3A4.5 4.5 0 0 1 12 7.5a4.5 4.5 0 0 1 7.9 2.8c0 5.3-7.9 10.3-7.9 10.3Z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h3.6c1.5 0 2.9.8 3.6 2.1l1.5 2.7c.7 1.3 2.1 2.1 3.6 2.1H21"/><path d="M17.5 4.5 21 7l-3.5 2.5"/><path d="M3 17h3.6c1.5 0 2.9-.8 3.6-2.1l1.5-2.7c.7-1.3 2.1-2.1 3.6-2.1H21"/><path d="M17.5 14.5 21 17l-3.5 2.5"/></svg>',
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
  const TITLES = { home: '首页', tracks: '全部歌曲', albums: '专辑', artists: '歌手', search: '搜索', online: '在线', playlists: '我的歌单', settings: '设置' }
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
      const box = $('#pl-list')
      box.innerHTML = ''
      for (const pl of playlistsCache) {
        const a = el('a', null, pl.name + ' (' + pl.count + ')')
        a.href = '#/playlist/' + encodeURIComponent(pl.id)
        if (location.hash === '#/playlist/' + encodeURIComponent(pl.id)) a.classList.add('on')
        box.appendChild(a)
      }
    } catch {}
  }

  const routes = {}
  function route() {
    const hash = location.hash || '#/home'
    const [pathPart, queryPart] = hash.substring(2).split('?')
    const seg = pathPart.split('/')
    const fn = routes[seg[0]]
    const view = $('#view')
    view.innerHTML = ''
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
    tr.appendChild(el('td', 'num', String(idx + 1)))
    // NAS 曲库行内封面（hasCover 时懒加载；在线源行走 t.pic）
    const tdCov = el('td', 'cov')
    if (t.online) {
      const im = el('img')
      im.loading = 'lazy'
      im.alt = ''
      im.src = t.pic && /^https?:\/\//.test(t.pic) ? t.pic : 'assets/icon.png'
      im.onerror = () => { im.src = 'assets/icon.png' }
      tdCov.appendChild(im)
      tr.appendChild(tdCov)
    } else if (t.hasCover) {
      tdCov.appendChild(coverImg(t, null))
      tr.appendChild(tdCov)
    } else {
      tr.appendChild(el('td', 'cov cov-empty', ''))
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
    love.appendChild(lb)
    tr.appendChild(love)
    tr.appendChild(el('td', 'dur', t.interval || ''))
    if (opts.order) appendOrderBtns(tr, t, musics, idx)
    if (opts.menu) {
      const acts = el('td', 'acts')
      const wrap = el('span', 'more-wrap')
      const mb = el('button', 'iconbtn', '…')
      mb.onclick = (e) => { e.stopPropagation(); openTrackMenu(mb, t, musics, idx) }
      wrap.appendChild(mb)
      acts.appendChild(wrap)
      tr.appendChild(acts)
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
    const table = el('table', 'tracks')
    const thead = el('thead')
    const htr = el('tr')
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
    return table
  }

  function openTrackMenu(btn, track, musics, idx) {
    document.querySelectorAll('.menu').forEach(m => m.remove())
    const menu = el('div', 'menu')
    const mk = (label, fn) => { const b = el('button', null, label); b.onclick = (e) => { e.stopPropagation(); menu.remove(); fn() }; menu.appendChild(b) }
    mk('立即播放', () => player.play(musics, idx))
    mk('下一首播放', () => { player.insertNext(track); toast('已插入下一首') })
    mk('加入我喜欢', async () => {
      if (loveIds.has('local_' + track.id)) return toast('已在我喜欢中')
      try { await api('/api/love/toggle', { method: 'POST', body: { trackId: track.id } }); loveIds.add('local_' + track.id); toast('已收藏'); route() } catch (e) { toast(e.message, true) }
    })
    mk('添加到歌单…', async () => {
      await refreshPlaylists()
      const targets = playlistsCache.filter(p => p.id !== 'love')
      if (!targets.length) return toast('还没有歌单，先在侧栏新建一个')
      const names = targets.map((p, i) => (i + 1) + '. ' + p.name).join('\n')
      const input = await prompt2('添加到歌单（输入序号）\n' + names, '1')
      const n = parseInt(input || '0', 10) - 1
      if (n < 0 || n >= targets.length) return
      try {
        await api('/api/playlists/' + encodeURIComponent(targets[n].id) + '/add', { method: 'POST', body: { trackIds: [track.id] } })
        toast('已添加到「' + targets[n].name + '」')
        refreshPlaylists()
      } catch (e) { toast(e.message, true) }
    })
    // 下载到本地：
    //   本地曲目（track.id）走 /web/media/download/<id>
    //   在线曲目（kind==='online' 且有 rid）走 /web/media/online/<source>/<rid>?dl=1
    //   若曲目既无本地 id 又无在线 rid（如从第三方客户端同步过来的歌单项）则不显示
    const canDl = track.id || (track.kind === 'online' && track.rid) || (track.online === true && track.rid)
    if (canDl) {
      mk('下载…', () => downloadTrack(track))
    }
    const wrap = btn.parentElement
    wrap.appendChild(menu)
    const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off) } }
    setTimeout(() => document.addEventListener('click', off), 0)
  }

  function coverImg(track, cls) {
    const img = el('img', cls)
    img.loading = 'lazy'
    if (track && track.hasCover) {
      img.src = mediaUrl('cover', track.id)
      img.onerror = () => { img.style.visibility = 'hidden' }
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
      return BASE + '/web/media/online/' + encodeURIComponent(t.source) + '/' + encodeURIComponent(t.rid)
        + '?dl=1&name=' + name + '&k=' + encodeURIComponent(token)
    }
    return mediaUrl('download', t.id)
  }
  function downloadCurrent() {
    const t = player.cur
    if (!t) return toast('当前无曲目', true)
    if (t.kind === 'online' && !t.rid) return toast('该在线曲目无法下载', true)
    if (t.kind !== 'online' && !t.id) return toast('当前曲目无法下载', true)
    const a = document.createElement('a')
    a.href = downloadUrl(t)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  function downloadTrack(t) {
    if (!t) return toast('该曲目无法下载', true)
    if (t.kind === 'online' && !t.rid) return toast('该在线曲目无法下载', true)
    if (t.kind !== 'online' && !t.id) return toast('该曲目无法下载', true)
    const a = document.createElement('a')
    a.href = downloadUrl(t)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // ---------------- 视图：首页 ----------------
  routes.home = async () => {
    setActiveNav('home')
    const v = $('#view')
    const hour = new Date().getHours()
    v.appendChild(el('h2', 'page', hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'))

    // 骨架屏占位
    v.appendChild(skeletonRows(5))

    // 并发拉取：统计卡片 + 发现页数据 + 最近播放
    const [stats, discover, played] = await Promise.all([
      api('/api/stats'),
      api('/api/discover'),
      api('/api/played'),
    ])

    // 清除骨架屏
    v.querySelectorAll('.sk-wrap').forEach(s => s.remove())

    // 统计卡片（保留）
    const quick = el('div', 'grid')
    quick.style.marginBottom = '8px'
    const tiles = [
      { svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.8"/><path d="M12 9.2v5.6"/></svg>', n: '专辑', s: stats.albums + ' 张', h: '#/albums' },
      { svg: '<svg viewBox="0 0 24 24"><rect x="9.2" y="2.6" width="5.6" height="11" rx="2.8"/><path d="M4.8 11.5a7.2 7.2 0 0 0 14.4 0"/><path d="M12 18.7V22"/></svg>', n: '歌手', s: stats.artists + ' 位', h: '#/artists' },
      { svg: '<svg viewBox="0 0 24 24"><path d="M9 18.5V5.5L21 3.2v13"/><circle cx="6.5" cy="18.5" r="2.8"/><circle cx="18.5" cy="16.2" r="2.8"/></svg>', n: '全部歌曲', s: stats.tracks + ' 首', h: '#/tracks' },
      { svg: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.8-5-7.8-10.2A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.8 2.7C19.8 15.5 12 20.5 12 20.5Z"/></svg>', n: '我喜欢', s: (playlistsCache.find(p => p.id === 'love') || {}).count + ' 首', h: '#/playlist/love' },
    ]
    for (const tile of tiles) {
      const c = el('div', 'card')
      const cov = el('div', 'cover')
      cov.innerHTML = tile.svg
      c.appendChild(cov)
      c.appendChild(el('div', 't', tile.n))
      c.appendChild(el('div', 's', tile.s))
      c.onclick = () => { location.hash = tile.h }
      quick.appendChild(c)
    }
    v.appendChild(quick)

    // 今日推荐（dailyMix：每天种子洗牌，同歌手最多 2 首）
    if (discover.dailyMix && discover.dailyMix.length) {
      const rh = el('div', 'row-head')
      rh.appendChild(el('h3', null, '今日推荐'))
      const btns = el('div', 'btns')
      const bAll = el('button', 'btn ghost')
      bAll.innerHTML = SVG.play + '<span>播放全部</span>'
      bAll.onclick = () => player.play(discover.dailyMix, 0)
      const bShuf = el('button', 'btn ghost')
      bShuf.innerHTML = SVG.shuffle + '<span>随机播放</span>'
      bShuf.onclick = () => player.shufflePlay(discover.dailyMix)
      btns.appendChild(bAll); btns.appendChild(bShuf)
      rh.appendChild(btns)
      v.appendChild(rh)
      v.appendChild(trackTable(discover.dailyMix.slice(0, 10), { menu: true }))
    }

    // 新入库（按 mtime 倒序）
    if (discover.newArrivals && discover.newArrivals.length) {
      const rh = el('div', 'row-head')
      rh.appendChild(el('h3', null, '新入库'))
      const btns = el('div', 'btns')
      const bAll = el('button', 'btn ghost', '播放全部')
      bAll.onclick = () => player.play(discover.newArrivals, 0)
      btns.appendChild(bAll)
      rh.appendChild(btns)
      v.appendChild(rh)
      v.appendChild(trackTable(discover.newArrivals.slice(0, 10), { menu: true, showAlbum: false }))
    }

    // 热门歌手（按曲目数降序，横向卡片网格）
    if (discover.hotArtists && discover.hotArtists.length) {
      const rh = el('div', 'row-head')
      rh.appendChild(el('h3', null, '热门歌手'))
      v.appendChild(rh)
      const grid = el('div', 'grid')
      grid.style.marginBottom = '24px'
      for (const a of discover.hotArtists) {
        const c = el('div', 'card')
        c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover'))
        c.appendChild(el('div', 't', a.name))
        c.appendChild(el('div', 's', a.count + ' 首 · ' + a.albumCount + ' 张'))
        c.onclick = () => { location.hash = '#/artist?singer=' + encodeURIComponent(a.name) }
        grid.appendChild(c)
      }
      v.appendChild(grid)
    }

    // 最近播放（保留）
    if (played.tracks && played.tracks.length) {
      const rh = el('div', 'row-head')
      rh.appendChild(el('h3', null, '最近播放'))
      const playedBtns = el('div', 'btns')
      const bAll = el('button', 'btn ghost')
      bAll.innerHTML = SVG.play + '<span>播放全部</span>'
      bAll.onclick = () => player.play(played.tracks, 0)
      const bShuf = el('button', 'btn ghost')
      bShuf.innerHTML = SVG.shuffle + '<span>随机播放</span>'
      bShuf.onclick = () => player.shufflePlay(played.tracks)
      playedBtns.appendChild(bAll); playedBtns.appendChild(bShuf)
      rh.appendChild(playedBtns)
      v.appendChild(rh)
      const list = played.tracks.slice(0, 20)
      v.appendChild(trackTable(list, { menu: true }))
    }
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
    head.appendChild(meta); head.appendChild(btns)
    v.appendChild(head)
    tracksPage = { page: 0, size: 60, total: 0, list: [], loading: false }
    const table = trackTable([], { menu: true })
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
    v.appendChild(el('h2', 'page', '专辑'))
    const d = await api('/api/albums?size=200')
    if (!d.albums.length) return v.appendChild(el('div', 'empty', '暂无专辑'))
    const grid = el('div', 'grid')
    for (const a of d.albums) {
      const c = el('div', 'card')
      const cover = coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover')
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
    v.appendChild(grid)
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
      c.appendChild(coverImg(a.coverTrackId ? { id: a.coverTrackId, hasCover: true } : null, 'cover round'))
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
    const cover = d.tracks.find(t => t.hasCover)
    const addAll = el('button', 'btn')
    addAll.textContent = '＋ 全部加到队列'
    addAll.onclick = () => { player.enqueue(d.tracks); toast('已加入 ' + d.tracks.length + ' 首') }
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => player.shufflePlay(d.tracks)
    v.appendChild(heroBlock(cover, album, singer + ' · ' + d.tracks.length + ' 首' + (d.tracks[0] && d.tracks[0].year ? ' · ' + d.tracks[0].year : ''), () => player.play(d.tracks, 0), [shuf, addAll]))
    v.appendChild(trackTable(d.tracks, { showSinger: false, showAlbum: false, menu: true }))
  }

  routes.artist = async (args, query) => {
    const q = new URLSearchParams(query)
    const singer = q.get('singer') || ''
    setActiveNav('artists')
    const v = $('#view')
    const d = await api('/api/artist?singer=' + encodeURIComponent(singer))
    const cover = d.tracks.find(t => t.hasCover)
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
      tabContent.appendChild(trackTable(hot, { showSinger: false, menu: true }))
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
  routes.playlists = async () => {
    setActiveNav('playlists')
    const v = $('#view')
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
      hasCover: !!m.trackId,
      _musicId: m.id,
      _listId: id,
    }))
    const playable = tracks.filter(t => !t.online)
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
    const metaText = tracks.length + ' 首' + (playable.length < tracks.length ? '（' + (tracks.length - playable.length) + ' 首在线源歌曲需手机端播放）' : '')
    const shuf = shuffleBtn('随机播放')
    shuf.onclick = () => { if (playable.length) player.shufflePlay(playable); else toast('歌单里没有可在网页端播放的曲目', true) }
    v.appendChild(heroBlock(tracks.find(t => t.hasCover), d.name, metaText, () => playable.length && player.play(playable, 0), [shuf, ...extra]))
    if (!tracks.length) {
      v.appendChild(el('div', 'empty', '歌单还是空的，去曲库添加喜欢的歌吧'))
      return
    }
    const table = trackTable(tracks, { menu: true, order: !isFixed })
    if (!isFixed) {
      // 歌单内支持移除
      const tbody = table.querySelector('tbody')
      tbody.querySelectorAll('tr').forEach((tr, i) => {
        const acts = tr.querySelector('.acts .more-wrap')
        if (!acts) return
        const b = el('button', 'iconbtn', '×')
        b.title = '从歌单移除'
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

  $('#pl-create').onclick = async () => {
    const name = await prompt2('新建歌单', '')
    if (!name) return
    try {
      const d = await api('/api/playlists', { method: 'POST', body: { name } })
      await refreshPlaylists()
      location.hash = '#/playlist/' + encodeURIComponent(d.id)
    } catch (e) { toast(e.message, true) }
  }

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
  let ostate = { view: 'search', q: '', source: 'kw', page: 0, size: 20, total: 0, list: [], boards: [], bid: '', loading: false }
  const onlineRow = (t, idx) => {
    const tr = el('tr', 'row')
    if (player.cur && player.cur.id === t.id) tr.classList.add('playing')
    tr.appendChild(el('td', 'num', String(idx + 1)))
    const tdCov = el('td', 'cov')
    const im = el('img')
    im.loading = 'lazy'
    im.src = t.pic && /^https?:\/\//.test(t.pic) ? t.pic : 'assets/icon.png'
    im.onerror = () => { im.src = 'assets/icon.png' }
    tdCov.appendChild(im)
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
    tdB.appendChild(pbtn)
    tdB.appendChild(nbtn)
    tdB.appendChild(el('span', 'd', fmtDur(t.interval / 1000)))
    tr.appendChild(tdB)
    tr.onclick = () => { player.play(ostate.list, idx) }
    return tr
  }
  const onTableHead = (thead) => {
    const htr = el('tr')
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
      const d = await api('/api/online/search?source=' + encodeURIComponent(ostate.source) +
        '&q=' + encodeURIComponent(ostate.q) + '&page=' + (ostate.page + 1) + '&size=' + ostate.size)
      ostate.page++
      ostate.total = d.total
      const rows = d.list.map(x => ({
        id: x.source + '_' + x.id.replace(/^MUSIC_/, ''),
        kind: 'online', source: x.source, rid: x.id,
        name: x.name, singer: x.singer, album: x.album,
        interval: x.intervalMs, pic: x.pic,
      }))
      ostate.list = ostate.page === 1 ? rows : ostate.list.concat(rows)
      paintSearchTable(container)
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
    onlArea.appendChild(hd)
    if (!ostate.list.length) { onlArea.appendChild(el('p', 'hint', '榜单加载中…')); return }
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
    if (ostate.view === 'boards') {
      onlArea.innerHTML = ''
      if (!ostate.boards.length) { onlArea.appendChild(el('p', 'hint', '榜单加载中…')); return }
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
  const renderSearch = () => {
    onlArea.innerHTML = ''
    const box = el('div', 'search-box')
    const input = el('input')
    input.placeholder = '搜索在线歌曲…'
    const btn = el('button', 'btn primary', '搜索')
    box.appendChild(input); box.appendChild(btn)
    onlArea.appendChild(box)
    const run = () => {
      const q = input.value.trim()
      if (!q) return
      ostate.q = q; ostate.page = 0; ostate.list = []
      pushHist('gusi-oh', ostate.source + ':' + q)
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
    onlArea.appendChild(head)
    const result = el('div', 'res')
    onlArea.appendChild(result)
    btn.onclick = run
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    if (ostate.q) input.value = ostate.q
    if (ostate.list.length) paintSearchTable(onlArea)
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
      c.onclick = () => { ostate.source = s.id; ostate.boards = []; ostate.view = 'search'; renderChips(); renderTabs(); renderArea() }
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
      const bt = el('button', 'otab' + (ostate.view !== 'search' ? ' on' : ''), '排行榜')
      bt.onclick = () => loadBoards()
      onlTabs.appendChild(bt)
    }
  }
  routes.online = async () => {
    setActiveNav('online')
    const v = $('#view')
    v.appendChild(el('h2', 'page', '在线音乐'))
    const banner = el('div', 'online-banner')
    banner.appendChild(el('div', 'ob-t', '发现好音乐'))
    banner.appendChild(el('div', 'ob-s', '搜索 / 排行榜 · 在线公开音源 · 本机 NAS 中转 · 不留存文件'))
    v.appendChild(banner)
    onlChips = el('div', 'chips')
    onlTabs = el('div', 'otabs')
    onlArea = el('div')
    v.appendChild(onlChips)
    v.appendChild(onlTabs)
    v.appendChild(onlArea)
    window.__onlineArea = onlArea
    window.__onlineTabs = onlTabs
    api('/api/online/sources').then(d => {
      if (d.sources && d.sources.length) onlineSourcesCache = d.sources
      renderChips(); renderTabs(); renderArea()
    }).catch(() => { renderChips(); renderTabs(); renderArea() })
  }

  // ---------------- 下载中心（MVP） ----------------
  let dlState = {
    sources: onlineSourcesCache.slice(),
    source: 'kw', q: '', page: 0, size: 20, total: 0,
    list: [], loading: false, tab: 'search', filter: '',
  }
  let dlSse = null, dlQueue = []
  let dlDir = { current: '', dirs: [], authed: [], userDir: '', autoAssigned: false }
  // 容量条：limitGb / effectiveGb / usedBytes / remainingBytes / note
  let dlQuota = null
  async function loadDlQuota() {
    try {
      const d = await api('/api/quota')
      dlQuota = d
      const bar = document.getElementById('dl-quota-bar')
      if (!bar) return
      bar.innerHTML = ''
      if (!d) return
      const gb = 1024 * 1024 * 1024
      const usedGb = d.usedBytes / gb
      const pct = Math.min(100, (usedGb / Math.max(d.effectiveGb, 0.0001)) * 100)
      const cls = pct >= 90 ? 'dl-quota-full' : (pct >= 70 ? 'dl-quota-warn' : '')
      const head = el('div', 'dl-quota-head')
      head.appendChild(el('span', 'dl-quota-icon', '📊'))
      head.appendChild(el('span', 'dl-quota-title', `已用 ${usedGb.toFixed(2)} GB / ${d.effectiveGb} GB`))
      const rem = el('span', 'dl-quota-rem', `剩余 ${((d.remainingBytes / gb)).toFixed(2)} GB`)
      head.appendChild(rem)
      bar.appendChild(head)
      const barWrap = el('div', 'dl-quota-bar-wrap')
      const fill = el('div', 'dl-quota-fill' + (cls ? ' ' + cls : ''), '')
      fill.style.width = pct.toFixed(1) + '%'
      barWrap.appendChild(fill)
      bar.appendChild(barWrap)
      if (d.note) bar.appendChild(el('div', 'dl-quota-note', d.note))
    } catch { /* 静默 */ }
  }

  async function loadDownloadDir() {
    try {
      const d = await api('/api/downloads/dir')
      dlDir = { current: d.current || '', dirs: d.dirs || [], authed: d.authed || [], userDir: d.userDir || '', autoAssigned: !!d.autoAssigned }
    } catch { /* 保持空状态 */ }
    paintDownloadDir()
  }
  function paintDownloadDir() {
    const bar = document.getElementById('dl-dir-bar')
    if (!bar) return
    bar.innerHTML = ''
    const wrap = el('div', 'dl-dir-row')
    const icon = el('span', 'dl-dir-icon', '📁')
    wrap.appendChild(icon)
    const label = el('span', 'dl-dir-label', '下载目录')
    wrap.appendChild(label)
    // 显示自动分配的目录路径
    const dirPath = dlDir.current || dlDir.userDir || 'dataPath/library/'
    const dirDisplay = el('span', 'dl-dir-current', dirPath)
    dirDisplay.title = '此目录在注册时自动分配，无需手动设置'
    wrap.appendChild(dirDisplay)
    // 标记为自动分配
    if (dlDir.autoAssigned) {
      const badge = el('span', 'dl-dir-badge', '✓ 已自动分配')
      wrap.appendChild(badge)
    }
    bar.appendChild(wrap)
  }
  async function saveDownloadDir(dir) {
    if (!dir) { toast('目录不能为空', true); return }
    try {
      const r = await api('/api/downloads/dir', { method: 'POST', body: { dir } })
      dlDir.current = r.current || dir
      if (!dlDir.dirs.length || dlDir.dirs[0] !== dlDir.current) {
        dlDir.dirs = r.settings?.dirs || [dlDir.current]
      }
      toast('下载目录已更新')
      paintDownloadDir()
    } catch (e) { toast(e.message, true) }
  }

  routes.downloads = async () => {
    setActiveNav('downloads')
    if (dlSse) { try { dlSse.close() } catch {} dlSse = null }
    const v = $('#view'); v.innerHTML = ''
    v.appendChild(el('h2', 'page', '下载中心'))
    const banner = el('div', 'online-banner dl-banner')
    banner.appendChild(el('div', 'ob-t', '下载到 NAS 曲库'))
    banner.appendChild(el('div', 'ob-s', '搜索在线歌曲 → 加入下载队列 → 保存到本机曲库目录（多源并发 · 断点重试 · 已存在跳过）'))
    v.appendChild(banner)
    const dirBar = el('div', 'dl-dir-bar'); dirBar.id = 'dl-dir-bar'; v.appendChild(dirBar)
    const quotaBar = el('div', 'dl-quota-bar'); quotaBar.id = 'dl-quota-bar'; v.appendChild(quotaBar)
    const stBox = el('div', 'dl-stats'); stBox.id = 'dl-stats'; v.appendChild(stBox)
    const tabs = el('div', 'otabs'); v.appendChild(tabs)
    const area = el('div', 'dl-area'); v.appendChild(area)

    // 进入下载中心时刷新在线源（dlState.sources 是 init 快照，不能依赖缓存）
    api('/api/online/sources').then(d => {
      if (d.sources && d.sources.length) {
        onlineSourcesCache = d.sources
        dlState.sources = d.sources.slice()
        if (dlState.tab === 'search') renderDlArea(area)
      }
    }).catch(() => {})

    function renderDlTabs(box) {
      box.innerHTML = ''
      const t1 = el('button', 'otab' + (dlState.tab === 'search' ? ' on' : ''), '🔍 搜索')
      const t2 = el('button', 'otab' + (dlState.tab === 'queue' ? ' on' : ''), '⏬ 下载队列')
      const t3 = el('button', 'otab' + (dlState.tab === 'playlist' ? ' on' : ''), '📋 歌单导入')
      t1.onclick = () => { dlState.tab = 'search'; renderDlTabs(box); renderDlArea(area) }
      t2.onclick = () => { dlState.tab = 'queue'; renderDlTabs(box); renderDlArea(area) }
      t3.onclick = () => { dlState.tab = 'playlist'; renderDlTabs(box); renderDlArea(area) }
      box.appendChild(t1); box.appendChild(t2); box.appendChild(t3)
    }
    function renderDlStats(s) {
      stBox.innerHTML = ''
      if (!s) return
      const items = [['总数', s.total, ''], ['下载中', s.downloading, 'dl-active'], ['已完成', s.done, 'dl-done'], ['失败', s.failed, 'dl-failed'], ['体积', fmtBytes(s.bytes), '']]
      for (const [label, val, cls] of items) {
        const card = el('div', 'stat' + (cls ? ' ' + cls : ''))
        card.appendChild(el('div', 'st-v', String(val)))
        card.appendChild(el('div', 'st-l', label))
        stBox.appendChild(card)
      }
    }
    async function loadStats() {
      try { renderDlStats(await api('/api/downloads/stats')) } catch {}
    }
    function renderDlArea(box) {
      if (dlState.tab === 'search') renderSearch(box)
      else if (dlState.tab === 'queue') renderQueue(box)
      else renderPlaylist(box)
    }

    // ---- 搜索 ----
    function renderSearch(box) {
      box.innerHTML = ''
      const chips = el('div', 'chips')
      const enabled = dlState.sources.filter(s => s.enabled)
      if (!enabled.length) chips.appendChild(el('span', 'online-disabled', '⚠ 在线源已在管理后台停用'))
      for (const s of enabled) {
        const c = el('button', 'chip' + (dlState.source === s.id ? ' on' : ''), s.name)
        c.onclick = () => { dlState.source = s.id; dlState.list = []; dlState.page = 0; dlState.total = 0; renderSearch(box) }
        chips.appendChild(c)
      }
      box.appendChild(chips)
      const bar = el('div', 'dl-search-bar')
      const inp = el('input'); inp.type = 'text'; inp.placeholder = '搜索歌曲名 / 歌手（回车）'; inp.value = dlState.q; inp.maxLength = 100
      const btn = el('button', 'btn primary', '搜索')
      const doSearch = () => {
        const q = inp.value.trim()
        if (!q) { toast('请输入关键词', true); return }
        dlState.q = q; dlState.page = 0; dlState.total = 0; dlState.list = []
        loadDlSearch(box)
      }
      inp.onkeydown = (e) => { if (e.key === 'Enter') doSearch() }
      btn.onclick = doSearch
      bar.appendChild(inp); bar.appendChild(btn)
      box.appendChild(bar)
      const res = el('div', 'res'); res.id = 'dl-res'; box.appendChild(res)
      if (dlState.list.length) paintDlResults(res)
      else if (dlState.q) res.appendChild(el('p', 'hint', '加载中…'))
      else res.appendChild(el('p', 'hint', '输入关键词开始搜索'))
    }
    async function loadDlSearch(box) {
      if (dlState.loading || !dlState.q) return
      dlState.loading = true
      try {
        const d = await api('/api/downloads/search?source=' + encodeURIComponent(dlState.source) +
          '&q=' + encodeURIComponent(dlState.q) + '&page=' + (dlState.page + 1) + '&size=' + dlState.size)
        dlState.page++
        dlState.total = d.total
        dlState.list = dlState.page === 1 ? d.list : dlState.list.concat(d.list)
        const res = box.querySelector('#dl-res') || box.querySelector('.res')
        paintDlResults(res)
      } catch (e) { toast(e.message, true) }
      dlState.loading = false
    }
    // 批量下载选中项
    let dlSearchSelected = new Set()

    async function batchEnqueueSearch() {
      const items = dlState.list.filter(t => dlSearchSelected.has(t.source + '_' + t.id + '_' + t.name))
      if (!items.length) { toast('请先勾选要下载的曲目', true); return }
      const bar = document.querySelector('.dl-search-batch-bar')
      const btn = bar && bar.querySelector('[data-op="enqueue"]')
      if (btn) { btn.disabled = true; btn.textContent = '加入中…' }
      try {
        const r = await api('/api/downloads/enqueue', {
          method: 'POST',
          body: { items: items.map(t => ({ source: t.source, id: t.id, name: t.name, singer: t.singer, intervalMs: t.intervalMs, pic: t.pic, album: t.album })) },
        })
        const okN = r.accepted || 0
        const failN = (r.reasons || []).length
        if (okN > 0) {
          toast(`已加入 ${okN} 首到下载队列`); loadStats(); loadDlQuota()
        }
        if (failN > 0) {
          const r0 = (r.reasons || [])[0]
          if (r0) toast(`${failN} 首入队失败：${r0.reason || ''}`, true)
        }
        if (!okN && !failN) toast('入队失败', true)
        // 清空选中并刷新表格
        dlSearchSelected = new Set()
        const res = document.querySelector('#dl-res')
        if (res) paintDlResults(res)
      } catch (e) {
        toast(e.message, true)
        if (btn) { btn.disabled = false; btn.textContent = '⬇ 批量下载' }
      }
    }

    function updateSearchBatchBar() {
      const bar = document.querySelector('.dl-search-batch-bar')
      if (!bar) return
      const count = dlSearchSelected.size
      bar.querySelector('.dl-sel-count').textContent = '已选 ' + count + ' 首'
      const btn = bar.querySelector('[data-op="enqueue"]')
      if (btn) btn.disabled = count === 0
    }

    function paintDlResults(container) {
      if (!container) return
      container.innerHTML = ''
      container.appendChild(el('div', 'res-info', '「' + dlState.q + '」 · ' + srcName(dlState.source) + ' · 共 ' + dlState.total + ' 首'))
      if (!dlState.list.length) { container.appendChild(el('p', 'hint', '无结果')); return }
      // 批量操作栏
      const batchBar = el('div', 'dl-search-batch-bar')
      batchBar.innerHTML = `
        <label class="dl-sel-all" title="全选当前页"><input type="checkbox" id="dl-search-check-all"><span>全选</span></label>
        <span class="dl-sel-count">已选 0 首</span>
        <span class="dl-batch-spacer"></span>
        <button class="btn primary mini" data-op="enqueue" disabled>⬇ 批量下载</button>
      `
      batchBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-op]')
        if (b) batchEnqueueSearch()
      })
      const checkAll = batchBar.querySelector('#dl-search-check-all')
      if (checkAll) checkAll.onchange = () => {
        if (checkAll.checked) {
          for (const t of dlState.list) dlSearchSelected.add(t.source + '_' + t.id + '_' + t.name)
        } else dlSearchSelected = new Set()
        paintDlResults(container)
      }
      container.appendChild(batchBar)
      const tbl = el('table', 'tracks')
      const thead = el('thead')
      const htr = el('tr')
      const thChk = el('th', 'num')
      const thChkCb = document.createElement('input'); thChkCb.type = 'checkbox'; thChkCb.title = '全选本页'
      thChkCb.onchange = () => {
        if (thChkCb.checked) { for (const t of dlState.list) dlSearchSelected.add(t.source + '_' + t.id + '_' + t.name) }
        else { for (const t of dlState.list) dlSearchSelected.delete(t.source + '_' + t.id + '_' + t.name) }
        paintDlResults(container)
      }
      thChk.appendChild(thChkCb)
      htr.appendChild(thChk)
      htr.appendChild(el('th', 'cov', ''))
      htr.appendChild(el('th', null, '歌曲'))
      htr.appendChild(el('th', 'album-col', '专辑'))
      htr.appendChild(el('th', 'dur', '时长'))
      htr.appendChild(el('th', 'acts', '操作'))
      thead.appendChild(htr); tbl.appendChild(thead)
      const tbody = el('tbody')
      dlState.list.forEach((t, i) => tbody.appendChild(dlRow(t, i, container)))
      tbl.appendChild(tbody)
      container.appendChild(tbl)
      const more = el('button', 'load-more')
      more.hidden = dlState.total <= dlState.list.length
      more.textContent = '加载更多（' + dlState.list.length + ' / ' + dlState.total + '）'
      more.onclick = () => loadDlSearch(area)
      container.appendChild(more)
    }
    function dlRow(t, i, container) {
      const tr = el('tr', 'row')
      // 勾选框
      const tdChk = el('td', 'num')
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.title = '勾选下载'
      const selKey = t.source + '_' + t.id + '_' + t.name
      if (dlSearchSelected.has(selKey)) chk.checked = true
      chk.onchange = () => {
        if (chk.checked) dlSearchSelected.add(selKey)
        else dlSearchSelected.delete(selKey)
        updateSearchBatchBar()
        // 同步全选框状态
        const allCb = document.querySelector('#dl-search-check-all')
        const thCb = document.querySelector('table.tracks thead input[type=checkbox]')
        const allChecked = dlState.list.every(x => dlSearchSelected.has(x.source + '_' + x.id + '_' + x.name))
        if (allCb) allCb.checked = allChecked
        if (thCb) thCb.checked = allChecked
      }
      tdChk.appendChild(chk)
      tr.appendChild(tdChk)
      const tdCov = el('td', 'cov')
      const im = el('img'); im.loading = 'lazy'
      im.src = t.pic && /^https?:\/\//.test(t.pic) ? t.pic : 'assets/icon.png'
      im.onerror = () => { im.src = 'assets/icon.png' }
      tdCov.appendChild(im); tr.appendChild(tdCov)
      const tdName = el('td')
      tdName.appendChild(el('div', null, t.name))
      tdName.appendChild(el('div', 'sub', t.singer || '未知歌手'))
      tr.appendChild(tdName)
      tr.appendChild(el('td', 'album-col ell', t.album || '—'))
      tr.appendChild(el('td', 'dur', fmtDur((t.intervalMs || 0) / 1000)))
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
            toast('已加入下载队列'); loadStats(); loadDlQuota()
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
        renderDlStats(d.stats)
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
      if (!dlQueue.length) { box.appendChild(el('p', 'hint', '暂无下载任务。切到「搜索」标签加入歌曲。')); return }
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
        im.src = t.pic && /^https?:\/\//.test(t.pic) ? t.pic : 'assets/icon.png'
        im.onerror = () => { im.src = 'assets/icon.png' }
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
          done: '✓ 已完成 · ' + fmtBytes(t.size),
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
    function renderPlaylist(box) {
      box.innerHTML = ''
      const guide = el('div', 'dl-paste-guide')
      guide.innerHTML = `
        <div class="pg-title">粘贴歌单文本 · 批量入队</div>
        <div class="pg-desc">每行一首，识别 <b>歌手 - 曲名</b> 或 <b>歌手⇥曲名</b>（Tab 分隔）；可带版本备注。</div>
        <pre class="pg-sample">周杰伦 - 晴天
周杰伦	稻香
林俊杰 - 江南 - Live</pre>
      `
      box.appendChild(guide)

      const chips = el('div', 'chips')
      for (const s of dlState.sources.filter(s => s.enabled)) {
        const c = el('button', 'chip' + (dlState.source === s.id ? ' on' : ''), s.name)
        c.onclick = () => { dlState.source = s.id; paintPlaylists(box) }
        chips.appendChild(c)
      }
      if (!chips.children.length) chips.appendChild(el('span', 'online-disabled', '⚠ 在线源已在管理后台停用'))
      box.appendChild(chips)

      const bar = el('div', 'dl-search-bar')
      const ta = el('textarea', 'dl-paste-area')
      ta.rows = 10
      ta.placeholder = '粘贴歌单（每行一首）…\n支持：\n  周杰伦 - 晴天\n  周杰伦⇥稻香\n  林俊杰 - 江南 - Live'
      ta.spellcheck = false
      bar.appendChild(ta)
      const btn = el('button', 'btn primary', '🚀 解析并入队')
      btn.onclick = () => doParsePlaylists(ta.value)
      bar.appendChild(btn)
      box.appendChild(bar)

      const preview = el('div', 'dl-paste-preview'); preview.id = 'dl-paste-preview'
      box.appendChild(preview)
    }

    async function doParsePlaylists(text) {
      const preview = document.getElementById('dl-paste-preview')
      if (!preview) return
      preview.innerHTML = ''
      const wrap = el('div', 'dl-parse-wrap')
      wrap.appendChild(el('p', 'hint', '🔍 正在逐行搜索…'))
      preview.appendChild(wrap)
      try {
        const r = await api('/api/downloads/parse-text', {
          method: 'POST',
          body: { text, source: dlState.source, maxLines: 50 },
        })
        wrap.innerHTML = ''
        const okN = r.accepted || 0
        const skipN = r.skipped || 0
        const notFound = r.notFound || []
        const head = el('div', 'dl-parse-head')
        head.innerHTML = `✅ 已入队 <b>${okN}</b> 首${skipN ? '，跳过 <b>' + skipN + '</b> 首' : ''}${notFound.length ? '，未匹配 <b>' + notFound.length + '</b> 首' : ''}`
        wrap.appendChild(head)
        if (notFound.length) {
          const ul = el('ul', 'dl-parse-miss')
          for (const it of notFound.slice(0, 20)) {
            const li = el('li', null, `「${it.line}」 — ${it.reason}`)
            ul.appendChild(li)
          }
          wrap.appendChild(ul)
          if (notFound.length > 20) wrap.appendChild(el('p', 'hint', '… 还有 ' + (notFound.length - 20) + ' 条未列出'))
        }
        if (okN > 0) {
          const goto = el('button', 'btn ghost mini', '→ 查看下载队列')
          goto.onclick = () => { dlState.tab = 'queue'; const tabsBox = area.parentElement.querySelector('.otabs'); if (tabsBox) renderDlTabs(tabsBox); renderDlArea(area) }
          wrap.appendChild(goto)
        }
        toast(`歌单解析完成：入队 ${okN} 首`)
      } catch (e) { toast(e.message, true) }
    }

    renderDlTabs(tabs); renderDlArea(area); loadStats()
    loadDownloadDir()
    loadDlQuota()

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
          if (dlState.tab === 'queue') {
            const idx = dlQueue.findIndex(x => x.id === t.id)
            if (idx >= 0) dlQueue[idx] = t
            else dlQueue.unshift(t)
            paintQueue(document.getElementById('dl-queue'))
            loadStats()
          }
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

  // ---------------- 设置 ----------------
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
      if (e.code === 'Space' && t && t.closest('button')) return // 保留按钮原生激活
      const seekBy = (s) => {
        const a = player.audio
        if (a && a.duration) a.currentTime = Math.max(0, Math.min(a.duration - 0.1, a.currentTime + s))
      }
      switch (e.code) {
        case 'Space': e.preventDefault(); player.toggle(); break
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
    if (t && t.kind === 'online') url = t.pic || 'assets/icon.png'
    else if (t && (t.hasCover || t.id)) url = mediaUrl('cover', t.id)
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
    // 随机播放无放回：已播过的下标，遍历完自动重置（避免连续重复）
    _visited: null,

    init() {
      this.audio = new Audio()
      this.audio.volume = (parseInt(localStorage.getItem('gusi-vol') ?? '80', 10)) / 100
      $('#vol').value = Math.round(this.audio.volume * 100)
      this.audio.addEventListener('timeupdate', () => this.tick())
      this.audio.addEventListener('ended', () => this.next(true))
      this.audio.addEventListener('pause', () => this.setPlayIcon(false))
      this.audio.addEventListener('playing', () => { this.setPlayIcon(true); this.onPlayOk() })
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
      $('#np-download').onclick = () => downloadCurrent()
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
          album: t.album, interval: t.interval, pic: t.pic, hasCover: t.hasCover,
        }))
        localStorage.setItem('gusi-q', JSON.stringify({ queue: slim, index: this.index, at: atSec || 0 }))
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
        this._pendingAt = Number(saved.at) || 0
        $('#player').hidden = false
        document.body.classList.add('has-player')
        this.renderNp()
        this.renderQueue()
        toast('已恢复上次播放队列 · 共 ' + this.queue.length + ' 首')
      } catch {}
    },

    play(list, idx) {
      this.queue = list.slice()
      this.index = idx
      this._visited = null
      this._errSeq = 0
      this._skips = []
      this.saveQ(0)
      this.start()
    },
    enqueue(list) {
      if (!this.queue.length) return this.play(list, 0)
      this.queue.push(...list)
      this.renderQueue()
      this.saveQ(0)
    },
    // 随机播放：打乱列表从头播，并切换洗牌模式（队列变更重置无放回记录）
    shufflePlay(list) {
      if (!list.length) return
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
      $('#player').hidden = true
      this.saveQ(0)
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
      } else {
        this.audio.src = mediaUrl('stream', t.id)
        api('/api/played', { method: 'POST', body: { trackId: t.id } }).catch(() => {})
      }
      this.audio.play().catch(() => {})
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
      $('#np-singer').textContent = t.singer || '未知歌手'
      const img = $('#np-cover')
      const npLove = $('#np-love')
      const npDl = $('#np-download')
      if (t.kind === 'online') {
        img.src = t.pic || 'assets/icon.png'
        img.onerror = () => { img.src = 'assets/icon.png' }
        npLove.style.visibility = 'hidden'
        npLove.style.pointerEvents = 'none'
        // 在线曲目支持下载（服务端 ?dl=1 附加 Content-Disposition: attachment）
        const canOnlineDl = !!t.rid
        npDl.style.visibility = canOnlineDl ? '' : 'hidden'
        npDl.style.pointerEvents = canOnlineDl ? '' : 'none'
        npDl.title = canOnlineDl ? '下载当前曲目（在线）' : '在线源暂不可下载'
      } else {
        if (t.hasCover || t.id) {
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
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: t.name, artist: t.singer || '', album: t.album || (t.kind === 'online' ? '在线音乐' : '古四音乐'),
            artwork: [{ src: t.kind === 'online' ? (t.pic || 'assets/icon.png') : mediaUrl('cover', t.id), sizes: '256x256' }],
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
