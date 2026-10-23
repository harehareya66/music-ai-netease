/**
 * Lyrics (L3): parse LRC / word-level YRC, split a remix request, validate the
 * model's answer.
 *
 * Parsing lives in core on purpose: the page, the tool result and the lyric
 * page all consume the same `{lines:[…]}` shape, and it is all pure string work
 * (PLAN §4 moved the reference `lib/yrc.js` here).
 *
 * @module ncm-plugin/core/lyric
 */

/** Tail added to the last line/word when NetEase gives no duration. */
export const VOCAL_TAIL_MS = 400;

const LRC_LINE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/;
const LRC_META = /^\[(ti|ar|al|by|offset|length|re|ve):/i;
const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD = /\((\d+),(\d+),\d+\)([^()]*)/g;
const YRC_META = /^\{.*\}$/;

function padEnd(lines, tailMs) {
  lines.forEach((line, index) => {
    const next = lines[index + 1];
    line.end = Math.max(line.end ?? 0, next ? next.t : line.t + (line.duration ?? 0));
    if (!next) line.end = (line.end || line.t) + tailMs;
    if (line.end <= line.t) line.end = line.t + tailMs;
    line.duration = Math.max(line.duration ?? 0, line.end - line.t);
  });
  return lines;
}

/** Metadata rows NetEase ships inside the lyric body (`作词 : …`, `编曲 : …`). */
const CREDIT_LINE = /^(作词|作曲|编曲|制作人?|监制|出品|演唱|录音|混音|母带|和声|吉他|贝斯|鼓|键盘|弦乐|词|曲)\s*[:：]/;

/** True for a credit row that should never be shown as lyric or sent to a model. */
export function isCreditLine(text) {
  return CREDIT_LINE.test(String(text ?? '').trim());
}

/**
 * Drop credit rows, keeping timings and word-level data untouched.
 * @param {{lines: object[]}} parsed
 */
export function dropCredits(parsed) {
  if (!parsed?.lines) return parsed;
  return { ...parsed, lines: parsed.lines.filter((line) => !isCreditLine(line.text)) };
}

/**
 * Parse ordinary `[mm:ss.xx]text` lyrics.
 * @param {string} text
 * @param {{tailMs?: number}} [options]
 * @returns {{lines: {t: number, end: number, text: string}[], wordLevel: false, format: 'lrc'}}
 */
export function parseLrc(text, { tailMs = VOCAL_TAIL_MS } = {}) {
  const lines = [];
  for (const row of String(text ?? '').split(/\r?\n/)) {
    const raw = row.trim();
    if (!raw || LRC_META.test(raw)) continue;
    const match = LRC_LINE.exec(raw);
    if (!match) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fraction = Number((match[3] ?? '0').padEnd(3, '0'));
    const t = minutes * 60_000 + seconds * 1000 + fraction;
    lines.push({ t, end: t, duration: 0, text: match[4].trim() });
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines: padEnd(lines, tailMs), wordLevel: false, format: 'lrc' };
}

/**
 * Parse NetEase word-level YRC (`[start,dur]content` + `(ws,wd,…)word`).
 * @param {string} text
 * @param {{tailMs?: number}} [options]
 * @returns {{lines: object[], wordLevel: boolean, format: 'yrc'}}
 */
export function parseYrc(text, { tailMs = VOCAL_TAIL_MS } = {}) {
  const lines = [];
  let wordLevel = false;
  for (const row of String(text ?? '').split(/\r?\n/)) {
    const raw = row.trim();
    if (!raw || YRC_META.test(raw)) continue;
    const match = YRC_LINE.exec(raw);
    if (!match) continue;
    const t = Number(match[1]);
    const duration = Number(match[2]);
    let content = match[3];
    const words = [];
    YRC_WORD.lastIndex = 0;
    let word = YRC_WORD.exec(content);
    while (word) {
      words.push({ t: Number(word[1]), end: Number(word[1]) + Number(word[2]), text: word[3] });
      word = YRC_WORD.exec(content);
    }
    if (words.length) {
      wordLevel = true;
      // Strip only the `(start,dur,mode)` timing prefix; the text stays.
      content = content.replace(/\(\d+,\d+,\d+\)/g, '');
    }
    lines.push({ t, end: t + duration, duration, text: content.trim(), ...(words.length ? { words } : {}) });
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines: padEnd(lines, tailMs), wordLevel, format: 'yrc' };
}

/**
 * Pick the parser that matches the payload.
 * @param {{lrc?: string, yrc?: string, wordLevel?: boolean}} payload
 */
export function parseLyrics({ lrc = '', yrc = '', tailMs = VOCAL_TAIL_MS } = {}) {
  if (yrc && /\(\d+,\d+,\d+\)/.test(yrc)) return parseYrc(yrc, { tailMs });
  return parseLrc(lrc, { tailMs });
}

/** Plain text of a parsed lyric, one line per lyric line. */
export function lyricText(lines) {
  return (lines ?? []).map((line) => line.text).filter(Boolean).join('\n');
}

/**
 * Build the text handed to the model.
 *
 * @param {{lines: object[]}} parsed
 * @param {{range?: 'all'|'selection', from?: number, to?: number, maxLines?: number}} [options]
 * @returns {{text: string, fromIndex: number, toIndex: number, count: number}}
 */
export function splitForRemix(parsed, { range = 'all', from = 0, to = Infinity, indexes, maxLines = 80 } = {}) {
  const lines = parsed?.lines ?? [];
  // 多选：页面传的是零散行号，可能不连续，按行号升序取，重复的丢掉。
  if (range === 'selection' && Array.isArray(indexes) && indexes.length) {
    const unique = [...new Set(indexes.map((value) => Number(value)))]
      .filter((value) => Number.isInteger(value) && value >= 0 && value < lines.length)
      .sort((a, b) => a - b)
      .slice(0, maxLines);
    const picked = unique
      .map((value) => ({ ...lines[value], index: value }))
      .filter((line) => line.text);
    return {
      text: picked.map((line) => line.text).join(String.fromCharCode(10)),
      fromIndex: unique[0] ?? -1,
      toIndex: unique[unique.length - 1] ?? -1,
      indexes: picked.map((line) => line.index),
      count: picked.length,
    };
  }
  const start = range === 'selection' ? Math.max(0, Math.min(from, lines.length - 1)) : 0;
  const end = range === 'selection' ? Math.min(Math.max(to, start), lines.length - 1) : lines.length - 1;
  const picked = lines
    .slice(start, end + 1)
    .map((line, index) => ({ ...line, index: start + index }))
    .filter((line) => line.text)
    .slice(0, maxLines);
  return {
    text: picked.map((line) => line.text).join(String.fromCharCode(10)),
    fromIndex: start,
    toIndex: end,
    indexes: picked.map((line) => line.index),
    count: picked.length,
  };
}

/**
 * Sanity-check a model rewrite before it reaches the page.
 * Rejects empty output, runaway length, and lines that are not Chinese at all.
 *
 * @param {string} text model answer
 * @param {{maxChars?: number}} [options]
 * @returns {{ok: boolean, issues: string[], chars: number, lines: number}}
 */
export function validateRemix(text, { maxChars = 1200, requireChinese = true } = {}) {
  const value = String(text ?? '').trim();
  const issues = [];
  if (!value) issues.push('empty');
  if (value.length > maxChars) issues.push('too-long');
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 80) issues.push('too-many-lines');
  // 翻译模式本来就该输出英文，只有其它模式才要求中文。
  if (requireChinese && value && !/[\u4e00-\u9fa5]/.test(value)) issues.push('not-chinese');
  return { ok: issues.length === 0, issues, chars: value.length, lines: lines.length };
}

/** Current line index for a playback position, -1 before the first line. */
export function lineAt(lines, positionMs) {
  let index = -1;
  for (let i = 0; i < (lines?.length ?? 0); i += 1) {
    if (lines[i].t <= positionMs) index = i;
    else break;
  }
  return index;
}
