/**
 * Scene playlists (L4): rank a candidate pool against one sentence of intent.
 *
 * The model is used only to *extract* the brief (scene/mood keywords, tempo,
 * language, target duration). Ranking, exclusion and ordering are code, so the
 * user can explain every row and the unit tests are deterministic (PLAN §6.3).
 *
 * The candidate pool is assembled by the tool layer: search hits, similar songs
 * of a seed, favourite artists' tracks and the daily recommendations. Each item
 * carries where it came from and the label to quote in the reason column.
 *
 * @module ncm-plugin/core/scene
 */

import { DAY_MS } from './models.js';
import { bpmBand, languageOf } from './tags.js';

/** Source weights — search intent beats "similar", which beats taste, which beats daily. */
export const SOURCE_WEIGHTS = Object.freeze({ search: 4, similar: 3, taste: 2, daily: 1 });

/** Same artist at most this many times per playlist, unless the pool is tiny. */
export const ARTIST_CAP = 2;

/** Tracks heard this recently are excluded from a new scene. */
export const RECENT_EXCLUDE_MS = 3 * DAY_MS;

/** Beats-to-tempo words the brief parser understands. */
const TEMPO_WORDS = Object.freeze([
  { band: 'slow', words: ['慢', '安静', '舒缓', '慵懒', '放松', '轻', '柔和', '别太吵'] },
  { band: 'mid', words: ['中速', '不吵不闹', '通勤', '路上'] },
  { band: 'fast', words: ['快', '燃', '蹦', ' energetic', '清爽'] },
]);

const LANGUAGE_WORDS = Object.freeze([
  { language: '华语', words: ['华语', '中文', '国语'] },
  { language: '英语', words: ['英文', '英语', '欧美'] },
  { language: '日语', words: ['日语', '日系', '日文'] },
  { language: '纯音乐', words: ['纯音乐', '钢琴', '器乐', '无人声'] },
]);

const DURATION_PATTERN = /(约?\s*(\d{1,3})\s*分钟)|(半小时)/;

/** Scene words recognised even when they are glued to a longer phrase ("雨天的下午"). */
export const SCENE_LEXICON = Object.freeze([
  '雨天', '深夜', '通勤', '怀旧', '加班', '周末', '清晨', '海边', '独处', '散步',
  '夏天', '冬天', '公路', '旅行', '睡前', '咖啡', '雨天', '治愈', '失恋', '聚会',
]);

/**
 * Parse the free-form brief into filters.
 *
 * @param {string} text what the user said.
 * @returns {{raw: string, keywords: string[], band: string|null, language: string|null, minutes: number|null, quiet: boolean}}
 */
export function parseBrief(text) {
  const raw = String(text ?? '').trim();
  const words = raw
    .split(/[，。,.、;；:：!！?？\s]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 8)
    .slice(0, 8);
  const lexiconHits = SCENE_LEXICON.filter((word) => raw.includes(word));
  const keywords = [...new Set([...lexiconHits, ...words])].slice(0, 8);

  let band = null;
  for (const entry of TEMPO_WORDS) {
    if (entry.words.some((word) => raw.includes(word))) {
      band = entry.band;
      break;
    }
  }

  let language = null;
  for (const entry of LANGUAGE_WORDS) {
    if (entry.words.some((word) => raw.includes(word))) {
      language = entry.language;
      break;
    }
  }

  let minutes = null;
  const match = DURATION_PATTERN.exec(raw);
  if (match) minutes = match[3] ? 30 : Number(match[2]);
  if (!minutes && /一小时|1\s*小时/.test(raw)) minutes = 60;

  return {
    raw,
    keywords,
    band,
    language,
    minutes,
    quiet: /别太吵|安静|放松|轻/.test(raw),
  };
}

/** Ids excluded from a fresh scene: liked-recently and disliked. */
export function excludedIds({ history = [], disliked = new Set(), now = Date.now(), recentMs = RECENT_EXCLUDE_MS } = {}) {
  const excluded = new Set();
  for (const entry of history) {
    if (entry?.id && entry.at >= now - recentMs) excluded.add(entry.id);
  }
  for (const id of disliked) excluded.add(Number(id));
  return excluded;
}

/** Base reason text per source, quoting the seed label when there is one. */
function reasonFor(item) {
  switch (item.source) {
    case 'search':
      return item.label ? `搜索命中「${item.label}」` : '搜索命中';
    case 'similar':
      return item.seed ? `相似于《${item.seed}》` : '相似推荐';
    case 'taste':
      return item.label ? `你常听的艺人 ${item.label}` : '根据你的口味';
    case 'daily':
      return '每日推荐';
    default:
      return '候选';
  }
}

function tagScore(track, tags, filters) {
  if (!tags) return 0;
  let score = 0;
  if (filters.language && languageOf(tags) === filters.language) score += 1;
  const band = bpmBand(tags.bpm);
  if (filters.band && band === filters.band) score += 1;
  if (filters.quiet && band === 'slow') score += 1;
  const keywordHit = filters.keywords.some((keyword) => (tags.tags ?? []).includes(keyword));
  if (keywordHit) score += 1;
  return score;
}

/**
 * Rank candidate tracks for a scene.
 *
 * @param {{
 *   brief?: string,
 *   pool?: {track: object, source?: string, label?: string, seed?: string}[],
 *   tagsById?: Record<number, object>,
 *   history?: object[],
 *   disliked?: Set<number>,
 *   now?: number,
 *   limit?: number,
 * }} input
 * @returns {object} scene draft, ready for the page or tool output.
 */
export function planScene({
  brief = '',
  pool = [],
  tagsById = {},
  history = [],
  disliked = new Set(),
  now = Date.now(),
  limit = 40,
} = {}) {
  const filters = parseBrief(brief);
  const excluded = excludedIds({ history, disliked, now });
  const artistCounts = new Map();
  const seen = new Set();
  const ranked = [];

  for (const item of pool) {
    const track = item?.track;
    if (!track?.id) continue;
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    const tags = tagsById[track.id];
    const bpm = Number(tags?.bpm) > 0 ? Number(tags.bpm) : null;
    const score = (SOURCE_WEIGHTS[item.source] ?? 1) + tagScore(track, tags, filters);
    ranked.push({
      track,
      source: item.source ?? 'unknown',
      label: item.label ?? '',
      seed: item.seed ?? '',
      bpm,
      language: tags ? languageOf(tags) : '',
      score,
      reason: reasonFor(item),
      excluded: excluded.has(track.id),
    });
  }

  const dropped = ranked.filter((item) => item.excluded);
  const kept = ranked.filter((item) => !item.excluded);

  // Best score first, then slower tracks for "quiet" briefs and faster otherwise.
  const bandRank = { slow: 0, mid: 1, fast: 2 };
  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const left = a.bpm ?? 100;
    const right = b.bpm ?? 100;
    return filters.quiet ? left - right : right - left;
  });

  const chosen = [];
  for (const item of kept) {
    if (chosen.length >= limit) break;
    const artist = item.track.artists?.[0] ?? '';
    const used = artistCounts.get(artist) ?? 0;
    if (artist && used >= ARTIST_CAP) continue;
    artistCounts.set(artist, used + 1);
    chosen.push(item);
  }

  const bySource = Object.entries(SOURCE_WEIGHTS)
    .map(([key, weight]) => ({
      key,
      weight,
      count: chosen.filter((item) => item.source === key).length,
    }))
    .filter((entry) => entry.count > 0);

  const totalMs = chosen.reduce((sum, item) => sum + Number(item.track.duration ?? 0), 0);
  const trimmed = trimToMinutes(chosen, filters.minutes);

  return {
    brief: filters.raw,
    filters,
    tracks: trimmed,
    count: trimmed.length,
    bySource: reCount(trimmed, bySource),
    estimatedMinutes: Math.round(trimmed.reduce((sum, item) => sum + Number(item.track.duration ?? 0), 0) / 60_000),
    excluded: {
      disliked: dropped.filter((item) => disliked.has(item.track.id)).length,
      recent: dropped.filter((item) => !disliked.has(item.track.id)).length,
    },
    poolSize: ranked.length,
  };
}

function reCount(tracks, bySource) {
  return bySource.map((entry) => ({ ...entry, count: tracks.filter((item) => item.source === entry.key).length }))
    .filter((entry) => entry.count > 0);
}

/** Drop tracks from the end until the playlist fits the requested duration. */
function trimToMinutes(tracks, minutes) {
  if (!minutes) return tracks;
  const budget = minutes * 60_000;
  const result = [];
  let total = 0;
  for (const item of tracks) {
    const duration = Number(item.track.duration ?? 0);
    if (total + duration > budget && result.length >= 5) break;
    result.push(item);
    total += duration;
  }
  return result;
}

/**
 * Re-order an existing scene by BPM, used by the page's "重排" button: pure code,
 * no regeneration, no model call.
 */
export function orderByTempo(tracks, { ascending = true } = {}) {
  return [...tracks].sort((a, b) => {
    const left = a.bpm ?? a.track?.bpm ?? 100;
    const right = b.bpm ?? b.track?.bpm ?? 100;
    return ascending ? left - right : right - left;
  });
}
