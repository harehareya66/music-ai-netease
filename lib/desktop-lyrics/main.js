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
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.NCM_BASE || 'http://127.0.0.1:7789/music').replace(/\/$/, '');
const PID_FILE = process.env.NCM_PID_FILE || '';
const POS_FILE = process.env.NCM_POS_FILE || '';
const LINES = Math.max(1, Math.min(5, Number(process.env.NCM_LINES) || 3));
const FONT = Math.max(14, Math.min(48, Number(process.env.NCM_FONT) || 26));

let win = null;
let timer = null;
let state = null;
let trackId = null;
let lyric = null;
let locked = false;
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

function applyLock(next) {
  locked = Boolean(next);
  if (!win) return;
  win.setIgnoreMouseEvents(locked, { forward: true });
  writePos({ locked });
  pushPayload(true);
}

function createWindow() {
  const saved = readPos();
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
    win.setIgnoreMouseEvents(locked, { forward: true });
    pushPayload(true);
  });
  win.on('moved', () => {
    const [wx, wy] = win.getPosition();
    writePos({ x: wx, y: wy });
  });
  win.on('closed', () => { win = null; });

  if (PID_FILE) {
    try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* ignore */ }
  }
  timer = setInterval(refresh, 400);
  refresh();
}

ipcMain.handle('ncm:lock', (_event, next) => { applyLock(next); return { ok: true, locked }; });
ipcMain.handle('ncm:interactive', (_event, next) => {
  if (!win) return { ok: false };
  const want = Boolean(next);
  if (want === unlockHover) return { ok: true };
  unlockHover = want;
  win.setIgnoreMouseEvents(!want, { forward: true });
  return { ok: true };
});
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
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { if (timer) clearInterval(timer); });
