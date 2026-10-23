# ncm-plugin

DSH 的网易云音乐插件：播放器 + 侧栏面板 + AI 对话控制，外加四项差异化能力——场景歌单、口味画像、听歌周报、歌词二创。

仓库：<https://github.com/harehareya66/music-ai-netease>

**开工先读 [`HANDOFF.md`](./HANDOFF.md)**（交接 + 第一步做什么），执行口径看 [`PLAN.md`](./PLAN.md)（分层设计、目录、里程碑、验收）。

## 现状（2026-10-22）

- [x] 调研 kendu76 与 doitian 两份源码（`analysis/` 下两份评审，全部带行号），路线定稿 **B″**
- [x] 基座就位：doitian v1.2.0 的 `lib/` 已复制进本仓（播放内核 / 客户端契约 / 扫码登录 / AI DJ / SSE 原样保留）
- [x] L3/L4 纯模块：`lib/core/{models,history,tags,taste,report,scene,lyric}.js`，零 ctx/fs/fetch
- [x] 数据层：`session.json` v2 + v1 自动迁移 + cookie `0600` + 历史 2000 条
- [x] 聚合层：`lib/features.js`（画像/周报/场景/歌词/二创）、`lib/model.js`（LLM 取用）、`lib/tagstore.js`（标签缓存）
- [x] 13 个工具（旧 7 + 新 6）与 5 个独立页（`/music/{library,taste,weekly,scene,lyric}`）
- [x] 曲库页：登录后看自建/收藏歌单、最近播放、每日推荐；点歌单出曲目列表，点行即播（H5 登录后「没有歌单」的反馈补的）
- [x] 端到端冒烟：`node --test` 48/48（含 apply 挂载、13 工具、页面路由、API 空态、检查台、账号画像、歌单写入）
- [x] 制作者检查台 `/music/dev`：环境事实 + M0 探针结论 + 12 项功能自检 + 六页入口 + 人工清单
- [x] 交互（10-23）：面板加「开始 DJ」按钮并等 plan 回执；歌单默认 18 张 +「显示全部」；底部浮空岛 `lib/ui/mini.js` 在六页共享播放条——播放/切歌不离开当前页，壳里只遥控、纯 H5 自己接管音频
- [ ] **M0 真实账号验证**：V1 ✅ 可读 / V2 ✅ 可用 / V3 ✅ 可用（2026-10-23 探针实测，临时歌单已自动删除）；剩 **V4** 需人在面板点一次「开始 DJ」
- [ ] M1 剩余：面板文案已强制中文，改名与 qrcode 常量双写检查待做
- [x] 画像「全部」接账号听歌记录（累计次数加权，无时间戳的指标留空，见 NOTES §8）
- [x] 写歌单落库：`playlist/create` + `playlist/manipulate/tracks` 接进场景页「存到我的网易云歌单」，失败不静默降级（NOTES §9）
- [ ] M5 剩余：面板本体与概念稿的视觉对齐（页签、底栏、队列行）
- [ ] M6 剩余：二创流式、装进 DSH 后验 V4/A1/A2/A3、发布收尾

## 跑起来

```powershell
cd music-plugin
node --test --test-isolation=none "test/*.test.mjs"   # 54 个用例，纯离线
node scripts/preview.mjs --keep                       # 本地预览五屏（不装 DSH 也能看）
node scripts/fixture.mjs --out "$env:TEMP\ncm-demo"   # 造一份演示数据（看有数据的样子）
node scripts/preview.mjs --data-dir "$env:TEMP\ncm-demo" --port 7789 --keep
node scripts/probe.mjs                                # M0 探针：只读，V2/V3 默认 dry-run
node scripts/probe.mjs --write                        # 真建临时歌单验 V2/V3，验完自动删
```

预览服务起来后，打开 **`/music/dev`**（或面板右上「检查台」）就能看到：环境事实、`probe.json` 里的
M0 结论、逐项功能自检（六页 + 六个 API + 场景草稿）、六页入口和人工检查清单。

`scripts/probe.mjs` 读 `~/.dsh/music/session.json` 的 cookie（只打印指纹），验证 V1-V4 后按提示把结论抄进 [`NOTES.md`](./NOTES.md) 并回填 [`PLAN.md`](./PLAN.md) §6.4。

## 装进 DSH

插件包名 `ncm-plugin`，零运行时依赖、无构建步骤，`lib/index.js` 是入口，`cordis.patch.yml` 是 bundle patch。装法二选一：

1. **插件市场**：把本目录打成 tarball（`npm pack`，产出 `ncm-plugin-0.1.0.tgz`），用 DSH 设置里的插件安装入口装本地包，然后重启 DSH。
2. **手动（桌面 profile 已按这条路装过一次）**：

   ```powershell
   $profile = "$env:USERPROFILE\.dsh\profiles\desktop"
   New-Item -ItemType Directory -Force "$profile\packages" | Out-Null
   Copy-Item ncm-plugin-0.1.0.tgz "$profile\packages\" -Force

   # package.json 里加一行依赖 + 把 ncm-plugin 追加进 dsh.profile.bundles
   #   "ncm-plugin": "file:./packages/ncm-plugin-0.1.0.tgz"
   #   "bundles": ["@deepseek-ai/dsh-base", ..., "dsh-push-index", "ncm-plugin"]

   node <pnpm.mjs> install --prefer-offline    # 用 DSH 自带的 pnpm
   ```

   然后**完全退出并重启 DSH**。登录态可以从预览目录搬过来，省一次扫码：

   ```powershell
   Copy-Item "$env:TEMP
cm-demo\session.json" "$env:USERPROFILE\.dsh\music\session.json" -Force
   ```

   没搬也没关系，装上后在面板右上「登录」扫码即可；之后所有会话共用 `~/.dsh/music/session.json`。

装好后：侧栏出现「音乐」，面板顶部有 `曲库 / 画像 / 周报 / 场景 / 歌词二创 / 检查台` 六个入口；对话里可用 `music_search`、`music_play`、`music_dj`、`scene_build`、`taste_profile`、`weekly_report`、`lyric_remix` 等 13 个工具。

## 在浏览器（H5）里测

插件还没装进 DSH profile 时，浏览器测试走本地预览服务：

```powershell
node scripts/preview.mjs --data-dir "$env:TEMP\ncm-demo" --port 7789 --keep
```

打开 <http://127.0.0.1:7789/music/panel> → 右上「登录」→ 手机网易云扫码；没有在播时会自动跳到 `/music/library`（曲库），面板顶部也随时有「曲库」入口。登录态写在 `--data-dir` 指向的 `session.json` 里，换端口记得带同一个 `--data-dir`。

## 文档

| 文件 | 是什么 |
|---|---|
| [`PLAN.md`](./PLAN.md) | 项目计划书：范围、L0-L5 分层设计、目录结构、数据模型、接口清单、里程碑与验收 |
| [`FLOWS.md`](./FLOWS.md) | 产品流程 / 使用剧本 / 状态机 / 异常流程 / 交互原则 |
| [`HANDOFF.md`](./HANDOFF.md) | 对话总结与交接：已定决策、已核实事实、四个待验证项、开工指引 |
| [`ANALYSIS.md`](./ANALYSIS.md) | 两份参考源码评审与路线选择（为什么 B″） |
| [`DESIGN.md`](./DESIGN.md) | 早期决策底稿（已被 PLAN 覆盖，以 PLAN 为准） |
| [`NOTES.md`](./NOTES.md) | 实测记录：环境快照、M0 结论表、踩坑、A1-A10 验收进度 |
| [`design/`](./design/README.md) | 五屏概念稿：真 HTML 原型 + 截图 + 设计系统 |

## 参考

- [@doitian/dsh-music](https://github.com/doitian/dsh-music)（MIT）—— 基座：播放内核 / 客户端契约 / 登录 / DJ
- [kendu76/dsh-music-player](https://github.com/kendu76/dsh-music-player)（MIT）—— 零件：歌单写操作 / 逐字歌词 / 限流器

两套源码解包在 `.reference/`（仅供参考，不进交付包）。
