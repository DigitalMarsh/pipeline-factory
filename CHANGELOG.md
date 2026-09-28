# Changelog

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
