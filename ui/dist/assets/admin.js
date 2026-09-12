/* ============================================================
 * 古四音乐 · 管理后台
 * 零构建原生三件套（index.html + admin.css + admin.js）
 * 认证：POST /admin/login → token → X-Admin-Token 头
 * 说明：CSP script-src 'self'，全部逻辑在本文件；'$' 是
 * document.querySelector 的简写，check-ids.js 用它核对静态 id。
 * ============================================================ */
'use strict'

const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))

// ---------------- 状态 ----------------
let TOKEN = localStorage.getItem('gusi-admin-token') || ''
let STREAM_TOKEN = ''
let CURRENT_TAB = 'overview'

// 曲库页状态
let lib = { q: '', page: 1, size: 50, total: 0, tracks: [], sel: new Set(), settings: null, dirs: [] }
// 下载页状态
let dlTargets = []
let dlTasks = []
// 用户/租户
let userList = []
let tenantData = []

const SOURCE_NAMES = { kw: '酷我', wy: '网易云', mg: '咪咕', kg: '酷狗', tx: 'QQ音乐' }
const PROXY_ALL = ['wy', 'kw', 'tx', 'kg', 'mg']
const ONLINE_ALL = ['kw', 'wy', 'mg']

// ---------------- 工具 ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtBytes = (n) => {
  const b = Number(n) || 0
  if (b <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = Math.floor(Math.log(b) / Math.log(1024))
  i = Math.min(i, u.length - 1)
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i]
}
const fmtTime = (t) => {
  if (!t) return '--:--'
  const s = Math.floor(Number(t) || 0)
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}
const fmtDate = (ts) => {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---------------- Toast ----------------
let toastTimer = null
const toast = (msg, ms = 2600) => {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, ms)
  return msg
}

// ---------------- Modal ----------------
let modalState = null // { onOpen, onClose }
const openModal = (title, html, onOpen) => {
  $('#modal-title').textContent = title
  $('#modal-body').innerHTML = html
  $('#modal').hidden = false
  modalState = { onOpen }
  if (onOpen) onOpen($('#modal-body'))
}
const closeModal = () => {
  $('#modal').hidden = true
  $('#modal-body').innerHTML = ''
  if (modalState?.onClose) modalState.onClose()
  modalState = null
}
$('#modal-close').addEventListener('click', closeModal)
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal() })

// ---------------- API ----------------
const api = async (path, opts = {}) => {
  const headers = { 'X-Admin-Token': TOKEN, ...(opts.headers || {}) }
  const options = { ...opts, headers }
  if (opts.body !== undefined && !(opts.body instanceof FormData) && typeof opts.body != 'string') {
    options.body = JSON.stringify(opts.body)
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(path, options)
  if (res.status === 401) {
    // token 过期/失效 → 退出到登录
    if (!path.endsWith('/admin/login')) {
      doLogout(false)
      throw new Error('未登录或会话过期')
    }
  }
  let data = null
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null)
  } else {
    data = await res.text().catch(() => '')
  }
  if (!res.ok) {
    const msg = (data && (data.msg || data.message)) || ('HTTP ' + res.status)
    throw new Error(msg)
  }
  // admin API 统一为 {code:0,data} 包装（或纯对象）；解包 data 字段供调用方直接使用
  const payload = (data && typeof data === 'object' && 'code' in data && 'data' in data) ? data.data : data
  return { status: res.status, data: payload }
}

// ---------------- 登录 ----------------
const doLogin = async (password) => {
  const r = await api('/admin/login', { method: 'POST', body: { password } })
  TOKEN = r.data.token
  localStorage.setItem('gusi-admin-token', TOKEN)
  $('#login').hidden = true
  $('#shell').hidden = false
  $('#login-err').textContent = ''
  $('#who').textContent = r.data.serverName || '管理后台'
  switchTab('overview')
  initAll()
}

const doLogout = (manual = true) => {
  TOKEN = ''
  localStorage.removeItem('gusi-admin-token')
  $('#login-pass').value = ''
  $('#login-err').textContent = ''
  $('#shell').hidden = true
  $('#login').hidden = false
  if (manual) toast('已退出登录')
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('#login-btn')
  btn.disabled = true
  btn.textContent = '登录中…'
  try {
    await doLogin($('#login-pass').value.trim())
  } catch (err) {
    $('#login-err').textContent = err.message
  } finally {
    btn.disabled = false
    btn.textContent = '登 录'
  }
})
$('#logout').addEventListener('click', () => doLogout(true))

// ---------------- Tab ----------------
const switchTab = (name) => {
  CURRENT_TAB = name
  $$('.nav .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  $$('.tab-page').forEach(p => { p.hidden = p.id !== 'tab-' + name })
  if (name === 'overview') loadOverview()
  if (name === 'users') loadUsers()
  if (name === 'library') loadLibrary()
  if (name === 'tenants') loadTenants()
  if (name === 'downloads') loadDownloads()
  if (name === 'sources') loadSources()
}
$$('.nav .tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)))
// ==================== 概览 ====================
const loadOverview = async () => {
  try {
    const [st, stats] = await Promise.all([
      api('/admin/api/status', { method: 'GET' }),
      api('/admin/api/library/stats', { method: 'GET' }),
    ])
    const s = st.data
    const d = stats.data
    // 服务状态卡片
    $('#status-cards').innerHTML = [
      statCard('服务状态', esc(s.status || '—'), 'status'),
      statCard('运行时长', Math.floor((s.uptime || 0) / 60) + ' 分钟', 'up'),
      statCard('服务地址', esc(s.address || '—'), 'addr'),
      statCard('连接设备', String(s.connections ?? 0) + ' 台', 'conn'),
      statCard('同步用户', String(s.users ?? 0) + ' 个', 'users'),
    ].join('')
    // 曲库统计卡片
    $('#lib-cards').innerHTML = [
      statCard('曲目', String(d.tracks ?? 0), 'tracks'),
      statCard('歌手', String(d.artists ?? 0), 'artists'),
      statCard('专辑', String(d.albums ?? 0), 'albums'),
      statCard('占用空间', fmtBytes(d.bytes), 'bytes'),
      statCard('令牌前缀', esc(d.tokenPreview || '—') + '…', 'token'),
    ].join('')
    // 扫描状态卡片
    const scan = d.scan || {}
    const pct = scan.total ? Math.round(100 * (scan.done || 0) / scan.total) : 0
    $('#scan-cards').innerHTML = [
      statCard('扫描状态', scan.scanning ? '扫描中 ' + pct + '%' : (scan.error ? '出错' : '空闲'), 'scan'),
      statCard('本次进度', String(scan.done || 0) + ' / ' + String(scan.total || 0), 'progress'),
      statCard('上次入库', fmtDate(d.scannedAt), 'scanned'),
    ].join('')
    // HTTPS 提示（非 localhost 明文 HTTP）
    const host = location.hostname
    const isLocal = host === 'localhost' || host.startsWith('127.') || host === '::1'
    const warn = $('#https-warn')
    if (location.protocol === 'http:' && !isLocal) {
      warn.hidden = false
      warn.innerHTML = '⚠️ 你正通过 <b>非 HTTPS</b> 地址访问。若需公网 / 跨网段访问，务必在服务前加 HTTPS 反向代理（Caddy / Nginx 示例见 README），并透传 WebSocket 与 Range 请求。'
    } else {
      warn.hidden = true
    }
  } catch (err) {
    toast('概览加载失败: ' + err.message)
  }
}

const statCard = (label, value, cls) =>
  '<div class="stat"><span>' + esc(label) + '</span><b class="st-' + cls + '">' + value + '</b></div>'

// ==================== 同步用户 ====================
const loadUsers = async () => {
  try {
    const r = await api('/admin/api/users', { method: 'GET' })
    userList = r.data.users || []
    renderUsers()
  } catch (err) {
    toast('用户加载失败: ' + err.message)
  }
}

const renderUsers = () => {
  const tb = $('#user-tbody')
  if (!userList.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">暂无同步用户。点击右上「新建用户」创建（用户名 + 连接码）。</td></tr>'
    return
  }
  tb.innerHTML = userList.map(u => `
    <tr data-user="${esc(u.name)}">
      <td><span class="t-name">${esc(u.name)}</span></td>
      <td>${u.deviceCount ?? 0} 台</td>
      <td class="u-quota">—</td>
      <td>
        <div class="row-acts">
          <button class="btn mini act-quota">配额</button>
          <button class="btn mini act-devices">设备</button>
          <button class="btn mini act-pwd">重置连接码</button>
          <button class="btn mini danger act-del">删除</button>
        </div>
      </td>
    </tr>`).join('')
  // 逐个拉配额
  userList.forEach(async (u) => {
    try {
      const r = await api('/admin/api/users/' + encodeURIComponent(u.name) + '/quota', { method: 'GET' })
      const q = r.data.quota
      const cell = tb.querySelector('tr[data-user="' + CSS.escape(u.name) + '"] .u-quota')
      if (cell) cell.textContent = (q?.maxGb != null ? q.maxGb + ' GB' : '自动') + (r.data.registered ? '' : '（内置）')
    } catch { /* ignore */ }
  })
}

const selectedUserName = (ev) => {
  const tr = ev.target.closest('tr')
  return tr ? tr.dataset.user : null
}

$('#user-tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const name = selectedUserName(e)
  if (!name) return
  if (btn.classList.contains('act-del')) {
    const c = confirm('删除用户 ' + name + '？\n其同步数据将无法再登录。')
    if (!c) return
    try {
      await api('/admin/api/users/' + encodeURIComponent(name) + '?purge=1', { method: 'DELETE' })
      toast('已删除用户 ' + name)
      loadUsers()
    } catch (err) { toast(err.message) }
  } else if (btn.classList.contains('act-pwd')) {
    openModal('重置连接码：' + name, `
      <label>新连接码（密码）<input type="text" id="m-new-pwd" autocomplete="off"></label>
      <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="m-pwd-ok">保存</button></div>
    `, (body) => {
      body.querySelector('#m-pwd-ok').addEventListener('click', async () => {
        const pwd = body.querySelector('#m-new-pwd').value.trim()
        if (!pwd) return toast('请输入连接码')
        try {
          await api('/admin/api/users/' + encodeURIComponent(name) + '/password', { method: 'POST', body: { password: pwd } })
          toast('连接码已更新')
          closeModal()
        } catch (err) { toast(err.message) }
      })
    })
  } else if (btn.classList.contains('act-devices')) {
    try {
      const r = await api('/admin/api/users/' + encodeURIComponent(name) + '/devices', { method: 'GET' })
      const devs = r.data.devices || []
      openModal('设备列表：' + name, `
        <table class="table">
          <thead><tr><th>设备名</th><th>ID</th><th>操作</th></tr></thead>
          <tbody>${devs.length ? devs.map(d => `
            <tr data-cid="${esc(d.clientId || '')}">
              <td>${esc(d.name || '—')}</td>
              <td style="font-size:11px;color:var(--muted)">${esc(d.clientId || '')}</td>
              <td><button class="btn mini danger dev-kick">移除</button></td>
            </tr>`).join('') : '<tr><td colspan="3" class="empty">无已连接设备</td></tr>'}
          </tbody>
        </table>
        <div class="btns"><button class="btn" data-close>关闭</button></div>
      `, (body) => {
        body.querySelectorAll('.dev-kick').forEach(b => b.addEventListener('click', async () => {
          const tr = b.closest('tr')
          const cid = tr.dataset.cid
          if (!confirm('移除该设备？')) return
          try {
            await api('/admin/api/users/' + encodeURIComponent(name) + '/devices/' + encodeURIComponent(cid), { method: 'DELETE' })
            tr.remove(); toast('设备已移除')
          } catch (err) { toast(err.message) }
        }))
      })
    } catch (err) { toast(err.message) }
  } else if (btn.classList.contains('act-quota')) {
    try {
      const r = await api('/admin/api/users/' + encodeURIComponent(name) + '/quota', { method: 'GET' })
      const q = r.data.quota
      openModal('网盘配额：' + name, `
        <p class="muted-note">${r.data.registered ? '该用户为运行时注册用户，可调整网盘配额。' : '该用户为内置用户，不支持调整配额。'}</p>
        <label>最大容量（GB，留空 / 0 = 自动计算）<input type="number" id="m-quota" min="0" step="0.1" value="${q?.maxGb ?? ''}" ${r.data.registered ? '' : 'disabled'}></label>
        <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="m-quota-ok" ${r.data.registered ? '' : 'disabled'}>保存</button></div>
      `, (body) => {
        body.querySelector('#m-quota-ok').addEventListener('click', async () => {
          const raw = body.querySelector('#m-quota').value
          const val = raw === '' ? null : Number(raw)
          try {
            await api('/admin/api/users/' + encodeURIComponent(name) + '/quota', { method: 'POST', body: { maxGb: val } })
            toast('配额已更新'); closeModal(); loadUsers()
          } catch (err) { toast(err.message) }
        })
      })
    } catch (err) { toast(err.message) }
  }
})

$('#btn-user-add').addEventListener('click', () => {
  openModal('新建同步用户', `
    <label>用户名（登录名 = 手机端连接账号）<input type="text" id="m-user-name" autocomplete="off"></label>
    <label>连接码（密码，手机端登录用）<input type="text" id="m-user-pwd" autocomplete="off"></label>
    <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="m-user-ok">创建</button></div>
  `, (body) => {
    body.querySelector('#m-user-ok').addEventListener('click', async () => {
      const name = body.querySelector('#m-user-name').value.trim()
      const pwd = body.querySelector('#m-user-pwd').value.trim()
      if (!name || !pwd) return toast('用户名与连接码不能为空')
      try {
        await api('/admin/api/users', { method: 'POST', body: { name, password: pwd } })
        toast('用户 ' + name + ' 已创建')
        closeModal(); loadUsers()
      } catch (err) { toast(err.message) }
    })
  })
})

// ==================== 音乐库 ====================
const loadLibrary = async () => {
  try {
    const r = await api('/admin/api/library/stats', { method: 'GET' })
    const d = r.data
    lib.settings = d.settings || {}
    lib.dirs = (d.settings?.dirs) || []
    STREAM_TOKEN = d.tokenPreview || ''
    // 完整 token（预览只有前 8 位）
    try {
      const tr = await api('/admin/api/library/stream-token', { method: 'GET' })
      if (tr.data?.token) STREAM_TOKEN = tr.data.token
    } catch { /* ignore */ }
    renderLibStats(d)
    renderDirs()
    renderToken()
    renderScan(d.scan)
    await loadSystemDirs()
    await loadTracks()
  } catch (err) {
    toast('音乐库加载失败: ' + err.message)
  }
}

const renderLibStats = (d) => {
  $('#lib-stats').innerHTML = [
    statCard('曲目', String(d.tracks ?? 0), 'tracks'),
    statCard('歌手', String(d.artists ?? 0), 'artists'),
    statCard('专辑', String(d.albums ?? 0), 'albums'),
    statCard('占用', fmtBytes(d.bytes), 'bytes'),
  ].join('')
}

const renderDirs = () => {
  const ul = $('#dir-list')
  if (!lib.dirs.length) {
    ul.innerHTML = '<li class="empty">尚未添加扫描目录</li>'
    return
  }
  ul.innerHTML = lib.dirs.map((d, i) => `
    <li><span>${esc(d)}</span><button class="x" data-idx="${i}" title="移除">×</button></li>`).join('')
}

$('#dir-list').addEventListener('click', (e) => {
  const x = e.target.closest('.x')
  if (!x) return
  lib.dirs.splice(Number(x.dataset.idx), 1)
  saveDirs()
})

$('#btn-dir-add').addEventListener('click', () => {
  const val = $('#dir-input').value.trim()
  if (!val) return toast('请输入目录路径')
  if (lib.dirs.includes(val)) return toast('目录已存在')
  lib.dirs.push(val)
  $('#dir-input').value = ''
  saveDirs()
})
$('#dir-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-dir-add').click() })

const saveDirs = async () => {
  try {
    await api('/admin/api/library/settings', { method: 'POST', body: { dirs: lib.dirs } })
    renderDirs()
    toast('目录已保存')
  } catch (err) { toast(err.message) }
}

// 系统授权目录（点选快捷填入）
const loadSystemDirs = async () => {
  try {
    const r = await api('/admin/api/library/system-dirs', { method: 'GET' })
    const dirs = r.data?.dirs || []
    const box = $('#sys-dirs')
    if (!dirs.length) { box.hidden = true; return }
    box.hidden = false
    box.innerHTML = dirs.map(d => `<span class="chip sys-dir" title="点击填入">${esc(d)}</span>`).join('')
    box.querySelectorAll('.sys-dir').forEach(chip => chip.addEventListener('click', () => {
      const d = chip.textContent
      if (!lib.dirs.includes(d)) { lib.dirs.push(d); saveDirs() }
    }))
  } catch { /* ignore */ }
}

const renderToken = () => {
  $('#token-view').value = STREAM_TOKEN ? STREAM_TOKEN.substring(0, 12) + '…' : '—'
}

$('#btn-token-reset').addEventListener('click', async () => {
  if (!confirm('重置流媒体令牌？重置后所有已生成的音源脚本将失效，需重新下发。')) return
  try {
    const r = await api('/admin/api/library/stream-token/reset', { method: 'POST' })
    STREAM_TOKEN = r.data.token
    renderToken()
    toast('令牌已重置，请重新生成音源脚本')
  } catch (err) { toast(err.message) }
})

// 扫描
let scanTimer = null
const renderScan = (scan) => {
  const s = scan || {}
  const pct = s.total ? Math.min(100, Math.round(100 * (s.done || 0) / s.total)) : 0
  $('#scan-info').textContent = s.scanning
    ? '扫描中 ' + (s.done || 0) + ' / ' + (s.total || 0) + '（' + pct + '%）'
    : (s.error ? '扫描出错：' + s.error : (s.total ? ('上次扫描完成 ' + (s.done || 0) + ' 个文件 @ ' + fmtDate(s.finishedAt)) : '未开始'))
  $('#scan-bar').style.width = pct + '%'
  $('#scan-meta').textContent = '曲目总数：' + String(s.trackCount ?? '—') + ' · 设备扫描中请稍候'
  $('#btn-scan').disabled = !!s.scanning
  if (s.scanning && !scanTimer) {
    scanTimer = setInterval(async () => {
      try {
        const r = await api('/admin/api/library/stats', { method: 'GET' })
        renderScan(r.data.scan)
        if (!r.data.scan.scanning) { clearInterval(scanTimer); scanTimer = null; loadLibrary() }
      } catch { /* ignore */ }
    }, 1500)
  }
  if (!s.scanning && scanTimer) { clearInterval(scanTimer); scanTimer = null }
}

$('#btn-scan').addEventListener('click', async () => {
  try {
    await api('/admin/api/library/scan', { method: 'POST' })
    toast('扫描已启动')
    loadLibrary()
  } catch (err) { toast(err.message) }
})

// 曲目列表
const loadTracks = async () => {
  try {
    const qs = new URLSearchParams({ q: lib.q, page: String(lib.page), size: String(lib.size) })
    const r = await api('/admin/api/library/tracks?' + qs.toString(), { method: 'GET' })
    const d = r.data
    lib.total = d.total
    lib.tracks = d.tracks || []
    renderTracks()
  } catch (err) {
    toast('曲目加载失败: ' + err.message)
  }
}

const renderTracks = () => {
  const tb = $('#track-tbody')
  $('#page-info').textContent = '第 ' + lib.page + ' 页 / 共 ' + lib.total + ' 首'
  const all = $('#chk-all')
  all.checked = lib.tracks.length > 0 && lib.tracks.every(t => lib.sel.has(t.id))
  if (!lib.tracks.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">' + (lib.q ? '无匹配曲目' : '曲库为空，请先添加扫描目录并扫描') + '</td></tr>'
  } else {
    tb.innerHTML = lib.tracks.map(t => `
      <tr class="${lib.sel.has(t.id) ? 'sel' : ''}" data-id="${esc(t.id)}">
        <td class="chk"><input type="checkbox" class="row-select" ${lib.sel.has(t.id) ? 'checked' : ''}></td>
        <td class="cov">${t.hasCover ? `<img class="cov-img" loading="lazy" src="${apiCover(t.id)}" alt="">` : '<span class="cov-img" style="display:block"></span>'}</td>
        <td><span class="t-name">${esc(t.name)}</span><div class="t-sub">${t.interval ? fmtTime(t.interval) : ''} ${esc(t.ext || '')}</div></td>
        <td>${esc(t.singer || '—')}</td>
        <td>${esc(t.album || '—')}</td>
        <td>${fmtTime(t.interval)}</td>
        <td>
          <div class="row-acts">
            <button class="btn mini act-dl">下载</button>
            <button class="btn mini act-play">试听</button>
          </div>
        </td>
      </tr>`).join('')
  }
  const n = lib.sel.size
  $('#sel-count').textContent = '已选 ' + n + ' 项'
  $('#batch-bar').hidden = !n
  $('#page-prev').disabled = lib.page <= 1
  $('#page-next').disabled = lib.page * lib.size >= lib.total
  if (!STREAM_TOKEN) $('#btn-export').disabled = true
}

const apiCover = (id) => '/admin/api/library/cover/' + encodeURIComponent(id)
const apiPreview = (id) => '/admin/api/library/preview/' + encodeURIComponent(id)
const apiDownload = (id) => '/admin/api/library/download/' + encodeURIComponent(id)

$('#track-tbody').addEventListener('click', (e) => {
  const row = e.target.closest('tr')
  if (!row) return
  const id = row.dataset.id
  if (e.target.closest('.act-play')) {
    const a = $('#preview-audio')
    a.src = apiPreview(id)
    a.play().catch(() => toast('试听失败（音频解码错误？）'))
    return
  }
  if (e.target.closest('.act-dl')) {
    const a = document.createElement('a')
    a.href = apiDownload(id)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    return
  }
  const cb = e.target.closest('.row-select')
  if (cb) {
    if (cb.checked) lib.sel.add(id); else lib.sel.delete(id)
    row.classList.toggle('sel', cb.checked)
    renderTracks()
  }
})
$('#chk-all').addEventListener('change', (e) => {
  if (e.target.checked) lib.tracks.forEach(t => lib.sel.add(t.id))
  else lib.tracks.forEach(t => lib.sel.delete(t.id))
  renderTracks()
})
$('#btn-track-search').addEventListener('click', () => {
  lib.q = $('#track-q').value.trim()
  lib.page = 1
  loadTracks()
})
$('#track-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-track-search').click() })
$('#page-prev').addEventListener('click', () => { if (lib.page > 1) { lib.page--; loadTracks() } })
$('#page-next').addEventListener('click', () => { if (lib.page * lib.size < lib.total) { lib.page++; loadTracks() } })
$('#btn-clear-sel').addEventListener('click', () => { lib.sel.clear(); renderTracks() })

// 导出 .lxmc
const exportIds = async (ids) => {
  try {
    const r = await api('/admin/api/library/export', { method: 'POST', body: { ids, name: '古四音乐' } })
    const blob = new Blob([JSON.stringify(r.data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '古四音乐.lxmc'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    toast('已导出 ' + ids.length + ' 首')
  } catch (err) { toast(err.message) }
}
$('#btn-export').addEventListener('click', async () => {
  if (!lib.total) return toast('曲库为空')
  try {
    // 全量导出：拉取全部曲目 id（分页拉）
    const all = []
    let page = 1
    for (;;) {
      const r = await api('/admin/api/library/tracks?q=' + encodeURIComponent(lib.q) + '&page=' + page + '&size=200', { method: 'GET' })
      all.push(...(r.data.tracks || []).map(t => t.id))
      if (all.length >= r.data.total || page > 100) break
      page++
    }
    await exportIds(all)
  } catch (err) { toast(err.message) }
})
$('#btn-export-sel').addEventListener('click', () => { if (lib.sel.size) exportIds([...lib.sel]) })

// ==================== 用户曲库（0020 租户） ====================
const loadTenants = async () => {
  try {
    const r = await api('/admin/api/library/users', { method: 'GET' })
    tenantData = r.data.users || []
    renderTenants()
  } catch (err) {
    toast('用户曲库加载失败: ' + err.message)
  }
}

const renderTenants = () => {
  const box = $('#tenant-list')
  if (!tenantData.length) {
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0">暂无同步用户。在「同步用户」页创建后，即可为每个用户配置独立曲库目录。</p></div>'
    return
  }
  box.innerHTML = tenantData.map(u => {
    const st = u.stats || {}
    const sc = u.scan || {}
    const pct = sc.total ? Math.round(100 * (sc.done || 0) / sc.total) : 0
    return `
    <div class="tenant-box" data-user="${esc(u.name)}">
      <div class="tenant-head">
        <div>
          <div class="u-name">${esc(u.name)}</div>
          <div class="u-meta">${st.tracks || 0} 首 · ${st.artists || 0} 位歌手 · ${st.albums || 0} 张专辑 · ${fmtBytes(st.bytes)}${st.scannedAt ? ' · 扫描于 ' + fmtDate(st.scannedAt) : ''}</div>
        </div>
        <div class="user-acts">
          <button class="btn mini ten-sc">${sc.scanning ? '扫描中 ' + pct + '%' : '扫描'}</button>
          <button class="btn mini ten-dirs">目录</button>
        </div>
      </div>
      <div class="tenant-body">
        <p class="muted-note">该用户 Web 端曲目来自以下独立目录；修改目录后需触发扫描。</p>
        <ul class="dir-list tdir-list"></ul>
        <div class="in-row">
          <input class="tdir-input" placeholder="/volume1/music …">
          <button class="btn primary tdir-add">添加</button>
        </div>
        <div class="scan-info tscan-info">${sc.error ? '出错：' + esc(sc.error) : (sc.scanning ? '扫描中 ' + (sc.done || 0) + ' / ' + (sc.total || 0) : '空闲')}</div>
        <div class="progress"><i class="progress-i" style="width:${pct}%"></i></div>
      </div>
    </div>`
  }).join('')
  // 事件委托
  box.querySelectorAll('.tenant-box').forEach(async (boxEl) => {
    const name = boxEl.dataset.user
    const r = await api('/admin/api/library/user-settings/' + encodeURIComponent(name), { method: 'GET' }).catch(() => null)
    const dirs = r?.data?.settings?.dirs || []
    const ul = boxEl.querySelector('.tdir-list')
    ul.innerHTML = dirs.length ? dirs.map((d, i) => `<li><span>${esc(d)}</span><button class="x tdir-del" data-idx="${i}">×</button></li>`).join('') : '<li class="empty">尚未配置目录</li>'
    boxEl.querySelector('.ten-dirs').addEventListener('click', () => {
      boxEl.classList.toggle('open')
    })
    boxEl.querySelector('.tdir-add').addEventListener('click', async () => {
      const val = boxEl.querySelector('.tdir-input').value.trim()
      if (!val) return
      const cur = dirs
      if (cur.includes(val)) return toast('目录已存在')
      cur.push(val)
      await saveTenantDirs(name, cur)
      loadTenants()
    })
    boxEl.querySelectorAll('.tdir-del').forEach(x => x.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      dirs.splice(Number(x.dataset.idx), 1)
      await saveTenantDirs(name, dirs)
      loadTenants()
    }))
    boxEl.querySelector('.ten-sc').addEventListener('click', async () => {
      try {
        await api('/admin/api/library/user-scan/' + encodeURIComponent(name), { method: 'POST' })
        toast('已触发 ' + name + ' 的扫描')
        loadTenants()
      } catch (err) { toast(err.message) }
    })
  })
}

const saveTenantDirs = async (name, dirs) => {
  try {
    await api('/admin/api/library/user-settings/' + encodeURIComponent(name), { method: 'POST', body: { dirs } })
    toast('已保存 ' + name + ' 的目录')
  } catch (err) { toast(err.message) }
}

// ==================== 下载中心 ====================
const loadDownloads = async () => {
  try {
    const [tr, ts] = await Promise.all([
      api('/admin/api/library/targets', { method: 'GET' }),
      api('/admin/api/library/downloads', { method: 'GET' }),
    ])
    dlTargets = tr.data.targets || []
    dlTasks = ts.data.tasks || []
    $('#btn-dl-clear').disabled = !dlTasks.some(t => ['done', 'error', 'cancelled'].includes(t.status))
    renderTargets()
    renderTasks()
    loadUsage()
  } catch (err) {
    toast('下载中心加载失败: ' + err.message)
  }
}

const loadUsage = async () => {
  try {
    const r = await api('/admin/api/library/targets/usage', { method: 'GET' })
    const usage = r.data.usage || {}
    Object.entries(usage).forEach(([id, u]) => {
      const el = document.querySelector('.target-item[data-id="' + CSS.escape(id) + '"] .t-usage')
      if (el) el.textContent = '剩余 ' + (u.free != null ? fmtBytes(u.free) : '—') + ' / ' + (u.total != null ? fmtBytes(u.total) : '—')
    })
  } catch { /* ignore */ }
}

const renderTargets = () => {
  const box = $('#target-list')
  if (!dlTargets.length) {
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0">暂无下载目标。新建本地目录或 WebDAV 目标后即可接收下载。</p></div>'
    return
  }
  box.innerHTML = dlTargets.map(t => `
    <div class="target-item" data-id="${esc(t.id)}">
      <div>
        <div class="t-name">${esc(t.name)} <span class="chip">${t.type === 'webdav' ? 'WebDAV' : '本地'}</span></div>
        <div class="t-meta">${t.type === 'webdav' ? esc(t.url || '') + (t.username ? ' · ' + esc(t.username) : '') : esc(t.path || '')}</div>
        <div class="t-usage">剩余 —</div>
      </div>
      <div class="user-acts">
        <button class="btn mini targ-edit">编辑</button>
        <button class="btn mini danger targ-del">删除</button>
      </div>
    </div>`).join('')
}

$('#target-list').addEventListener('click', async (e) => {
  const box = e.target.closest('.target-item')
  if (!box) return
  const id = box.dataset.id
  const target = dlTargets.find(t => t.id === id)
  if (!target) return
  if (e.target.closest('.targ-del')) {
    if (!confirm('删除目标 ' + target.name + '？')) return
    try {
      saveTargetList(dlTargets.filter(t => t.id !== id))
      toast('已删除目标')
    } catch (err) { toast(err.message) }
  } else if (e.target.closest('.targ-edit')) {
    openTargetModal(target)
  }
})

$('#btn-target-add').addEventListener('click', () => openTargetModal(null))

const openTargetModal = (target) => {
  const isWebdav = target?.type === 'webdav'
  openModal(target ? '编辑目标：' + target.name : '新建下载目标', `
    <label>名称<input type="text" id="tg-name" value="${esc(target?.name || '')}" placeholder="如：音乐下载、网盘"></label>
    <label>类型
      <select id="tg-type">
        <option value="local" ${isWebdav ? '' : 'selected'}>本地目录（含已挂载 WebDAV/网盘）</option>
        <option value="webdav" ${isWebdav ? 'selected' : ''}>WebDAV 服务器（直传）</option>
      </select>
    </label>
    <div id="tg-local"><label>本地路径<input type="text" id="tg-path" value="${esc(target?.path || '')}" placeholder="/volume1/music"></label></div>
    <div id="tg-webdav" ${isWebdav ? '' : 'hidden'}>
      <label>WebDAV 地址<input type="text" id="tg-url" value="${esc(target?.url || '')}" placeholder="https://dav.example.com/dav"></label>
      <label>用户名<input type="text" id="tg-user" value="${esc(target?.username || '')}" autocomplete="off"></label>
      <label>密码（留空保留原值）<input type="password" id="tg-pass" autocomplete="new-password"></label>
    </div>
    <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="tg-ok">保存</button></div>
  `, (body) => {
    const typeSel = body.querySelector('#tg-type')
    const sync = () => {
      const wv = typeSel.value === 'webdav'
      body.querySelector('#tg-local').hidden = wv
      body.querySelector('#tg-webdav').hidden = !wv
    }
    typeSel.addEventListener('change', sync)
    sync()
    body.querySelector('#tg-ok').addEventListener('click', async () => {
      const name = body.querySelector('#tg-name').value.trim()
      const type = typeSel.value
      if (!name) return toast('请输入名称')
      const item = { id: target?.id, name, type }
      if (type === 'local') {
        const p = body.querySelector('#tg-path').value.trim()
        if (!p) return toast('请输入本地路径')
        item.path = p
      } else {
        const u = body.querySelector('#tg-url').value.trim()
        const user = body.querySelector('#tg-user').value.trim()
        const pass = body.querySelector('#tg-pass').value
        if (!/^https?:\/\/.+/.test(u)) return toast('WebDAV 地址格式不正确')
        item.url = u
        item.username = user
        if (pass) item.password = pass
      }
      try {
        saveTargetList(target ? dlTargets.map(t => t.id === target.id ? item : t) : [...dlTargets, item])
        closeModal()
        toast('目标已保存')
      } catch (err) { toast(err.message) }
    })
  })
}

const saveTargetList = async (list) => {
  await api('/admin/api/library/targets', { method: 'POST', body: { targets: list } })
  loadDownloads()
}

const renderTasks = () => {
  const tb = $('#dl-tbody')
  if (!dlTasks.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">暂无下载任务</td></tr>'
    return
  }
  tb.innerHTML = dlTasks.map(t => {
    const pct = t.total ? Math.min(100, Math.round(100 * (t.received || 0) / t.total)) : (t.status === 'done' ? 100 : 0)
    return `
    <tr data-task="${esc(t.id)}">
      <td><span class="t-name">${esc(t.filename)}</span><div class="t-sub">${esc(t.source4 || '')}</div></td>
      <td>${esc(t.targetName || '—')}${t.subdir ? '<div class="t-sub">' + esc(t.subdir) + '</div>' : ''}</td>
      <td><span class="dl-status ${t.status}">${statusText(t.status)}</span></td>
      <td>
        <div class="dl-bar"><i style="width:${pct}%"></i></div>
        <div class="t-sub" style="margin-top:3px">${fmtBytes(t.received || 0)}${t.total ? ' / ' + fmtBytes(t.total) : ''}</div>
        ${t.error ? '<div class="t-sub" style="color:var(--danger)">' + esc(t.error) + '</div>' : ''}
      </td>
      <td>
        <div class="row-acts">
          ${['queued', 'running'].includes(t.status) ? '<button class="btn mini danger dl-cancel">取消</button>' : '<button class="btn mini dl-remove">移除</button>'}
        </div>
      </td>
    </tr>`
  }).join('')
}

const statusText = (s) => ({ queued: '排队中', running: '下载中', done: '完成', error: '失败', cancelled: '已取消' }[s] || s)

$('#dl-tbody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr')
  if (!tr) return
  const id = tr.dataset.task
  if (e.target.closest('.dl-cancel')) {
    try { await api('/admin/api/library/downloads/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }); toast('已取消'); loadDownloads() } catch (err) { toast(err.message) }
  } else if (e.target.closest('.dl-remove')) {
    try { await api('/admin/api/library/downloads/' + encodeURIComponent(id), { method: 'DELETE' }); loadDownloads() } catch (err) { toast(err.message) }
  }
})
$('#btn-dl-refresh').addEventListener('click', loadDownloads)
$('#btn-dl-clear').addEventListener('click', async () => {
  try { const r = await api('/admin/api/library/downloads/clear', { method: 'POST' }); toast('已清除 ' + (r.data.removed ?? 0) + ' 条'); loadDownloads() } catch (err) { toast(err.message) }
})

// ==================== 音源与代理 ====================
let sourceState = { proxySources: [], onlineSources: [], scriptSources: [], userSources: [] }

const loadSources = async () => {
  try {
    const r = await api('/admin/api/library/settings', { method: 'GET' })
    const s = r.data || {}
    sourceState.proxySources = s.proxySources || []
    sourceState.onlineSources = s.onlineSources || []
    sourceState.scriptSources = [...sourceState.proxySources]
    renderChips($('#online-sources'), ONLINE_ALL, sourceState.onlineSources)
    renderChips($('#script-sources'), PROXY_ALL, sourceState.scriptSources, (sel) => {
      sourceState.proxySources = [...sel]
      sourceState.scriptSources = [...sel]
    })
    await loadUserSources()
  } catch (err) {
    toast('音源配置加载失败: ' + err.message)
  }
}

const renderChips = (el, all, selected, onToggle) => {
  el.innerHTML = all.map(k => `<span class="chip tog ${selected.includes(k) ? 'on' : ''}" data-k="${k}">${SOURCE_NAMES[k] || k}</span>`).join('')
  el.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
    const k = c.dataset.k
    const i = selected.indexOf(k)
    if (i >= 0) selected.splice(i, 1); else selected.push(k)
    c.classList.toggle('on')
    if (onToggle) onToggle(selected)
    saveSourceConfig()
  }))
}

const saveSourceConfig = () => {
  debounce(async () => {
    try {
      await api('/admin/api/library/settings', {
        method: 'POST',
        body: {
          proxySources: [...sourceState.proxySources],
          onlineSources: [...sourceState.onlineSources],
        },
      })
      toast('音源配置已保存')
    } catch (err) { toast(err.message) }
  }, 500)()
}

// 音源脚本
const buildScript = (download = false) => {
  const qs = new URLSearchParams({ proxy: sourceState.scriptSources.join(',') })
  if (download) qs.set('download', '1')
  return '/admin/api/library/source-script?' + qs.toString()
}
$('#btn-script-preview').addEventListener('click', async () => {
  try {
    const r = await api(buildScript(), { method: 'GET' })
    openModal('音源脚本预览', `<pre class="script-pre">${esc(r.data)}</pre><div class="btns"><button class="btn" data-close>关闭</button></div>`)
  } catch (err) { toast(err.message) }
})
$('#btn-script-copy').addEventListener('click', async () => {
  try {
    const r = await api(buildScript(), { method: 'GET' })
    await navigator.clipboard.writeText(r.data)
    toast('脚本已复制到剪贴板')
  } catch (err) { toast('复制失败: ' + err.message) }
})
$('#btn-script-download').addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = buildScript(true)
  a.download = 'gusi-user-source.js'
  document.body.appendChild(a); a.click(); a.remove()
})

// 第三方 JS 音源
const loadUserSources = async () => {
  try {
    const r = await api('/admin/api/library/user-sources', { method: 'GET' })
    sourceState.userSources = r.data.list || []
    renderUserSources()
  } catch (err) { toast(err.message) }
}

const renderUserSources = () => {
  const tb = $('#us-tbody')
  const list = sourceState.userSources
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">未添加第三方音源脚本。点击右上「添加脚本」，粘贴社区音源（如 Flower / Huibq / LX / QDY / SixYin）后启用。</td></tr>'
    return
  }
  tb.innerHTML = list.map(s => {
    const caps = Object.keys(s.capabilities || {}).filter(k => SOURCE_NAMES[k]).map(k => `<span class="chip">${SOURCE_NAMES[k]}</span>`).join('')
    const statusMap = { ready: '就绪', boot: '启动中', dead: '异常', cold: '未启动' }
    return `
    <tr data-us="${esc(s.id)}">
      <td><span class="t-name">${esc(s.name)}</span>
        <div class="t-sub">${esc(s.id)} · ${fmtBytes(s.bytes)} · 更新 ${fmtDate(s.updatedAt)}</div>
        ${s.lastError ? '<div class="t-sub" style="color:var(--danger)">' + esc(s.lastError) + '</div>' : ''}
        ${s.lastAlert?.log ? '<div class="t-sub" style="color:var(--gold)">⚠ ' + esc(s.lastAlert.log) + '</div>' : ''}</td>
      <td>${caps || '<span class="t-sub">—</span>'}</td>
      <td><span class="dl-status ${s.enabled ? 'done' : 'queued'}">${s.enabled ? '启用' : '停用'} · ${statusMap[s.status] || s.status}</span></td>
      <td>
        <div class="row-acts">
          <button class="btn mini us-toggle">${s.enabled ? '停用' : '启用'}</button>
          <button class="btn mini us-test">测活</button>
          <button class="btn mini us-edit">编辑</button>
          <button class="btn mini danger us-del">删除</button>
        </div>
      </td>
    </tr>`
  }).join('')
}

$('#us-tbody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr')
  if (!tr) return
  const id = tr.dataset.us
  const src = sourceState.userSources.find(x => x.id === id)
  if (!src) return
  if (e.target.closest('.us-toggle')) {
    try {
      await api('/admin/api/library/user-sources/enable', { method: 'POST', body: { id, enabled: !src.enabled } })
      toast(src.enabled ? '已停用' : '已启用（后台预热中）')
      loadUserSources()
    } catch (err) { toast(err.message) }
  } else if (e.target.closest('.us-test')) {
    openModal('测活：' + src.name, `
      <label>源平台<select id="us-t-source"><option value="wy">网易云</option><option value="kw">酷我</option><option value="mg">咪咕</option><option value="kg">酷狗</option><option value="tx">QQ音乐</option></select></label>
      <label>歌曲 ID<input type="text" id="us-t-id" placeholder="例如 1842025914（晴天）"></label>
      <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="us-t-ok">测活</button></div>
      <p class="muted-note" id="us-t-res" style="margin-top:12px"></p>
    `, (body) => {
      body.querySelector('#us-t-ok').addEventListener('click', async () => {
        const resEl = body.querySelector('#us-t-res')
        resEl.textContent = '测活中…'
        try {
          const r = await api('/admin/api/library/user-sources/test', {
            method: 'POST',
            body: { id, probe: { source: body.querySelector('#us-t-source').value, id: body.querySelector('#us-t-id').value.trim() || '1842025914', type: '128k' } },
          })
          const d = r.data
          resEl.innerHTML = d.ok ? '<span style="color:var(--ok)">✅ 成功</span> ' + esc(d.url || '') + '（' + (d.ms || '—') + 'ms）' : '<span style="color:var(--danger)">❌ ' + esc(d.error || '失败') + '</span>'
        } catch (err) { resEl.textContent = '测活失败: ' + err.message }
      })
    })
  } else if (e.target.closest('.us-edit')) {
    try {
      const r = await api('/admin/api/library/user-sources/' + encodeURIComponent(id), { method: 'GET' })
      openUserSourceModal(r.data)
    } catch (err) { toast(err.message) }
  } else if (e.target.closest('.us-del')) {
    if (!confirm('删除音源 ' + src.name + '？')) return
    try {
      await api('/admin/api/library/user-sources/' + encodeURIComponent(id), { method: 'DELETE' })
      toast('已删除')
      loadUserSources()
    } catch (err) { toast(err.message) }
  }
})

$('#btn-us-add').addEventListener('click', () => openUserSourceModal(null))

const openUserSourceModal = (src) => {
  openModal(src ? '编辑音源：' + src.name : '添加第三方 JS 音源', `
    <label>名称<input type="text" id="us-name" value="${esc(src?.name || '')}" placeholder="如：Flower 音源"></label>
    <label>脚本内容（.js）<textarea id="us-script" placeholder="粘贴音源脚本">${esc(src?.script || '')}</textarea></label>
    <div class="btns">
      <button class="btn" data-close>取消</button>
      <button class="btn" id="us-save-no">保存（不启用）</button>
      <button class="btn primary" id="us-save-on">保存并启用</button>
    </div>
  `, (body) => {
    const save = async (enabled) => {
      const name = body.querySelector('#us-name').value.trim()
      const script = body.querySelector('#us-script').value
      if (!name || !script.trim()) return toast('名称与脚本不能为空')
      try {
        await api('/admin/api/library/user-sources', { method: 'POST', body: { id: src?.id, name, script, enabled } })
        toast('已保存')
        closeModal()
        loadUserSources()
      } catch (err) { toast(err.message) }
    }
    body.querySelector('#us-save-no').addEventListener('click', () => save(false))
    body.querySelector('#us-save-on').addEventListener('click', () => save(true))
  })
}

// ==================== 上传 ====================
$('#btn-upload').addEventListener('click', () => {
  openModal('上传音频到曲库', `
    <label>选择音频（mp3 / flac / wav / m4a / aac / ogg / opus / ape / wma）<input type="file" id="up-file" accept="audio/*,.ape,.wma"></label>
    <label>子目录（可选，如 歌手/专辑）<input type="text" id="up-dir" placeholder="周杰伦/范特西"></label>
    <div class="btns"><button class="btn" data-close>取消</button><button class="btn primary" id="up-ok">上传</button></div>
    <p class="muted-note" id="up-res" style="margin-top:12px"></p>
  `, (body) => {
    body.querySelector('#up-ok').addEventListener('click', async () => {
      const file = body.querySelector('#up-file').files[0]
      if (!file) return toast('请选择文件')
      const qs = new URLSearchParams({ name: file.name, dir: body.querySelector('#up-dir').value.trim() || '' })
      const resEl = body.querySelector('#up-res')
      resEl.textContent = '上传中…'
      try {
        const resp = await fetch('/admin/api/library/upload?' + qs.toString(), {
          method: 'PUT',
          headers: { 'X-Admin-Token': TOKEN },
          body: file,
        })
        const d = await resp.json().catch(() => null)
        if (!resp.ok) throw new Error(d?.msg || d?.message || ('HTTP ' + resp.status))
        resEl.innerHTML = '<span style="color:var(--ok)">✅ 已上传</span> ' + esc(d.data?.filePath || '')
        toast('上传成功，已触发自动扫描')
      } catch (err) { resEl.innerHTML = '<span style="color:var(--danger)">❌ ' + esc(err.message) + '</span>' }
    })
  })
})

// ==================== 初始化 ====================
const initAll = () => {
  switchTab(CURRENT_TAB)
}

// 自动恢复会话
;(async () => {
  if (!TOKEN) { $('#login').hidden = false; return }
  try {
    await api('/admin/api/status', { method: 'GET' })
    $('#login').hidden = true
    $('#shell').hidden = false
    const cfg = await api('/admin/api/status', { method: 'GET' })
    $('#who').textContent = cfg.data.serverName || '管理后台'
    initAll()
  } catch (err) {
    // token 可能失效，api() 已处理登出
    if (TOKEN) doLogout(false)
  }
})()
