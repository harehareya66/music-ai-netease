import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acrosticReport,
  bigrams,
  extractHeads,
  normalizeForCompare,
  overlapStats,
} from '../lib/core/lyric.js';
import {
  MIN_OVERLAP,
  acrosticTarget,
  buildAnalysisPrompt,
  buildRemixPrompt,
} from '../lib/features.js';

test('normalizeForCompare 去掉标点空白，bigrams 按相邻两字切', () => {
  assert.equal(normalizeForCompare('零零散散，凑齐了！'), '零零散散凑齐了');
  assert.deepEqual([...bigrams('零零散')], ['零零', '零散']);
  assert.deepEqual([...bigrams('零')], []);
});

test('overlapStats：改写保留原词能被量化，另起炉灶会很低', () => {
  const source = '零零散散凑齐了阵营\n固执美丽的意义';
  const kept = overlapStats(source, '零零散散凑齐了阵营\n固执美的意义还在');
  assert.ok(kept.overlap > 0.5, `kept=${kept.overlap}`);
  assert.ok(kept.shared >= 8);
  const strayed = overlapStats(source, '月光落在旧站台\n风把你的名字吹散');
  assert.ok(strayed.overlap < MIN_OVERLAP, `strayed=${strayed.overlap}`);
});

test('extractHeads：跳过空行与标点，按行取首字', () => {
  const heads = extractHeads([
    { text: '，零零散散' },
    { text: '' },
    { text: '固执美丽' },
    { text: '  ，  ' },
  ]);
  assert.deepEqual(heads, ['零', '', '固', '']);
});

test('acrosticReport：对上为 ok，错位能指出第几行', () => {
  const good = acrosticReport('零散的行\n固执的词', ['零', '固']);
  assert.equal(good.ok, true);
  assert.deepEqual(good.mismatches, []);

  const bad = acrosticReport('（先说明\n零散的行', ['零', '固']);
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches.length, 2);
  assert.equal(bad.mismatches[0].expected, '零');
  assert.equal(bad.mismatches[0].got, '（');
});

test('acrosticReport：行数不足也算没对上', () => {
  const short = acrosticReport('零散的行', ['零', '固']);
  assert.equal(short.ok, false);
  assert.equal(short.lines, 1);
});

test('acrosticTarget：选中行首字优先，其次手写，都没有则抛 BAD_ARGS', () => {
  const lines = [
    { text: '零零散散凑齐了阵营' },
    { text: '固执美丽的意义' },
  ];
  assert.equal(acrosticTarget('', '', lines), '零固');
  assert.equal(acrosticTarget(['秋', '日'], '秋日私语', lines), '秋日');
  assert.throws(() => acrosticTarget([], '', []), (error) => error.code === 'BAD_ARGS');
});

test('buildAnalysisPrompt 带歌名与整首背景', () => {
  const prompt = buildAnalysisPrompt({
    track: { name: '虚拟', artists: ['陈粒'] },
    fullText: '第一行\n第二行\n第三行',
    selectedText: '第二行',
  });
  assert.match(prompt, /虚拟/);
  assert.match(prompt, /陈粒/);
  assert.match(prompt, /先只读、不改写/);
  assert.match(prompt, /情绪：/);
});

test('buildRemixPrompt 带行数硬约束、藏头目标与重试提示', () => {
  const prompt = buildRemixPrompt({
    mode: '藏头',
    track: { name: '虚拟', artists: ['陈粒'] },
    selectedText: '零散的行\n固执的词',
    fullText: '零散的行\n固执的词\n第三行',
    lineCount: 2,
    analysis: '情绪：克制',
    targetChars: '零固',
    extra: '上一版第 1 行不是「零」开头',
  });
  assert.match(prompt, /输出 2 行左右/);
  assert.match(prompt, /零固/);
  assert.match(prompt, /上一版第 1 行不是「零」开头/);
  assert.match(prompt, /情绪：克制/);
});

test('buildRemixPrompt 翻译模式要求英文输出', () => {
  const prompt = buildRemixPrompt({
    mode: '翻译',
    track: { name: '虚拟' },
    selectedText: '第一行',
    fullText: '第一行',
    lineCount: 1,
  });
  assert.match(prompt, /英文/);
});

test('buildRemixPrompt: 用户要求与重试修正分开注入', () => {
  const base = {
    mode: '改诗',
    track: { name: '虚拟', artists: ['陈粒'] },
    selectedText: '固执押韵的排比',
    fullText: '固执押韵的排比',
    lineCount: 1,
  };
  const withReq = buildRemixPrompt({ ...base, extra: '更口语化，保留「固执」' });
  assert.match(withReq, /【用户这次的要求，务必满足】更口语化，保留「固执」/);
  assert.doesNotMatch(withReq, /【上一版的问题/);

  const withFix = buildRemixPrompt({ ...base, fix: '重试：多用原词' });
  assert.match(withFix, /【上一版的问题，务必修正】重试：多用原词/);
  assert.doesNotMatch(withFix, /【用户这次的要求/);

  const both = buildRemixPrompt({ ...base, extra: '更短', fix: '重合度太低' });
  assert.match(both, /【用户这次的要求，务必满足】更短/);
  assert.match(both, /【上一版的问题，务必修正】重合度太低/);
});
