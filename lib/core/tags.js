/**
 * Song-tag extraction and the on-disk tag cache.
 *
 * Tags come from NetEase's music wiki (`parseSongWiki` in L1): genres, biz
 * tags, language and BPM. The cache keeps them keyed by track id so the taste
 * profile and the weekly report can be computed entirely offline.
 *
 * @module ncm-plugin/core/tags
 */

import { DAY_MS } from './models.js';

/** Cache entries older than this are refreshed on the next build. */
export const TAG_TTL_MS = 30 * DAY_MS;

/** Cache growth ceiling; the oldest entries go first. */
export const TAG_CACHE_LIMIT = 3000;

/** BPM bands used by the profile and by scene ordering. */
export const BPM_BANDS = Object.freeze([
  { key: 'slow', label: '慢速', max: 85 },
  { key: 'mid', label: '中速', max: 105 },
  { key: 'fast', label: '快速', max: Infinity },
]);

/** Bucket one BPM value, or null when the wiki had none. */
export function bpmBand(bpm) {
  const value = Number(bpm);
  if (!Number.isFinite(value) || value <= 0) return null;
  return BPM_BANDS.find((band) => value < band.max)?.key ?? 'fast';
}

/** Label for a band key, used by the profile sentence. */
export function bpmBandLabel(key) {
  return BPM_BANDS.find((band) => band.key === key)?.label ?? '未标注';
}

/**
 * Canonical language labels. NetEase's wiki says 国语 where every page and the
 * profile sentence say 华语; keeping both would split one bucket in two.
 */
const LANGUAGE_ALIASES = new Map([
  ['国语', '华语'],
  ['普通话', '华语'],
  ['中文', '华语'],
  ['mandarin', '华语'],
  ['粤语', '粤语'],
  ['英语', '英语'],
  ['日语', '日语'],
  ['韩语', '韩语'],
]);

/** Normalise a wiki language string to the label the pages show. */
export function normalizeLanguage(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return LANGUAGE_ALIASES.get(text.toLowerCase()) ?? LANGUAGE_ALIASES.get(text) ?? text;
}

/**
 * Normalise the facts `parseSongWiki` returned into a cache record. Tolerant of
 * missing fields because not every song has a wiki page.
 */
export function extractTags(wiki = {}) {
  const genres = (wiki.genres ?? []).map(String).filter(Boolean).slice(0, 6);
  const tags = (wiki.tags ?? []).map(String).filter(Boolean).slice(0, 12);
  return {
    genres,
    tags,
    language: normalizeLanguage(wiki.language),
    bpm: Number(wiki.bpm) > 0 ? Number(wiki.bpm) : null,
    year: Number(wiki.year) > 0 ? Number(wiki.year) : null,
  };
}

/**
 * Merge one wiki lookup into the cache.
 * @param {Record<string, object>} cache
 * @param {number} id
 * @param {object} wiki facts from `parseSongWiki`, optionally with `year`.
 * @param {{now?: number}} [options]
 */
export function putTags(cache, id, wiki, { now = Date.now() } = {}) {
  const store = cache && typeof cache === 'object' ? cache : {};
  const trackId = Number(id);
  if (!Number.isFinite(trackId)) return store;
  store[trackId] = { ...extractTags(wiki), at: now };
  trimCache(store);
  return store;
}

/** Drop entries older than the TTL, then the oldest beyond the ceiling. */
export function trimCache(cache, { now = Date.now(), ttlMs = TAG_TTL_MS, limit = TAG_CACHE_LIMIT } = {}) {
  const entries = Object.entries(cache);
  for (const [id, record] of entries) {
    if (now - Number(record?.at ?? 0) > ttlMs) delete cache[id];
  }
  const remaining = Object.entries(cache).sort((a, b) => Number(a[1]?.at ?? 0) - Number(b[1]?.at ?? 0));
  for (const [id] of remaining.slice(0, Math.max(remaining.length - limit, 0))) delete cache[id];
  return cache;
}

/** One track's cached tags, or null. */
export function tagsOf(cache, id) {
  return cache?.[Number(id)] ?? null;
}

/** Ids the cache cannot answer for, newest-first order preserved. */
export function missingTagIds(history, cache, limit = 40) {
  const missing = [];
  const seen = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (!cache?.[entry.id]) missing.push(entry.id);
    if (missing.length >= limit) break;
  }
  return missing;
}

/** Language label from cached tags, `未标注` when the wiki never said. */
export function languageOf(tags) {
  const value = normalizeLanguage(tags?.language);
  return value || '未标注';
}

/** Decade label from cached tags (`2010s`), null when unknown. */
export function eraOf(tags) {
  const year = Number(tags?.year);
  return Number.isFinite(year) && year > 1900 ? `${Math.floor(year / 10) * 10}s` : null;
}
