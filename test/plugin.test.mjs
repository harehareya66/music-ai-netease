/**
 * End-to-end smoke test of `apply()`: a fake Cordis context, a fake HTTP
 * server, and real route dispatch. This is what proves the plugin mounts, the
 * tools register, and the feature endpoints answer without a browser.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, name } from '../lib/index.js';

/** Minimal request object: a URL plus an empty async body. */
function request(url, method = 'GET', body) {
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
}

/** Response collector shaped like `node:http`. */
function response() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    },
    get body() {
      return Buffer.concat(this.chunks).toString('utf8');
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

/** Mount the plugin in a temp data dir; returns the pieces the tests need. */
function mount() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-smoke-'));
  const tools = [];
  const cleanups = [];
  let route = null;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: { register: (spec) => tools.push(spec) },
    webServer: {
      port: 12345,
      register: (entry) => {
        route = entry;
        return () => {};
      },
    },
    effect: (fn) => cleanups.push(fn()),
    get: () => undefined,
  };
  apply(ctx, { dataDir, requestTimeoutMs: 200 });
  return {
    dataDir,
    tools,
    route,
    call: async (url, method = 'GET', body) => {
      const res = response();
      await route.handler(request(url, method, body), res);
      return res;
    },
    dispose: () => {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // already disposed
        }
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('plugin export shape', () => {
  assert.equal(name, 'music');
  assert.equal(typeof apply, 'function');
});

test('mounts, registers 13 tools and serves health', async () => {
  const plugin = mount();
  try {
    assert.equal(plugin.route.kind, 'prefix');
    assert.equal(plugin.route.path, '/music');
    const names = plugin.tools.map((spec) => spec.name);
    assert.equal(names.length, 13, `expected 13 tools, got ${names.join(', ')}`);
    for (const required of ['library_list', 'library_tracks', 'scene_build', 'taste_profile', 'weekly_report', 'lyric_remix']) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }

    const res = await plugin.call('/music/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.panelContract, 2);
    assert.equal(res.json.tools.length, 13);
  } finally {
    plugin.dispose();
  }
});

test('serves the panel with feature navigation', async () => {
  const plugin = mount();
  try {
    const res = await plugin.call('/music/panel');
    assert.equal(res.status, 200);
    assert.match(res.body, /feature-nav/);
    assert.match(res.body, /画像/);
  } finally {
    plugin.dispose();
  }
});

test('taste endpoint answers with an empty profile before any play', async () => {
  const plugin = mount();
  try {
    const res = await plugin.call('/music/api/taste?range=4w');
    assert.equal(res.status, 200);
    const { profile } = res.json;
    assert.equal(profile.range, '4w');
    assert.equal(profile.metrics.plays, 0);
    assert.ok(Array.isArray(profile.tags));
    assert.ok(profile.summary.length > 0);
  } finally {
    plugin.dispose();
  }
});

test('report endpoint answers for this and last week', async () => {
  const plugin = mount();
  try {
    for (const week of ['this', 'last']) {
      const res = await plugin.call(`/music/api/report?week=${week}`);
      assert.equal(res.status, 200);
      const { report } = res.json;
      assert.match(report.week.key, /^\d{4}-W\d{2}$/);
      assert.equal(report.daily.length, 7);
      assert.equal(report.metrics.plays, 0);
    }
    const bad = await plugin.call('/music/api/report?week=2026-W99');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'BAD_WEEK');
  } finally {
    plugin.dispose();
  }
});

test('feature tool executes the weekly report end to end', async () => {
  const plugin = mount();
  try {
    const tool = plugin.tools.find((spec) => spec.name === 'weekly_report');
    const value = await tool.execute({ week: 'this' }, {});
    assert.match(value.message, /时长/);
    assert.match(value.report.week.label, /月/);
    const blocks = tool.output.render({ week: 'this' }, value);
    assert.equal(blocks[0].type, 'text');
  } finally {
    plugin.dispose();
  }
});
