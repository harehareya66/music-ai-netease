/**
 * Account listening-record aggregation: plays arrive pre-counted, with no
 * timestamps. These tests pin the weighting and the honest nulls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateCounted, buildAccountProfile, describeCounted } from '../lib/core/taste.js';

const track = (id, name, artist) => ({ id, name, artists: [artist], album: 'A', duration: 200_000 });
const tagsById = {
  1: { language: '华语', bpm: 70, year: 2015, genres: ['民谣'], tags: ['深夜'] },
  2: { language: '华语', bpm: 120, year: 2004, genres: ['摇滚'], tags: [] },
  3: { language: '英语', bpm: 96, year: 1998, genres: [], tags: ['通勤'] },
};
const items = [
  { track: track(1, 'A', '万能青年旅店'), plays: 60 },
  { track: track(2, 'B', '万能青年旅店'), plays: 24 },
  { track: track(3, 'C', 'Radiohead'), plays: 16 },
];

test('aggregateCounted weights every bucket by play count', () => {
  const agg = aggregateCounted(items, tagsById);
  assert.equal(agg.plays, 100);
  assert.equal(agg.unique, 3);
  assert.equal(agg.weighted, true);
  assert.equal(agg.hours, null, 'no timestamps, so no hours');
  assert.equal(agg.nightShare, null);
  assert.equal(agg.languages[0].key, '华语');
  assert.equal(agg.languages[0].pct, 84, '60+24 out of 100');
  assert.equal(agg.artists[0].name, '万能青年旅店');
  assert.equal(agg.artists[0].count, 84);
  // (70*60 + 120*24 + 96*16) / 100 = 86.16 → 86
  assert.equal(agg.avgBpm, 86);
  // repeats: (60-1) + (24-1) + (16-1) = 97
  assert.equal(agg.repeats, 97);
  assert.equal(agg.repeatRate, 97);
});

test('aggregateCounted skips items without a track or with no plays', () => {
  const agg = aggregateCounted(
    [{ track: null, plays: 5 }, { track: track(1, 'A', 'X'), plays: 0 }, items[0]],
    tagsById,
  );
  assert.equal(agg.plays, 60);
  assert.equal(agg.unique, 1);
});

test('buildAccountProfile marks the source and leaves time-derived fields null', () => {
  const profile = buildAccountProfile({ items, tagsById, now: 1_700_000_000_000 });
  assert.equal(profile.source, 'account');
  assert.equal(profile.range, 'all');
  assert.equal(profile.metrics.newRate, null);
  assert.equal(profile.metrics.hours, null);
  assert.equal(profile.metrics.plays, 100);
  assert.equal(profile.metrics.tracks, 3);
  assert.equal(profile.metrics.repeatRate, null, 'lifetime counts cannot express repeat rate');
  assert.equal(profile.deltas, null);
  assert.deepEqual(profile.topTracks.map((entry) => entry.plays), [60, 24, 16]);
  assert.equal(profile.buckets.language[0].key, '华语');
  assert.ok(profile.tags.length > 0);
});

test('describeCounted is deterministic and says it is a lifetime count', () => {
  const profile = buildAccountProfile({ items, tagsById });
  assert.match(profile.summary, /账号累计 100 次播放/);
  assert.match(profile.summary, /最常听 万能青年旅店/);
  assert.doesNotMatch(profile.summary, /单曲循环/);
  assert.equal(describeCounted(aggregateCounted([], {})), '账号里还没有听歌记录，先在网易云听几首再来看看。');
});
