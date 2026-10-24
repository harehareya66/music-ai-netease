/**
 * Weekly report (L3): aggregate one ISO week of plays into the numbers and the
 * narrative blocks the report page renders.
 *
 * The narrative ("你在周三凌晨 1 点听了 23 遍…") is computed, not generated:
 * the page must show the same report for the same data, and the tool output
 * must agree with the page.
 *
 * @module ncm-plugin/core/report
 */

import { formatDay, isHeard, isoWeek, isoWeekRange, weekdayIndex } from './models.js';
import { playsWithin, topTracks, uniqueTrackCount } from './history.js';

/** How many tracks the "most loved" list shows (screenshot keeps 7 rows). */
export const REPORT_TRACK_LIMIT = 7;

const WEEKDAY_LABELS = Object.freeze(['一', '二', '三', '四', '五', '六', '日']);
const WEEKDAY_WORDS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** ISO week key for `now`. */
export function reportWeekKey(now = Date.now()) {
  return isoWeek(now).key;
}

/** `10月14日 — 10月20日` */
export function weekLabel(week) {
  return `${formatDay(week.start)} — ${formatDay(week.end - 1)}`;
}

function percentage(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Minute totals for Monday..Sunday inside the window. */
function dailyMinutes(plays) {
  const minutes = new Array(7).fill(0);
  for (const entry of plays) {
    minutes[weekdayIndex(entry.at)] += Number(entry.playedMs ?? 0) / MINUTE_MS;
  }
  return minutes.map((value, index) => ({
    weekday: index,
    label: WEEKDAY_LABELS[index],
    minutes: Math.round(value),
  }));
}

/** Hour-of-day histogram, used for the "听歌集中在…" sentence. */
function hourHistogram(plays) {
  const hours = new Array(24).fill(0);
  for (const entry of plays) {
    if (!isHeard(entry)) continue;
    hours[new Date(entry.at).getHours()] += 1;
  }
  return hours;
}

/**
 * The window (and busiest stretch) the week's listening sits in.
 * @returns {{label: string, peakHour: number}|null}
 */
function listeningWindow(hours) {
  const total = hours.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  let bestStart = 0;
  let bestSum = -1;
  for (let start = 0; start < 24; start += 1) {
    const sum = hours[start] + hours[(start + 1) % 24] + hours[(start + 2) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  const startLabel = bestStart === 22 ? '晚上十点' : bestStart === 21 ? '晚上九点' : bestStart === 23 ? '深夜十一点' : `${bestStart} 点`;
  return { label: `${startLabel}到凌晨一点`, peakHour: bestStart };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Build the weekly report.
 *
 * @param {{
 *   history?: object[],
 *   firstSeen?: Map<number, number>,
 *   now?: number,
 *   weekKey?: string,
 * }} input
 * @returns {object|null} null when the week key is malformed.
 */
export function buildWeekly({
  history = [],
  firstSeen = new Map(),
  now = Date.now(),
  weekKey,
} = {}) {
  const key = weekKey ?? reportWeekKey(now);
  const week = isoWeekRange(key);
  if (!week) return null;
  const periodMs = week.end - week.start;

  const plays = playsWithin(history, { since: week.start, until: week.end });
  const previousPlays = playsWithin(history, { since: week.start - periodMs, until: week.start });
  const heard = plays.filter(isHeard);
  const skipped = plays.filter((entry) => entry.skipped);
  const backfilled = plays.filter((entry) => entry.backfilled);

  let newTracks = 0;
  for (const id of new Set(heard.map((entry) => entry.id))) {
    const first = firstSeen.get(id);
    if (first !== undefined && first >= week.start && first < week.end) newTracks += 1;
  }

  const playedMs = plays.reduce((sum, entry) => sum + Number(entry.playedMs ?? 0), 0);
  const previousMs = previousPlays.reduce((sum, entry) => sum + Number(entry.playedMs ?? 0), 0);
  const skipRate = percentage(skipped.length, plays.length);
  const previousSkipRate = percentage(
    previousPlays.filter((entry) => entry.skipped).length,
    previousPlays.length,
  );
  const daily = dailyMinutes(plays);
  const peakDay = daily.reduce((best, day) => (day.minutes > best.minutes ? day : best), daily[0]);
  const hours = hourHistogram(plays);
  const windowInfo = listeningWindow(hours);
  const tracks = topTracks(plays, REPORT_TRACK_LIMIT);

  const loop = tracks.length
    ? {
      ...tracks[0],
      story: loopStory(tracks[0], plays),
    }
    : null;

  return {
    version: 1,
    generatedAt: now,
    week: { key: week.key, start: week.start, end: week.end, label: weekLabel(week) },
    metrics: {
      hours: round1(playedMs / HOUR_MS),
      tracks: uniqueTrackCount(plays),
      newTracks,
      skipRate,
      plays: heard.length,
      backfilled: backfilled.length,
    },
    daily,
    peakDay: peakDay?.minutes ? { label: WEEKDAY_WORDS[peakDay.weekday], hours: round1(peakDay.minutes / 60) } : null,
    listeningWindow: windowInfo,
    topTracks: tracks,
    loop,
    compare: previousPlays.length
      ? {
        hours: round1(playedMs / HOUR_MS) - round1(previousMs / HOUR_MS),
        newTracks: newTracks - newCount(previousPlays, firstSeen, week.start - periodMs, week.start),
        skipRate: Math.round((skipRate - previousSkipRate) * 10) / 10,
      }
      : null,
    text: reportText({
      week,
      hours: round1(playedMs / HOUR_MS),
      plays: heard.length,
      newTracks,
      skipRate,
      peakDay,
      windowInfo,
      loop,
    }),
  };
}

/**
 * Fold the account's current-week record into a report.
 *
 * The account endpoint gives the week's 100 most-played tracks with a running
 * count but **no timestamps**, so it can replace the "most loved" list and the
 * play counts, but not hours, daily curves, listening windows or week-over-week
 * comparisons. Those stay local; blocks with no local data are hidden by callers
 * instead of being painted as zero.
 *
 * @param {object} report   result of `buildWeekly`
 * @param {{available?: boolean, weekKey?: string, plays?: number, tracks?: object[], source?: object}} [account]
 * @returns {object} the same report with an `account` block and account-sourced topTracks
 */
export function applyAccountWeek(report, account) {
  if (!report) return report;
  if (!account || !account.available) {
    return { ...report, account: { available: false } };
  }
  const tracks = (account.tracks ?? []).filter((item) => item && (item.track ?? item.name));
  if (!tracks.length) {
    return { ...report, account: { available: false, reason: 'empty' } };
  }
  const topTracks = tracks.slice(0, REPORT_TRACK_LIMIT).map((item) => ({
    track: item.track ?? { id: item.id, name: item.name, artists: item.artists ?? [] },
    plays: Number(item.plays ?? item.playCount ?? 0),
  }));
  const plays = Number(account.plays ?? topTracks.reduce((sum, item) => sum + item.plays, 0));
  const localPlays = Number(report.metrics?.plays ?? 0);
  const text = localPlays === 0
    ? `本周本机没有播放记录；账号本周榜显示 ${plays} 次播放、${tracks.length} 首（不含时间），榜单在下面。`
    : report.text;
  return {
    ...report,
    text,
    topSource: 'account',
    topTracks,
    account: {
      available: true,
      weekKey: account.weekKey ?? report.week?.key ?? null,
      plays,
      tracks: tracks.length,
      source: account.source ?? { label: '账号本周记录', note: '最近 100 首 · 累计次数，不含时间' },
    },
  };
}

function newCount(plays, firstSeen, since, until) {
  let count = 0;
  for (const id of new Set(plays.filter(isHeard).map((entry) => entry.id))) {
    const first = firstSeen.get(id);
    if (first !== undefined && first >= since && first < until) count += 1;
  }
  return count;
}

/**
 * One-sentence story for the looped track, or null when it was not looped.
 */
function loopStory({ track, plays }, allPlays) {
  const at = allPlays.find((entry) => entry.id === track.id);
  if (!at) return '';
  const hour = new Date(at.at).getHours();
  if (plays < 3) return `这一周你把它听了 ${plays} 遍。`;
  const weekday = WEEKDAY_WORDS[weekdayIndex(at.at)];
  return `你在${weekday}${hour}点听了 ${plays} 遍，那一小时里，这首歌没断过。`;
}

function reportText({ hours, plays, newTracks, skipRate, peakDay, windowInfo, loop }) {
  const lines = [];
  if (windowInfo) {
    lines.push(`听歌集中在${windowInfo.label}，${peakDay ? `${peakDay.label}是你的峰值，那天你听了 ${peakDay.hours} 小时` : `一共听了 ${hours} 小时`}。`);
  } else {
    lines.push('这一周几乎没有听歌，先把歌放起来吧。');
  }
  if (newTracks > 0) {
    lines.push(`你比上周更愿意尝试新歌：这周有 ${newTracks} 首第一次听，跳过率 ${skipRate}%。`);
  }
  if (loop) {
    lines.push(`最放不下的是《${loop.track.name}》，一共 ${loop.plays} 遍。`);
  }
  return lines.join('');
}

/** Human label for the current week, for tool output. */
export function currentWeekLabel(now = Date.now()) {
  return weekLabel(isoWeekRange(reportWeekKey(now)));
}

export { playsWithin, topTracks, formatDay };
