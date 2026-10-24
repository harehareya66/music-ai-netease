import test from 'node:test';
import assert from 'node:assert/strict';

import { ORIGIN_LABEL, reasonForPick, summarizePicks } from '../lib/dj.js';

test('reasonForPick：口味里有的艺人优先说，再补来源', () => {
  const reason = reasonForPick(
    { name: '秦皇岛', artists: ['万能青年旅店'], origin: 'similar', boost: 'more' },
    { topArtists: ['万能青年旅店', '陈粒'], terms: [] },
  );
  assert.match(reason, /你刚说想多听这类/);
  assert.match(reason, /你常听 万能青年旅店/);
  assert.match(reason, /和你最近听的歌相似/);
});

test('reasonForPick：没有口味命中时退到「接着听」，并保留来源标签', () => {
  const reason = reasonForPick(
    { name: '晴天', artists: ['周杰伦'], origin: 'daily' },
    { topArtists: [], currentArtists: ['周杰伦'] },
  );
  assert.match(reason, /接着 周杰伦 听/);
  assert.match(reason, /每日推荐/);
});

test('reasonForPick：brief 命中歌名/艺人时点名关键词', () => {
  const reason = reasonForPick(
    { name: '雨天', artists: ['孙燕姿'], album: '雨天', origin: 'prompt' },
    { topArtists: [], terms: ['雨天'] },
  );
  assert.match(reason, /歌名\/艺人里有「雨天」/);
  assert.match(reason, /按你说的搜到/);
});

test('reasonForPick：不认识的来源也不会空着', () => {
  assert.equal(reasonForPick(null), '');
  const reason = reasonForPick({ name: 'x', artists: [] }, {});
  assert.equal(reason, '');
  assert.ok(ORIGIN_LABEL.chart);
});

test('summarizePicks：给出处分布与人数最多的一位艺人', () => {
  const tracks = [
    { name: 'a', artists: ['万能青年旅店'], origin: 'similar' },
    { name: 'b', artists: ['万能青年旅店'], origin: 'similar' },
    { name: 'c', artists: ['陈粒'], origin: 'daily' },
    { name: 'd', artists: ['陈粒'], origin: 'daily' },
    { name: 'e', artists: ['陈粒'], origin: 'chart' },
  ];
  const { summary, mix } = summarizePicks({ tracks, prompt: '深夜 emo', source: 'model', route: 'deepseek-account/deepseek-flash' });
  assert.deepEqual(mix, { similar: 2, daily: 2, chart: 1 });
  assert.match(summary, /按「深夜 emo」挑了 5 首/);
  assert.match(summary, /陈粒 占 3 首/);
  assert.match(summary, /deepseek-flash 从候选里挑的/);
  assert.match(summary, /和你最近听的歌相似 2 首/);
});

test('summarizePicks：没有 brief 时说「接着正在听」，heuristic 说明降级', () => {
  const { summary } = summarizePicks({
    tracks: [{ name: 'a', artists: ['x'], origin: 'fm' }],
    terms: ['雨天'],
    source: 'heuristic',
  });
  assert.match(summary, /接着你正在听的方向挑了 1 首/);
  assert.match(summary, /模型没连上/);
});
