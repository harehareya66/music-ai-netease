# 交接文档 · 对话总结与开工指引

> 读者：在新工作区（DSH 创造模式）接手这个项目的会话。
> 读完这一份，你应该知道：项目要做什么、已经定了什么、哪些结论有证据、哪些还没验证、第一步先干什么。

---

## 1. 一句话说清

做一个 **DSH 里的网易云音乐插件**：能放歌、有侧栏面板、能用对话指挥；在播放内核之上加四项差异化能力——**场景歌单、口味画像、听歌周报、歌词二创**。

路线已定：**fork `@doitian/dsh-music@1.2.0` 当基座**（保留它的播放内核、DSH 客户端契约、登录、AI DJ），**从 `kendu76/dsh-music-player@1.0.3` 取零件**（歌单写操作、逐字歌词解析、请求限流）。先整形，再加功能。

---

## 2. 按什么顺序读

| 顺序 | 文件 | 读它为了 |
|---|---|---|
| 1 | `PLAN.md` §0-§3 | 范围、分层、目录、里程碑 |
| 2 | `FLOWS.md` | 产品流程、使用剧本、状态机、异常态 |
| 3 | `design/shots/*.png` + `design/README.md` | 五个界面长什么样、设计系统 |
| 4 | `ANALYSIS.md` | 为什么选 doitian 当基座、两份源码的取舍证据 |
| 5 | `analysis/doitian.md`、`analysis/kendu76.md` | 需要细节时再查（611 / 405 行，全部带行号） |
| 6 | `DESIGN.md` | 最早的决策底稿；部分已被 PLAN 覆盖，以 PLAN 为准 |

---

## 3. 已拍板的决策（不要再重新讨论）

| # | 决策 | 理由 / 影响 |
|---|---|---|
| D1 | 路线 B″：doitian 基座 + kendu76 零件 | doitian 已啃下音频引擎、页面/引擎契约、SSE；kendu76 的 index/client 不可拆（1888 行单函数 + 11848 行单闭包） |
| D2 | **AI DJ 保留**（LLM 编排、面板 DJ 卡、自动续播） | 自动续播是播放体验核心；画像可直接长在它的 `tasteDigest` 上 |
| D3 | **只做中文**，不做双语 | 保留 `ctx.locale.register/bind` 调用（管 slot 重渲染时机），字典只留中文 |
| D4 | 配置面保留原样（8 个字段），不收敛 | 用户明确要求；只把注释改中文 |
| D5 | 做成 **DSH 插件**，不做独立软件、不做 MCP、不做跨应用协议 | 用户已确认 |
| D6 | 新功能**旁挂**：独立页面 + 独立路由，`panel.html` 只加入口 | panel.html 是 2498 行单体，改它风险最高 |
| D7 | **L3/L4 零 ctx 依赖**，只吃 ports | 唯一能纯 `node --test` 覆盖的部分 |
| D8 | 数据落 `$DSH_HOME/music/session.json` v2，history 扩到 2000 条/12 个月 | 周报要按时间聚合，v1 的 300 条只够喂 DJ |
| D9 | 写歌单接口未验证前，按钮置灰、只存本地 | 不承诺没验证过的能力 |
| D10 | 合规红线：不解灰、cookie 不进日志、保留 MIT 头与作者风险声明 | kendu76 在 `lib/netease.js:18-19` 明确"严禁解灰"；MIT 只覆盖代码不覆盖音乐内容 |
| D11 | 数据源优先级：账号历史 > 本地历史，界面永远标明范围 | 换设备会丢本地数据 |
| D12 | 测试：core 用 `node --test`，live 测试手动门控（`NCM_LIVE=1`） | 基座发布包不带测试 |

---

## 4. 已核实的事实（有证据，可直接引用）

**基座 `@doitian/dsh-music@1.2.0`（MIT）**
- 自研 ≈9,225 行 + vendored QR 2,297 行；零 npm 依赖、无构建、node ≥ 20。
- 音频引擎在 shell，不在页面：切会话不断音（`lib/client.js:207`）。
- 页面与引擎有契约版本握手，防"双声齐放"：`PANEL_CONTRACT=2`，**常量双写** `lib/client.js:134` ↔ `lib/router.js:54`（改名必漏一处，失败是静默降级）。
- 状态同步是 SSE，带可见 key 去重 + 单调 version（`lib/feed.js:38-69`）。
- 本地历史上限 300，只喂 DJ（`lib/session.js:243`）；`tasteDigest` 是画像雏形，只有艺人维度（`lib/session.js:426-451`）。
- `parseSongWiki` 能直出 `genres/tags/language/bpm`（`lib/netease.js:235-269`）——L2 打标签不用另外埋点。
- **两个硬缺口**：账号播放历史只写不读（全仓 `play/record` 0 命中）；没有任何歌单写操作（`README.md:129` 自认）。
- 安全问题：cookie 落盘无 `mode`（`lib/session.js:164`），需补 0600。

**零件 `kendu76/dsh-music-player@1.0.3`（MIT © 2026 kendu76）**
- 自研 18,081 行（`index.js` 6,233 + `client.js` 11,848），无测试（README 称 500+ 用例，`npm test` 实际 No test files）。
- 唯一值得整块搬的是 `lib/netease.js`：639 行、零 npm 依赖、无全局状态、cookie 全参数注入、25 个导出；**必须连 `lib/vendor/qrcode.mjs` 一起**（相对路径 `./vendor/`）。
- 独有能力：**歌单写操作**（add/del）、逐字歌词 `lib/yrc.js`（72 行）、限流器 `lib/fetch-limit.js`（84 行）。
- 缺口：`getDownloadURL` 写死 `br:999000`（`:509`）、无播放记录接口、`assertOk` 抛裸 `Error`。

**环境（本机）**
- node 24.19.0 / npm 11.17.0 / git 2.56.0；Edge 可无头截图（需要 danger-full-access，当前会话已是）。
- 参考源码在 `music-plugin/.reference/`（1.6 MB + 485 KB，**不进交付包**）。
- 无头截图脚本见 `design/README.md`；系统 Python 处理中文路径有坑，写文件优先用 pwsh 或文件工具。

---

## 5. 还没验证的四件事（M0 要出结论）

| # | 未知 | 验证方式 | 不通过时的降级 |
|---|---|---|---|
| V1 | `play/record`（读听歌记录）能否用 | 登录后打 `/weapi/v1/play/record?uid=&type=0\|1` | 周报只用本地历史，界面明示 |
| V2 | `playlist/create` 能否建歌单 | 真 cookie 打接口，观察返回 code | 场景歌单只存本地 + 导出文本 |
| V3 | `playlist/tracks/manipulate` 能否加曲目 | 同上 | 同上 |
| V4 | DJ 模型路由是否真的能出 plan | 配好 `dj.provider/model`，面板点「开始 DJ」 | DJ 卡置灰并提示去设置 |

> V1-V3 的结论写进 `NOTES.md`，并回填 `PLAN.md` §6.4 的状态列。**V1 是周报的地基，V4 是 DJ 保留下来的前提。**

---

## 6. 第一步先干什么（可直接执行）

```text
1) 确认工作区根目录 = 现在的 music-plugin/（PLAN.md 就在根上）
2) 安装原版基座：dsh plugin add @doitian/dsh-music（或桌面「插件 → 添加插件」）→ 重启
3) 打开侧栏「音乐」→ 点登录 → 手机扫码
4) 故意播一首非 VIP、再播一首 VIP，各听 40 秒
   → 确认：出声、切会话不断音、手机端「最近播放」能看到
5) 写 scripts/probe.mjs，从 $DSH_HOME/music/session.json 取 cookie，依次打 V1/V2/V3
   → 每条记录：请求、HTTP 状态、业务 code、关键字段、结论（可用/不可用）
6) 试一次 DJ：面板输入"今晚想听点慢的"→ 开始 DJ → 看 queue 是否被补满（V4）
7) 把 5、6 的结论写进 NOTES.md，然后把 PLAN.md §6.4 状态列更新
```

M0 结束的标准：V1-V4 四条都有定论，且原版在本机能稳定播放 30 分钟。

---

## 7. 给新会话的开场提示词（复制即用）

> 我在开发 `ncm-plugin`（DSH 网易云音乐插件）。工作区根目录有 `PLAN.md`、`FLOWS.md`、`ANALYSIS.md`、`DESIGN.md`、`design/`。
> 请先读 `PLAN.md` 的 §0-§3 和 `HANDOFF.md` 的 §3-§6，然后按 §6 的步骤开始 M0：安装原版基座、扫码登录、验证四个未知接口（play/record、playlist/create、playlist/tracks/manipulate、DJ 模型路由），结论写进 `NOTES.md` 并回填 `PLAN.md` §6.4。
> 纪律：不改 `panel.html` 的播放逻辑；L3/L4 新代码不许 import ctx；每个里程碑结束必须过"播放不断音"这条红线。

---

## 8. 文件地图

```
music-plugin/
├── PLAN.md              ← 项目计划书（分层设计、目录、里程碑、验收）
├── FLOWS.md             ← 产品流程 + 使用流程 + 状态机 + 异常态
├── HANDOFF.md           ← 本文件：交接与开工指引
├── ANALYSIS.md          ← 路线评审（为什么 B″）
├── DESIGN.md            ← 早期决策底稿（以 PLAN 为准）
├── README.md            ← 项目简介 + 进度
├── analysis/
│   ├── doitian.md       ← 基座完整评审（611 行，带行号）
│   └── kendu76.md       ← 零件完整评审（405 行，带行号）
├── design/
│   ├── README.md        ← 设计系统、截图方法、设计取舍
│   ├── mockups/*.html   ← 五屏原型（真 HTML，可直接打开）
│   └── shots/*.png      ← 五屏截图
└── .reference/          ← 两份参考源码（不进交付包）
```

---

## 9. 术语

| 词 | 含义 |
|---|---|
| L0-L5 | 分层：宿主接缝 / 账号曲库 / 播放内核 / 数据画像 / 决策 / 交互 |
| port | core 层依赖的接口（Store/Netease/Llm/Clock/Logger/Events），由 L0 注入 |
| 旁挂 | 新功能做成独立页 + 独立路由，不改进 `panel.html` |
| 落库 | 把草稿歌单写进网易云账号（依赖 V2/V3） |
| 上报 | 把播放事件发给网易云 `weblog`，让"最近播放"有记录 |
| 红线 | 新增功能坏了也不能影响播放（验收 A7） |
