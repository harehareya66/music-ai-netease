/**
 * Settings are a small pure layer: validation, precedence, and the names the
 * settings page shows. No host, no network — the route-level shape is covered
 * in `plugin.test.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSettingsPatch,
  preferredModel,
  savedModel,
} from '../lib/settings.js';

test('model choice needs both halves, or neither', () => {
  const cleared = normalizeSettingsPatch({ model: { provider: '', model: '' } }, {});
  assert.deepEqual(cleared.patch.model, { provider: '', model: '' });
  assert.deepEqual(cleared.issues, []);

  const partial = normalizeSettingsPatch({ model: { provider: 'p' } }, {});
  assert.equal(partial.patch.model, undefined);
  assert.match(partial.issues[0], /provider 和 model/);

  const picked = normalizeSettingsPatch({ model: { provider: 'deepseek-account', model: 'deepseek-flash' } }, {});
  assert.deepEqual(picked.patch.model, { provider: 'deepseek-account', model: 'deepseek-flash' });
  // The legacy picker fields follow the unified choice, so a downgrade still
  // reads one coherent route.
  assert.equal(picked.patch.djProvider, 'deepseek-account');
  assert.equal(picked.patch.djModel, 'deepseek-flash');
});

test('quality, scrobble and DJ fields are validated rather than trusted', () => {
  const { patch, issues } = normalizeSettingsPatch(
    { level: 'hires', scrobble: false, dj: { batchSize: 12, autoExtendBelow: -3, prompt: ' 深夜 ' } },
    {},
  );
  assert.equal(patch.level, 'hires');
  assert.equal(patch.scrobble, false);
  assert.equal(patch.dj.batchSize, 12);
  assert.equal(patch.dj.autoExtendBelow, 0);
  assert.equal(patch.dj.prompt, '深夜');
  assert.deepEqual(issues, []);

  const bad = normalizeSettingsPatch({ level: 'ultra', scrobble: 'yes', nope: 1 }, {});
  assert.equal(bad.patch.level, undefined);
  assert.equal(bad.patch.scrobble, undefined);
  assert.ok(bad.issues.some((line) => line.includes('未知音质档')));
  assert.ok(bad.issues.some((line) => line.includes('scrobble')));
  assert.ok(bad.issues.some((line) => line.includes('未知设置项')));
});

test('appearance accepts the stored shape and clamps the scale', () => {
  const { patch } = normalizeSettingsPatch({ ui: { template: 'light', fontScale: 9 } }, {});
  assert.equal(patch.ui.template, 'light');
  assert.equal(patch.ui.fontScale, 1.3);

  const ignored = normalizeSettingsPatch({ ui: { template: 'solar' } }, {});
  assert.equal(ignored.patch.ui, undefined);
});

test('precedence: saved choice, then the conversation model, then nothing', () => {
  const saved = { model: { provider: 'deepseek-account', model: 'deepseek-flash' } };
  assert.deepEqual(preferredModel({ settings: saved, readAgentDefault: () => ({ provider: 'x', model: 'y' }) }), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    source: 'settings',
  });
  assert.deepEqual(preferredModel({ settings: {}, readAgentDefault: () => ({ provider: 'x', model: 'y' }) }), {
    provider: 'x',
    model: 'y',
    source: 'agent-default',
  });
  assert.equal(preferredModel({ settings: {}, readAgentDefault: () => null }), null);
  assert.equal(savedModel({ model: { provider: '', model: '' } }), null);
});
