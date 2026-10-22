import assert from 'node:assert/strict';
import test from 'node:test';

import { appendPlay, evictToLimit, migrateSession, playsWithin, bucketByWeek, topTracks } from '../lib/core/history.js';
import { isoWeek, isoWeekRange, normalizePlay } from '../lib/core/models.js';

/** Local-time timestamp helper; tests never depend on the machine timezone offset. */
function at(y, monthIndex, day, hour = 12, minute = 0) {
  return new Date(y, monthIndex, day, hour, minute).getTime();
}

function play(overrides = {}) {
  return normalizePlay({ id: 1, name: '夜航西飞', artists: ['陈粒'], duration: 266_000, playedMs: 200_000, at: at(2026, 9, 19, 22, 10), ...overrides });
}

test('appendPlay merges a re-record inside the window', () => {
  const first = play();
  const history = [];
  appendPlay(history, first, { now: first.at });
  const merged = appendPlay(history, play({ playedMs: 250_000 }), { now: first.at + 30_000 });
  assert.equal(merged.merged, true);
  assert.equal(history.length, 1);
  assert.equal(history[0].playedMs, 250_000);
});

test('appendPlay keeps a later replay as a new entry', () => {
  const history = [];
  appendPlay(history, play(), { now: at(2026, 9, 19, 22, 10) });
  appendPlay(history, play(), { now: at(2026, 9, 20, 22, 10) });
  assert.equal(history.length, 2);
});

test('evictToLimit drops oldest and respects protected ids', () => {
  const history = [play({ id: 1 }), play({ id: 2 }), play({ id: 3 })];
  evictToLimit(history, 2);
  assert.deepEqual(history.map((entry) => entry.id), [1, 2]);
  const kept = [play({ id: 1 }), play({ id: 2 }), play({ id: 3 })];
  evictToLimit(kept, 2, new Set([3]));
  assert.ok(kept.some((entry) => entry.id === 3));
});

test('migrateSession upgrades v1 and preserves unrelated blocks', () => {
  const v1 = {
    version: 1,
    cookie: 'abc',
    history: [{ id: 7, name: '山海', artists: ['草东没有派对'], at: at(2026, 9, 18) }],
    feedback: { likes: [7], dislikes: [], skips: [] },
    queue: { tracks: [{ id: 7 }], index: 0 },
  };
  const { state, migrated, from } = migrateSession(v1);
  assert.equal(migrated, true);
  assert.equal(from, 1);
  assert.equal(state.version, 2);
  assert.equal(state.cookie, 'abc');
  assert.deepEqual(state.feedback.likes, [7]);
  assert.equal(state.history[0].source, 'unknown');
  assert.deepEqual(state.profile, { version: 1, generatedAt: 0, ranges: {} });
  assert.deepEqual(state.reports, {});
});

test('playsWithin is half-open and bucketByWeek keeps newest-first buckets', () => {
  const monday = at(2026, 9, 19, 8);
  const history = [play({ id: 1, at: monday }), play({ id: 2, at: monday + 3_600_000 })];
  assert.equal(playsWithin(history, { since: monday, until: monday + 1000 }).length, 1);
  assert.equal(playsWithin(history, { since: monday }).length, 2);
  const buckets = bucketByWeek(history);
  assert.equal(buckets.size, 1);
  assert.equal([...buckets.values()][0].length, 2);
});

test('topTracks counts heard plays only and sorts by count', () => {
  const history = [
    play({ id: 1 }), play({ id: 1 }), play({ id: 2 }),
    play({ id: 3, skipped: true }), play({ id: 3, skipped: true }),
  ];
  const top = topTracks(history, 2);
  assert.deepEqual(top.map((entry) => entry.track.id), [1, 2]);
  assert.equal(top[0].plays, 2);
});

test('isoWeekRange round-trips the ISO week that contains the timestamp', () => {
  for (const stamp of [at(2026, 0, 1, 9), at(2026, 9, 19, 22), at(2026, 11, 31, 23)]) {
    const week = isoWeek(stamp);
    assert.match(week.key, /^\d{4}-W\d{2}$/);
    const range = isoWeekRange(week.key);
    assert.ok(stamp >= range.start && stamp < range.end, `${week.key} misses ${new Date(stamp).toString()}`);
  }
});
