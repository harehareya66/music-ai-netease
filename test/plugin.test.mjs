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
    assert.match(res.body, /检查台/);
  } finally {
    plugin.dispose();
  }
});

test('serves the maker console and its facts', async () => {
  const plugin = mount();
  try {
    const page = await plugin.call('/music/dev');
    assert.equal(page.status, 200);
    assert.match(page.body, /制作者检查台/);

    const res = await plugin.call('/music/api/dev');
    assert.equal(res.status, 200);
    const dev = res.json;
    assert.equal(dev.ok, true);
    assert.equal(dev.prefix, '/music');
    assert.equal(dev.pages.includes('dev'), true);
    assert.equal(Array.isArray(dev.tools), true);
    assert.equal(dev.tools.length, 13);
    assert.equal(typeof dev.session.history, 'number');
    // No probe has run in a temp data dir yet, and that must not be an error.
    assert.equal(dev.probe, null);
  } finally {
    plugin.dispose();
  }
});

test('the floating lyrics window is served and says what it is', async () => {
  const plugin = mount();
  try {
    const page = await plugin.call('/music/lyric-window');
    assert.equal(page.status, 200);
    assert.match(page.body, /歌词/);
    // 它只读 API、不写账号：页面里不该出现任何写操作端点。
    assert.doesNotMatch(page.body, /playlist\/create/);
  } finally {
    plugin.dispose();
  }
});

test('settings page and API agree, and a saved route survives a re-read', async () => {
  const plugin = mount();
  try {
    const page = await plugin.call('/music/settings');
    assert.equal(page.status, 200);
    assert.match(page.body, /设置/);

    const initial = await plugin.call('/music/api/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.ok, true);
    // No LLM service is mounted in this fake host, and that is a state the page
    // has to render, not an error.
    assert.deepEqual(initial.json.catalog, []);
    assert.equal(initial.json.settings.model.provider, '');
    assert.equal(initial.json.write.playlist, true);

    const saved = await plugin.call('/music/api/settings', 'POST', {
      model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      level: 'hires',
      ui: { template: 'dark', fontScale: 1.1 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.settings.model.model, 'deepseek-flash');
    assert.equal(saved.json.effective.source, 'settings');
    assert.equal(saved.json.settings.level, 'hires');
    assert.equal(saved.json.settings.ui.fontScale, 1.1);

    const reread = await plugin.call('/music/api/settings');
    assert.equal(reread.json.settings.model.provider, 'deepseek-account');

    const bad = await plugin.call('/music/api/settings', 'POST', { model: { provider: 'only-provider' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /provider 和 model/);

    const noModel = await plugin.call('/music/api/settings/model-test', 'POST', { provider: 'p', model: 'm' });
    // Without a host LLM service the test reports a coded failure instead of
    // pretending the route works.
    assert.equal(noModel.status, 200);
    assert.equal(noModel.json.ok, false);
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

test('security page and report expose the audit without leaking secrets', async () => {
  const plugin = mount();
  try {
    const page = await plugin.call('/music/security');
    assert.equal(page.status, 200);
    assert.match(page.body, /安全与权限/);

    const res = await plugin.call('/music/api/security');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const { report } = res.json;
    assert.equal(report.checks.length, 4);
    assert.equal(report.checksSummary.total, 4);
    assert.ok(Array.isArray(report.outbound));
    assert.ok(report.storage.session.exists);
    // The report must never carry the cookie value itself, only its length.
    const serialized = JSON.stringify(report);
    // Only mention the cookie by name is fine; its value must never appear.
    assert.equal(/MUSIC_U\s*[=:]\s*[A-Za-z0-9%_-]{20,}/.test(serialized), false);
    assert.ok(typeof report.account.cookieChars === 'number');
  } finally {
    plugin.dispose();
  }
});

test('theme bridge merges the shell template with the saved ui settings', async () => {
  const plugin = mount();
  try {
    const initial = await plugin.call('/music/api/theme');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.effective, 'dark');

    const posted = await plugin.call('/music/api/theme', 'POST', { resolved: 'light' });
    assert.equal(posted.status, 200);
    const merged = await plugin.call('/music/api/theme');
    assert.equal(merged.json.host.resolved, 'light');
    assert.equal(merged.json.effective, 'light');

    const forced = await plugin.call('/music/api/settings', 'POST', { ui: { template: 'dark', fontScale: 1.2 } });
    assert.equal(forced.status, 200);
    const after = await plugin.call('/music/api/theme');
    assert.equal(after.json.template, 'dark');
    assert.equal(after.json.effective, 'dark');
    assert.equal(after.json.scale, 1.2);

    const bad = await plugin.call('/music/api/theme', 'POST', { resolved: 'blue' });
    assert.equal(bad.status, 400);
  } finally {
    plugin.dispose();
  }
});
