import assert from 'node:assert/strict';
import test from 'node:test';

import { bpmBand, bpmBandLabel, extractTags, languageOf, normalizeLanguage, putTags } from '../lib/core/tags.js';

test('normalizeLanguage folds NetEase wiki wording into the page labels', () => {
  assert.equal(normalizeLanguage('国语'), '华语');
  assert.equal(normalizeLanguage('普通话'), '华语');
  assert.equal(normalizeLanguage('Mandarin'), '华语');
  assert.equal(normalizeLanguage('粤语'), '粤语');
  assert.equal(normalizeLanguage('日语'), '日语');
  assert.equal(normalizeLanguage(''), '');
  assert.equal(normalizeLanguage(undefined), '');
});

test('extractTags normalises language and keeps genres/tags/bpm', () => {
  const tags = extractTags({ genres: ['民谣', ''], tags: ['深夜'], language: '国语', bpm: '96', year: 2010 });
  assert.deepEqual(tags.genres, ['民谣']);
  assert.deepEqual(tags.tags, ['深夜']);
  assert.equal(tags.language, '华语');
  assert.equal(tags.bpm, 96);
  assert.equal(tags.year, 2010);
  assert.equal(extractTags({ bpm: 0 }).bpm, null);
});

test('putTags caches normalised facts with a timestamp', () => {
  const cache = {};
  const now = Date.now();
  putTags(cache, '42', { language: '国语', bpm: 100 }, { now });
  assert.equal(cache[42].language, '华语');
  assert.equal(cache[42].at, now);
  assert.equal(languageOf(cache[42]), '华语');
  assert.equal(languageOf(undefined), '未标注');
});

test('bpmBand splits slow / mid / fast at 85 and 105', () => {
  assert.equal(bpmBand(70), 'slow');
  assert.equal(bpmBand(84.9), 'slow');
  assert.equal(bpmBand(85), 'mid');
  assert.equal(bpmBand(104), 'mid');
  assert.equal(bpmBand(105), 'fast');
  // 没 BPM 就是没分区，不能默认算成慢速（会让画像凭空偏慢）。
  assert.equal(bpmBand(null), null);
  assert.equal(bpmBandLabel('mid'), '中速');
  assert.equal(bpmBandLabel('unknown'), '未标注');
});
