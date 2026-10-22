/**
 * Core data shapes and calendar helpers shared by the data (L3) and decision
 * (L4) layers.
 *
 * Pure by contract: no `ctx`, no `fs`, no `fetch` (PLAN §3.1). Pure also means
 * no `Date.now()` at module scope — callers pass `now` when it matters.
 *
 * @module ncm-plugin/core/models
 */

/** Current on-disk session schema. v1 was the upstream 300-entry shape. */
export const SESSION_VERSION = 2;

/** Play-history ceiling for v2 (PLAN §5.3). */
export const HISTORY_LIMIT = 2000;

/** Where a play came from, so scene/DJ batches stay attributable. */
export const PLAY_SOURCES = Object.freeze(['search', 'scene', 'dj', 'library', 'manual', 'agent', 'unknown']);

/** One track's taste level; `none` is "never rated", not a fourth signal. */
export const FEEDBACK_LEVELS = Object.freeze(['liked', 'disliked', 'none']);

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

/** Artist entries arrive as plain strings or `{name}` objects. */
export function artistNames(artists) {
  if (!Array.isArray(artists)) return [];
  return artists
    .map((artist) => (typeof artist === 'string' ? artist : artist?.name))
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
}

/**
 * Coerce one stored/API track into the v2 play shape.
 *
 * Tolerant by design: history written by v1, by the API (`normalizeTrack`), and
 * by the browser all flow through here, so every field has a documented
 * fallback instead of letting `undefined` reach the statistics.
 *
 * @param {object} raw
 * @param {{now?: number}} [options]
 * @returns {object|null} null when the entry has no id.
 */
export function normalizePlay(raw, { now = Date.now() } = {}) {
  if (!raw || raw.id === undefined || raw.id === null) return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  const duration = Math.max(Number(raw.duration ?? raw.durationMs ?? 0) || 0, 0);
  const playedMs = Math.max(Number(raw.playedMs ?? 0) || 0, 0);
  const at = Number(raw.at);
  const album = typeof raw.album === 'string' ? raw.album : (raw.album?.name ?? '');
  return {
    id,
    name: String(raw.name ?? ''),
    artists: artistNames(raw.artists),
    album: String(album ?? ''),
    duration,
    at: Number.isFinite(at) ? at : now,
    playedMs,
    completed: Boolean(raw.completed ?? (duration > 0 && playedMs >= duration * 0.9)),
    skipped: Boolean(raw.skipped),
    source: PLAY_SOURCES.includes(raw.source) ? raw.source : 'unknown',
    reason: raw.reason ? String(raw.reason) : '',
    feedback: FEEDBACK_LEVELS.includes(raw.feedback) ? raw.feedback : 'none',
  };
}

/**
 * Whether a play is evidence of taste. Tentative plays are DJ picks that have
 * not been heard through yet; skipped ones are the opposite of taste.
 */
export function isHeard(entry) {
  return Boolean(entry) && !entry.skipped && !entry.tentative;
}

/** Local midnight for a timestamp. */
export function startOfDay(ts = Date.now()) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday=0 … Sunday=6, matching the report's daily buckets. */
export function weekdayIndex(ts = Date.now()) {
  return (new Date(ts).getDay() + 6) % 7;
}

/**
 * ISO-8601 week for a timestamp, in local time.
 *
 * Weeks start Monday; week 1 is the week containing the first Thursday. The
 * report cache is keyed `2026-W42`, so this must agree with {@link isoWeekRange}.
 *
 * @returns {{year: number, week: number, key: string, start: number}}
 */
export function isoWeek(ts = Date.now()) {
  const monday = startOfDay(ts) - weekdayIndex(ts) * DAY_MS;
  const thursday = monday + 3 * DAY_MS;
  const year = new Date(thursday).getFullYear();
  const jan1 = new Date(year, 0, 1);
  const jan1Day = weekdayIndex(jan1.getTime());
  const firstMonday = startOfDay(jan1.getTime()) - jan1Day * DAY_MS;
  const week = Math.floor((monday - firstMonday) / (7 * DAY_MS)) + 1;
  return { year, week, key: `${year}-W${String(week).padStart(2, '0')}`, start: monday };
}

/**
 * Half-open `[start, end)` window for an ISO week key.
 * @param {string} key e.g. `2026-W42`
 * @returns {{key: string, start: number, end: number}|null}
 */
export function isoWeekRange(key) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(String(key ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const jan1 = new Date(year, 0, 1);
  const firstMonday = startOfDay(jan1.getTime()) - weekdayIndex(jan1.getTime()) * DAY_MS;
  const start = firstMonday + (week - 1) * 7 * DAY_MS;
  return { key: `${year}-W${String(week).padStart(2, '0')}`, start, end: start + 7 * DAY_MS };
}

/** `MM月DD日` — the label the report and screenshots use. */
export function formatDay(ts) {
  const date = new Date(ts);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Whole-day distance between two timestamps (calendar days, not 24h spans). */
export function dayDistance(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}
