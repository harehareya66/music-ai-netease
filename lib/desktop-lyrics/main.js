/**
 * Desktop lyrics window — Electron main process.
 *
 * Spawned by lib/desktop-lyrics.js with `electron.exe main.js` (Electron lives
 * in `$DSH_HOME/electron`, provisioned by the desktop-pet plugin, so the music
 * plugin does not download a second runtime).
 *
 * Why Electron instead of the old PowerShell/WinForms window: a transparent
 * GDI window repaints the whole surface on every update (users saw stutter),
 * and click-through had to be faked per pixel with no mouse forwarding. An
 * Electron window is composited by Chromium: it is genuinely transparent,
 * redraws only what changed, and supports the same interaction model the
 * desktop pet uses — window ignores the mouse by default, the renderer does a
 * hit test on forwarded mousemove and flips `setIgnoreMouseEvents` only while
 * the pointer is over a real control.
 *
 * Configuration arrives through environment variables (the launcher sets them):
 *   NCM_BASE        http://127.0.0.1:<port>/music
 *   NCM_PID_FILE    where to write the process id (launcher watches it)
 *   NCM_POS_FILE    JSON {x?,y?,locked?} persisted across launches
 *   NCM_LINES       1..5
 *   NCM_FONT        px
 */
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.NCM_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', '9223');

const BASE = (process.env.NCM_BASE || 'http://127.0.0.1:7789/music').replace(/\/$/, '');
const PID_FILE = process.env.NCM_PID_FILE || '';
const POS_FILE = process.env.NCM_POS_FILE || '';
const LINES = Math.max(1, Math.min(5, Number(process.env.NCM_LINES) || 3));
const FONT = Math.max(14, Math.min(48, Number(process.env.NCM_FONT) || 26));

let win = null;
let timer = null;
let topmostTimer = null;
let state = null;
let trackId = null;
let lyric = null;
let locked = false;
let pointerTimer = null;
let hovering = false;
let accepting = false;
let lastPayload = '';
let unlockHover = false;

function readPos() {
  try { return JSON.parse(fs.readFileSync(POS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writePos(patch) {
  if (!POS_FILE) return;
  try { fs.writeFileSync(POS_FILE, JSON.stringify(Object.assign(readPos(), patch))); } catch { /* ignore */ }
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function computePayload() {
  const current = state?.current;
  const lines = lyric?.lines || [];
  const count = LINES;
  const dur = Number(state?.reported?.duration || current?.duration || 0);
  let pos = 0;
  if (state?.reported && current && state.reported.trackId === current.id) {
    pos = Number(state.reported.position) || 0;
    if (state.playing) pos += Math.max(0, Date.now() - Number(state.reported.at || Date.now()));
  }
  if (dur) pos = Math.min(pos, dur);
  let idx = lines.findIndex((line) => pos < (line.end ?? line.t));
  if (idx < 0) idx = lines.length - 1;
  idx = Math.max(0, idx);
  const first = Math.max(0, idx - Math.floor((count - 1) / 2));
  const slice = lines.slice(first, first + count).map((line, offset) => ({
    text: line.text || '·',
    current: first + offset === idx,
  }));
  return {
    title: current ? `${current.name} — ${(current.artists || []).join(' / ')}` : '',
    playing: Boolean(state?.playing),
    locked,
    font: FONT,
    lines: slice,
  };
}

function pushPayload(force) {
  if (!win || win.isDestroyed()) return;
  const payload = computePayload();
  const serialized = JSON.stringify(payload);
  if (!force && serialized === lastPayload) return;
  lastPayload = serialized;
  win.webContents.send('ncm:update', payload);
}

async function refresh() {
  try {
    state = await getJson('/api/state');
    const id = state?.current?.id ?? null;
    if (id !== trackId) {
      trackId = id;
      lyric = null;
      if (id) {
        try {
          const data = await getJson(`/api/lyric?id=${encodeURIComponent(id)}`);
          lyric = data?.lyrics && Array.isArray(data.lyrics.lines) ? data.lyrics : null;
        } catch { lyric = null; }
      }
      pushPayload(true);
      return;
    }
    pushPayload(false);
  } catch { /* server briefly unavailable */ }
}

/* Geometry of the parts that should accept the mouse, in CSS pixels. The
   window itself is a big transparent box; everything outside these rects must
   let the click fall through to whatever is underneath. */
/** Distance from a screen point to the window, in CSS pixels. Electron reports
 *  getBounds() in DIP but on Windows the cursor point can arrive in physical
 *  pixels (and vice versa); try both and take the one that lands inside. */
function toLocal(point, bounds, cssWidth, cssHeight, scaleFactor) {
  const candidates = [
    { x: point.x - bounds.x, y: point.y - bounds.y },
    { x: point.x / scaleFactor - bounds.x, y: point.y / scaleFactor - bounds.y },
  ];
  for (const c of candidates) {
    if (c.x >= -2 && c.y >= -2 && c.x <= cssWidth + 2 && c.y <= cssHeight + 2) return c;
  }
  return candidates[0];
}

function interactiveAt(point, bounds, cssWidth, cssHeight, scaleFactor) {
  const local = toLocal(point, bounds, cssWidth, cssHeight, scaleFactor);
  const x = local.x;
  const y = local.y;
  if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) return { inside: false, hover: false };
  if (locked) {
    return { inside: x > cssWidth - 32 && y < 32 && x < cssWidth && y > 0, hover: true };
  }
  const inChrome = x > cssWidth - 190 && y > cssHeight - 42 && x < cssWidth - 6 && y < cssHeight - 2;
  const inDrag = y < 30;
  return { inside: inChrome || inDrag, hover: inChrome || inDrag || y < cssHeight };
}

function startPointerFallback() {
  // Electron's forward-mouse hook can be silently dropped on Windows; the pet
  // plugin keeps a main-process poll for the same reason. Poll the real cursor
  // and drive setIgnoreMouseEvents from geometry, independent of the renderer.
  clearInterval(pointerTimer);
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      const bounds = win.getBounds();
      const [cssWidth, cssHeight] = win.getContentSize();
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const scaleFactor = display && display.scaleFactor ? display.scaleFactor : 1;
      const { inside, hover } = interactiveAt(cursor, bounds, cssWidth, cssHeight, scaleFactor);
      if (process.env.NCM_DEBUG) {
        try {
          require('node:fs').appendFileSync(process.env.NCM_DEBUG_FILE || require('node:path').join(require('node:os').tmpdir(), 'ncm-desk-debug.log'),
            JSON.stringify({ t: Date.now(), cursor, bounds, cssWidth, scaleFactor, inside, hover, accepting, locked }) + String.fromCharCode(10));
        } catch { /* ignore */ }
      }
      if (inside !== accepting) {
        accepting = inside;
        win.setIgnoreMouseEvents(!inside, { forward: true });
      }
      if (hover !== hovering) {
        hovering = hover;
        win.webContents.send('ncm:hover', hover);
      }
    } catch { /* ignore */ }
  }, 60);
}

function applyLock(next) {
  locked = Boolean(next);
  if (!win) return;
  // Locked: the window never accepts the mouse (the renderer still sees the
  // forwarded moves and can turn on the unlock badge). Unlocked: the renderer
  // flips interaction per-element, so keep ignore on until it asks.
  win.setIgnoreMouseEvents(true, { forward: true });
  unlockHover = locked;
  writePos({ locked });
  pushPayload(true);
}

function createWindow() {
  const saved = readPos();
  // Always start unlocked. A locked window has no chrome, so persisting the
  // lock across launches made the window impossible to close on the next run.
  locked = false;
  const area = screen.getPrimaryDisplay().workArea;
  const width = 900;
  const height = Math.max(150, 60 + LINES * (FONT + 12));
  const x = Number.isFinite(saved.x) ? saved.x : Math.round(area.x + (area.width - width) / 2);
  const y = Number.isFinite(saved.y) ? saved.y : Math.round(area.y + area.height * 0.7);

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    win.setIgnoreMouseEvents(true, { forward: true });
    accepting = false;
    startPointerFallback();
    pushPayload(true);
  });
  win.on('moved', () => {
    const [wx, wy] = win.getPosition();
    writePos({ x: wx, y: wy });
  });
  win.on('closed', () => { clearInterval(pointerTimer); win = null; });

  if (PID_FILE) {
    try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* ignore */ }
  }
  timer = setInterval(refresh, 400);
  // DSH itself keeps re-claiming the topmost band when it gains focus, which
  // buries the lyrics window behind the app. Re-assert like the desktop-pet
  // plugin's watchdog does.
  topmostTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (typeof win.moveTop === 'function') win.moveTop();
    } catch { /* ignore */ }
  }, 1500);
  refresh();
}

ipcMain.handle('ncm:lock', (_event, next) => { applyLock(next); return { ok: true, locked }; });
ipcMain.handle('ncm:move', (_event, dx, dy) => {
  if (!win) return { ok: false };
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + Number(dx || 0)), Math.round(y + Number(dy || 0)));
  return { ok: true };
});
// The main-process cursor poll owns setIgnoreMouseEvents; the renderer channel
// is kept for compatibility but no longer flips the window (its forward-mouse
// events may never arrive on Windows).
ipcMain.handle('ncm:interactive', () => ({ ok: true, accepting }));
ipcMain.handle('ncm:control', async (_event, action) => {
  try {
    await fetch(`${BASE}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: String(action) }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle('ncm:close', () => { app.quit(); return { ok: true }; });
ipcMain.handle('ncm:config', () => ({ ok: true, lines: LINES, font: FONT }));

app.whenReady().then(() => {
  createWindow();
  // Escape hatches while the window is click-through or has lost its chrome.
  globalShortcut.register('Control+Alt+L', () => { applyLock(!locked); });
  globalShortcut.register('Control+Alt+X', () => { app.quit(); });
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { if (timer) clearInterval(timer); if (topmostTimer) clearInterval(topmostTimer); globalShortcut.unregisterAll(); });
