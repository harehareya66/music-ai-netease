# @doitian/dsh-music v1.2.0 · 基座可行性代码评审

- 评审对象：`music-plugin/.reference/doitian-v1.2.0/`（npm 包解压，只读）
- 评审目的：判断它能否作为我们「网易云插件（场景歌单 / 口味画像 / 听歌周报 / 歌词二创）」的基座
- 评审方式：纯静态阅读（read/grep），**未安装依赖、未联网、未运行**。发布包内不含测试目录，故没有可跑的测试结论
- 证据记法：`相对路径:行号`，路径相对插件根目录 `doitian-v1.2.0/`
- 许可证：MIT（`LICENSE`；`package.json:16`）——可 fork、可商用、需保留版权声明

---

## 0. 结论前置

**可以作为基座，但要把它当「播放器 + 登录 + DJ」基座，四项新功能全部旁挂，不要动它的核心。**

它已经把我们最难、最容易被低估的三块啃完了，而且做法是对的：

| 已经解决的硬骨头 | 证据 |
|---|---|
| 浏览器音频不在页面里，切面板不断音 | `lib/client.js:14-25` 讲清了原因；`lib/client.js:207` 建引擎、`lib/client.js:222-224` 热重载前先 dispose 旧引擎 |
| 页面与引擎的版本偏斜握手（否则会「双声齐放」） | `lib/client.js:142-168` 两级握手；`lib/router.js:54` + `lib/panel.html:13` 的 `PANEL_CONTRACT=2` |
| 状态同步从轮询改 SSE，且解决乱序 | `lib/feed.js:1-21` 决策记录；`lib/feed.js:38-69` 按「可见内容」编号 |
| 扫码登录 + cookie 落盘 + 匿名可用 | `lib/session.js:460-563`、`lib/netease.js:883`、`lib/session.js:15` |
| 零 npm 依赖、无 bundler 的打包 | `package.json`（无 `dependencies`/`devDependencies` 字段）、`lib/client.js:40-48` |

同时它有 4 个必须一次性说清的硬缺口（详见第 6 节）：**账号播放历史读不出来、场景歌单不能落库、周报完全没有、歌词只有取词没有解析和二创**。

---

## 1. 结构与分层

### 1.1 文件清单（行数/字节为实测，行数口径 = `(Get-Content).Count`）

| 文件 | 行数 | 字节 | 职责 |
|---|---:|---:|---|
| `lib/index.js` | 763 | 33,484 | 宿主入口：`apply(ctx, config)`（`:117`）装配所有服务、注册 HTTP 前缀路由（`:325-329`）、定义并注册 7 个工具（`:87-101` + `:346/381/441/494/542/653/678`）、`/music/health` 诊断（`:289-321`）、`ctx.effect` 清理（`:752-760`） |
| `lib/client.js` | 528 | 19,946 | 浏览器半：手写 `window.__ModuleLoader__` 工厂（`:40-42`），持久音频引擎（`:126-395`），React 页面组件（`:422`）、侧栏图标（`:457`）、slot 注册（`:480-502`）、`apply`（`:506-521`） |
| `lib/netease.js` | 918 | 33,521 | 网易云 HTTP 客户端：**全部走明文 `/api/*` 端点**（`:407/438/463/522/539/607/634/646/654/660/672/685/694/769/803/825/841/883/902`），仅上报播放走 weapi（`:730`）；`parseSongWiki`（`:235-269`）、歌曲详情聚合（`:566-601`） |
| `lib/router.js` | 944 | 40,523 | HTTP 路由 + 静态资源 + 面板注入：路由表注释（`:6-7`），`/state`（`:564`）、`/events`（`:567`）、`/report`（`:570`）、`/control`（`:579`）、`/play`（`:597`）、`/queue`（`:605`）、`/search`（`:626`）、`/lyric/:id`（`:640`）、`/feedback`（`:741`）、`/login/*`（`:831-858`）、面板（`:879`）、`playback.js`（`:888`）、`__BASE__` 注入（`:910`） |
| `lib/dj.js` | 1,429 | 61,210 | AI DJ：候选池 `#candidates`（`:498`）、种子 `#seeds`（`:456`）、模型层 `#askModel`（`:1188`）、启发式打分 `#rank`（`:1229`）、`plan`（`:1283`）、`topUp`（`:1322`） |
| `lib/state.js` | 580 | 20,367 | `Player`：队列/游标/传输状态/音量/模式、吸收面板回报 `report()`（`:470`）、给工具的精简视图（`:544`） |
| `lib/session.js` | 563 | 20,360 | `SessionStore`（JSON 原子落盘 `:155-169`）+ 历史/口味/boost（`:229-451`）+ `QrLogin` 状态机（`:460-563`） |
| `lib/likes.js` | 169 | 6,244 | 红心状态缓存：未知≠未红心、写是权威、不持久化（`:1-25` 注释） |
| `lib/playback.js` | 343 | 12,488 | 浏览器播放核心 `createPlayback({base, streamOrigin, call, report})`（`:49`）；淡入淡出、seek 保持、自动播放重试。**页面与引擎共用同一份文件** |
| `lib/scrobble.js` | 85 | 2,891 | 上报播放到网易云：`startplay`（`:36`）、`play`（`:50-65`），skip window 内的不报、best-effort（`:1-15`） |
| `lib/cache.js` | 156 | 5,086 | `TtlCache`（`:18`）、`sampleInOrder`（`:96`）、`Pacer`（`:119`） |
| `lib/feed.js` | 191 | 6,547 | SSE 状态流：`visibleKey`（`:38`）、`SnapshotVersions`（`:54`）、`StateFeed`（`:75`）；心跳 25 s（`:24`）、兜底扫描 5 s（`:30`） |
| `lib/weapi.js` | 58 | 2,520 | 只为「上报播放」需要的 weapi 加密（`lib/netease.js:28`） |
| `lib/panel.html` | 2,498 | 116,263 | 面板页单文件：meta 契约（`:13`）、外链 `vendor/qrcode.js` + `playback.js`（`:485-486`）、`__BASE__` 占位（`:489`）；CSS ≈`:1-484`、HTML ≈`:485-744`、内联 JS ≈`:745-2498` |
| `lib/vendor/qrcode.js` | 2,297 | 56,694 | 第三方 QR 编码器（vendored 源码，非 npm 依赖） |
| `cordis.patch.yml` | 40 | 2,400 | profile patch：insert 一个 `id: music` 的插件条目（`:38-40`），并在注释里写全 config 语义（`:8-37`） |
| `icon.svg` | 8 | 406 | 侧栏图标 |
| `LICENSE` | 28 | 1,304 | MIT |
| `package.json` | 63 | 1,602 | 入口 `lib/index.js`（`:27`）、`exports` 暴露 `./client`（`:31`）、`engines.node>=20`（`:41-43`）、`dsh.bundle/client` 元数据（`:55-62`） |
| `README.md` | 131 | 9,681 | 用户文档；顺带承认了 3 个限制（`:123-131`） |

> 合计：**19 个文件、约 12,700 行、约 0.44 MB**（含 2,297 行 vendored QR）。

### 1.2 分层评价

**干净的部分（可以直接沿用这套切法）**

1. **单一装配点**：只有 `lib/index.js` 知道全部实现（`import` 清单见 `lib/index.js:21-27`），其余模块只依赖接口。依赖注入全部走构造函数（`lib/index.js:125-131`、`:259`）。没有全局单例、没有模块级可变状态 —— 这一点比同类插件好很多。
2. **依赖单向、无环**：`index → {netease, session, state, dj, likes, router, scrobble}`；`dj → {cache, session}`（`lib/dj.js:32-35`）；`router → {cache, feed, netease, session}`（`lib/router.js:24-29`）；`state → netease`（`lib/state.js:20`）；`netease → weapi`（`lib/netease.js:28`）；`session` 零内部依赖（`lib/session.js:11-12`）。**没有循环 import**。
3. **关注点分层清楚**：网络（netease）、状态机（state）、持久化（session）、缓存/节流（cache）、推送（feed）、HTTP（router）、编排（dj）、工具（index）、UI（client + panel.html）。`feed.js` 单独抽出来是对的，它把「什么时候推」和「推什么」分开了（`lib/feed.js:10-19`）。

**耦合点（fork 后改名/改结构会踩的地方）**

| 耦合点 | 表现 | 风险 |
|---|---|---|
| **常量双写：`PANEL_CONTRACT`** | `lib/client.js:134` 与 `lib/router.js:54` 各写一次 `2` | 改契约必须同时改两处，漏一处 → 引擎降级为 inert、页面自己出声 |
| **常量双写：`BASE='/music'`** | `lib/client.js:51`（注释明说「Must match the host plugin's `apiPrefix`」，见 `lib/index.js`）vs `lib/index.js:119` | 改前缀必须同时改两处；`cordis.patch.yml:9-10` 也提醒过 |
| **`window.__dshMusicPlayback` 全局** | `lib/client.js:190` 读取已加载的全局对象；页面侧同源 `lib/panel.html:486` 也加载同一文件 | 两个全局名（`__dshMusicPlayback` / `__dshMusicEngine`）是隐式 ABI |
| **`window.parent.__dshMusicEngine` 跨 frame** | `lib/panel.html:1046-1048`（`shellEngine()`） | iframe 与 shell 同源假设；跨源即失效 |
| **页面文件由宿主读盘** | `lib/client.js:146-150` 明确说「插件 mount 会重读 `panel.html`，但 Node 仍服务已缓存的模块」 | 页面与宿主不同步，只能靠握手兜住（`:154-168`） |
| **i18n 双份** | `lib/client.js:62-80` 的 `DICTIONARY` vs `lib/panel.html:836` 自己的 `t()` | 加一句文案要改两个文件 |
| **`router.js` 既是 API 又是静态服务器** | `:879-920` 里读 `panel.html`、`playback.js`、`vendor/qrcode.js` 并做字符串注入 | 加新页面必须改 router 的分支逻辑（`:879-920`），不是简单的静态目录服务 |

**三个「大而全」文件**是主要维护负担：`lib/dj.js` 1,429 行、`lib/router.js` 944 行、`lib/panel.html` 2,498 行/116 KB。前两个尚可读（注释好），第三个是纯前端单体，见第 8 节。

---

## 2. DSH 客户端契约（重点核实）

`lib/client.js` 开头注释（`:1-38`）声称了 5 件事，逐条对代码核实：

| 声称 | 代码事实 | 判定 |
|---|---|---|
| 手写 `window.__ModuleLoader__` 契约，因此**不需要 bundler** | `lib/client.js:40-42` `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`；内部自造 `module/exports`（`:43-45`）；`const React = require('react')`（`:47`）；末尾 `return module.exports`（`:526`） | ✅ 属实。但注意：**client 是 CJS 风格（`module.exports`），宿主 `lib/index.js` 是标准 ESM**（`export const name` `:29`、`export function apply` `:117`）。同一包两种模块形态，照抄时别统一 |
| shell 的冻结 `PLATFORM_MODULES` 提供 `react` | `:7` 注释 + `:47` 唯一的 `require` | ✅ 属实（只依赖 react 一个平台模块） |
| `apply(ctx)` 启动**持久音频引擎**并注册侧栏条目与页面 | `:506-521` `async function apply(ctx)`；`:96` `inject = ['slots','locale']`；`:487-491` 两条 slot 注册 | ✅ 属实 |
| `ctx.slots.inject` 是**声明式**注册，会等 slot 的属主就绪 | `:487` `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key: PANEL_ID, locale: NS }, MusicPanel))`；`:490` 同理注册 `sidebar.panellist` | ✅ 属实，但实际叠了**三种**机制：模块级 `exports.inject`（`:96/525`，声明服务依赖）→ `ctx.inject(['slots'], cb)`（`:511`）→ `ctx.slots.inject(slot, cb)`（`:487/490`，声明 slot 属主依赖）。API 有层次，也存在冗余写法 |
| 音频引擎放在 shell 文档，`panel.html` 只是遥控器 | 「引擎在 shell」✅（`:207-395`，页面是 iframe，URL 见 `:122-125`）。「只是遥控器」**有条件** | ⚠️ 半真：页面内置完整后备播放通路 —— `lib/panel.html:1044` `shellEngine()`、`:1102` `createLocalTransport()`、`:1130` `applyTransport()`、`:1184` `autoplayBlocked()`、`:1198` `resumeWithGesture()`。握手失败时页面自己拿 `<audio>`（`lib/client.js:136-140` 的 `inertEngine()`，`playback:false` 就是给页面的信号） |
| `/music/api/events` 事件流 | `lib/client.js:51-52` `BASE='/music'`、`API=BASE+'/api'`；`lib/router.js:567` `route === '/events'`；`lib/feed.js:71-73` 帧格式 `event: state\ndata: {...}\n\n`；`:108` `retry: 2000`；`:926` 处理 `/api/` 前缀 | ✅ 属实。设计要点：按「可见内容」去重（`lib/feed.js:38-43` 剔除 position/at/rev 等逐秒变化字段）、单调 `version`（`:54-68`）防乱序、5 s 兜底扫描（`:30`）、25 s 心跳（`:24`） |

补充一个**注释没有明说但很重要**的设计：`lib/client.js:170-195` 的 `loadPlayback()` 用 `<script src="/music/playback.js">` 动态加载，理由是「宿主和页面是一代、这个 bundle 可能是另一代，握手已经确认宿主那一代是对的」。所以**播放核心的权威版本在宿主**，client bundle 里没有它。

### 2.1 「照抄就能用」的最小模板

**A. 宿主侧（ESM，`lib/index.js`）——5 个必需动作**

```js
// 1. 身份与依赖声明
export const name = 'music';                       // 对应 lib/index.js:29
export const inject = ['tools', 'webServer'];      // 对应 lib/index.js:32

export function apply(ctx, config = {}) {          // 对应 lib/index.js:117
  // 2. 自己的服务（这里全部 new 出来，不要用全局单例）
  const store = new SessionStore({ file: path.join(dataDir, 'session.json'), logger }); // :122
  store.load();

  // 3. 注册工具（每个工具 = 一个 registerTool 块）
  ctx.tools.register({
    name, description, parameters,               // parameters 是手写 JSON Schema
    output: { schema: { type:'object', properties:{}, additionalProperties:true },
              render: (args, value) => render(args, value) },   // lib/index.js:92-97
    presentCall: (args) => ({ card:'generic', title, kind:'other', rawInput: args }), // :98
    execute: (args, exec) => execute(args ?? {}, exec),           // :99
  });

  // 4. 注册 HTTP 前缀路由（页面/引擎/SSE 都挂在下面）
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix', path: base, handler: (req, res) => router.handle(req, res),
  });                                            // lib/index.js:325-329
  const panelUrl = () => `http://127.0.0.1:${ctx.webServer.port}${base}/panel`; // :330

  // 5. 清理
  ctx.effect(() => () => { disposeRoute(); router.dispose(); store.close(); }); // :752-760
}
```

**B. 客户端侧（CJS 风格，`lib/client.js`，并在 `package.json` 的 `exports` 里暴露 `"./client"`，见 `package.json:31`）——4 步**

```js
window.__ModuleLoader__.load({                    // lib/client.js:40
  id: '@doitian/dsh-music',
  factory: (require) => {
    var module = { exports: {} }, exports = module.exports;             // :43-44
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');                                     // :47（唯一平台模块）
    const BASE = '/music';                                              // :51 必须与宿主 apiPrefix 一致

    const inject = ['slots', 'locale'];                                 // :96
    exports.inject = inject;                                            // :525

    async function apply(ctx) {                                         // :506
      const disposeLocale = ctx.locale.register(NS, DICTIONARY);        // :509
      const ui = ctx.inject(['slots'], () => registerUi(ctx));          // :511
      const engine = await createEngine();                              // 见 C
      return () => { ui?.dispose?.(); engine.dispose(); disposeLocale?.(); }; // :515-521
    }
    exports.apply = apply;
    return module.exports;                                              // :526
  },
});
```

**C. slot 注册（侧栏条目 + 页面）——2 条**

```js
// 页面（被 layout 的 main slot 渲染）
ctx.slots.inject('main', () =>                                    // lib/client.js:487
  ctx.slots.register({ name:'main', key: PANEL_ID, locale: NS }, PageComponent));

// 侧栏条目（列表 slot；id 与页面 key 同值，order 决定排序）
ctx.slots.inject('sidebar.panellist', () =>                        // :490
  ctx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order: 20,
                       locale: NS, label: () => t('panel') }, IconComponent));
```

**D. 音频引擎（shell 文档里，`window.__dshMusicEngine`）**

```js
// 1. 握手：先问宿主 /health 的 panelContract，问不到就抓面板 HTML 的 meta
const ok = await pageAcceptsEngine();          // lib/client.js:154-168
// 2. 加载宿主提供的播放核心
const core = await loadPlayback();             // :183-195，检查 window.__dshMusicPlayback.createPlayback
// 3. 建引擎；先 dispose 旧实例，否则热重载会双声
window.__dshMusicEngine?.dispose?.();          // :222-224
const playback = core.createPlayback({ base: BASE, streamOrigin, call, report }); // :239
const { audio, reconcile, applySource, enforce } = playback;                      // :240
// 4. 对外暴露（页面通过 window.parent.__dshMusicEngine 用它）
//    { playback, inert, sync(), playNow(), state(), position(), dispose() }     // :136-140, :205
// 5. 逐秒上报：POST /music/api/report
//    { trackId, position, duration, playing, blocked, ended }                    // :254-271 + lib/playback.js:285-305
```

**E. 页面侧（`lib/panel.html`）——3 处硬要求**

1. `<meta name="dsh-music-panel-contract" content="2">`（`lib/panel.html:13`）—— client 用正则抓它（`lib/client.js:162-164`）
2. `const BASE = '__BASE__';`（`lib/panel.html:489`）—— 宿主做字符串替换，并把 `qrcodeJs`、`panelContract`、`config` 注入进去（`lib/router.js:888-920`）
3. `shellEngine()` 读 `window.parent.__dshMusicEngine`（`lib/panel.html:1046-1048`）；拿不到就用本地 transport（`:1102/1130`）

> **最小集总结**：3 个文件（`index.js` 宿主 / `client.js` 客户端 / `panel.html` 页面）+ 1 个 `playback.js` 播放核心 + 1 个 `<meta>` + 2 条 slot 注册 + 1 条 `webServer.register({kind:'prefix'})` + 1 个 `/report` 端点 + 1 个 `/api/events` SSE。这套契约本身是**很值得照抄的资产**，比它承载的业务代码价值更高。

---

## 3. 工具层（7 个工具）

### 3.1 定义结构

所有工具都过同一个包装器 `defineMusicTool`（`lib/index.js:87-101`），它把「友好 spec」编译成 `ctx.tools.register()` 要的裸对象：

```js
{ name, description, parameters,
  output: { schema: { type:'object', properties:{}, additionalProperties:true },  // :92-95 故意开 schema
            render: (args, value) => render(args, value) },                        // :96
  presentCall: (args) => ({ card:'generic', title, kind:'other', rawInput: args }),// :98
  execute: (args, exec) => execute(args ?? {}, exec) }                            // :99
```

关键取舍写在注释里（`:73-77`）：**不用 `@deepseek-ai/dsh-tools` 的 `defineTool()`，因为那会把 DSH 变成运行时依赖**；直接写裸形状，保持零依赖。

### 3.2 七个工具一览

| 工具 | 定义 | `parameters` 关键字段 | `execute` 返回（对象，由 `render` 出文本块） |
|---|---|---|---|
| `music_search` | `:346` | `query`（required `:359`）、`limit`（1-50） | `{ query, total, tracks }`（`:377`） |
| `music_play` | `:381` | `ids`（integer 数组 `:392`）、`query`（`:393`）、`mode`（`replace/append/insert` 的 enum，`:396-398`）、`limit`（`:399`） | 播放/入队结果 |
| `music_queue` | `:441` | `action`（required `:458`）、`ids`（`:455`）、`index`（`:456`） | 队列视图 |
| `music_control` | `:494` | `action`（required `:513`）、`value`；动作含 play/pause/next/prev/seek/volume/mute/mode（对应 `lib/router.js:582-590`） | 传输状态 |
| `music_dj` | `:542` | `enabled`（`:556`）、`prompt`（`:557`）、`replan`（`:558`）、`count`（`:561`）、`start`（`:563`）、`boost`（more/less/none，`:567`）、`boostTrackId`（`:569`）、`boostMinutes`（5-720，`:570`） | plan 结果（source/vibe/route/poolSize/searchedAs） |
| `music_now_playing` | `:653` | `{ type:'object', additionalProperties:false, properties:{} }`（`:658`，无参工具的正确写法） | 当前曲 + 下一曲 + 登录态 |
| `music_login` | `:678` | `action`（required `:692`）、`cookie`（`:690`，给「贴 cookie」用） | QR 快照 / 状态 |

### 3.3 schema 写法（手写 JSON Schema，不用 zod）

- 标量：`query: { type: 'string', description: 'Search text: song, artist, or album.' }`（`lib/index.js:356`）
- 整数带范围说明：`limit: { type: 'integer', description: 'Maximum results (1-50, default 10).' }`（`:357`）——**范围靠描述 + 执行期 clamp**（`:374` `Math.min(Math.max(...), 1), 50)`）
- 数组：`ids: { type: 'array', items: { type: 'integer' }, description: 'Track ids to play, in order.' }`（`:392`）
- 枚举：`enum` + 长 description 的组合（`:396-398` 的 `mode`）
- 必填：`required: ['query']`（`:359`）、`['action']`（`:458/513/692`）
- 无参：`{ type:'object', additionalProperties:false, properties:{} }`（`:658`）

→ 可直接抄成我们 10 个工具的模板；`description` 全部英文单句，模型友好。

### 3.4 返回值形态

`execute` 返回**任意对象**（`output.schema` 是开放对象，`additionalProperties:true`，`:95`），再由 `render(args, value)` 转成 content 块数组：

```js
render: (_args, value) => [ { type: 'text', text: '...' } ]   // lib/index.js:361-370
```

文本由 `trackLine()` 统一生成「`歌名 — 艺人 (专辑) [id:123, 4:05, VIP]`」（`:104-109`）——**一行一首、id 内联**，方便模型下一轮直接引用 id。这个格式很值得抄。

### 3.5 新增一个工具要改哪里

| 步骤 | 位置 | 说明 |
|---|---|---|
| 1 | `lib/index.js` 里加一个 `registerTool({ ... })` 块 | 仿 `music_dj`（`:542-652`，最复杂的一个）或 `music_search`（`:346-379`，最简） |
| 2 | 若需要新后端能力 | 优先加在已有模块（`netease.js` / 新 `lib/taste.js`），复用 `TtlCache` |
| 3 | 登记 | `registeredTools` 自动收集（`:343`），`/music/health` 自动显示（`:290`） |
| 4 | 文档 | `README.md:31-39` 的工具表（用户可见，建议同步） |
| 不需要 | `lib/router.js` | 工具走 `ctx.tools.register()`，与 HTTP 路由无关；只有「面板也要显示这个数据」时才加路由（仿 `:776` `/dj/models`） |
| 不需要 | `external` 配置 | `config` 只用来放可调参数，不加也行 |

---

## 4. 登录与数据

### 4.1 二维码登录流程

```
music_login(action=qr) / 面板点「登录」
  → QrLogin.start()            lib/session.js:476
  → api.qrStart()              lib/netease.js:883   POST /api/login/qrcode/unikey  { type: 1 }
  ← { unikey, loginUrl }       loginUrl = https://music.163.com/login?codekey=<unikey>
  → 面板把 loginUrl 画成二维码   lib/panel.html:1925 drawQr(text)（用 vendor/qrcode.js）
  → 轮询 QrLogin.poll()        lib/session.js:510
  → api.qrPoll(unikey)         lib/netease.js:902   POST /api/login/qrcode/client/login
      code 800 → 过期，自动重开    lib/session.js:532-534
      code 802 → 已扫码待确认      lib/session.js:536-538
      done     → 成功            lib/session.js:539-545
  → store.setSession(jar.header(), account)   lib/session.js:543
```

实现细节值得注意：

- **本地提前刷新**：`QR_TTL_MS = 110_000`（`lib/session.js:47`），`ensure()` 在 `expiresAt` 前就换码（`:492-498`），不等服务端报 800。
- **状态文案双语**：`message` 里同时给中英（`lib/session.js:482/514/518/529/534/538`），注释说明「`error` 给机器、`message` 给人」（`:527-528`）。
- **交替失败不致命**：轮询抛错只记 `lastError` 并返回当前状态（`:524-530`），前端继续轮询。

### 4.2 cookie 持久化位置与权限 ⚠️

| 项 | 事实 | 证据 |
|---|---|---|
| 路径 | `$DSH_HOME/music/session.json`（`DSH_HOME` 未设则 `~/.dsh`） | `lib/index.js:112-115`（`dshHome()`）、`:120`、`:122`；`README.md:25/105` |
| 写入 | 原子写：同目录 `.tmp` + `renameSync`，防半截文件 | `lib/session.js:161-165` |
| 频率 | 高频字段（历史、队列）走 1.5 s 防抖 `touch()`；喜欢/boost 立即写 | `lib/session.js:171-180`、`:309-325`、`:393-410` |
| **权限** | **没有 0600，也没有任何 chmod**。`fs.writeFileSync(temp, json, 'utf8')` 未传 `mode` | `lib/session.js:164`；全仓 grep `0o600\|0600\|chmod\|mode: 0o` **只命中这一行的 `writeFileSync`**，即无显式权限 |
| 官方态度 | README 自认「cookie 明文存放」 | `README.md:124` |
| 路由鉴权 | `/music` 路由无鉴权，仅靠 loopback | `README.md:123`；`lib/router.js:6-7` 也说明只有本机 |

→ **对照 DESIGN.md 第五节 L1「登录态存本地（0600）」，这一条是硬缺口**。若沿用基座，需要自己加：`fs.writeFileSync(temp, data, { encoding:'utf8', mode: 0o600 })` + 首次 `chmodSync` 修正已存在的文件（Windows 上无意义，但 Linux/macOS 要）。

### 4.3 匿名 cookie

```js
export const ANONYMOUS_COOKIE = 'os=pc; appver=2.10.6; channel=netease';   // lib/session.js:15
```

- 未登录时用它初始化客户端：`new Netease({ cookie: store.cookie || ANONYMOUS_COOKIE, ... })`（`lib/index.js:126`）。
- 注释说明 `os=pc` 是为了让服务端返回桌面版 payload（`lib/session.js:14`）。
- 能力边界写在 README：未登录可搜、榜、歌单、歌词、非 VIP 播放，VIP 曲目无音源（`README.md:23`）。

### 4.4 播放历史：**只写不读**

**写**（到网易云账号，让它出现在「最近播放 / 听歌排行」）：

| 动作 | 位置 | 端点 |
|---|---|---|
| 曲目开始 | `lib/scrobble.js:36` `startplay` | `POST ${LOG_ORIGIN}/weapi/feedback/weblog`（`lib/netease.js:730`） |
| 曲目结束 | `lib/scrobble.js:50-65` `play`（带 `time`、`end: 'ui'|'interrupt'`） | 同上 |
| 门槛 | 未听过 skip window 的**不报**（`:47`）；`#active()` 要求已登录（`:78-80`） | — |

**没有任何读取**：

- 全仓 grep `play/record|playlist/create|playlist/tracks|playlist/manipulate|playlist/subscribe|remix|二创|weeklyReport|tasteProfile` → **0 命中**。
- `lib/netease.js` 的端点全集（`grep this.call`）里没有 `play/record`、没有 `user/record`、没有任何 `/play/record` 变体。
- 本地历史 `state.history` 存在（`lib/session.js:243-253`，上限 `MAX_HISTORY = 300`，`lib/session.js:18`），但**只服务 DJ**：`recentIds()`（`:264`）、`heardArtists()`（`:277`）、`topArtists()`（`:269`）、`tasteDigest()`（`:426`）。`lib/router.js` 里**没有 `/history` 路由**，**7 个工具里也没有任何「读历史」的工具**。
- DESIGN.md `?74-77` 标注的「必须先验证：`/weapi/v1/play/record` 是否可用」—— **在这个参考实现里依然没有被验证/实现**，它是本项目最大的未知数，也是本参考**无法回答**的问题。

> 结论：网易云那边的历史数据是有的（因为我们写了），但插件侧没有读回能力。做「周报」只有两条路：(a) 自己长期累积本地历史；(b) 自己实现 `play/record` 读取（需实测风控）。

---

## 5. AI DJ

### 5.1 两层结构（注释自述，`lib/dj.js:1-30`）

| 层 | 用什么 | 何时用 |
|---|---|---|
| 模型层 | 候选池 + taste digest 交 `ctx.llm.stream()`，模型返回 picks 索引 + 一句 vibe | 有模型路由且调用成功 |
| 启发式层 | 网易云自身信号（相似歌/FM/休整过的红心/每日推荐/新歌/榜单/关键词搜索）按加权打分 | 无模型、或模型失败（`lib/dj.js:1303-1311`） |

模型失败不会中断播放，只写 `modelError`（`:339-340`）并记录在 `/music/health`（`lib/index.js:307`）。

### 5.2 候选池怎么来

```js
async #candidates({ prompt = '' } = {}) {        // lib/dj.js:498
  const digest = this.store.tasteDigest();       // :499  口味摘要
  const seeds  = [...boostSeeds, ...this.#seeds(digest)...];  // :456, :518
  ...
}
```

- **种子**：`#seeds(digest)`（`:456`）从 digest 里取「听过/喜欢但没在最近播过的」艺人/曲目，再走相似歌。
- **来源与配额**：相似歌 `/api/discovery/simiSong`（`lib/netease.js:646`）、私人 FM `/api/v1/radio/get`（`:685`）、每日推荐 `/api/v1/discovery/recommend/songs`（`:672`）、新歌 `/api/personalized/newsong`（`:654`）、榜单 `/api/toplist`（`:634`）、红心休整（`:841` + `:872`）、情绪关键词 → 歌单搜索（`:438`，注释 `:447` 说明「歌曲搜索只匹配标题与歌词，所以 brief 走歌单搜索」）。
- **节流与变化**：`TtlCache` 按时效缓存（`lib/cache.js:1-13` 解释「榜单按天、相似度几乎不变」），`sampleInOrder` 从长列表随机取样但保持原顺序（`:82-108`），`Pacer` 把请求起点按 250 ms + 0–500 ms 抖动拉开，**避免机器爬虫特征**（`:110-118`）。

### 5.3 taste digest：**这就是「口味画像」的雏形**

`SessionStore.tasteDigest({ history = 15 })`（`lib/session.js:426-451`）返回：

| 字段 | 含义 | 证据 |
|---|---|---|
| `recentlyPlayed` | 最近 15 首「名 — 艺人」 | `:438` |
| `topArtists` | 最常听的 8 个艺人（只算听完的） | `:439` → `:269-274` |
| `liked` / `disliked` | 最近 15 首喜欢/不喜欢（带歌名） | `:440-441` |
| `skipped` | 最近被跳过的 15 首 | `:443` |
| `dislikedIds` | 前 80 个不喜欢 id（给候选池过滤用） | `:444` |
| `recentIds` | 最近 60 个 id（防重复） | `:445` |
| `skipCounts` | 单曲跳过次数 | `:446-447` |
| `skippedArtists` | 艺人级跳过次数（近 150 条历史） | `:448-449` |

信号质量的两个关键设计（**这两条是我们做画像时要继承的**）：

1. **「听过」有明确定义**：`isHeard(entry) = !entry.skipped && !entry.tentative`（`lib/session.js:112-114`）。`tentative` 指「DJ 自己选的歌」，只有听完 skip window 才 `confirmPlay()` 转正（`:255-261`），否则「DJ 排的歌会给自己的口味投票」（注释 `:231-238`）。
2. **skip 是一等信号**：`recordSkip()` 既计数，又把对应历史条目标 `skipped`（`:366-376`），这样艺人亲和度不会被半途放弃的播放污染（注释 `:356-363`）。

**但它离「口味画像」还差三样**：

- 只有「艺人/曲目/跳过」三个维度，**没有语言/年代/BPM/情绪/场景维度**；
- 没有「画像」的稳定产物（不落盘、无版本、无趋势），每次都是即时计算的 prompt 片段；
- 数据窗口太短：`MAX_HISTORY = 300`（`:18`），且**没有时间戳聚合**（`at` 字段有，`lib/session.js:248`，但从未被用于按周/按月统计）。

> 好消息：**L2 打标签的数据源它已经打通了，只是没用**。`parseSongWiki()`（`lib/netease.js:235-269`）能从歌曲百科解析出 `{ genres, tags, language, bpm, awards, featuredIn, review }`，其中 `songTag`→`genres`（`:242-244`）、`songBizTag`→`tags`（`:245-247`）、`language`（`:248-250`）、`bpm`（`:251-253`）。目前**只用于面板的「详情」展示**（`:566-601` 组装 → `lib/router.js:646` `/info/:id` → `lib/panel.html:1792 paintDetails`），完全没进 DJ，更没进画像。这是做「口语化口味画像 + 场景歌单」最省力的一块现成砖。

### 5.4 llm 调用方式

```js
const llm = ctx.get?.('llm') ?? ctx.llm;                  // lib/index.js:147
const text = await this.#collect(llm.stream(request));    // lib/dj.js:926 / 975 / 1212
```

- **leaf call，不是 agent**：`cordis.patch.yml:29-32` 明确写「The DJ is not an agent and starts none. It makes stateless leaf calls」，每次 plan 一次、情绪 brief 首次改写一次。
- **无 headers**：`lib/dj.js:202-209` 说明「a leaf call 不能带 header，所以身份只能靠 `djSessionId`」（持久化在 `settings.djSessionId`，`lib/session.js:76-84`）。
- **路由解析优先级**：面板选择器 → `config.dj` → 会话默认模型 → discovery（`cordis.patch.yml:26-32`；实现 `lib/index.js:186-192`、`:165`）。
- **结果收集**：`#collect` 只拼 `type === 'text-delta'` 的 `chunk.text`，`finish` 的 `reason.kind === 'error'|'aborted'` 或 `type==='error'` 时抛（这解释了 `#askModel` 为什么必须 try/catch 后落 `modelError`）。
- **模型层端到端没测过**：`README.md:130` 自认「The DJ's model mode hasn't yet been tested end to end with a real model」。

### 5.5 跳过 / 不喜欢如何影响排序

`#rank({ pool, digest, count, follows })`（`lib/dj.js:1229-1270`），全部权重都可读：

| 项 | 权重 | 行 |
|---|---:|---|
| 随机噪声 `Math.random()*0.8` | 0 – 0.8 | `:1235` |
| 显式 mood brief 命中的候选（`origin==='prompt'`） | **+3.0** | `:1240` |
| boost `more` / `less` | **±3.0**（`BOOST_WEIGHT`，`:80`） | `:1241-1242` |
| 来自私人 FM | +1.0 | `:1243` |
| 来自相似歌 | +0.6 | `:1244` |
| 来自红心 | +0.5 | `:1245` |
| 艺人 ∈ 最常听 | **+2.2** | `:1247` |
| 艺人 = 当前播放艺人 | +1.4 | `:1248` |
| 艺人近期听过次数 | `+min(count*0.15, 1.0)` | `:1249` |
| **艺人被跳过次数** | **`−min(count*0.6, 2.4)`** | `:1250` |
| **单曲被跳过过** | **−1.5** | `:1252` |
| VIP 曲目 | −0.4（登录后可播但仍更冒险） | `:1253` |

排序后的**同艺人回避交织**：按分数逐个取出，跳过「与上一首同艺人」的候选（`:1258-1268`），避免一批里被一个艺人占满。

两个容易误判的点：

- **`disliked` 不在 `#rank` 扣分**，而是在**候选池构建时直接过滤**（`lib/dj.js:518` 的 `fewer` 集合 + `dislikedIds`），过滤是硬性的、比扣分更彻底。`#rank` 只负责「剩下的里挑哪些」。
- **面板的「✕ 移出队列」也记 dislike**（`README.md:57`），且 dislike 与 skip 互斥计数（`README.md:60`）——`recordFeedback` 的做法是 `setTaste(id, taste===level ? 'none' : level)`（`lib/session.js:347-354`），天然互斥。

**likes.js 与 DJ 的分工**（`lib/likes.js:1-25`）：`LikeState` 是**账号红心的读缓存**（账号是唯一真相），DJ 的 `feedback.likes` 是**镜像**，由 `setLikedIds()` 在启动/同步时刷新（`lib/session.js:336-341`，注释 `:327-335` 说明「账号才是喜欢住的地方，这份是拷贝」）。红心写入是先调 `api.likeSong` 再更新镜像（`lib/session.js:298-305` 注释），失败不回写。

---

## 6. 缺口确认（对照我们的四项功能）

统一的 grep 证据（对全仓 `doitian-v1.2.0`）：

```
pattern: play/record|playlist/create|playlist/tracks|playlist/manipulate|playlist/subscribe|remix|二创|weeklyReport|tasteProfile
result : 0 命中
```

| 需求 | 现状 | 判定 | 证据 |
|---|---|---|---|
| **播放历史读取（账号侧）** | 无。没有任何 `/play/record` 类端点；`netease.js` 端点全集里没有；7 个工具里没有 | ❌ **完全没有** | `grep play/record` 0 命中；`lib/netease.js` 全部 `this.call` 端点（`:407-902`）无 record；`lib/router.js` 无 `/history` 路由 |
| **播放历史读取（本地）** | 有，但只喂 DJ，不对外 | ⚠️ **有数据、无出口** | `lib/session.js:243-253` + `MAX_HISTORY=300`（`:18`）；消费方仅 `lib/dj.js:499` |
| **口味画像** | 有雏形（规则版 prompt 片段），不是功能 | ⚠️ **雏形，可复用** | `lib/session.js:426-451` `tasteDigest`；`topArtists`/`heardArtists`/`skipCounts`/`skippedArtists`；差距见 5.3 |
| **听歌周报** | 无。无按时间分桶、无统计、无产出物 | ❌ **完全没有** | `grep weekly\|周报` 只命中两处无关注释（`lib/dj.js:118/136` 说榜单更新频率）；`history` 的 `at`（`lib/session.js:248`）从未被聚合 |
| **歌词二创** | 只有「取歌词 + 面板展示」，**没有解析、没有模型二次创作** | ⚠️ **半块** | 端点 `lib/netease.js:538-552`（返回 `lrc/translated/romaji/noLyric`）；路由 `lib/router.js:640`；面板渲染 `lib/panel.html:1865-1924`；**host 侧无 LRC 解析器**（全仓无 `parseLrc`/时间轴解析），无 remix 工具 |
| **场景歌单落库**（建歌单/加曲目到账号） | 无。README 自认 | ❌ **完全没有** | `grep playlist/create\|playlist/tracks\|playlist/manipulate` 0 命中；`README.md:129`「There is no playlist editing」；`netease.js` 只有**读**歌单能力：`userPlaylists`（`:841`）、歌单详情（`:607`）、红心歌单 id（`:872`） |
| **账号歌单读取** | 有（无工具暴露） | ✅ **底层有** | `lib/netease.js:841` `/api/user/playlist`、`:607` `/api/v6/playlist/detail`；但 7 个工具里没有 `library_*` |

补充：DESIGN.md 的 10 个工具 vs 本参考的 7 个工具，**没有交集可白拿的是** `library_list`、`library_tracks`、`scene_build`、`taste_profile`、`weekly_report`、`lyric_remix` —— 恰好就是我们要加的那批。可以参考的只有 `music_search/play/queue/control/now_playing/login` 六个（`music_dj` 可留作娱乐功能）。

---

## 7. 工程质量

### 7.1 测试：**仓库里有、发布包里没有**

`package.json:47-53` 声明了四个测试脚本：

```json
"test":      "node --test --test-isolation=none \"test/*.test.mjs\"",
"test:live": "node --test --test-isolation=none \"test/live/*.test.mjs\"",
"test:all":  "npm test && npm run test:live",
"check":     "node scripts/check.mjs"
```

但 `files` 白名单只发四样东西（`package.json:35-40`）：

```json
"files": ["lib/", "cordis.patch.yml", "icon.svg", "README.md"]
```

**发布包里既没有 `test/` 也没有 `scripts/`**（实测全量枚举 19 个文件，无 test、无 scripts、无 CI 配置、无 `.nvmrc`、无 `tsconfig.json`）。

→ 结论：**`npm test` 在装好的包里必然「找不到测试文件」**。作者显然有测试（脚本名与 `--test-isolation=none` 这种细节不是随手写的），但**我们拿不到**。所以本文所有结论都是静态评审，未经测试验证。若真要 fork，第一件事是去 GitHub 仓库拿 `test/`（`package.json:19-22` 有仓库地址）。

### 7.2 注释：**这是它最强的一项**

- 每个文件都有 15–40 行「为什么这么做」的头注释，而不是「这是什么」：`lib/feed.js:1-21`（为什么从轮询改 SSE、为什么不信任每条 mutation 自己广播）、`lib/session.js:231-242`（为什么 DJ 选的歌要先 tentative）、`lib/likes.js:1-25`（四条性质：未知≠未红心 / 拒绝不是答案 / 写是权威 / 不持久化）、`lib/scrobble.js:1-15`、`lib/playback.js:40-47`、`lib/client.js:14-25`（为什么音频不能在页面里）。
- JSDoc `@param`/`@returns` 基本齐全（如 `lib/dj.js:205-209`、`lib/session.js:384-392`）。
- 关键常量都带单位与理由：`HEARTBEAT_MS = 25_000`（`lib/feed.js:24`）、`SWEEP_MS = 5_000`（`:30`）、`MAX_HISTORY = 300`（`lib/session.js:18`）、`BOOST_WEIGHT = 3.0`（`lib/dj.js:80`）。
- 存在「解释权衡」的段落，这是最难自动生成的部分，例如 `lib/client.js:142-153`（为什么页面权威、宿主不权威）、`lib/feed.js:44-53`（为什么用 `version` 而不是 `rev` 排序）。

### 7.3 零依赖声明：**基本属实，但有一处 vendored 代码**

- `package.json` 全文 63 行，**没有 `dependencies`、没有 `devDependencies`**。
- `lib/index.js:8-11` 自称「Deliberately dependency-free: only `node:` builtins plus global `fetch`」。
- 实际 import 只有 `node:fs/os/path/url/crypto/stream`（`lib/index.js:16-19`、`lib/dj.js:32`、`lib/router.js:24`、`lib/session.js:11-12`、`lib/weapi.js:22`）。
- **例外**：`lib/vendor/qrcode.js`（2,297 行）是第三方 QR 编码器源码拷贝，页面用 `<script src="__BASE__/vendor/qrcode.js">` 引入（`lib/panel.html:485`）。
  → 准确表述：**零 npm 依赖成立；零第三方代码不成立**。fork 时要保留它的许可证声明（包里只有顶层 `LICENSE`，vendored 文件自身没看到独立声明，这是个小合规隐患）。

### 7.4 无 bundler：**属实**

- `lib/client.js:40-48` 手写模块工厂，直接 `require('react')`。
- `package.json:47-53` 的 scripts 里**没有任何 build/rollup/esbuild/vite**。
- `lib/panel.html` 由宿主运行时读盘 + 字符串替换注入（`lib/router.js:888-920`），没有预编译产物。
- 代价：没有 tree-shaking、没有 TS 类型、改一行就是改产物。

### 7.5 Node 版本

- `engines.node >= 20`（`package.json:41-43`），`"type": "module"`（`:26`）。
- 代码用了私有字段/私有方法（`#active` `lib/scrobble.js:78`、`#collect`/`#askModel`/`#rank` `lib/dj.js`）、`structuredClone` 级现代 API、可选链。Node 20 是合理下限。
- **没有 `.nvmrc`、没有 CI 配置**（文件枚举可证），版本承诺无自动化保障。

### 7.6 可维护性评分

| 维度 | 评价 | 说明 |
|---|---|---|
| 分层 | 好 | 单向依赖、单一装配点、构造函数注入（§1.2） |
| 命名 | 好 | 领域词一致：`taste`/`boost`/`skip`/`tentative`/`scrobble`/`plan` |
| 注释 | 很好 | 讲理由、讲权衡（§7.2） |
| 文件规模 | 差 | 4 个文件 >700 行，`panel.html` 2,498 行 / 116 KB |
| 重复 | 中 | `PANEL_CONTRACT`/`BASE`/i18n 三处双写 |
| 类型安全 | 无 | 无 TS、无 `// @ts-check`、无运行时 schema 校验（工具参数靠执行期 `Number()`/`clamp`） |
| 测试 | 缺失（包内） | §7.1；无 CI |
| 可读性（前端） | 差 | 单文件含 CSS + HTML + 2,000 行内联 JS，无组件边界 |

**总评：后端代码质量明显高于前端。** 后端（`index/netease/session/state/dj/feed/cache/likes/scrobble`，合计约 5,500 行）是可以直接接手维护的水平；前端（`client.js` + `panel.html`，约 3,000 行但 116 KB 单文件）是「能跑、能改小东西、不适合大改」的水平。

---

## 8. 基座结论

### 8.1 判定

**可以用，但定位要收窄：把它当「播放内核 + 登录 + 面板壳 + 工具框架」的基座，四项新功能全部旁挂。**

不建议的做法：整仓 fork 后重写 `panel.html`（成本最高、收益最低）、或把新功能塞进 `dj.js`（它已经很挤）。

### 8.2 若加「口味画像 + 周报 + 歌词二创」三项，要改/加的文件

| # | 文件 | 动作 | 规模 | 说明 |
|---|---|---|---|---|
| 1 | `lib/taste.js` 🆕 | 新增 | ~250-350 行 | 读 `store.history` + `feedback` + `netease.songInfo()` 的 `{genres,tags,language,bpm}`（`lib/netease.js:235-269`），产出**稳定画像**（落盘、带版本）。规则优先、模型兜底，用 `lib/cache.js:18` 的 `TtlCache` 缓存打标签结果 |
| 2 | `lib/report.js` 🆕 | 新增 | ~200-280 行 | 周报：按 ISO 周分桶、`topArtists`、新歌率、跳过率、单曲循环榜。**依赖 #3 的历史结构** |
| 3 | `lib/session.js` | **改核心** | ~60-100 行 diff | 历史条目加字段（`duration`/`playedMs`/`source`/`completed`），`MAX_HISTORY` 300→2000+ 或改成按月滚动的 ring buffer；`emptyState.version 1 → 2`（`:52`）并加迁移；同步修 `recordPlay`（`:243`）、`isHeard`（`:112`）、`tasteDigest`（`:426`） |
| 4 | `lib/lyric.js` 🆕 | 新增 | ~150-220 行 | host 侧 LRC/LRC-翻译 解析（**目前完全没有，见 §6**）+ 二创 prompt + `ctx.llm.stream()`（仿 `lib/dj.js:1188-1230` 的 leaf call） |
| 5 | `lib/index.js` | 改 | ~180-240 行 | 3 个新 `registerTool` 块（仿 `:542-652`，每个 60-80 行），diagnostics 加字段（`:289-321`），清理顺序（`:752-760`） |
| 6 | `lib/router.js` + `lib/panel.html` | 改（可选） | 300-600 行 | 「画像/周报」两个页签。**最大成本项**，见 8.3 |
| 7 | `lib/netease.js` | 改（若做场景歌单落库） | ~80-150 行 | 新增 `playlist/create` + `playlist/tracks/manipulate` 写端点。**零既有代码可抄**，需实测 |
| 8 | `README.md` / `cordis.patch.yml` | 改 | 小 | 工具表（`README.md:31-39`）、config 注释（`cordis.patch.yml:8-37`） |

### 8.3 最大改造成本：`panel.html` 116 KB

事实：**2,498 行 / 116,263 字节**，单文件包含 CSS（`:1-484`）、HTML 骨架（`:485-744`）、2,000 行内联 JS（`:745-2498`），其中：

- 渲染函数 `render()`（`:1210-1302`）+ `renderQueue()`（`:1303-1368`）一次性重绘；
- 自带 i18n `t()`（`:836`）与 `DICTIONARY`（`lib/client.js:62-80`）重复；
- 主题/语言跟随 shell：`syncShellTheme()`（`:895`）、`watchShellLocale()`（`:916`）；
- 布局用媒体查询硬切两栏（`README.md:45`）。

**改造成本估算（一个熟悉前端的人）**：

| 方案 | 工作量 | 风险 |
|---|---|---|
| A. 在现有 `render()` 里加两个页签 | 2-3 天 | 中：必须同时动 CSS、`paintInfoTabs`（`:1571`）、`showInfo`（`:1602`）与状态机，容易踩坏播放条 |
| **B. 新增独立页面 + 新路由（推荐）** | 1-1.5 天 | 低：复制 `lib/router.js:879-920` 的分支模式，新 html 只读 `/api/taste`、`/api/report` 两个 JSON 端点，**完全不动 `panel.html`** |
| C. 把 `panel.html` 拆成组件 + 构建 | 5-8 天 | 高：引入 bundler 就破坏了「零依赖无构建」这条核心资产，不值 |

→ **建议 B**：把「画像 / 周报 / 歌词二创」做成**独立 HTML 页 + 独立 `/music/*` 路由**，与播放器解耦。这样 `panel.html` 一行都不用改，116 KB 单体就变成一个可以长期不碰的历史包袱。

### 8.4 工作量估算

| 阶段 | 内容 | 估时（一人） |
|---|---|---|
| 0 | 从 GitHub 取 `test/`、跑通一遍基线（`npm test`、`npm run test:live`） | 0.5 天 |
| 1 | 数据层：历史结构扩展 + 迁移 + LRC 解析（#3、#4 解析部分） | 1-1.5 天 |
| 2 | 画像 + 周报的纯逻辑（#1、#2，无 UI，可 node --test 覆盖） | 2-3 天（规则打标签最耗时，因为要定维度与阈值） |
| 3 | 3 个新工具（#5） | 1-1.5 天 |
| 4 | 独立页面 + 2 个 JSON 端点（方案 B） | 1.5-2 天 |
| 5 | 联调、面板回归、文档 | 1 天 |
| **小计（不含场景歌单落库）** | | **7-9.5 天** |
| 6 | 场景歌单落库（#7，写端点 + 实测 + 风控） | +1.5-2 天，且**风险不可控** |

缩减版（只做工具、不做页面）：**3.5-4.5 天**。

### 8.5 风险清单

| 风险 | 等级 | 依据与应对 |
|---|---|---|
| **写接口零基础**（建歌单/加曲目） | 高 | `grep` 0 命中、`README.md:129` 自认无歌单编辑。要自己摸 `playlist/create` 与 `playlist/tracks/manipulate` 的参数与加密；**这是唯一可能需要 weapi/eapi 签名的写操作**，而仓库里 weapi 实现只有 58 行（`lib/weapi.js`）且只验证过一种请求。必须先实测再承诺 |
| **账号历史读不到**（周报地基不稳） | 高 | `play/record` 全仓无实现。若该接口不可用（DESIGN.md `?74-77` 的未验证项），周报只能基于**我们自己的本地历史**，用户换机/重装即丢 |
| **`panel.html` 116 KB 单体** | 高 | 2,498 行、无组件化、无测试。**应对：方案 B，绝不进这个文件** |
| **cookie 明文、无 0600** | 中高 | `lib/session.js:164` 无 `mode`；`README.md:124` 自认。若沿用即继承安全债，需自己补 `mode: 0o600` + 老文件 `chmod` |
| 契约常量双写 | 中 | `PANEL_CONTRACT`（`lib/client.js:134` ↔ `lib/router.js:54`）、`BASE`（`lib/client.js:51` ↔ `lib/index.js:119`）。fork 后改名必漏一处，且**失败是静默降级**（引擎 inert，页面自己出声） |
| 无类型、无 CI、包内无测试 | 中 | §7.1/7.6。改核心数据结构（#3）时没有回归网，必须自己先补 `node --test` |
| vendored QR 的许可证边界 | 低 | `lib/vendor/qrcode.js` 2,297 行无独立声明，只有顶层 MIT。fork 时补一份来源与许可说明 |
| DJ 模型层未端到端验证 | 低（对我们无影响） | `README.md:130`。我们做画像/二创会复用同一套 leaf call 方式，需自测 |
| 接口整体非官方 | 中 | `README.md:123-131` 与 DESIGN.md「风险」一致，随网易云改版可能整体失效 —— 这与选谁做基座无关，是赛道风险 |

### 8.6 一句话建议

> **抄它的契约（§2 的最小模板）、抄它的 `netease.js` 只读接口层与 `session.js` 的历史/口味模型、抄它的工具包装器；不要抄它的 `panel.html`、不要指望它的 DJ、更不要指望它有任何写入能力。** 四项新功能做成「新模块 + 新工具 + 新页面」三处旁挂，`panel.html` 一次都别改，这样最坏情况是新增功能坏了、播放器照旧能用。

---

## 附录 A：可直接复用的资产清单（按性价比排序）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 客户端模块契约 + 引擎/页面握手 | `lib/client.js:40-48, 126-395` | 几乎逐行照抄，改 id/BASE |
| SSE 状态流（带去重与版本号） | `lib/feed.js` 全文 | 直接拷，改 snapshot 来源 |
| 工具包装器 | `lib/index.js:87-109` | 直接拷 |
| 网易云只读接口层 | `lib/netease.js`（`:235-269`, `:407-902`） | 拷，删掉 DJ 不用的部分 |
| 历史/口味/反馈模型 | `lib/session.js:108-451` | 拷，扩字段（§8.2 #3） |
| 缓存/取样/节流 | `lib/cache.js` 全文 | 直接拷 |
| 红心缓存语义 | `lib/likes.js` 全文 | 直接拷 |
| 二维码登录状态机 | `lib/session.js:454-563` + `lib/netease.js:883-916` | 直接拷，补 0600 |
| 播放上报 | `lib/scrobble.js` 全文 + `lib/netease.js:723-745` | 拷（周报的数据来源之一） |
| `trackLine()` 文本格式 | `lib/index.js:104-109` | 直接拷（工具返回格式统一） |

## 附录 B：不建议复用的部分

| 部分 | 原因 |
|---|---|
| `lib/panel.html` 全文 | 2,498 行单体、无组件化、无测试（§8.3） |
| `lib/dj.js` 全文 | 1,429 行、模型层未经端到端验证；其「候选池 + 加权打分」思路可借，实现不必抄 |
| `lib/vendor/qrcode.js` | 可换我们自己的二维码方案；若保留需补许可证声明 |
| DJ 的 `tasteDigest` 直接当画像 | 维度太少、无时间聚合、不落盘（§5.3） |
