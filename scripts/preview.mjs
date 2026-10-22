#!/usr/bin/env node
/**
 * 独立预览：不在 DSH 里也能把五屏和 API 跑起来，用来截图回归与肉眼验收。
 *
 *   node scripts/preview.mjs                      # 临时空数据目录（未登录）
 *   node scripts/preview.mjs --data-dir %USERPROFILE%\.dsh\music
 *   node scripts/preview.mjs --port 7788 --keep    # 固定端口，Ctrl-C 退出
 *
 * 输出的 URL 直接贴浏览器：
 *   /music/panel  播放器      /music/taste   画像
 *   /music/weekly 周报        /music/scene   场景
 *   /music/lyric  歌词二创    /music/health  健康检查
 *
 * 注意：这是本地预览服务器（mock 掉 Cordis ctx），不是 DSH 运行时；
 * 播放引擎/登录/SSE 在预览里能跑，但工具调用与 slot 只在真 DSH 里存在。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PORT = Number(flag('--port')) || 0;
const DATA_DIR = typeof flag('--data-dir') === 'string' ? flag('--data-dir') : null;

const logger = {
  info: (...parts) => console.log('[music]', ...parts),
  warn: (...parts) => console.warn('[music]', ...parts),
  debug: () => {},
};

function mount(dataDir) {
  const cleanups = [];
  let routeHandler = null;
  const tools = [];
  const ctx = {
    logger,
    tools: { register: (spec) => tools.push(spec) },
    webServer: {
      port: 0,
      register: ({ handler }) => {
        routeHandler = handler;
        return () => {};
      },
    },
    effect: (fn) => cleanups.push(fn()),
    get: () => undefined,
  };
  apply(ctx, { dataDir, requestTimeoutMs: 20_000 });
  return { ctx, tools, handler: routeHandler, cleanups };
}

async function main() {
  const tempDir = DATA_DIR ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-preview-'));
  const dataDir = DATA_DIR || tempDir;
  const mounted = mount(dataDir);

  const server = http.createServer((req, res) => {
    Promise.resolve(mounted.handler(req, res))
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
        }
      })
      .catch((error) => {
        console.error('[music] request failed:', error);
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(error?.message ?? error));
        }
      });
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/music`;

  mounted.ctx.webServer.port = port;
  console.log('─'.repeat(64));
  console.log(`数据目录 ${dataDir}${DATA_DIR ? '' : '（临时，退出即删）'}`);
  console.log(`工具 ${mounted.tools.length} 个：${mounted.tools.map((spec) => spec.name).join(', ')}`);
  console.log('─'.repeat(64));
  for (const page of ['panel', 'taste', 'weekly', 'scene', 'lyric']) {
    console.log(`${base}/${page}`);
  }
  console.log(`${base}/health`);
  console.log(`${base}/api/taste?range=4w`);
  console.log(`${base}/api/report?week=this`);
  console.log('─'.repeat(64));

  const shutdown = () => {
    server.close();
    for (const cleanup of mounted.cleanups) {
      try {
        cleanup();
      } catch {
        // already gone
      }
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (!flag('--keep')) {
    console.log('加 --keep 常驻；不加以 30 分钟后自动退出。');
    setTimeout(shutdown, 30 * 60_000).unref();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
