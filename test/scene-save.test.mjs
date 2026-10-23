/**
 * Playlist write-back: scene drafts may become real playlists once
 * `playlist/create` is known to work, but only when the gate allows it and the
 * account is signed in. These tests pin the gate, the dedupe and the error codes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Features } from '../lib/features.js';
import { Netease } from '../lib/netease.js';

function makeFeatures(api, config = {}) {
  return new Features({
    api,
    store: { historyEntries: [], dislikedIds: [] },
    tags: { all: () => ({}) },
    player: {},
    config,
    llm: () => undefined,
    logger: { debug() {}, info() {}, warn() {} },
  });
}

function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    authenticated: true,
    async createPlaylist(name) {
      calls.push(['create', name]);
      return { id: 4242, name };
    },
    async addPlaylistTracks(playlistId, ids) {
      calls.push(['add', playlistId, ids]);
      return { playlistId, added: ids.length };
    },
    ...overrides,
  };
}

test('local mode never touches the account', async () => {
  const api = fakeApi();
  const features = makeFeatures(api, { write: { playlist: true } });
  const saved = await features.saveScene({ name: '雨天下午', trackIds: [1, 2], mode: 'local' });
  assert.deepEqual(saved, { saved: true, mode: 'local', name: '雨天下午', count: 2 });
  assert.equal(api.calls.length, 0);
});

test('account mode creates the playlist and appends the deduped tracks', async () => {
  const api = fakeApi();
  const features = makeFeatures(api, { write: { playlist: true } });
  const saved = await features.saveScene({ name: '雨天下午', trackIds: [1, 2, 2, '3', 'x'], mode: 'account' });
  assert.equal(saved.mode, 'account');
  assert.equal(saved.playlistId, 4242);
  assert.equal(saved.count, 3, 'duplicates and non-numeric ids are dropped');
  assert.deepEqual(api.calls[0], ['create', '雨天下午']);
  assert.deepEqual(api.calls[1], ['add', 4242, [1, 2, 3]]);
});

test('a disabled write gate still answers UNVERIFIED instead of writing', async () => {
  const api = fakeApi();
  const features = makeFeatures(api, { write: { playlist: false } });
  await assert.rejects(
    () => features.saveScene({ trackIds: [1], mode: 'account' }),
    (error) => error.code === 'UNVERIFIED',
  );
  assert.equal(api.calls.length, 0);
});

test('an empty draft is refused before any network call', async () => {
  const api = fakeApi();
  const features = makeFeatures(api, { write: { playlist: true } });
  await assert.rejects(() => features.saveScene({ trackIds: [], mode: 'account' }), (error) => error.code === 'EMPTY');
  assert.equal(api.calls.length, 0);
});

test('the nameless draft gets a readable default title', async () => {
  const api = fakeApi();
  const features = makeFeatures(api, { write: { playlist: true } });
  const saved = await features.saveScene({ trackIds: [7], mode: 'account' });
  assert.equal(saved.name, '场景歌单 1 首');
});

test('signed-out netease refuses the write locally, without a request', async () => {
  const api = new Netease({ cookie: '' });
  assert.equal(api.authenticated, false);
  await assert.rejects(() => api.createPlaylist('x'), (error) => error.code === 'NOT_SIGNED_IN');
});
