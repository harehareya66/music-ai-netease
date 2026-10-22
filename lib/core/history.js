/**
 * Play-history bookkeeping: append/throttle, capacity eviction, v1→v2
 * migration, and the small aggregations every view needs.
 *
 * @module ncm-plugin/core/history
 */

import { DAY_MS, HISTORY_LIMIT, isHeard, isoWeek, normalizePlay } from './models.js';

/** Same track this close to the previous entry is one play, not two. */
export const MERGE_WINDOW_MS = 60_000;

/**
 * Append a play, merging a re-record of the same track inside the window.
 *
 * @param {object[]} history newest-first array (mutated and returned).
 * @param {object} play already normalised by {@link normalizePlay}.
 * @param {{now?: number, throttleMs?: number, limit?: number, protectedIds?: Set<number>}} [options]
 * @returns {{history: object[], merged: boolean}}
 */
export function appendPlay(history, play, {
  now = Date.now(),
  throttleMs = MERGE_WINDOW_MS,
  limit = HISTORY_LIMIT,
  protectedIds = new Set(),
} = {}) {
  const list = Array.isArray(history) ? history : [];
  if (!play?.id) return { history: list, merged: false };

  const head = list[0];
  if (head && head.id === play.id && Math.abs(now - head.at) <= throttleMs) {
    head.playedMs = Math.max(head.playedMs ?? 0, play.playedMs ?? 0);
    head.at = now;
    if (play.completed) head.completed = true;
    if (play.skipped) head.skipped = true;
    if (play.feedback && play.feedback !== 'none') head.feedback = play.feedback;
    return { history: list, merged: true };
  }

  list.unshift(play);
  evictToLimit(list, limit, protectedIds);
  return { history: list, merged: false };
}

/**
 * Drop the oldest entries past `limit`, skipping protected ones.
 * The end of the array is the oldest play (newest-first order).
 */
export function evictToLimit(history, limit = HISTORY_LIMIT, protectedIds = new Set()) {
  if (!Array.isArray(history)) return history;
  for (let index = history.length - 1; index >= 0 && history.length > limit; index -= 1) {
    if (protectedIds.has(history[index].id)) continue;
    history.splice(index, 1);
  }
  return history;
}

/**
 * Upgrade a v1 session document in place-free fashion.
 *
 * v1 history entries only carried `{id, name, artists, at, tentative?,
 * skipped?}`. v2 adds the playback facts and the profile/report caches; the
 * account, queue, settings and feedback blocks are preserved untouched so a
 * downgrade still reads the file (as v1 ignoring the extra keys).
 *
 * @param {object} state parsed session.json
 * @returns {{state: object, migrated: boolean, from: number}}
 */
export function migrateSession(state) {
  const base = state && typeof state === 'object' ? state : {};
  const from = Number(base.version) || 1;
  const history = (Array.isArray(base.history) ? base.history : [])
    .map((entry) => normalizePlay(entry))
    .filter(Boolean);
  const next = {
    ...base,
    version: 2,
    history,
    profile: base.profile ?? { version: 1, generatedAt: 0, ranges: {} },
    reports: base.reports ?? {},
  };
  return { state: next, migrated: from < 2, from };
}

/** Plays inside a half-open `[since, until)` window, newest first. */
export function playsWithin(history, { since = -Infinity, until = Infinity } = {}) {
  return (Array.isArray(history) ? history : []).filter(
    (entry) => entry.at >= since && entry.at < until,
  );
}

/** group plays by ISO week key, preserving newest-first order inside a bucket. */
export function bucketByWeek(history) {
  const buckets = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    const key = isoWeek(entry.at).key;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  return buckets;
}

/** Track id → the earliest play timestamp in the whole history. */
export function firstSeenMap(history) {
  const seen = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    const previous = seen.get(entry.id);
    if (previous === undefined || entry.at < previous) seen.set(entry.id, entry.at);
  }
  return seen;
}

/** Track id → heard-through play count. */
export function playCounts(history, { heardOnly = true } = {}) {
  const counts = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    if (heardOnly && !isHeard(entry)) continue;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Most-played tracks with their entries.
 * @returns {{track: object, plays: number}[]}
 */
export function topTracks(history, limit = 7) {
  const counts = playCounts(history);
  const byId = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id, plays]) => ({ track: byId.get(id), plays }));
}

/** Unique heard track count, used by the new/repeat rate split. */
export function uniqueTrackCount(history) {
  const ids = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    if (isHeard(entry)) ids.add(entry.id);
  }
  return ids.size;
}

/** Newest-first track ids, for repeat avoidance. */
export function recentIds(history, limit = 50) {
  return (Array.isArray(history) ? history : []).slice(0, limit).map((entry) => entry.id);
}

/** Plays recorded over the last `days` days (rolling window, not calendar weeks). */
export function recentPlays(history, { days = 28, now = Date.now() } = {}) {
  return playsWithin(history, { since: now - days * DAY_MS, until: now + 1 });
}
