/**
 * Feature services: the seam between the HTTP layer and the pure `core/*`
 * logic. Every fetch, every cache read/write and every model call lives here,
 * so `router.js` stays a thin request/response adapter and `core/*` stays
 * testable without a context object.
 *
 * @module ncm-plugin/features
 */

import { firstSeenMap, playsWithin, topTracks } from './core/history.js';
import {
  acrosticReport,
  dropCredits,
  extractHeads,
  lyricText,
  overlapStats,
  parseLyrics,
  splitForRemix,
  validateRemix,
} from './core/lyric.js';
import { DAY_MS, isoWeek } from './core/models.js';
import { buildWeekly, reportWeekKey } from './core/report.js';
import { parseBrief, planScene } from './core/scene.js';
import { RANGE_DAYS, buildAccountProfile, buildProfile, selectRange } from './core/taste.js';
import { normalizeTrack } from './netease.js';
import { preferredModel } from './settings.js';
import { generateText, streamText } from './model.js';

/** How long a generated profile/report is reused before it is recomputed. */
export const CACHE_TTL_MS = 10 * 60_000;
/** Candidate ceiling: enough for a 40-track draft with room for exclusions. */
const POOL_LIMIT = 120;

const RANGE_LABEL = Object.freeze({ '4w': '近 4 周', '6m': '近半年', all: '全部' });

export class Features {
  /**
   * @param {{
   *   api: object,
   *   store: object,
   *   tags: object,
   *   player?: object,
   *   config?: object,
   *   llm?: () => object|undefined,
   *   logger?: object,
   * }} options
   */
  constructor({ api, store, tags, player, config = {}, llm, readAgentDefault, logger }) {
    this.api = api;
    this.store = store;
    this.tags = tags;
    this.player = player;
    this.config = config;
    this.getLlm = llm;
    this.readAgentDefault = readAgentDefault;
    this.logger = logger;
    /** Account listening record, refreshed at the same cadence as profiles. */
    this.accountCache = { at: 0, items: [] };
  }

  /**
   * The account's lifetime listening record as `[{track, plays}]`.
   *
   * `play/record` returns at most 100 songs with a `playCount` per song and no
   * timestamps. It is the only source that covers listening done outside this
   * machine, so 全部 画像 prefers it; everything time-based (weekly, 深夜占比,
   * 新歌率) still comes from local history.
   */
  async accountItems({ now = Date.now() } = {}) {
    if (now - this.accountCache.at < CACHE_TTL_MS && this.accountCache.items.length) {
      return this.accountCache.items;
    }
    let account = null;
    try {
      account = await this.api.fetchAccount();
    } catch {
      account = null;
    }
    if (!account?.uid) return [];
    const data = await this.api.playRecord(account.uid).catch(() => ({ allData: [] }));
    const items = (data.allData ?? [])
      .map((entry) => ({ track: normalizeTrack(entry?.song), plays: Number(entry?.playCount) || 0 }))
      .filter((item) => item.track && item.plays > 0);
    this.accountCache = { at: now, items };
    return items;
  }

  // ------------------------------------------------------------------ taste

  /**
   * Profile for one range; cached in `session.profile.ranges`.
   *
   * @param {{range?: string, refresh?: boolean, now?: number}} [options]
   */
  async taste({ range = '4w', refresh = false, now = Date.now() } = {}) {
    const key = RANGE_LABEL[range] ? range : '4w';
    const cached = this.store.profileCache?.ranges?.[key];
    if (!refresh && cached && now - (cached.generatedAt ?? 0) < CACHE_TTL_MS) {
      // An account-built profile carries its own label; relabelling it as local
      // history would misreport where the numbers came from.
      if (!cached.dataSource?.account) cached.dataSource = this.dataSource();
      return cached;
    }

    // 全部 range: the account record covers listening this machine never saw,
    // and it is already counted, so it must not be mixed into local history.
    if (key === 'all') {
      const accountItems = await this.accountItems({ now }).catch(() => []);
      if (accountItems.length >= 20) {
        await this.#ensureTagsFor(
          accountItems.map(({ track }) => ({ id: track.id, artists: track.artists, album: track.album, duration: track.duration })),
          80,
        );
        const accountProfile = buildAccountProfile({ items: accountItems, tagsById: this.tags.all(), now });
        accountProfile.label = RANGE_LABEL[key];
        accountProfile.dataSource = {
          label: '账号听歌记录',
          account: true,
          local: false,
          note: '最近 100 首 · 累计播放次数，不含时间',
        };
        this.store.profileCache.ranges[key] = accountProfile;
        this.store.save?.();
        return accountProfile;
      }
    }

    const history = this.store.historyEntries;
    const plays = selectRange(history, { range: key, now });
    await this.#ensureTagsFor(plays, 60);

    const days = RANGE_DAYS[key];
    const previous = Number.isFinite(days)
      ? playsWithin(history, { since: now - days * 2 * DAY_MS, until: now - days * DAY_MS })
      : [];
    const profile = buildProfile({
      plays,
      previousPlays: previous,
      tagsById: this.tags.all(),
      firstSeen: firstSeenMap(history),
      now,
      range: key,
      since: Number.isFinite(days) ? now - days * DAY_MS : -Infinity,
    });
    profile.label = RANGE_LABEL[key];
    profile.dataSource = this.dataSource();
    this.store.profileCache.ranges[key] = profile;
    this.store.save?.();
    return profile;
  }

  // ----------------------------------------------------------------- report

  /**
   * One ISO week's report; cached in `session.reports`.
   *
   * @param {{week?: string, refresh?: boolean, now?: number}} [options]
   */
  async report({ week = 'this', refresh = false, now = Date.now() } = {}) {
    const key = week === 'this' || !week
      ? reportWeekKey(now)
      : week === 'last'
        ? isoWeek(now - 7 * DAY_MS).key
        : week;
    const cached = this.store.reports?.[key];
    if (!refresh && cached) {
      cached.dataSource = this.dataSource();
      return cached;
    }

    const history = this.store.historyEntries;
    const report = buildWeekly({ history, firstSeen: firstSeenMap(history), now, weekKey: key });
    if (!report) {
      const error = new Error(`无法识别的周：${key}`);
      error.code = 'BAD_WEEK';
      throw error;
    }
    this.store.reports[key] = report;
    report.dataSource = this.dataSource();
    this.store.save?.();
    return report;
  }

  /**
   * Where the numbers came from, for the "数据来源" line the pages must show.
   *
   * Until M0-V1 lands, no play carries `source: 'account'`, so this honestly
   * reports the local history alone. Once account history is imported the
   * label switches with no page change.
   *
   * @returns {{label: string, account: boolean, local: boolean, note?: string}}
   */
  dataSource() {
    const account = this.store.historyEntries.some((entry) => entry.source === 'account');
    return account
      ? { label: '账号听歌记录 + 本机播放历史', account: true, local: true }
      : { label: '本机播放历史', account: false, local: true, note: '换设备会丢' };
  }

  // ---------------------------------------------------------------- library

  /**
   * The listener's playlists and quick shelves: what the library page shows
   * right after sign-in. Without this the signed-in UI is just an empty player.
   *
   * @param {{limit?: number}} [options]
   */
  async library({ limit = 60 } = {}) {
    const account = await this.api.fetchAccount().catch(() => null);
    if (!account) {
      const error = new Error('还没有登录网易云');
      error.code = 'NO_ACCOUNT';
      throw error;
    }
    const playlists = await this.api.userPlaylists(account.uid, { limit: 100 }).catch(() => []);
    const decorate = (playlist) => ({
      id: playlist.id,
      name: playlist.name,
      cover: playlist.cover,
      trackCount: playlist.trackCount,
      playCount: playlist.playCount ?? 0,
      subscribed: Boolean(playlist.subscribed),
      special: playlist.specialType === 5,
    });
    const created = playlists
      .filter((playlist) => !playlist.subscribed && playlist.specialType !== 5)
      .map(decorate)
      .slice(0, limit);
    const likedPlaylist = playlists.find((playlist) => playlist.specialType === 5) ?? null;
    const collected = playlists
      .filter((playlist) => playlist.subscribed && playlist.specialType !== 5)
      .map(decorate)
      .slice(0, limit);

    // Recent plays are stored as compact history entries; hydrate the newest
    // ones once so the row can show a cover instead of a grey square.
    const history = this.store.historyEntries;
    const recentIds = [...new Set(history.slice(0, 40).map((entry) => entry.id))].slice(0, 20);
    const details = await this.api.songDetail(recentIds).catch(() => []);
    const byId = new Map(details.map((track) => [track.id, track]));
    const recent = recentIds
      .map((id) => {
        const track = byId.get(id);
        if (track) return track;
        const entry = history.find((item) => item.id === id);
        return entry
          ? { id: entry.id, name: entry.name, artists: entry.artists ?? [], album: entry.album ?? '', duration: entry.duration ?? 0 }
          : null;
      })
      .filter(Boolean)
      .map((track) => ({
        id: track.id,
        name: track.name,
        artists: track.artists ?? [],
        album: typeof track.album === 'string' ? track.album : track.album?.name ?? '',
        picUrl: track.picUrl ?? null,
        duration: track.duration ?? 0,
      }));

    const daily = await this.api
      .personalizedNewsongs(6)
      .then((tracks) => this.api.withCovers(tracks))
      .catch(() => []);

    return {
      account: { uid: account.uid, nickname: account.nickname, avatar: account.avatar ?? null },
      created,
      liked: likedPlaylist ? decorate(likedPlaylist) : null,
      collected,
      recent,
      daily,
    };
  }

  // ------------------------------------------------------------------ scene

  /**
   * Build a scene draft from one sentence.
   *
   * @param {{brief?: string, count?: number, now?: number}} [options]
   */
  async scene({ brief = '', count = 40, now = Date.now() } = {}) {
    const filters = parseBrief(brief);
    const { pool, warnings } = await this.#collectPool(filters, now);
    await this.#ensureTagsFor(pool.map((item) => item.track), 80);
    const draft = planScene({
      brief: filters.raw,
      pool,
      tagsById: this.tags.all(),
      history: this.store.historyEntries,
      disliked: new Set(this.store.dislikedIds ?? []),
      now,
      limit: Math.min(Math.max(Number(count) || 40, 5), 60),
    });
    draft.warnings = warnings;
    if (draft.count === 0) draft.warnings.push('候选池是空的：检查网络或换个说法');
    this.logger?.debug?.(`[music] scene draft: ${draft.count} of ${draft.poolSize} candidates`);
    return draft;
  }

  /**
   * Persist a scene as a playlist. Account writes are gated behind the M0
   * verification flag: until `playlist/create` + `playlist/tracks` are proven,
   * the page must fall back to local storage rather than pretend.
   *
   * @param {{name?: string, trackIds?: number[], mode?: string}} input
   */
  async saveScene({ name = '', trackIds = [], mode = 'account' } = {}) {
    const ids = [...new Set(trackIds.map(Number).filter(Number.isFinite))];
    if (ids.length === 0) {
      const error = new Error('歌单是空的');
      error.code = 'EMPTY';
      throw error;
    }
    const title = String(name || '').trim() || `场景歌单 ${ids.length} 首`;
    if (mode === 'local') return { saved: true, mode: 'local', name: title, count: ids.length };
    if (!this.config.write?.playlist) {
      const error = new Error('写歌单接口还没验证（playlist/create、playlist/tracks/manipulate），验证通过前只能存到本地');
      error.code = 'UNVERIFIED';
      throw error;
    }
    const created = await this.api.createPlaylist(title);
    await this.api.addPlaylistTracks(created.id, ids);
    this.logger?.info?.(`[music] playlist created: ${created.id} (${ids.length} tracks)`);
    return { saved: true, mode: 'account', name: created.name, count: ids.length, playlistId: created.id };
  }

  /**
   * Candidate pool for a scene: keyword search, similar tracks around what the
   * listener actually plays, favourite artists, and the daily picks. This is
   * the same four-source shape the DJ uses, minus the model plan.
   */
  async #collectPool(filters, now) {
    const history = this.store.historyEntries;
    const pool = [];
    const warnings = [];
    const push = (track, source, label, seed) => {
      if (track?.id) pool.push({ track, source, label, seed });
    };

    // One retry: NetEase rate-limits bursts, and a failed keyword search is the
    // difference between "a rainy afternoon" and a generic similar-tracks list.
    const searchKeyword = async (keyword, limit) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await this.api.searchSongs(keyword, { limit });
          return result.tracks ?? [];
        } catch (error) {
          if (attempt === 2) {
            warnings.push(`搜索「${keyword}」失败：${error.message}`);
            return [];
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      return [];
    };

    const keywords = (filters.keywords.length > 0 ? filters.keywords : ['深夜', '安静']).slice(0, 3);
    const searches = await Promise.all(keywords.map(async (keyword) => ({ keyword, tracks: await searchKeyword(keyword, 8) })));
    for (const { keyword, tracks } of searches) {
      for (const track of tracks) push(track, 'search', keyword, keyword);
    }
    if (searches.every(({ tracks }) => tracks.length === 0)) {
      // Anonymous NetEase search answers 200 with zero songs; say so instead of
      // silently handing back a draft that ignores the brief.
      warnings.push('搜索没结果：未登录时网易云不返回搜索，草稿只能来自相似推荐与每日推荐');
    }

    const anchors = topTracks(history, 2);
    const similars = await Promise.all(anchors.map(({ track }) =>
      this.api.simiSongs(track.id, { limit: 10 }).then((tracks) => ({ track, tracks }), () => ({ track, tracks: [] }))));
    for (const { track, tracks } of similars) {
      for (const similar of tracks) push(similar, 'similar', track.name, track.name);
    }

    const artists = [...new Set(history.map((entry) => entry.artists?.[0]).filter(Boolean))].slice(0, 2);
    const artistSearches = await Promise.all(artists.map(async (artist) => ({ artist, tracks: await searchKeyword(artist, 6) })));
    for (const { artist, tracks } of artistSearches) {
      for (const track of tracks) push(track, 'taste', artist, artist);
    }

    const daily = await this.api.personalizedNewsongs(8).catch(() => []);
    for (const track of daily) push(track, 'daily', '每日推荐与榜单', '每日推荐');

    // Search results arrive without covers; one batched detail call fills them.
    const tracks = pool.map((item) => item.track);
    const covered = await this.api.withCovers(tracks).catch(() => tracks);
    const byId = new Map(covered.map((track) => [track.id, track]));
    const seen = new Set();
    const deduped = pool
      .map((item) => ({ ...item, track: byId.get(item.track.id) ?? item.track }))
      .filter((item) => (seen.has(item.track.id) ? false : seen.add(item.track.id)))
      .slice(0, POOL_LIMIT);
    return { pool: deduped, warnings };
  }

  // ------------------------------------------------------------------ lyric

  /**
   * Lyrics (line and word level when the API serves YRC) plus track metadata.
   *
   * @param {{id: number|string, mode?: string, scope?: string, from?: number, to?: number}} input
   */
  async lyric({ id, mode = '改诗', scope = 'all', from, to, indexes } = {}) {
    const songId = Number(id);
    if (!Number.isFinite(songId)) {
      const error = new Error('缺少歌曲 id');
      error.code = 'BAD_ID';
      throw error;
    }
    const [detail, raw] = await Promise.all([
      this.api.songDetail([songId]).then((tracks) => tracks[0] ?? null, () => null),
      this.#lyricText(songId),
    ]);
    const track = detail ?? { id: songId, name: `歌曲 ${songId}`, artists: [], duration: 0 };
    const lyrics = dropCredits(parseLyrics(raw));
    const selection = splitForRemix(lyrics, { range: scope, from, to, indexes });
    return {
      track,
      lyrics,
      remix: null,
      selection: { from: selection.fromIndex, to: selection.toIndex, indexes: selection.indexes ?? [], count: selection.count },
      mode,
    };
  }

  /**
   * Ask the model to rewrite the lyrics. The text alone leaves the machine:
   * no account, no cookie, no track id.
   *
   * The visit is two-step on purpose: a short read of the selection first
   * (mood / images / story), then a write that is allowed to see that read.
   * Rounds of "rewrite these words" alone produce the same poem for every
   * song; reading first is what makes each selection different.
   *
   * @param {{id: number|string, mode?: string, scope?: string, from?: number, to?: number,
   *          style?: string, head?: string, headChars?: string|string[], indexes?: number[],
   *          onDelta?: (delta: string) => void}} input
   */
  async remix({
    id,
    mode = '改诗',
    scope = 'all',
    from,
    to,
    indexes,
    style = '',
    head = '',
    headChars,
    onDelta,
  } = {}) {
    const data = await this.lyric({ id, mode, scope, from, to, indexes });
    const source = splitForRemix(data.lyrics, { range: scope, from, to, indexes });
    if (!source.text.trim()) {
      const error = new Error('这首歌没有可用的歌词');
      error.code = 'NO_LYRIC';
      throw error;
    }
    const llm = this.getLlm?.();
    if (!llm?.stream) {
      const error = new Error('没有可用的模型，请先在设置里配置 provider / model');
      error.code = 'NO_MODEL';
      throw error;
    }
    const started = Date.now();
    // Same route precedence as the DJ: the settings page's choice first, then
    // the conversation's model, and only then whatever the host lists first
    // (that last hop lives inside `generateText`).
    const chosen = preferredModel({ settings: this.store?.settings, readAgentDefault: this.readAgentDefault });
    const route = {
      llm,
      provider: chosen?.provider || this.config.remix?.provider,
      model: chosen?.model || this.config.remix?.model,
      sessionId: this.config.remix?.sessionId ?? 'ncm-lyric',
    };
    const track = data.track ?? {};
    const lyricLines = data.lyrics?.lines ?? [];
    const fullText = lyricText(lyricLines);
    const selectedLines = (source.indexes ?? []).map((index) => lyricLines[index]).filter(Boolean);
    const targetChars = mode === '藏头' ? acrosticTarget(headChars, head, selectedLines) : '';
    const warnings = [];

    let analysis = null;
    if (mode !== '翻译') {
      try {
        const read = await generateText({
          ...route,
          text: buildAnalysisPrompt({ track, fullText, selectedText: source.text }),
        });
        if (read?.text) analysis = read.text.trim().slice(0, 240);
      } catch (error) {
        warnings.push(`先读这段没成功：${error.message}`);
      }
    }

    const write = (extra = '') => {
      const prompt = buildRemixPrompt({
        mode,
        track,
        selectedText: source.text,
        fullText,
        lineCount: source.count,
        analysis,
        style,
        targetChars,
        extra,
      });
      return onDelta
        ? streamText({ ...route, text: prompt, onDelta })
        : generateText({ ...route, text: prompt });
    };

    let answer = await write();
    if (!answer) {
      const error = new Error('没有可用的模型，请先在设置里配置 provider / model');
      error.code = 'NO_MODEL';
      throw error;
    }
    let check = validateRemix(answer.text, { requireChinese: mode !== '翻译' });
    let metrics = mode === '翻译' ? null : overlapStats(source.text, answer.text);
    let acrostic = targetChars ? acrosticReport(answer.text, targetChars) : null;
    let retried = false;

    // Streaming cannot be retried without typing the answer twice, so only the
    // batch call asks again; both paths report the metrics they ended with.
    const weak = metrics ? metrics.overlap < MIN_OVERLAP : false;
    const brokenHead = Boolean(acrostic && !acrostic.ok);
    if (!onDelta && (!check.ok || weak || brokenHead)) {
      let hint = '';
      if (!check.ok) hint = '上一次输出不合格（空、太长、行数过多或不是中文），请重来。';
      else if (weak) hint = `上一次输出和原词的词句几乎不重合（重合 ${Math.round(metrics.overlap * 100)}%），请多用原词里的词和意象。`;
      else if (brokenHead) {
        hint = `上一版第 ${String(acrostic.mismatches.map((item) => item.line)).replace(/,/g, '、')} 行首字不对；每行第一个字必须依次是「${Array.from(targetChars).join('')}」。`;
      }
      retried = true;
      const second = await write(hint);
      if (second) {
        const secondCheck = validateRemix(second.text, { requireChinese: mode !== '翻译' });
        if (secondCheck.ok) {
          answer = second;
          check = secondCheck;
          metrics = mode === '翻译' ? null : overlapStats(source.text, second.text);
          acrostic = targetChars ? acrosticReport(second.text, targetChars) : null;
        }
      }
    }
    if (!check.ok) {
      const error = new Error(`模型返回的内容不合规：${check.issues.join('、')}`);
      error.code = 'BAD_REMIX';
      error.issues = check.issues;
      throw error;
    }
    if (metrics && metrics.overlap < MIN_OVERLAP) {
      warnings.push(`输出与原词重合偏低（${Math.round(metrics.overlap * 100)}%），可能跑题`);
    }
    if (acrostic && !acrostic.ok) {
      warnings.push(`藏头有 ${acrostic.mismatches.length} 个字没对上（第 ${String(acrostic.mismatches.map((item) => item.line)).replace(/,/g, '、')} 行）`);
    }
    return {
      mode,
      text: answer.text,
      route: answer.route,
      analysis,
      metrics,
      acrostic,
      targetChars,
      warnings,
      retried,
      elapsedMs: Date.now() - started,
      sourceLines: source.count,
      sourceIndexes: source.indexes ?? [],
    };
  }

  /** Fetch lyric payloads; YRC needs the extended `*-1` tier parameters. */
  async #lyricText(songId) {
    const [plain, rich] = await Promise.all([
      this.api.lyric(songId).catch(() => ({ lrc: '' })),
      this.api.call('/api/song/lyric', {
        query: { id: songId, lv: -1, kv: -1, yv: -1, tv: -1, rv: -1 },
      }).then((data) => ({ yrc: data?.yrc?.lyric ?? '', lrc: data?.lrc?.lyric ?? '' }), () => ({ yrc: '', lrc: '' })),
    ]);
    return {
      lrc: plain?.lrc || rich.lrc,
      yrc: rich.yrc,
      translated: plain?.translated ?? '',
      romaji: plain?.romaji ?? '',
      noLyric: Boolean(plain?.noLyric) && !rich.lrc && !rich.yrc,
    };
  }

  /**
   * Make sure the tag cache can answer for these tracks before an aggregation.
   * Never fatal: a profile computed from partial tags is still useful.
   */
  async #ensureTagsFor(tracks, limit) {
    try {
      const ids = tracks.map((entry) => entry.id ?? entry?.track?.id).filter(Boolean);
      await this.tags.ensure(this.api, this.tags.missing(ids.map((id) => ({ id })), limit));
    } catch (error) {
      this.logger?.warn?.(`[music] tag fill failed: ${error.message}`);
    }
  }
}

/** Answers below this share of shared bigrams are treated as "drifted off the lyrics". */
export const MIN_OVERLAP = 0.15;

/** How much of the full lyrics to show the model for context. */
const CONTEXT_CHARS = 1200;

/**
 * The "read before write" pass: three short lines about the selection only.
 * It is deliberately dumb — no rewriting, no titles — so a small model can do
 * it and the answer stays cheap enough to keep around as prompt context.
 */
export function buildAnalysisPrompt({ track = {}, fullText = '', selectedText = '' }) {
  const title = track.name ? `《${track.name}》` : '这首歌';
  const artist = (track.artists ?? []).join('、');
  return [
    '你是一位中文歌词编辑，先只读、不改写。',
    '请针对下面这一段歌词，用三行回答：',
    '情绪：用 2-4 个词概括。',
    '意象：列出 3-5 个具体名词或画面，用逗号分隔。',
    '叙事：一句话说这段在讲什么。',
    '不要写别的，不要引用整句歌词，不要输出标题。',
    '',
    artist ? `${title} — ${artist}` : title,
    '【整首歌的歌词，只作背景】',
    String(fullText ?? '').slice(0, CONTEXT_CHARS),
    '',
    '【要读的是这一段】',
    String(selectedText ?? ''),
  ].join('\n');
}

/**
 * The write prompt. Everything the model needs is in one place: which song,
 * what the full lyrics say, which lines are being rewritten, the model's own
 * read of them, and hard constraints the caller checks afterwards.
 */
export function buildRemixPrompt({
  mode = '改诗',
  track = {},
  selectedText = '',
  fullText = '',
  lineCount = 0,
  analysis = '',
  style = '',
  targetChars = '',
  extra = '',
} = {}) {
  const title = track.name ? `《${track.name}》` : '这首歌';
  const artist = (track.artists ?? []).join('、');
  const styleLine = style ? `风格偏好：${style}。` : '';
  const task = {
    翻译: '把这一段歌词翻译成英文，保留分行、语气和叙事顺序，不要解释。',
    藏头: `把这一段歌词改写成藏头诗：第 1 行第一个字是「${Array.from(targetChars)[0] ?? '?'}」，第 2 行第一个字是「${Array.from(targetChars)[1] ?? '?'}」，依此类推，每行首字连起来必须是「${targetChars}」。`,
    短视频文案: '根据这一段歌词写三条短视频文案，每条一句话，直白克制，不要表情符号。',
    改诗: '把这一段歌词改写成一首诗：保留原意与叙事顺序，去掉口水词和重复句，语气克制。',
  }[mode] ?? '把这一段歌词改写成一首诗：保留原意与叙事顺序，语气克制。';
  return [
    '你是中文歌词编辑，正在帮用户做二次创作。',
    artist ? `${title} — ${artist}` : title,
    '',
    '【整首歌的歌词（只作理解上下文，不要整首改写）】',
    String(fullText ?? '').slice(0, CONTEXT_CHARS),
    '',
    `【这一次要处理的部分，共 ${lineCount} 行】`,
    String(selectedText ?? ''),
    analysis ? `\n【你刚才对这段的解读】\n${analysis}` : '',
    '',
    `【任务】${task}${styleLine}`,
    '【硬约束】',
    `1. 只输出正文，不要标题、不要解释、不要用引号包住整段；输出 ${lineCount} 行左右，最多比原文多 1 行。`,
    '2. 必须复用原词里的具体意象或词（至少 3 处），不要整句照抄，也不要写成和原词无关的通用抒情。',
    '3. 保持中文；' + (mode === '翻译' ? '这一条按任务要求输出英文。' : '不要中途翻译成英文。'),
    '4. 不要出现「歌词」「这首歌」这类元话语。',
    extra ? `\n【上一版的问题，务必修正】${extra}` : '',
  ].join('\n');
}

/**
 * Acrostic target: what the first characters of the generated lines must spell.
 * Defaults to the first characters of the selected lines — the selection is the
 * source of truth, not a free-text box.
 */
export function acrosticTarget(headChars, head, selectedLines) {
  const explicit = Array.isArray(headChars)
    ? headChars.join('')
    : String(headChars ?? head ?? '').replace(/[\s\p{P}]/gu, '');
  const target = explicit || extractHeads(selectedLines).join('');
  if (!target) {
    const error = new Error('藏头要先选几行歌词，或者写一句想藏进去的话');
    error.code = 'BAD_ARGS';
    throw error;
  }
  return target;
}

export { RANGE_LABEL };
