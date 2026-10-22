import assert from 'node:assert/strict';
import test from 'node:test';

import { excludedIds, orderByTempo, parseBrief, planScene } from '../lib/core/scene.js';

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const DAY = 86_400_000;

function track(id, { name = `曲目${id}`, artist = `歌手${id}`, duration = 240_000 } = {}) {
  return { id, name, artists: [artist], album: '专辑', duration };
}

const tags = {
  1: { tags: ['雨天', '深夜'], language: '华语', bpm: 72 },
  2: { tags: ['雨天'], language: '华语', bpm: 78 },
  3: { tags: ['通勤'], language: '英语', bpm: 120 },
  4: { tags: ['雨天'], language: '华语', bpm: 84 },
};

test('parseBrief extracts tempo, language and duration', () => {
  const brief = parseBrief('雨天的下午，别太吵，华语，约 42 分钟');
  assert.equal(brief.band, 'slow');
  assert.equal(brief.language, '华语');
  assert.equal(brief.minutes, 42);
  assert.equal(brief.quiet, true);
  assert.ok(brief.keywords.includes('雨天'));
});

test('excludedIds drops recent plays and disliked tracks', () => {
  const ids = excludedIds({
    history: [{ id: 9, at: NOW - DAY }, { id: 10, at: NOW - 10 * DAY }],
    disliked: new Set([11]),
    now: NOW,
  });
  assert.ok(ids.has(9));
  assert.ok(ids.has(11));
  assert.ok(!ids.has(10));
});

test('planScene ranks by source, honours exclusions and caps per artist', () => {
  const pool = [
    { track: track(1), source: 'search', label: '雨天' },
    { track: track(2), source: 'similar', seed: '曲目1' },
    { track: track(3), source: 'daily' },
    { track: track(4), source: 'taste', label: '歌手4' },
    { track: track(5, { artist: '歌手1' }), source: 'search', label: '雨天' },
    { track: track(6, { artist: '歌手1' }), source: 'search', label: '雨天' },
  ];
  const draft = planScene({
    brief: '雨天的下午，别太吵，华语',
    pool,
    tagsById: tags,
    history: [{ id: 3, at: NOW - DAY }],
    disliked: new Set([4]),
    now: NOW,
  });
  const ids = draft.tracks.map((entry) => entry.track.id);
  assert.ok(!ids.includes(3), 'recent track must be excluded');
  assert.ok(!ids.includes(4), 'disliked track must be excluded');
  assert.equal(ids[0], 1, 'search hit with matching tags ranks first');
  assert.ok(draft.bySource.some((entry) => entry.key === 'search'));
  // artist cap: only two tracks by 歌手1
  assert.ok(ids.filter((id) => id === 5 || id === 6).length <= 2);
  assert.equal(draft.excluded.recent, 1);
  assert.equal(draft.excluded.disliked, 1);
});

test('planScene trims to the requested duration but keeps at least five', () => {
  const pool = Array.from({ length: 10 }, (_, index) => ({ track: track(10 + index), source: 'search', label: 'x' }));
  const draft = planScene({ brief: '45 分钟', pool, tagsById: {}, now: NOW });
  assert.ok(draft.tracks.length >= 5);
  assert.ok(draft.estimatedMinutes <= 45 + 4);
});

test('orderByTempo is stable code-side reordering', () => {
  const tracks = [{ track: track(1), bpm: 120 }, { track: track(2), bpm: 72 }, { track: track(3), bpm: 96 }];
  assert.deepEqual(orderByTempo(tracks).map((entry) => entry.bpm), [72, 96, 120]);
  assert.deepEqual(orderByTempo(tracks, { ascending: false }).map((entry) => entry.bpm), [120, 96, 72]);
});
