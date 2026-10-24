import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAccountWeek, buildWeekly, REPORT_TRACK_LIMIT } from '../lib/core/report.js';

function report(plays = []) {
  const now = Date.UTC(2026, 9, 21, 12); // Wed
  return buildWeekly({
    history: plays,
    firstSeen: new Map(),
    now,
    weekKey: '2026-W43',
  });
}

const track = (id, name, plays) => ({
  track: { id, name, artists: ['某艺人'] },
  plays,
});

test('账号本周榜替换榜单并标注来源，时长/每日仍是本机的', () => {
  const local = [
    { id: 1, name: 'A', artists: ['x'], at: Date.UTC(2026, 9, 21, 4), playedMs: 120_000, tentative: false },
    { id: 2, name: 'B', artists: ['y'], at: Date.UTC(2026, 9, 21, 5), playedMs: 60_000, tentative: false },
  ];
  const base = report(local);
  const merged = applyAccountWeek(base, {
    available: true,
    weekKey: '2026-W43',
    plays: 900,
    tracks: [track(11, '账号最爱', 40), track(12, '第二', 20)],
    source: { label: '账号本周记录' },
  });
  assert.equal(merged.topSource, 'account');
  assert.deepEqual(merged.topTracks.map((item) => item.track.name), ['账号最爱', '第二']);
  assert.equal(merged.topTracks[0].plays, 40);
  assert.equal(merged.account.available, true);
  assert.equal(merged.account.plays, 900);
  // 本机时间形状的数字不动
  assert.equal(merged.metrics.hours, base.metrics.hours);
  assert.deepEqual(merged.daily.map((day) => day.minutes), base.daily.map((day) => day.minutes));
});

test('账号本周榜最多 7 条', () => {
  const base = report([]);
  const tracks = Array.from({ length: 12 }, (_, i) => track(100 + i, `T${i}`, 12 - i));
  const merged = applyAccountWeek(base, { available: true, tracks });
  assert.equal(merged.topTracks.length, REPORT_TRACK_LIMIT);
});

test('账号为空或不可用时保留本机榜单', () => {
  const local = [{ id: 1, name: 'A', artists: ['x'], at: Date.UTC(2026, 9, 21, 4), playedMs: 60_000, tentative: false }];
  const base = report(local);
  const empty = applyAccountWeek(base, { available: true, tracks: [] });
  assert.equal(empty.account.available, false);
  assert.equal(empty.topSource, undefined);
  assert.deepEqual(empty.topTracks.map((item) => item.track.name), ['A']);

  const offline = applyAccountWeek(base, { available: false });
  assert.equal(offline.account.available, false);
  assert.equal(offline.topTracks.length, base.topTracks.length);
});

test('applyAccountWeek 不改原对象', () => {
  const base = report([]);
  const snapshot = JSON.stringify(base);
  applyAccountWeek(base, { available: true, tracks: [track(1, 'x', 3)] });
  assert.equal(JSON.stringify(base), snapshot);
});
