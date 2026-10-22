# kendu76/dsh-music-player v1.0.3 复用评审

- 评审对象：`C:\Users\19825\Documents\deepseek-harness\default-workspace\music-plugin\.reference\kendu76-v1.0.3\`（tarball 解压、只读）
- 评审目的：判断「能不能复用」——具体是 (A) 只搬 `lib/netease.js` 自己写壳，(B) 在它基础上加「场景歌单 / 口味画像 / 听歌周报 / 歌词二创」。
- 方法：`read`/`grep`/`glob` + PowerShell 行数/字节统计；未安装依赖、未联网、未执行 `npm test`。
- 口径说明：文中所有路径均相对插件根目录 `R`；行号来自 tarball 原始文件（`ReadAllLines` 计数）。
- **一句话结论**：`lib/netease.js` 是一块罕见地干净的移植目标（639 行、零 npm 运行时依赖、无全局状态、cookie 全参数注入），可以整块搬走；而 `lib/index.js`（6233 行）和 `lib/client.js`（11848 行）是「能跑但不可拆」的单体，除抄几十行 Range 代理与取链逻辑外没有复用价值。仓库自身没有测试、没有构建，README 声称的 500+ 用例在发布包里根本不存在。

---

## 1. 结构与体量

### 1.1 文件清单

| 文件 | 行数 | 字节 | 职责（证据） |
|---|---:|---:|---|
| `lib/index.js` | 6233 | 346,083 | host 插件：扫本地音乐、HTTP 路由、3 个 tool、提示词注入（头注释 `lib/index.js:1-11`） |
| `lib/client.js` | 11848 | 795,487 | 浏览器 UI：dock 播放条 + 悬浮面板 + 三套在线面板（头注释 `lib/client.js:1-19`） |
| `lib/kugou.js` | 1271 | 65,555 | 酷狗：三套签名 + 扫码 + 取链 + 歌词（`lib/kugou.js:1-20`） |
| `lib/netease.js` | 639 | 30,018 | 网易云：weapi/linuxapi/eapi 三套加密 + 25 个具名导出（`lib/netease.js:1-20`） |
| `lib/qq.js` | 996 | 57,044 | QQ/微信扫码 + musicu.fcg 取链（`lib/qq.js:1-10`） |
| `lib/news-core.js` | 1071 | 52,340 | 纯逻辑：新闻抓取/去重/播报稿（`lib/news-core.js:8`） |
| `lib/hls.js` | 451 | 20,647 | m3u8 → 连续 ADTS 零依赖转换（`lib/hls.js:1-15`） |
| `lib/qrc.js` | 405 | 16,037 | QQ QRC 歌词 3DES 解密（`lib/qrc.js:19-23`） |
| `lib/lyric.js` | 302 | 13,320 | 在线歌词兜底链 QQ→酷狗→网易云→LRCLIB（`lib/lyric.js:15-18`） |
| `lib/radio.js` | 283 | 13,009 | radio-browser 多镜像（`lib/radio.js:42-55`） |
| `lib/whatsnew.js` | 244 | 9,130 | 版本更新弹窗数据（`lib/whatsnew.js:20-43`） |
| `lib/calendar.js` | 155 | 7,683 | 中国节假日离线表（`lib/calendar.js:19-67`） |
| `lib/krc.js` | 202 | 8,415 | 酷狗 KRC 逐字歌词解密（`lib/krc.js:26-117`） |
| `lib/fetch-limit.js` | 84 | 3,806 | 有界出网限流器（`lib/fetch-limit.js:33`） |
| `lib/yrc.js` | 72 | 3,061 | 网易云 YRC 逐字歌词解析（`lib/yrc.js:29`） |
| `lib/vendor/qrcode.mjs` | 2237 | 51,907 | 二维码生成（MIT，© 2009 Kazuhiko Arase，`lib/vendor/qrcode.mjs:1-27`） |
| `package.json` | 61 | 1,142 | ESM、零 deps、`dsh.client` 声明 |
| `cordis.patch.yml` | 8 | 397 | 插件行插入（`cordis.patch.yml:6-8`） |
| `README.md` | 314 | 36,617 | 文档（含若干与实现不符的说法，见 4.2） |
| `LICENSE` | 21 | 1,064 | MIT © 2026 kendu76 |

关键观察：

- **发布包只有 20 个文件，无 `test/`、无 `vitest.config.*`、无 `CONTRIBUTING.md`、无 `docs/`**（`glob **/*{test,spec}*` 零命中）。而 `lib/netease.js:19`、`lib/kugou.js:9`、`lib/lyric.js:12` 的注释都引用 `docs/` 下的设计文档（如「见 docs §4.5」「docs/kugou-integration-research.md」）——**源码里的证据链在发布包里是断的**，无法核验其逆向/抓包过程。
- 两个巨型文件占全仓代码量的 **≈88%**（346KB + 795KB / 1.30MB），与 `music-plugin/DESIGN.md` 的判断一致。

### 1.2 `lib/index.js`：扁平导出区 + 1888 行单函数

组织结构（三段）：

1. **1-1511：扁平纯函数区**，没有类、没有模块内命名空间，连续 29 个 `export function`：音频头解析 `parseMpegFrame():82`、`parseM4a():111`、`parseAudioMeta():250`、`extractEmbeddedLyric():298`，EPUB 处理 `parseBookStructure():687`、`zipEntries():833`、`readEpubBuffer():973`、`splitBookChunks():1241`，歌词 `parseLrc():1405`、`splitTranslatedLyric():1459`。这一层其实**质量尚可**，是可单测的纯函数——但仓库里没有测试。
2. **1513-1516：插件契约**——`export const name = 'dsh-music-player'`、`export const inject = ['webServer','fs','shell','tools','systemPrompt','llm']`、`export function apply(ctx)`。所有运行时状态都挂在 `apply` 闭包里（`lib/index.js:1517-1523`，`home/musicRoot/bookRoot/tracks/books/pendingIntent/startupPromise`），文件级无状态。
3. **3757-5644：`const serve = async (req, res) => {`**——**1888 行的单个函数**，内部 **94 个 `pathname === '...'`（17 个网易云）+ 9 个 `pathname.startsWith`（2 个网易云）** 的 if 链，手写 `writeHead`/`writeJson`，没有 router、没有框架、没有中间件。这是全仓最大的结构性问题：任何新路由的插入点都在这条 1888 行的 if 链里。

分区标记极度稀疏：全文只有 **4 个 `// =====` 横幅 + 45 个 `// ----` 小标题**，注释 1146 行（18%）。也就是说平均 **每 127 行才有一个分区标记**（6233/49），而单个函数跨 1888 行。

### 1.3 `lib/client.js`：手写 ModuleLoader bundle + 单闭包 268 函数

- 不经过任何打包器：`window.__ModuleLoader__.load({ id: 'dsh-music-player', factory: (require) => {`（`lib/client.js:20`），内部手写 `var module = { exports: {} }`（`:23`），React/ReactDOM 由 `require('react')` 取得（`:27-28`），末尾 `return module.exports`（`:11846`）。**这是「DSH 客户端插件的加载契约」而非通用 ESM**，拷贝到别的宿主会直接失效。
- 单个 factory 闭包内 **268 个 function 声明、936 处 `React.createElement`**（无 JSX、无 `h()` 简写），注释 2441 行（21%），**0 个 `// =====` 横幅**、56 个 `// ----`。
- 组件按行号线性排列：图标集 `:4814-4887`、`BarLyric:5030`、`NowPlayingBar:5166`、`NewsPane:5621`、`BookTocPanel:6273`、`KGOnlinePanel:6629`（≈991 行）、`NCOnePanel:7620`（≈849 行）、`RadioPanel:8469`、`QQOnlinePanel:8865`（≈1010 行）、`PlayerPanel:9875`、`LyricPanel:10212`、设置/弹窗类 `:10358-11100`。
- 末尾 **`PLAYER_CSS`（`:11199-11844`，约 646 行）** 是字符串拼接的 CSS（`\n` + 单引号行），混在同一个 factory 里。

### 1.4 重复代码与复制粘贴痕迹（明确存在）

| 现象 | 证据 |
|---|---|
| 三套在线面板（QQ/酷狗/网易云）同构复制 | `NCOnePanel` 内自带注释「与酷狗同款」`lib/client.js:7630`、「与 QQ/酷狗同规矩」`:7644`；登录态 state 结构一样 `:7625-7651` vs `:8870-8895` |
| 扫码轮询定时器三份 | `:7672-7688`（1500ms tick）| 
| 分页 state 两套并存 | `browseTab: mine\|recommend\|category\|tops\|new\|search` `:8874`，分页字段 `:8888-8895` |
| UA 魔法串至少 3 处 | `lib/index.js:20`（`QQ_USER_AGENT`）、`lib/index.js:4958`（`NC_STREAM_UA`，**定义在 serve 函数内部**）、`lib/netease.js:29-30`（`UA_WEB`/`UA_DESKTOP`） |
| 网易云路由处理与 netease.js 语义重叠 | 17 条 `/dsh-music/nc/*`（`:4960-5198`）每条都先 `await loadNCCookie()` 再调 `NC.*`，属于「薄包装 ×17」的重复样板 |

结论：**「复制粘贴谱系」主要发生在 client.js 的三套平台面板之间**，以及 index.js 的 17 条 nc 路由样板。netease.js 本身没有重复代码（24 个 `// =====` 分区，每个函数带 JSDoc）。

---

## 2. `lib/netease.js` 质量与边界

### 2.1 功能面：25 个具名导出（不是 26）

`grep '^export (function|const|async)'` 的完整清单（**25 个**）：

| 分类 | 导出（行号） | 备注 |
|---|---|---|
| 加密原语 | `md5Hex:42`、`weapi:83`、`linuxapi:92`、`eapi:98` | 全部纯函数，可单独测 |
| 归一化 | `normalizeSong:166`、`cookieValue:636` | 统一形状 `{id,title,artists,album,albumId,cover,interval,fee,privilege:{st,pl,dl,maxbr},source:'nc',link}`（`:166-184`） |
| 搜索/发现 | `search:211`、`searchPlaylist:234`、`getTopLists:250`、`getTopListSongs:264`、`getRecommendedPlaylists:285`、`getPlaylistCategories:292`、`getCategoryPlaylists:304` | `search` 主 linuxapi `/api/cloudsearch/pc`、备 weapi `/weapi/search/get`；`limit=30` 硬编码 `:213` |
| 歌单读 | `getPlaylistSongs:318`、`getMyPlaylists:380` | v6/detail + trackIds 差集，`BATCH=500` `:331`，`/weapi/v3/song/detail` 去重保序 |
| 歌单写 | `subscribePlaylist:412`、`createPlaylist:442`、`deletePlaylist:463`、`manipulateTracks:480` | 收藏/取消、建/删、加/删曲（`op: add\|del`） |
| 账号 | `getAccount:367` | 返回 profile/vipType |
| 播放链 | `getDownloadURL:506` | `/weapi/song/enhance/player/url`，**固定 `br:999000` `:509`**，返回 `{url,level,br,fee,code,freeTrialInfo,quality}`，`QUALITY_LABELS:500` |
| 歌词 | `getLyric:533` | weapi(`yv:-1`) + GET `/api/song/lyric` 兜底，返回 `{lyric,trans,roma,yrc}` |
| 扫码登录 | `createQRLogin:565`、`qrSvgDataUrl:583`、`checkQRLogin:599` | `unikey type=3`，二维码内容 `https://music.163.com/login?codekey=<unikey>`，`expiresAt=now+5min` |

> 用户任务里写「26 个导出的功能面」，**实测是 25 个具名导出**；若把 `getLyric` 的 4 个返回值算成 4 个能力，功能面约 28 项。建议以 25 为准。

### 2.2 三套加密的实现方式

| 方案 | 实现 | 证据 |
|---|---|---|
| weapi | `AES-128-CBC` 两层（随机 16 位 `crypto.randomInt` secret 先加密，再用 `PRESET_KEY='0CoJUm6Qyw8W8jud'` 包一层），末尾 `RSA-no-padding` 用大整数模幂加密 secret | `aesCbc:58`、`rsaNoPad:66-80`、`weapi:83-89`、常量 `:29-40` |
| linuxapi | `AES-128-ECB` 加密 `{method,url,params}` 整体，表单字段 `eparams`，密钥 `LINUXAPI_KEY='rFgB&h#%2?^eDg:Q'` | `aesEcbHex:62`、`linuxapi:92-95` |
| eapi | 摘要串 `` `nobody${urlPath}use${text}md5forencrypt` `` → md5 → `AES-128-ECB`，密钥 `EAPI_KEY='e82ckenh8dichen8'`，走 `interface3.music.163.com` + cookie 拼接 `os=pc; appver=8.9.75; ` | `eapi:98-103`、`eapiPost:130-134` |

实现细节质量：`rsaNoPad` 用 BigInt 手写模幂并按 256 字节 `padStart`，没有依赖 `node-forge`——这是**零依赖**的关键；`randomInt` 保证每次 weapi 的 secret 不同（也意味着 `weapi()` 输出不可重现，测试需注入或只做形状断言）。

### 2.3 请求层与错误处理风格

- `fetchWithTimeout:44-52`：`AbortController`，**默认超时 12000ms 是单点硬编码**，所有请求共用，没有按接口区分。
- `formPost:109-124`：统一返回 `{status,json,text,setCookie}`，其中 `setCookie` 取 `res.headers.getSetCookie()`（**要求 Node ≥ 19.7，实际靠 engines `>=20` 兜住**）。
- 错误风格：**「业务码统一断言 + 抛裸 `Error`」**——`assertOk:146-154` 在 `code != 200` 时 `throw new Error(msg)` 并挂 `err.ncmCode`；全文 **21 处 `throw new Error`、8 个 try / 7 个 catch**，**3 处静默吞异常**（`:219` 搜索回退、`:341` 批量补全、`:541` 歌词兜底）。没有 `Error` 子类、没有重试、没有退避、没有限流——虽然仓库里有 `lib/fetch-limit.js:33` 的限流器，但 **netease.js 完全没用它**（`:22-23` 只有两个 import）。
- 错误消息全中文，可直接透传给 LLM（`index.js` 的 nc 路由确实这么做了）。

### 2.4 依赖与耦合

| 检查项 | 结果 | 证据 |
|---|---|---|
| npm 运行时依赖 | **零**（`package.json` 无 `dependencies`） | package.json |
| Node 内置依赖 | `node:crypto` | `lib/netease.js:22` |
| 同目录依赖 | `./vendor/qrcode.mjs`（唯一） | `lib/netease.js:23`、`lib/vendor/qrcode.mjs:27` |
| 对 `lib/index.js` 的耦合 | **无**（index.js 单向 import 它：`lib/index.js:484`） | grep |
| 全局状态 / 进程状态 | 无 `process`/`fs`/`require`/`__dirname`（0 命中）；**无顶层 `let`/`var`**；模块级仅 const 查表 | grep |
| 隐式环境约定 | 全局 `fetch`（Node ≥ 18，engines 保证 `>=20`） | `lib/netease.js:44` |

耦合方式是**参数注入**：需要登录态的接口签名统一为 `(..., cookie = '')`（如 `search:211`、`getMyPlaylists:380`、`getDownloadURL:506`、`getLyric:533`），状态由宿主保管——`lib/index.js:2641` 的 `const nc = { cookie, userId, nickname, vipType, loggedIn }`。

### 2.5 「单独拷走能不能跑」

**能，但必须连 `lib/vendor/qrcode.mjs` 一起带**，否则 ESM 解析期直接 `ERR_MODULE_NOT_FOUND`。

| 场景 | 结论 |
|---|---|
| 只搬 `lib/netease.js` | ❌ 失败：`:23` import 不存在 → 启动即崩 |
| 搬 `lib/netease.js` + `lib/vendor/qrcode.mjs`（保持 `netease.js` 与 `vendor/` 的相对位置） | ✅ 可直接工作：只需 Node ≥ 20，无需 npm install，无需构建 |
| 只搬 `netease.js` 并改写 `qrSvgDataUrl` 的二维码调用 | ✅ 可行：`:583-589` 是唯一使用 `qrcode` 的地方，改成返回 `unikey` 字符串或换库即可，代价是失去本地 SVG 生成 |
| 搬 `lib/lyric.js`（若想复用歌词兜底链） | ⚠️ 会连带拉入 `lib/qq.js:13`→`lib/qrc.js`、`lib/kugou.js:21`→`lib/krc.js`、`lib/fetch-limit.js`，共 7 个文件；只做网易云不需要它 |

移植时需注意的两个隐性缺口：

1. `getDownloadURL` **不暴露音质参数**（`:509` 写死 `br:999000`），登录态之外的档位不可选；若我们要 320k/128k 选择，得加参数并透传 `level`。
2. **无播放记录 / 听歌统计接口**——`grep 'record|week|/weapi/v1/'` 在 netease.js 里只命中 `:379` 的 `getMyPlaylists` 注释。周报/画像所需的历史数据接口 **必须自己补**（见 5.2）。

---

## 3. DSH 集成写法

### 3.1 插件导出契约（host half）

```js
export const name = 'dsh-music-player'                 // lib/index.js:1513
export const inject = ['webServer','fs','shell','tools','systemPrompt','llm']  // :1514
export function apply(ctx) { ... }                      // :1516
```

- 依赖注入通过 `inject` 声明，运行时用 `ctx.webServer` / `ctx.fs` / `ctx.shell` / `ctx.tools` / `ctx.systemPrompt` / `ctx.llm` 取用（`:5645`、`:5829`、`:6207`、`:1525`）。
- 所有副作用都包在 `ctx.effect(fn, 'label')` 里以便卸载：路由 `:5645`、三个 tool `:5829`/`:6103`/`:6204`。
- 启动期 `void` 调用 5 个异步初始化 `:6227-6231`（`loadQQCookie/loadRadio/ensureStarted/rebuildTimer/rebuildCleanupTimer`）——**没有 await，失败只打日志**。
- 插件行由 `cordis.patch.yml:6-8` 插入：`- id: music-player` / `name: 'dsh-music-player'`（注释说明 node half 走 `exports["."]`，浏览器 half 走 `exports["./client"]`）。

### 3.2 工具注册：`ctx.tools.register` 的完整结构

`music_play` 的 tool 对象（`lib/index.js:5649-5829`）就是完整范式：

```js
const tool = {
  name: 'music_play',
  description: '……长中文描述（含何时用/何时不用）……',
  parameters: {                                  // :5652-5661
    type: 'object',
    additionalProperties: false,
    properties: {
      query:    { type: 'string',  description: '...' },
      playlist: { type: 'string',  description: '...' },
      source:   { type: 'string',  enum: ['local','web','netease','radio'] },
      action:   { type: 'string',  enum: PLAY_ACTIONS },   // :5648
    },
  },
  output: {                                      // :5662-5674
    schema: { type: 'object', properties: { ok:{type:'boolean'}, /* ... */ } },
    render(_args, value) { return [{ type: 'text', text: `...` }] },
  },
  async execute(args) { ... },                   // :5675-5828
}
ctx.effect(() => ctx.tools.register(tool), 'music-player: music_play tool')  // :5829
```

三个工具的体量对比：

| 工具 | 定义区间 | 注册行 | 说明 |
|---|---|---|---|
| `music_play` | `:5649-5829` | `:5829` | 180 行 execute，内部分支：local/web/netease/radio + 6 种 action |
| `news_broadcast` | `:5830-6103` | `:6103` | 273 行，结构同构 |
| `news_schedule` | `:6105-6204` | `:6204` | 99 行，结构同构 |

网易云入口在 `:5741`：`if (action === 'play' && source === 'netease' && query0 !== '')` → `NC.search()` → 写 `pendingIntent`，**真正的播放在浏览器侧执行**（见 3.5）。

### 3.3 提示词注入

```js
ctx.systemPrompt.section({ name: 'tool:music-player',      order: 116, text })            // :6207
ctx.systemPrompt.section({ name: 'tool:music-player-news', order: 117, text: [...].join('\n') })  // :6213-6225
```

`news` 那一段是**约 10 行的超长中文指令串**（`order:117`），把「每条摘要 ≤200 字、要自含主语、不得新增类别、候选按 1.5~2 倍提交」等规则写死在代码里（`:6220` 一行超过 800 字）。这是「用 prompt 补代码约束」的典型做法，可读性差但有效。

### 3.4 HTTP 路由：单一 prefix + 巨型 handler

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix', path: '/dsh-music', handler: serve,
}), 'music-player: routes')                                   // :5645
```

- **只有一次注册**，所有路由都靠 `serve`（`:3757-5644`，1888 行）内部 if 链分发：**94 个精确匹配 + 9 个前缀匹配**。
- 网易云相关：`/dsh-music/nc/status:4960`、`login/start:4966`、`login/check:4977`、`login/logout:4996`、`search:5001`、`play:5011-5048`、`lyric:5050`、`playlists:5069`、`playlist-categories:5081`、`playlist-search:5086`、`my-playlists:5105`、`playlist-collect:5114`、`playlist-create:5128`、`playlist-delete:5141`、`playlist-add:5154`、`playlist-remove:5168`、`top-lists:5181`、`top-songs:5186`。
- 其它：`manifest:3762`、`rescan:3787`、`prefs:3815/3820`、`intent:3940`、`news/:4074`、`book/:4140`、`qq/play:4420`、`qq/playlist:4567`、`kg/play:4736`、`kg/playlist:4832`、`kg/my-playlist:4869`。
- **没有静态资源服务**：全文件无 `createReadStream`/`sendFile`/静态中间件（grep 零命中）；客户端 JS 不由本插件 serve，而是由 DSH 的 `dsh.client` 机制加载 `exports["./client"]`。
- 无鉴权、无 CSRF token：路由靠 DSH 的本地 webServer 边界；`:4966` 等 POST 只校验方法。

### 3.5 客户端 UI 怎么挂

三件套：

1. **`package.json` 的 `dsh` 字段**：`dsh.bundle.patch = "./cordis.patch.yml"`、`dsh.client = { inject: ["@deepseek-ai/dsh-client-ui-slots"], platform: "web" }`——声明依赖哪个客户端 UI 槽位包、目标平台。
2. **客户端模块契约**（`lib/client.js:20-28`、`:11846-11848`）：
   ```js
   window.__ModuleLoader__.load({
     id: 'dsh-music-player',
     factory: (require) => {
       const React = require('react')
       const ReactDOM = require('react-dom')
       var module = { exports: {} }
       // ... 全部 UI ...
       return module.exports
     },
   })
   ```
   `module.exports = { apply, inject }`（`:11195-11196`），**没有 `name` 导出**——模块身份由 loader 的 `id` 决定。`inject = ['slots']`（`:10974`），`apply(ctx)` 里 `const slots = ctx.get('slots')`（`:10976`），取不到就静默 return。
3. **插槽名与注册**（`:11175-11190`，3 个 slot / 4 个注册）：

| 插槽 | 注册 id | order | 组件 |
|---|---|---|---|
| `conversation.input.dock` | `music-player-bar` | 40 | `NowPlayingBar placement="dock"` |
| `shell.overlay` | `music-player-bar-floating` | 19 | 悬浮播放条 |
| `shell.overlay` | `music-player-panel` | 20 | `PlayerPanel` |
| `shell.overlay` | `music-player-lyric-panel` | 21 | `LyricPanel` |

注册形态：`slots.inject('<slotName>', () => slots.register({ name, id, order }, () => React.createElement(...)))`，每个都包在 `ctx.effect` 里。CSS 由 `ctx.effect` 注入 `<style data-plugin>`（`:10979`）。

### 3.6 音频在哪播

**音频在浏览器里播，由 host 代理流。** 链路：

1. 浏览器侧创建原生 `<audio>`（`:10987` `attachAudioElements()`），`audio.src = track.url`（`:11153`）——`track.url` 指向 host 路由（本地文件 `/dsh-music/<id>`，网易云 `/dsh-music/nc/play/<id>`，QQ/KG/电台类似）。
2. host 侧 `/dsh-music/nc/play/<id>`（`:5011-5048`）：正则校验 id → `ncTake(id)` 取链（`:2649`，带 **200 条上限的 URL 缓存** `:2648`、`:2659`）→ 透传浏览器 `Range` → 上游 fetch（注入 `NC_STREAM_UA`、`Referer: music.163.com`）→ 回写 `Content-Type/Accept-Ranges/Content-Range/Content-Length` + 自定义头 `X-DSH-NC-Quality:5034`、`X-DSH-NC-Trial:5036` → `for await (const chunk of stream.body) res.write(chunk)` 手写流管道。取链失败按 `fee 1/4/其它` 返回 404 中文原因。
3. 频谱：`captureStream()` + `AnalyserNode`（**刻意不用 `createMediaElementSource` 以免静音**，`:1-19` 头注释说明）。
4. host→浏览器指令通道：`pendingIntent` + `GET /dsh-music/intent:3940`，客户端 `setInterval(..., 2000)` 轮询（`:11166`），`:11192` 清理。**没有 WebSocket/SSE**。

自动播放被拦截时的降级：`:11157` 捕获 `audio.play()` 失败，提示「浏览器拦截了自动播放，请在播放条点击▶解锁」。

---

## 4. 工程质量

### 4.1 可读性 / 注释密度

| 文件 | 注释行 | 占比 | `// ----` | `// =====` |
|---|---:|---:|---:|---:|
| `lib/index.js` | 1146 | 18% | 45 | 4 |
| `lib/client.js` | 2441 | 21% | 56 | 0 |
| `lib/netease.js` | 135 | 21% | 0 | 24 |
| `lib/qq.js` | 140 | 14% | 0 | 12 |
| `lib/kugou.js` | 183 | 14% | 4 | 17 |

注释**内容质量高、分区稀疏**：平台模块（netease/qq/kugou）用 `// =====` 做函数级横幅、每个导出带 JSDoc，密度虽只有 14-21%，但信息密度大（大量「为何这样写」的坑注释，如 `lib/index.js:2792` 的在途去重说明、`lib/kugou.js:857` 的签名覆盖警告）。真正的可读性问题不是注释少，而是 **1888 行函数 + 268 函数单闭包 + 646 行内联 CSS**。

### 4.2 测试：声称有，实际没有

| 项 | 事实 | 证据 |
|---|---|---|
| `package.json` 脚本 | `test: "vitest run"`、`ci: "vitest run --retry=2 --testTimeout=20000"` | package.json |
| 依赖 | `vitest ^4.1.10`、`jsdom ^24.1.3`、`react-dom ^18.3.1` | package.json |
| 实际测试文件 | **0 个**（`glob **/*{test,spec}*` 零命中；全包仅 20 文件） | — |
| 配置文件 | **无** `vitest.config.*` | — |
| README 声称 | `README.md:227`「npm test 跑 vitest 套件（Host 单测 + Web 渲染冒烟，共 500+ 用例）」；`:236` 指向 `CONTRIBUTING.md`（不存在） | `README.md:227`、`:236` |

**能跑吗：不能。** `npm test` 会以 `No test files found` 非零退出；`ci` 脚本同理。这是本次评审里最直接的「不可复用为基线」信号——**我们无法用它的测试验证我们移植后的行为**，只能自己补测试。

### 4.3 依赖 / 构建 / Node

- **零 npm 运行时依赖**（`package.json` 无 `dependencies`）；`peerDependencies: react ^18.2.0`（宿主提供 React）。
- **无构建步骤**：源码即产物。host half 是纯 ESM（`"type": "module"`），client half 是**手写 IIFE 风格的 ModuleLoader bundle**（`lib/client.js:20`），由 DSH 的客户端加载器直接吃。**修改 client.js 不需要重新打包，但需要重新加载插件**。
- `engines.node >= 20`；实际硬依赖：全局 `fetch`（≥18）、`res.headers.getSetCookie()`（≥19.7）、`crypto.randomInt`。README `:223` 额外建议 vitest 用 20.19+。
- `import` 图（可作移植清单）：
  - `lib/index.js:477-500` → `fs/path/zlib/os/module` + `./qq.js`、`./kugou.js`、`./netease.js`、`./radio.js`、`./hls.js`、`./yrc.js`、`./lyric.js`、`./whatsnew.js`、`./calendar.js`、`./news-core.js`
  - `lib/lyric.js:15-18` → `./qq.js`、`./kugou.js`、`./netease.js`、`./fetch-limit.js`
  - `lib/kugou.js:20-21` → `node:crypto`、`./krc.js`；`lib/qq.js:13` → `./qrc.js`；`lib/news-core.js:8` → `./calendar.js`；`lib/netease.js:22-23` → `node:crypto`、`./vendor/qrcode.mjs`（**叶子节点，依赖最浅**）。

### 4.4 明显的坑

| # | 坑 | 证据 | 影响 |
|---|---|---|---|
| 1 | **1888 行单函数** `serve` | `lib/index.js:3757-5644` | 加任何路由都要在巨型 if 链里找位置；无法单测；圈复杂度爆表 |
| 2 | **apply 闭包可变状态**（`nc`、`tracks`、`books`、`pendingIntent`…） | `:1517-1523`、`:2641` | 多实例/热重载时会话状态混杂；测试需重建整个插件 |
| 3 | nc URL 缓存有 TTL 但**不缓存负结果**、`err` 字段不外露 | `:2647` `NC_TAKE_TTL_MS = 5*60*1000`、`:2652` 过期判断、`:2661-2663` 失败也返回带 `err` 的 entry 但 `:5011-5048` 只用 `url/fee` | 取链失败会每次都重打上游；排障时看不到 `err` |
| 4 | **cookie 明文 JSON 落盘**（仅靠 `0o600` 权限兜底） | `:2671` `music-player-netease-cookie.json`（`DSH_HOME` 或 `~/.dsh`）、`:2694` `writeFileSync(..., { mode: 0o600 })` | 同一用户下其它进程/备份可读；账号凭据泄漏风险 |
| 5 | 魔法数散布 | `br:999000`(`netease.js:509`)、`limit=30`(`:213`)、`BATCH=500`(`:331`)、`12000ms`(`:44`)、`2000ms` 轮询(`client.js:11166`)、`1500ms` 扫码 tick(`:7672`) | 调参要全仓搜 |
| 6 | 3 处静默吞异常 | `lib/netease.js:219`、`:341`、`:541` | 搜索/批量补全/歌词失败不可观测，只能从「结果变少」推断 |
| 7 | UA 串三处重复且一处定义在函数体内 | `lib/index.js:20`、`:4958`、`lib/netease.js:29-30` | 换 UA 要改三处，易漏 |
| 8 | 无重试/无退避/无限流（netease 路径） | `lib/netease.js` 全文；`lib/fetch-limit.js:33` 存在但未被引用 | 批量建 30 首场景歌单会连打 30+ 请求，风控风险 |
| 9 | 文档与实现矛盾 | `README.md:144`「未登录只显示登录入口」vs `:152`「匿名取链…未登录也能播」 | 用户预期错位 |
| 10 | 客户端无 `name` 导出、身份靠 loader id | `lib/client.js:11195-11196` | 换宿主或改 id 会静默不挂载 |
| 11 | `systemPrompt` 里塞 10 行硬编码指令 | `lib/index.js:6213-6225` | 提示词与代码逻辑耦合，改行为要改两处 |
| 12 | 无 E2E / 无冒烟脚本 | 无 `test/` | 任何改动都只能靠手点 |

---

## 5. 复用结论

### 5.1 方案 A：只移植 `lib/netease.js`（对应 DESIGN.md 路线 B）

**结论：可行，边界干净，是本次评审里唯一推荐的复用方式。**

- 边界评价：**A 级**。无全局状态、无 `fs`/`process` 依赖、cookie 全参数注入、只依赖 `node:crypto` + 同目录 `vendor/qrcode.mjs`。
- 必带文件（最小集）：
  1. `lib/netease.js`（639 行）
  2. `lib/vendor/qrcode.mjs`（2237 行，MIT © 2009 Kazuhiko Arase）——**保持相对路径 `./vendor/qrcode.mjs`**，否则 ESM 解析期崩
- 可选带：
  - `lib/yrc.js`（72 行）——若要做**逐字歌词**（二创必需）：`parseYrc` 把 `getLyric` 返回的 `yrc` 解析成逐字时间轴（`lib/yrc.js:29`），零依赖。
  - `lib/fetch-limit.js`（84 行）——批量请求限流，`createLimiter({maxConcurrent, minGapMs, maxQueue})`（`:33`）；netease.js 自己没用，但我们的场景歌单会需要。
- 移植时需要补/改的点（都在 netease.js 内部，改动可控）：
  1. `getDownloadURL` 加音质参数（现在 `br:999000` 写死，`:509`）。
  2. 补**播放记录/统计接口**（周报必需，见 5.2）。
  3. `search` 的 `limit=30` 参数化（`:213`）。
  4. 给 `assertOk` 换成有 `code` 字段的 Error 子类，便于我们统一映射 HTTP 状态。
  5. 把 `weapi` 的随机 secret 做成可注入，否则单测无法固定输出。
- 难度：**低**（半天到一天），风险集中在「接口是否仍有效」而非代码本身。

### 5.2 方案 B：在它上面加「场景歌单 / 口味画像 / 听歌周报 / 歌词二创」

先明确**能力缺口**（netease.js 没有的）：

| 需求 | 现有能力 | 缺口 |
|---|---|---|
| 场景歌单 | 搜索、榜单、分类歌单、歌单读写全有（`:211-494`） | 无「按标签/情绪批量取歌」接口；无并发限流；歌单写操作只支持 add/del，不支持改描述/封面/排序 |
| 口味画像 | `getAccount:367`、`getMyPlaylists:380` | **无历史播放数据接口**（`grep 'record'` 零命中）；画像只能靠我们本地埋点自采 |
| 听歌周报 | 无 | 同上；且 DESIGN.md 拟验证的 `/weapi/v1/play/record?uid=&type=0\|1` **不在本模块内**，需新增约 30 行 + cookie 权限 |
| 歌词二创 | `getLyric:533`（含 `yrc` 逐字）、`lib/yrc.js:29` 解析器 | 无缺口；**这是复用价值最高的一块**，可直接接 LLM 做二创 |

若选择「fork 整仓再改」，要动的文件与难度：

| 文件 | 要动什么 | 难度 | 判断 |
|---|---|---|---|
| `lib/netease.js` | 加 3-5 个导出（播放记录、按标签取歌、批量取链） | ★★☆☆☆ | 值得，改动局部 |
| `lib/index.js` | 在 1888 行 `serve` 里加 6-10 条路由 + 2-3 个 tool + 状态 | ★★★★☆ | **不推荐**：插入点恶劣，且要理解 1517-1523 的全部闭包状态 |
| `lib/client.js` | 加画像/周报面板 | ★★★★★ | **强烈不推荐**：795KB 单闭包、268 函数共享 player 上下文、三套面板已复制粘贴；新面板会变成第四份 |
| `package.json` / `cordis.patch.yml` | 改名、改 id | ★☆☆☆☆ | 但改了 id 客户端就不挂载（`lib/client.js:20` 的 `id` 必须与 `cordis.patch.yml:7` 的 `name` 对应） |

**难度结论**：画像/周报/二创的数据层可以在 netease.js 上轻量长出来（净增 200-300 行），但**渲染层（client.js）和工具编排层（index.js）不可复用**。按 DESIGN.md 的「自己写壳」路线，正确做法是：**只搬 netease.js（+vendor/qrcode.mjs、yrc.js、fetch-limit.js），壳全部重写**。这样我们的代码量约 1-2k 行可控，而 fork 后要维护 18k 行不可测代码。

### 5.3 一句话决策

> netease.js 值 30KB，index.js + client.js 值 0——不是因为它们写得烂，而是因为**没有测试、没有分区、1888 行函数**让「改一点点」的成本高于「重写」。

---

## 6. 许可证与合规

### 6.1 LICENSE 原文要点

`LICENSE`（21 行，1064 字节）：标准 **MIT**，`Copyright (c) 2026 kendu76`。

- ✅ 允许：商业/非商业使用、修改、分发、再许可，**只需保留版权声明与许可声明**。
- ❌ 不提供担保；作者不承担任何责任。
- ⚠️ **MIT 只覆盖「代码著作权」，不覆盖**：网易云/QQ/酷狗的音乐内容、歌词文本、平台接口、账号数据。搬走 `netease.js` 后，**接口使用本身的合法性不因 MIT 而改变**。

### 6.2 代码里的风险声明（作者写得很明确）

| 位置 | 原文要点 |
|---|---|
| `lib/netease.js:18-19` | 「均为非官方接口 + 流播受版权保护音乐，仅用于个人试听/学习，**违反平台 ToS**，风险自担；账号风控风险由使用者承担。**严禁解灰/绕过版权限制**（见 docs §4.5）」 |
| `lib/qq.js:10` | 同款声明，QQ 扫码「需大陆 IP，接口有地理/WAF 风控」 |
| `lib/kugou.js:16-17` | 同款 + 「账号风控风险（SSA 验证码/封禁）由使用者承担」 |
| `lib/krc.js:14`、`lib/qrc.js:19`、`lib/yrc.js:13`、`lib/lyric.js:10-11`、`lib/radio.js:11` | 歌词/数据版权归平台与著作权人，仅个人试听 |
| `lib/client.js:8207`、`:7391`、`:9655`、`:10165` | UI 内嵌免责声明（未登录页 + 关于页），措辞为「非官方接口、仅供个人学习/技术研究/日常试听，严禁商业用途、公开传播、二次分发或盈利」 |
| `README.md:312` | MIT © kendu76 |

### 6.3 给我们的合规提示

1. **`netease.js` 的声明必须原样保留**（`lib/netease.js:18-19`），并保持 MIT 版权头；建议在我们仓库的 `NOTICE`/`THIRD_PARTY` 里登记 `kendu76/dsh-music-player`、`vendor/qrcode.mjs`（© 2009 Kazuhiko Arase, MIT）。
2. **「严禁解灰/绕过版权限制」是作者的硬约束**——我们做场景歌单/画像/周报时，**不得**引入 VIP 绕过、地区解锁、DRM 规避；`getDownloadURL` 的 `fee` 判断（`lib/netease.js:506-522`）应当保留并透传给 UI。
3. **账号 cookie 是最大合规/安全风险点**：`lib/index.js:2694` 以明文 JSON 落盘（仅有 `mode: 0o600` 兜底）。我们若沿用扫码登录，应改为 DSH 密钥存储或进程内存 + 用户显式同意，且**不允许把 cookie 写进日志/周报数据**。
4. **二维码相关**：`lib/netease.js:565-629` 的登录流是「模拟官方网页扫码」，非官方 OAuth；分发时应在 README 显著位置声明，避免用户误认为官方授权。
5. **文档引用断链**：`lib/netease.js:19` 指向的 `docs §4.5` 不在发布包内，**我们无法据此主张「已评估过合规风险」**——若要在内部做合规评审，需要自己补一份风险评估，不能引用上游文档。

---

## 附：评审速览

| 维度 | 评分 | 依据 |
|---|---|---|
| `lib/netease.js` 可复用性 | ★★★★★ | 零依赖、无全局态、参数注入（`:22-23`、`:211`） |
| `lib/index.js` 可复用性 | ★★☆☆☆ | 1888 行 `serve`（`:3757-5644`）、闭包状态（`:1517-1523`） |
| `lib/client.js` 可复用性 | ★☆☆☆☆ | 795KB 单闭包、手写 loader 契约（`:20`）、646 行内联 CSS |
| 测试 | ☆☆☆☆☆ | 无测试文件，README 声称 500+ 用例（`README.md:227`） |
| 文档 | ★★★☆☆ | README 详实但与实现有矛盾（`:144` vs `:152`） |
| 合规声明 | ★★★★☆ | 每个平台模块头部 + UI 免责（`lib/netease.js:18-19` 等） |
| 许可证风险 | 低 | MIT，仅需保留声明（`LICENSE`） |
