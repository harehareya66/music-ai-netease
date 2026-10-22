/**
 * Agent-facing tools for the four side features.
 *
 * Each spec has the shape `defineMusicTool` consumes (name/title/description/
 * parameters/execute/render); `index.js` registers them through the same helper
 * as the playback tools, so cards and output rendering stay uniform.
 *
 * @module ncm-plugin/tools/features
 */

/** One line per track, the form the model reads best. */
function line(track, index) {
  const artists = (track.artists ?? []).join('/');
  const minutes = Math.floor((track.duration ?? 0) / 60000);
  const seconds = String(Math.floor(((track.duration ?? 0) % 60000) / 1000)).padStart(2, '0');
  return `${index === undefined ? '' : `${index + 1}. `}${track.name} — ${artists} [id:${track.id}, ${minutes}:${seconds}]`;
}

const RANGE_TEXT = { '4w': '近 4 周', '6m': '近半年', all: '全部' };

/**
 * @param {{
 *   features: object,
 *   api: object,
 *   store: object,
 *   config?: object,
 *   panelUrl: () => string,
 * }} deps
 * @returns {object[]} tool specs, in registration order.
 */
export function createFeatureTools({ features, api, store, config = {}, panelUrl }) {
  const tools = [];

  // --------------------------------------------------------------- library
  tools.push({
    name: 'library_list',
    title: 'List the NetEase library',
    description:
      'List the user\'s NetEase Cloud Music library: playlists they created (`kind: "created"`), ' +
      'their 我喜欢的音乐 likes (`kind: "liked"`), or what they have played locally (`kind: "recent"`). ' +
      'Returns names and ids usable with library_tracks. Requires a signed-in account for account kinds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['created', 'liked', 'recent'],
          description: 'Which slice to list (default created).',
        },
        limit: { type: 'integer', description: 'How many entries (default 20, max 50).' },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: value.message ?? `${value.items.length} 项` },
    ],
    async execute(args = {}) {
      const kind = args.kind ?? 'created';
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      if (kind === 'recent') {
        const items = store.historyEntries.slice(0, limit).map((entry) => ({
          id: entry.id,
          name: entry.name,
          artists: entry.artists ?? [],
          at: entry.at,
        }));
        return {
          kind,
          items,
          authenticated: api.authenticated,
          message: items.length === 0
            ? '本机还没有播放记录。'
            : `最近播放 ${items.length} 首：\n${items.map((item, index) => line(item, index)).join('\n')}`,
        };
      }

      if (!api.account) {
        return { kind, items: [], authenticated: false, message: '账号未登录：先在音乐面板扫码登录，才能读取账号歌单。' };
      }
      const uid = api.account.uid;
      const playlists = await api.userPlaylists(uid, { limit: 100 });
      if (kind === 'liked') {
        const liked = playlists.find((playlist) => playlist.specialType === 5);
        if (!liked) return { kind, items: [], authenticated: true, message: '账号里没有「我喜欢的音乐」歌单。' };
        const detail = await api.playlistDetail(liked.id, { limit });
        const tracks = await api.withCovers(detail.tracks.slice(0, limit));
        return {
          kind,
          items: tracks.map((track) => ({ id: track.id, name: track.name, artists: track.artists })),
          playlistId: liked.id,
          authenticated: true,
          message: `我喜欢的音乐（共 ${liked.trackCount} 首），前 ${tracks.length} 首：\n${tracks.map((track, index) => line(track, index)).join('\n')}`,
        };
      }

      const created = playlists.filter((playlist) => !playlist.subscribed && playlist.specialType !== 5).slice(0, limit);
      return {
        kind,
        items: created.map((playlist) => ({ id: playlist.id, name: playlist.name, trackCount: playlist.trackCount })),
        authenticated: true,
        message: created.length === 0
          ? '账号里没有自建歌单。'
          : `自建歌单 ${created.length} 个：\n${created.map((playlist, index) => `${index + 1}. ${playlist.name}（${playlist.trackCount} 首）[id:${playlist.id}]`).join('\n')}`,
      };
    },
  });

  tools.push({
    name: 'library_tracks',
    title: 'List tracks in a NetEase playlist',
    description:
      'List the tracks of one NetEase playlist by id (get ids from library_list). Returns names and ids usable with music_play.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['playlistId'],
      properties: {
        playlistId: { type: 'integer', description: 'Playlist id.' },
        limit: { type: 'integer', description: 'How many tracks (default 30, max 100).' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
    async execute(args = {}) {
      const id = Number(args.playlistId);
      if (!Number.isFinite(id)) throw new Error('`playlistId` must be a number');
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const playlist = await api.playlistDetail(id, { limit });
      const tracks = await api.withCovers(playlist.tracks.slice(0, limit));
      return {
        playlistId: id,
        name: playlist.name,
        total: playlist.tracks.length,
        tracks: tracks.map((track) => ({ id: track.id, name: track.name, artists: track.artists })),
        message: `《${playlist.name ?? id}》共 ${playlist.tracks.length} 首，取前 ${tracks.length} 首：\n${tracks.map((track, index) => line(track, index)).join('\n')}`,
      };
    },
  });

  // ----------------------------------------------------------------- scene
  tools.push({
    name: 'scene_build',
    title: 'Build a scene playlist',
    description:
      'Turn one sentence of mood into a playlist ("雨天的下午，别太吵，约 42 分钟"). ' +
      'Candidates come from search, similar tracks, favourite artists and the daily picks; ranking is code, not the model. ' +
      'Set `save: true` to also persist it — account saving stays disabled until the playlist write API is verified, so it falls back to local.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        brief: { type: 'string', description: 'One sentence: scene, tempo, language, duration, exclusions.' },
        count: { type: 'integer', description: 'Target track count (default 40, max 60).' },
        save: { type: 'boolean', description: 'Also save the draft as a playlist (account, or local when that is unavailable).' },
        name: { type: 'string', description: 'Playlist name when saving.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
    async execute(args = {}) {
      const brief = String(args.brief ?? '').trim();
      if (!brief) throw new Error('`brief` is required: describe the scene in one sentence');
      const draft = await features.scene({ brief, count: args.count });
      let saved = null;
      if (args.save) {
        try {
          saved = await features.saveScene({
            name: args.name ?? draft.brief,
            trackIds: draft.tracks.map((item) => item.track.id),
            mode: 'account',
          });
        } catch (error) {
          if (error.code !== 'UNVERIFIED') throw error;
          saved = { saved: true, mode: 'local', note: error.message };
        }
      }
      const sources = draft.bySource.map((entry) => `${entry.key}×${entry.count}`).join('、');
      return {
        draft,
        saved,
        message:
          `「${draft.brief}」→ 草稿 ${draft.count} 首，约 ${draft.estimatedMinutes} 分钟（候选 ${draft.poolSize}，来源 ${sources}）` +
          `\n${draft.tracks.map((item, index) => line(item.track, index)).join('\n')}` +
          (saved ? `\n已${saved.mode === 'account' ? '存到账号' : '存到本地'}。` : '') +
          (saved?.note ? `\n${saved.note}` : ''),
      };
    },
  });

  // ----------------------------------------------------------------- taste
  tools.push({
    name: 'taste_profile',
    title: 'Read the listening profile',
    description:
      'Summarise what the user has actually been listening to: languages, eras, tempo, artists, new-song rate and repeats, ' +
      'over the last 4 weeks / 6 months / all time. Empty until the panel has played something.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: ['4w', '6m', 'all'], description: 'Window (default 4w).' },
        refresh: { type: 'boolean', description: 'Recompute instead of using the 10-minute cache.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
    async execute(args = {}) {
      const range = RANGE_TEXT[args.range] ? args.range : '4w';
      const profile = await features.taste({ range, refresh: Boolean(args.refresh) });
      const metrics = profile.metrics;
      if (!metrics.plays) {
        return {
          profile,
          message: `还没有可统计的播放记录（${RANGE_TEXT[range]}）。先放几首歌，或在面板里正常听一会儿。`,
        };
      }
      const delta = profile.deltas;
      const deltaText = delta
        ? `（比上一周期：新歌率 ${delta.newRate >= 0 ? '+' : ''}${delta.newRate}%，重复播放 ${delta.repeatRate >= 0 ? '+' : ''}${delta.repeatRate}%，平均 BPM ${delta.avgBpm ?? '—'}）`
        : '';
      return {
        profile,
        message:
          `${profile.summary}\n` +
          `统计：${metrics.plays} 次播放 / ${metrics.tracks} 首 / ${metrics.hours} 小时，新歌率 ${metrics.newRate}%，重复 ${metrics.repeatRate}%，平均 BPM ${metrics.avgBpm} ${deltaText}\n` +
          `标签：${profile.tags.map((tag) => tag.label).join('、') || '暂无'}\n` +
          `最常听：${profile.topArtists.map((artist) => `${artist.name}(${artist.count})`).join('、') || '暂无'}`,
      };
    },
  });

  // ---------------------------------------------------------------- weekly
  tools.push({
    name: 'weekly_report',
    title: 'Read the weekly listening report',
    description:
      'One ISO week\'s listening report: hours, tracks, new songs, skip rate, daily curve, top tracks, the single-track loop story ' +
      'and a short written summary. Computed from local playback history; account history is not required.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        week: { type: 'string', description: '"this" (default), "last", or an ISO week key like 2026-W42.' },
        refresh: { type: 'boolean', description: 'Recompute instead of using the cache.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
    async execute(args = {}) {
      const report = await features.report({ week: String(args.week ?? 'this'), refresh: Boolean(args.refresh) });
      const m = report.metrics;
      const tops = report.topTracks.map((item, index) => line(item.track, index)).join('\n');
      return {
        report,
        message:
          `${report.week.label}\n` +
          `时长 ${m.hours} 小时 / ${m.tracks} 首 / 新歌 ${m.newTracks} 首 / 跳过率 ${m.skipRate}%\n` +
          `${report.text}\n` +
          (tops ? `\n本周最爱：\n${tops}` : '') +
          (report.loop ? `\n单曲循环：${report.loop.story}` : '') +
          (m.backfilled ? '\n注：本周从账号听歌记录补录过一部分，可能不完整。' : ''),
      };
    },
  });

  // ----------------------------------------------------------------- lyric
  tools.push({
    name: 'lyric_remix',
    title: 'Rewrite song lyrics',
    description:
      'Fetch a track\'s lyrics and rewrite them with the configured model: 改诗 (poem), 翻译 (English), 藏头 (acrostic), ' +
      '短视频文案 (short-video captions). Only the lyric text leaves the machine — never the account or cookie. ' +
      'Returns the original text and the rewrite; the result is not saved to the account.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', description: 'Track id.' },
        mode: {
          type: 'string',
          enum: ['改诗', '翻译', '藏头', '短视频文案'],
          description: 'Rewrite mode (default 改诗).',
        },
        scope: { type: 'string', enum: ['all', 'selection'], description: 'Whole lyric or only selected lines.' },
        from: { type: 'integer', description: 'First line index for scope=selection.' },
        to: { type: 'integer', description: 'Last line index for scope=selection.' },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: value.message },
      { type: 'text', text: value.remix.text },
    ],
    async execute(args = {}) {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error('`id` must be a track id');
      const data = await features.lyric({
        id,
        mode: args.mode ?? '改诗',
        scope: args.scope === 'selection' ? 'selection' : 'all',
        from: args.from,
        to: args.to,
      });
      const original = data.lyrics.lines.map((item) => item.text).filter(Boolean).join('\n');
      if (!original) throw new Error('这首歌没有可用的歌词，无法改写');
      const remix = await features.remix({
        id,
        mode: args.mode ?? '改诗',
        scope: args.scope === 'selection' ? 'selection' : 'all',
        from: args.from,
        to: args.to,
      });
      return {
        track: { id: data.track.id, name: data.track.name, artists: data.track.artists },
        mode: remix.mode,
        route: remix.route,
        elapsedMs: remix.elapsedMs,
        remix,
        message:
          `《${data.track.name}》— ${(data.track.artists ?? []).join('/')} ｜ ${remix.mode}（${remix.route}，${(remix.elapsedMs / 1000).toFixed(1)}s）\n` +
          `结果只存在本机，不会写进账号。`,
        panelUrl: panelUrl(),
      };
    },
  });

  return tools;
}
