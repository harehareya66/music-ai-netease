/**
 * Desktop lyrics window launcher.
 *
 * The window itself is a WinForms form hosted by Windows PowerShell
 * (`lib/desktop-lyrics.ps1`): only a real OS window can sit on top of other
 * applications and swallow clicks (WS_EX_TRANSPARENT). The plugin just starts
 * and stops that process and reports its state; nothing here touches playback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DESKTOP_WIDGET_FILE = 'desktop-lyrics.json';

function paths(dataDir) {
  return {
    state: path.join(dataDir, DESKTOP_WIDGET_FILE),
    content: path.join(dataDir, 'desktop-lyrics.content.json'),
    log: path.join(dataDir, 'desktop-lyrics.log'),
  };
}

/** Running content pumps, keyed by data dir (one per widget). */
const pumps = new Map();

/** Lines of a plain LRC, minus credit-ish rows the widget should not show. */
const CREDIT = /^\s*(作词|作曲|编曲|制作人|原唱|演唱|监制|混音|母带|录音|吉他|贝斯|鼓|键盘|弦乐|和声|出品|发行|OP|SP)\s*[:：]/;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Pump "what the widget should draw" into a JSON file.
 *
 * Node does the HTTP + UTF-8 work because Windows PowerShell 5.1 decodes JSON
 * bodies as ANSI and would turn every Chinese lyric into question marks.
 */
function startPump({ dataDir, baseUrl, lines }) {
  stopPump(dataDir);
  const out = paths(dataDir).content;
  let trackId = null;
  let lyric = [];
  let busy = false;

  const write = (payload) => {
    try {
      fs.writeFileSync(out, JSON.stringify(payload));
    } catch {
      /* window is gone */
    }
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await fetchJson(`${baseUrl}/api/state`);
      const current = state?.current;
      if (!current) {
        write({ title: '', lines: [], status: '播放器里没有在放的歌' });
        return;
      }
      if (current.id !== trackId) {
        trackId = current.id;
        lyric = [];
        try {
          const raw = await fetchJson(`${baseUrl}/api/lyric?id=${current.id}&mode=lrc`);
          lyric = (raw?.lyrics?.lines ?? [])
            .filter((row) => row?.text && !CREDIT.test(row.text))
            .map((row) => ({ t: Number(row.t) || 0, text: String(row.text) }));
        } catch {
          lyric = [];
        }
      }
      const reported = state.reported ?? {};
      let position = Number(reported.position) || 0;
      if (state.playing && reported.at) position += Date.now() - Number(reported.at);
      let index = 0;
      for (let i = 0; i < lyric.length; i += 1) if (lyric[i].t <= position) index = i;
      const count = Math.max(1, lines);
      const start = Math.max(0, index - Math.floor((count - 1) / 2));
      const chunk = lyric.slice(start, start + count).map((row) => row.text);
      write({
        title: `${current.name} — ${(current.artists ?? []).join(' / ')}`,
        lines: chunk,
        status: chunk.length === 0 ? '这首歌还没有时间轴歌词' : '',
      });
    } catch {
      write({ title: '', lines: [], status: '连不上播放器' });
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(tick, 700);
  timer.unref?.();
  pumps.set(dataDir, timer);
}

export function stopPump(dataDir) {
  const timer = pumps.get(dataDir);
  if (timer) clearInterval(timer);
  pumps.delete(dataDir);
}


function readState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(paths(dataDir).state, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Current desktop-widget state; `running` reflects the OS process, not the file. */
export function desktopLyricsStatus({ dataDir }) {
  const saved = readState(dataDir);
  const running = Boolean(saved && alive(saved.pid));
  return {
    ok: true,
    running,
    pid: running ? saved.pid : null,
    startedAt: running ? saved.startedAt : null,
    lines: saved?.lines ?? 3,
    fontSize: saved?.fontSize ?? 26,
    baseUrl: saved?.baseUrl ?? null,
    script: path.join(HERE, 'desktop-lyrics.ps1'),
  };
}

/** Start (or restart) the desktop window; returns the same shape as status(). */
export function startDesktopLyrics({ dataDir, baseUrl, lines = 3, fontSize = 26, x, y }) {
  fs.mkdirSync(dataDir, { recursive: true });
  stopDesktopLyrics({ dataDir });

  const script = path.join(HERE, 'desktop-lyrics.ps1');
  if (!fs.existsSync(script)) {
    const err = new Error('desktop-lyrics.ps1 is missing from this build');
    err.code = 'MISSING_SCRIPT';
    throw err;
  }

  const pidFile = path.join(dataDir, 'desktop-lyrics.pid');
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* first run */
  }

  const args = [
    '/c',
    'start',
    '',
    'powershell.exe',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    script,
    '-BaseUrl',
    baseUrl,
    '-Lines',
    String(lines),
    '-FontSize',
    String(fontSize),
    '-StateFile',
    pidFile,
    '-ContentFile',
    paths(dataDir).content,
  ];
  if (Number.isInteger(x)) args.push('-X', String(x));
  if (Number.isInteger(y)) args.push('-Y', String(y));

  /*
   * PowerShell 直接由 Node detached 启动时会在没有控制台的环境下立即退出；
   * `cmd /c start` 会给它一个独立控制台，窗口才活得下来。代价是拿不到子进程
   * PID，所以由脚本启动后把 $PID 写进 pidFile，这里轮询读回来。
   */
  spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  const deadline = Date.now() + 8000;
  let pid = null;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        pid = parsed;
        break;
      }
    } catch {
      /* not written yet */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* ignore */
  }

  const saved = {
    pid,
    startedAt: Date.now(),
    baseUrl,
    lines,
    fontSize,
  };
  fs.writeFileSync(paths(dataDir).state, JSON.stringify(saved, null, 2));
  startPump({ dataDir, baseUrl, lines });
  return desktopLyricsStatus({ dataDir });
}

/** Stop the desktop window if it is running; never throws for "already gone". */
export function stopDesktopLyrics({ dataDir }) {
  stopPump(dataDir);
  const saved = readState(dataDir);
  if (saved && alive(saved.pid)) {
    try {
      spawn('taskkill', ['/PID', String(saved.pid), '/T', '/F'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      /* best effort */
    }
  }
  try {
    fs.unlinkSync(paths(dataDir).state);
  } catch {
    /* not running */
  }
  return { ok: true, running: false, pid: null };
}
