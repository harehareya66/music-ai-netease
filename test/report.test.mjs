import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWeekly, currentWeekLabel, reportWeekKey, weekLabel } from '../lib/core/report.js';
import { firstSeenMap } from '../lib/core/history.js';
import { isoWeek, isoWeekRange, normalizePlay } from '../lib/core/models.js';

function play(id, { day = 19, hour = 22, minute = 10, playedMs = 200_000, skipped = false, name } = {}) {
  const at = new Date(2026, 9, day, hour, minute).getTime();
  return normalizePlay({ id, name: name ?? `曲目${id}`, artists: ['陈粒'], duration: 240_000, playedMs, skipped, at });
}

test('buildWeekly produces metrics, daily buckets and the loop story', () => {
  const history = [
    play(1, { day: 19, hour: 22 }),
    play(1, { day: 20, hour: 1 }),
    play(1, { day: 21, hour: 1 }),
    play(1, { day: 22, hour: 0 }),
    play(2, { day: 21, hour: 23, skipped: true }),
    play(3, { day: 22, hour: 9 }),
  ];
  const weekKey = isoWeek(new Date(2026, 9, 21, 12).getTime()).key;
  const report = buildWeekly({ history, firstSeen: firstSeenMap(history), now: new Date(2026, 9, 21, 12).getTime(), weekKey });
  assert.ok(report);
  assert.equal(report.week.key, weekKey);
  assert.equal(report.metrics.tracks, 2);
  assert.equal(report.daily.length, 7);
  assert.equal(report.topTracks[0].track.id, 1);
  assert.equal(report.topTracks[0].plays, 4);
  assert.match(report.loop.story, /没断过/);
  assert.ok(report.text.includes('听歌集中在'));
  assert.ok(report.metrics.hours > 0);
});

test('weekly metrics count new tracks and skip rate', () => {
  const history = [play(1), play(2, { day: 20 }), play(3, { day: 20, skipped: true })];
  const weekKey = isoWeek(new Date(2026, 9, 20, 12).getTime()).key;
  const report = buildWeekly({ history, firstSeen: firstSeenMap(history), now: new Date(2026, 9, 20, 12).getTime(), weekKey });
  assert.equal(report.metrics.newTracks, 2);
  assert.equal(report.metrics.skipRate, 33.3);
});

test('week helpers agree with the ISO calendar', () => {
  const now = new Date(2026, 9, 21, 12).getTime();
  const key = reportWeekKey(now);
  const range = isoWeekRange(key);
  assert.ok(now >= range.start && now < range.end);
  assert.equal(currentWeekLabel(now), weekLabel(range));
});

test('malformed week key returns null instead of throwing', () => {
  assert.equal(buildWeekly({ history: [], weekKey: 'not-a-week' }), null);
});
