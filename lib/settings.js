/**
 * One place for the plugin's user-facing settings.
 *
 * Two rules shape this module:
 *
 * 1. The plugin never stores credentials. It only names a `provider/model`
 *    pair; the host's LLM service owns the key and the request.
 * 2. A setting written by the GUI wins over the deployment-time profile patch
 *    (`cordis.patch.yml`), so a stale operator pin cannot silently override a
 *    choice the user just made.
 *
 * @module ncm-plugin/settings
 */

import { generateText, resolveRoute } from './model.js';

/** Provider/model names come from the host catalogue, so they are plain strings. */
const MAX_NAME = 120;

const QUALITY_LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : fallback;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function int(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : null;
}

/**
 * Validate a partial settings update.
 *
 * Anything unknown is dropped rather than rejected — a page from an older
 * build keeps working after the shape grows. `issues` reports what was
 * ignored so the route can echo it, which is also what a test asserts.
 *
 * @param {object} patch raw request body
 * @param {object} current current `settings` object
 * @returns {{patch: object, issues: string[]}}
 */
export function normalizeSettingsPatch(patch = {}, current = {}) {
  const issues = [];
  const next = {};

  if (patch.model && typeof patch.model === 'object') {
    const provider = text(patch.model.provider);
    const model = text(patch.model.model);
    if (provider && model) next.model = { provider, model };
    else if (!provider && !model) next.model = { provider: '', model: '' };
    else issues.push('model 需要 provider 和 model 同时提供，或同时留空');
  }

  if (patch.level !== undefined) {
    const level = text(patch.level);
    if (level === '') next.level = '';
    else if (QUALITY_LEVELS.has(level)) next.level = level;
    else issues.push(`未知音质档：${level}`);
  }

  if (patch.scrobble !== undefined) {
    const flag = bool(patch.scrobble);
    if (flag === null) issues.push('scrobble 必须是 true / false / null');
    else next.scrobble = flag;
  }

  if (patch.dj && typeof patch.dj === 'object') {
    const dj = {};
    const enabled = bool(patch.dj.enabled);
    if (enabled !== null) dj.enabled = enabled;
    if (patch.dj.prompt !== undefined) dj.prompt = text(patch.dj.prompt, '');
    const batch = int(patch.dj.batchSize, 1, 20);
    if (batch !== null) dj.batchSize = batch;
    const threshold = int(patch.dj.autoExtendBelow, 0, 50);
    if (threshold !== null) dj.autoExtendBelow = threshold;
    if (Object.keys(dj).length > 0) next.dj = dj;
  }

  if (patch.ui && typeof patch.ui === 'object') {
    // The appearance work is P7; accept the fields now so the page can save
    // them, but the pages do not read them yet.
    const ui = {};
    const template = text(patch.ui.template);
    if (['auto', 'dark', 'light'].includes(template)) ui.template = template;
    const scale = Number(patch.ui.fontScale);
    if (Number.isFinite(scale)) ui.fontScale = Math.min(1.3, Math.max(0.85, Math.round(scale * 100) / 100));
    if (Object.keys(ui).length > 0) next.ui = ui;
  }

  for (const key of Object.keys(patch)) {
    if (!['model', 'level', 'scrobble', 'dj', 'ui'].includes(key)) issues.push(`未知设置项：${key}`);
  }

  // Keep the legacy DJ picker fields in step with the unified choice, so an
  // older panel (or a downgrade) still reads a coherent route.
  if (next.model) {
    next.djProvider = next.model.provider;
    next.djModel = next.model.model;
  }

  return { patch: next, issues };
}

/** Read the unified choice out of a settings object, if one was made. */
export function savedModel(settings) {
  const provider = text(settings?.model?.provider);
  const model = text(settings?.model?.model);
  return provider && model ? { provider, model, source: 'settings' } : null;
}

/**
 * The model route the plugin should use for its own leaf calls: the saved
 * choice, then the model the current conversation runs on, then whatever the
 * host lists first (the caller decides whether to use that last resort).
 *
 * @returns {{provider: string, model: string, source: string} | null}
 */
export function preferredModel({ settings, readAgentDefault }) {
  const saved = savedModel(settings);
  if (saved) return saved;
  try {
    const inherited = readAgentDefault?.();
    if (inherited?.provider && inherited.model) {
      return { provider: inherited.provider, model: inherited.model, source: 'agent-default' };
    }
  } catch {
    /* a missing host service is not an error here */
  }
  return null;
}

/**
 * The host's provider/model catalogue, shaped for a picker.
 *
 * @returns {Promise<{providers: Array<{provider: string, models: string[]}>, error: string | null}>}
 */
export async function modelCatalog(llm) {
  if (!llm?.listProviders) return { providers: [], error: '宿主没有提供模型服务' };
  let entries = [];
  try {
    entries = llm.listProviders() ?? [];
  } catch (error) {
    return { providers: [], error: `读不到 provider 列表：${error.message}` };
  }
  const providers = [];
  for (const entry of entries) {
    const provider = entry?.id ?? entry?.provider;
    if (!provider) continue;
    let models = [];
    try {
      const listed = (await llm.listModels?.(provider)) ?? [];
      models = listed
        .map((item) => item?.id ?? item?.model)
        .filter((value) => typeof value === 'string' && value);
    } catch {
      models = [];
    }
    providers.push({ provider: String(provider), models });
  }
  return { providers, error: providers.length === 0 ? '宿主没有已注册的 provider' : null };
}

/** What the plugin will actually use, with the reason, for the settings page. */
export async function effectiveModel({ settings, readAgentDefault, llm }) {
  const preferred = preferredModel({ settings, readAgentDefault });
  if (preferred) return { ...preferred, note: null };
  const discovered = await resolveRoute(llm, {});
  if (discovered) {
    return { ...discovered, source: 'discovered', note: '没有保存选择，也没有会话模型，暂用宿主列出的第一个' };
  }
  return { provider: '', model: '', source: null, note: '还没有可用的模型' };
}

/**
 * Send one tiny prompt through a route, so the settings page can prove a
 * choice works before the user walks away from it.
 *
 * @returns {Promise<{ok: boolean, provider: string, model: string, text?: string, error?: {code: string, message: string}}>}
 */
export async function testModel(llm, { provider, model }) {
  try {
    const answer = await generateText({
      llm,
      provider,
      model,
      sessionId: 'ncm-settings-test',
      text: '只回两个字：可以',
      timeoutMs: 30_000,
    });
    if (!answer) {
      return { ok: false, provider, model, error: { code: 'NO_MODEL', message: '没有可用的模型路由' } };
    }
    return { ok: true, provider: answer.route?.provider ?? provider, model: answer.route?.model ?? model, text: answer.text.trim().slice(0, 40) };
  } catch (error) {
    return {
      ok: false,
      provider,
      model,
      error: { code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 400) },
    };
  }
}
