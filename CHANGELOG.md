# Changelog

## 2026-09-29 — 移除 5 小时 / 7 天额度（页面与后端服务两侧一起）

### 为什么删

那两格的唯一数据源是 Codex App Server 的**账号级**额度接口（`account/rateLimits/read` 与
`account/rateLimits/updated` 两条 JSON-RPC）。它与用量栏要回答的问题不是一类事实：一个是
**账号级、跨会话**，一个是**本次调用**用了哪个模型、上下文占了多少。

更要紧的是另一侧：Claude Agent SDK **根本没有**这个接口（SDK 只在会话内提示限流）。原实现
让不具备该接口的后端返回 `available: false` + reason ——"宁可显式报取不到也不编一个数字"
这个立场是对的，但代价是每个后端都要为一个与自己无关的窗口维护一份"不可用"。
`ModelGateway` 描述的是"一次模型调用"，账号额度不属于它。

于是按"数据源在哪、消费者有几个"处理：这条链路的消费者只有页面用量栏一个，两侧一起删，
而不是留一条**恒为"不可用"**的路由。

### Changed

后端服务侧：

- 删 `GET /api/v4/codex/rate-limits`（[platform.ts](code/apps/api/src/routes/platform.ts)）。
  模块头的路由计数从 5 条改为 4 条，那条"它怎么吞异常退化成 `available:false`"的维护提示
  换成"这里为什么不再有额度路由、加回来之前先回答什么"——旧注释留着会让下一个人照着加回去。
- `ModelGateway` 删 `readRateLimits()`，以及只为它存在的 `ProviderUsageSnapshot` /
  `ProviderUsageWindow`（[types.ts](code/packages/domain/src/model/types.ts)）。
  **`ProviderEndpoint` 保留**：端点指纹是另一件事，`agent.loop.started` 的 `provider` 字段在用。
- 各实现同步删：[stub-gateway.ts](code/packages/domain/src/model/stub-gateway.ts)、
  [claude-agent-sdk.ts](code/packages/domain/src/model/claude-agent-sdk.ts)，
  以及 Codex 侧的**整条**链路——客户端的 `readRateLimits` / `onRateLimitsUpdated` /
  `rateLimitListeners` / `account/rateLimits/updated` 通知分支，网关的 `rateLimitUnsubscribers` /
  `cachedRateLimits` / `readRateLimits`，以及会话端口上的两个可选方法。
- 删 [model/codex-rate-limits.ts](code/packages/domain/src/model/codex-rate-limits.ts)（Codex
  响应形状与 `mapCodexRateLimits`）及其单测，`index.ts` 上的三个类型导出一并去掉。

页面侧：

- [ProviderUsageFooter.vue](code/apps/web/src/components/ProviderUsageFooter.vue) 只留
  MODEL / CONTEXT 两格：删掉账号额度那一块、它的取数（`api.codexRateLimits()`）与
  加载/错误态。**`props` 形状没变**，ExplorerView 与 RunDetailView 的调用点一行没改。
- [api.ts](code/apps/web/src/api.ts) 删 `codexRateLimits()`、[types.ts](code/apps/web/src/types.ts)
  删 `CodexRateLimitValue` / `CodexRateLimitsStatus`、
  [explorerStatus.ts](code/apps/web/src/utils/explorerStatus.ts) 删 `formatRateLimit`
  （`formatContextUsage` 保留——上下文占用是 provider 无关的指标）、
  [styles.css](code/apps/web/src/styles.css) 删 `.provider-usage-limits` / `.provider-usage-limit`
  两条已成无主的规则（含 720px 断点里那三条）。

### 留下的不是删除动作，而是理由

- 五处维护提示写的是"**再要加回来，先回答什么**"，不是"这里曾经有什么"：
  `ProviderUsageFooter.vue`、`explorerStatus.ts`、`model/types.ts`、`model/stub-gateway.ts`、
  `platform.ts`。README 的用量栏说明同步改写，`待办事项.md` 里那条已勾选的额度修复下补一行
  "该链路已整体删除"（那条记录本身不动——它是当时的决策）。
- "宁可显式报取不到也不编一个数字"这条立场**没有随代码消失**：它写进了
  `model/types.ts` 的维护提示 8 与 README，成为下次有人要加任何用量面时的判据。

### 防回归断言（两条原先的**正向**断言翻成了负向）

- `ProviderUsageFooter.test.ts` 新增一条"不渲染任何账号级额度"：`.provider-usage-limits` 为
  `null`、`.provider-usage-limit` 长度为 0、正文不含"限额"与"剩余"。
- `ExplorerView.test.ts` 原有的两条 `toContain("5 小时限额")` / `toContain("7 天限额")` 翻成
  `not.toContain`。**翻的时候踩了一次**：直接断言"源码不含『限额』"会撞上组件里那段"为什么删"
  的注释（注释里正写着"5 小时限额 / 7 天限额"），于是先剥掉注释再断言，并把"剥的是注释、
  不是放宽断言"写进注释本身。

### Changed files

- 后端：`code/apps/api/src/routes/platform.ts`、`code/apps/api/src/server.test.ts`。
- 域：`code/packages/domain/src/model/types.ts`、`model/stub-gateway.ts`、
  `model/claude-agent-sdk.ts`、`model/codex-app-server.ts`、`model/codex-app-server.test.ts`、
  `codex-app-server-client.test.ts`、`index.ts`；
  **删除** `model/codex-rate-limits.ts`、`model/codex-rate-limits.test.ts`。
- 页面：`code/apps/web/src/components/ProviderUsageFooter.vue`、`ProviderUsageFooter.test.ts`、
  `api.ts`、`types.ts`、`utils/explorerStatus.ts`、`utils/explorerStatus.test.ts`、
  `views/ExplorerView.test.ts`、`styles.css`。
- 文档：`code/README.md`、`待办事项.md`。

### Verification

- `pnpm --dir code verify` 通过：domain 289/289、API 73/73、Web 421/421，无新增值级循环依赖。
- **路由真的没了**（重建 `apps/api/dist` 后，在隔离实例上验证）：`curl /api/v4/codex/rate-limits`
  → **404** `{"code":"NOT_FOUND"}`；同文件的另外三条平台路由 `/health`、`/api/v4/mcp/tools`、
  `/api/v4/plugins/tools`、`/api/v4/explorer-plan-requirements` 仍全部 200 —— 删的是那一条，
  不是把 `platform.ts` 删塌了。
- **浏览器实测**（隔离实例，指向快照库，不碰正在跑的服务）：重建 `apps/web/dist` 后打开 Explorer
  需求页，用量栏渲染为 `MODEL gpt-5.6-luna` + `CONTEXT ~0 tokens` 两格；
  `.provider-usage-limits` / `.provider-usage-limit` 命中 0 个；页面正文不含"限额"；
  **控制台无任何报错**；`performance.getEntriesByType("resource")` 里匹配 `rate|limit` 的请求
  **0 条**——面板没了，取数也真的没了，不是渲染时被藏起来。
  （截图见过一次 `gpt-5.6-luna`：那是隔离实例的配置，模型名随 E4 收敛，与本次无关。）
- 全仓 grep `ratelimit|限额|fiveHour|sevenDay|额度`：除 CHANGELOG、`docs/` 下的历史设计文档与
  `pnpm-lock.yaml` 里的 `express-rate-limit`（无关依赖）外，剩余命中**全部是上面那批"说明它
  已删除"的注释与文档**。`待办事项.md` 与历史设计文档按惯例只做记账，不改写。
- **未重启线上服务**：`pnpm start` 跑的那个进程仍持有旧 `dist`，`/api/v4/codex/rate-limits` 在
  它上面还会 200 到下次重启为止。本次只重建了 `dist`，重启留到后端收敛那一轮一起做（那轮还要
  把 `backend` 换成 `claude-agent-sdk`，重启一次就够）。

## 2026-09-28 — 开启事件回收：14 天 / 每聚合保底 200 条

### Changed

- 本地 [pipeline-factory.config.json](code/config/pipeline-factory.config.json) 的 `storage` 段加上 `eventRetentionDays: 14` 与 `eventRetentionMinPerAggregate: 200`。保底条数本来就有同样的默认值，这里**显式写出来**：它决定"每个聚合至少留多少条"，是这套策略的一半，读 config 的人应该在一个文件里看全，而不必去翻 `config.ts` 才知道会删到什么程度。

### 开启前的实测（真实库，只读，未动一行数据）

| | |
| --- | --- |
| 全库事件 | 159,543 行 / 22.8 MB 载荷 |
| 事件时间范围 | 2026-09-12 → 2026-09-28（16 天） |
| **14 天 + 保底 200 会删** | **30,238 行 / 3.9 MB（19.0%）** |

- 删的全是那两个**逐字重复**的逐 token 增量类型：`agent.step.model_text_delta` 15,119 行 + `agent.model.text.delta` 15,119 行。两者各有 15,625 行早于 cutoff，其中 506 行被"每聚合保底 200 条"留下。
- `explorer.turn.text.delta`（32,984 行）与 `project.execution.turn.text.delta`（299 行）**一行都不删**：它们最早分别是 09-17 与 09-26，全在 14 天以内。这不是白名单没生效，是这个库只比 14 天大两天。
- `run.executor.event` 有 10,961 行早于 cutoff，**一行都不删**——按下面「A2 白名单收紧」已移出白名单。
- 30,238 行逐行核实过"最终态另有副本"（方法与其结果见下面「A2 白名单收紧」一节）。

### Verification

- 配置能过 API 的加载器：`loadFactoryConfig()` 解析出 `eventRetentionDays: 14` / `eventRetentionMinPerAggregate: 200`。（`apps/api/dist` 在此之前是**旧的**——回收那几项是 A2 才加进 schema 的，旧 dist 会把它们静默丢掉。这一点是靠这次真的去解析配置、而不是只看文件内容才发现的。）
- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424。

### 首次开启的实测结果（重启前后各取一次全量快照比对）

| | 重启前 | 重启后 |
| --- | --- | --- |
| `domain_events` 行数 | 159,556 | 129,320 |
| 载荷 | 22.81 MB | 18.93 MB |
| `MAX(sequence)` | 220,322 | 220,324 |
| 序号高水位表 | 不存在（旧 dist 建的库） | `last_sequence = 220322` |

**实际删除 30,238 行 / 3.88 MB，与开启前算出的预测逐行一致**，且只动了两个类型：

- `agent.model.text.delta` −15,119 行（−2.65 MB）
- `agent.step.model_text_delta` −15,119 行（−1.23 MB）

其余类型一行未动——包括 `run.executor.event`（它另有 10,961 行早于 cutoff，按上一节移出白名单后不删）。

顺带核实到的两件事：

- 重启后仍存在的最大序号行（220322）就是回收前的 `MAX(sequence)`——**这次没有考到序号回退那条守卫**。回收只摘旧行，被摘的行本来就在序号低位，所以存活行的 MAX 没变，有没有高水位都会得到 220,323。高水位表写对了值，但"它救了谁"要等回收真的摘掉序号最大的那批行才能验到（例如某个聚合整体变旧后）。这一点记在这里，别把它当成"守卫已验证"。
- 重启打断了一个在途的 Explorer 回合（`thread-demo` / `turn-ff9f792d-852`，15:30:55 发起）。没有丢数据：回合被标为 `FAILED` 且 `error = EXPLORER_TURN_RECOVERY_REQUIRED`，`agent_loop_steps` 里留下 `LOOP_RESUMED / MODEL_STARTED / PROVIDER_ACTIVITY×2 / LOOP_FAILED` 共 5 步——这正是启动期"未结束的回合标记为待恢复"那条路径该有的样子。**重启前的在途检查只看了 runs / dispatch states，漏了 Explorer 回合**：那个回合是重启前 40 秒才发起的，检查时还不存在。要重启一个正在被使用的实例，这一条得算进去。

## 2026-09-28 — A2 白名单收紧：run.executor.event 移出

### 结论：那一条的依据在真实数据上不成立

A2 把 `run.executor.event` 中 `payload.type === 'MODEL_OUTPUT'` 的部分列进了可回收白名单，依据是
"它是 `execution_journal` 那一行的镜像"。白名单的**判据只有一条**——*最终态另有持久化副本*——
所以在真的按下开关之前，把这个类型**待删的每一行**拿去和 `execution_journal` 逐行关联（不是抽样）。
结果是一条都关联不上，原因是两处：

1. **历史行的载荷里根本没有 `sequence` 字段**（当前代码才写它）。载荷长这样：
   `{"executionThreadId":"execution-thread-b56cb883-72e","type":"MODEL_OUTPUT","text":"I"}`。
   没有 `sequence` 就无法定位 journal 里的对应行，副本"可能存在"但**无法证明存在**。
2. 更要紧的是：这些行绝大多数属于**已经被删除的 run**。run 删掉时 journal 与 execution_thread 一起
   没了，**这些事件是那段模型输出的唯一记录**。实测单个已删除的 `run-1491d6e7-70e` 就有 9,408 条，
   它的 journal 行数、runs 行数、execution_threads 行数全是 0。

它们是垃圾——这一点没错。但白名单的判据是"**另有**副本"，不是"看起来没用"。收据不成立就不能删，
于是把这个类型整个移出白名单（`isPrunableEvent` 退回成一句纯白名单查询，SQLite 侧那条 `prunable`
也去掉了 `json_extract`）。

另一条被引用的依据也一并纠正：A2 原文引 `run/dispatch-coordinator.ts` 的 `isStreamingEvent`
"只影响展示进度，不需要逐条 reconcile"。那是说**不需要逐条对账**，与"数据有副本"是两件事，
不能拿来当回收依据。

### Changed

- [event-retention.ts](code/packages/domain/src/store/event-retention.ts)：`PRUNABLE_EVENT_TYPES` 现在是全部规则，`isPrunableEvent` 只剩一句 `includes`。模块头记下了这次的证据，并新增一条维护提示：**往白名单里加类型之前，在真实库上按聚合逐行验证副本确实存在，而不是只读代码**——上面第 2 条就是这个动作抓出来的，光读代码看不出来。
- [sqlite-store.ts](code/packages/domain/src/store/sqlite-store.ts)：`pruneEvents` 的 `prunable` / `scope` 简化，注释同步。
- [store-contract.test.ts](code/packages/domain/src/store-contract.test.ts)：那条 `prunes only MODEL_OUTPUT among run.executor.event payloads` **反向重写**为 `never prunes run.executor.event, not even its MODEL_OUTPUT payloads`。断言是翻过来的，不是被删掉的——它现在是"判据是副本、不是观感"这条规则在两个实现上的守卫。

### Changed files

- Domain：`code/packages/domain/src/store/event-retention.ts`、`store/sqlite-store.ts`、`store-contract.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。
- 收紧后重跑逐行核实（本次 14 天配置下**实际会删的两个类型**）：`agent.step.model_text_delta` 15,119 行待删、0 行找不到副本（按 `(loop_id, sequence)` 与 `agent_loop_steps` 关联）；`agent.model.text.delta` 15,119 行待删、0 行找不到副本（它的载荷带的是 `providerTurnId` 而非 `sequence`，按"同 loop 同文本"关联，且与上一个类型条数逐字相等、A1a 已停止写入）。`run.executor.event` 现在是 0 行待删。

## 2026-09-28 — D3 结论：只做 D3-1，另两簇记账不做

D3 原计划把 ExplorerView.vue 的 script 块按三簇拆成 `usePlanDetailDrawer` / `useProjectDialogs` /
`useExplorerComposer`。**D3-1 做了，另两簇经核实不该按原样做**——计划里那三簇是照符号名前缀猜的，
不是照实际内聚度划的，和后端 B1 是同一种偏差。

### D3-2 `useProjectDialogs`：前提不成立，且真实规模不值得抽

计划把 `renameDialogOpen` / `renameSaving` / `renameError` 归进"项目与对话框编排"，但它们
**属于线程重命名**：唯一写它们的是 `openRenameDialog` / `renameThread`，而 `renameThread` 与
`isCurrentProjectScope`、`thread`、导航耦合在一起，是一个独立功能，不是项目对话框的一部分。
去掉这三者之后，"项目对话框"只剩 `projectCreateOpen` / `projectSettingsOpen` /
`projectSettingsProjectId` 三个 ref 与两个开关函数，**约 20 行**——为它新增一个文件、一个测试与
一条 `readFileSync` 常量，收益抵不上成本。记在这里，不硬拆。

### D3-3 `useExplorerComposer`：安全网不足，不做

这一簇（`draft` / `requirementDrafts` / `pendingSendPlanIds` / `failedExplorerSends`）确实内聚，
但它的主体是 `sendTurn`——**全应用最热的路径**（乐观回合、SSE 重试、失败重发、按需求暂存草稿）。
抽它等于把这条路径整体搬家，而当前**没有任何行为测试兜底**：

- `ExplorerView.vue` 只有一个测试文件，且 `mount(` 出现 **0 次**——它全部是读源码文本做断言
  （`expect(explorerViewSource).toContain(...)`）。搬家之后这些断言照旧全绿，**什么也没验证**。
- 本仓没有组件级测试设施的先例，也没有可用的浏览器验收（见下面 A1b/D3 的说明）。

在这种条件下搬最热的代码，风险与收益完全不成比例。它要实现的话应当**先补行为测试**（把
ExplorerView 的发送路径挂到组件测试上），再动结构——那是另一件事，不在本次范围。

### 一份需要单独安排的债

`ExplorerView.test.ts` 的源码文本断言是 P7 抽取时建立的模式，它抓得住"某段代码跑到别的文件去了"
（本次 D3-1 就是靠它发现的），但抓不住任何行为。P7 抽出的 7 个 composable 各自都有独立的行为
测试文件；`ExplorerView.vue` 自身则一次都没有被 mount 过。这条债值得单独排期，不该塞进 D3——
本次新增的 `usePlanDetailDrawer` 同样还没有测试文件，理由与 D3-3 相同：给它写"源码文本断言"
只会复制这个模式，写真正的行为测试才是该做的事，而那是独立的一件事。

## 2026-09-28 — D3-1 抽出 usePlanDetailDrawer（共享抽屉的 Plan 详情）

### Changed

- 共享右侧抽屉的 Plan 详情状态从 [ExplorerView.vue](code/apps/web/src/views/ExplorerView.vue) 抽到新的 composable [usePlanDetailDrawer.ts](code/apps/web/src/composables/usePlanDetailDrawer.ts)：抽屉开关与页签、当前展示的 Plan 版本、可切换的版本列表，以及 `openPlanDetail` / `selectPlanRevision` 两个加载流程。视图的 script 块少 110 行，且"抽屉里到底显示什么"现在能在一个文件里读完（此前 ref 声明与函数分处两段，中间隔着近 400 行别的逻辑）。
- 抽出的顺序有约束：它必须建在 `usePlanLifecycleActions` **之前**——后者要拿这里的 `drawerOpen` / `drawerTab` / `detailPlan` 去在确认、入队之后刷新并切页签。这条写进了调用点的注释。
- 路由跳转（把 `requirementTab=plan` 写进 query）**没有下沉**：composable 只通过 `onOpened` 回调通知"打开了"，路由形状仍由视图决定。与 `usePlanLifecycleActions` 处理 `openRunView` 的方式一致。
- `SharedDrawerTab` 类型随 `drawerTab` 这个 ref 一起搬进 composable 并导出，视图改为 import——避免两处各写一份联合类型。

### Fixed

- **顺手消掉一处重复**：`resetThreadState` 里把同一组抽屉重置（`drawerOpen` / `detailPlan` / `detailRevisions` / `detailConfirmedRevisions` / `detailLatestRevision` / `detailVersionSource`）**写了两遍**，第二遍还漏了 `detailLoadError`。现在只有 `resetDetailState()` 一处。这不是行数问题：两处要保持同步的写法，下一处新增抽屉状态时必然漏一边。

### Changed files

- Web：`code/apps/web/src/composables/usePlanDetailDrawer.ts`（新增）、`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/ExplorerView.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。typecheck 与 build 均通过。
- 逻辑逐字搬移，除 `planFromRevisionDraft` 改为 `deps.planFromRevisionDraft` 外无改动。
- `ExplorerView.test.ts` 里两条用例失败过，原因值得记下来：本仓 P7 抽取时建立的模式是**读源码文本做断言**（每个 composable 都有一个 `readFileSync` 常量）。断言不是被放宽，而是**跟着搬到新文件并保持同一批性质**——包括"先把已知 Plan 落进抽屉再等接口"的顺序断言。切线程那条改为**两半都断言**（视图的 `resetThreadState` 委托 + composable 的 `resetDetailState` 执行），只测一半会让另一半能悄悄漏掉。
- **未做浏览器验收**：抽屉是可见行为，虽然逻辑逐字未改，仍应在下一轮浏览器验收中确认详情打开、版本切换与线程切换三条路径。

## 2026-09-28 — 事件回收（A2）：机制、白名单与序号高水位

### Added

- `PipelineStore.pruneEvents({ cutoff, minPerAggregate })`：回收高频事件，返回删除条数。规则与白名单的**唯一**定义在新增的叶子模块 `store/event-retention.ts`，两个实现都按它来——SQLite 那条带窗口函数的 DELETE 是它的规格翻译。`cutoff` 由调用方算好传进来（而不是让存储层取 `now()`），这样"删哪些"完全由入参决定，两种实现才对得齐，测试也不必去伪造历史时间戳（`appendEvent` 的 `occurredAt` 由存储层生成，调用方给不了过去的时间）。
- 配置项 `storage.eventRetentionDays` 与 `storage.eventRetentionMinPerAggregate`，并接进 `createApp` 的 store 构造。
- **可回收白名单**（判定标准只有一条：*这一条事件是不是某段事实的中间态，而那段事实的最终态另有持久化副本*）：`explorer.turn.text.delta`（最终正文在 `explorer_turns.content`）、`agent.step.model_text_delta`（`agent_loop_steps` 那行的事件镜像）、`agent.model.text.delta`（与上一条逐字重复，A1a 已停止写入）、`project.execution.turn.text.delta`（最终正文在 `project_execution_messages.content`）。**任何参与业务判定的事件都不能进白名单**——`plan.*`、`run.paused`、`verification.completed` 删掉不是"少了几条历史"，是状态机少了输入。
- 本条原文把 `run.executor.event` 中 `payload.type === 'MODEL_OUTPUT'` 的那部分也列进了白名单，依据是"它是 `execution_journal` 的镜像"。**那条依据是错的，已在开启回收前移除**，见上面「A2 白名单收紧」一节。
- `store/event-retention.ts` 里另有 `prunableEventIds`（内存实现的判定）与 `isPrunableEvent`，两者与 SQLite 的 SQL 是同一套规则的两种表达。

### Fixed

- **修复回收会引入的序号回退**（由本次新增的契约用例当场抓到）：SQLite 的 `appendEvent` 用 `SELECT MAX(sequence) + 1` 取号，回收删掉尾部若干行之后这个号会**退回去**，于是新事件复用了一个已经被客户端当作游标用过的号——已连接的客户端拿它去过滤（`sequence > cursor`）会把那批新事件整段静默跳过。新增单行表 `event_sequence_watermark` 记高水位，`pruneEvents` 在删行**之前**先写它（顺序不能反：崩在中间时"记了没删"只是下次重删一遍，而"删了没记"才会退号）。内存实现本来就不会退（它用独立的 `eventSequence` 计数器），这条修的是 SQLite。

### Changed

- 回收**默认关闭**（`eventRetentionDays: 0`），这是有意的：回收是不可逆地删除用户数据，不该在升级后第一次启动时悄悄开始。要看效果就把它设成正数，然后重启一次。启动期的回收放在**所有修复与回填之后**——那几步要读历史事件，先删再修会让它们看到一份被削过的历史。
- 启动期回收失败不会挡住启动：它只是清理，库本身仍然可用，下次启动再试。（domain 层没有日志通道，所以明确吞掉，并在源码里写明这是有意的。）
- 不做 `VACUUM`：它会重写整个数据库文件，对几十兆的库是秒级阻塞。回收后只做一次 `PRAGMA wal_checkpoint(TRUNCATE)`，真正的体积回收留给运维在停机窗口执行。

### Changed files

- Domain：`code/packages/domain/src/store/event-retention.ts`（新增）、`store/pipeline-store.ts`、`store/in-memory-store.ts`、`store/sqlite-store.ts`、`index.ts`、`store-contract.test.ts`、`store-startup-repair.test.ts`。
- API：`code/apps/api/src/config.ts`、`code/apps/api/src/server.ts`。
- 配置：`code/config/pipeline-factory.config.example.json`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。
- 契约套件新增 5 条用例，在两个实现上各跑一遍：cutoff 在过去时一条不删；白名单外的类型永不删；保底条数**按聚合**生效（3 条保 2 条只删最旧一条，2 条的聚合一条不删）；`run.executor.event` 无论载荷是什么都不删（本条当时断言的是"只有 `MODEL_OUTPUT` 被删"，规则收紧后已改为反向断言）；回收后追加的事件序号仍大于历史。
- 最后一条**当场抓到上文的序号回退缺陷**——SQLite 实现当时还没写高水位，用例失败。这不是"补一条测试让它通过"，是守卫先红后绿。
- 启动期接线新增 1 条用例（`store-startup-repair.test.ts`）：不配置回收时一条不删、配置后只删白名单内那条、且删完追加的事件序号仍大于历史。用独立连接直接写库造"2020 年的事件"，因为 `appendEvent` 给不出过去的时间戳。
- `store-startup-repair.test.ts` 的 `corrupt()` 改名 `runRawSql()`：它在本文件里多数时候确实在制造损坏，但回收那组用例只是用它塞一条旧事件，用 `corrupt` 会让那句读起来像在"制造损坏"。

## 2026-09-28 — Explorer 活动取数去重，并把"产出依赖逐条增量"这个事实钉住（B1 的结论）

### 结论：B1 作为"等价优化"不成立，改为记账 + 加守卫

原计划是"正文改取 `explorer_turns.content`，只取每个 loop 最后一条增量步骤"，理由是
`content` 已经是增量的逐字拼接、投影真正还需要的是 `providerItemId`/`occurredAt`/排序序号。
**这个前提是错的。** `projectExplorerActivity` 的产出确实依赖逐条 `MODEL_TEXT_DELTA`，两处：

- **气泡数量**取决于增量步与非增量步的先后。相邻增量合并进同一条 `ASSISTANT_MESSAGE`，但中间只要夹了任何其它步骤（工具、门禁、Provider 活动）就会另起一条。一个回合有几个助手气泡，拿拼好的 `content` 分不出来。
- **合并后那条气泡的 `occurredAt` 与排序序号取的是第一条增量**（它参与最终按 `occurredAt` 的排序，换成最后一条会改变该气泡与其它活动的相对顺序），而挂在气泡上的 `providerItemId` 取的是最后一条非空增量。两个值 `content` 里都没有。

所以"只取最后一条增量"与"改读 `content`"都会改变可见产出，不是等价优化。真要收敛，得让**写侧**按"文本段"落一条事实（见 `agent/agent-loop.ts` 的 `flushTextDelta`），而不是在读侧猜。本次不硬做。

### Changed

- `routes/explorers.ts` 的两处活动取数（workspace 快照与 activity 时间线）原本是逐字重复的四行查表，抽成 `planActivityInput`。抽出来的主要目的是**给上面的结论一个落点**——两处各写一遍注释必然会漂移，而且这段代码正是下一个想"优化掉步骤读取"的人会盯上的地方，提示必须写在他看得见的位置。

### Added

- `explorer-activity.test.ts` 新增两条用例，把上面两个事实钉住：增量之间夹了非增量步骤会另起一条气泡（且用例把 `turn.content` 设成两段增量的完整拼接，正是为了说明"有 content 也分不出来"）；合并后气泡的时间取第一条增量、`providerItemId` 取最后一条非空增量。**这两条不是描述理想行为，而是守卫**——谁想按原计划那样优化，先让它们变绿。

### Changed files

- API：`code/apps/api/src/routes/explorers.ts`。
- Domain：`code/packages/domain/src/explorer/explorer-activity.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 270/270、API 72/72、Web 424/424，无新增值级循环依赖。
- 抽取是纯搬移：两处调用点的查表顺序、过滤条件、传参逐字未变，产出不变。
- 新用例未做反向验证：它们断言的是**当前**行为（而非新引入的行为），构造上不存在"守卫空转"——把 `explorer-activity.ts` 改成读 `content` 就会直接失败。
- **未做浏览器验收**：本次不含可见行为变化（抽取前后产出相同）。

## 2026-09-28 — SQLite 语句缓存（A3）

### Changed

- `SqlitePipelineStore` 的 127 处方法体内联 `this.database.prepare(sql)` 全部改为 `this.statement(sql)`：按 SQL 文本记忆化已编译语句。此前每执行一次就重新编译一次 SQL 文本，而本类绝大多数调用点是"同一条 SQL 反复执行"——`appendEvent` 在流式期间每秒被调几十次，`getProject` 在每次 `savePlan`/`saveRun` 的收尾都被调一次。
- **构造函数里的迁移区刻意不缓存**（仍是 `this.database.prepare(...)`，共 5 处）：那里每条语句只执行一次，缓存没有收益，却会让语句句柄跨越紧随其后的 `ALTER TABLE` 存活，平白引入"schema 已变但语句早已编译"的疑问。这条例外写进了模块头的维护提示 7，与"新增列必须补迁移分支"并列——两者都容易在改动时被忽略。
- 缓存设了条目上限（512），超出即整体清空重建。**这是有意为之的粗暴做法**：带 `IN (?, ?, …)` 的语句文本随参数个数变化（`sqlIn` 的返回值、`listEvents` 的 `aggregateIds`/`types`、`deleteExplorerCascade` 按被删 ID 个数生成的十几条 DELETE），参数个数有多少种就占多少条；`deleteExplorerCascade` 是唯一可能让它显著增长的调用方。清空只让下一轮调用重新编译一次，不影响正确性；不做 LRU 是因为触发场景本身罕见，为它维护访问序会让这个纯加速层比它加速的东西更复杂。
- `close()` 先清空语句表再关连接：`node:sqlite` 的 `StatementSync` 没有显式 finalize，持引用即在连接存活期内有效，主动释放比交给 GC 去和连接关闭赛跑更可控。

### Added

- 新增 `packages/domain/src/store-statement-cache.test.ts`：对 `DatabaseSync.prototype.prepare` 计数，把"编译次数"这条功能上不可见的性质变成可断言的。四个用例分别覆盖：同一 SQL 反复执行只编译一次、SQL 文本不同才各编译一次、命中缓存不改变结果（写入后读到的仍是最新值，即缓存的是语句不是结果）、带 `IN` 列表的语句按元数分桶。

### Changed files

- Domain：`code/packages/domain/src/store/sqlite-store.ts`、`code/packages/domain/src/store-statement-cache.test.ts`（新增）。

### Verification

- `pnpm --dir code verify` 通过：domain 268/268、API 72/72、Web 424/424，无新增值级循环依赖。
- 守卫经**反向验证**：把 `getProject` 改回 `this.database.prepare(...)`，前两个用例按预期失败（`expected 50 to be 1`、`expected 8 to be 7`），恢复后 4/4 通过。确认它抓的是编译次数而非别的性质。
- **没有断言缓存上限**：观测它要么把 `STATEMENT_CACHE_LIMIT` 导出成公开面，要么把清空时机编码进用例，两者都会让这个纯加速层更难改。上限作为防御性措施记录在本条与源码注释里，不作为契约。
- 未测性能数字：本仓没有基准设施，本次不新增；收益的定性依据是"消除重复编译"这一机制本身。
- 未做浏览器验收：纯存储层改动，无前端可见行为变化。

## 2026-09-28 — 验证命令判定规则收敛（修复基线里挂着的那个真实缺陷）+ Plan 列表读取复杂度

### Fixed

- **修复 `scripts/test-baseline.json` 中长期豁免的那条真实缺陷**（原用例名 `PlanDispatchCoordinator does not treat V2 natural-language prerequisites as Plan dependencies during dispatch`，期望 `RUNNING` 实得 `WAITING/NEEDS_CONFIGURATION`）。根因不是 V2 的自然语言前置条件，而是**验证命令的判定规则被写成两套**：
  - `run/scheduler.ts` 的 `assertVerificationCommands` 与 `PlanService.reviseConfiguration` 只读 V1 的 `contract.verificationCommandIds`，并把 `settings.commands` 里**任何**命令都算作已注册；
  - `PlanDispatchCoordinator.evaluateWait` 在 revision 带 `resolvedContract` 时改读 V2 的 `resolvedContract.verification.commandIds`，且只把 `category === "verification"` 且 `enabled !== false` 的命令算作已注册。

  两套规则让"同一个 Plan 该不该被拦"取决于**谁先问**：派发前的 `evaluateWait` 放行，`Scheduler.start` 里的同名校验却抛 `RUN_PREREQUISITES_UNSATISFIED`。典型触发是 V2 的 `verification.mode: "NONE"`——解析后 `commandIds` 为空、按 README 应当被 `SKIPPED` 而非被拦，但只要它身上带着一份陈旧的 V1 镜像 id 就会被卡住。规则已收敛到 `plan/contract.ts` 的 `missingVerificationCommands` 一处，三处调用点改用它；统一到 coordinator 的那套（已解析的 V2 契约是权威来源）。
- 判定规则两侧语义都被测试钉住（`plan/contract.test.ts`）：V2 分支保持严格（未启用或非 verification 类别的命令不算已注册），V1 回落分支保持历史行为（不收紧，否则旧库里的历史合同会突然无法确认）。

### Changed

- Plan 生命周期投影改为"按请求建一次索引、沿调用链下传"（`buildPlanLifecycleIndex`）。`planEventAggregateIds` 原先**每个 Plan** 都读一遍 `listRuns()` 与 `listMergeRequests()`（各是全表 `SELECT *`），内层再对每个匹配 Run 调 `listChangeProposals`；而 `decoratePlanRows` 对查询返回的**每一行**调一次 `planProjection` —— Plan Center 的 limit 上限是 100，于是单次列表请求等于 200 次全表读。`planProjection` / `decoratePlanRows` 的 `index` 参数可省略（单 Plan 调用自建一次与原行为等价），列表路径由 `decoratePlanRows` 与 `workbenchSnapshot` 各建一次。
- `scripts/test-baseline.json` 的 `knownFailures` 清空 —— 仓库现在没有已知失败用例。文件里保留了 `_历史` 字段记录这条缺陷的原委，因为"空清单"与"漏填"从文件本身看不出来。

### Added

- 新增 `apps/api/src/projections/plan-lifecycle.test.ts`：用调用计数把读取复杂度钉死（表读次数必须与行数无关），并断言"共享索引"与"逐 Plan 自建"产出**完全相同**的 lifecycle —— 否则"优化"就变成了行为变更。
- 新增 `packages/domain/src/plan/contract.test.ts`：判定规则的纯函数级覆盖。

### Changed files

- Domain：`code/packages/domain/src/plan/contract.ts`、`code/packages/domain/src/plan/contract.test.ts`（新增）、`code/packages/domain/src/plan/service.ts`、`code/packages/domain/src/run/scheduler.ts`、`code/packages/domain/src/run/dispatch-coordinator.ts`。
- API：`code/apps/api/src/projections/plan-lifecycle.ts`、`code/apps/api/src/projections/workbench.ts`、`code/apps/api/src/projections/plan-lifecycle.test.ts`（新增）。
- 脚本：`code/scripts/test-baseline.json`。

### Verification

- `pnpm --dir code verify` 通过，**三包零失败**：domain 264/264、API 72/72、Web 424/424，无新增值级循环依赖。这是 `test-baseline.json` 清空后的第一次全绿。
- 原豁免用例现在真正通过（`dispatch-coordinator.test.ts` 14/14），不是被从清单里删掉。
- 复杂度守卫经构造验证：`decoratePlanRows` 处理 5 行时三张表各只被读 1 次；改回逐 Plan 读取会让这三个计数变成 5。
- 未做浏览器验收：C3 改变了派发判定，属于后端行为；受影响的场景（V2 mode NONE 的 Plan 从"卡在 NEEDS_CONFIGURATION"变为"可派发并在验证阶段 SKIPPED"）应在下一轮端到端验收中确认。

## 2026-09-28 — 事件读取加界与 Plan 投影漂移可见化

### Added

- `PipelineStore.listEvents` 新增 `limitFrom: "head" | "tail"`（缺省 `"tail"`，与引入前行为一致）。缺省的 tail 语义是"最新的 N 条"，而轮询式增量读取需要的是"游标之后最早的 N 条"——两者混用会在游标落后时反复读到最新那一批，而游标又推进到本批末尾，中间事件被**永久跳过且不报错**。新增 `EventQuery` 类型承载过滤与截断参数，两个实现同步。
- `SqlitePipelineStore` 新增构造期修复 `repairOrphanedPlans`：把"已确认之后、来源 ExplorerThread 已不存在"的 Plan 标成 `BLOCKED` + `attentionReason`，复用既有前端"需要关注"展示链路。此前这类 Plan 会被投影守卫跳过而**无声消失**，状态却停留在 `READY`/`QUEUED` 之类看起来可执行的值上。
- 新增 `store-startup-repair.test.ts`：覆盖 `repairUnconfirmedProgressedPlans` 与 `repairOrphanedPlans` 的生效与**幂等**（重开库不重复处理、不重复写 `plan.status.changed`）。两条修复的输入都只能用独立连接直接改库来构造——走领域 API 产生不出这些行，那正是它们只对历史数据生效的原因。

### Fixed

- `PlanService.query` 遇到"投影行没有源 Plan"时不再抛错，改为跳过该行。此前一行坏数据会让整个 Plan Center 变成 500。该分支在正常流程不可达（写侧有守卫、`deleteExplorerCascade` 会级联删投影），属防御性修复。

### Changed

- Workbench 事件路由的每一次 `listEvents` 都带 limit：首次连接取尾部窗口（与 `workbenchSnapshot` 的 `WORKBENCH_EVENT_TAIL_LIMIT` 同一常量），之后从游标向前读、单轮上限 500。此前该路由缺 limit，`afterSequence=0` 会把整张事件表读进内存并逐条 `JSON.parse`，而生产库已有十几万条事件、绝大多数与本 Project 无关。
- Agent Loop 事件路由同上：首次回放窗口 2000、单轮上限 500。此前 web 端 `agentLoopEventsUrl` 不传游标，建连即 from 0 全量回放。
- 在 `savePlan` / `backfillPlanQueryProjection` / 内存实现三处注明：投影守卫是**外键驱动**的，不是业务规则——`plan_query_projection` 对 `project_id` 与 `source_explorer_thread_id` 建了外键，而它所索引的 `candidate_plans` 自己没有。**不要把它改成无条件写入**：那会把 `savePlan` 从不抛错的 UPSERT 变成 project/thread 缺失时抛错的方法，而内存实现没有外键会静默成功，等于制造新的双实现分歧。
- `repairOrphanedPlans` **只查来源线程，不查 Project**：领域层允许"有 Plan 却没有 Project 行"（`PlanService.registerThread` + `createCandidatePlan` 不需要先建 Project，多个领域测试正是这么用），把"项目不存在"当孤儿会把正常数据误判成 BLOCKED。这条是在 `pnpm verify` 抓到 `m0-m1.test.ts` 的真实回归后收窄的。

### Changed files

- Domain：`code/packages/domain/src/store/pipeline-store.ts`、`code/packages/domain/src/store/sqlite-store.ts`、`code/packages/domain/src/store/in-memory-store.ts`、`code/packages/domain/src/plan/service.ts`、`code/packages/domain/src/store-startup-repair.test.ts`（新增）、`code/packages/domain/src/store-event-query.test.ts`、`code/packages/domain/src/plan-query.test.ts`。
- API：`code/apps/api/src/routes/workbench.ts`、`code/apps/api/src/routes/agent-loops.ts`、`code/apps/api/src/projections/workbench.ts`、`code/apps/api/src/server-sse.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 258 用例（通过 257，失败 1）、API 70 用例全通过、Web 424 用例全通过，无新增值级循环依赖。
- 那 1 个失败仍是 `scripts/test-baseline.json` 中已登记的既有缺陷（`dispatch-coordinator.test.ts:121`），非回归。
- 新增守卫经反向验证：临时把 Workbench 路由的读取改回无界，`server-sse.test.ts` 的新增用例按预期失败（`expected undefined to deeply equal Any<Number>`），确认它抓的是"路由传了什么参数"而非帧数——无界读取的帧数完全正常，代价全在服务端。
- **中途 `pnpm verify` 抓到一次真实回归**：`repairOrphanedPlans` 初版把"Project 不存在"也当孤儿，导致 `m0-m1.test.ts` 的 `restores plans and append-only events after a service restart` 从 `ENQUEUED` 变 `BLOCKED`。收窄后恢复绿灯——这条正说明该门禁有效。
- 未做浏览器验收：本次改动未触及前端可见行为（Workbench/Agent Loop 面板看的是事件尾部，与窗口语义一致），但窗口化改变了首屏回放条数，仍应在下一轮浏览器验收中确认两个面板内容完整。

## 2026-09-28 — Store 跨实现契约与事件写入去重

### Added

- 新增 `store-contract.test.ts`：PipelineStore 的跨实现契约套件，同一批断言在 `InMemoryPipelineStore` 与 `SqlitePipelineStore` 上各跑一遍。端口方法清单由 tsc 保证完整（漏一个方法编译不过），覆盖生产写路径：事件追加与查询、脱敏、步骤序号、Plan 查询投影、Run/合并/工具调用、幂等与事务回滚。

### Fixed

- 修复 `VerificationRun.reason` 在 SQLite 上永远读不出来的缺陷：该字段自类型引入时就存在（并被 Web 的类型 parity 守卫覆盖），但 `verification_runs` 建表语句一直漏了 `reason` 列，`saveVerificationRun` 也不写、`verificationFromRow` 也不读，于是生产上恒为 `undefined`——`NO_PROJECT_VERIFICATION_COMMANDS`（"未配置自动验证"的唯一凭据）被静默丢弃。补建表列 + `ALTER TABLE` 迁移分支 + 读写路径。
- 修复 `saveIdempotency` 在两种存储下语义相反的缺陷：内存实现用 `Map.set`（后写覆盖），SQLite 用 `INSERT OR IGNORE`（首次写入生效）。调用方一律"先查后写"，该过程不原子，并发重放时只有首次写入生效才能保证重放拿到**原来**那条结果，因此按 SQLite 语义对齐内存实现，并在端口注释 6 中写明该契约。

### Changed

- Agent Loop 的单次模型文本增量不再往事件表写第二份：`agent.model.text.delta` 与 `agent.step.model_text_delta` 的 `text` 逐字相同，同一次增量此前落 1 行 `agent_loop_steps` + 2 条领域事件。`emit` 增加 `durable` 开关，`flushTextDelta` 改用它只做进程内派发——**回调与 listener 的派发时序、内容完全不变**（Explorer 的实时正文靠 thread-service 的 callback 累积，读的是 `AgentLoopEvent` 而非事件表）。实测该类型占全部事件 159,523 条中的 53,161 条（33.3%），数据库 81 MB 中 `domain_events` 占 43 MB。
- `PipelineStore` 端口注释补充 `saveIdempotency` 的首次写入生效语义。

### Changed files

- Domain：`code/packages/domain/src/store-contract.test.ts`（新增）、`code/packages/domain/src/agent-loop-engine.test.ts`、`code/packages/domain/src/agent/agent-loop.ts`、`code/packages/domain/src/store/pipeline-store.ts`、`code/packages/domain/src/store/in-memory-store.ts`、`code/packages/domain/src/store/sqlite-store.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 253 用例（通过 252，失败 1）、API 68 用例全通过、Web 424 用例全通过，无新增值级循环依赖。
- 那 1 个失败是 `scripts/test-baseline.json` 中已登记的既有缺陷（`dispatch-coordinator.test.ts:121` 期望 `RUNNING` 实得 `WAITING/NEEDS_CONFIGURATION`），本次未触碰，非回归。
- 新契约套件的断言经反向验证：临时移除 `durable: false` 后 `agent-loop-engine.test.ts` 的新增用例按预期失败（`to not include 'agent.model.text.delta'`），确认守卫非空转。
- 未做浏览器验收：本次改动不含前端可见行为变化，但 A1a 改变了事件写入，仍应在下一轮浏览器验收中确认 Explorer 流式正文实时可见。

## 2026-09-27 — Explorer 流式交互与事件查询性能

### Changed

- Agent Loop 将高频模型文本增量合并后再写入步骤和事件：达到 160 字符、最长 40ms、Provider 输出项切换、遇到其他事件或步骤结束时刷新，减少逐 token 持久化和 SSE 事件数量，同时保留流式更新。
- Agent Loop 事件序号改为由追加步骤维护，并在首次使用时从 Store 查询最大序号；诊断投影只读取 `PROVIDER_ACTIVITY`、`GATE_CHECKED` 和 `LOOP_FAILED` 步骤。
- Store 的 `listEvents` 增加多聚合、事件类型和最新条数过滤，SQLite 为聚合 ID 与序号增加索引；Plan 生命周期事件在存储查询层过滤。
- Workbench 初始事件快照最多检查全局最近 4,000 条，再保留当前 Project 最近 400 条；实时新事件仍通过 SSE 推送。Project 事件归属改为先建立聚合到 Project 的索引，避免逐事件重复查找。
- Explorer 将流式期间的 activity、Plan 和 Agent Loop 投影刷新合并到 400ms 间隔；门禁、输入和终态事件仍立即刷新，并在线程切换或卸载时清理定时任务。

### Added

- 新增 Store 事件查询测试，覆盖 InMemory 与 SQLite 实现的多聚合筛选、事件类型筛选、空筛选语义、最新条数和冲突参数校验。

### Changed files

- API：`code/apps/api/src/server.ts`。
- Domain：`code/packages/domain/src/agent-loop.ts`、`code/packages/domain/src/index.ts`、`code/packages/domain/src/store-event-query.test.ts`。
- Explorer：`code/apps/web/src/views/ExplorerView.vue`。
- 文档：`CHANGELOG.md`。

### Verification

- `git diff --check` 通过。
- 本次未运行测试、typecheck 或 build；新增 Store 查询测试尚未在本次提交前执行。

## 2026-09-27 — Explorer 需求工作台与交互恢复

### Added

- 新增当前 ExplorerThread 的需求清单投影：按需求序号稳定排序，将需求、有效 Plan 修订和关联 Run 汇总到同一行；点击 Plan 状态、结构化 Plan 或任务状态分别进入探索对话、Plan 详情或 Run。
- 新增需求行组件与共享右侧抽屉页签，支持当前需求的探索对话、Plan 详情、待入队操作和 Run 对话；线程切换会清除旧线程抽屉内容，并保持需求选择与路由状态一致。
- 新增 Explorer 输入回答草稿恢复：在当前浏览器标签页保存需求范围内的非敏感回答和题目位置，刷新后恢复；敏感题答案不写入 sessionStorage，已结束请求会清理草稿。
- 将完整 Plan 正文抽为可复用组件，并读取 `generatedSpec` 的 V2 结构化字段，使完整解析契约尚未生成时也能查看目标、范围、任务、产物和执行策略。

### Changed

- 左侧线程栏仅显示 Project 与 ExplorerThread，移除其下的需求子项；需求新增入口和清单移到主工作区。新增需求后在当前线程创建对应 ExplorerPlan，并将描述作为首条探索消息；发送失败时保留该需求以便重试。
- Plan 已确认但尚未创建 Run 时，Run 页签显示待入队状态；对话型 Plan 会在入队前给出不可执行原因和修订指引，处理 `CONVERSATION_ARTIFACT_NOT_EXECUTABLE`，不改变服务端接口或生命周期顺序。
- 线程和需求切换时同步更新清单范围、路由与抽屉状态，避免旧需求内容残留；响应式布局覆盖窄屏清单和抽屉展示。

### Changed files

- 组件：`code/apps/web/src/components/ExplorerInputDialog.vue`、`code/apps/web/src/components/ExplorerRequirementList.vue`、`code/apps/web/src/components/PlanDetailContent.vue`、`code/apps/web/src/components/PlanDetailDrawer.vue`、`code/apps/web/src/components/ThreadRail.vue`。
- 页面与类型：`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/RunDetailView.vue`、`code/apps/web/src/styles.css`、`code/apps/web/src/types.ts`。
- 工具：`code/apps/web/src/utils/explorerInputProgressDraft.ts`、`code/apps/web/src/utils/explorerRequirementRows.ts`。
- 测试：`code/apps/web/src/components/PlanDetailDrawer.test.ts`、`code/apps/web/src/components/ThreadRail.test.ts`、`code/apps/web/src/views/ExplorerView.test.ts`、`code/apps/web/src/views/RunDetailView.test.ts`、`code/apps/web/src/utils/explorerInputProgressDraft.test.ts`、`code/apps/web/src/utils/explorerRequirementRows.test.ts`。
- 文档：`CHANGELOG.md`。

### Verification

- `npm --prefix code/apps/web test`：54 个测试文件、274 个测试通过。
- `npm --prefix code/apps/web run typecheck` 与 `npm --prefix code/apps/web run build` 通过；构建仍提示存在大于 500 kB 的 chunk。
- `git diff --check` 通过。
- 浏览器全流程验收未完成：当时 API 与 Web 健康检查失败（过期 PID 文件且端点不可用），已打开的浏览器标签也未能完成自动化交互；自动化测试和构建不能替代运行中的浏览器验收。

## 2026-09-27 — 执行线程与 Run 可观测性

### Added

- 增加每个 Project 独立的长期执行线程：持久化消息、Provider Thread、模型与推理等级偏好；按顺序处理请求，支持幂等提交、取消、重启后恢复队列，并通过项目级 API 和 SSE 回放进度。该入口可直接在项目仓库目录执行，不会隐式创建 Explorer Plan 或 Run。
- 在 Explorer 左侧加入“项目执行线程”入口和会话面板，展示消息、Provider/工具活动、队列与连接状态，并支持切换模型偏好和发送请求。
- 为 Run 工作树增加项目当前 Git 可见变更的快照基线，使已修改和普通未跟踪项目文件可供新 Run 使用；快照失败时清理新建的工作树和分支。
- 新增执行目录解析与安全检查：从 Plan 的 `artifactPath` 或 `include` 推导命令工作目录，拒绝越界路径及符号链接，并向 Executor 明确传入工作树根目录与命令目录。
- 新增 Run 执行预检与恢复流程文档，记录 Provider 命令超时、错误目录和清理旧工作树前的现场保全步骤。

### Changed

- Provider 代执行的命令现在受项目默认命令超时约束；超时会取消 Provider Turn、阻塞 Agent Loop，并记录活动 ID、工作目录及超时值。
- Run journal 增加模型轮次、任务 ID、Provider 会话/活动及工具调用的关联字段；执行页按 Plan 任务展示模型输出、工具/MCP 活动和错误，明确标出未记录的状态，并将重复且进度未变化的 Executor 报告合并展示。
- Executor 使用结构化任务进度标记更新任务状态；缺少任务事实时保持“未记录”，不根据模型叙述或 Run 状态推测。执行状态卡直接展示 token 用量明细，执行会话承载过程信息。
- RecoveryCoordinator 仅处理 Run 所属 Agent Loop；项目执行线程单独将重启前未完成的轮次标为需要恢复。

### Verification

- `pnpm --dir code typecheck`、`pnpm --dir code build`、Web 277 个测试和 API 51 个测试通过；构建仍有大于 500 kB 的 chunk 提示。
- Domain 测试 225/226 通过；`dispatch-coordinator.test.ts` 的 1 个测试期望 `RUNNING`，实际因 `NEEDS_CONFIGURATION` 停在 `WAITING`。该测试文件未在本次提交中修改。

## [Unreleased] - 2026-09-19

### Added

- ExplorerThread 支持一等 ExplorerPlan 分区：默认 Plan 1、Plan 级消息/活动/候选方案隔离，所有 Plan 复用同一 Provider Thread 与完整会话上下文。
- 增加同一 ExplorerThread 下多个 ExplorerPlan 的持久化 FIFO 后台队列、运行状态、重启恢复和线程级上下文摘要。
- 增加 ExplorerPlan 分组、创建、重命名、激活和 workspace API；turn、activity、input request、Agent Loop、candidate Plan 和 revision draft 均支持按 ExplorerPlan 隔离。
- 将聊天区消息快捷入口改为 Element Plus Tree：Explorer Thread 作为根节点，Task 和 Plan 默认展开，子 Plan 可定位到时间线；Plan 卡片也可反向定位对应 Task。
- 为 Explorer 增加标题栏状态摘要组件，集中展示需求契约、Provider Loop 和探索进度；支持点击查看详情、键盘操作，以及在 Provider Loop 详情中暂停/恢复循环。
- 将计划中心入口加入左侧主导航并显示计划数量；保留右侧上下文面板中的候选、已确认、已入队、已派发、运行中和待处理分区。
- 将用户消息改为可折叠的标题/摘要卡片，展开后查看完整 Markdown；新增消息摘要工具及对应测试。
- 将聊天区消息时间线改为窄型浮动标记轨道，支持 hover、focus、active 状态和消息定位；最新消息按钮改为水平居中。
- 为 Explorer Tree 增加根节点到 Task、Task 到 Plan 的树形连接线，并保留当前 Task 的轻量选中态。
- 增加 `ProviderUsageFooter`，在聊天底部展示当前模型、上下文用量和账户级 5 小时/7 天限额。
- 增加共享 `TaskLifecycleCard`，统一候选、已确认、已入队、已派发、运行中和待处理 Plan 的生命周期展示、异常状态和执行线程入口。
- 增加 ExplorerThread 删除 API 与领域级级联删除能力；删除前阻止仍有活动 Run 或 Explorer Loop 的线程，并在删除最后一个线程时创建替代线程。
- 增加 Explorer Task 归属和 Plan 生命周期工具及测试，明确未归属记录不得猜测挂到 Task 1。

### Changed

- 优化 Explorer、项目上下文卡片和右侧上下文面板布局，减少冗余标题、仓库路径和说明文本，并补充响应式样式与可访问性标记。
- 统一 Explorer 上下文菜单、计划中心标签和线程操作菜单的中文文案。
- `ExplorerPlanRequirements` 支持通过 `initiallyExpanded` 控制初始展开状态，以适配状态详情浮层。
- Explorer、Executor 及 Project 默认模型由 `deepseek-v4-flash` 切换为 `gpt-5.6-luna`；同步更新配置示例、运行配置、项目设置表单和项目领域默认值。
- 历史模型迁移改为只识别并替换精确的 `deepseek-v4-flash`，继续保留活动 Run 跳过、配置版本递增和配置修订记录能力。
- 更新 `code/README.md`，同步新的默认模型说明和本地运行配置示例。
- Explorer UI 将 `ExplorerPlan` 显示为 `Task`，仅调整前端术语；domain、API、数据库仍保留 `ExplorerPlan` 原名。
- 删除聊天区右侧 `PLANS` 导航栏和 `THREAD READY FOR YOUR NEXT TURN` 专用分隔提示；保留候选 Plan 数据、状态和业务流程。
- Agent Loop 从共享 Provider Thread 继承 provider thread ID，并将排队/运行/等待输入/完成/失败状态同步到对应 Task。
- 修复本地开发服务的过期 PID 文件判断；status/start 脚本优先以健康端点和监听端口判断 API/Web 是否可用。
- 修正本地配置中的项目仓库根目录和 Codex App Server cwd，避免从 `code/config` 解析到非 Git 的上级目录。
- Candidate 查询支持显式 `explorerPlanId` 并默认使用活动 Task；Plan、Revision 和执行详情响应统一补充生命周期投影与执行线程摘要。
- Plan 状态变化统一写入 `plan.status.changed` 事件；旧数据中缺少确认记录却已进入后续状态的 Plan 会被修复为 `BLOCKED`，避免无确认执行。
- 执行时间线保留不可变 Plan 快照；Explorer 线程切换时仅刷新当前 Task 的 Candidate、Revision Draft、消息、输入请求和 Plan 绑定。

### Tests and documentation

- 新增 `ExplorerHeaderStatus`、用户消息摘要和相关交互覆盖；同步更新 Explorer、ThreadRail、计划需求和 Project 模型迁移测试。
- 新增 `design-qa.md`，记录 Explorer 聊天区视觉/交互验收结果和现场截图依据。
- 修正 ThreadRail 样式断言，使测试与当前三列 Grid 项目上下文布局一致。
- 新增 `taskTree.ts` 及测试，覆盖 Task 排序、Plan 归属、去重、未归属 Plan 隔离、展示术语和时间线定位目标。
- 扩展 Explorer domain/API 测试，覆盖默认 Plan 1、多 Plan FIFO 与共享 Provider Thread、跨项目 workspace 拒绝和无效 Plan turn 拒绝；同步记录探索流程设计文档和待办事项。
- 新增 Explorer 删除、Task 归属、Plan 生命周期、Provider 用量页脚和共享生命周期卡测试；扩展 API、domain、ExplorerView、ThreadRail、执行流和状态事件测试。
- 更新原始需求合规计划、UI 完整性计划、探索流程说明和 `待办事项.md`，标注当前自动化结果与剩余浏览器矩阵验收项。

### Verification

- `pnpm --dir code test`：88 个测试文件、526 个测试通过（当前工作区）。
- `pnpm --dir code typecheck`：domain、web、API 均通过。
- `pnpm --dir code build`：domain、web、API 均通过；仅有既有的 chunk size warning。
- API smoke check：health、Project、Explorer、ExplorerPlan、workspace 和 Plan endpoints 均返回成功；跨项目访问按预期拒绝。
- `git diff --check`：通过。
- 浏览器已完成 Explorer Tree 基础交互和 API 健康检查；完整的 Explorer、Plan Center、Workbench、Run、Settings 桌面/平板/窄屏矩阵仍待完成。

### Changed files in this working-tree update

- Explorer UI：`code/apps/web/src/components/ThreadRail.vue`、`code/apps/web/src/components/ThreadRail.test.ts`、`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/ExplorerView.test.ts`、`code/apps/web/src/styles.css`、`code/apps/web/src/types.ts`。
- Explorer UI utilities：`code/apps/web/src/utils/explorerScope.ts`、`code/apps/web/src/utils/explorerScope.test.ts`、`code/apps/web/src/utils/explorerStatus.ts`、`code/apps/web/src/utils/explorerStatus.test.ts`、`code/apps/web/src/utils/planLifecycle.ts`、`code/apps/web/src/utils/planLifecycle.test.ts`。
- Explorer UI components：`code/apps/web/src/components/ProviderUsageFooter.vue`、`code/apps/web/src/components/ProviderUsageFooter.test.ts`、`code/apps/web/src/components/TaskLifecycleCard.vue`、`code/apps/web/src/components/TaskLifecycleCard.test.ts`、`code/apps/web/src/components/ExecutionHeaderStatus.test.ts`、`code/apps/web/src/components/ProjectSettingsDialog.test.ts`。
- Web API and execution flow：`code/apps/web/src/api.ts`、`code/apps/web/src/api.test.ts`、`code/apps/web/src/utils/executionStream.ts`、`code/apps/web/src/utils/executionStream.test.ts`、`code/apps/web/src/utils/executionTelemetry.ts`、`code/apps/web/src/utils/executionTelemetry.test.ts`。
- API：`code/apps/api/src/server.ts`、`code/apps/api/src/server.test.ts`。
- Domain：`code/packages/domain/src/index.ts`、`code/packages/domain/src/executor-agent.ts`、`code/packages/domain/src/recovery-coordinator.ts`、`code/packages/domain/src/change-proposal.test.ts`、`code/packages/domain/src/m0-m1.test.ts`、`code/packages/domain/src/explorer-delete.test.ts`。
- Runtime and configuration：`startApi.sh`、`startWeb.sh`、`status.sh`、`code/config/pipeline-factory.config.json`、`code/config/pipeline-factory.config.example.json`。
- Documentation and tracking：`CHANGELOG.md`、`待办事项.md`、`docs/superpowers/plans/2026-08-30-ui-completeness.md`、`docs/superpowers/plans/2026-09-01-original-requirement-compliance.md`、`docs/探索的流程/流程优化升级.txt`。
