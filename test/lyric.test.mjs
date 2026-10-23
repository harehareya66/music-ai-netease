import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dropCredits,
  isCreditLine,
  lineAt,
  lyricText,
  parseLrc,
  parseLyrics,
  parseYrc,
  splitForRemix,
  validateRemix,
} from '../lib/core/lyric.js';

test('parseLrc converts [mm:ss.xx] to millisecond lines', () => {
  const { lines, wordLevel } = parseLrc('[ti:夜航西飞]\n[00:12.00]我听见风 从西边来\n[00:18.50]吹过你 没说出口的那句\n');
  assert.equal(wordLevel, false);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].t, 12_000);
  assert.equal(lines[1].t, 18_500);
  assert.equal(lines[0].end, 18_500);
  assert.equal(lines[0].text, '我听见风 从西边来');
});

test('parseYrc keeps word timings', () => {
  const yrc = '[18000,3200](18000,240,0)吹过(18240,220,0)你\n{ "t": 0 }\n';
  const parsed = parseYrc(yrc);
  assert.equal(parsed.wordLevel, true);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].text, '吹过你');
  assert.deepEqual(parsed.lines[0].words.map((word) => word.text), ['吹过', '你']);
  assert.equal(parsed.lines[0].words[0].t, 18_000);
});

test('parseLyrics picks the parser from the payload', () => {
  assert.equal(parseLyrics({ lrc: '[00:01.00]hi' }).format, 'lrc');
  assert.equal(parseLyrics({ yrc: '[1000,500](1000,200,0)hi' }).format, 'yrc');
});

test('splitForRemix selects a range and skips empty lines', () => {
  const parsed = parseLrc('[00:01.00]一\n[00:02.00]二\n[00:03.00]\n[00:04.00]四\n');
  const all = splitForRemix(parsed);
  assert.equal(all.count, 3);
  assert.equal(all.text, '一\n二\n四');
  const selected = splitForRemix(parsed, { range: 'selection', from: 1, to: 2 });
  assert.equal(selected.text, '二');
  assert.equal(lyricText(parsed.lines), '一\n二\n四');
});

test('validateRemix rejects empty, non-Chinese and runaway answers', () => {
  assert.equal(validateRemix('风从西边来的时候，').ok, true);
  assert.equal(validateRemix('').issues.includes('empty'), true);
  assert.equal(validateRemix('hello world').issues.includes('not-chinese'), true);
  assert.equal(validateRemix('字'.repeat(50), { maxChars: 10 }).issues.includes('too-long'), true);
});

test('lineAt finds the active line for a playback position', () => {
  const { lines } = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c\n');
  assert.equal(lineAt(lines, 5_000), -1);
  assert.equal(lineAt(lines, 15_000), 0);
  assert.equal(lineAt(lines, 30_000), 2);
});

test('credit rows are recognised and dropped, timings stay usable', () => {
  assert.equal(isCreditLine('作词 : 陈粒'), true);
  assert.equal(isCreditLine('《夜航西飞》'), false);
  const parsed = parseLrc('[00:00.00]作词 : 陈粒\n[00:01.00]作曲 : 陈粒\n[00:12.00]我听见风从西边来\n[00:20.00]吹过你\n');
  const lyrics = dropCredits(parsed);
  assert.deepEqual(lyrics.lines.map((line) => line.text), ['我听见风从西边来', '吹过你']);
  assert.equal(lyrics.lines[0].duration, 8_000);
  assert.equal(lyrics.wordLevel, false);
  // The original object is untouched: the page may still want the full payload.
  assert.equal(parsed.lines.length, 4);
});

test('splitForRemix takes an arbitrary set of line indexes (multi-select)', () => {
  const { lines } = parseLrc('[00:01.00]一\n[00:02.00]二\n[00:03.00]三\n[00:04.00]四\n');
  const parsed = { lines, wordLevel: false, format: 'lrc' };
  const picked = splitForRemix(parsed, { range: 'selection', indexes: [3, 0, 3, 99] });
  assert.equal(picked.text, '一\n四');
  assert.deepEqual(picked.indexes, [0, 3]);
  assert.equal(picked.count, 2);
  // 没有 indexes 时仍然走时间区间，兼容旧调用
  const ranged = splitForRemix(parsed, { range: 'selection', from: 0, to: 0 });
  assert.equal(ranged.text, '一');
});

test('validateRemix can accept non-Chinese output for translation mode', () => {
  assert.equal(validateRemix('The wind comes from the west').issues.includes('not-chinese'), true);
  assert.equal(validateRemix('The wind comes from the west', { requireChinese: false }).ok, true);
});
