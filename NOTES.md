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
| 曲库页（登录后看歌单） | 🚧 | 服务端 `GET /music/api/library` 已通（真账号返回 created 47 / liked / collected 60 / recent 14 / daily 6）；页面 `lib/ui/library.html` 由 libbuilder 写 |
| 端到端冒烟 | ✅ | `test/plugin.test.mjs`，`node --test` **37/37** |
| M0 探针脚本 | ✅ | `scripts/probe.mjs`（只读默认，`--write` 才写账号） |
| 本地可复用测试数据 | ✅ | `scripts/fixture.mjs --out %TEMP%\ncm-demo`（213 条播放 / 20 首标签 / 1 条 dislike） |
| 打包装备 | ✅ | `npm pack` → `ncm-plugin-0.1.0.tgz`（35 files，197 KB） |

跑测试与探针：

```powershell
cd music-plugin
node --test --test-isolation=none "test/*.test.mjs"
node scripts/preview.mjs --keep                              # 五屏本地预览
node scripts/fixture.mjs --out "$env:TEMP\ncm-demo"          # 造演示数据
node scripts/preview.mjs --data-dir "$env:TEMP\ncm-demo" --port 7789 --keep
node scripts/probe.mjs                                       # 需先扫码登录；只读 + V2/V3 dry-run
node scripts/probe.mjs --write                               # 真建一张临时歌单验 V2/V3
```

## 0.2 H5 实测：登录成功但页面无内容（2026-10-22）

用户反馈原话：“我在后h5版本的测试,登录后主页面没有任何反应,也没有歌单列表之类.以后我的测试都会在h5版本,现在请先优化。”

- 观察：`%TEMP%\ncm-demo\session.json` 里 `version 2`、`account 喝水去喝水`、`uid 562295789`、`cookieLen 937`、`history 213` → **扫码登录本身是通的**，cookie 也落盘了。
- 根因（设计缺口，不是 bug）：基座面板登录后只有「播放器 + 队列」，没有曲库/歌单浏览；H5 用户登录后自然找不到歌单。
- 处置：新增 `GET /music/api/library`（账号歌单三分组 + 最近播放 + 每日推荐，未登录 401 `NO_ACCOUNT`）、`lib/ui/library.html` 曲库页、面板 header 加「曲库」入口、未播放时显示「去曲库挑一张歌单 →」、扫码成功且没有在播时自动跳到曲库。
- 另记：DSH GUI（端口 63734）的 `/music/health` 是 404——**插件还没装进 desktop profile**，H5 测试目前跑的是 `scripts/preview.mjs`（7789），不是 DSH 本体。

## 1. M0 四个未知项

| # | 未知 | 验证方式 | 结论 | 证据（请求 / 响应 / 观察） |
|---|---|---|---|---|
| V1 | `play/record` 读听歌记录 | `GET /weapi/v1/play/record?uid=&type=0\|1` | 待验证 | |
| V2 | `playlist/create` 建歌单 | 真 cookie 打接口，看返回 `code` | 待验证 | |
| V3 | `playlist/manipulate/tracks` 加曲目 | 同上 | 待验证 | |
| V4 | DJ 模型路由能否真出 plan | 配 `dj.provider/model`，面板「开始 DJ」 | 待验证 | |

**降级预案**：
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
