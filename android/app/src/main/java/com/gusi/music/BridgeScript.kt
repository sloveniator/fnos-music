package com.gusi.music

/**
 * 注入到 Web 应用里的桥接脚本。
 *
 * 为什么用「注入脚本」而不是改 Web 端代码：安卓壳要能在 Web 端继续独立演进的前提下
 * 长期可用。这里只读 Web 端**已经存在且稳定**的三样东西：
 *
 *   1. `window.__player` —— ui/app/assets/app.js 里的播放器对象（同一个对象就是
 *      底栏那几个按钮的 onclick 用到的），有 toggle() / next() / prev() / audio；
 *   2. `#np-name` / `#np-singer` / `#np-cover` —— 底栏正在播的曲目信息；
 *   3. `window.GusiBridge.setState(json)` —— 反向调用原生。
 *
 * 通知栏/锁屏的按钮不走「另造一套播放」这条路，而是直接调 `__player` 的方法 ——
 * 播放状态永远只有一份真相（Web 端），壳只做展示与转发。
 */
object BridgeScript {

    val JS: String = """
(function () {
  if (window.__gusiBridge) return;
  window.__gusiBridge = true;

  var lastPush = 0;

  // ---- 离线播放：本地已下载的那份优先 ----
  // 为什么拦 src setter 而不是改 Web 端代码：Web 端只管拼 URL，它不需要知道「手机上有缓存」；
  // 壳在这一层做替换，Web 端换播放器实现也不会把这条路弄断。
  function localFirst(url) {
    try {
      if (url && window.GusiBridge && window.GusiBridge.localFor) {
        var hit = window.GusiBridge.localFor(String(url));
        if (hit) return hit;
      }
    } catch (e) {}
    return url;
  }

  (function patchMediaSrc() {
    try {
      var proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
      if (!proto || proto.__gusiSrcPatched) return;
      var d = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!d || !d.set) return;
      proto.__gusiSrcPatched = true;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) { d.set.call(this, localFirst(v)); }
      });
      // 兼容 setAttribute('src', …) 这条路径（虽然当前 Web 端用的是属性赋值）
      var sa = proto.setAttribute;
      proto.setAttribute = function (name, value) {
        if (String(name).toLowerCase() === 'src') return sa.call(this, name, localFirst(value));
        return sa.call(this, name, value);
      };
    } catch (e) {}
  })();

  function txt(id) {
    var e = document.getElementById(id);
    return e ? (e.textContent || '') : '';
  }

  function state() {
    var p = window.__player;
    if (!p || !p.audio) return null;
    var a = p.audio;
    var img = document.getElementById('np-cover');
    return {
      playing: !a.paused && !a.ended,
      // readyState 不到 HAVE_FUTURE_DATA(3) = 手上没数据可放了：加载中 / 卡住 / seek 后重新缓冲。
      // 通知栏据此显示「缓冲中」，也让进度条停下，而不是继续假装在往前走。
      buffering: !a.paused && !a.ended && a.readyState < 3,
      // 推送时刻（毫秒时间戳）：系统画进度条要的是「这个位置是什么时候的」，
      // 少了它系统会把过期位置当成现在，进度条整体落后一到两秒（seek 之后尤其明显）
      at: Date.now(),
      title: txt('np-name'),
      artist: txt('np-singer'),
      cover: (img && img.src) ? img.src : '',
      position: Math.round((a.currentTime || 0) * 1000),
      duration: isFinite(a.duration) ? Math.round(a.duration * 1000) : 0
    };
  }

  function push(force) {
    var s = state();
    if (!s) return false;
    var now = Date.now();
    if (!force && now - lastPush < 900) return true;   // timeupdate 节流，别把通知栏刷爆
    lastPush = now;
    try {
      if (window.GusiBridge && window.GusiBridge.setState) {
        window.GusiBridge.setState(JSON.stringify(s));
      }
    } catch (e) {}
    return true;
  }

  // 原生 → Web：通知栏 / 锁屏 / 耳机线控来的指令
  window.__gusiCmd = function (cmd, arg) {
    var p = window.__player;
    if (!p) return;
    try {
      if (cmd === 'toggle') { p.toggle(); }
      else if (cmd === 'play') { if (p.audio && p.audio.paused) p.toggle(); }
      else if (cmd === 'pause') { if (p.audio && !p.audio.paused) p.toggle(); }
      else if (cmd === 'next') { p.next(false); }
      else if (cmd === 'prev') { p.prev(); }
      else if (cmd === 'seek' && p.audio && isFinite(p.audio.duration)) {
        var v = Number(arg) || 0;
        p.audio.currentTime = Math.max(0, Math.min(p.audio.duration, v));
      }
    } catch (e) {}
    setTimeout(function () { push(true); }, 120);
  };

  // 关掉 Web 端的浮层/全屏页：返回键优先关浮层，而不是直接退出页面。
  // 顺序刻意与「用户理解的返回」一致：对话框 → 抽屉 → 行菜单 → 队列/帮助 → 歌词全屏。
  window.__gusiEscape = function () {
    var closed = false;
    function hide(id) {
      var e = document.getElementById(id);
      if (e && !e.hidden) { e.hidden = true; return true; }
      return false;
    }
    try {
      // 1) 普通对话框：走它自己的取消按钮，才会触发调用方的收尾逻辑
      var dlg = document.getElementById('dialog');
      if (dlg && !dlg.hidden) {
        var cancel = document.getElementById('dlg-cancel');
        if (cancel && cancel.onclick) { cancel.click(); } else { dlg.hidden = true; }
        closed = true;
      }
      // 2) 侧边抽屉
      var side = document.getElementById('sidebar');
      if (side && side.classList.contains('open')) {
        side.classList.remove('open');
        hide('mask');
        closed = true;
      }
      // 3) 行菜单 / 浮层小菜单
      var pops = document.querySelectorAll('.menu.pop');
      for (var i = 0; i < pops.length; i++) { pops[i].remove(); closed = true; }
      // 4) 队列面板、帮助面板、歌词全屏页 —— 这三样 Web 端自己就绑了 Escape
      var hp = document.getElementById('help-panel');
      var q = document.getElementById('queue');
      var lf = document.getElementById('lyric-full');
      var anyWebPanel = (hp && !hp.hidden) || (q && !q.hidden) || (lf && !lf.hidden);
      if (anyWebPanel) {
        var esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
        document.body.dispatchEvent(esc);
        closed = true;
      }
    } catch (e) {}
    return closed;
  };

  function bind() {
    var p = window.__player;
    if (!p || !p.audio) return false;
    if (!p.__gusiBound) {
      p.__gusiBound = true;
      var evs = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'durationchange',
                 'seeked', 'error', 'waiting', 'stalled', 'canplay'];
      for (var i = 0; i < evs.length; i++) {
        p.audio.addEventListener(evs[i], function () { setTimeout(function () { push(true); }, 60); });
      }
      p.audio.addEventListener('timeupdate', function () { push(false); });
    }
    push(true);
    return true;
  }

  // 播放器是页面启动时才创建的，且 SPA 不会整页重载 → 轮询等它出现
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    if (bind() || tries > 240) { clearInterval(t); }
  }, 250);
  bind();
})();
""".trimIndent()
}
