# 两份参考源码评审汇总与路线建议

> 评审对象：
> `kendu76/dsh-music-player@1.0.3`（MIT，1.6 MB）与 `@doitian/dsh-music@1.2.0`（MIT，485 KB）
> 完整证据见 `analysis/kendu76.md`（405 行）与 `analysis/doitian.md`（611 行），两份都带 `文件:行号`。

---

## 0. 结论

**建议走 B′：以 `@doitian/dsh-music` 为基座 fork，把 kendu76 当"零件库"。**

理由三条，都能落到代码上：

1. **doitian 已经把我们最难的三块啃完了**：浏览器音频引擎放 shell（切面板不断音，`lib/client.js:14-25`、`:207`）、页面与引擎的契约版本握手防"双声齐放"（`PANEL_CONTRACT=2`，`lib/client.js:142-168` ↔ `lib/router.js:54`）、状态同步从轮询改 SSE 且解决乱序（`lib/feed.js:38-69`）。这三样自己写要踩一周坑。
2. **kendu76 的壳不可改**：`lib/index.js` 是 1888 行单函数 `serve`（`:3757-5644`）装 94 条路由，`lib/client.js` 是 11848 行单闭包 268 个函数、三套面板复制粘贴（`:7630`「与酷狗同款」）。它值钱的只有 `lib/netease.js`（639 行，零依赖、cookie 全参数注入）。
3. **两者能力互补**：doitian 只读不写（建歌单/加曲目 0 命中），kendu76 的 `netease.js` 恰好有歌单写操作、逐字歌词（`lib/yrc.js`）和限流器（`lib/fetch-limit.js`）。组合起来没有重复劳动。

**不建议**：fork kendu76 整仓再改（改造成本 ★★★★★，还要维护 18k 行不可测代码）；也不建议把新功能塞进 doitian 的 `panel.html`（2498 行单体）。

---

## 1. 它们不是一类东西

| | kendu76 v1.0.3 | doitian v1.2.0 |
|---|---|---|
| 定位 | 全能音频应用：音乐 + 小说 AI 讲书 + 新闻播报 + 网络电台 + QQ/酷狗/网易云三平台 | 专注的网易云播放器 + AI DJ |
| 工具 | 3 个（`music_play`、`news_broadcast`、`news_schedule`）+ systemPrompt 注入 + `shell`/`fs` 权限 | 7 个（search/play/queue/control/dj/now_playing/login） |
| 自研代码 | ~18,000 行（index 6233 + client 11848，另 20 个文件） | ~9,200 行（lib 12 个模块），最大单文件 `panel.html` 2498 行 |
| 结构 | 巨型 if 链 + 单闭包 | 一模块一职责（netease / state / playback / feed / router / dj / session…） |
| 测试 | 无（README 称 500+ 用例，`npm test` 实际 No test files） | 仓库有 `node --test`，**发布包没带 test/**（`package.json:35-40` 只发 lib/） |
| 音频 | 页面内 `<audio>`（`lib/client.js:11153`），切面板随页面卸载而断 | shell 持有引擎，页面只是遥控器；另有 SSE 状态流 |
| 登录 | 网易云 + QQ + 酷狗 多平台扫码 | 网易云扫码，cookie 明文落盘**且无 0600**（`lib/session.js:164`） |
| 播放历史 | 无接口 | **只写不读**：`scrobble.js` 上报 weblog，本地 history 上限 300 条只喂 DJ |
| 歌单写 | 有（add/del），无改描述 | **完全没有**（`README.md:129` 自认） |
| 标签数据 | `getLyric` + `yrc.js` 逐字歌词 | `parseSongWiki` 能解析 genres/tags/language/bpm（`lib/netease.js:235-269`）—— L2 打标签的数据源现成 |
| 合规 | 每模块头部明确"违反平台 ToS、严禁解灰"（`lib/netease.js:18-19`） | README 声明非官方接口，无解灰能力 |

---

## 2. kendu76：值 30 KB，不值 1.6 MB

**值得搬（MIT 可商用，保留版权头）**

| 文件 | 行数 | 用途 | 独立可用？ |
|---|---|---|---|
| `lib/netease.js` | 639 | 网易云接口层：25 个导出、三套加密（weapi/linuxapi/eapi）、零 npm 依赖 | ✅ 必须连 `lib/vendor/qrcode.mjs`（2237 行）一起，保持 `./vendor/` 相对路径 |
| `lib/yrc.js` | 72 | 逐字歌词解析 `parseYrc`（歌词二创必需） | ✅ 零依赖 |
| `lib/fetch-limit.js` | 84 | `createLimiter({maxConcurrent,minGapMs,maxQueue})`（场景歌单批量请求用） | ✅ 零依赖 |

移植要改 5 处（都在 netease.js 内部）：`getDownloadURL` 音质参数写死 `br:999000`（`:509`）、无播放记录接口、`search` limit 写死 30（`:213`）、`assertOk` 抛裸 `Error`（`:146-154`）、weapi 随机 secret 不可注入（单测无法固定输出）。

**不值得搬**：`index.js`（1888 行 serve，插新路由成本高于重写）、`client.js`（11848 行单闭包，加面板会变成第四份复制的面板）、以及小说/TTS/新闻/电台/QQ/酷狗整条线（我们不需要）。

---

## 3. doitian：契约是真资产，但有四个硬缺口

**可直接抄的资产（按性价比）**

| 资产 | 位置 |
|---|---|
| 客户端模块契约 + 引擎/页面握手 | `lib/client.js:40-48`、`:126-395` |
| SSE 状态流（visibleKey 去重 + 单调 version） | `lib/feed.js` 全文 |
| 工具包装器（plain object + JSON Schema） | `lib/index.js:87-109` |
| 网易云只读接口层 | `lib/netease.js:407-902` |
| 历史 / 口味 / 反馈模型 | `lib/session.js:108-451` |
| 缓存 / 取样 / 节流 | `lib/cache.js` 全文 |
| 红心缓存语义 | `lib/likes.js` 全文 |
| 扫码登录状态机 | `lib/session.js:454-563` + `lib/netease.js:883-916` |
| 播放上报（周报数据源之一） | `lib/scrobble.js` + `lib/netease.js:723-745` |

**四个硬缺口（对照 DESIGN.md 的四项功能）**

| 需求 | 现状 | 缺口 |
|---|---|---|
| 账号播放历史读取 | 无。全仓 grep `play/record` **0 命中** | ❌ 完全空白（周报地基） |
| 本地播放历史 | 有，`session.js:243`，上限 300，只喂 DJ | ⚠️ 有数据无出口，无 `/history` 路由、无工具 |
| 口味画像 | `tasteDigest`（`session.js:426-451`）只有艺人维度、无时间聚合、不落盘 | ⚠️ 雏形，需重写 |
| 听歌周报 | 无按时间分桶、无统计、无产出物；`history.at` 从未被聚合 | ❌ 完全没有 |
| 歌词二创 | 只到"取词"（`netease.js:538`）+ 面板展示；**host 侧无 LRC 解析器** | ⚠️ 半块 |
| 场景歌单落库 | 无建歌单/加曲目（grep 0 命中，可能需 eapi 签名） | ❌ 完全没有，**风险最高** |
| 账号歌单读取 | 底层有（`netease.js:841` / `:607`），但无 `library_*` 工具 | ✅ 只差包装 |

其余工程质量：零 npm 依赖、无 bundler 属实；注释是它最强项（每个决策都写了 why）；client 是手写 CJS、宿主是 ESM；`PANEL_CONTRACT` 与 `BASE` 常量各写两处（`client.js:134`↔`router.js:54`、`client.js:51`↔`index.js:119`），改名漏一处会静默降级成"页面自己出声"。

---

## 4. 组合方案 B′：文件清单

以 doitian 为骨架 fork 成我们自己的包（约 9k 行起步），新增/改动：

| # | 文件 | 动作 | 规模 | 说明 |
|---|---|---|---|---|
| 1 | `lib/taste.js` 🆕 | 新增 | 250-350 行 | 读 `store.history` + `feedback` + `parseSongWiki` 的 `{genres,tags,language,bpm}`，产出落盘、带版本的稳定画像；规则优先、模型兜底 |
| 2 | `lib/report.js` 🆕 | 新增 | 200-280 行 | 周报：ISO 周分桶、topArtists、新歌率、跳过率、单曲循环榜 |
| 3 | `lib/session.js` | 改核心 | 60-100 行 diff | history 条目扩字段（duration/playedMs/source/completed），上限 300→2000 或按月滚动，`version 1→2` + 迁移 |
| 4 | `lib/lyric.js` 🆕 | 新增 | 150-220 行 | LRC + 翻译解析（现无）+ 二创 prompt + `ctx.llm` leaf call（仿 `dj.js:1188-1230`） |
| 5 | `lib/index.js` | 改 | 180-240 行 | 3-4 个新 `registerTool` 块（仿 `:542-652`）、diagnostics、清理顺序 |
| 6 | 独立页 + 路由 | 新增 | 300-600 行 | 画像/周报独立 HTML + 2 个 JSON 端点，**复制 `router.js:879-920` 的分支模式，`panel.html` 一行不改** |
| 7 | `lib/netease.js` | 改 | 80-150 行 | 补 `play/record`（读）；若做落库，从 kendu76 抄 `playlist/manipulate` 写端点并实测 |

工作量：不含落库 **7-9.5 天**（只做工具不做页面 3.5-4.5 天）；落库另加 1.5-2 天且风险不可控。

---

## 5. 动手前必须先验证的三件事

1. **播放记录读接口**：`/weapi/v1/play/record?uid=&type=0|1`（全时段 / 本周）。两个参考都没实现，DESIGN.md 里的未知数**依然没答**。若不可用，周报只能基于本地历史，换机即丢。
2. **歌单写接口**：`playlist/create` + `playlist/tracks/manipulate`，可能需 eapi 签名。doitian 的 weapi 只有 58 行、只验过播放上报；kendu76 的写操作是现成参照，但必须用真 cookie 跑一遍。
3. **环境基线**：先安装原版 `@doitian/dsh-music`，确认能登录、能出声、播放能进网易云"最近播放"，再谈 fork。

三件事是一次性的：装原版 → 扫码登录 → 用登录 cookie 跑一个小脚本打这三个接口。全部通过，方案 B′ 才算落地。

---

## 6. 风险

| 风险 | 等级 | 说明 |
|---|---|---|
| 写接口零基础 | 高 | 建歌单/加曲目无既有实现，可能需 eapi，风控不可控 |
| 账号历史读不到 | 高 | 周报地基不稳，只能降级为本地历史 |
| `panel.html` 116 KB 单体 | 高 | 应对：绝不进这个文件，新功能做独立页 |
| cookie 明文、无 0600 | 中高 | fork 即继承，需补 `mode: 0o600` + 老文件 chmod |
| 契约常量双写、无 CI、包内无测试 | 中 | 改核心数据结构前先补 `node --test` |
| 接口非官方，改版即失效 | 中 | 赛道风险，与选谁做基座无关 |
| 许可证 | 低 | 两边都是 MIT；kendu76 的 `docs §4.5` 不在发布包，不能当合规依据；`vendor/qrcode` 需补来源声明 |

---

## 7. 下一步

1. 安装原版 doitian 插件，跑通登录/播放（验证环境 + 拿 cookie）
2. 用 cookie 打三接口：`play/record`、`playlist/create`、`playlist/tracks/manipulate`
3. 通过后再 fork，按第 4 节顺序落：`taste.js` → `report.js` → `lyric.js` → 工具 → 独立页

---

## 8. 变体 B″：先整形、再加法（用户提案，已评估）

主张：不要把 doitian 当"直接往上加功能"的基座，而是先在底座上做减法——去掉我们不要的冗杂功能，把代码整形成我们的形状，再加新功能。

### 8.1 为什么这个思路对

- **改代码之前必须先理解代码，而删减是强制理解**：判断一个模块能不能删，就得读懂它的承重关系。这份代码没有测试，删一遍是建立可靠心智模型的最快方式。
- **先加后减是双重负债**：在别人的复杂度上叠我们的复杂度，最后没人分得清哪层是谁的。
- **整形之后才是"敢改"的仓库**：fork 的意义不是拿到功能，是拿到一个我们敢动的地方。
- **减法有自然验证**：删错了通常立刻表现为面板白屏/没声音，比加功能的隐性 bug 容易发现。

### 8.2 三条约束（否则会翻车）

1. **"冗杂"要按"能否删而不丢能力"定义，不是按"看着多余"。** 两个典型误判：
   - `panel.html` 的详情/歌词页签像"展示功能"，但 `parseSongWiki` 的 genres/tags/language/bpm 是画像数据源，歌词是二创输入 —— 这些是**加法要用的接口**。
   - `dj.js` 的候选池（similar/FM/likes/daily/new/chart + 加权打分）就是"场景歌单"的同构实现，删掉等于拆场景歌单的地基。
2. **减法前先立行为基线。** 没有测试是这份代码最大的坑。基线 = 装原版跑通 + 录一份操作/事件流快照（登录、播放、切歌、各页签），每删一刀重放对比。
3. **最佳形态是"提炼"而不是"删除"。** 把 `dj.js` 的池子与打分抽成 `lib/curator.js`，DJ 与场景歌单共用；删的是 LLM 编排、mood brief、面板卡片这些"它自己的口味实现"。

### 8.3 减法空间实测（比直觉小）

| 判定 | 对象 | 行数 | 依据 |
|---|---|---:|---|
| 直接删 | DJ 的 LLM 编排 / mood brief / 面板 DJ 卡 | ~700-900 | 与我们"对话控制 + 场景歌单"重叠，模型层未端到端验证 |
| 提炼后删壳 | `dj.js` 其余部分 | ~500 | 池子 → `curator.js`，DJ 降级为可选续播开关 |
| 裁剪 | `netease.js` 的 DJ 专用端点 | ~100-150 | 补 `play/record` 与写接口后净增 |
| 裁剪 | `panel.html` 的 DJ 卡片与设置 | ~200 | 详情/歌词页签必须留（画像与二创的数据入口） |
| 保留 | client / router / state / playback / feed / cache / likes / scrobble / weapi | ~3,300 | 全部承重 |
| 可换不必换 | `lib/vendor/qrcode.js` | 2,297 | 换库不如保留 + 补许可证声明 |

**纯删除约 15%（≈1,400 行），不是 40%。** 收益不在这 15%，而在"提炼 curator + 裁剪端点 + 面板整形"带来的结构清晰度。

### 8.4 阶段与工期

| 阶段 | 内容 | 工期 |
|---|---|---|
| 0 基线 | 装原版、登录、出声、录行为快照；cookie 实测三个未知接口 | 0.5-1 天 |
| 1 改名整形 | 包名/BASE/`PANEL_CONTRACT` 双写点统一、配置面收窄、补 0600 | 0.5-1 天 |
| 2 提炼 | `dj.js` → `curator.js`（池子/打分）+ 可选续播开关；裁面板 DJ 卡 | 1-2 天 |
| 3 减法 | 删 LLM 编排、mood brief、无用配置与端点，每刀重放基线 | 1-2 天 |
| 4 加法 | `taste.js` / `report.js` / `lyric.js` / 场景歌单 / 工具 / 独立页 | 7-9.5 天 |
| 5 落库 | 写接口实测通过后 | +1.5-2 天 |

### 8.5 需要拍板的三件事

1. **AI DJ 留不留**：留 = 多 ~1,400 行 + 未验证模型层，但自动续播是播放体验核心；不留 = 干净 15%，但每次点歌都得手动。
2. **面板策略**：改造现有 `panel.html`（1-2 天，风险中），还是先旁挂独立页、把面板留到最后重做（推荐）。
3. **中英双语留不留**：决定 `client.js` i18n 字典与面板 `t()` 是否保留。

### 8.6 已拍板（用户决定）：DJ 保留 + 中文单语，方案随之调整

| 决定 | 对方案的影响 |
|---|---|
| **AI DJ 保留**（含 LLM 编排、面板 DJ 卡、自动续播） | ① 8.3 表里"直接删 ~700-900 行"作废，可删只剩英文字典/双语 `t()`/配置面 ≈ 200-300 行；② 8.4 的"阶段 2 提炼""阶段 3 减法"压缩成半天到一天，**减法阶段基本消失**；③ **新增第 4 个验证项：DJ 模型路由端到端**——`cordis.patch.yml` 里 `dj.provider`/`dj.model` 配好后，面板 DJ 卡是否真能出 plan，否则那颗按钮是死的（`README.md:130` 作者自己承认模型层未端到端验证）；④ 画像直接长在 `session.js:426-451` 的 `tasteDigest` + `parseSongWiki` 上，不重写；⑤ 场景歌单复用 `dj.js` 的候选池与打分（similar/FM/likes/daily/new/chart 六路），只新增"场景 → 查询词 → 选歌 → 落库"这一层，比原估算省 1-2 天 |
| **只做中文** | 保留 `ctx.locale.register/bind` 调用（它管 slot 重渲染时机，删了反而要多改调用点），只把字典删成一份 zh；`panel.html` 的 `t()`/`DICTIONARY` 同样处理 |

**修订后工期**：基线 0.5-1 天 + 整形 0.5-1 天 + 加法 6-8.5 天 = **7-10.5 天**（落库另 +1.5-2 天）。

**修订后的关键判断**：既然 DJ 保留，B″ 的重心从"瘦身"变成"接线"——先把它的资产（池子、tasteDigest、反馈语义、播放上报）接到我们的三个新工具上，再补它没有的（账号历史读取、周报聚合、歌词二创、场景落库）。这比"先删再写"更快，但要求整形阶段必须把双写常量、配置面、中文单语这三件事做干净。
