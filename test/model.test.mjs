/**
 * Streaming leaf calls: the remix page paints chunks as they arrive, so the
 * collector must forward deltas and still surface provider failures.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { collectStream, streamText } from '../lib/model.js';

function fakeLlm(chunks) {
  return {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    stream: () => (async function* gen() {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

test('collectStream forwards each delta and returns the whole text', async () => {
  const seen = [];
  const text = await collectStream(
    (async function* gen() {
      yield { type: 'text-delta', text: '风从' };
      yield { type: 'text-delta', text: '西边来' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
    { onDelta: (delta) => seen.push(delta) },
  );
  assert.equal(text, '风从西边来');
  assert.deepEqual(seen, ['风从', '西边来']);
});

test('streamText resolves a route and returns the trimmed answer', async () => {
  const deltas = [];
  const result = await streamText({
    llm: fakeLlm([{ type: 'text-delta', text: '  风从西边来  ' }, { type: 'finish', reason: 'stop' }]),
    text: '把这段改成诗',
    onDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.text, '风从西边来');
  assert.equal(result.route, 'p1/m1');
  assert.deepEqual(deltas, ['  风从西边来  ']);
});

test('streamText returns null when no model route is mounted', async () => {
  const result = await streamText({ llm: null, text: 'x' });
  assert.equal(result, null);
});

test('a failed stream throws after the deltas already forwarded', async () => {
  const seen = [];
  await assert.rejects(
    () =>
      streamText({
        llm: fakeLlm([
          { type: 'text-delta', text: '前半' },
          { type: 'finish', reason: { kind: 'error', failure: { message: '模型超时', code: 'TIMEOUT' } } },
        ]),
        text: 'x',
        onDelta: (delta) => seen.push(delta),
      }),
    (error) => error.code === 'TIMEOUT' && /模型超时/.test(error.message),
  );
  assert.deepEqual(seen, ['前半'], 'the page keeps what was already written');
});
