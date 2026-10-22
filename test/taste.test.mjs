import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProfile, describe, selectRange } from '../lib/core/taste.js';
import { firstSeenMap } from '../lib/core/history.js';
import { normalizePlay } from '../lib/core/models.js';

const DAY = 86_400_000;
/** Fixed "now" so the rolling windows are deterministic. */
const NOW = new Date(2026, 9, 22, 12, 0).getTime();

function play(id, { daysAgo = 1, hour = 23, skipped = false, playedMs = 200_000, artists = ['陈粒'] } = {}) {
  const at = NOW - daysAgo * DAY;
  const date = new Date(at);
  date.setHours(hour, 10, 0, 0);
  return normalizePlay({ id, name: `曲目${id}`, artists, duration: 240_000, playedMs, skipped, at: date.getTime() });
}

const tags = {
  1: { genres: ['流行'], tags: ['深夜', '怀旧'], language: '华语', bpm: 72, year: 2019 },
  2: { genres: ['摇滚'], tags: ['雨天'], language: '华语', bpm: 96, year: 2016 },
  3: { genres: ['流行'], tags: ['通勤'], language: '英语', bpm: 118, year: 2020 },
};

test('buildProfile aggregates languages, tempo, top artists and the summary', () => {
  const plays = [play(1), play(1, { daysAgo: 2 }), play(2, { daysAgo: 3 }), play(3, { daysAgo: 4, hour: 9 })];
  const profile = buildProfile({ plays, tagsById: tags, now: NOW, range: '4w', since: NOW - 28 * DAY });
  assert.equal(profile.metrics.plays, 4);
  assert.equal(profile.metrics.tracks, 3);
  assert.equal(profile.buckets.language[0].key, '华语');
  assert.equal(profile.metrics.avgBpm, 90);
  assert.equal(profile.topArtists[0].name, '陈粒');
  assert.match(profile.summary, /华语/);
  assert.ok(profile.tags.some((tag) => tag.label === '深夜'));
});

test('buildProfile marks genuinely new tracks and reports deltas against the previous window', () => {
  const plays = [play(1, { daysAgo: 1 }), play(2, { daysAgo: 2 })];
  const previousPlays = [play(3, { daysAgo: 40 })];
  const firstSeen = firstSeenMap([...plays, ...previousPlays]);
  const profile = buildProfile({
    plays,
    previousPlays,
    tagsById: tags,
    firstSeen,
    now: NOW,
    range: '4w',
    since: NOW - 28 * DAY,
  });
  // Both plays fall inside the window and are new to the history.
  assert.equal(profile.metrics.newRate, 100);
  assert.ok(profile.deltas);
});

test('describe handles an empty profile', () => {
  assert.match(describe({ plays: 0 }), /数据/);
});

test('selectRange uses rolling days, not calendar weeks', () => {
  const history = [play(1, { daysAgo: 1 }), play(2, { daysAgo: 100 })];
  assert.equal(selectRange(history, { range: '4w', now: NOW }).length, 1);
  assert.equal(selectRange(history, { range: 'all', now: NOW }).length, 2);
});
