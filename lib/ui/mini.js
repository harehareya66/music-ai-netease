/**
 * 浮空岛：独立页（曲库 / 画像 / 周报 / 场景 / 歌词二创 / 检查台）底部的共享播放条。
 *
 * 为什么要有它：真正出声的音频在播放器页面（或桌面壳里的引擎）。用户从曲库点一首歌
 * 时若直接跳页，会打断浏览 —— 所以这些页面共用一条浮空岛，直接对着服务端已有的
 * 快照（SSE `/api/events` 的 state 事件）显示正在播放什么，并把控制指令发回
 * `/api/control`。在桌面壳里音频归壳所有，浮空岛只做「遥控器 + 显示器」；
 * 没有壳（preview / 纯 H5）时，浮空岛自己在页面里跑 `playback.js`，这样离开
 * 播放器页去曲库点歌也真的能听到声音。
 *
 * 只依赖服务端契约：GET /api/state、GET /api/events(SSE)、POST /api/control、
 * POST /api/taste、POST /api/quality、POST /api/report、GET /api/quality。
 */
(function () {
  'use strict';

  var path = window.location.pathname.replace(/\/+$/, '');
  if (/\/panel$/.test(path)) return; // 播放器页自带完整播放器，不需要浮空岛

  var script = document.currentScript;
  var BASE = '/music';
  try { BASE = new URL(script.src, window.location.href).pathname.replace(/\/mini\.js$/, ''); } catch { /* 保持默认 */ }
  var API = BASE + '/api';

  /** 桌面壳自己持有音频：壳里页面只当遥控器，不能再起一个 <audio>，否则双声。 */
  function hostEngine() {
    try {
      if (!window.parent || window.parent === window) return null;
      var engine = window.parent.__dshMusicEngine;
      return engine && typeof engine.sync === 'function' ? engine : null;
    } catch { return null; }
  }

  function shellOwnsAudio() {
    try {
      if (hostEngine()) return true;
    } catch { /* 跨域父窗口，说明不是壳里 */ }
    return false;
  }

  var hasEngine = false;
  var state = null;
  var playback = null;
  var bootedAt = Date.now();

  function api(path, options) {
    return fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      ...(options && options.body ? { body: JSON.stringify(options.body) } : {}),
    }).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
        if (!response.ok) {
          var error = new Error(data.error || data.message || 'HTTP ' + response.status);
          if (data.code) error.code = data.code;
          throw error;
        }
        return data;
      });
    });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmt(ms) {
    var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    if (m >= 60) return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function artistText(track) {
    var artists = track && Array.isArray(track.artists) ? track.artists : [];
    return artists.map(function (a) { return typeof a === 'string' ? a : (a && a.name) || ''; })
      .filter(Boolean).join(' / ');
  }

  // ------------------------------------------------------------------ 样式
  var CSS = [
    ':root{--island-bg:color-mix(in srgb,#14161b 94%,transparent);--island-line:#262a33;--island-text:#e8eaed;--island-muted:#8b909a;--island-red:#e5484d;}',
    'body{padding-bottom:104px !important;}',
    '.ncm-island{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;',
    ' width:min(1240px,calc(100% - 32px));display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1.05fr);',
    ' align-items:center;gap:16px;padding:12px 16px;border-radius:18px;border:1px solid var(--island-line);',
    ' background:var(--island-bg);backdrop-filter:blur(18px) saturate(1.2);box-shadow:0 18px 48px rgba(0,0,0,.55);',
    ' color:var(--island-text);font:13px/1.4 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;',
    ' opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;}',
    '.ncm-island.on{opacity:1;pointer-events:auto;}',
    '.ncm-island .bar{position:absolute;left:14px;right:14px;top:-1px;height:2px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden;}',
    '.ncm-island .seek{position:absolute;left:6px;right:6px;top:-9px;width:calc(100% - 12px);height:18px;margin:0;background:transparent;',
    ' appearance:none;-webkit-appearance:none;cursor:pointer;}',
    '.ncm-island .seek::-webkit-slider-runnable-track{height:18px;background:transparent;}',
    '.ncm-island .seek::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:3px;border-radius:50%;',
    ' background:var(--island-red);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);opacity:0;transition:opacity .15s;}',
    '.ncm-island:hover .seek::-webkit-slider-thumb{opacity:1;}',
    '.ncm-island .seek::-moz-range-track{height:18px;background:transparent;}',
    '.ncm-island .seek::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:var(--island-red);border:2px solid #fff;opacity:0;}',
    '.ncm-island:hover .seek::-moz-range-thumb{opacity:1;}',
    '.ncm-island .bar i{display:block;height:100%;width:0;background:var(--island-red);transition:width .25s linear;}',
    '.ncm-island .now{display:flex;align-items:center;gap:12px;min-width:0;}',
    '.ncm-island .cover{width:52px;height:52px;border-radius:12px;flex:none;background:#20242c center/cover no-repeat;',
    ' box-shadow:0 6px 16px rgba(0,0,0,.4);}',
    '.ncm-island .meta{min-width:0;}',
    '.ncm-island .title{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ncm-island .sub{color:var(--island-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}',
    '.ncm-island .ic{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;',
    ' border:1px solid transparent;background:transparent;color:var(--island-text);cursor:pointer;padding:0;flex:none;}',
    '.ncm-island .ic:hover{background:rgba(255,255,255,.08);}',
    '.ncm-island .ic svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '.ncm-island .ic.liked{color:var(--island-red);}',
    '.ncm-island .ic.liked svg{fill:currentColor;}',
    '.ncm-island .center{display:flex;align-items:center;gap:6px;justify-self:center;}',
    '.ncm-island .play{width:44px;height:44px;border-radius:50%;background:var(--island-red);color:#fff;border:0;}',
    '.ncm-island .play:hover{filter:brightness(1.08);background:var(--island-red);}',
    '.ncm-island .play svg{fill:currentColor;stroke:none;width:20px;height:20px;}',
    '.ncm-island .right{display:flex;align-items:center;justify-content:flex-end;gap:9px;min-width:0;}',
    '.ncm-island .chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:999px;white-space:nowrap;',
    ' border:1px solid var(--island-line);background:rgba(255,255,255,.03);color:var(--island-muted);font-size:12px;cursor:pointer;}',
    '.ncm-island .chip:hover{color:var(--island-text);border-color:#3a4049;}',
    '.ncm-island .chip svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none;}',
    '.ncm-island .qcount{font-weight:600;color:var(--island-text);font-variant-numeric:tabular-nums;}',
    '.ncm-island select{height:30px;border-radius:999px;border:1px solid var(--island-line);background:#191c22;',
    ' color:var(--island-text);font:12px "Microsoft YaHei UI",system-ui,sans-serif;padding:0 8px;max-width:132px;}',
    '.ncm-island select option{background:#191c22;color:var(--island-text);}',
    '.ncm-island .vol{display:flex;align-items:center;gap:6px;}',
    '.ncm-island .vol input{width:84px;accent-color:var(--island-red);}',
    '.ncm-island .time{color:var(--island-muted);font-size:11px;font-variant-numeric:tabular-nums;text-align:right;padding-left:12px;flex:none;white-space:nowrap;}',
    '.ncm-island .toastline{position:absolute;left:50%;transform:translateX(-50%);top:-38px;padding:7px 14px;border-radius:999px;',
    ' background:rgba(20,22,27,.96);border:1px solid var(--island-line);color:var(--island-text);font-size:12px;opacity:0;transition:opacity .18s;}',
    '.ncm-island .toastline.on{opacity:1;}',
    '@media(max-width:1000px){.ncm-island{grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:10px 12px;}',
    ' .ncm-island .right{grid-column:1/-1;justify-content:space-between;padding-top:8px;border-top:1px solid rgba(255,255,255,.06);}',
    ' .ncm-island .time{display:none;}',
    ' .ncm-island .qcount{display:none;}',
    ' .ncm-island .lyrics span{display:none;}',
    ' .ncm-island .open span{display:none;}',
    ' body{padding-bottom:150px !important;}}',
    '@media(max-width:1280px){.ncm-island .open span{display:none;}}',
    '@media(max-width:720px){.ncm-island .vol input{width:64px;}.ncm-island select{max-width:104px;}}',
  ].join('\n');

  // ------------------------------------------------------------------ 图标
  var ICONS = {
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5v14"/><path d="M19 5l-9 7 9 7z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M18 5v14"/><path d="M5 5l9 7-9 7z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.7C19 15.6 12 20 12 20z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l4 3V7L7 10H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
    queue: '<svg viewBox="0 0 24 24"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M17 14l4 3-4 3z"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    lyrics: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 11h10M5 16h7"/><path d="M17.5 16.2v3.1a1.6 1.6 0 1 1-1.6-1.6c.5 0 .9.2 1.2.4v-4.4l3.4-.7v4.6a1.6 1.6 0 1 1-1.6-1.6c.5 0 .9.2 1.2.4"/></svg>',
  };

  // ------------------------------------------------------------------ DOM
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var el = document.createElement('div');
  el.className = 'ncm-island';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', '正在播放');
  el.innerHTML = [
    '<div class="bar"><i></i></div>',
    '<input class="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="播放进度" title="拖动跳转">',
    '<div class="now">',
    '  <div class="cover"></div>',
    '  <div class="meta"><div class="title">未播放</div><div class="sub"></div></div>',
    '  <button class="ic like" type="button" title="喜欢" aria-label="喜欢">', ICONS.heart, '</button>',
    '</div>',
    '<div class="center">',
    '  <button class="ic prev" type="button" title="上一首" aria-label="上一首">', ICONS.prev, '</button>',
    '  <button class="ic play" type="button" title="播放" aria-label="播放">', ICONS.play, '</button>',
    '  <button class="ic next" type="button" title="下一首" aria-label="下一首">', ICONS.next, '</button>',
    '</div>',
    '<div class="right">',
    '  <span class="time"></span>',
    '  <button class="chip queue" type="button" title="打开播放队列">', ICONS.queue, '<span class="qlabel">队列</span><b class="qcount"></b></button>',
    '  <select class="quality" aria-label="音质" title="流媒体音质"></select>',
    '  <span class="vol"><button class="ic mute" type="button" title="静音" aria-label="静音">', ICONS.volume, '</button><input class="volume" type="range" min="0" max="1" step="0.01" aria-label="音量"></span>',
    '  <button class="chip lyrics" type="button" title="悬浮歌词窗">', ICONS.lyrics, '<span class="llabel">歌词</span></button>',
    '  <button class="chip open" type="button" title="打开完整播放器">', ICONS.open, '<span>播放器</span></button>',
    '</div>',
    '<div class="toastline" role="status"></div>',
  ].join('');
  document.body.appendChild(el);

  var ui = {
    bar: el.querySelector('.bar i'),
    cover: el.querySelector('.cover'),
    title: el.querySelector('.title'),
    sub: el.querySelector('.sub'),
    like: el.querySelector('.like'),
    play: el.querySelector('.play'),
    prev: el.querySelector('.prev'),
    next: el.querySelector('.next'),
    time: el.querySelector('.time'),
    queue: el.querySelector('.queue .qlabel'),
    qcount: el.querySelector('.queue .qcount'),
    seek: el.querySelector('.seek'),
    quality: el.querySelector('.quality'),
    mute: el.querySelector('.mute'),
    volume: el.querySelector('.volume'),
    open: el.querySelector('.open'),
    lyrics: el.querySelector('.lyrics'),
    toast: el.querySelector('.toastline'),
  };

  var toastTimer = 0;
  function toast(text) {
    if (!text) return;
    ui.toast.textContent = text;
    ui.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('on'); }, 2600);
  }

  // ------------------------------------------------------------------ 渲染
  function positionMs() {
    var engine = hostEngine();
    if (engine) {
      try {
        var host = engine.position && engine.position();
        if (host && Number.isFinite(host.seconds)) return host.seconds * 1000;
      } catch { /* fall through */ }
    }
    if (playback) {
      try {
        var pos = playback.position();
        if (pos && Number.isFinite(pos.seconds)) return pos.seconds * 1000;
      } catch { /* fall through to the host's report */ }
    }
    var reported = state && state.reported;
    if (!reported) return 0;
    var base = Number(reported.position) || 0;
    if (state.playing && reported.at) base += Math.max(0, Date.now() - Number(reported.at));
    return Math.min(base, Number(reported.duration) || base);
  }

  function paint() {
    if (!state) return;
    var track = state.current;
    if (!track) {
      el.classList.remove('on');
      return;
    }
    el.classList.add('on');
    ui.cover.style.backgroundImage = track.picUrl ? 'url("' + String(track.picUrl).replace(/"/g, '%22') + '")' : '';
    ui.title.textContent = track.name || '未命名';
    ui.sub.textContent = artistText(track) || (track.album && String(track.album)) || '';
    ui.like.classList.toggle('liked', Boolean(track.liked));
    ui.like.title = track.liked ? '取消喜欢' : '喜欢';
    ui.play.innerHTML = state.playing ? ICONS.pause : ICONS.play;
    ui.play.title = state.playing ? '暂停' : '播放';
    ui.play.setAttribute('aria-label', ui.play.title);
    ui.mute.innerHTML = ICONS.volume;
    ui.mute.title = state.muted || !state.volume ? '取消静音' : '静音';
    ui.volume.value = String(state.muted ? 0 : state.volume == null ? 1 : state.volume);
    var count = Array.isArray(state.queue) ? state.queue.length : 0;
    ui.qcount.textContent = count ? String(count) : '';
    ui.queue.parentElement.title = count ? '播放队列 · ' + count + ' 首（点击打开播放器）' : '播放队列（点击打开播放器）';
    var pos = positionMs();
    var duration = Number((state.current && state.current.duration) || (state.reported && state.reported.duration) || 0);
    ui.bar.style.width = duration > 0 ? Math.min(100, (pos / duration) * 100) + '%' : '0%';
    ui.time.textContent = duration > 0 ? fmt(pos) + ' / ' + fmt(duration) : '';
    if (!seeking && duration > 0) ui.seek.value = String(Math.round(Math.min(1, pos / duration) * 1000));
  }

  /**
   * 新页面第一次接管音频时，服务端只知道上一次上报的位置；不补这一步，
   * 从曲库切到画像页时歌会从头开始。同一个 trackId 只补一次。
   */
  var resumedTrackId = null;
  function resumeOnBoot(next) {
    if (!playback || !next || !next.current) return;
    var trackId = next.current.id;
    if (resumedTrackId === trackId) return;
    resumedTrackId = trackId;
    if (!next.playing) return;
    var reported = next.reported;
    if (!reported || String(reported.trackId) !== String(trackId)) return;
    var ms = Number(reported.position) || 0;
    if (reported.at) ms += Math.max(0, Date.now() - Number(reported.at));
    var target = ms / 1000;
    if (!(target > 0.5)) return;
    try {
      var audio = playback.audio;
      var applySeek = function () { try { audio.currentTime = target; } catch { /* 不可寻址 */ } };
      if (audio.readyState >= 1) applySeek();
      else audio.addEventListener('loadedmetadata', applySeek, { once: true });
    } catch { /* 元素还没就绪 */ }
  }

  function adopt(next) {
    if (!next) return;
    if (state && next.version != null && state.version != null && next.version < state.version) return;
    state = next;
    paint();
    if (playback) {
      try { playback.apply(next); } catch { /* 引擎自己会重试 */ }
      resumeOnBoot(next);
    }
  }

  // ------------------------------------------------------------------ 控制
  function control(body) {
    return api('/control', { method: 'POST', body: body }).then(function (next) {
      adopt(next);
      if (playback && state && state.playing) {
        try { playback.playNow(); } catch { /* 浏览器拒绝时等下一次点击 */ }
      }
      return next;
    }).catch(function (error) { toast('操作失败：' + (error.message || '未知错误')); });
  }

  var seeking = false;
  function seekDuration() {
    return Number((state && state.current && state.current.duration) || (state && state.reported && state.reported.duration) || 0);
  }
  ui.seek.addEventListener('pointerdown', function () { seeking = true; });
  ui.seek.addEventListener('input', function (event) {
    seeking = true;
    var duration = seekDuration();
    if (duration > 0) {
      var ms = (Number(event.target.value) / 1000) * duration;
      ui.bar.style.width = (Number(event.target.value) / 10) + '%';
      ui.time.textContent = fmt(ms) + ' / ' + fmt(duration);
    }
  });
  ui.seek.addEventListener('change', function (event) {
    var duration = seekDuration();
    var ms = Math.max(0, Math.round((Number(event.target.value) / 1000) * duration));
    seeking = false;
    if (!duration) return;
    if (playback) {
      try { playback.audio.currentTime = ms / 1000; } catch { /* 等 apply 后由服务端 seek 生效 */ }
    }
    void control({ action: 'seek', value: ms });
  });
  ui.seek.addEventListener('pointerup', function () { setTimeout(function () { seeking = false; }, 400); });

  ui.play.addEventListener('click', function () { void control({ action: 'toggle' }); });
  ui.prev.addEventListener('click', function () { void control({ action: 'previous' }); });
  ui.next.addEventListener('click', function () { void control({ action: 'next' }); });
  ui.queue.addEventListener('click', function () { window.location.href = BASE + '/panel'; });
  var lyricWin = null;
  function openLyricsWindow() {
    // A stale Document PiP window (older builds) would float over the shell widget.
    try { if (window.documentPictureInPicture && window.documentPictureInPicture.window) window.documentPictureInPicture.window.close(); } catch (e) {}
    var url = BASE + '/lyric-window?base=' + encodeURIComponent(BASE);
    /* 在 DSH 壳里，页面本身就是壳的 iframe：请壳把它挂到壳文档上，跨面板常驻。 */
    if (window.parent && window.parent !== window) {
      var settled = false;
      var onAck = function (event) {
        if (event.data && event.data.type === 'ncm-widget-mounted') {
          settled = true;
          window.removeEventListener('message', onAck);
        }
      };
      window.addEventListener('message', onAck);
      try { window.parent.postMessage({ type: 'ncm-open-lyrics', url: url + '&embed=1' }, '*'); } catch (e) {}
      setTimeout(function () {
        window.removeEventListener('message', onAck);
        if (!settled) openLyricsFallback(url);
      }, 1500);
      return;
    }
    openLyricsFallback(url);
  }
  function openLyricsFallback(url) {
    var pip = window.documentPictureInPicture;
    if (lyricWin && !lyricWin.closed) { lyricWin.focus(); return; }
    if (pip && typeof pip.requestWindow === 'function') {
      pip.requestWindow({ width: 560, height: 320 })
        .then(function (win) {
          lyricWin = win;
          return fetch(url, { cache: 'no-store' }).then(function (res) { return res.text(); })
            .then(function (html) {
              /* Document PiP 的地址是 about:blank，页面读不到 BASE：先注进去。 */
              var prefix = '<script>window.__NCM_BASE__=' + JSON.stringify(BASE) + ';</scr' + 'ipt>';
              win.document.open();
              win.document.write(prefix + html);
              win.document.close();
            });
        })
        .catch(function () {
          lyricWin = window.open(url, 'ncm-lyrics', 'width=560,height=320,menubar=no,toolbar=no,location=no,status=no');
        });
      return;
    }
    lyricWin = window.open(url, 'ncm-lyrics', 'width=560,height=320,menubar=no,toolbar=no,location=no,status=no');
  }
  ui.lyrics.addEventListener('click', openLyricsWindow);

  ui.open.addEventListener('click', function () { window.location.href = BASE + '/panel'; });
  ui.mute.addEventListener('click', function () { void control({ action: 'mute', value: !(state && state.muted) }); });
  ui.volume.addEventListener('input', function (event) {
    var value = Number(event.target.value);
    if (state) { state.volume = value; state.muted = false; }
    paint();
  });
  ui.volume.addEventListener('change', function (event) {
    void control({ action: 'volume', value: Number(event.target.value) });
  });
  ui.like.addEventListener('click', function () {
    var track = state && state.current;
    if (!track) return;
    api('/taste', { method: 'POST', body: { trackId: track.id, level: track.liked ? 'none' : 'liked' } })
      .then(function (next) { adopt(next); toast(track.liked ? '已取消喜欢' : '已喜欢'); })
      .catch(function (error) { toast(error.code === 'ANONYMOUS' ? '喜欢需要先登录网易云' : '操作失败：' + (error.message || '')); });
  });
  ui.quality.addEventListener('change', function (event) {
    api('/quality', { method: 'POST', body: { level: event.target.value } })
      .then(function (next) { adopt(next); toast('音质已设为 ' + event.target.value); })
      .catch(function (error) { toast('音质切换失败：' + (error.message || '')); });
  });

  // ------------------------------------------------------------------ 音质选项
  function loadQuality() {
    api('/quality').then(function (data) {
      var levels = Array.isArray(data && data.levels) ? data.levels : [];
      if (!levels.length) { ui.quality.hidden = true; return; }
      var current = data.preferred || (data.last && data.last.requested) || '';
      ui.quality.innerHTML = levels.map(function (entry) {
        return '<option value="' + esc(entry.id) + '">' + esc(shortLabel(entry)) + '</option>';
      }).join('');
      if (levels.some(function (entry) { return entry.id === current; })) ui.quality.value = current;
    }).catch(function () { ui.quality.hidden = true; });
  }

  function shortLabel(entry) {
    var label = String(entry && entry.label || entry && entry.id || '');
    var zh = label.split('/')[0].trim();
    return zh || label;
  }

  // ------------------------------------------------------------------ 数据源
  function poll() {
    api('/state').then(adopt).catch(function () { /* 网络抖一下不弹错 */ });
  }

  function listen() {
    if (typeof window.EventSource !== 'function') return false;
    try {
      var events = new window.EventSource(API + '/events');
      events.addEventListener('state', function (event) {
        try { adopt(JSON.parse(event.data)); } catch { /* 坏帧忽略 */ }
      });
      return true;
    } catch { return false; }
  }

  // ------------------------------------------------------------------ 本地引擎
  function bootEngine() {
    return new Promise(function (resolve) {
      if (shellOwnsAudio()) { resolve(); return; }
      var src = BASE + '/playback.js';
      var existing = window.__dshMusicPlayback;
      if (existing && typeof existing.createPlayback === 'function') { resolve(); return; }
      var tag = document.createElement('script');
      tag.src = src;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { resolve(); };
      document.head.appendChild(tag);
    }).then(function () {
      var factory = window.__dshMusicPlayback;
      if (!factory || typeof factory.createPlayback !== 'function') return;
      if (shellOwnsAudio()) return; // 壳里的音频归壳，页面不重复出声
      playback = factory.createPlayback({
        base: BASE,
        streamOrigin: function () { return ''; },
        call: api,
        report: function (extra) {
          if (!state || !state.current) return;
          api('/report', {
            method: 'POST',
            body: Object.assign({ trackId: state.current.id }, playback.progress(), extra || {}),
          }).catch(function () { /* 下一次快照会纠正 */ });
        },
      });
      hasEngine = true;
      // 定期把真实播放位置告诉服务端，切页后浮空岛能接着放。
      setInterval(function () {
        if (!playback || !state || !state.current || !state.playing) return;
        try {
          var progress = playback.progress();
          api('/report', {
            method: 'POST',
            body: Object.assign({ trackId: state.current.id }, progress, {}),
          }).catch(function () { /* 同样交给下一次 */ });
        } catch { /* 元素还没就绪 */ }
      }, 5000);
      if (state) {
        try {
          playback.apply(state);
          if (state.playing) playback.playNow();
        } catch { /* 等下一次快照 */ }
      }

      // 离开本页前把真实位置交回服务端：5 秒一次的上报太稀，切页会倒退几秒。
      function flushPosition() {
        if (!playback || !state || !state.current) return;
        try {
          var body = JSON.stringify(Object.assign({ trackId: state.current.id }, playback.progress(), {}));
          if (navigator.sendBeacon) {
            navigator.sendBeacon(API + '/report', new Blob([body], { type: 'application/json' }));
          } else {
            fetch(API + '/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
          }
        } catch { /* 尽力而为 */ }
      }
      window.addEventListener('pagehide', flushPosition);
      document.addEventListener('visibilitychange', function () { if (document.hidden) flushPosition(); });

      // 新页面里的第一次 play() 会被浏览器的自动播放策略拦下；任意一次点击
      // 都是用户手势，借它把音乐接上（不打断其它点击行为）。
      document.addEventListener('click', function () {
        if (!playback || !state || !state.playing) return;
        try { if (playback.audio && playback.audio.paused) playback.playNow(); } catch { /* 下一次 */ }
      }, true);
    });
  }

  // ------------------------------------------------------------------ 启动
  function tick() {
    if (state) paint();
    setTimeout(tick, 500);
  }

  bootEngine().then(function () {
    listen();
    poll();
    setInterval(poll, 3000);
    setInterval(paint, 1000);
    loadQuality();
    tick();
    // 回到本页（bfcache）或从别的页跳回来时，服务器位置可能已经前进。
    window.addEventListener('pageshow', poll);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });
  });
})();
