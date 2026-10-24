# NOTES · 实测记录与踩坑（从 M0 开始记）

> 规则：每条结论都要能追溯到「请求 / 响应 / 观察」三者之一。没有证据的写"未验证"。
> M0 结束后把 V1-V4 的结论回填到 `PLAN.md` §6.4 的状态列。

## 0. 环境快照

| 项 | 值 | 记录时间 |
|---|---|---|
| OS | Windows 10/11 | 2026-10-22 |
| node / npm | v24.19.0 / 11.17.0 | 2026-10-22 |
| git | 2.56.0 | 2026-10-22 |
| DSH_HOME | `C:\Users\19825\.dsh` | 2026-10-22 |
| 原版基座 | 源码已复制进本仓 `lib/`（来自 `.reference/doitian-v1.2.0`，9,225 行）；**尚未装进 DSH profile** | 2026-10-22 |
| 登录态 | 未登录（`~/.dsh/music/session.json` 不存在） | 2026-10-22 |
| 本仓包名 | `ncm-plugin@0.1.0`，零运行时依赖，`node --test` | 2026-10-22 |
| 预览服务器 | `scripts/preview.mjs`（假 ctx + 真 HTTP），无需装 DSH 即可看五屏 | 2026-10-22 |

## 0.1 MVP 当前状态（2026-10-22 16:20）

| 块 | 状态 | 证据 |
|---|---|---|
| 基座复制（播放内核 / 扫码登录 / DJ / SSE） | ✅ | `lib/{index,client,router,state,playback,dj,feed,session,netease,likes,weapi}.js` 对齐 v1.2.0 |
| L3/L4 纯模块（models/history/tags/taste/report/scene/lyric） | ✅ | `lib/core/`，零 ctx/fs/fetch |
| session v2 + 迁移 + cookie 0600 | ✅ | `lib/session.js`：`migrateSession`、`save()` 先 chmod 后 rename |
| 聚合层（features/model/tagstore） | ✅ | `lib/features.js`、`lib/model.js`、`lib/tagstore.js` |
| 6 个新工具 | ✅ | `lib/tools/features.js`，共 13 个工具 |
| 4 个页面路由 + API | ✅ | `lib/router.js`：`/music/taste|weekly|scene|lyric`、`api/taste|report|scene|lyric` |
| 四页 HTML（`lib/ui/`） | ✅ | taste 672 / weekly 673 / scene 821 / lyric 834 行；1600 与 1100 两档截图验收 |
| 面板中文 + 四入口 | ✅ | `lib/panel.html`：`detectLang()` 恒 `zh`；header `feature-nav`；1100 宽不溢出 |
| 曲库页（登录后看歌单） | ✅ | `lib/ui/library.html` + `GET /music/api/library`（真账号 created 47 / liked 4458 / collected 60 / recent 15 / daily 6）；未登录 401 空态；1100 单列 |
| 制作者检查台 | ✅ | `/music/dev` + `GET /music/api/dev`：环境、探针结论、12 项功能自检、六页入口、人工清单 |
| 端到端冒烟 | ✅ | `test/plugin.test.mjs`，`node --test` **38/38** |
| M0 探针脚本 | ✅ | `scripts/probe.mjs`（只读默认，`--write` 才写账号）；结论写入 `<dataDir>/probe.json`，检查台直接读 |
| 本地可复用测试数据 | ✅ | `scripts/fixture.mjs --out %TEMP%\ncm-demo`（213 条播放 / 20 首标签 / 1 条 dislike） |
| 打包装备 | ✅ | `npm pack`（37 files 左右，含 `lib/ui/dev.html`） |

跑测试与探针：

```powershell
cd music-plugin
node --test --test-isolation=none "test/*.test.mjs"
node scripts/preview.mjs --keep                              # 五屏本地预览
node scripts/fixture.mjs --out "$env:TEMP\ncm-demo"          # 造演示数据
node scripts/preview.mjs --data-dir "$env:TEMP\ncm-demo" --port 7789 --keep
node scripts/probe.mjs                                       # 需先扫码登录；只读 + V2/V3 dry-run
node scripts/probe.mjs --write                               # 真建一张临时歌单验 V2/V3（验完自动删）
```

装了 DSH 之后，检查台在侧栏音乐面板右上「检查台」，或直接开 `http://127.0.0.1:<port>/music/dev`。

## 0.2 H5 实测：登录成功但页面无内容（2026-10-22）

用户反馈原话：“我在后h5版本的测试,登录后主页面没有任何反应,也没有歌单列表之类.以后我的测试都会在h5版本,现在请先优化。”

- 观察：`%TEMP%\ncm-demo\session.json` 里 `version 2`、`account 喝水去喝水`、`uid 562295789`、`cookieLen 937`、`history 213` → **扫码登录本身是通的**，cookie 也落盘了。
- 根因（设计缺口，不是 bug）：基座面板登录后只有「播放器 + 队列」，没有曲库/歌单浏览；H5 用户登录后自然找不到歌单。
- 处置：新增 `GET /music/api/library`（账号歌单三分组 + 最近播放 + 每日推荐，未登录 401 `NO_ACCOUNT`）、`lib/ui/library.html` 曲库页、面板 header 加「曲库」入口、未播放时显示「去曲库挑一张歌单 →」、扫码成功且没有在播时自动跳到曲库。
- 另记：DSH GUI（端口 63734）的 `/music/health` 是 404——**插件还没装进 desktop profile**，H5 测试目前跑的是 `scripts/preview.mjs`（7789），不是 DSH 本体。

## 0.3 制作者检查台（2026-10-23）

给开发验收用的页面，`GET /music/dev`（数据来自 `GET /music/api/dev`，都是只读；自检会真的打接口，但只打读接口，唯一有副作用的是场景草稿——它只读候选池，不写账号、不落盘）。

| 卡 | 内容 |
|---|---|
| 环境 | 账号/uid/VIP、数据目录、session 版本与历史条数/黑名单/周报数、13 个工具名、DJ 模型与来源、喜欢缓存、播放上报、写接口开关、探针时间 |
| M0 探针 V1–V3 | 读 `<dataDir>/probe.json`：每项 `通过/不通过/仅演练/跳过/手动` + 一句话结论；没跑过时给出要执行的命令 |
| 功能自检 | 12 项，逐项按钮或「全部运行」：六页 200、`api/state|taste|report|library|lyric|dev`、`POST api/scene` 草稿；显示 HTTP 状态、耗时、摘要（不是裸 JSON） |
| 六个页面 | 播放器/曲库/画像/周报/场景/歌词的直达链接 |
| 人工检查 | A1 播放、A2 切会话不断音、A3 队列、A5 登录、A6 场景、A7 周报、A9 合规——自动测不了的留在这一列 |

面板右上入口是虚线框的「检查台」，故意做得低调（不是给日常听歌用的）。

## 1. M0 四个未知项

| # | 未知 | 验证方式 | 结论 | 证据（请求 / 响应 / 观察） |
|---|---|---|---|---|
| V1 | `play/record` 读听歌记录 | `GET /weapi/v1/play/record?uid=&type=0\|1` | **✅ 可读**（2026-10-23） | `node scripts/probe.mjs`：account 喝水去喝水 uid 562295789；V1 返回 `allData 100 首 / weekData 0 首`。注意 allData 有 100 条上限、weekData 只覆盖本周，历史要跟本地 v2 历史合并去重。 |
| V2 | `playlist/create` 建歌单 | 真 cookie 打接口，看返回 `code` | **✅ 可用**（`--write` 实测） | `weapi/playlist/create {name:'NCM 探针 · 可删',privacy:'10'}` → `code 200`，返回 id（如 18514410813）。删除用 `weapi/playlist/remove {ids:'[id]'}`；`playlist/delete` 会回 400，别用。 |
| V3 | `playlist/manipulate/tracks` 加曲目 | 同上 | **✅ 可用** | `{op:'add',pid,tracks,trackIds}` → `code 200`，账号端歌单里能看到；两次实测都成功。 |
| V4 | DJ 模型路由能否真出 plan | 配 `dj.provider/model`，面板「开始 DJ」 | 待验证（人工） | 探针只能给出配置状态：当前未 pin provider/model，走 DSH 默认路由（`modelSource: discovered`）。需要人在面板点一次「开始 DJ」，看队列是否补满。 |

**M0 结论（2026-10-23）**：V1/V2/V3 全通 → **写歌单能力可用**，场景页「存到我的歌单」可以按 M6 计划接通（先保持置灰到那一版落地）；周报/画像可以「账号历史 + 本机历史」双源合并，界面仍要标明来源。探针结论文件：`<dataDir>/probe.json`，制作者检查台 `/music/dev` 直接读。

**降级预案**（保留，防以后接口变动）：
- V1 不可用 → 周报只用本地历史，界面标明「本机数据 · 换设备会丢」。
- V2/V3 不可用 → 场景歌单只存本地 + 导出文本；M6 工期 -1.5d。
- V4 不可用 → DJ 卡置灰并提示去设置，播放内核照旧。

## 2. 行为快照（M0 采集）

- 工具返回样例：`music_search` / `music_play` / `music_queue` / `music_now_playing` 各一条
- `session.json` v1 实际结构（对照 `PLAN.md` §5.2 的 v2 设计）
- 面板交互清单：页签、按钮、可拖拽区域

## 3. 验收进度（PLAN §7 的 A1-A10）

| 项 | 状态 | 证据 / 备注 |
|---|---|---|
| A1 点歌到出声 ≤3s；音量/静音/音质可达 | ⏳ 待真机 | 面板底栏已有音量条、`极高 320 kbps` 档、`POST /music/api/player` 持久化到 `session.player`；出声要靠真实账号 |
| A2 切会话不断音 | ⏳ 待真机 | 引擎在 shell（`client.js:207`），页面只发指令；需装进 DSH 后实测 |
| A3 13 个工具在对话里可见可调 | ✅ 代码侧 | `test/plugin.test.mjs` 断言 13 个名字 + `/music/health` 返回 13；真机待验 |
| A4 画像四张图有数据、空态不崩 | ✅ | 空态与 213 条 fixture 两种截图都过 |
| A5 周报数字由代码算、口径写清 | ✅ | `buildWeekly` 单测 + 页面「按听歌记录生成」标注；模型只写人话 |
| A6 场景草稿可解释（来源/理由/排除） | ✅ | `来源计分` 卡 + 每首 reason + 「已排除 N 首」 |
| A7 歌词二创有边界说明、不写账号 | ✅ | 底部「只把歌词文本发给模型 · 不发送账号信息与 cookie」；`存到本机笔记` |
| A8 视觉与概念稿一致 | ✅ 基本 | 五屏按概念稿实现；面板本体仍是基座样式（M5 再对齐） |
| A9 合规（不解灰 / cookie 不进日志 / MIT） | ✅ | cookie 只打指纹；`LICENSE` 保留；无解灰代码 |
| A10 1100 / 1400 不横向溢出 | ✅ | taste / lyric 1100 单列截图过；weekly / scene 同法抽测 |

## 4. 踩坑记录

| 时间 | 现象 | 原因 | 处置 |
|---|---|---|---|
| 10-22 | 面板改了中文却没生效 | `panel.html` 在启动时读成常量，preview 进程不重启不刷新 | 重启 preview（真机装 DSH 后同理要重启） |
| 10-22 | 场景草稿完全不贴 brief，来源只有「相似推荐」 | 匿名状态下网易云搜索返回 200 但 0 首；`searchSongs` 不抛错 | `features.js#collectPool` 搜索命中 0 时挂 `draft.warnings`，页面在「来源计分」下红字说明 |
| 10-22 | 画像语言分桶出现「国语」与「华语」两桶 | wiki 里的 `language` 写法不统一 | `core/tags.js` 加 `LANGUAGE_ALIASES` 归一 |
| 10-22 | 歌词页顶部冒出「作词 : 陈粒」等制作行 | 网易云 LRC 头几行是制作信息 | `core/lyric.js#dropCredits` 在服务端就滤掉 |
| 10-22 | YRC 去时间戳把整行文字也删了 | 正则把文字捕获组一起剔了 | 只替换时间戳段，保留文字 |
| 10-22 | 周报「你听了 undefined 小时」 | `peakDay` 只有分钟，模板却读 `hours` | 页面按分钟换算；`buildWeekly` 补 `hours` 字段 |
| 10-22 | 环形图红/青/灰混用，违反用色规则 | 首名高亮没收敛到红 | 类别灰阶 + 仅首名红 + 正向 delta 才用 teal |
| 10-22 | 「存到我的歌单」按钮可按 | D8 未验证写接口前必须置灰 | 页面 disabled + title 说明，服务端另返 501 `UNVERIFIED` |
| 10-22 | 打包后 bundle patch 仍指向旧包名 | 从基座复制来的 `cordis.patch.yml` 未改名 | 改为 `name: 'ncm-plugin'` 后重新 `npm pack` |

## 5. 10-23 交互修复（用户反馈：DJ 入口找不到 / 曲库点完不播 / 曲库太长）

| 问题 | 原因 | 处置（已用 CDP 真点击验证） |
|---|---|---|
| 面板没有「开始 DJ」按钮，只在内部开开关 | 基座只有 `#dj-toggle` 开关，概念稿里的红按钮没实现 | `panel.html` 加 `#dj-start`「开始 DJ」+ 轮询 `api/state` 等 `dj.lastPlanAt` 更新，完成后 toast「AI DJ 补了 N 首：…」；实测队列 500→505、`source: heuristic` |
| DJ 提示里混着英文诊断（`model tier unavailable…`） | 服务端 `plan.vibe` 原样渲染 | 面板改为中文：`+5 首 · 模型没连上，先按相似歌曲、榜单和你的口味兜底`，并提示「想更准：在 AI DJ 模型里选一个可用模型」 |
| 曲库点「播放全部 / 单曲 / 插到下一首 / 每日推荐」后不播，要手动回主页 | 真正出声的引擎在播放器页面，页面只发指令，成功后停在曲库 | `library.html` 新增 `goToPlayer()`（480ms 后跳 `/music/panel`），四类操作成功都调用；CDP 实测点歌后 URL = `/music/panel`、`playing: true`，插下一首后队列 505→506 且 `next = 宝船` |
| 曲库页太长（108 张歌单铺三屏） | 一次渲染全部歌单 | 默认只显示 18 张 + 「显示全部 108 张 / 收起」，卡片 `minmax 140px`；CDP 实测 18→108，按钮文案对 |
| 场景页「试听全部」同样只提示不跳 | 同曲库问题 | `scene.html#previewAll` 成功后 480ms 跳 `/music/panel` |

遗留：`V4`（真模型出 plan）与 `A2`（切会话不断音）必须装进 DSH 才能验；preview 里 DJ 走启发式兜底（相似/榜单/口味），所以「播放列表不变」的印象已消除，但真模型质量要等装包。

## 6. 浮空岛（2026-10-23，用户二次反馈）

用户要「底部加一条浮空岛，播放不跳页而是同步给主页播放列表」，并报「主页音效设置看不到字」。

- 新增 `lib/ui/mini.js`：六页（library/taste/weekly/scene/lyric/dev）通过 `<script src="__BASE__/mini.js" defer>` 共用，路由 `GET /music/mini.js`（`router.js` 新增，每次请求读文件，不缓存）。
- 数据：SSE `GET /api/events` 的 `state` 事件 + 3s 轮询兜底；控制走 `POST /api/control`、`POST /api/taste`、`POST /api/quality`、`POST /api/report`。
- 音频：桌面壳里 `window.parent.__dshMusicEngine.sync` 存在时只做遥控器（音频归壳）；没有壳（preview/H5）时浮空岛自己加载 `/music/playback.js`，在页面内起 `<audio>`。切页前 `pagehide` + `visibilitychange` 用 `sendBeacon` 把真实位置交回服务端，新页按 `reported.position` 续播（同曲只补一次）。
- 控件：封面/歌名/艺人、喜欢、上一首/播放暂停/下一首、进度与时长、队列数（点击回播放器）、音质下拉、静音+音量、打开播放器；1100/720 两档收窄。
- 曲库与场景页不再 `goToPlayer()` 跳页（`library.html` 的播放/插队、`scene.html` 的试听全部），改为浮空岛接管。
- 面板「看不到字」根因：`input, select` 没给 `<option>` 定背景/前景，Chromium 的原生下拉是白底、选项文字继承近白 → 白字白底。`panel.html` 加 `select option, select optgroup { background:#1c1d21; color:#f9fafb; }`；`mini.js` 的音质下拉同样处理。
- CDP 实测：曲库点「播放全部」→ 仍停在 `/music/library`、岛显示「Let Me Go(共创版)」、`audio.paused=false`、`currentTime=3.4s`；跳 `/music/taste` 后岛仍在播同一首（`currentTime` 连续，不是从 0 重来）；暂停/继续/下一首按钮均改变服务端 `playing`/`index`；播放器页不出现浮空岛（`island on panel: false`）；`select option` 计算样式 `color rgb(232,234,237)` / `background rgb(25,28,34)`。
- 测试仍 38/38；`npm pack` 后更新工作区根的 tgz。

## 7. 浮空岛二次修（2026-10-23，用户三次反馈）

用户报三件：① 从其它页回播放器音乐「重新加载」、进度被重置；② 浮空岛两个按钮一个显示成「500」、一个空的；③ 进度条拖不动。

- ① 根因：纯 H5 下每个页面各自持有一个 `<audio>`，跨页导航必然销毁重建，新页面从 0 开始。修法不是杀重建（做不到），而是重建后**接着上一位置**：`lib/panel.html` 的本地 transport 在 `loadedmetadata` 里读 `state.reported`，同一 trackId、位置 >2s 且播放器仍在开头时把 `currentTime` 设到 `reported.position + 距上次上报的时长`；装进 DSH 桌面壳后音频归壳里的引擎，切换页面根本不会重建，这条兜底只在 H5/preview 生效。
- ② `mini.js` 的队列按钮原来把「队列」两个字替换成了数字；`chip` 里的 `<svg>` 没定宽高（默认 300×150 被裁掉）→ 看起来是空按钮。改成 `图标 + 「队列」 + 数字`，并补 `.ncm-island .chip svg{width:15px;height:15px;…}`；窄屏（≤1000px）隐藏数字只留「队列」。
- ③ 进度条原来只是 `<i>` 宽度，不能被拖。加 `<input class="seek" type="range">` 覆盖在进度线上：悬停出现 11px 红点，拖动时实时改时间文字，松手 `POST /api/control {action:'seek', value: ms}`（服务端 `player.seek` 收的是毫秒）。
- CDP 实测：曲库播放中把 seek 拖到 50% → 浮空岛显示 `1:04 / 2:04`、`audio.currentTime=63`；随后打开 `/music/panel` → 新页面 `audio.currentTime=82`（接着放，不是 0）。
- 布局：岛宽 `min(1240px, 100% - 32px)`，`1100/720` 两档收窄；1600 宽下时间/队列/音质/音量/播放器一行排开不挤压；900 宽自动两行。
- 测试 38/38。

## 8. 账号听歌记录接入画像（2026-10-23，M2 续）

M0 的 V1 已证实 `weapi/v1/play/record` 可读（allData 100 首、weekData 0 首）。这一轮把它接进画像：

- `lib/netease.js` 新增 `playRecord(uid)`：走 **music.163.com** 的 weapi（`clientlogusf` 只收日志，拿它请求会 404），返回 `{allData, weekData, code}`；每条是 `{playCount, score, song}`。
- `lib/core/taste.js` 新增 `aggregateCounted(items, tagsById)`：按 `playCount` 当权重累计语言/年代/BPM/标签/艺人，`hours`、`nightShare`、`newRate` 一律为 `null`——账号记录没有时间轴，不编造；`buildAccountProfile()` 产出与本地画像同形的文档（`source:'account'`、`deltas:null`、`repeatRate:null`），`describeCounted()` 输出「账号累计 N 次播放、M 首，偏慢速、偏华语，最常听 X。」
- `lib/features.js`：`accountItems()` 读并缓存账号记录 10 分钟（`accountCache`）；`taste({range:'all'})` 在账号可用且 ≥20 首时优先用账号画像，`dataSource` 标注「账号听歌记录（最近 100 首 · 累计播放次数，不含时间）」；缓存命中时不再把账号画像误标成「本机播放历史」。
- 口径：**不混算**。近 4 周 / 近半年仍用本机历史（有时间和 playedMs），只有「全部」切到账号记录。
- `lib/ui/taste.html`：`newRate`/`repeatRate` 为 null 时显示「—」，底部对比文案改成「账号记录只有累计值，没有上一周期」。
- 实测（真实账号 喝水去喝水 uid 562295789）：`GET /music/api/taste?range=all&refresh=1` → `source:'account'`、plays 19095、tracks 100、avgBpm 103、topArtists 祖娅纳惜 1067 / YOASOBI 986 / 奇然 958；页面截图 `design/shots/mvp/taste-account.png`。
- 新增 `test/taste-account.test.mjs` 4 个用例（权重累计、null 语义、排序、文案），测试 **42/42**。

## 9. 歌单落库（2026-10-23，M6）

M0 的 V2/V3 已验证 `playlist/create` 与 `playlist/manipulate/tracks` 可用，于是把「存到我的歌单」从置灰接到真实写入。

- `lib/netease.js` 新增三个写入方法，共用私有 `#weapiPost()`（带登录 cookie + csrf 的加密 POST，走 `music.163.com`）：
  - `createPlaylist(name)` → `{id, name}`（`/weapi/playlist/create`）；
  - `addPlaylistTracks(playlistId, trackIds)`（`op:'add'`，`trackIds` 是 JSON 字符串）；
  - `removePlaylist(playlistId)` → `/weapi/playlist/remove`（`playlist/delete` 会 400，M0 踩过）。
  - 未登录时本地就抛 `NOT_SIGNED_IN`，不发请求。
- `lib/features.js#saveScene`：账号模式改为「建单 → 追加曲目」，返回 `playlistId`；失败向上抛，由路由映射状态码。
- `lib/index.js`：`write.playlist` 默认 **true**（显式设 false 才回到 501 门禁），并在注释里写明依据是 M0 探针。
- `lib/router.js`：`FEATURE_STATUS` 增 `NOT_SIGNED_IN:401`、`BAD_NAME:400`、`BAD_ARGS:400`。
- `lib/ui/scene.html`：主按钮改「存到我的网易云歌单」，副按钮「只存本地」；提示「会写进你的网易云账号『我的歌单』，随时可删；没登录或写入失败时不会静默改成本地」；401 时提示先去面板扫码；保存后用 `scrollIntoView` 把结果提示滚进视野（浮空岛会挡住页面底部）。
- `lib/ui/dev.html`：写接口一行改读 `dev.config.write.playlist`，开/关两种文案。
- 测试新增 `test/scene-save.test.mjs` 6 例（本地模式不碰账号、建单+去重追加、开关关闭 → UNVERIFIED、空草稿 → EMPTY、默认标题、未登录 → NOT_SIGNED_IN），合计 **48/48**。
- 真实账号 E2E：`POST /music/api/scene/save` 建成 `18514470039`（3 首）后立即 `removePlaylist` 删除；页面路径再建 `18514427272`（25 首）并删除——两次都没留垃圾歌单。

## 10. 场景「试听全部」报 no playable track（2026-10-23 修复）

用户点「试听全部」弹红条 `no playable track`，队列不换。

- 根因：`lib/netease.js#songDetail()` 走 `/api/song/detail?ids=[...]`，该接口现在对即使单次请求也回 `405 操作频繁，请稍候再试`，`songs` 为空 → `/api/scene/preview` 认为没有可播曲目。
- 修法：`songDetail()` 优先打 `/api/v3/song/detail?c=[{"id":...}]`（实测 3 首正常返回），失败再回落旧接口；两处都不行才返回空。
- 顺手把 `/api/scene/preview` 的两条英文报错改成中文。
- 实测：`POST /api/scene/preview {trackIds:[3 首]}` → `{queued:true,count:3}`、`state.playing=true`、`current=孤勇者`、`queue=3`；页面路径「生成 25 首 → 点试听全部」→ 服务端 `true/下雨天/25/index 0`、toast「已加入临时队列，共 25 首」、页面不跳转。

## 11. 歌词二创流式输出（2026-10-23，S3）

- 服务端：`lib/model.js` 新增 `streamText({llm, provider, model, sessionId, text, timeoutMs, onDelta})`，`collectStream(stream, { onDelta })` 在每个 `text-delta` 回吐；`lib/features.js#remix` 收到 `onDelta` 时走流式、否则仍走一次性 `generateText`。
- 路由：`POST /music/api/lyric/remix/stream`，响应 `Content-Type: application/x-ndjson`、`X-Accel-Buffering: no`、`Cache-Control: no-store, no-transform`；每行一个 JSON：`{delta}` … `{done:true, remix}`；流已开始后出错只能写 `{error, code, text}` 再收尾，页面据此保留已生成部分。
- 页面：`lib/ui/lyric.html#streamRemix` 用 `fetch` + `res.body.getReader()` + `TextDecoder` 逐行解析；每个 delta 直接写 `#remixBody`、badge 显示「正在生成… N 字」；点「重新生成」时**先清掉上一版**并显示「生成中」，失败且无部分内容时把上一版还回去——避免用户把旧文案当成新结果。
- 预览：`scripts/preview.mjs --fake-llm` 提供假模型（每 700ms 一行，共 7 行），无需 API key 即可验流式。
- 实测（CDP 采样每 400ms 读 `#remixBody.textContent.length`）：`[18,18,18,18,18,30,30,40,49,49,59,59,64,64]`，结束时 badge「DSH 模型生成 · 4.9s」、无报错；首个 delta 前约 2s 是服务端拉歌词 + 建 prompt 的固定开销。
- 新增 `test/model.test.mjs` 4 例（delta 转发、streamText 路由与 trim、无路由返回 null、失败时已转发 delta 不丢），测试 **52/52**。
- 踩坑：往 HTML 内联 JS 里插 `\n` 被写成真实换行导致整页 `SyntaxError: Invalid or unexpected token`；此后一律用 `String.fromCharCode(10)` 或 `--check` 前先抽脚本验证。

## 12. 歌词多选 + 三种改写补齐（2026-10-23）

用户反馈「行数可以多选，而且改写貌似大多数功能只是占位」。核查结果：确实有两处是占位/坏的：

- **多选**：原来 `state.selection` 是 `{from,to}` 单区间，只能单选或拖一段。改成行号数组：单击选中、再点取消、**Shift 连选**（从锚点连到这里，且不清空已点选的行）、**Ctrl/⌘ 加选**、拖动连选；`#selectedNote` 显示「已选 N 行」。
- **服务端多选**：`lib/core/lyric.js#splitForRemix` 新增 `indexes` 参数（去重、排序、越界丢弃），`lib/features.js` 的 `lyric/remix` 透传，`lib/router.js` 两个 remix 端点接收 `indexes`；返回里带 `sourceIndexes`。
- **翻译是坏的**：`validateRemix` 原来一律要求中文，翻译出的英文会被判 `not-chinese` 打回。加 `requireChinese` 选项，`features.remix` 只在非翻译模式要求中文。
- **藏头是写死的**：prompt 里硬编码「夜航西飞」。现在页面多一个「藏头的话」输入框（选藏头时出现），`buildRemixPrompt(mode, text, style, { head })` 用用户输入，没填直接报 `BAD_ARGS` 并提示先填。
- 短文案（短视频文案）本来就能用；「只改副歌」那颗禁用按钮删掉了，改用「选中的行（可多选）」手动框副歌。
- 测试：新增 2 例（多选 indexes 去重排序越界、翻译允许非中文），**54/54**。
- CDP 实测：点第 2 行 → Ctrl 点第 5 行 → Shift 点第 8 行 → 「已选 5 行」`[2,5,6,7,8]` → 改写成功；翻译成功无报错；藏头出现输入框、填「秋日私语」后流式生成成功。

## 13. S4 面板骨架：第三个页签「画像」（2026-10-23）

- `lib/panel.html` 的详情区页签从「详情 / 歌词」变成「详情 / 歌词 / 画像」。
- 画像页签不跟当前曲目走：`syncInfo()` 里 `infoView === 'profile'` 直接 `renderProfile(false)` 并返回，切歌不重绘。
- `renderProfile(force)`：`GET /api/taste?range=4w` → 一句话摘要 + 前 6 个标签 + 三个数（小时 / 首 / 平均 BPM）+ 「看完整画像 →」（链到 `/music/taste`）；成功缓存 120s；失败显示可点击重试；标签兼容 `{label,count}` 与纯字符串两种返回形状。
- 底栏音量/静音/音质档与队列行 ♡ / ✕ 沿用基座（✕ 对未评级曲目会同时记 dislike，代码注释已写明），这一轮不改语义。
- 新增 `scripts/check-panel.mjs`：抽出 `lib/panel.html` 与 `lib/ui/*.html` 的内联脚本逐个 `new Function` 编译，改面板后先跑它，避免整页 SyntaxError（这个项目已经踩过两次）。
- 实测（CDP）：页签 `["详情","歌词","画像"]`，点开后 `ready=1`、摘要「你是个偏慢速、偏纯音乐、爱在深夜听歌的人…」、标签 6 个、数 `8.9 小时 / 26 首 / 132 BPM`、链接 `/music/taste`；1100 宽不溢出。

## 14. S5 + S6 面板视觉与画像/不喜欢细节（2026-10-23）

视觉（`lib/panel.html` CSS，不动播放逻辑）：
- 封面 `clamp(112px, 24vw, 264px)` + 16px 圆角 + 深投影；歌名 27px；舞台间距放宽。
- AI DJ 卡加暗红描边（`rgba(229,72,77,.34)`）与柔光，和概念稿一致。
- 播放条：play 58px、进度条 5px、滑块带红色光晕；底栏（列表/音质/码率/音量）加一条分隔线。
- 队列行封面 40px、圆角 10、当前行红色渐变底。
- 音质说明改中文：`（无损, 已降级）`，不再直出 `lossless`；`failureText()` 收口英文错误（not found → 「没找到这首歌，可能已下架或需要换一首」）。

画像与不喜欢（S6）：
- 摘要里的数字/百分比自动加粗（`esc(...).replace(/(\d+(?:\.\d+)?%?)/g, '<b>$1</b>')`）。
- 三个指标改独立小卡；「看完整画像 →」改胶囊按钮。
- 队列 ✕ 标题改成「移出队列（没评过级的歌会顺手记一次不喜欢）」，hover 变红；播放条 ✕ 仍是「不喜欢」：CDP 实测点它 → 队列 30→29、自动跳下一首、「不再推荐」toast。

验证：
- CDP：播放/暂停/下一首 `playing false→true→index 0→1→false`；不喜欢后 `queue 30→29`、`current 够钟→初恋`。
- `node scripts/check-panel.mjs` 全过；`node --test` 54/54；1600 / 1100 两档截图无溢出。
- 新增 `VERIFY.md`：S3-S6 的人工验收清单（逐步勾选），地址与启动命令都写在开头。

## 15. S7 装进 DSH desktop profile（2026-10-23）

- 打包：`npm pack` → `ncm-plugin-0.1.0.tgz`（约 237KB，37-38 个文件，含 lib/ui、lib/tools、vendor）。
- 安装方式（和 dsh-push-index 同一条路，不用插件市场）：
  1. tarball 拷到 `~/.dsh/profiles/desktop/packages/ncm-plugin-0.1.0.tgz`（备份了 `package.json.bak-ncm`）；
  2. profile `package.json`：`dependencies["ncm-plugin"] = "file:./packages/ncm-plugin-0.1.0.tgz"`，并把 `ncm-plugin` 追加进 `dsh.profile.bundles`（33 项）；
  3. 用 DSH 自带 pnpm（`C:\Users\19825\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`，v11.28.5）在 profile 目录 `install --prefer-offline`：`+ ncm-plugin 0.1.0`，3.5s 完成；其余插件（dsh-pet / genui / billion-context / cc-safety-net / dsh-ops / modsearch）逐个确认还在。
- 登录态迁移：把 `%TEMP%\ncm-demo\session.json`（cookie 937B、账号 喝水去喝水 uid 562295789、历史 220 条）复制到 `~/.dsh/music/session.json`，`cache/tags.json` 复制到 `~/.dsh/music/cache/tags.json`，装上即可直接是登录态，无需重新扫码。
- 待办：用户重启 DSH 后验 V4 真模型（DJ plan）、A1 音质真实切换、A2 切会话不断音、A3 队列操作；结论回填本文件与 PLAN §6.4。

## 16. S7 真机（DSH desktop profile）验证记录（2026-10-23）

装好后首次启动崩溃：`web boot: 1 entry did not activate` + `ncm-plugin: import failed`，renderer console 最后一行是 `client-modules: duplicate factory registration for "@doitian/dsh-music" (bundle executed twice without invalidate?)`。

- 根因：fork 保留了基座的 client 模块 id。宿主按**包名**加载 client、按**模块 id** 去重，`id` 与包名不一致时同一 bundle 执行两次，第二次注册抛错，web boot 失败。
- 修复：`lib/client.js` 的 `id` 改为 `'ncm-plugin'`（必须等于包名），版本 0.1.1，重新打包并重装进 `~/.dsh/profiles/desktop`。
- 卡巴斯基只报了「勿扰模式 已开启/已关闭」，没有任何拦截记录；当时的 `spawn EPERM` 是我自己起了第二个 DSH 实例导致的，退出重启后恢复。

真机实测（DSH GUI 端口 64456，dataDir `C:\Users\19825\.dsh\music`）：

- `GET /music/panel` 200；`/music/health`：panelContract 2、authenticated、账号 喝水去喝水 uid 562295789 VIP、13 工具齐全、audio last hires FLAC 1,829,357 bps。
- **V4 通过**：默认 session model 是 `deepseek-official/deepseek-flash`，该路由没有凭据（`MISSING_CREDENTIAL: no API key for provider route "deepseek-official"`），DJ 自动降级 heuristic。在面板里把 DJ 模型 pin 到 `deepseek-account/deepseek-flash` 后，`POST /music/api/dj/test` 返回 `{source:'model', route:'deepseek-account/deepseek-flash', vibe:'深夜emo的克制伤感', picked:['富士山下 — 陈奕迅']}` —— **真模型出 plan 成功**。
- **A1 音质档**：`POST /music/api/quality {level:'exhigh'}` → `served:'exhigh', br:320000, type:'mp3', downgraded:true`；再切回 `hires` 恢复正常。
- **A2 切会话不断音（机制层）**：无任何页面打开时，`/api/state.reported` 的 position 在 6 秒内前进 6499ms（引擎在壳里，不依赖页面）。
- 队列 A3：`insert` 200（下一首插入成功）、`remove` 200，均在真机接口上验证。

## 17. GitHub 同步方式（本机 git push 不可用）

这台机器 `github.com:443` 不通（`api.github.com` 通），所以 `git push` 全部失败；另外卡巴斯基做了 TLS 中间人，Node 的 `fetch` 默认校验失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。

同步流程（脚本临时写在 `%TEMP%\ncm-upload.mjs`，需要时重建）：

1. `git ls-files` 列出全部受版本控制的文件（`.reference/` 已在 `.gitignore`）；
2. 逐个 `POST /git/blobs`（base64）→ `POST /git/trees`（全路径条目，无 base_tree）→ `POST /git/commits`（parent = 远端 main）→ `PATCH /git/refs/heads/main`（force）；
3. 运行时加 `NODE_OPTIONS=--use-system-ca`，让 Node 信任系统证书（卡巴斯基根证书）。

仓库：<https://github.com/harehareya66/music-ai-netease>（main）。最近一次同步 commit `d64edbe`，83 个文件。

## 18. P0 预验结论（2026-10-23，六块优化的开工前置）

三件事都验证过，结论写进 `PLAN.md` §6.5，这里存证据。

### ① 壳的版本
`ELECTRON_RUN_AS_NODE=1 "...\DeepSeek Harness.exe" -e "console.log(process.versions)"`：
`electron 44.7.0 / chrome 152.0.7977.130 / node 24.21.0`；本机 Edge 155.0.4283.62。
Document PiP 自 Chromium 116 起支持，API 在；Electron 是否真开原生窗口必须在渲染进程里点一次才能确定，headless Edge 不能当证据 → 留到 P5 首步实测，降级链路已在 PLAN §6.5 写明。

### ② 主题
`app.asar` 里 `@deepseek-ai/dsh-client-ui-theme` 的 README 明确：feature plugin 用 `ctx.theme` 拿快照（`preference` light/dark/system、resolved、`fontSizes`、`fontFamilies`、`revision`），变化走 `theme/change`；页面侧公开令牌前缀 `--dsw-*`。
我们的 `lib/client.js` 现在 `inject = ['slots','locale']`，panel 是 `h('iframe',{src:panelUrl()})`，页面由插件 HTTP 服务提供 → **跨源 iframe 读不到父页 CSS 变量**，必须 client 侧读快照、压成 query 参数 + `postMessage`。定案见 PLAN §6.5。

### ③ 周维度（探针 `%TEMP%\ncm-week-probe.mjs`，真实账号 uid 562295789）
```
type0+allData=true  => code 200, all 100 首, week 0
type0+allData=false => code 200, all 100 首, week 0
type1+allData=true  => code 200, week 100 首, 首条 真夜中のドア 14 次
type0 only          => code 200, all 100 首, week 0
/api/v1/play/record?uid=...        => 400 非 JSON
/api/usertool/play/record?uid=...  => code 404
```
结论：**`type:1` 能拿到本周 100 条（带 playCount，无时间戳）**；`type:0` 拿全部累计。上一周没有端点。周报因此分两栏：本周榜单/次数优先账号，时长/每日/时段/上周对比只用本机历史，缺失就隐藏而不是显示 0。

### 实施排期（用户已批，13 人天）
P0 定案 ✅ → P1 设置与模型底座 2d → P2 二创 v2 2d → P3 AI DJ v2 2d / P4 周报修正 1d（可并行）→ P5 歌词与悬浮窗 2d → P6 安全页与静态检查 1.5d → P7 主题模板 1d → P8 回归发布 1d。

## 19. P1 设置与模型底座（2026-10-23）

### 做了什么
- **新建 `lib/settings.js`**：`normalizeSettingsPatch()`（模型成对、音质 6 档、scrobble 三态、dj.batchSize 1-20、autoExtendBelow 0-50、ui.template auto/dark/light、fontScale 0.85-1.3；未知键记 issues）、`preferredModel()`（settings → 会话默认模型 → null）、`modelCatalog()`、`effectiveModel()`（再回落 `resolveRoute`）、`testModel()`（发「只回两个字：可以」）。
- **`lib/session.js`**：settings 增 `model:{provider:'',model:''}`（空 = 跟随会话）与 `ui:{template:'auto',fontScale:1}`；旧的 `djProvider/djModel` 保留为镜像，写 model 时同步。
- **一条模型路由**：`lib/index.js` 里 AiDj 的 model、`lib/features.js` 的 `remix()` 都改走 `preferredModel()`，不再一个读 `dj.*`、一个读 `config.remix.*`；`config.remix` 只作最后回落。
- **路由**：`GET/POST /music/api/settings`、`POST /music/api/settings/model-test`、页面 `/music/settings`（`PAGE_NAMES` 加 `settings`）；`#settingsView()` 返回 settings/agentDefault/catalog/catalogError/effective/write/dataDir。
- **页面 `lib/ui/settings.html`**：四块——模型（跟随 DSH / 固定某模型 + provider/model 联动 select + 测试按钮）、播放（音质 6 档、播放上报 跟随/开/关）、外观（模板 + 字号 85%-130%，P7 接令牌）、数据与安全（dataDir、写歌单、账号、入口链接）；保存走 POST，issues 逐条提示。面板 feature-nav 加「设置」。
- **测试**：`test/settings.test.mjs` 4 例 + `test/plugin.test.mjs` 设置用例（页面 200、GET 初始形状、POST 持久化与 effective.source、非法 model 400、无 llm 时 model-test ok:false），共 **59/59**；`node scripts/check-panel.mjs` 通过。
- **preview 实测**：POST `/api/settings` → 200，`effective.source:'settings'`；`/api/settings/model-test` → 200 返回文本；截图 `%TEMP%\settings-page.png`、`settings-1100.png`。
- 视觉两点：单选按钮改自绘（空心 / 红圈红点），字号 range 用 `accent-color` 跟随主题红；右上角只显示「已保存」。

### 为什么这么做
P0 定案里「模型两套配置」是二创报「没有可用的模型」的根因；把选择收口到一处后，DJ 与二创共享同一条路由，页面上也能直接看到「现在实际用哪个模型」。

### 踩坑
- 测试 helper `plugin.call(url, method, body)` 是位置参数，先误传对象导致 404；已改。
- 带 SSE 的页面不能加 `--virtual-time-budget` 截图（永远不结束），统一用 CDP 脚本截。
- preview 旧进程会残留占端口，重启前先确认端口释放。

## 20. 侦探：为什么「驴头不对马嘴」+ 假模型自证（2026-10-23）

用户反馈：选中的歌词与输出的诗对不上；无论哪首歌/哪几句/整首，输出都是同一首；藏头不该手输文字。

- **同一首诗的根因**：预览服务器 `scripts/preview.mjs` 的假模型是一段**写死的诗**（`风从西边来的时候…`），完全不看输入。现在改成「按输入回声」：改诗模式逐行回显你这次选中的歌词（最多 7 行），藏头模式用给定的首字逐字生成，第一行明确写「预览假模型：只为验证管道」。同一接口四次调用已能产生四种不同输出。
- **真实的提示词缺陷**（换真模型也会差）：`lib/features.js:501 buildRemixPrompt()` 只把 `source.text` 塞进一句固定指令，不带歌名/歌手、不带全词上下文、不做任何分析；`lib/core/lyric.js:171 validateRemix()` 只查空/超长/行数/是否中文，查不出「和原词无关」。
- **藏头设计错位**：把「藏头要藏什么」做成手输框，既不是从选中歌词来，也不校验每行首字是否真的拼出那句话；3 行选中 + 4 字藏头时更没有约束。

## 21. P2 二创 v2：先读再写、可量化、藏头来自选中行（2026-10-23）

用户反馈「选的歌词和输出驴头不对马嘴，所有歌都输出同一首诗，藏头应该是选歌词而不是打字」，核查后三条都成立：

- **同诗**：`scripts/preview.mjs` 的假模型是写死的七行诗，完全无视输入 —— 这解释了预览里「哪首都是它」。已改成回声式假模型（只用于验证管道，首行标明「预览假模型」）。
- **跑题**：`buildRemixPrompt` 旧版只把选段塞进一句固定指令，没有歌名/整首背景/分析，也没有任何检查。现在分两段：
  - `buildAnalysisPrompt({track,fullText,selectedText})` → 「情绪 / 意象 / 叙事」三行；
  - `buildRemixPrompt({mode,track,selectedText,fullText,lineCount,analysis,style,targetChars,extra})` → 带整首作背景、选中行数、analysis、硬约束（行数≈原文、复用原词 ≥3 处、不整句照抄、不写元话语、翻译输出英文）。
- **可检查**：`lib/core/lyric.js` 新增 `normalizeForCompare` / `bigrams` / `overlapStats(source,answer)` / `extractHeads` / `acrosticReport(answer,targetChars)`。`features.remix()` 返回 `analysis / metrics{overlap,shared,total,echoes} / acrostic{ok,wanted,lines,mismatches} / warnings / retried`；批式路径在 `overlap < MIN_OVERLAP(0.15)` 或藏头错位时带纠正提示重试一次。
- **藏头**：目标默认取**选中行首字**（`acrosticTarget(headChars, head, selectedLines)`），输入框只是覆盖入口，旁边加「用选中行首字」按钮；`headChars` 由页面传服务端，两个 remix 端点都读。
- **页面**：右侧加「AI 怎么读这段」卡 + 一行 meta（重合度 / 复用 / 藏头是否对上 / 重试 / 模型 / 发送行数）+ warnings 红字；徽标对 `preview/*` 路由标「预览假模型（只验管道）」。
- 顺手修：选了行再点模式按钮原先会 early-return 没反应，现在同模式但有选中时按选中重跑。

## 验证
- `test/remix.test.mjs` 8 例（归一化/双字/重合度、首字、藏头报错、目标来源、两个 prompt 的硬约束）；全部 **68/68**。
- API：`POST /api/lyric/remix` 两段不同 selection → 文本不同、analysis 不同、metrics `0.44 / 0.56`、`retried:false`；藏头 `targetChars:"零固固"`、`acrostic.ok:true`。
- CDP（页面）：选第 2/5/8 行（5 行）→ 点「改写成诗」→ `本次发送 5 行`、分析卡「这 5 行…」、meta `与原词重合 68% · 模型 preview/preview-model`；切「藏头」→ 输入框自动填 `零飘你我载`、meta `藏头对上了「零飘你我载」`。截图 `design/shots/mvp/lyric-analysis.png`、`lyric-acrostic.png`。

## 22. P3 AI DJ v2：每批歌说得出为什么，场景可交给 DJ（2026-10-24）

用户原话：「AI DJ 看不出作用、能加歌但不给推荐理由，应该和场景/画像联动」。三处一起改：

- **理由生成**（`lib/dj.js`）：`reasonForPick(track,{topArtists,terms,currentArtists})` 按优先级拼最多三段——boost（你刚说想多听这类 / 尽量避开你不想听的）、口味（你常听 X；没有就「接着 X 听」）、来源标签（`ORIGIN_LABEL`：按你说的搜到 / 你红心过、有一阵没听 / 私人 FM / 和你最近听的歌相似 / 每日推荐 / 新歌速递 / 榜单）、brief 命中（歌名/艺人有「X」）。
- **批次摘要**：`summarizePicks({tracks,terms,prompt,source,route})` → `{summary,mix}`，例如「按「深夜 emo，别太吵」挑了 5 首：和你最近听的歌相似 3 首、按你说的搜到 2 首；容祖儿 占 3 首；模型没连上，用相似/榜单/口味排序」。
- **贯通**：`#parseAnswer` 保留模型给的 `why`；`plan()` 统一产出 `tracks(带 reason) / reasons[{id,name,reason}] / summary / mix`，`topUp()`/`start()` 写进 `player.dj.lastPlan`；`/api/dj/test` 也返回 summary 与 reasons。
- **界面**：面板 DJ 卡多一行 summary + 折叠「▸ 为什么是这些歌」（每条歌名 + 理由，最多 8 条）；`music_dj` 工具的返回与 render 也带 summary 和逐条「— 理由」；`/music/health` 的 dj 段加 `summary`/`reasons`。
- **场景联动**：场景页草稿工具栏新增「交给 DJ 接着放」（title 提示会替换当前队列）→ `POST /api/dj {enabled:true,start:true,prompt:brief,count:12}`，成功 toast「AI DJ 已接手：按这句场景挑 12 首，去播放器看」，失败页内 errorbar；按钮纳入 `setActionsDisabled`。

## 验证
- `test/dj-plan.test.mjs` 6 例（理由优先级、来源标签、brief 命中、空输入、出处分布+艺人、无 brief/heuristic 文案）；全部 **74/74**。
- 预览（假模型 → model tier 降级 heuristic，正好验降级文案）：`POST /api/dj {replan:true}` 后 `summary`「按「深夜 emo，别太吵」挑了 5 首：和你最近听的歌相似 3 首、按你说的搜到 2 首；容祖儿 占 3 首；模型没连上，用相似/榜单/口味排序」、`reasons` 逐条有理由、`mix {similar:3,prompt:2}`；`{start:true,count:12}` 把队列替换成 12 首。
- CDP：面板点「开始 DJ」→ 摘要行出现、展开折叠看到 5 条「歌名 — 理由」；场景页（深链生成 12 首）点「交给 DJ 接着放」→ toast 出现、队列变成 DJ 的 12 首。截图 `design/shots/mvp/panel-dj-why.png`、`scene-to-dj.png`。

## 23. P4 周报修正：本周榜单走账号，时间维度只认本机（2026-10-24）

按 P0 定案（`PLAN.md` §6.5）落到代码：

- **取数**：`lib/netease.js` 的 `playRecord(uid, {type})` 支持 `type:1`（本周 100 首，带 `playCount`，无时间戳）；新增 `weekRecord(uid)`，返回 `{weekData, code}`，为空回退 `allData`。
- **合并**：`lib/core/report.js` 新增 `applyAccountWeek(report, account)` —— 账号榜可用时替换 `topTracks`（≤7）、置 `topSource:'account'`、挂 `account{available, weekKey, plays, tracks, source}`；**时长/每日分布/时段/compare 一律不动**（账号没有时间轴）；本机 `plays===0` 且账号榜可用时，`text` 换成「本周本机没有播放记录；账号本周榜显示 N 次播放、M 首（不含时间），榜单在下面。」
- **选择**：`lib/features.js` 的 `report()` 只在「目标周 = 本周」且账号可用时合并；`accountWeekCache` 10 分钟；`#reportSource()` 给「账号本周记录 + 本机播放历史（榜单来自账号，时长/每日分布来自本机）」。
- **缓存**：`REPORT_CACHE_VERSION = 3`，老形状的 `session.json` 周报缓存自动作废重算（踩过坑：旧缓存让页面一直显示旧榜/未知艺人）。
- **页面**（`lib/ui/weekly.html`）：`#topSource` 行写榜单来源；本机 0 播放时四个数字卡显示「—」并各写原因（本机没记录 / 账号不含时间算不出新歌率、跳过率）；单曲循环卡解释「账号记录只有累计次数、没有时间轴」；每日图提示「本机这一周没有播放记录；账号记录不带时间，画不出每日分布」；峰值/常听时段写「本机没有记录 / 需要本机记录」；分享文本带来源。
- **工具**：`weekly_report` 的返回与描述带榜单来源，账号模式无 loop 时明说原因。
- 坑与修：`#accountWeek` 曾用 `this.api.normalizeTrack`（模块导出，不是实例方法）→ 账号榜显示「未知艺人/无封面」，改为直接 `normalizeTrack(entry.song)`；CDP 截图默认 500×320，需 `Emulation.setDeviceMetricsOverride {width:1600,height:1150}`，且带 SSE 页面不能用 `--virtual-time-budget`。

## 验证
- `test/report-account.test.mjs` 4 例（替换榜单保留时间维度、最多 7 条、不可用回退、不改原对象）；全量 **78/78**。
- 真实账号（uid 562295789）：`GET /api/report?week=this&refresh=1` → `topSource:'account'`、`account{plays:235,tracks:100}`、top1「真夜中のドア〜stay with me」14 次、本机 `metrics{hours:1.2,tracks:28,newTracks:14,skipRate:5.2,plays:55}`、`daily[16,21,25,8,0,0,0]`。
- 账号-only 数据集（`%TEMP%\ncm-acct`，清空 history）：四卡「—」、循环卡与每日图均为说明文案、榜单来自账号、`text` 为账号口径；上周无账号来源且本机为空 → 整页空态。
- 截图：`design/shots/mvp/weekly-account.png`、`weekly-account-only.png`。
