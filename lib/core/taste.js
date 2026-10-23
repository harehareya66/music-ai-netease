/**
 * Taste profile (L3): aggregate plays + cached tags into a structured profile
 * with a deterministic Chinese summary.
 *
 * The summary is template-based on purpose — the same data must render the same
 * sentence on the page, in the weekly report and in the tool output, and it
 * must work with no model call at all (PLAN §8: core is testable without DSH).
 *
 * @module ncm-plugin/core/taste
 */

import { DAY_MS, isHeard } from './models.js';
import { playsWithin, topTracks } from './history.js';
import { BPM_BANDS, bpmBand, languageOf } from './tags.js';

/** Rolling ranges offered by the profile window switcher. */
export const RANGE_DAYS = Object.freeze({ '4w': 28, '6m': 182, all: Infinity });

/** Hours counted as "late night" for the summary sentence. */
const NIGHT_HOURS = new Set([22, 23, 0, 1]);

const BPM_WORD = { slow: '偏慢速', mid: '偏中速', fast: '偏快速' };
const LANGUAGE_WORD = { 华语: '偏华语', 英语: '偏英文', 日语: '偏日系' };

/** Plays inside the selected window, newest first. */
export function selectRange(history, { range = '4w', now = Date.now() } = {}) {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS['4w'];
  const since = Number.isFinite(days) ? now - days * DAY_MS : -Infinity;
  return playsWithin(history, { since, until: now + 1 });
}

/** Percentage of a part over a whole, one decimal; 0 when the whole is 0. */
export function share(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Sorted `[{key, label, count, pct}]` from a count map. */
function distribution(counts, labels = {}) {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, label: labels[key] ?? key, count, pct: share(count, total) }));
}

/** Core aggregate shared by the profile, its deltas and the weekly report. */
export function aggregate(plays, tagsById = {}) {
  const heard = plays.filter(isHeard);
  const languages = new Map();
  const eras = new Map();
  const bands = new Map();
  const tags = new Map();
  const artists = new Map();
  const trackPlays = new Map();
  let playedMs = 0;
  let bpmSum = 0;
  let bpmCount = 0;
  let nightPlays = 0;

  for (const entry of plays) {
    playedMs += Number(entry.playedMs ?? 0);
    if (!isHeard(entry)) continue;
    trackPlays.set(entry.id, (trackPlays.get(entry.id) ?? 0) + 1);
    for (const name of entry.artists ?? []) artists.set(name, (artists.get(name) ?? 0) + 1);
    if (NIGHT_HOURS.has(new Date(entry.at).getHours())) nightPlays += 1;

    const record = tagsById[entry.id];
    if (!record) continue;
    const language = languageOf(record);
    languages.set(language, (languages.get(language) ?? 0) + 1);
    const year = Number(record.year);
    if (Number.isFinite(year) && year > 1900) {
      const era = `${Math.floor(year / 10) * 10}s`;
      eras.set(era, (eras.get(era) ?? 0) + 1);
    }
    const band = bpmBand(record.bpm);
    if (band) bands.set(band, (bands.get(band) ?? 0) + 1);
    if (Number(record.bpm) > 0) {
      bpmSum += Number(record.bpm);
      bpmCount += 1;
    }
    for (const tag of [...(record.genres ?? []), ...(record.tags ?? [])]) {
      tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
  }

  const playsCount = heard.length;
  const unique = trackPlays.size;
  const repeats = [...trackPlays.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
  return {
    plays: playsCount,
    unique,
    repeats,
    trackPlays,
    repeatRate: share(repeats, Math.max(playsCount, 1)),
    hours: Math.round((playedMs / 3_600_000) * 10) / 10,
    nightShare: Math.round((nightPlays / Math.max(playsCount, 1)) * 100) / 100,
    languages: distribution(languages),
    eras: distribution(eras),
    bands: BPM_BANDS.filter((band) => bands.has(band.key)).map((band) => ({
      key: band.key,
      label: band.label,
      count: bands.get(band.key),
      pct: share(bands.get(band.key), Math.max(playsCount, 1)),
    })),
    tags: distribution(tags),
    artists: [...artists.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    avgBpm: bpmCount ? Math.round(bpmSum / bpmCount) : null,
  };
}

/**
 * Aggregate plays that arrive **already counted**, as the account's listening
 * record does: `[{ track, plays }]` where `plays` is the account's lifetime
 * play count. Local history carries one row per play, so it goes through
 * {@link aggregate} instead; this variant keeps the two sources from being
 * silently mixed (FLOWS: 数据范围永远写清).
 *
 * @param {{track: object, plays: number}[]} items
 * @param {object} tagsById
 */
export function aggregateCounted(items, tagsById = {}) {
  const languages = new Map();
  const eras = new Map();
  const bands = new Map();
  const tags = new Map();
  const artists = new Map();
  const trackPlays = new Map();
  let total = 0;
  let bpmSum = 0;
  let bpmWeight = 0;

  const bump = (map, key, weight) => map.set(key, (map.get(key) ?? 0) + weight);

  for (const item of items) {
    const track = item?.track;
    const weight = Number(item?.plays);
    if (!track?.id || !(weight > 0)) continue;
    total += weight;
    bump(trackPlays, track.id, weight);
    for (const name of track.artists ?? []) bump(artists, name, weight);

    const record = tagsById[track.id];
    if (!record) continue;
    bump(languages, languageOf(record), weight);
    const year = Number(record.year);
    if (Number.isFinite(year) && year > 1900) bump(eras, `${Math.floor(year / 10) * 10}s`, weight);
    const band = bpmBand(record.bpm);
    if (band) bump(bands, band, weight);
    const bpm = Number(record.bpm);
    if (bpm > 0) {
      bpmSum += bpm * weight;
      bpmWeight += weight;
    }
    for (const tag of [...(record.genres ?? []), ...(record.tags ?? [])]) bump(tags, tag, weight);
  }

  const repeats = [...trackPlays.values()].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
  return {
    plays: total,
    unique: trackPlays.size,
    repeats,
    trackPlays,
    repeatRate: share(repeats, Math.max(total, 1)),
    /** The account record has no timestamps, so time-derived numbers stay null. */
    hours: null,
    nightShare: null,
    languages: distribution(languages),
    eras: distribution(eras),
    bands: BPM_BANDS.filter((band) => bands.has(band.key)).map((band) => ({
      key: band.key,
      label: band.label,
      count: bands.get(band.key),
      pct: share(bands.get(band.key), Math.max(total, 1)),
    })),
    tags: distribution(tags),
    artists: [...artists.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    avgBpm: bpmWeight ? Math.round(bpmSum / bpmWeight) : null,
    weighted: true,
  };
}

/**
 * The account-record counterpart of {@link describe}; deterministic, and it
 * says out loud that the numbers are lifetime counts.
 */
export function describeCounted(agg) {
  if (!agg.plays) return '账号里还没有听歌记录，先在网易云听几首再来看看。';
  const band = agg.bands[0]?.key;
  const language = agg.languages[0]?.key;
  const bpmWord = BPM_WORD[band] ?? '口味不明';
  const languageWord = LANGUAGE_WORD[language] ?? (language && language !== '未标注' ? `偏${language}` : '口味很杂');
  const top = agg.artists[0]?.name;
  const who = top ? `，最常听 ${top}` : '';
  return `账号累计 ${agg.plays} 次播放、${agg.unique} 首，${bpmWord}、${languageWord}${who}。`;
}

/**
 * Profile built from the account's listening record.
 *
 * `newRate` needs first-seen timestamps the record does not have, so it stays
 * `null`; the page prints a dash instead of inventing one.
 */
export function buildAccountProfile({ items = [], tagsById = {}, now = Date.now() } = {}) {
  const agg = aggregateCounted(items, tagsById);
  const ranked = [...items]
    .filter((item) => item?.track?.id && item?.plays > 0)
    .sort((a, b) => b.plays - a.plays);
  return {
    version: 1,
    generatedAt: now,
    range: 'all',
    source: 'account',
    summary: describeCounted(agg),
    tags: agg.tags.slice(0, 8).map(({ label, count }) => ({ label, count })),
    buckets: { language: agg.languages, era: agg.eras, bpm: agg.bands },
    topArtists: agg.artists,
    topTracks: ranked.slice(0, 10).map(({ track, plays }) => ({ track, plays })),
    metrics: {
      hours: null,
      plays: agg.plays,
      tracks: agg.unique,
      newRate: null,
      // `repeats / plays` only means something for one-row-per-play history;
      // lifetime play counts would always read ~99%, so it stays unknown.
      repeatRate: null,
      avgBpm: agg.avgBpm,
    },
    deltas: null,
  };
}

/**
 * One deterministic sentence describing who the listener is.
 * @param {object} agg result of {@link aggregate}
 * @param {{newRate?: number}} [extra]
 */
export function describe(agg, { newRate = null } = {}) {
  if (!agg.plays) return '还没有足够的数据，多听几天再来看看。';
  const band = agg.bands[0]?.key;
  const language = agg.languages[0]?.key;
  const bpmWord = BPM_WORD[band] ?? '口味不明';
  const languageWord = LANGUAGE_WORD[language] ?? (language && language !== '未标注' ? `偏${language}` : '口味很杂');
  const nightWord = agg.nightShare >= 0.35 ? '、爱在深夜听歌' : '';
  const newSentence = newRate === null
    ? '还没分清新歌和老歌'
    : newRate >= 25
      ? `最近新歌吃得不少，新歌率 ${newRate}%`
      : `你听得挺稳，新歌率只有 ${newRate}%`;
  const tail = agg.repeatRate >= 20 ? '，但单曲循环的瘾还没戒' : '';
  return `你是个${bpmWord}、${languageWord}${nightWord}的人；${newSentence}${tail}。`;
}

/**
 * Build the full profile document.
 *
 * `firstSeen` maps track id → first play timestamp from the whole history; it is
 * what separates a genuinely new song from a repeat inside the window.
 *
 * @param {{plays?: object[], previousPlays?: object[], tagsById?: object, firstSeen?: Map<number, number>, now?: number, range?: string, since?: number}} input
 * @returns {object} profile shape cached under `profile.ranges[range]`.
 */
export function buildProfile({
  plays = [],
  previousPlays = [],
  tagsById = {},
  firstSeen = new Map(),
  now = Date.now(),
  range = '4w',
  since,
} = {}) {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS['4w'];
  const sinceTs = Number.isFinite(since) ? since : (Number.isFinite(days) ? now - days * DAY_MS : -Infinity);
  const current = aggregate(plays, tagsById);
  const previous = aggregate(previousPlays, tagsById);

  let newTracks = 0;
  for (const id of current.trackPlays.keys()) {
    if ((firstSeen.get(id) ?? 0) >= sinceTs) newTracks += 1;
  }
  const newRate = share(newTracks, Math.max(current.unique, 1));
  const windowMs = Number.isFinite(days) ? days * DAY_MS : Infinity;
  const previousNew = previous.plays
    ? share(
      [...previous.trackPlays.keys()].filter((id) => {
        const first = firstSeen.get(id);
        return first !== undefined && first >= sinceTs - windowMs && first < sinceTs;
      }).length,
      Math.max(previous.unique, 1),
    )
    : null;

  return {
    version: 1,
    generatedAt: now,
    range,
    summary: describe(current, { newRate }),
    tags: current.tags.slice(0, 8).map(({ label, count }) => ({ label, count })),
    buckets: { language: current.languages, era: current.eras, bpm: current.bands },
    topArtists: current.artists,
    topTracks: topTracks(plays, 10).map(({ track, plays: count }) => ({ track, plays: count })),
    metrics: {
      hours: current.hours,
      plays: current.plays,
      tracks: current.unique,
      newRate,
      repeatRate: current.repeatRate,
      avgBpm: current.avgBpm,
    },
    deltas: previous.plays
      ? {
        newRate: Math.round((newRate - previousNew) * 10) / 10,
        repeatRate: Math.round((current.repeatRate - previous.repeatRate) * 10) / 10,
        avgBpm: current.avgBpm && previous.avgBpm ? current.avgBpm - previous.avgBpm : null,
      }
      : null,
  };
}
