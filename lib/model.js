/**
 * Leaf model calls for features that only need one plain-text answer
 * (lyric remix). The DJ owns curation; this module reuses the same request
 * envelope and identity so the plugin makes exactly one kind of provider call.
 *
 * @module ncm-plugin/model
 */

import { curationRequest } from './dj.js';

/**
 * Collect a text answer from an LLM stream, surfacing provider failures.
 * Mirrors the DJ's collector: `text-delta` chunks append text, `finish` and
 * `error` chunks carry the failure when there is one. When `onDelta` is given
 * every chunk is forwarded as it arrives, so a caller can paint the answer
 * while it is still being written.
 *
 * @param {AsyncIterable<object>} stream
 * @param {{onDelta?: (delta: string) => void}} [options]
 * @returns {Promise<string>}
 */
export async function collectStream(stream, { onDelta } = {}) {
  let text = '';
  let failure = null;
  if (!stream) return text;
  for await (const chunk of stream) {
    const type = chunk?.type ?? chunk?.kind;
    if (type === 'text-delta') {
      const delta = chunk.text ?? '';
      text += delta;
      if (delta && typeof onDelta === 'function') onDelta(delta);
    } else if (type === 'finish') {
      const reason = chunk?.reason;
      const kind = typeof reason === 'string' ? reason : reason?.kind;
      if (kind === 'error' || kind === 'aborted') {
        failure = { kind, ...(reason?.failure ?? chunk?.failure ?? {}) };
      }
    } else if (type === 'error') {
      failure = { kind: 'error', ...(chunk?.failure ?? {}) };
    }
  }
  if (failure) {
    const code = failure.code ?? failure.name ?? (failure.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN');
    const error = new Error(failure.message ?? (failure.kind ? `stream ${failure.kind}` : 'stream failed'));
    error.code = code;
    error.failure = failure;
    throw error;
  }
  return text;
}

/**
 * Pick the provider route: an explicit pin, else the first provider with a
 * model. Same precedence the DJ uses, minus the agent-default inheritance
 * (a remix is not worth blocking on session model state).
 *
 * @param {object} llm mounted LLM service
 * @param {{provider?: string, model?: string}} [preferred]
 * @returns {Promise<{provider: string, model: string, source: string}|null>}
 */
export async function resolveRoute(llm, { provider, model } = {}) {
  if (!llm?.stream) return null;
  if (provider && model) return { provider, model, source: 'pin' };
  let providers = [];
  try {
    providers = (llm.listProviders?.() ?? []).map((entry) => entry?.id ?? entry?.provider).filter(Boolean);
  } catch {
    providers = [];
  }
  const chosen = provider ?? providers[0];
  if (!chosen) return null;
  let resolved = model;
  if (!resolved) {
    try {
      const models = await llm.listModels?.(chosen);
      resolved = models?.[0]?.id ?? models?.[0]?.model ?? null;
    } catch {
      resolved = null;
    }
  }
  return resolved ? { provider: chosen, model: resolved, source: 'discovered' } : null;
}

/**
 * One leaf call: send `text` and return the answer.
 *
 * @param {{llm?: object, provider?: string, model?: string, sessionId?: string, text: string, timeoutMs?: number}} input
 * @returns {Promise<{text: string, route: string, model: string}|null>} null when no route is mounted.
 */
export async function generateText({ llm, provider, model, sessionId = 'ncm-plugin', text, timeoutMs = 90_000 }) {
  const target = await resolveRoute(llm, { provider, model });
  if (!target) return null;
  const request = curationRequest({
    target,
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  });
  const answer = await collectStream(llm.stream(request, { timeoutMs }));
  return { text: answer.trim(), route: `${target.provider}/${target.model}`, model: target.model };
}

/**
 * One leaf call with live chunks: send `text`, forward every delta, and return
 * the finished answer once the stream ends.
 *
 * @param {{llm?: object, provider?: string, model?: string, sessionId?: string, text: string,
 *          timeoutMs?: number, onDelta?: (delta: string) => void}} input
 * @returns {Promise<{text: string, route: string, model: string}|null>} null when no route is mounted.
 */
export async function streamText({
  llm,
  provider,
  model,
  sessionId = 'ncm-plugin',
  text,
  timeoutMs = 90_000,
  onDelta,
}) {
  const target = await resolveRoute(llm, { provider, model });
  if (!target) return null;
  const request = curationRequest({
    target,
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  });
  const answer = await collectStream(llm.stream(request, { timeoutMs }), { onDelta });
  return { text: answer.trim(), route: `${target.provider}/${target.model}`, model: target.model };
}
