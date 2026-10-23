# 项目计划书 · 网易云音乐 DSH 插件（工作名 `ncm-plugin`）

> 状态：设计定稿，待开发。日期 2026-10-22。
> 前置阅读：`DESIGN.md`（原始决策）、`ANALYSIS.md`（两份参考源码评审与路线）、`FLOWS.md`（产品/使用流程）、`design/`（五屏概念稿）。
> 本文是开发期的唯一执行口径：范围、分层、目录、数据模型、里程碑、验收。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 做什么 | DSH 里的网易云音乐插件：能放歌、有面板、能用对话指挥；能按场景组歌单、出口味画像、出听歌周报、做歌词二创 |
| 基座 | fork `@doitian/dsh-music@1.2.0`（MIT，9.2k 行自研），保留 AI DJ 与播放内核 |
| 零件 | 从 `kendu76/dsh-music-player@1.0.3` 取歌单写操作、逐字歌词解析、请求限流器 |
| 分层 | L0 宿主接缝 / L1 账号与曲库 / L2 播放内核 / L3 数据与画像 / L4 决策 / L5 交互，单向依赖 |
| 语言 | 只做中文，不做双语切换 |
| 形态 | DSH 插件（挂 sidebar + 工具 + 路由），不是独立软件 |
| 关键约束 | 不碰 `panel.html` 的播放逻辑；新功能旁挂；每步都能回退到"播放器仍可用" |
| 工期 | 8-11 人天（不含写接口落地；写接口未验证通过前不承诺） |
| 最大未知 | ① `play/record` 读接口 ② 歌单写接口 ③ DJ 模型路由 |

---

## 1. 目标与验收

### 1.1 五个产品目标

1. **一句话放歌**：对话里"来点适合写代码的"，队列立刻有 10 首并开始播。
2. **面板可控**：侧栏音乐页能看队列、切歌、调音质、看歌词、看详情，切面板不断音。
3. **场景歌单**：一句话生成草稿 → 可增删排序 → 存到网易云账号（写接口验证通过后）。
4. **口味画像**：从听歌数据里算出"你是个什么听歌的人"，一句话结论 + 可核对的图表。
5. **听歌周报 + 歌词二创**：按周聚合出可读的报告；歌词可翻译/改诗/藏头/短视频文案。

### 1.2 验收标准（可测）

| # | 标准 | 测法 |
|---|---|---|
| A1 | 点歌到出声 ≤ 3s（网络正常）；音量条/静音/音质档（128/192/320）在面板底栏与详情页可达 | 手动计时 5 次取中位；底栏各调一次，详情页切一次音质 |
| A2 | 切换到其他会话/面板，播放不中断 | 手动：播放中切 3 次 |
| A3 | 登录后播放 30s，出现在网易云"最近播放" | 手机端核对 |
| A4 | 周报聚合正确 | `node --test`：500 条合成历史 → 断言各项统计 |
| A5 | 画像首次生成 ≤ 6s，缓存命中 ≤ 300ms | 日志打点 |
| A6 | 二创 30 行内 ≤ 8s，失败可重试且不丢输入 | 手动 + 单测 mock |
| A7 | 任一新增功能抛错，播放器仍可用 | 注入异常测试 |
| A8 | cookie 文件权限 0600，日志不含 cookie | 检查文件属性 + grep 日志 |
| A9 | 写歌单：仅在接口验证通过后承诺 | M0 结论 |
| A10 | 五屏 UI 在 1100 / 1400 两档宽度下不横向溢出（窄档转单列） | 无头 Edge 以 `--window-size=1100,900` 与 `1600,900` 各截一遍目测 |

---

## 2. 范围

**做**：网易云扫码登录、搜索/播放/队列/控制、红心与歌单读取、播放记录读取、场景歌单（草稿→落库）、口味画像、听歌周报、歌词二创、AI DJ（保留）。

**不做**（明确写下来，防止范围蔓延）：
- 不做双语/多语言切换（只中文）
- 不做独立桌面软件，不做 MCP server，不做跨应用协议
- 不做账号密码登录（只扫码，MUSIC_U）
- 不做 QQ/酷狗/其他平台（kendu76 那套不搬）
- 不做"哪类歌总跳过"这类需要长期行为采样才成立的分析
- 不做任何解灰/绕过版权/地区解锁（合规红线，见 `ANALYSIS.md` §6）
- 不引入 bundler、不引 npm 运行时依赖（保持零依赖、无构建）

### 2.1 页面与导航

面板（播放器）是**面板里的整页**——占满侧栏 slot，不是悬浮播放条，也不进独立页；其余五页是**独立页面**，各有 URL，从面板左栏或面板内入口进入。跳转只用普通链接（`<a href>`），不做前端路由、不带参数回传。

| 页面 | 形态 | 地址 | 职责 | 概念图 |
|---|---|---|---|---|
| 面板（播放器） | 面板（main slot）整页 | `/music/panel`，由 `client.js` 注入 slot | 播控 / 队列 / 详情·歌词·画像三个页签；左栏是五个独立页的入口 | `design/mockups/player.html` |
| 画像 | 独立页 | `/music/taste` | 完整口味画像（只读，可刷新、可切数据范围） | `taste.html` |
| 周报 | 独立页 | `/music/weekly` | 四数字卡 + 本周最爱 TOP + 单曲循环 + 总结 | `weekly.html` |
| 场景 | 独立页 | `/music/scene` | 一句话 → 草稿歌单 → 落库 | `scene.html` |
| 歌词二创 | 独立页 | `/music/lyric` | 左原词 / 右二创，结果只存本机笔记 | `lyric.html` |

| 曲库 | 独立页 | `/music/library` | 登录后同步：自建/收藏歌单、最近播放、每日推荐；点歌单出曲目列表，点行即播（2026-10-22 H5 反馈后补） | `library.html` |

- 面板的**画像页签只放摘要**：3 个标签 + 一句话 + 「查看完整画像 →」跳 `/music/taste`，不放完整画像——完整画像只有 `/music/taste` 一处。
- 面板「详情」页签放歌曲元信息与音质档（128/192/320）；底栏另有音量条、静音键与音质快捷档（见 A1）。
- 五屏共用 `design/README.md` 的设计系统；**1100px 以下一律转单列**（见 A10），数据图表类别用中性灰阶、只在"当前/选中/峰值/第一名"上用红（见 `design/README.md`「数据可视化用色」）。

---

## 3. 分层设计（核心）

### 3.1 依赖方向

```
        ┌──────────────────────────────────────────────┐
   L5   │ 交互层：面板页 / 画像页 / 周报页 / 场景页 / 二创页 / 工具语义 │
        └───────────────┬──────────────────────────────┘
                        │ 只调用 L4 与 L3 的公开函数
        ┌───────────────▼──────────────────────────────┐
   L4   │ 决策层：DJ 池子与打分 / 场景解析 / 候选筛选      │
        └───────┬──────────────────────┬───────────────┘
                │                      │
        ┌───────▼──────────┐   ┌───────▼───────────────┐
   L3   │ 数据层：历史/画像/  │   │ 标签层：genres/tags/  │
        │ 周报聚合/歌词解析   │   │ language/bpm 缓存     │
        └───────┬──────────┘   └───────┬───────────────┘
                │                      │
        ┌───────▼──────────────────────▼───────────────┐
   L2   │ 播放内核：权威状态 / 音频引擎 / SSE / 播放上报    │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
   L1   │ 账号与曲库：登录 / cookie / 网易云接口 / 红心缓存 │
        └───────────────┬──────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────┐
   L0   │ 宿主接缝：插件契约 / 工具注册 / HTTP 路由 / slot │
        └──────────────────────────────────────────────┘
```

**铁律**：箭头只能向下。L3/L4 **不许** `import` 任何 `ctx`、`fs`、`fetch`；它们只接收 ports。

### 3.2 每层职责与文件

| 层 | 职责 | 文件 | 状态 |
|---|---|---|---|
| **L0 宿主接缝** | 插件契约、工具注册、路由、配置、slot 注入；把下面各层组装起来 | `lib/index.js`、`lib/router.js`、`lib/client.js`、`lib/config.js`、`package.json`、`cordis.patch.yml` | 改 |
| **L1 账号与曲库** | 扫码登录状态机、cookie 落盘（0600）、网易云只读接口、红心缓存 | `lib/account/*`、`lib/netease/api.js`、`lib/netease/weapi.js`、`lib/likes.js`、`lib/cache.js` | 改/搬 |
| **L2 播放内核** | 权威状态机、浏览器音频引擎（在 shell，不在页面）、SSE 推状态、播放上报 | `lib/playback/state.js`、`lib/playback/engine.js`、`lib/playback/feed.js`、`lib/playback/scrobble.js` | 基本不动 |
| **L3 数据层** | 本地历史（扩字段）、账号历史读取、标签缓存、画像、周报聚合、歌词解析与二创 | `lib/core/history.js`、`taste.js`、`report.js`、`lyric.js`、`tags.js` | 🆕 多数新建 |
| **L4 决策层** | DJ 候选池与打分（保留）、场景解析与选歌、排除规则（跳过 / 不喜欢 → 7 天黑名单，DJ 与场景候选都排除） | `lib/dj/*`（保留）、`lib/core/scene.js` | 保留 + 新增 |
| **L5 交互层** | 面板页与四个独立页（画像/周报/场景/二创）、工具语义（名字/描述/schema/返回渲染） | `lib/ui/*.html`、`lib/tools/*.js` | 新增 + 少量改面板 |

### 3.3 ports（让 L3/L4 可脱离 DSH 单测）

| port | 方法 | 谁实现 |
|---|---|---|
| `Store` | `read()/write(state)`、`migrate(v)` | L0（JSON 文件，`$DSH_HOME/music/`） |
| `Netease` | `search/getSongUrl/getLyric/getSongInfo/playlists/likedIds/record` | L1 |
| `Llm` | `leaf({system,user,maxTokens}) → text`（供二创与画像总结） | L0（`ctx.llm`） |
| `Clock` | `now()` | L0（测试可注入固定时间） |
| `Logger` | `debug/info/warn/error` | L0 |
| `Events` | `emit(type, payload)` → 触发 SSE | L2 |

**为什么值得这么麻烦**：L3/L4 是唯一需要大量测试的部分（统计、打分、解析），脱离 DSH 后可以纯 `node --test` 跑，不需要启动宿主。

### 3.4 「可脱离」的边界

插件优先。但 L3/L4 + `netease/api.js` 组合起来本身就是一个**不依赖 DSH 的音乐数据核心**：将来若要 CLI / 独立应用，只需重写 L0/L2/L5 的适配器。这个可脱离性不额外花工期——它只是"别在 core 里 import ctx"这一条纪律。

---

## 4. 目录结构（开发目标树）

```
music-plugin/                     # 仓库根目录（代码与文档同仓，见下方说明）
├── package.json                 # name/main/exports/dsh 字段
├── cordis.patch.yml             # 配置面（保留 7 个字段，见 6.3）
├── icon.svg
├── README.md                    # 用户向：安装/登录/工具表
├── lib/
│   ├── index.js                 # L0 组装：工具注册 + 路由 + 定时清理
│   ├── config.js                # 配置读取与默认值、校验
│   ├── router.js                # /music/api/* + 页面路由
│   ├── client.js                # 客户端入口：slot 注册、注入引擎与 SSE
│   ├── ui/
│   │   ├── panel.html           # 播放器（改：底栏加音量/静音/音质 + 四个独立页入口，不动播放逻辑）
│   │   ├── taste.html           # 🆕 画像页（独立页 /music/taste）
│   │   ├── weekly.html          # 🆕 周报页（独立页 /music/weekly）
│   │   ├── scene.html           # 🆕 场景页（独立页 /music/scene）
│   │   ├── lyric.html           # 🆕 二创页（独立页 /music/lyric）
│   │   └── vendor/              # qrcode.js 等（保留许可证声明）
│   ├── account/
│   │   ├── login.js             # 扫码两跳状态机
│   │   ├── cookie.js            # 0600 原子写
│   │   └── session.js           # 账号快照 + 历史 + 反馈（扩字段）
│   ├── netease/
│   │   ├── api.js               # 只读接口（由参考 netease.js 裁剪）
│   │   ├── weapi.js             # 签名
│   │   ├── write.js             # 🆕 歌单写（M0 验证通过才启用）
│   │   └── lrc.js               # 🆕 LRC/LRC-翻译/逐字解析
│   ├── core/                    # 🆕 纯逻辑，零 ctx
│   │   ├── models.js            # Track/PlayEvent/Profile/Report 类型与校验
│   │   ├── history.js           # 记录、去重、按周分桶、迁移
│   │   ├── tags.js              # 标签提取与缓存
│   │   ├── taste.js             # 画像计算
│   │   ├── report.js            # 周报聚合
│   │   ├── scene.js             # 场景词 → 查询词 → 候选 → 排序
│   │   ├── lyric.js             # 二创 prompt 与结果整形
│   │   └── ports.js             # port 定义（JSDoc typedef）
│   ├── playback/
│   │   ├── state.js             # 权威状态
│   │   ├── engine.js            # 引擎（客户端侧另一份，见 5.2）
│   │   ├── feed.js              # SSE
│   │   └── scrobble.js          # 播放上报
│   ├── dj/                      # 参考的 dj.js 保留（池子/打分/leaf call）
│   │   └── adapter.js           # 🆕 把 DJ 的候选池暴露给 scene.js
│   └── tools/                   # 🆕 一个工具一个文件
│       ├── search.js  play.js  queue.js  control.js  now.js  login.js  dj.js
│       ├── library.js  scene.js  taste.js  weekly.js  remix.js
├── test/                        # node --test，纯 core + 契约
│   ├── history.test.js  taste.test.js  report.test.js
│   ├── scene.test.js    lrc.test.js     api-contract.test.js
│   └── fixtures/*.json
└── scripts/                     # 手动跑的验证脚本，不进交付包
    └── probe.mjs                # M0：读 cookie 打 V1–V3，见 §10
```

**这份树的实际位置**（避免"文件该放哪"的二次确认）：
- 仓库根就是 `music-plugin/`——代码与文档**同仓**，不存在 `ncm-plugin/` 或 `packages/*` 子目录，上面的路径直接从仓库根算。
- `lib/ui/{taste,weekly,scene,lyric}.html` 是四个独立页的真实入口文件：`router.js` 用 `fs` 读取后原样返回（`file://` 方式），路由见 §6.2；`panel.html` 仍是基座那一个整页面板。
- `lib/tools/*.js` 一个工具一个文件，由 `lib/index.js` 逐个注册，工具名与 schema 见 §6.1。
- `scripts/probe.mjs` 是 M0 的接口验证脚本：只读、手动 `node scripts/probe.mjs` 运行，不注册为工具、不进交付物。

---

## 5. 数据模型

### 5.1 磁盘布局（`$DSH_HOME/music/`）

| 文件 | 内容 | 权限 |
|---|---|---|
| `session.json` | 账号快照 + 队列 + 历史 + 反馈 + 画像 + 周报缓存 | 0600 |
| `cookie` | 仅 cookie 字符串（与 session 分离，便于清除） | 0600 |
| `cache/tags.json` | 歌曲标签缓存（`{id: {genres,tags,language,bpm,at}}`） | 0644 |
| `cache/audio/*.m4a` | 可选：短 TTL 音频缓存（默认关） | 0644 |

### 5.2 `session.json` v2（关键结构）

```json
{
  "version": 2,
  "account": { "uid": 123, "nickname": "…", "vipType": 1, "loggedIn": true },
  "queue": { "items": [], "current": 0, "mode": "list" },
  "player": { "volume": 0.62, "muted": false, "quality": 320 },
  "history": [
    {
      "id": 1234567,
      "name": "夜航西飞",
      "artists": [{ "id": 1, "name": "陈粒" }],
      "album": { "id": 2, "name": "洄游", "cover": "…" },
      "duration": 266000,
      "at": 1729500000000,
      "playedMs": 213000,
      "completed": true,
      "skipped": false,
      "source": "search|scene|dj|library|manual",
      "reason": "scene:rainy-afternoon",
      "feedback": "liked|disliked|none"
    }
  ],
  "profile": {
    "version": 1,
    "generatedAt": 1729500000000,
    "ranges": { "4w": { "summary": "…", "tags": ["华语","民谣","慢速","夜听"], "languages": {}, "eras": {}, "bpm": {}, "topArtists": [], "newRate": 0.18, "repeatRate": 0.27 } }
  },
  "reports": { "2026-W42": { "generatedAt": 0, "data": {} } }
}
```

**迁移**：`version 1 → 2` 时给旧 history 条目补 `playedMs/completed/source/feedback` 默认值；迁移失败保留 `.bak` 并降级为 v1 只读。

**不喜欢黑名单**：`dislikes = { "曲目 id": 写入时间戳 }`，保留 7 天、到期自动清；面板队列行的 ⊘ 与 `music_queue({op:"dislike"})` 都写这里，DJ 与场景候选在挑歌时排除（见 FLOWS §3.3）。

### 5.3 历史容量

- v1：300 条（只喂 DJ）→ v2：**2000 条**或按月分桶保留 12 个月。
- 超出时按"最旧且未红心/未在歌单"淘汰，避免把用户在意的东西挤掉。
- 写入节流：同一首歌 60s 内重复记录合并（只更新 `playedMs`）。

---

## 6. 接口清单

### 6.1 工具（12 个；前 7 个沿用参考实现）

| 工具 | 入参要点 | 返回/副作用 |
|---|---|---|
| `music_search` | `q, limit?` | 列表（id/歌名/艺人/时长/封面） |
| `music_play` | `ids? \| q?, position?` | 入队并播放 |
| `music_queue` | `op: list\|append\|insert\|remove\|jump\|clear\|dislike` | 队列操作；`dislike` = 移出队列 + 写 7 天黑名单 |
| `music_control` | `op: play\|pause\|next\|prev\|seek\|volume\|mute\|mode` | 播放控制；`volume` 带 `0–1`，`mute` 为静音开关（这两个 op 原本就有，签名不变） |
| `music_now_playing` | — | 当前曲 + 下一首 + 登录态 |
| `music_login` | `op: status\|qr\|poll\|cookie\|logout` | 扫码/登录态 |
| `music_dj` | `brief?, boost?, op: start\|stop\|config\|status` | 续播队列 |
| 🆕 `library_list` | `kind: created\|liked\|recent` | 歌单列表 |
| 🆕 `library_tracks` | `playlistId, limit?` | 曲目列表 |
| 🆕 `scene_build` | `brief, count?, save?: "account"\|"local"\|"none"` | 草稿（可落库） |
| 🆕 `taste_profile` | `range: 4w\|6m\|all, refresh?` | 画像摘要 + 图数据 |
| 🆕 `weekly_report` | `week?: "this"\|"last"\|ISO` | 周报数据 |
| 🆕 `lyric_remix` | `id, mode: 翻译\|改诗\|藏头\|文案, scope?` | 二创文本 |

### 6.2 HTTP 路由（`/music/api/*`）

| 路由 | 用途 |
|---|---|
| `GET /music/api/snapshot` | 播放状态快照（页面首屏） |
| `GET /music/api/events` | SSE 状态流 |
| `GET /music/api/library` | 曲库：账号歌单分组 + 最近播放 + 每日推荐（未登录 401 `NO_ACCOUNT`） |
| `GET /music/api/taste?range=` | 画像数据 |
| `GET /music/api/report?week=` | 周报数据 |
| `GET /music/api/lyric?id=&mode=` | 原词 + 二创（流式见 6.4） |
| `POST /music/api/scene` | 生成草稿 |
| `POST /music/api/scene/save` | 落库（写接口未验证时返回 501） |
| `POST /music/api/queue/*` | 队列动作（沿用） |
| `POST /music/api/player` | 音量/静音/音质档（写 `session.player`，页面底栏与详情页共用） |

页面路由：`/music/panel`（面板 slot 整页）、`/music/library`、`/music/taste`、`/music/weekly`、`/music/scene`、`/music/lyric`（后五个各自独立 HTML，面板只提供入口链接）。

### 6.3 配置面（`cordis.patch.yml`，保留原样，只改注释语言）

`apiPrefix`、`dataDir`、`audioLevel`、`requestTimeoutMs`、`dj.provider`、`dj.model`、`dj.sessionId`、`scrobble`。用户已确认保留这套入口，不收敛。

### 6.4 网易云端点

| 端点 | 用途 | 状态 |
|---|---|---|
| `/api/cloudsearch/pc` | 搜索 | ✅ 参考已实现 |
| `/api/song/enhance/player/url/v1` | 播放地址（音质档） | ✅ |
| `/api/song/lyric` | 歌词（lrc/tlyric/yrc） | ✅（解析需自写） |
| `/api/v3/song/detail` | 详情 | ✅ |
| `/api/v6/playlist/detail` | 歌单详情 | ✅ |
| `/api/user/playlist` | 我的歌单 | ✅ |
| `/api/song/like` + `/api/v1/playlist/manipulate/tracks` | 红心 | ✅ |
| `/weapi/v1/play/record?uid=&type=0\|1` | **听歌记录（读）** | ✅ **M0 已验证可读**（allData 上限 100 条，weekData 只含本周） |
| `/api/playlist/create` | 建歌单 | ✅ **M0 已验证可用**（`--write` 实测 code 200） |
| `/api/playlist/manipulate/tracks` | 加/删曲目 | ✅ **M0 已验证可用**（加曲 code 200；删歌单用 `/weapi/playlist/remove`） |
| `/weapi/feedback/weblog` | 播放上报 | ✅（参考已实现） |

---

## 7. 里程碑

| # | 里程碑 | 产出 | 验收 | 工期 |
|---|---|---|---|---|
| **M0** | 基线与验证 | 原版跑通；4 个未知项结论（含 DJ 模型路由）；行为快照（工具返回样例、session.json 结构、面板交互清单）；验证脚本 `scripts/probe.mjs` | 四个结论有"可用/不可用"定论 —— 现状：V1/V2/V3 ✅（2026-10-23 探针实测）；V4 ✅（真机 DS7：DJ 模型 pin 到 `deepseek-account/deepseek-flash` 后 `/api/dj/test` 返回 `source:"model"`；默认 session 模型若缺 key 会自动降级 heuristic） | 0.5-1d |
| **M1** | 整形 | 改名（包名/BASE/`PANEL_CONTRACT` 双写点）、中文单语、cookie 0600、配置注释、留 DJ | 原版功能全在；`grep` 无残留旧名；cookie 属主权限 0600 | 1d |
| **M2** | 数据层 | `session v2` + 迁移、账号历史接入（若通过）、history 出口、tags 缓存 | 单测全绿；A4 通过 | 2-3d |
| **M3** | 决策层 | `taste.js`、`report.js`、`scene.js`（复用 DJ 池子）、排除规则 | 单测：画像/周报/场景各一组固定 fixture | 2-3d |
| **M4** | 工具层 | 6 个新工具 + 工具契约测试 | 对话里可用，返回结构稳定 | 1-1.5d |
| **M5** | 交互层 | 画像页、周报页、二创页、面板入口与页签 | 五屏概念稿对齐；A5/A6/A7 | 2-3d |
| **M6** | 落库与打磨 | 写接口（若 M0 通过）、二创流式、错误态、README、打包 | A9；卸载重装数据完好 | 1.5-2d |

**合计 8-11 人天**。M0 若判定写接口不可用，M6 退化为"只存本地歌单"，工期 -1.5d。

---

## 8. 测试策略

| 层 | 方式 |
|---|---|
| core（L3/L4） | 纯 `node --test`，多组 fixture：空历史、单曲循环、跨周、跨年、异常字段 |
| 接口契约 | `test/api-contract.test.js`：mock fetch，断言请求形状（weapi 参数、音质档）与错误映射 |
| 登录/写接口 | `test/live/*.test.mjs` 手动门控（`NCM_LIVE=1` 才跑），绝不进 CI 默认 |
| UI | 不引 E2E；用无头 Edge 截图回归（`design/mockups/*.html` 就是原型，改 CSS 后必须重截对比），每轮另截 1100 宽一档看单列（A10） |
| 回归红线 | 每个里程碑跑一遍：播放、切面板不断音、上报进历史 |

---

## 9. 风险与对策

| 风险 | 应对 |
|---|---|
| 写接口不通 | 降级为本地歌单 + 导出文本；不阻塞主流程 |
| 账号历史读不到 | 周报降级为"本机历史"，界面明示数据范围与丢失风险 |
| DJ 模型路由未配好 | M0 先验；未通过就把 DJ 卡置灰并提示去设置，不假装能用 |
| `panel.html` 被改坏 | 新功能全走独立页；面板只加底栏（音量/音质）与四个入口链接，改完必须过 A2 |
| 接口改版失效 | 端点集中 `netease/api.js`，错误统一映射；面板显示"接口失效，请更新插件" |
| 无测试的基座 | M1 后先给 core 建单测，再动数据模型（M2） |
| 合规 | 保留 MIT 版权头与作者风险声明；不做解灰；cookie 不进日志、不进周报 |

---

## 10. 交付物

- 可安装的插件包（含 `README.md`、`cordis.patch.yml`、许可证与来源声明 `THIRD_PARTY.md`）
- 五屏 UI（面板 slot 整页 + 画像/周报/场景/二创四个独立页，见 §2.1）
- `test/` 单测（core）+ `scripts/probe.mjs`（接口验证脚本）
- 一份 `NOTES.md`：实测结论、踩坑、接口变化记录
