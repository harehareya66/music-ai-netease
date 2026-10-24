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
     * A lyrics widget that lives in the **shell** document, not in the music
     * page.
     *
     * Page-level overlays only exist while the Music panel is mounted; a user
     * reading other panels still expects lyrics to stay put. This mounts one
     * fixed, draggable, resizable iframe on the shell body that talks to the
     * same `/api` as every other page.
     *
     * Lock behaviour: the widget reports `ncm-widget-lock`, and a locked widget
     * turns its own iframe `pointer-events: none` so clicks fall through to the
     * panel underneath (only the small unlock badge stays interactive). True
     * OS-level click-through needs a host window API, which plugins do not get.
     */
    function mountLyricsWidget() {
      const KEY = 'ncm-widget-shell';
      let host = null;
      let iframe = null;
      let frameUrl = '';

      const base = API.replace(/\/api$/, '');
      const defaultUrl = `${base}/lyric-window?embed=1&base=${encodeURIComponent(base)}`;

      function readPrefs() {
        try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
      }
      function writePrefs(next) {
        try { localStorage.setItem(KEY, JSON.stringify(Object.assign(readPrefs(), next))); } catch { /* private mode */ }
      }
      function clampToViewport() {
        if (!host) return;
        const r = host.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - r.width - 8);
        const maxTop = Math.max(0, window.innerHeight - r.height - 8);
        if (r.left > maxLeft || r.top > maxTop) {
          host.style.left = `${Math.min(Math.max(8, r.left), maxLeft)}px`;
          host.style.top = `${Math.min(Math.max(8, r.top), maxTop)}px`;
        }
      }

      function setLocked(locked) {
        if (!host) return;
        host.dataset.locked = locked ? '1' : '0';
        if (iframe) iframe.style.pointerEvents = locked ? 'none' : 'auto';
        const unlock = host.querySelector('.ncm-lyrics-unlock');
        if (unlock) unlock.style.display = locked ? 'grid' : 'none';
      }

      function remove() {
        if (!host) return;
        host.remove();
        host = null;
        iframe = null;
      }

      function open(url) {
        if (host) {
          if (url && iframe && url !== frameUrl) {
            frameUrl = url;
            iframe.src = url;
          }
          setLocked(false);
          return;
        }
        const prefs = readPrefs();
        const width = Math.min(720, Math.max(320, Number(prefs.width) || 520));
        const height = Math.min(520, Math.max(140, Number(prefs.height) || 230));
        host = document.createElement('div');
        host.className = 'ncm-lyrics-widget';
        host.style.cssText = [
          'position:fixed', 'display:flex', 'z-index:2147483000',
          `width:${width}px`, `height:${height}px`,
          `left:${prefs.left == null ? Math.max(16, window.innerWidth - width - 28) : prefs.left}px`,
          `top:${prefs.top == null ? Math.max(16, window.innerHeight - height - 96) : prefs.top}px`,
          'border-radius:14px', 'overflow:hidden', 'background:transparent',
        ].join(';');

        iframe = document.createElement('iframe');
        frameUrl = url || defaultUrl;
        iframe.src = frameUrl;
        iframe.title = '歌词';
        iframe.setAttribute('allow', 'autoplay');
        iframe.style.cssText = 'border:0;width:100%;height:100%;background:transparent;display:block;';

        const drag = document.createElement('div');
        drag.className = 'ncm-lyrics-drag';
        drag.title = '按住拖动';
        drag.style.cssText = 'position:absolute;left:0;right:0;top:0;height:24px;cursor:move;background:transparent;z-index:2;';

        const grip = document.createElement('div');
        grip.className = 'ncm-lyrics-grip';
        grip.title = '拖动调整大小';
        grip.style.cssText = 'position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:2;';

        const unlock = document.createElement('button');
        unlock.type = 'button';
        unlock.className = 'ncm-lyrics-unlock';
        unlock.title = '解锁歌词窗（恢复控制条）';
        unlock.textContent = '\u{1F512}';
        unlock.style.cssText = [
          'position:absolute;right:6px;top:6px;z-index:4', 'display:none',
          'width:24px;height:24px;border-radius:50%', 'border:1px solid rgba(255,255,255,.18)',
          'background:rgba(10,12,16,.66)', 'color:#c8ccd4', 'font-size:12px',
          'line-height:1', 'cursor:pointer', 'padding:0', 'place-items:center',
        ].join(';');
        unlock.addEventListener('click', () => {
          setLocked(false);
          try { iframe.contentWindow.postMessage({ type: 'ncm-widget-unlock' }, '*'); } catch { /* frame gone */ }
        });

        host.append(iframe, drag, grip, unlock);
        document.body.appendChild(host);
        clampToViewport();

        drag.addEventListener('pointerdown', (event) => {
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
            writePrefs({ left: parseInt(host.style.left, 10), top: parseInt(host.style.top, 10) });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });

        grip.addEventListener('pointerdown', (event) => {
          if (host.dataset.locked === '1') return;
          event.preventDefault();
          const r = host.getBoundingClientRect();
          const sx = event.clientX;
          const sy = event.clientY;
          const move = (ev) => {
            const w = Math.min(720, Math.max(320, r.width + ev.clientX - sx));
            const h = Math.min(520, Math.max(140, r.height + ev.clientY - sy));
            host.style.width = `${w}px`;
            host.style.height = `${h}px`;
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            writePrefs({ width: parseInt(host.style.width, 10), height: parseInt(host.style.height, 10) });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });

        window.addEventListener('resize', clampToViewport);
        setLocked(false);
      }

      function receive(event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'ncm-open-lyrics') {
          open(typeof data.url === 'string' ? data.url : '');
          try { event.source?.postMessage({ type: 'ncm-widget-mounted' }, '*'); } catch { /* cross-origin */ }
          return;
        }
        if (!host || event.source !== iframe?.contentWindow) return;
        if (data.type === 'ncm-widget-lock') setLocked(Boolean(data.locked));
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
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
