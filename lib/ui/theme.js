/**
 * Page theme bridge.
 *
 * DSH already tells the shell whether it is dark; the shell forwards that to this
 * plugin (lib/client.js → POST /api/theme), and the plugin pages read the merged
 * answer here. Templates: auto (follow DSH) / dark / light; ui.fontScale zooms the
 * page 85%–130% so the same layout works on a big monitor and a laptop.
 *
 * Light is applied by inverting the dark design system and then hue-rotating red
 * back — the pages use hand-picked dark colours, and a token swap alone would
 * leave half the chrome dark. Images are inverted twice (once by their container,
 * once by themselves) so covers stay correct.
 */
(() => {
  'use strict';
  const script = document.currentScript;
  const BASE = script && script.src ? new URL(script.src).pathname.replace(/\/theme\.js$/, '') : '/music';
  const STYLE_ID = 'ncm-theme-style';

  function styleText() {
    return [
      'html.ncm-light body{background:#f7f8fa;}',
      'html.ncm-light body > *:not(script):not(.ncm-island){filter:invert(1) hue-rotate(180deg);}',
      'html.ncm-light body > *:not(script):not(.ncm-island) :is(img,video,canvas){filter:invert(1) hue-rotate(180deg);}',
      'html.ncm-light{color-scheme:light;}',
    ].join('\n');
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = styleText();
    document.head.appendChild(style);
  }

  function apply(theme) {
    const root = document.documentElement;
    const scale = Math.min(1.3, Math.max(0.85, Number(theme && theme.scale) || 1));
    const light = theme && theme.effective === 'light';
    ensureStyle();
    root.classList.toggle('ncm-light', Boolean(light));
    root.dataset.ncmTemplate = (theme && theme.template) || 'auto';
    root.dataset.ncmTheme = light ? 'light' : 'dark';
    document.body.style.zoom = String(scale);
    root.style.setProperty('--ncm-ui-scale', String(scale));
  }

  async function refresh() {
    try {
      const res = await fetch(`${BASE}/api/theme`, { cache: 'no-store' });
      if (!res.ok) return;
      apply(await res.json());
    } catch {
      apply({ template: 'auto', scale: 1, effective: 'dark' });
    }
  }

  window.__ncmThemeRefresh = refresh;
  // Another page (settings) can nudge us live; the shell may also post a snapshot.
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'ncm-theme' && data.effective) apply(data);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true });
  } else {
    refresh();
  }
})();
