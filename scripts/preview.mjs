#!/usr/bin/env node
/**
 * 独立预览：不在 DSH 里也能把五屏和 API 跑起来，用来截图回归与肉眼验收。
 *
 *   node scripts/preview.mjs                      # 临时空数据目录（未登录）
 *   node scripts/preview.mjs --data-dir %USERPROFILE%\.dsh\music
 *   node scripts/preview.mjs --port 7788 --keep    # 固定端口，Ctrl-C 退出
 *   node scripts/preview.mjs --fake-llm            # 挂一个假模型，验证二创流式
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
const FAKE_LLM = Boolean(flag('--fake-llm'));

const logger = {
  info: (...parts) => console.log('[music]', ...parts),
  warn: (...parts) => console.warn('[music]', ...parts),
  debug: () => {},
};

/**
 * A stand-in LLM for previewing the streaming remix page **without pretending
 * to be a writer**: it answers from the text it was given, so two different
 * selections visibly produce two different results. The first line says it is
 * fake; real model quality is only checked against a configured provider.
 */
function promptText(request) {
  const content = request?.messages?.at(-1)?.content;
  return Array.isArray(content)
    ? content.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('')
    : String(content ?? '');
}

/** Take the lines inside `【要读的是这一段】` / `【这一次要处理的部分…】` sections. */
function sectionLines(prompt, marker) {
  const at = prompt.indexOf(marker);
  if (at < 0) return [];
  const rest = prompt.slice(at + marker.length);
  const stop = rest.search(/\n【/);
  let body = stop >= 0 ? rest.slice(0, stop) : rest;
  // 标记行本身的尾巴（「，共 3 行】」）要丢掉，否则会被当成第一行歌词。
  const close = body.indexOf('】');
  if (close >= 0 && close < 40) body = body.slice(close + 1);
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('【'));
}

function fakeAnswer(request) {
  const prompt = promptText(request);

  if (prompt.includes('先只读、不改写')) {
    const rows = sectionLines(prompt, '【要读的是这一段】');
    return [
      '（预览假模型：这段分析也是假的，只为验证两段式管道）',
      '情绪：克制、怀旧',
      `意象：${rows.slice(0, 3).map((line) => line.slice(0, 2)).join('、') || '灯、岸、船'}`,
      `叙事：这 ${rows.length} 行在讲一段没有说完的旧事。`,
    ];
  }

  const head = /(?:连起来是"|必须是「)([^"」]+)/.exec(prompt)?.[1] ?? '';
  const source = sectionLines(prompt, '【这一次要处理的部分');
  const lyricLines = source.length ? source : sectionLines(prompt, '【整首歌的歌词，只作背景】');

  if (head) {
    const chars = Array.from(head);
    // 藏头必须逐行首字对齐，所以不加任何说明行，也不重复已经以该字开头的词。
    return chars.map((char, index) => {
      const raw = lyricLines[index] || `第 ${index + 1} 行的词`;
      const body = raw.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').replace(new RegExp(`^${char}+`), '');
      return `${char}${body.slice(0, 10)}`;
    });
  }

  const shape = '（预览假模型：下面每行都来自你这次选中的歌词，只验证管道）';
  if (lyricLines.length === 0) return [shape, '这次没有选中任何歌词。'];
  return [
    shape,
    ...lyricLines.slice(0, 7).map((line) => line.replace(/[，。！？；：]$/, '')),
  ];
}

function makeFakeLlm() {
  return {
    listProviders: () => [{ id: 'preview' }],
    listModels: async () => [{ id: 'preview-model' }],
    stream: (request) => (async function* generate() {
      for (const line of fakeAnswer(request)) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        yield { type: 'text-delta', text: `${line}\n` };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  };
}

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
    get: (name) => (FAKE_LLM && name === 'llm' ? makeFakeLlm() : undefined),
  };
  apply(ctx, { dataDir, requestTimeoutMs: 20_000, write: { playlist: true } });
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
