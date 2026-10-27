/**
 * Browser half of `ncm-plugin`.
 *
 * Hand-written against the client module contract (`window.__ModuleLoader__`),
 * so the package needs no bundler step:
 *
 *   - the shell's frozen `PLATFORM_MODULES` table supplies `react`;
 *   - `apply(ctx)` starts a **persistent audio engine** and registers the
 *     sidebar entry (`sidebar.panellist`, a list slot) plus the page it opens
 *     (the layout's keyed `main` slot, same id);
 *   - `ctx.slots.inject(slot, …)` is declaration-aware, so registration waits
 *     for the sidebar and layout packages that own those slots.
 *
 * ## Why the audio element is not in the page
 *
 * The layout renders only the **active** `main` slot entry:
 *
 *     renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })
 *
 * so opening a Session unmounts the Music page and discards its document. An
 * `<audio>` element owned by that page therefore stops the music the moment the
 * user goes back to chatting. Playback instead belongs to this engine, created
 * on the plugin's own lifetime in the shell document, which keeps running no
 * matter which panel is on screen. The page becomes a remote control over the
 * host's shared state, and `window.__dshMusicEngine.sync()` lets it apply a
 * command at once.
 *
 * ## How the engine hears about changes
 *
 * The host pushes its state over `/music/api/events` (an event stream; see
 * lib/feed.js) whenever something the engine acts on changes. The engine
 * re-reads `/state` itself only while that stream is down. A short local clock
 * still runs regardless, because two things never reach the host as a change:
 * a play the browser refused, which must be retried until it is allowed, and
 * the position reports the engine owes the host.
 *
 * @module ncm-plugin/client
 */

window.__ModuleLoader__.load({
  // 这个 id 必须等于包名：宿主按包名加载 client 入口，并按 id 去重。
  // 沿用基座 id 会让同一份 bundle 被判定成两次执行
  // （duplicate factory registration for "@doitian/dsh-music"）。
  id: 'ncm-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Must match the host plugin's `apiPrefix` (see lib/index.js). */
    const BASE = '/music';
    const API = `${BASE}/api`;
    /** Shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'music';

    /**
     * The locale namespace and its dictionary, registered with the host's
     * `locale` service so the UI follows the Settings language. The service
     * requires both shipped locales up front.
     */
    const NS = 'music';
    const DICTIONARY = {
      zh: {
        panel: '音乐',
        iframeTitle: '网易云音乐播放器',
        unreachableTitle: '无法连接到音乐插件',
        unreachableBody: '音乐插件路由没有响应。请确认插件已在当前 profile 中启用，然后',
        unreachableLink: '直接打开播放器',
        unreachableSuffix: '。',
      },
      en: {
        panel: 'Music',
        iframeTitle: 'NetEase Cloud Music player',
        unreachableTitle: 'Music is not reachable',
        unreachableBody:
          'The music plugin route did not answer. Check that the plugin is enabled in this profile, then ',
        unreachableLink: 'open the player directly',
        unreachableSuffix: '.',
      },
    };
    /** Bound in apply() once the dictionary is registered; English until then. */
    let t = (key) => DICTIONARY.en[key] ?? key;

    /**
     * The engine's own clock: it retries a refused play, sends a report when one
     * is due, and re-reads the host while the event stream is down.
     */
    const TICK_MS = 500;
    /** A stream the browser gave up on (an error answer) is opened again after this. */
    const RELISTEN_MS = 10_000;
    /** Position report cadence while playing, and while idle. */
    const REPORT_MS = 1000;
    const IDLE_REPORT_MS = 5000;

    /** Services required before the slot registrations can be made. */
    const inject = ['slots', 'locale'];

    /** Absolute URL helper; the shell page and the panel share one origin. */
    function origin() {
      return window.location?.origin && window.location.origin !== 'null'
        ? window.location.origin
        : '';
    }

    /**
     * Origin that serves audio bytes.
     *
     * The desktop shell runs on the `dsh-app://` custom scheme, whose responses
     * Chromium cannot byte-range (electron/electron#38749): audio plays, but a
     * seek collapses to zero and restarts the track. The shell publishes its
     * real HTTP origin as `__DSH_TRANSPORT__.streamBaseUrl` for exactly this;
     * in a browser it is absent and the document origin serves.
     */
    function streamOrigin() {
      try {
        const base = window.__DSH_TRANSPORT__?.streamBaseUrl;
        if (typeof base === 'string' && base) return new URL(base).origin;
      } catch { /* a malformed base falls back to the document origin */ }
      return origin();
    }

    /** Player page URL, shown in errors and used as the iframe source. */
    function panelUrl() {
      return `${origin()}${BASE}/panel`;
    }

    // ------------------------------------------------------------------ engine

    /**
     * The page/engine boundary this bundle expects, mirrored from the host's
     * `/health`. It covers the host's playback core too: see
     * {@link loadPlayback}, and {@link createEngine} for why it is checked at all.
     */
    const PANEL_CONTRACT = 2;

    /** An engine that does nothing, for a host that predates the contract. */
    function inertEngine() {
      // `playback: false` is the page's cue to own the audio element itself.
      return { playback: false, inert: true, sync() {}, playNow() {}, state: () => null, position: () => 0, dispose() {} };
    }

    /**
     * Does the page this host serves expect an engine to own the audio?
     *
     * Asked in two steps, because two independently versioned artifacts are
     * involved. The host module and the page are *not* refreshed together: a
     * plugin mount re-reads `panel.html` from disk while Node keeps serving the
     * cached module. The page therefore wins when the two disagree — it is the
     * component that actually decides whether to defer, so it is the authority
     * on the question being asked.
     *
     * @returns {Promise<boolean>}
     */
    async function pageAcceptsEngine() {
      try {
        const health = await (await fetch(`${BASE}/health`)).json();
        // A host that advertises the boundary answers definitively, either way.
        if (health?.panelContract !== undefined) return health.panelContract === PANEL_CONTRACT;
      } catch { /* fall through to the page itself */ }

      try {
        const html = await (await fetch(`${BASE}/panel`)).text();
        const declared = /name="dsh-music-panel-contract"\s+content="(\d+)"/.exec(html);
        return declared !== null && Number(declared[1]) === PANEL_CONTRACT;
      } catch {
        return false;
      }
    }

    /**
     * Load the playback core the host serves beside the page.
     *
     * The page's fallback transport runs the same file, which is the point:
     * the fades, the seek hold and the autoplay retry exist once. It comes
     * from the host rather than this bundle because the host and the page are
     * one generation and this bundle may be another; the handshake has already
     * established that the host's generation is the one this engine expects.
     * A host from before the core was split out does not serve it, and that
     * leaves the engine inert like any other mismatch.
     *
     * @returns {Promise<{createPlayback: Function} | null>}
     */
    function loadPlayback() {
      return new Promise((resolve) => {
        const script = document.createElement('script');
        const settle = (core) => {
          script.remove();
          resolve(typeof core?.createPlayback === 'function' ? core : null);
        };
        script.addEventListener('load', () => settle(window.__dshMusicPlayback));
        script.addEventListener('error', () => settle(null));
        script.src = `${BASE}/playback.js`;
        (document.head ?? document.documentElement).appendChild(script);
      });
    }

    /**
     * Start the persistent audio engine, after a contract handshake.
     *
     * Playback lives here rather than in the page, so the two halves have to
     * agree. When they do not, the page owns its own `<audio>` and starting
     * this engine as well would play every track twice — so the engine stays
     * inert and the old behaviour applies until the two are refreshed together.
     *
     * @returns {Promise<{sync: () => void, state: () => object | null, position: () => number, dispose: () => void}>}
     */
    async function createEngine() {
      if (!(await pageAcceptsEngine())) {
        console.warn(
          `[music] the served page does not implement panel contract ${PANEL_CONTRACT}; ` +
            'leaving playback to the page until the harness restarts.',
        );
        return inertEngine();
      }
      const core = await loadPlayback();
      if (!core) {
        console.warn('[music] the host serves no playback core; leaving playback to the page until the harness restarts.');
        return inertEngine();
      }

      // A hot re-materialization must not leave a second element playing.
      try {
        window.__dshMusicEngine?.dispose?.();
      } catch { /* ignore a stale engine */ }

      let state = null;
      // Start the clock now so the first tick reconciles without also posting a
      // redundant position report.
      let lastReportAt = Date.now();
      let disposed = false;
      let inflight = false;
      /** The host's event stream, and whether it is open. */
      let events = null;
      let streaming = false;
      let relisten = null;
      /** The newest snapshot version adopted; see {@link take}. */
      let versionFloor = 0;

      const playback = core.createPlayback({ base: BASE, streamOrigin, call, report });
      const { audio, reconcile, applySource, enforce } = playback;

      /** One JSON round-trip to the host. */
      async function call(path, init) {
        const response = await fetch(`${API}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          ...init,
          ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        });
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }

      /** Tell the host where playback actually is. */
      async function report(extra) {
        if (!state?.current) return;
        lastReportAt = Date.now();
        try {
          const next = await call('/report', {
            method: 'POST',
            body: { trackId: state.current.id, ...playback.progress(), ...extra },
          });
          // Taken, not acted on: acting here would retry a refused play from
          // the answer to its own refusal, as fast as the host can reply.
          if (next?.rev !== undefined) take(next);
        } catch { /* the next update carries the host's view */ }
      }

      /**
       * Adopt one host state, unless it is older than the one held.
       *
       * A report's answer and a pushed frame travel on different connections,
       * so one read earlier can land later; adopting it would undo the newer
       * one — resume a pause, or load the quality just left — with no frame
       * coming to repair it. While the stream is open, a state whose `version`
       * is older than the newest one adopted is dropped. A reconnect drops the
       * floor, since a restarted host counts its versions from zero again.
       * A host without versions is taken as it comes.
       *
       * @returns {boolean} whether it was adopted.
       */
      function take(next) {
        if (disposed || !next) return false;
        const version = Number(next.version);
        if (Number.isFinite(version)) {
          if (streaming && version < versionFloor) return false;
          versionFloor = version;
        }
        state = next;
        reconcile(next);
        return true;
      }

      /** Adopt one host state and bring the element in line with it. */
      function receive(next) {
        if (!take(next)) return;
        applySource(next);
        enforce(next);
      }

      /** Read the host's state over a plain request. */
      async function poll() {
        if (disposed || inflight) return;
        inflight = true;
        try {
          receive(await call('/state'));
        } catch { /* host not reachable yet; the next tick tries again */ } finally {
          inflight = false;
        }
      }

      /** Subscribe to the host's pushed state, where the browser can. */
      function listen() {
        relisten = null;
        const Source = window.EventSource;
        if (disposed || typeof Source !== 'function') return;
        events = new Source(`${API}/events`);
        events.onopen = () => {
          streaming = true;
          versionFloor = 0;
        };
        events.onerror = () => {
          streaming = false;
          // A dropped connection is retried by the browser; an error status
          // (a host that predates the route) closes the stream for good.
          if (events?.readyState === Source.CLOSED) {
            events = null;
            if (!disposed) relisten = setTimeout(listen, RELISTEN_MS);
          }
        };
        events.addEventListener('state', (event) => {
          try {
            receive(JSON.parse(event.data));
          } catch { /* a garbled frame; the next one carries the whole state */ }
        });
      }

      function tick() {
        if (disposed) return;
        if (!streaming) void poll();
        else if (state) {
          // The host has nothing new to say about a refused play, so it is
          // retried here, against the state already held — which a report's
          // answer may have moved to the next track without loading it.
          applySource(state);
          enforce(state);
        }
        const due = state?.playing && !audio.paused ? REPORT_MS : IDLE_REPORT_MS;
        if (audio.dataset.trackId && Date.now() - lastReportAt >= due) void report({});
      }

      const timer = setInterval(tick, TICK_MS);
      void poll();
      listen();

      return {
        /**
         * Declares that this engine really owns and drives the audio element.
         * The page checks it before deferring, so a host that cannot run the
         * engine never leaves playback unowned.
         */
        playback: true,
        /** Re-read the host now: the page just sent a command and wants it applied. */
        sync() {
          void poll();
        },
        /**
         * Retry playback synchronously, for a click on the autoplay hint.
         *
         * Called from inside the gesture so the attempt lands while the page is
         * being activated, rather than on the next tick.
         */
        playNow() {
          playback.playNow();
        },
        state() {
          return state;
        },
        /**
         * Where playback is, in milliseconds, read off the element itself, so
         * the page's bar moves smoothly without a report per frame. A held seek
         * counts as already there.
         */
        position() {
          return playback.position();
        },
        dispose() {
          disposed = true;
          clearInterval(timer);
          clearTimeout(relisten);
          events?.close();
          events = null;
          streaming = false;
          playback.dispose();
        },
      };
    }

    // --------------------------------------------------------------- components

    /** Sidebar destination inside the iframe, shown when the host is down. */
    function PanelError() {
      return h(
        'div',
        {
          style: {
            padding: '28px',
            font: '13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
            opacity: 0.75,
          },
        },
        h('div', { style: { fontWeight: 650, marginBottom: 6 } }, t('unreachableTitle')),
        h(
          'div',
          null,
          t('unreachableBody'),
          h('a', { href: panelUrl(), target: '_blank', rel: 'noreferrer' }, t('unreachableLink')),
          t('unreachableSuffix'),
        ),
      );
    }

    /** The page component registered into the layout's keyed `main` slot. */
    function MusicPanel() {
      const [status, setStatus] = React.useState('loading');

      React.useEffect(() => {
        let cancelled = false;
        fetch(`${BASE}/health`)
          .then((response) => {
            if (!cancelled) setStatus(response.ok ? 'ready' : 'error');
          })
          .catch(() => {
            if (!cancelled) setStatus('error');
          });
        return () => {
          cancelled = true;
        };
      }, []);

      if (status === 'error') return h(PanelError);

      return h('iframe', {
        src: panelUrl(),
        title: t('iframeTitle'),
        allow: 'autoplay; clipboard-write; encrypted-media',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '520px',
          border: 0,
          display: 'block',
          background: 'transparent',
        },
      });
    }

    /** The sidebar row icon; the shell renders it in both states of the rail. */
    function MusicIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M9 18V5l10-2v13' }),
        h('circle', { cx: 6, cy: 18, r: 3 }),
        h('circle', { cx: 16, cy: 16, r: 3 }),
      );
    }

    /**
     * Register the sidebar entry and the page it opens.
     *
     * Both registrations carry `locale: NS` and resolve their text through
     * `t` at render time, so the slot system re-renders them in place when
     * the user switches the Harness language — no remount, no refresh.
     */
    function registerUi(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MusicPanel),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, MusicIcon),
      );
    }


    /**
     * Share the shell's light/dark choice with the plugin.
     *
     * DSH marks dark on the shell body (`data-ds-dark-theme`); pages opened as
     * standalone tabs cannot read that document, so the shell forwards the
     * resolved template here and pages merge it with their own setting in
     * `GET /api/theme`.
     */
    function startThemeBridge(ctx) {
      let last = null;
      const push = () => {
        let dark = document.body?.hasAttribute?.('data-ds-dark-theme')
          || document.documentElement.hasAttribute('data-ds-dark-theme');
        if (!dark) {
          try {
            dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          } catch { /* no matchMedia: treat as light */ }
        }
        const resolved = dark ? 'dark' : 'light';
        if (last === resolved) return;
        last = resolved;
        fetch(`${API}/theme`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved }),
        }).catch(() => { /* the plugin may still be mounting */ });
      };
      const observer = new MutationObserver(push);
      for (const node of [document.documentElement, document.body].filter(Boolean)) {
        observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme'] });
      }
      push();
      const timer = setInterval(push, 5000);
      return () => {
        observer.disconnect();
        clearInterval(timer);
      };
    }

    /**
     * Shell-level floating lyrics widget.
     *
     * Rendered as plain DOM in the shell document instead of an iframe: a
     * framed document brings its own background (the white box users saw), and
     * an iframe cannot blend into whatever panel is underneath. DOM has no
     * background unless we paint one, so transparency is the default rather
     * than something to fight.
     *
     * Interaction model:
     *   - unlocked: widget is interactive; drag the top strip, hover for the
     *     control bar, click the gear for settings;
     *   - locked: the whole widget is `pointer-events: none`, so clicks land on
     *     the panel underneath; only the tiny unlock badge stays clickable.
     *
     * State comes from the same `/music/api` the pages use; lyrics are fetched
     * once per track, and the current line is derived from the host position
     * report so no audio element is needed here.
     */
    function mountLyricsWidget() {
      const KEY = 'ncm-widget-dom-v2';
      const DEFAULT = { left: null, top: null, width: 560, height: 150, lines: 3, font: 22, opacity: 0.92, bg: 'none', tone: 'auto' };
      let host = null;
      let linesEl = null;
      let titleEl = null;
      let playBtn = null;
      let gearEl = null;
      let settingsEl = null;
      let unlockEl = null;
      let state = null;
      let trackId = null;
      let lyric = null;
      let timer = null;
      let dragCleanup = null;

      function prefs() {
        try { return Object.assign({}, DEFAULT, JSON.parse(localStorage.getItem(KEY) || '{}') || {}); } catch { return { ...DEFAULT }; }
      }
      function save(next) {
        try { localStorage.setItem(KEY, JSON.stringify(Object.assign(prefs(), next))); } catch { /* private mode */ }
      }

      function hostTheme() {
        return document.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
      }

      function applyLook() {
        if (!host) return;
        const p = prefs();
        const tone = p.tone === 'auto' ? (hostTheme() === 'dark' ? 'light' : 'dark') : p.tone;
        const color = tone === 'light' ? '255,255,255' : '24,26,30';
        const shadow = tone === 'light' ? '1px 1px 2px rgba(0,0,0,.75)' : '0 1px 2px rgba(255,255,255,.65)';
        const count = Math.max(1, Math.min(5, Number(p.lines) || 3));
        const compactHeight = Math.round(count * (Number(p.font) || 22) * 1.42) + 34;
        host.style.width = `${p.width}px`;
        host.style.height = `${Math.max(84, Math.min(360, compactHeight))}px`;
        host.style.background = p.bg === 'glass' ? 'rgba(14,16,20,.42)' : p.bg === 'card' ? 'rgba(14,16,20,.78)' : 'transparent';
        host.style.backdropFilter = p.bg === 'glass' ? 'blur(14px)' : 'none';
        host.style.borderRadius = p.bg === 'none' ? '0' : '12px';
        if (linesEl) {
          linesEl.style.color = `rgba(${color},${p.opacity})`;
          linesEl.style.textShadow = shadow;
        }
        if (titleEl) {
          titleEl.style.color = `rgba(${color},${Math.min(1, p.opacity)})`;
          titleEl.style.textShadow = shadow;
          titleEl.style.fontSize = `${Math.max(9, Math.round(p.font * 0.5))}px`;
        }
        if (linesEl) {
          for (const el of linesEl.children) {
            el.style.fontSize = `${el.dataset.current === '1' ? p.font : Math.round(p.font * 0.82)}px`;
          }
        }
      }

      function paintLines() {
        if (!linesEl) return;
        const p = prefs();
        const count = Math.max(1, Math.min(5, Number(p.lines) || 3));
        const list = lyric?.lines || [];
        if (!list.length) {
          linesEl.textContent = lyric === null ? '正在取歌词…' : '这首歌没有时间轴歌词';
          linesEl.style.fontSize = `${Math.round(p.font * 0.8)}px`;
          return;
        }
        const dur = state?.reported?.duration || state?.current?.duration || 0;
        let pos = 0;
        if (state?.reported && state.current && state.reported.trackId === state.current.id) {
          pos = Number(state.reported.position) || 0;
          if (state.playing) pos += Math.max(0, Date.now() - Number(state.reported.at || Date.now()));
        }
        pos = Math.min(pos, dur || pos);
        let idx = list.findIndex((line) => pos < (line.end ?? line.t));
        if (idx < 0) idx = list.length - 1;
        idx = Math.max(0, idx);
        const first = Math.max(0, idx - Math.floor((count - 1) / 2));
        const slice = list.slice(first, first + count);
        linesEl.replaceChildren();
        for (const line of slice) {
          const current = line === list[idx];
          const div = document.createElement('div');
          div.textContent = line.text || '·';
          div.dataset.current = current ? '1' : '0';
          div.style.cssText = [
            'text-align:center', 'line-height:1.4', 'white-space:nowrap',
            'overflow:hidden', 'text-overflow:ellipsis', 'transition:color .18s ease',
            `font-weight:${current ? 600 : 400}`,
            `font-size:${current ? p.font : Math.round(p.font * 0.82)}px`,
            `color:inherit`, current ? '' : 'opacity:.72',
          ].join(';');
          linesEl.appendChild(div);
        }
      }

      function paintControls() {
        if (!playBtn) return;
        playBtn.textContent = state?.playing ? '\u23F8' : '\u25B6';
        playBtn.title = state?.playing ? '暂停' : '播放';
      }

      function send(path, body) {
        return fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).catch(() => null);
      }

      async function loadLyric(id) {
        lyric = null;
        paintLines();
        try {
          const res = await fetch(`${API}/lyric?id=${encodeURIComponent(id)}`);
          const data = await res.json();
          lyric = data?.lyrics && Array.isArray(data.lyrics.lines) ? data.lyrics : null;
        } catch { lyric = null; }
        paintLines();
      }

      async function poll() {
        try {
          const res = await fetch(`${API}/state`);
          state = await res.json();
        } catch { return; }
        const id = state?.current?.id ?? null;
        if (id !== trackId) {
          trackId = id;
          if (id) loadLyric(id);
          else { lyric = null; paintLines(); }
        }
        paintControls();
        paintLines();
      }

      function setLocked(locked) {
        if (!host) return;
        host.dataset.locked = locked ? '1' : '0';
        // The box itself never captures clicks; only children opt back in. Locking
        // hides those children so the layer truly passes the mouse through.
        host.style.pointerEvents = 'none';
        for (const el of host.querySelectorAll('.ncm-lyrics-drag, .ncm-lyrics-controls')) {
          el.style.pointerEvents = locked ? 'none' : 'auto';
          el.style.opacity = locked ? '0' : '';
        }
        if (linesEl) linesEl.style.pointerEvents = locked ? 'none' : 'auto';
        if (settingsEl) settingsEl.style.pointerEvents = locked ? 'none' : 'auto';
        if (unlockEl) unlockEl.style.display = locked ? 'grid' : 'none';
        if (closeDot) {
          closeDot.style.display = locked ? 'none' : 'block';
          closeDot.style.pointerEvents = locked ? 'none' : 'auto';
        }
        if (locked) {
          unlockEl.style.opacity = '0.18';
          unlockEl.onmouseenter = () => { if (unlockEl) unlockEl.style.opacity = '1'; };
          unlockEl.onmouseleave = () => { if (unlockEl) unlockEl.style.opacity = '0.18'; };
        }
      }

      function openSettings() {
        if (!settingsEl) return;
        const show = settingsEl.style.display !== 'grid';
        settingsEl.style.display = show ? 'grid' : 'none';
        if (!show) return;
        const p = prefs();
        for (const el of settingsEl.querySelectorAll('[data-pref="lines"] button')) {
          el.style.background = Number(el.dataset.value) === p.lines ? 'rgba(229,72,77,.9)' : 'rgba(255,255,255,.14)';
        }
        for (const el of settingsEl.querySelectorAll('[data-pref="bg"] button')) {
          el.style.background = el.dataset.value === p.bg ? 'rgba(229,72,77,.9)' : 'rgba(255,255,255,.14)';
        }
        const fontEl = settingsEl.querySelector('[data-pref="font"] span');
        if (fontEl) fontEl.textContent = `${p.font}px`;
      }

      function buildSettings() {
        const panel = document.createElement('div');
        panel.style.cssText = [
          'position:absolute', 'right:6px', 'top:6px', 'z-index:3', 'display:none',
          'grid-template-columns:auto auto auto', 'gap:6px 10px', 'align-items:center',
          'padding:10px 12px', 'border-radius:10px', 'font-size:12px', 'color:#e8eaed',
          'background:rgba(12,14,18,.92)', 'border:1px solid rgba(255,255,255,.12)',
          'box-shadow:0 8px 24px rgba(0,0,0,.45)', 'pointer-events:auto', 'white-space:nowrap',
        ].join(';');
        const label = (text) => {
          const el = document.createElement('span');
          el.textContent = text;
          el.style.cssText = 'color:rgba(232,234,237,.66)';
          return el;
        };
        const btn = (text, onClick, extra) => {
          const el = document.createElement('button');
          el.type = 'button';
          el.textContent = text;
          el.style.cssText = [
            'border:0', 'border-radius:7px', 'padding:4px 9px', 'cursor:pointer',
            'background:rgba(255,255,255,.14)', 'color:#f2f4f7', 'font-size:12px',
          ].join(';') + (extra || '');
          el.addEventListener('click', onClick);
          return el;
        };

        const fontWrap = document.createElement('div');
        fontWrap.dataset.pref = 'font';
        fontWrap.style.cssText = 'display:flex;gap:6px;align-items:center';
        fontWrap.append(
          btn('A-', () => { const p = prefs(); save({ font: Math.max(14, p.font - 2) }); applyLook(); openSettings(); openSettings(); }),
          (() => { const s = document.createElement('span'); s.style.cssText = 'min-width:34px;text-align:center;font-variant-numeric:tabular-nums'; return s; })(),
          btn('A+', () => { const p = prefs(); save({ font: Math.min(40, p.font + 2) }); applyLook(); openSettings(); openSettings(); }),
        );
        panel.append(label('字号'), fontWrap, (() => { const s = document.createElement('span'); return s; })());

        const linesWrap = document.createElement('div');
        linesWrap.dataset.pref = 'lines';
        linesWrap.style.cssText = 'display:flex;gap:4px';
        for (const n of [1, 3, 5]) {
          const b = btn(String(n), () => { save({ lines: n }); paintLines(); openSettings(); openSettings(); });
          b.dataset.value = String(n);
          linesWrap.appendChild(b);
        }
        panel.append(label('行数'), linesWrap, (() => document.createElement('span'))());

        const bgWrap = document.createElement('div');
        bgWrap.dataset.pref = 'bg';
        bgWrap.style.cssText = 'display:flex;gap:4px';
        for (const [value, text] of [['none', '透明'], ['glass', '毛玻璃'], ['card', '卡片']]) {
          const b = btn(text, () => { save({ bg: value }); applyLook(); openSettings(); openSettings(); });
          b.dataset.value = value;
          bgWrap.appendChild(b);
        }
        panel.append(label('背景'), bgWrap, (() => document.createElement('span'))());

        const opacity = document.createElement('input');
        opacity.type = 'range';
        opacity.min = '45';
        opacity.max = '100';
        opacity.value = String(Math.round(prefs().opacity * 100));
        opacity.style.cssText = 'width:110px;accent-color:#e5484d';
        opacity.addEventListener('input', () => {
          save({ opacity: Number(opacity.value) / 100 });
          applyLook();
        });
        const opWrap = document.createElement('div');
        opWrap.style.cssText = 'display:flex;gap:8px;align-items:center';
        opWrap.append(opacity, btn('深色字', () => { save({ tone: 'dark' }); applyLook(); }), btn('浅色字', () => { save({ tone: 'light' }); applyLook(); }));
        panel.append(label('文字'), opWrap, (() => document.createElement('span'))());

        const closeSettings = btn('收起', () => { panel.style.display = 'none'; });
        panel.append((() => document.createElement('span'))(), closeSettings, (() => document.createElement('span'))());
        return panel;
      }

      function remove() {
        if (timer) clearInterval(timer);
        timer = null;
        if (dragCleanup) dragCleanup();
        dragCleanup = null;
        if (host) host.remove();
        host = linesEl = titleEl = playBtn = gearEl = settingsEl = unlockEl = null;
        state = null;
        trackId = null;
        lyric = null;
      }

      function open() {
        if (host) { setLocked(false); return; }
        const p = prefs();
        const width = Math.min(860, Math.max(320, Number(p.width) || DEFAULT.width));
        const height = Math.min(420, Math.max(110, Number(p.height) || DEFAULT.height));
        host = document.createElement('div');
        host.className = 'ncm-lyrics-widget';
        host.dataset.locked = '0';
        host.style.cssText = [
          'position:fixed', 'z-index:2147483000', 'display:flex', 'flex-direction:column',
          'justify-content:center', `width:${width}px`, `height:${height}px`,
          `left:${p.left == null ? Math.max(16, Math.round(window.innerWidth / 2 - width / 2)) : p.left}px`,
          `top:${p.top == null ? Math.max(16, window.innerHeight - height - 172) : p.top}px`,
          'background:transparent', 'border-radius:0', 'color:#fff',
          'font-family:"Microsoft YaHei UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
          'user-select:none', 'pointer-events:none',
        ].join(';');

        const bar = document.createElement('div');
        bar.className = 'ncm-lyrics-drag';
        bar.title = '按住拖动';
        // Only a small centred strip is draggable; a full-width invisible band
        // used to swallow clicks that should have reached the page underneath.
        bar.style.cssText = [
          'position:absolute', 'left:50%', 'transform:translateX(-50%)', 'top:0',
          'width:160px', 'height:22px', 'cursor:move', 'background:transparent',
          'z-index:6', 'pointer-events:auto',
        ].join(';');
        bar.innerHTML = '<span class="ncm-lyrics-grip" style="position:absolute;left:50%;top:6px;'
          + 'transform:translateX(-50%);width:44px;height:4px;border-radius:2px;'
          + 'background:rgba(255,255,255,.28);box-shadow:0 0 6px rgba(0,0,0,.4);'
          + 'opacity:0;transition:opacity .16s ease"></span>';

        linesEl = document.createElement('div');
        linesEl.style.cssText = [
          'flex:1', 'display:flex', 'flex-direction:column', 'justify-content:center',
          'gap:4px', 'padding:10px 18px 16px', 'overflow:hidden', 'pointer-events:none',
        ].join(';');
        linesEl.textContent = '正在连接播放器…';

        titleEl = document.createElement('div');
        titleEl.style.cssText = [
          'position:absolute', 'left:10px', 'bottom:4px', 'z-index:2',
          'pointer-events:none', 'opacity:.6', 'font-size:10px',
        ].join(';');

        const controls = document.createElement('div');
        controls.className = 'ncm-lyrics-controls';
        controls.style.cssText = [
          'position:absolute', 'left:50%', 'transform:translateX(-50%)', 'bottom:6px', 'z-index:7',
          'display:flex', 'align-items:center', 'gap:2px', 'padding:3px 6px',
          'border-radius:999px', 'background:rgba(10,12,16,.62)',
          'border:1px solid rgba(255,255,255,.12)', 'opacity:0',
          'transition:opacity .18s ease', 'pointer-events:auto',
        ].join(';');

        const ctrlBtn = (text, title, onClick) => {
          const el = document.createElement('button');
          el.type = 'button';
          el.textContent = text;
          el.title = title;
          el.style.cssText = [
            'border:0', 'background:transparent', 'color:#e8eaed', 'cursor:pointer',
            'font-size:12px', 'line-height:1', 'padding:4px 5px', 'border-radius:6px',
          ].join(';');
          el.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
          return el;
        };
        const prev = ctrlBtn('\u23EE', '上一首', () => send('/control', { action: 'previous' }));
        playBtn = ctrlBtn('\u25B6', '播放', () => send('/control', { action: 'toggle' }));
        const next = ctrlBtn('\u23ED', '下一首', () => send('/control', { action: 'next' }));
        gearEl = ctrlBtn('\u2699', '设置', () => openSettings());
        const lockBtn = ctrlBtn('\u{1F512}', '锁定（点穿到下层）', () => setLocked(true));
        const closeBtn = ctrlBtn('\u00D7', '关闭歌词窗', () => remove());
        controls.append(prev, playBtn, next, gearEl, lockBtn, closeBtn);

        unlockEl = document.createElement('button');
        unlockEl.type = 'button';
        unlockEl.title = '解锁歌词窗';
        unlockEl.textContent = '\u{1F513}';
        unlockEl.style.cssText = [
          'position:absolute', 'right:4px', 'top:4px', 'z-index:5', 'display:none',
          'width:22px', 'height:22px', 'border-radius:50%', 'padding:0',
          'border:1px solid rgba(255,255,255,.16)', 'background:rgba(10,12,16,.6)',
          'color:#c8ccd4', 'font-size:11px', 'line-height:1', 'cursor:pointer',
          'place-items:center', 'pointer-events:auto', 'opacity:.18',
          'transition:opacity .16s ease',
        ].join(';');
        unlockEl.addEventListener('click', (ev) => { ev.stopPropagation(); setLocked(false); });

        settingsEl = buildSettings();

        const closeDot = document.createElement('button');
        closeDot.type = 'button';
        closeDot.title = '关闭歌词窗';
        closeDot.textContent = '×';
        closeDot.style.cssText = [
          'position:absolute', 'right:30px', 'top:4px', 'z-index:8', 'width:20px', 'height:20px',
          'border-radius:50%', 'padding:0', 'border:1px solid rgba(255,255,255,.16)',
          'background:rgba(10,12,16,.55)', 'color:#c8ccd4', 'font-size:12px', 'line-height:1',
          'cursor:pointer', 'pointer-events:auto', 'opacity:0', 'transition:opacity .16s ease',
        ].join(';');
        closeDot.addEventListener('click', (ev) => { ev.stopPropagation(); remove(); });
        host.addEventListener('mouseenter', () => { closeDot.style.opacity = '1'; });
        host.addEventListener('mouseleave', () => { closeDot.style.opacity = '0'; });

        host.append(bar, linesEl, titleEl, controls, unlockEl, settingsEl, closeDot);
        document.body.appendChild(host);
        host.addEventListener('mouseenter', () => {
          controls.style.opacity = '1';
          const grip = bar.firstElementChild;
          if (grip) grip.style.opacity = '0.55';
        });
        bar.addEventListener('mouseenter', () => {
          const grip = bar.firstElementChild;
          if (grip) grip.style.opacity = '0.7';
        });
        host.addEventListener('mouseleave', () => { controls.style.opacity = '0'; if (settingsEl) settingsEl.style.display = 'none'; });

        const startDrag = (event) => {
          if (host.dataset.locked === '1') return;
          event.preventDefault();
          const r = host.getBoundingClientRect();
          const dx = event.clientX - r.left;
          const dy = event.clientY - r.top;
          const move = (ev) => {
            const left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - r.width - 4);
            const top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - r.height - 4);
            host.style.left = `${left}px`;
            host.style.top = `${top}px`;
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            save({ left: parseInt(host.style.left, 10), top: parseInt(host.style.top, 10) });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        };
        bar.addEventListener('pointerdown', startDrag);

        const onResize = () => {
          if (!host) return;
          const r = host.getBoundingClientRect();
          const maxLeft = Math.max(0, window.innerWidth - r.width - 8);
          const maxTop = Math.max(0, window.innerHeight - r.height - 8);
          if (r.left > maxLeft) host.style.left = `${maxLeft}px`;
          if (r.top > maxTop) host.style.top = `${maxTop}px`;
        };
        window.addEventListener('resize', onResize);
        dragCleanup = () => window.removeEventListener('resize', onResize);

        applyLook();
        paintLines();
        poll();
        timer = setInterval(poll, 1000);
        setLocked(false);
      }

      function receive(event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'ncm-open-lyrics') {
          open();
          try { event.source?.postMessage({ type: 'ncm-widget-mounted', mode: 'dom' }, '*'); } catch { /* cross-origin */ }
          return;
        }
        if (data.type === 'ncm-widget-close') remove();
      }
      window.addEventListener('message', receive);

      return {
        open,
        close: remove,
        dispose() {
          window.removeEventListener('message', receive);
          remove();
        },
      };
    }

    /**
     * Activate the music contribution.
     *
     * The UI registers first, then the engine starts behind its contract
     * handshake. The engine is deliberately not tied to any slot: the layout
     * unmounts the Music page whenever another panel is active, and playback
     * must outlive that.
     *
     * @param ctx client runtime.
     * @returns disposer stopping playback and withdrawing both registrations.
     */
    async function apply(ctx) {
      // The dictionary goes in before anything renders, and bound `t` reads
      // the live snapshot, so a later language switch needs no rewiring.
      const disposeLocale = ctx.locale.register(NS, DICTIONARY);
      t = ctx.locale.bind(NS);
      const ui = ctx.inject(['slots'], () => registerUi(ctx));
      const disposeTheme = typeof ctx.effect === 'function' ? ctx.effect(() => startThemeBridge(ctx)) : startThemeBridge(ctx);
      const lyricsWidget = mountLyricsWidget();
      const disposeWidget = typeof ctx.effect === 'function' ? ctx.effect(() => () => lyricsWidget.dispose()) : () => lyricsWidget.dispose();
      window.__ncmLyricsWidget = lyricsWidget;
      const engine = await createEngine();
      // The panel is same-origin, so it can nudge the engine after a command.
      window.__dshMusicEngine = engine;
      return () => {
        ui?.dispose?.();
        disposeTheme?.();
        disposeWidget?.();
        lyricsWidget.dispose();
        engine.dispose();
        disposeLocale?.();
        if (window.__dshMusicEngine === engine) delete window.__dshMusicEngine;
      };
    }

    exports.PANEL_ID = PANEL_ID;
    exports.mountLyricsWidget = mountLyricsWidget;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
