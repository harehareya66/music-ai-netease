/**
 * 安全与权限：把「数据在哪、什么会出网、插件能改什么」整理成可读的一份报告。
 *
 * 这里只做审计与汇总，不发请求、不碰账号。静态检查在请求时扫源码，
 * 结果缓存 60 秒；页面拿到的是文件与行号，便于用户自己核对。
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXT = /\.(mjs|js|html)$/;
const SKIP_DIRS = new Set(['vendor', 'node_modules']);
const CACHE_TTL_MS = 60_000;

/** 允许出网的主机：只应该有网易云与本地回环。 */
const ALLOWED_HOSTS = [
  'music.163.com',
  'interface.music.163.com',
  'clientlog.music.163.com',
  'clientlogusf.music.163.com',
  'p1.music.126.net',
  'p2.music.126.net',
  'p3.music.126.net',
  'p4.music.126.net',
  'm701.music.126.net',
  'm801.music.126.net',
  'm804.music.126.net',
  '127.0.0.1',
  'localhost',
];

/** 逐条检查：返回 {id,label,ok,detail,issues[]}。 */
export function auditSource({ files }) {
  const issues = { eval: [], external: [], cookieLog: [], child: [] };
  for (const file of files) {
    const rel = file.path;
    const lines = String(file.text ?? '').split('\n');
    lines.forEach((line, index) => {
      const at = `${rel}:${index + 1}`;
      const trimmed = line.trim();
      // 注释里的链接（比如图标来源）不是出网请求，跳过注释行。
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('<!--');
      if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) issues.eval.push(at);
      if (!isComment && /(https?:\/\/[^\s'"`)]+)/.test(line)) {
        const match = line.match(/(https?:\/\/[^\s'"`)]+)/);
        const url = match ? match[1] : '';
        let host = '';
        try { host = new URL(url).hostname; } catch { host = ''; }
        if (host && !ALLOWED_HOSTS.includes(host) && !host.endsWith('.music.126.net')) {
          issues.external.push(`${at} ${host}`);
        }
      }
      if (/console\.(log|info|warn|error)/.test(line) && /cookie|MUSIC_U/i.test(line)) {
        issues.cookieLog.push(at);
      }
      if (/require\(['"]child_process['"]\)|from ['"]node:child_process['"]/.test(line)) issues.child.push(at);
    });
  }
  const list = (items) => items.slice(0, 6);
  return [
    {
      id: 'no-eval',
      label: '没有动态执行代码',
      ok: issues.eval.length === 0,
      detail: issues.eval.length ? `发现 eval / new Function：${list(issues.eval).join('、')}` : '未发现 eval / new Function',
      issues: list(issues.eval),
    },
    {
      id: 'outbound-hosts',
      label: '出网只去网易云与本机',
      ok: issues.external.length === 0,
      detail: issues.external.length ? `发现其它主机：${list(issues.external).join('、')}` : '源码里的 URL 只指向网易云域名与本机回环',
      issues: list(issues.external),
    },
    {
      id: 'cookie-not-logged',
      label: 'cookie 不写日志',
      ok: issues.cookieLog.length === 0,
      detail: issues.cookieLog.length ? `发现日志里带 cookie：${list(issues.cookieLog).join('、')}` : '日志语句里没有 cookie / MUSIC_U',
      issues: list(issues.cookieLog),
    },
    {
      id: 'no-child-process',
      label: '不创建子进程',
      ok: issues.child.length === 0,
      detail: issues.child.length ? `发现 child_process：${list(issues.child).join('、')}` : '没有 child_process 引用',
      issues: list(issues.child),
    },
  ];
}

/** 读源码（跳过 vendor 与 node_modules），供 auditSource 使用。 */
export function collectSources(libDir) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      files.push({ path: path.relative(path.dirname(libDir), full).split(path.sep).join('/'), text });
    }
  };
  walk(libDir);
  return files;
}

/** session.json 的权限与大小；文件不存在时也如实报告。 */
export function fileFacts(file) {
  try {
    const stat = fs.statSync(file);
    const mode = stat.mode & 0o777;
    // Windows 没有 POSIX 权限位（Node 只能切只读），文件在用户目录下即视为私有。
    const windows = process.platform === 'win32';
    return {
      exists: true,
      size: stat.size,
      mode,
      modeText: mode.toString(8).padStart(3, '0'),
      windows,
      private: windows ? true : (mode & 0o077) === 0,
    };
  } catch {
    return { exists: false, size: 0, mode: null, modeText: null, windows: process.platform === 'win32', private: false };
  }
}

/** 汇总成页面需要的形状。 */
export function buildSecurityReport({ dataDir, settings, write, model, session, sources, now = Date.now() }) {
  const sessionFile = path.join(dataDir, 'session.json');
  const facts = fileFacts(sessionFile);
  const checks = auditSource({ files: sources });
  return {
    version: 1,
    generatedAt: now,
    dataDir,
    storage: {
      sessionFile,
      session: facts,
      files: [
        {
          name: 'session.json',
          what: '登录 cookie、播放历史、画像/周报缓存、设置',
          outbound: false,
          note: facts.exists
            ? (facts.windows ? 'Windows：文件在用户目录下，权限位不生效' : `权限 ${facts.modeText}，仅本机`)
            : '还没写入',
        },
        { name: 'cache/tags.json', what: '歌曲标签缓存（曲风/语言/BPM）', outbound: false, note: '只读缓存' },
        { name: 'probe.json', what: 'M0 探针结果（脱敏，无 cookie）', outbound: false, note: '手动运行才会写' },
      ],
    },
    account: {
      signedIn: Boolean(session?.authenticated),
      nickname: session?.account?.nickname ?? null,
      cookieChars: Number(session?.cookieLength ?? 0),
      cookieStored: '仅本机 session.json，权限 0600，不写日志、不上传',
    },
    outbound: [
      { target: 'music.163.com / interface.music.163.com', what: '搜索、歌单、歌词、播放地址、听歌记录', carries: 'cookie（仅请求头）', sent: true },
      { target: '*.music.126.net', what: '封面与音频流', carries: '不带账号信息', sent: true },
      { target: '模型服务（DSH 里配置的 provider）', what: '歌词二创：只发选中的歌词文本；DJ：只发候选歌名与画像摘要', carries: '不发送 cookie / 账号 / 播放历史原始数据', sent: Boolean(model?.route || model?.provider) },
    ],
    permissions: {
      read: ['账号昵称/头像', '歌单与收藏（只读）', '听歌记录（最近 100 首）', '歌词、封面、播放地址'],
      write: [
        { what: '播放歌单（场景草稿保存）', enabled: Boolean(write?.playlist), note: write?.playlist ? '会调用 playlist/create 与 tracks/manipulate' : '当前关闭' },
        { what: '红心 / 取消红心', enabled: true, note: '与面板的喜欢按钮同一接口' },
        { what: '播放上报（计入账号听歌记录）', enabled: Boolean(settings?.scrobble !== 'off'), note: '关闭后只记本机历史' },
      ],
      never: ['修改账号密码或安全设置', '读取私信 / 关注列表', '上传本地文件'],
    },
    model: {
      provider: model?.provider ?? null,
      model: model?.model ?? null,
      source: model?.source ?? null,
      note: 'API Key 由 DSH 的「设置 → 模型」保管，插件从不读取也不保存',
    },
    checks,
    checksSummary: {
      total: checks.length,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
    },
  };
}

/** 审计结果按目录缓存，返回一个可复用的读取器。 */
export function createSecurityAuditor({ libDir, ttlMs = CACHE_TTL_MS }) {
  let cache = { at: 0, sources: [] };
  return function sources() {
    if (Date.now() - cache.at < ttlMs && cache.sources.length) return cache.sources;
    cache = { at: Date.now(), sources: collectSources(libDir) };
    return cache.sources;
  };
}
