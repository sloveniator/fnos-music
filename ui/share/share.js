/* 分享页（/s/<code>）交互：清单、播放器、歌词、提取码
   CSP: script-src 'self' —— 不允许内联脚本/内联事件，一律 addEventListener */
(function () {
  'use strict';
  var root = document.getElementById('s-root');
  if (!root) return;
  var CODE = root.dataset.code || '';
  var API = '/s/' + CODE;
  var state = { items: [], allowDownload: false, order: [], pos: -1, title: '', subtitle: '' };
  var audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = (function () {
    var v = parseFloat(localStorage.getItem('gusi-s-vol'));
    return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  })();

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('s-list');
  var barEl = $('s-bar');
  var fillEl = $('s-fill');
  var trackEl = $('s-track');

  function toast(msg) {
    var el = $('s-toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  // ---------------- 提取码 ----------------
  function askPassword(msg) {
    var gate = $('s-gate');
    gate.hidden = false;
    var m = $('s-gate-msg');
    if (msg) { m.textContent = msg; m.hidden = false; }
    var input = $('s-pass');
    input.value = '';
    input.focus();
    $('s-gate-ok').onclick = null;
    $('s-gate-ok').addEventListener('click', function () {
      var pwd = input.value.trim();
      if (!pwd) { m.textContent = '请输入提取码'; m.hidden = false; return; }
      fetch(API + '/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok || r.j.code !== 0) { m.textContent = (r.j && r.j.msg) || '提取码不正确'; m.hidden = false; return; }
          gate.hidden = true;
          load();
        })
        .catch(function () { m.textContent = '网络异常，请重试'; m.hidden = false; });
    }, { once: true });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('s-gate-ok').click();
    });
  }

  // ---------------- 加载清单 ----------------
  function load() {
    fetch(API + '/api').then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (r) {
      if (r.status === 401 || (r.j && r.j.need)) { askPassword(); return; }
      if (!r.j || r.j.code !== 0) { listEl.innerHTML = ''; listEl.appendChild(el('li', 's-empty', (r.j && r.j.msg) || '分享内容不可用')); return; }
      var d = r.j.data;
      state.items = d.items || [];
      state.allowDownload = !!d.allowDownload;
      state.title = d.title || '';
      state.subtitle = d.subtitle || '';
      render();
      if (d.title && document.title.indexOf(d.title) < 0) document.title = d.title + ' · 古四音乐分享';
    }).catch(function () {
      listEl.innerHTML = '';
      listEl.appendChild(el('li', 's-empty', '载入失败，请刷新重试'));
    });
  }

  function render() {
    listEl.innerHTML = '';
    var playable = [];
    state.items.forEach(function (it, i) { if (it.playable) playable.push(i); });
    if (!state.items.length) {
      listEl.appendChild(el('li', 's-empty', '这条分享里还没有曲目'));
      return;
    }
    state.items.forEach(function (it, i) {
      var li = el('li', 's-item' + (it.playable ? '' : ' dead'));
      li.dataset.i = String(i);
      var no = el('span', 's-no', String(i + 1));
      li.appendChild(no);
      var cov = el('div', 's-cov');
      if (it.playable) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = API + '/cover/' + i;
        img.addEventListener('error', function () { cov.textContent = '♪'; cov.classList.add('ph'); });
        cov.appendChild(img);
      } else {
        cov.textContent = '♪';
        cov.classList.add('ph');
      }
      li.appendChild(cov);
      var main = el('div', 's-txt');
      var nm = el('div', 's-nm', it.name);
      nm.title = it.name;
      main.appendChild(nm);
      var sub = [it.singer, it.album].filter(Boolean).join(' · ');
      if (sub) main.appendChild(el('div', 's-sb', sub));
      li.appendChild(main);
      li.appendChild(el('span', 's-du', it.interval || ''));
      var acts = el('div', 's-acts');
      if (it.playable) {
        var bp = el('button', 's-ic sm', '▶');
        bp.title = '播放这首';
        bp.addEventListener('click', function () { playAt(i, true); });
        acts.appendChild(bp);
        if (state.allowDownload) {
          var a = document.createElement('a');
          a.className = 's-ic sm';
          a.textContent = '⬇';
          a.title = '下载这首';
          a.href = API + '/download/' + i;
          acts.appendChild(a);
        }
      }
      li.appendChild(acts);
      if (it.playable) {
        li.addEventListener('click', function (e) {
          if (e.target.closest('button,a')) return;
          playAt(i, true);
        });
      }
      listEl.appendChild(li);
    });
    state.playable = playable;
    var first = state.items.findIndex(function (x) { return x.playable; });
    buildOrder(first >= 0 ? first : 0);
    // 头部封面用第一首可播放曲目的图（服务端渲染的是 ♪ 占位）
    var art = $('s-art');
    if (first >= 0) {
      var ai = document.createElement('img');
      ai.alt = '';
      ai.src = API + '/cover/' + first;
      ai.addEventListener('error', function () { art.textContent = '♪'; });
      art.innerHTML = '';
      art.appendChild(ai);
    }
  }

  // ---------------- 播放 ----------------
  function buildOrder(start) {
    var idx = [];
    for (var i = 0; i < state.items.length; i++) if (state.items[i].playable) idx.push(i);
    state.order = idx;
    state.cursor = idx.indexOf(start);
  }

  function playAt(i, notify) {
    var it = state.items[i];
    if (!it || !it.playable) { toast('这首已经不在了'); return; }
    state.pos = i;
    state.cursor = state.order.indexOf(i);
    audio.src = API + '/stream/' + i;
    audio.play().then(function () { setPlaying(true); })
      .catch(function () { setPlaying(false); toast('浏览器拦了自动播放，点一下播放键'); });
    if (notify !== false) updateNow();
    updateLyricSource();
  }

  function setPlaying(on) {
    $('s-toggle').textContent = on ? '⏸' : '▶';
  }

  function updateNow() {
    var it = state.items[state.pos];
    if (!it) return;
    barEl.hidden = false;
    $('s-np-name').textContent = it.name;
    $('s-np-sub').textContent = [it.singer, it.album].filter(Boolean).join(' · ');
    var art = $('s-np-art');
    art.innerHTML = '';
    var img = document.createElement('img');
    img.alt = '';
    img.src = API + '/cover/' + state.pos;
    img.addEventListener('error', function () { art.textContent = '♪'; });
    art.appendChild(img);
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: it.name, artist: it.singer || '', album: it.album || '',
          artwork: [{ src: API + '/cover/' + state.pos, sizes: '512x512' }],
        });
      } catch (e) { /* 忽略 */ }
    }
    Array.prototype.forEach.call(listEl.children, function (li) {
      if (!li.dataset) return;
      li.classList.toggle('on', li.dataset.i === String(state.pos));
    });
  }

  function step(delta) {
    if (!state.order.length) return;
    if (state.cursor < 0) state.cursor = 0;
    else state.cursor = (state.cursor + delta + state.order.length) % state.order.length;
    playAt(state.order[state.cursor], true);
    if (!audio.paused) return;
    audio.play().then(function () { setPlaying(true); }).catch(function () {});
  }

  function shuffle() {
    if (!state.order.length) return;
    var pick = state.order[Math.floor(Math.random() * state.order.length)];
    playAt(pick, true);
    if (!audio.paused) return;
    audio.play().then(function () { setPlaying(true); }).catch(function () {});
  }

  audio.addEventListener('play', function () { setPlaying(true); });
  audio.addEventListener('pause', function () { setPlaying(false); });
  audio.addEventListener('ended', function () { step(1); });
  audio.addEventListener('timeupdate', function () {
    var d = audio.duration;
    $('s-cur').textContent = fmt(audio.currentTime);
    if (isFinite(d) && d > 0) {
      $('s-dur').textContent = fmt(d);
      fillEl.style.width = (audio.currentTime / d * 100).toFixed(2) + '%';
    }
    paintLyric(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', function () {
    if (isFinite(audio.duration)) $('s-dur').textContent = fmt(audio.duration);
  });
  audio.addEventListener('error', function () {
    if (audio.src) toast('这首播放失败了，试试下一首');
  });

  // 进度条拖拽
  function seekAt(clientX) {
    var r = trackEl.getBoundingClientRect();
    var ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = ratio * audio.duration;
  }
  var dragging = false;
  trackEl.addEventListener('pointerdown', function (e) { dragging = true; seekAt(e.clientX); trackEl.setPointerCapture(e.pointerId); });
  trackEl.addEventListener('pointermove', function (e) { if (dragging) seekAt(e.clientX); });
  trackEl.addEventListener('pointerup', function () { dragging = false; });
  trackEl.addEventListener('pointercancel', function () { dragging = false; });

  // ---------------- 歌词 ----------------
  var lyricLines = [];
  var lyricFor = -1;

  function updateLyricSource() {
    var panel = $('s-lyric');
    if (panel.hidden) return;
    loadLyric(state.pos);
  }

  function loadLyric(i) {
    lyricFor = i;
    lyricLines = [];
    var panel = $('s-lyric');
    panel.textContent = '正在载入歌词…';
    fetch(API + '/lyric/' + i).then(function (r) { return r.json(); }).then(function (j) {
      if (lyricFor !== i) return;
      var raw = (j && j.data && j.data.lyric) || '';
      lyricLines = parseLrc(raw);
      paintLyric(audio.currentTime, true);
    }).catch(function () {
      if (lyricFor === i) panel.textContent = '歌词加载失败';
    });
  }

  function parseLrc(raw) {
    var out = [];
    if (!raw) return out;
    raw.split(/\r?\n/).forEach(function (line) {
      var times = [];
      var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
      var m;
      while ((m = re.exec(line))) {
        var ms = m[3] ? parseInt((m[3] + '00').substring(0, 3), 10) : 0;
        times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + ms / 1000);
      }
      var text = line.replace(/\[[^\]]*\]/g, '').trim();
      if (!times.length) {
        if (text) out.push({ t: null, text: text });
        return;
      }
      times.forEach(function (t) { out.push({ t: t, text: text }); });
    });
    out.sort(function (a, b) { return (a.t == null ? -1 : a.t) - (b.t == null ? -1 : b.t); });
    return out;
  }

  function paintLyric(cur, force) {
    var panel = $('s-lyric');
    if (panel.hidden) return;
    if (!lyricLines.length) return;
    var active = -1;
    for (var i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].t != null && lyricLines[i].t <= cur + 0.15) active = i;
      else if (lyricLines[i].t != null && lyricLines[i].t > cur + 0.15) break;
    }
    if (!force && active === panel._active) return;
    panel._active = active;
    panel.innerHTML = '';
    lyricLines.forEach(function (l, i) {
      var d = el('div', 's-ln' + (i === active ? ' on' : ''), l.text || '♪');
      panel.appendChild(d);
    });
    var on = panel.querySelector('.s-ln.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function toggleLyric() {
    var panel = $('s-lyric');
    panel.hidden = !panel.hidden;
    if (!panel.hidden && state.pos >= 0) loadLyric(state.pos);
  }

  // ---------------- 绑定 ----------------
  $('s-playall').addEventListener('click', function () {
    if (!state.order.length) { toast('没有可播放的曲目'); return; }
    playAt(state.order[0], true);
    audio.play().then(function () { setPlaying(true); }).catch(function () {});
  });
  $('s-shuffle').addEventListener('click', shuffle);
  $('s-more').addEventListener('click', function () {
    var items = [['💬 显示/隐藏歌词', toggleLyric]];
    if (state.pos >= 0 && state.allowDownload) {
      items.push(['⬇ 下载当前歌曲', function () { window.location.href = API + '/download/' + state.pos; }]);
    }
    items.push(['🔗 复制本页链接', function () {
      var url = location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('链接已复制'); }, function () { toast(url); });
      else toast(url);
    }]);
    showMenu(this, items);
  });

  function showMenu(anchor, items) {
    var old = document.querySelector('.s-menu');
    if (old) old.remove();
    var m = el('div', 's-menu');
    items.forEach(function (pair) {
      var b = el('button', 's-mi', pair[0]);
      b.addEventListener('click', function () { m.remove(); pair[1](); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left)) + 'px';
    m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';
    setTimeout(function () {
      document.addEventListener('click', function onDoc(e) {
        if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', onDoc); }
      });
    }, 0);
  }

  $('s-toggle').addEventListener('click', function () {
    if (!audio.src) { if (state.order.length) { playAt(state.order[0], true); audio.play().catch(function () {}); } return; }
    if (audio.paused) audio.play().then(function () { setPlaying(true); }).catch(function () {});
    else audio.pause();
  });
  $('s-prev').addEventListener('click', function () { step(-1); });
  $('s-next').addEventListener('click', function () { step(1); });
  $('s-vol').addEventListener('input', function () {
    audio.volume = this.value / 100;
    localStorage.setItem('gusi-s-vol', String(audio.volume));
  });
  $('s-vol').value = String(Math.round(audio.volume * 100));
  $('s-mute').addEventListener('click', function () {
    audio.muted = !audio.muted;
    this.textContent = audio.muted ? '🔇' : '🔊';
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); $('s-toggle').click(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
      navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { step(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { step(1); });
    } catch (e) { /* 忽略 */ }
  }

  load();
})();
