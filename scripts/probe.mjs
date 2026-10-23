#!/usr/bin/env node
/**
 * M0 探针：把 HANDOFF 里的四个未知项一次问清楚，结论直接打印成表格。
 *
 *   V1  账号听歌记录读取   `weapi/v1/play/record`
 *   V2  建歌单             `weapi/playlist/create`
 *   V3  往歌单加曲目       `weapi/playlist/manipulate/tracks`
 *   V4  AI DJ 能否出 plan  读配置 + 给出人工验证步骤
 *
 * 默认只读：V2/V3 只做 dry-run。确认要真写账号时加 --write。
 * cookie 只打印 4 位指纹，绝不落日志、不写入结果文件。
 *
 *   node scripts/probe.mjs            # 只读 + V2/V3 dry-run
 *   node scripts/probe.mjs --write    # 真建一张临时歌单并加一首歌
 *   node scripts/probe.mjs --json     # 额外输出机器可读结论
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Netease, NeteaseError } from '../lib/netease.js';
import { weapiEncrypt } from '../lib/weapi.js';

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const JSON_OUT = args.has('--json');
const ORIGIN = 'https://music.163.com';
const TEMP_PLAYLIST = 'NCM 探针 · 可删';

const sessionPath =
  process.env.NCM_SESSION ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'music', 'session.json');

const report = { startedAt: new Date().toISOString(), sessionPath, results: {}, env: {} };

function line(char = '─') {
  console.log(char.repeat(64));
}

function fingerprint(cookie) {
  const hash = [...String(cookie)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return `len=${String(cookie).length} fp=${hash.toString(16).padStart(8, '0').slice(0, 4)}`;
}

function record(key, status, detail, extra = {}) {
  report.results[key] = { status, detail, ...extra };
  const mark = { OK: '✅', NO: '❌', DRY: '⏭ ', MANUAL: '👀', SKIP: '· ' }[status] ?? '?';
  console.log(`${mark} ${key}  ${detail}`);
}

/** weapi 加密表单请求。 */
async function weapi(api, pathname, payload) {
  const csrf = csrfToken(api);
  return api.call(`${ORIGIN}${pathname}`, {
    method: 'POST',
    query: { csrf_token: csrf },
    body: weapiEncrypt({ ...payload, csrf_token: csrf }),
  });
}

function csrfToken(api) {
  return api.jar?.get?.('__csrf') ?? '';
}

async function main() {
  line('═');
  console.log('M0 探针 · 网易云账号能力核查');
  line('═');

  // ---------------------------------------------------------------- 环境
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  report.env.node = process.versions.node;
  console.log(`node ${process.versions.node}${nodeMajor >= 20 ? ' ✅' : ' ❌ 需要 ≥20'}`);

  if (!fs.existsSync(sessionPath)) {
    line();
    console.error(`找不到 session.json：${sessionPath}`);
    console.error('先在 DSH 侧栏音乐面板扫码登录，再重跑本探针。');
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (cause) {
    console.error(`session.json 解析失败：${cause.message}`);
    process.exit(2);
  }
  const cookie = String(state.cookie ?? '');
  if (!cookie) {
    console.error('session.json 里没有 cookie——还没登录，先去面板扫码。');
    process.exit(2);
  }
  console.log(`session ${sessionPath}`);
  console.log(`cookie ${fingerprint(cookie)} · account=${state.account?.nickname ?? '未知'} uid=${state.account?.uid ?? '未知'}`);
  console.log(`history ${(state.history ?? []).length} 条 · version=${state.version ?? 1} · ${WRITE ? '写模式' : '只读模式（--write 才写账号）'}`);

  const api = new Netease({ cookie, timeoutMs: 20_000 });

  // ------------------------------------------------------------- 账号
  let account = state.account ?? null;
  try {
    account = (await api.fetchAccount()) ?? account;
    record('account', 'OK', `已登录：${account?.nickname ?? '?'} (uid ${account?.uid ?? '?'})`, {
      uid: account?.uid ?? null,
      nickname: account?.nickname ?? null,
    });
  } catch (cause) {
    record('account', 'NO', `fetchAccount 失败：${cause.message}`);
  }

  // ------------------------------------------------------- V1 听歌记录
  line();
  console.log('V1 · 账号听歌记录（play/record，读取）');
  let v1Tracks = [];
  if (!account?.uid) {
    record('V1', 'SKIP', '没有 uid，无法查听歌记录');
  } else {
    try {
      const data = await weapi(api, '/weapi/v1/play/record', {
        uid: account.uid,
        type: 0,
        allData: 'true',
      });
      const all = Array.isArray(data?.allData) ? data.allData : [];
      const week = Array.isArray(data?.weekData) ? data.weekData : [];
      v1Tracks = all;
      const code = String(data?.code ?? '?');
      if (code === '200' && all.length > 0) {
        record('V1', 'OK', `allData ${all.length} 首 / weekData ${week.length} 首，可读`, {
          allData: all.length,
          weekData: week.length,
        });
      } else if (code === '200') {
        record('V1', 'OK', '接口返回 200 但列表为空（账号确实没听过歌，或隐私设置关闭）', {
          allData: 0,
          weekData: week.length,
        });
      } else {
        record('V1', 'NO', `code=${code} ${data?.message ?? ''}`.trim(), { code });
      }
    } catch (cause) {
      record('V1', 'NO', `${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
    }
  }

  // -------------------------------------------------- V2/V3 写歌单
  line();
  console.log(`V2 · 建歌单（playlist/create）   V3 · 加曲目（playlist/manipulate/tracks）`);
  let sampleId = v1Tracks.find((entry) => entry?.songId ?? entry?.id)?.songId ??
    v1Tracks.find((entry) => entry?.songId ?? entry?.id)?.id ??
    null;
  if (!sampleId) {
    try {
      const { tracks } = await api.searchSongs('夜航西飞 陈粒', { limit: 1 });
      sampleId = tracks?.[0]?.id ?? null;
    } catch {
      // 搜索也失败就跳过写测试
    }
  }

  if (!sampleId) {
    record('V2', 'SKIP', '拿不到任何曲目 id，无法构造写测试');
    record('V3', 'SKIP', '同上');
  } else if (!WRITE) {
    record('V2', 'DRY', `将创建歌单「${TEMP_PLAYLIST}」（加 --write 真执行）`, { sampleId });
    record('V3', 'DRY', `将把曲目 ${sampleId} 加进该歌单（加 --write 真执行）`, { sampleId });
  } else {
    let playlistId = null;
    try {
      const created = await weapi(api, '/weapi/playlist/create', {
        name: TEMP_PLAYLIST,
        privacy: '10',
      });
      playlistId = created?.id ?? created?.playlist?.id ?? null;
      if (String(created?.code) === '200' && playlistId) {
        record('V2', 'OK', `建成歌单 id=${playlistId}`, { playlistId });
      } else {
        record('V2', 'NO', `code=${created?.code} ${created?.message ?? ''}`.trim(), {
          code: created?.code,
        });
      }
    } catch (cause) {
      record('V2', 'NO', `${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
    }

    if (!playlistId) {
      record('V3', 'SKIP', '歌单没建成，无从加曲');
    } else {
      try {
        const added = await weapi(api, '/weapi/playlist/manipulate/tracks', {
          op: 'add',
          pid: playlistId,
          tracks: String(sampleId),
          trackIds: JSON.stringify([Number(sampleId)]),
        });
        const code = String(added?.code ?? '?');
        if (code === '200') {
          record('V3', 'OK', `曲目 ${sampleId} 已加入，账号端可见即可用`, { playlistId });
        } else {
          record('V3', 'NO', `code=${code} ${added?.message ?? ''}`.trim(), { code });
        }
      } catch (cause) {
        record('V3', 'NO', `${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
      }
    }

    // 探针建的是真歌单，验完不留垃圾：尽力删掉，删不掉就把 id 打出来让用户手动删。
    // 正确的删除接口是 playlist/remove（playlist/delete 会回 400）。
    if (playlistId) {
      try {
        const removed = await weapi(api, '/weapi/playlist/remove', { ids: `[${playlistId}]` });
        if (String(removed?.code) === '200') {
          report.results.V2.detail += '；临时歌单已删除';
          console.log(`🧹 临时歌单 ${playlistId} 已删除`);
        } else {
          report.results.V2.detail += `；临时歌单 id=${playlistId} 未删掉，请手动删除`;
          console.log(`⚠️ 临时歌单没删掉（code=${removed?.code}），请在网易云里手动删「${TEMP_PLAYLIST}」`);
        }
      } catch (cause) {
        report.results.V2.detail += `；临时歌单 id=${playlistId} 未删掉（${cause.message}），请手动删除`;
        console.log(`⚠️ 删除临时歌单失败：${cause.message}`);
      }
    }
  }

  // ------------------------------------------------------------ V4 DJ
  line();
  console.log('V4 · AI DJ 能否出 plan（只能人工确认）');
  const settings = state.settings ?? {};
  const provider = settings.djProvider || process.env.NCM_DJ_PROVIDER || null;
  const model = settings.djModel || process.env.NCM_DJ_MODEL || null;
  if (provider || model) {
    record('V4', 'MANUAL', `已配置 provider=${provider ?? '默认'} model=${model ?? '默认'}；在面板点「开始 DJ」，队列补满即通过`, {
      provider,
      model,
    });
  } else {
    record('V4', 'MANUAL', '未配置 dj.provider/model（会用 DSH 默认模型）；点「开始 DJ」看队列是否补满', {
      provider: null,
      model: null,
    });
  }

  // ------------------------------------------------------------ 汇总
  line('═');
  const rows = Object.entries(report.results);
  for (const [key, value] of rows) {
    console.log(`${key.padEnd(8)} ${value.status.padEnd(6)} ${value.detail}`);
  }
  line('═');
  console.log('把上面的结论抄进 NOTES.md 的 V1-V4 表，并回填 PLAN.md §6.4 状态列：');
  console.log('  V1 不通 → 周报只用本机历史，页面明示数据来源；');
  console.log('  V2/V3 不通 → 场景页只存本地 + 导出文本，M6 工期 -1.5d；');
  console.log('  V4 不通 → DJ 卡置灰，其余功能照常。');

  const failed = rows.filter(([, value]) => value.status === 'NO').map(([key]) => key);
  report.finishedAt = new Date().toISOString();
  report.failed = failed;

  // 结论落到 dataDir/probe.json，制作者检查台（/music/dev）直接读它显示。
  // 只写结论：cookie 与完整曲目列表都不进文件。
  if (!args.has('--no-save')) {
    const outPath = path.join(path.dirname(sessionPath), 'probe.json');
    try {
      fs.writeFileSync(outPath, JSON.stringify({ ...report, sessionPath: undefined }, null, 2), { mode: 0o600 });
      console.log(`\n结论已写入 ${outPath}（检查台 /music/dev 会读它）`);
    } catch (cause) {
      console.error(`结论写盘失败：${cause.message}`);
    }
  }

  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((cause) => {
  if (cause instanceof NeteaseError) {
    console.error(`探针中断：${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
  } else {
    console.error('探针中断：', cause);
  }
  process.exit(1);
});
