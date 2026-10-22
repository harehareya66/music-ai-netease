/**
 * Song-tag cache on disk (`$DSH_HOME/music/cache/tags.json`).
 *
 * The pure logic lives in `core/tags.js`; this class only owns I/O and the
 * wiki lookups that fill the cache. Tags make the profile and the weekly
 * report computable without re-fetching the wiki every time.
 *
 * @module ncm-plugin/tagstore
 */

import fs from 'node:fs';
import path from 'node:path';

import { missingTagIds, putTags, tagsOf, trimCache } from './core/tags.js';

export class TagStore {
  /**
   * @param {{file: string, logger?: object, saveDelayMs?: number}} options
   */
  constructor({ file, logger, saveDelayMs = 2_000 }) {
    this.file = file;
    this.logger = logger;
    this.saveDelayMs = saveDelayMs;
    this.cache = {};
    this.timer = undefined;
  }

  /** Read the cache; a missing or corrupt file starts empty. */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cache = parsed && typeof parsed === 'object' ? (parsed.cache ?? parsed) : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.(`[music] tag cache unreadable, starting empty: ${error.message}`);
      }
    }
    return this.cache;
  }

  save() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      const body = { version: 1, savedAt: new Date().toISOString(), cache: this.cache };
      fs.writeFileSync(temp, `${JSON.stringify(body)}\n`, 'utf8');
      fs.renameSync(temp, this.file);
    } catch (error) {
      this.logger?.warn?.(`[music] could not save tag cache: ${error.message}`);
    }
  }

  touch() {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  close() {
    this.save();
  }

  /** One track's cached tags, or null. */
  get(id) {
    return tagsOf(this.cache, id);
  }

  /** Whole cache (track id → tags), for the pure aggregators. */
  all() {
    return this.cache;
  }

  /** Ids the cache cannot answer for, newest-first order. */
  missing(history, limit = 40) {
    return missingTagIds(history, this.cache, limit);
  }

  put(id, wiki, now = Date.now()) {
    putTags(this.cache, id, wiki, { now });
    trimCache(this.cache, { now });
    this.touch();
  }

  /**
   * Fetch wiki facts for ids and cache them, bounded concurrency.
   * Failures are per-track and never abort the batch.
   *
   * @param {object} api Netease client (`songInfo` required)
   * @param {number[]} ids
   * @param {{concurrency?: number}} [options]
   * @returns {Promise<number>} how many entries were added
   */
  async ensure(api, ids = [], { concurrency = 3 } = {}) {
    const queue = [...new Set(ids.map(Number).filter(Number.isFinite))];
    let stored = 0;
    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const info = await api.songInfo(id);
          this.put(id, {
            genres: info.genres,
            tags: info.tags,
            language: info.language,
            bpm: info.bpm,
            year: info.album?.publishTime ? new Date(info.album.publishTime).getFullYear() : null,
          });
          stored += 1;
        } catch (error) {
          this.logger?.debug?.(`[music] wiki lookup failed for ${id}: ${error.message}`);
        }
      }
    });
    await Promise.all(workers);
    return stored;
  }
}
