# API 读路径的 Service 缺口（P6 的产出）

本文记录 `code/apps/api/src/routes/*.ts` 里 Store 直连读的逐类判定，以及"要收敛还得补哪些 Service 方法"。它是 P6（Store 直连收敛到 Service）留下的交付物——**要动手时按这里的表逐条做，一条一个提交**。

## 度量方法（可复现，先读这一段）

度量命令**必须排除整行注释**：

```bash
cd code
# 命令 A：Store 直连调用的出现次数（P6 那道**只许往下走的门槛**就是这个数）
grep -h -v '^[[:space:]]*\(\*\|//\|/\*\)' apps/api/src/routes/*.ts | grep -o 'store\.[a-zA-Z]*(' | wc -l
```

**为什么不能直接用 `grep -c 'store\.' routes/*.ts`**：有 4 行注释里写到了这个字面量——`platform.ts:7`（`（不查 store.getProject、…）`）、`change-proposals.ts:12`、`explorers.ts:23`、`plans.ts:24`。其中三处带括号，会让命令 A 也偏高。**这正是 P3 批 C 记录过的那条经验的第二个实例**（"按文本出现次数统计时，注释里提到符号名会产生假阳性"，当时坑的是 `value-deps.mjs`）。

| 时点 | 命令 A | 说明 |
|---|---|---|
| P6 开始 | **135** | 含 3 处本次替换掉的 |
| P6 结束 | **132** | 见"已替换的部分" |

按文件（P6 结束时）：`plans.ts` 39 / `explorers.ts` 34 / `runs.ts` 19 / `agent-loops.ts` 17 / `projects.ts` 6 / `workbench.ts` 5 / `change-proposals.ts` 4 / `merge-requests.ts` 4 / `execution-threads.ts` 2 / `hooks.ts` 2 / `platform.ts` 0 / `index.ts` 0。

按方法名（P6 结束时）：

| 方法 | 次数 | 判定 |
|---|---|---|
| `getThread` | 20 | 待补 |
| `getProject` | 16 | 待补 |
| `getRun` | 12 | 待补 |
| `getAgentLoop` | 10 | 待补 |
| `getExplorerPlan` | 10 | 待补 |
| `listEvents` | 6 | **保留**（事件流） |
| `listAgentLoops` | 6 | 待补 |
| `getLastEventSequence` | 6 | **保留**（事件游标） |
| `getRevisionDraft` | 5 | 待补 |
| `listTurns` / `getVerificationRun` / `getDispatchState` / `getExecutionThread` | 各 4 | 待补 |
| `listAgentLoopSteps` / `getPlan` / `listRuns` | 各 3 | 待补 |
| `listPlans` / `listInputRequests` / `listCandidateVersions` | 各 2 | 待补 |
| 其余 10 个方法 | 各 1 | 待补 |

## 四种形态（先分清，再谈收敛）

**1）投影入参（26 处，是上面 132 的一部分，但不是"绕过 Service 读实体"）**

```ts
planProjection(store, plan)            // 8 处
projectRunThreadTelemetry(store, …)    // 6 处
projectAgentLoopResponse(store, loop)  // 6 处
loopDiagnostics(store, loop)           // 3 处
createProjectEventScope(store, …)      // 2 处
workbenchSnapshot(store, projects, …)  // 1 处
```

这里的 `store` 是**纯投影函数的数据源**（投影在 `apps/api/src/projections/`，无 IO）。要收敛它们得先让投影接受更窄的入参（例如传入已取好的 `plan` + `revisions` + `loops`），那是 P5 投影下沉的后续，**不是把路由改成调 Service 能解决的**。列在这里是为了避免被误读成"上百处路由在裸读库"。

**2）事件日志与游标（12 处）——有意保留**

`listEvents`(6) 与 `getLastEventSequence`(6) 只出现在 SSE / 事件流分支里。**事件流是传输层，不是业务实体读**：游标推进、分批扫描、断线重连靠 `Last-Event-ID` 对齐，都要直读日志。给这些包一层 Service 只会让 `openSseChannel` 的每个 250ms 轮询多一次无意义的转发。**明确结论：这 12 处不收敛，也不该收敛。**

**3）实体 / 枚举直读（94 处）——本文的主体**

它们的共同形状是：

```ts
const x = store.getX(id);
if (!x) return reply.code(404).send({ error: "… not found" });
```

而现有的 Service 读方法**恰好都在实体缺失时抛错**。换成 Service 方法会把 404 变成 500——**这正是 P6 必须单独成阶段的原因**（见方案 P6 开头）。

**4）已替换（0 处，见文末"已替换的部分"）**

## 待补 Service 方法（逐条）

每条给出：**要补什么** / **为什么现有方法不能直接用** / **该方法名当前的出现次数**。最后一列是**上限**——同一方法名下总有几处不属于这个形状（例如用于再读、用于 `?.` 安全读），实际能消掉的只会更少。签名只写形状，具体命名在动手时按各域已有的命名习惯定。

### A. 非抛错的实体读（一次补一个，价值最高）

| 需要的形状 | 现有方法为什么不行 | 上限 |
|---|---|---|
| `ProjectService.find(projectId): Project \| null` | `get()` 抛错；`getProject(id)?.settings.hooks ?? {}` 这种**安全读**需要的正是 null | 16 |
| `ExplorerService.find(explorerId): ExplorerThread \| null` | `get()` 抛错 | 20 |
| `Scheduler.findRun(runId): Run \| null` / `findThread(threadId): ExecutionThread \| null` | `run()` / `thread()` 抛错；且它们带**短期缓存副作用**（`this.runs.set`），读路径不该有 | 16 |
| `PlanService.findRevisionDraft(draftId): PlanRevisionDraft \| null` | 只有草稿的**写**方法（create / update / confirm / discard） | 5 |
| `VerificationService.find(runId): VerificationRun \| null` | 只有 `verify()`，没有读方法 | 4 |
| `PlanService.find(planId): CandidatePlan \| null` | `get()` 抛错；`change-proposals.ts:58` 要的是 `?? 内存态 Plan` 的降级回退 | 3 |
| `PlanService.findRevision(planId, revision): PlanRevisionV2 \| null` | `getRevision()` 抛错；`plans.ts:360` 需要 `?? null` | 1 |
| `ChangeProposalService.find(proposalId): ChangeProposal \| null` | 只有 `create()` / `approve()` | 1 |

**补 A 类时注意**：不要给 Service 加一个 `find` 又把 `get` 改成调 `find` 再抛错——那会把"找不到"这个原本只在**写**路径出现的语义扩散到读路径。两个方法各自独立，`get` 保持抛错（写路径需要 fail-fast）。

### B. 跨项目归属校验（17 处，占 `getThread` 的绝大部分）

这个形状共 **17 处**：`explorers.ts` 11 处 + `plans.ts` 6 处（同一段代码在 Plan 域也复制了一份；其中 `plans.ts:179` 是复合条件，前两个判断仍是这个片段）。

```ts
const explorer = store.getThread(params.data.explorerId);
if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
```

`ExplorerService.get(id)` **完全不看 `projectId`**，所以这不是"抛错 vs 返回 null"的问题，而是**缺少一个语义**。要补的是：

```
ExplorerService.findInProject(projectId, explorerId): ExplorerThread | null
```

它必须同时表达两件事：不存在、**存在但不属于这个 Project**（后者也回 404，不能泄露"这个 ID 存在"）。注意 `plans.ts` 目前没有 `explorers` 这个 dep——补这个方法时要顺带把它加进 `PlanRouteDeps`（那是显式 deps 的正常演化，不是破坏）。

同形状还有 `store.getExplorerPlan(id)` + `explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== …`（`explorers.ts:108`、`agent-loops.ts:130`），归到下面的 D 类一起考虑。

同形状还有 `store.getExplorerPlan(id)` + `explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== …`（`explorers.ts:108`、`agent-loops.ts:130`），归到下面的 D 类一起考虑。

### C. 枚举读（无 Service 方法，且**多数不该补**）

| 方法 | 次数 | 判断 |
|---|---|---|
| `listAgentLoops` | 6 | 无任何 Service 管 AgentLoop 的**读**（`loopController` 只有 pause/resume/cancel）。补 `AgentLoopService.list*` 是**新功能面**，不是收敛——先记着 |
| `listTurns` / `listInputRequests` | 各 4 / 2 | 同上，ExplorerThreadService 只管回合的**执行** |
| `listAgentLoopSteps` / `listToolCalls` | 3 / 1 | 观测类枚举，建议**永久保留**在 route 里 |
| `listRuns` | 3 | `Scheduler.listRuns(projectId)` 是合理补充（Run 是 Scheduler 管的） |
| `listPlans` | 2 | `PlanService.listProjectPlans` 返回 `PlanIndexRow[]`，**形状不同**，不能替换。若补，要补的是"按 explorerPlanId + source + status 找草稿"这个**查询**，属 `PlanService.query` 的邻域 |
| `listCandidateVersions` | 2 | `PlanService.listRevisions` 返回 `PlanRevisionV2[]`，形状不同 |
| `listRevisionDrafts` / `listRevisionLifecycleProjections` / `listHookExecutions` / `listChangeProposals` / `listThreads` / `nextId` / `getInputRequest` | 各 1 | 单点使用，**收敛收益低于新增公共面**，建议保留 |

**这一类的默认答案是"保留"。** 每补一个 Service 读方法都是一次公共 API 扩张（P3 批 F 的教训：给零外部消费者的符号增加公共面，只会让后续的类型共享多背一个无意义的契约）。

### D. 两个容易看错的陷阱（已在代码里踩过的）

1. **`ExplorerService.list(projectId)` 与 `store.listThreads()` 再过滤 `state !== "ARCHIVED"` 不等价。** `list()` 会**带上 ARCHIVED 线程**。`projects.ts:78` 需要的是"未归档的线程"，直接换过去会让重复导入同一个仓库时复用一个已归档线程。**判据：换之前先读被换方法的函数体，不要只看名字。**

2. **`store.getDispatchState(planId)` 与 `dispatchCoordinator.state(planId)` 不是同一件事。** 后者是协调器的**内存投影**，前者是库里落盘的。`plans.ts:360` 的 `dispatchCoordinator?.state(plan.id) ?? store.getDispatchState(plan.id) ?? null` 是**三层回退**，顺序即优先级，**不是重复读**。

## 已替换的部分（P6 实际改掉的）

只有 3 处，全部是**逐字透传且不需要 null 语义**的：

| 位置 | 改动 | 为什么等价 |
|---|---|---|
| `plans.ts:272` | `store.findMergeRequestByRun(run.id)` → `merger.findByRun(run.id)` | `MergeService.findByRun` 的函数体就是 `return this.store.findMergeRequestByRun(runId)`，返回类型同为 `MergeRequest \| undefined` |
| `explorers.ts:97` | `store.getThread(explorer.id)` → `explorers.get(explorer.id)` | 刚 `createPlan` 过的线程必然存在，`get()` 的 throw 分支不可达 |
| `explorers.ts:147` | `store.getThread(explorer.id)` → `explorers.get(explorer.id)` | 同上（`activatePlan` 之后） |

**`MergeService` 的三个读方法（`findByRun` / `get` / `list`）是全仓唯一逐字透传的读方法**，已经全部接上（`merger.findByRun` 4 处 / `merger.get` 1 处；`merger.list` 目前无路由使用）。

## 一条不要做的事

**不要为了把 `store.*` 清零而现造 Service 方法。** 那会把重构变成功能开发，而且每一次现造都是在扩大 domain 的公共面。真实的收敛顺序是：**先补 A 类的非抛错读 → 再补 B 类的归属校验 → C 类默认保留**。每补一个，同一个提交里改掉对应的 route 调用点并跑 `pnpm --filter @pipeline-factory/api test`；这个计数记在提交信息里。

另有一条**不属于 P6、但读代码时会问到的**重复：`routes/*.ts` 里那些 `if (!store.getProject(id)) return 404 PROJECT_NOT_FOUND` 与组合根 `server.ts` 的 `preHandler` **守卫完全重合**（同一个 `/^\/api\/v[34]\/projects\/([^/]+)/` 前缀，同一个 `code`，同一条 error 文案），因此那些 404 分支在当前路由表下**不可达**。删掉它们是行为中性的，但那是**减法收尾**（方案 P9 的"可选"一类），不在 P6 的章程内——本文只做记录。
