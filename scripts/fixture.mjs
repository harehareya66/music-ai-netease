#!/usr/bin/env node
/**
 * 造一份演示数据（开发/验收用，不属于插件运行时）。
 *
 *   node scripts/fixture.mjs --out %TEMP%\ncm-demo
 *   node scripts/preview.mjs --data-dir %TEMP%\ncm-demo --port 7789 --keep
 *
 * 生成：
 *   session.json         v2 结构，含 6 周播放历史、画像缓存、本周周报、1 条 dislike
 *   cache/tags.json      曲目标签缓存（语言/BPM/年代），TasteStore 与画像共用
 *
 * 数据是合成的，只为看版式：artist/曲名借现实中的组合，不代表真听过。
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : path.join(process.env.TEMP ?? '/tmp', 'ncm-demo');
const now = Date.now();
const DAY = 86_400_000;

const TRACKS = [
  ['夜航西飞', '陈粒', '华语', 78, 2019],
  ['秦皇岛', '万能青年旅店', '华语', 96, 2010],
  ['披星戴月的想你', '告五人', '华语', 104, 2018],
  ['山海', '草东没有派对', '华语', 118, 2016],
  ['水星记', '郭顶', '华语', 72, 2016],
  ['东北民谣', '毛不易', '华语', 84, 2020],
  ['关于郑州的记忆', '李志', '华语', 88, 2009],
  ['雨的印记', 'Yiruma', '其他', 66, 2001],
  ['南山南', '马頔', '华语', 76, 2014],
  ['海阔天空', 'Beyond', '粤语', 84, 1993],
  ['陀螺', '万晓利', '华语', 92, 2010],
  ['晚安', '丢火车', '华语', 70, 2013],
  ['The Night We Met', 'Lord Huron', '英语', 82, 2015],
  ['Fix You', 'Coldplay', '英语', 138, 2005],
  ['夜に駆ける', 'YOASOBI', '日语', 130, 2019],
  ['First Love', '宇多田ヒカル', '日语', 90, 1999],
  ['夏夜晚风', '伍佰 & China Blue', '华语', 74, 1996],
  ['孤独患者', '陈奕迅', '粤语', 108, 2011],
  ['这一生关于你的风景', '枯木逢春', '华语', 80, 2018],
  ['雨天的下午', 'Nujabes', '其他', 88, 2005],
];

const PLAYLIST_SOURCE = ['search', 'scene', 'dj', 'library', 'manual'];

function track(i) {
  const [name, artist, language, bpm, year] = TRACKS[i % TRACKS.length];
  return {
    id: 100000 + i,
    name,
    artist,
    artists: [artist],
    language,
    bpm,
    year,
    album: { name: `${name} · 单曲`, picUrl: null },
    duration: 210_000 + ((i * 17) % 90) * 1000,
  };
}

/** 每天听 3-8 首，周末多、深夜多；重复播放最近 5 天的主打。 */
function buildHistory() {
  const history = [];
  const favourites = [0, 1, 4, 8, 2];
  for (let day = 41; day >= 0; day -= 1) {
    const date = new Date(now - day * DAY);
    const weekend = [0, 6].includes(date.getDay());
    const count = (weekend ? 5 : 3) + ((day * 7) % 4);
    for (let n = 0; n < count; n += 1) {
      const pick = n % 3 === 0 ? favourites[day % favourites.length] : (day * 5 + n) % TRACKS.length;
      const base = track(pick);
      const at = new Date(now - day * DAY);
      at.setHours(22 + (n % 2), (n * 13) % 60, 0, 0);
      if (at.getTime() > now) at.setTime(now - 60_000 * (n + 1));
      const skipped = (day + n) % 11 === 0;
      history.push({
        ...base,
        at: at.getTime(),
        playedMs: skipped ? 25_000 : base.duration,
        completed: !skipped,
        skipped,
        source: PLAYLIST_SOURCE[(day + n) % PLAYLIST_SOURCE.length],
        reason: null,
        feedback: skipped ? 'disliked' : (day + n) % 7 === 0 ? 'liked' : 'none',
      });
    }
  }
  return history.sort((a, b) => b.at - a.at).slice(0, 2000);
}

function buildTags() {
  const cache = {};
  for (let i = 0; i < TRACKS.length; i += 1) {
    const item = track(i);
    cache[item.id] = {
      genres: [item.language === '英语' ? '独立流行' : '民谣'],
      tags: [item.bpm < 85 ? '深夜' : '通勤', '怀旧'],
      language: item.language,
      bpm: item.bpm,
      year: item.year,
      updatedAt: now,
    };
  }
  return { version: 1, savedAt: now, cache };
}

const history = buildHistory();
const tags = buildTags();

fs.mkdirSync(path.join(out, 'cache'), { recursive: true });
fs.writeFileSync(
  path.join(out, 'session.json'),
  JSON.stringify(
    {
      version: 2,
      cookie: '',
      account: { uid: 0, nickname: '演示账号', avatar: null, vip: false },
      savedAt: now,
      settings: { level: 'exhigh', djEnabled: false, djPrompt: '', scrobble: true },
      player: { volume: 0.62, muted: false, quality: 320 },
      history,
      feedback: {
        likes: history.filter((entry) => entry.feedback === 'liked').map((entry) => entry.id),
        dislikes: [],
        skips: history.filter((entry) => entry.skipped).map((entry) => entry.id),
      },
      boosts: [],
      dislikes: { [track(3).id]: now - 2 * DAY },
      profile: { version: 1, generatedAt: 0, ranges: {} },
      reports: {},
      queue: { tracks: [], index: 0 },
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(out, 'cache', 'tags.json'), JSON.stringify(tags, null, 2));

console.log(`演示数据已写入 ${out}`);
console.log(`  播放记录 ${history.length} 条 · 标签 ${Object.keys(tags.cache).length} 首 · dislike 1 首`);
console.log(`  node scripts/preview.mjs --data-dir ${out} --port 7789 --keep`);
