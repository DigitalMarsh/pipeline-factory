# Changelog

## 2026-10-07 — Loop 面板改成列「结论」，不再列「最后 4 条」

报障是问出来的：那几格（`#41 PROVIDER_ACTIVITY` / …）**对判断业务执行有帮助吗**。答案是"几乎没有"，
毛病有三条，而**不是**"会漏看"：

- **原因从来没被显示过** —— 那一格只写 `#44 LOOP_SUSPENDED`，而"发生了什么"全在载荷里
  （`PROCESS_RESTARTED`）。用户问"为什么卡住了"，面板答不上来。这是主要毛病。
- **4 格里通常 3 格是成对的活动** —— `PROVIDER_ACTIVITY` 是 started / completed 各一条，
  等于 4 格只讲了一件事。
- 显示的是**枚举原名**，且不分轻重（一律灰底）。

> 订正一处我先前的论断：我一度说"真正的死因常常挤不进那 4 格"。**全库实测不成立**——
> 76 条有结论的步骤**全部**落在最后 4 格之内（`LOOP_FAILED` / `LOOP_SUSPENDED` / `LOOP_COMPLETED`
> 本身就是收尾的那一条）。这次改的不是"漏看"，是**让面板说人话**。

### Changed

判据从"新不新"换成**"这条步骤有没有结论"**（`apps/web/src/utils/agentLoopSteps.ts`）：

- **只留**：`LOOP_FAILED`、`LOOP_SUSPENDED`、`LOOP_COMPLETED`（取消时按 status 说"循环已取消"，
  不读成正常结束）、`TOOL_FAILED`、`TOOL_DENIED`、`TOOL_NEEDS_RECONCILIATION`、`GATE_CHECKED`
  **仅 blocked**（与探索侧 `explorer-activity` 那条判据逐字相同：没问题的不占行）。
- **把原因码顶到面上**：`#85 循环失败 · PROVIDER_COMMAND_TIMEOUT`。原因码保持原样不翻译——
  界面上别处（任务卡的阻塞原因）就是这么显示的，翻成中文反而没法拿去 grep 日志。
- 中文标签 + **原始枚举名留在 `title` 里**，排障时仍可按 `LOOP_SUSPENDED` 去搜代码与日志。
- 三档语调：失败红、需要你看一眼的橙（挂起 / 被拒 / 拦截 / 已取消）、正常结束灰。此前一律灰底，
  `LOOP_SUSPENDED` 与 `PROVIDER_ACTIVITY` 长得一模一样。
- **正常跑着的 Loop 一条都不给**，面板上只留那行进度。

### 验证

- 新增 5 条 `agentLoopSteps` 用例（含"活动再多也不占格"、"取消不是正常结束"、"超过上限取最后几条"）
  与 1 条组件用例（断言渲染出来的是结论那一格、且页面上不出现 `PROVIDER_ACTIVITY`）。
- **两个真实 Run 上实测**：
  - `run-8d0b9489-06d`（已阻塞）：面板只有一格 `#85 循环失败 · PROVIDER_COMMAND_TIMEOUT`（红）——
    改之前那一格只有 `LOOP_FAILED`，看不到是命令超时；
  - `run-ff037bc2-26d`（已完成）：只有一格 `#1640 循环结束 · READY_FOR_VERIFY`——**1600 多条
    `PROVIDER_ACTIVITY` 一条都没露**。
- `pnpm verify`：domain 443 / api 121 / web 599。


## 2026-10-07 — 删需求留下的空号会让新回合**撞号**

删掉几条需求之后核对线程状态，发现**需求7 与需求10 的回合都占着 #13 / #14**——同一线程里两对回合
分不出先后。查下来是这行：

```ts
sequence: turns.length + 1,   // explorer/thread-service.ts
```

**数行数**在"回合只会跟整条线程一起消失"的年代是对的——那时行数恒等于最大序号。但**删除一条需求
会在中间留下空号**（实测：删掉两条需求后剩下的序号是 1, 2, 7…14, 17, 18，而行数是 12），
再数行数就会**撞上已经存在的号**。

这是「删除需求」这个功能带出来的回归：它是第一个能在回合序列中间挖洞的操作。

**修法**：下一个序号**从现有的最大值接着数**（`max(sequence) + 1`），不数行数。

**验证**：新增一条用例（内存 + SQLite 各跑一遍），刻意造出"删过之后有空号"的状态
（剩 1,2,5,6），再新建一个回合。它**先失败、后修好**——把修复退回去跑一遍，结果是
`[1,2,5,6,5,6]`（#5/#6 撞号），修好后是 `[1,2,5,6,7,8]`。

库里现存的那对撞号随"删掉需求7"自然消失了；要不要把历史回合重排成连续号另说（重排会改
前端用的稳定键，属于呈现层的事）。

`pnpm verify`：domain 443 / api 121 / web 593。


## 2026-10-07 — 「上下文压缩」是个错名字：它从没压过

报障：探索线程里**老是冒出"上下文压缩"**，而探索根本没聊几句——"这不合理"。

**确实不合理，因为根本没有压缩。** 顺着那条行往上查：

- 它来自 Loop 里的一个步骤，追加在**每轮跑完、门禁说"接着做"**的时候（`agent-loop.ts`）；
- 看它前后几行：把这一轮的正文 push 进 `messages`、把续跑提示 push 进 `messages`、写一个
  checkpoint（步骤号 / Provider 会话 / 消息条数 / 末段正文）——**两次 push，零次删除**；
- 全仓搜 `messages` 的删减（`slice` / `splice` / `shift` / 重新赋值）：**一处都没有**；
- 连领域侧的投影英文文案都写的是 `"The loop saved a checkpoint before continuing."`——
  **代码自己知道它是检查点，只有那个名字和界面上的中文标签说是"压缩"。**

真的压缩只有一种：**Provider 自己压**（Codex 的 `thread/compacted`、Claude 的 `system/compact_boundary`），
走 ④ 类的 `PROVIDER_COMPACTION`，标签「上下文已压缩」，进的是头部诊断区而不是时间线。
⑤ 的 `CONTEXT` 与它**被写成了同一件事**，于是"探索没聊几句却老在压缩"。

### Changed

- 步骤类型 `CONTEXT_COMPACTED` → **`LOOP_CHECKPOINTED`**，事件 `agent.step.context_compacted` →
  `agent.step.loop_checkpointed`、`agent.context.compacted` → `agent.loop.checkpointed`
  （后者顺带归到它真正的兄弟那一族：`agent.loop.started` / `resumed` / `paused` / `cancelled` / …）。
- 界面文案：⑤ `CONTEXT` 的标签从「Factory · 上下文压缩」改成 **「Factory · 续跑检查点」**（探索侧与执行侧
  同形，两处都改）；执行侧那句详情从「模型上下文已刷新」改成「已保存检查点，继续下一轮」。
  ④ 的「上下文已压缩」**保持不动**——那一条才是真的。
- 老数据照读：库里还有 **52 条历史步骤 + 53 条事件**用旧名，所以投影、执行侧的事件判据与 SSE 白名单
  **新旧两个名字都认**（`packages/domain/src/explorer/explorer-activity.ts` 里那处判据特意放宽到
  `string`：`AgentStepType` 里已经没有旧名，直接比会让 TS 判"没有交集"，也会让老数据静默地不再成行）。
- `docs/消息类型及事件状态机流程图.md` **8 处**跟着订正（§0.1 的产者清单、§1.1 清单表、§1.3 的 23 号
  逐条说明、§2.3 的状态表、§3.1 的类型对照、§4.2 的映射图、§5/§6 的两处对照）。其中 §6.4 那行原本写
  "与 OpenClaw / Hermes 一致"，现在改成**形一致、概念不同**——它们画的是真压过的后果，我们画的是
  "这一轮跑完、接着做下一项"的边界。

### 验证

- `pnpm verify` 六阶段全绿：domain 441 / api 121 / web 593（新增一条：新事件名走同一条渲染）。
- **老数据在浏览器里真的改了口**（两侧都是历史行，库里存的还是旧名）：
  - 探索侧需求10：`Factory · 续跑检查点 · 3 条消息 20:56`；
  - 执行侧 run-ff037bc2-26d：4 条 `Factory · 续跑检查点 已保存检查点，继续下一轮`；
  - 两页全文搜「上下文压缩」：**0 处**。


## 2026-10-07 — 需求清单里能删掉一条需求了

上一轮把**方案**从"只能丢草稿"放宽到"还没开始执行的都能丢"，但那只解决了一半：**丢弃动的是 Plan，
需求行还在清单里**。project4 那条线程下有 9 条需求，其中 8 条是反复试同一个问题留下的近重复——
要的是"把这一条从清单里删掉"，不是"把它的方案标成已丢弃"。

而这个产品**删得掉线程，删不掉线程里的一条需求**：`ExplorerService.delete` 是按线程级联的，
它继而下调的 `deleteExplorerCascade` 里还有一大半 SQL 条件是按 `input.explorerId`（**线程**）匹配的
——`explorer_turns.thread_id`、`explorer_input_requests.thread_id`、`plans.source_explorer_thread_id`、
`explorer_plans.explorer_thread_id`，最后还有一句 `DELETE FROM explorer_threads`。所以"删一条需求"
既不能直接调它，也没有任何 API。

### Added

- **`ExplorerService.deletePlan(explorerId, explorerPlanId)`**：删掉这条需求，连同它名下的候选方案与
  全部版本 / 修订 / 修订草稿、调度与查询投影、由它派生的 Run 及执行线程 / 执行日志 / 钩子执行 / 验证轮次 /
  合并请求 / 补充要求、它名下（含"owner 是回合"那条）的 loop 与 steps、以及结构化提问。
  **不碰线程行本身**，也不删 `domain_events`（审计事件保留——与「删除线程」一致）。
- **`Store.deleteExplorerPlanCascade`**（内存 + SQLite 两套实现）：只按 id 删行，与线程级那段逐条对应，
  差别只有两处且都是故意的——**没有 `DELETE FROM explorer_threads`**；三张挂在需求上的表按
  `explorer_plan_id` 匹配，而线程级那边用的是 `thread_id` / `source_explorer_thread_id`。
  线程行上的指针不在 store 里改：**用既有的 `updateThread` 由 service 写回**，这样两个 store 实现都不必
  各自重写一遍"谁接任"的判定。
- `DELETE /api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId`，
  返回 `{ deletedExplorerPlanId, explorer, explorerPlans, deleted }`——顺手把刷新后的清单一起给回来，
  前端就不用再拉一次（少一次漂移的机会）。归属校验照抄 `workspace` 那条：不属于本线程的方案一律 404。
- 需求清单每行末尾一个删除按钮（与重命名铅笔并排，悬停才红），确认框写明代价：
  "结构化 Plan、执行记录与执行日志会一起删除，无法恢复；已结束运行的本地 worktree 不会自动清理"。

### 两条护栏

- **有在跑的就不给删**：直接复用删除线程那把尺（`EXPLORER_DELETE_ACTIVE_RUN_STATUSES` +
  `ExplorerDeleteBlockedError`），没有另起一套判据。待合并、已取消、已阻塞、`STALE` 都放行。
  （`MERGED` 不在这一串里：它是 **Plan** 的状态，Run 上不存在——合并后 Run 停在 `MERGE_READY`。）
- **线程里最后一条需求不给删**：线程必须至少有一条（`listPlans()` 在没有需求时会当场补一条空的），
  放行的话用户看到的是"删了但清单没变"。抛错比静默重建诚实。

  为此新加了 `ExplorerPlanDeleteForbiddenError`（code `EXPLORER_PLAN_DELETE_FORBIDDEN`），
  与"还有在跑的"那类 409（`EXPLORER_DELETE_BLOCKED`）**分成两个 code**：一个是"先停掉再来"，
  一个是"规则上就不许"，前端给的说法完全不同（"先把它停掉再删" / "线程至少要留一条"）——
  压成同一个 code 的话，界面只剩一句笼统的失败。

### 收指针：不是置空，是镜像

删掉一条需求后，线程行上有**六个指针**指着它：`active_explorer_plan_id`、`candidate_plan_id`、
`last_assessed_turn_id`、`active_revision_draft_id`、`context_summary_json`（`openPlanIds` + `completedPlans`）、
`message_count`。退回的办法不是置空，而是**镜像剩下的最后一条需求**（按 ordinal）——线程级的
`candidate_plan_id` / `last_assessed_turn_id` / `exploration_*` 本来就是"最后评估过的那条需求"的投影
（`thread-service` 每轮都这么写），置空会让界面显示成"这条线程还没评估过"，而它明明有。
这套回落规则与上一轮手工清探针时逐列核出来的是同一条。

### 一处顺带的改动

`ApiRequestError` 现在带上出错响应的 JSON 体（`body`）。此前只有 `status` 与 message，而**同一个 409
下可能有好几种原因**——删除需求的两种 409 就是这么回事，前端拿不到 `code` 就只能笼统报一句失败。
顺带把"`error` 字段不是字符串时 message 变成 `[object Object]`"也修了（路由里有几处 `error` 传的是
`zod` 的 `flatten()` 对象）。

### 验证

- **领域 13 条**（内存 + SQLite 各跑一遍）：三条需求的线程里删中间那条，另外两条的回合 / 方案 / Run /
  loop / 事件**一条不少**，线程行的指针落到剩下的最后一条、`messageCount` 相应减少；删当前选中的那条时
  活动需求落到剩下的一条；有在跑的 Run 就拒**且一行都没删**（事务回滚），Run 停了但探索 loop 还 PAUSED
  同样拒；跑过但停了的（`MERGE_READY` / `CANCELLED` / `BLOCKED` / `STALE` / `NEEDS_PLAN_CHANGE`）放行；
  最后一条拒；别的线程的需求拒。
- **API 4 条**：200 的形状与剩下的清单、最后一条 409 `EXPLORER_PLAN_DELETE_FORBIDDEN`、
  有在跑的 409 `EXPLORER_DELETE_BLOCKED`（带 `activeRunIds`）、跨线程 404。
- **web 8 条**：清单每一行都有删除按钮且 aria-label 带标题、点第几行只发那一条的 id、重命名按钮没被串；
  视图侧接上了处理函数、确认框的三句代价、两个 code 的两种说法、以及"只有删掉的是当前打开的那条时才换选中项"。
- **浏览器**：project4 那条 9 条需求的线程里，9 行的删除按钮与 aria-label 都对，点第一行弹出的确认框
  标题「永久删除需求」与正文（一起删 / 无法恢复 / worktree 不自动清理）逐字正确。
  （按下"永久删除"那一下在这一轮里被判成不可逆的本地破坏，我停手没绕，改由用户点。）
- **真实数据上真删了三条**（需求8 `explorer-plan-7451f3d6-59d` 待合并、需求2 `…-c0afc8bc-c43` 与
  需求3 `…-f6742d18-5f3` 已阻塞），三条都干净：
  - 清单 9 → 8，留下的是**序号不重排**的 1/2/3/4/5/6/7/9；线程回合 18 → 16，
    缺口正好落在它名下那两个（#15–#16）——删的是回合，不是把后面的往前挪。
  - **17 张表逐张对账**：15 张精确命中期望值（`candidate_plans` 28→26、`runs` 26→24、
    `execution_journal` 1317→1011、`explorer_turns` 106→102、`merge_requests` 15→13、
    `verification_runs` 16→14 ……）。**两张比期望多删了一点**：`agent_loops` 多 1 个、
    `agent_loop_steps` 多 43 步。查下来是**我的期望算漏了**，不是删多了——`collectExecutionClosure`
    同时按**回合**和 **Run** 收 loop，而这条需求名下的 Run 自己还带一个 executor loop（43 步），
    除了那条 46 步的探索 loop。旁证：随便挑三个跑过的 Run，各自都带 1–2 个 executor loop（最多 84 步）。
  - **全库悬空引用扫描：三次删除零残留。** 扫法不是按 id 找（那要先知道删了哪些 id），而是把
    37 条「子列 → 父表」的对照逐条查"指着不存在的行"——不管删掉的是什么，只要没有哪一列还悬空，
    就说明删干净了。**顺带挖出 8 行悬空 loop**，时间戳全是 9 月 12 / 16 日（如
    `agent-loop-c9afc760-c68`）：那是本次改动**之前**就留在库里的，删前删后都是这 8 行，没有新增。
    （这 8 行后来单独清掉了——连它们的 554 行 `agent_loop_steps`，**领域事件按产品自己的口径保留**；
    清理脚本 `.runtime/cleanup-orphan-loops.mjs`，判据是"父行还在不在"而不是 id 名单。）
  - **级联是"有什么删什么"**：逐表对账时有两张表没按我预期掉——`merge_requests` 与
    `verification_runs` 在需求2、需求3 上**一行都没删**，因为那两条的 Run 停在 `BLOCKED`，
    从来没走到验证。查了一遍全库印证：`MERGE_READY` 的 Run 是 10 个对 10 个验证轮次 + 10 个合并请求，
    `BLOCKED` 的 Run 是 1 个对 0 / 0。又是我的期望算错了，不是删漏了。
  - **指针按预期没动**（删的都不是最后一条，就不该动）：`active_explorer_plan_id` 仍是原来那条、
    `candidate_plan_id` / `last_assessed_turn_id` 仍指向需求9 的；
    `message_count` 18 → 12、`contextSummary.completedPlans` 9 → 6；
    三条 `explorer.plan.deleted` 事件落在 #236377 / #236378 / #236379。
- `pnpm verify` 六阶段全绿：domain 441 / api 121 / web 592。


## 2026-10-07 — 需求能丢掉了；顺带修掉"刷新就弹右侧面板"

起因是那条探针需求清不掉：**这个产品没有"删除需求"的路**。查到底——API 上需求只有
`create` / `rename` / `activate`（`/explorers/:id/archive` 归档的是整个探索线程，会牵连别的需求）；
`PlanService.discard` 只允许从 `DRAFT` 丢弃；存储层只有线程级的 `deleteExplorerCascade`。
于是**一个建错的需求是永久的**，它只能改名。而最需要收掉的恰恰是 `BLOCKED` / `NEEDS_PLAN_CHANGE`：
卡住了、又不打算改计划。

### Changed

- **`canDiscardPlanStatus`**（`plan/status-transition.ts`）成为"哪些状态能丢"的唯一判据，与
  `canTransitionPlanStatus` 同源：**`DRAFT` / `READY` / `BLOCKED` / `NEEDS_PLAN_CHANGE`**——
  都是"还没真正开始执行、也没有活着的 Run"的那些。**排除** `ENQUEUED` / `DISPATCHED`（正排在队列里）、
  `IN_PROGRESS` / `VERIFYING`（有 Run 在跑）、`MERGE_READY`（活干完了在等人合并，丢它会让一份待合并的
  成果失去归属）、`MERGED`。`PlanService.discard` 改用同一判据；走既有的 `DISCARDED` 状态与
  `plan.discarded` 事件，**不引入新的删除语义**。
- **客户端判据同源**（`usePlanLifecycleActions.discardPlan`）。它此前也写着"只有 DRAFT"——那颗按钮在
  BLOCKED 方案上点下去**什么都不发生**，而按钮就在那儿，看起来像坏了。

### Fixed

- **丢弃清掉的调度投影会被立刻写回来。** `discard` 顺手删掉 `plan_dispatch_states` 之后，
  `PlanDispatchCoordinator.syncRun` 6 毫秒后就按 **Run 的状态**又写了一条 `BLOCKED`/`ATTENTION`
  （实测：`plan.discarded` 之后紧跟着一条 `plan.dispatch.state.changed`）。投影的来源是 Run，而 Run
  并不知道自己的方案已经被丢了——所以判据必须放在那一侧：**已丢弃的方案不再有调度投影**。
  不修的话，Plan 中心里会永远挂着一条指向已丢弃方案的"待处理"。
- **刷新页面不再自动弹出右侧抽屉**（用户报）。`explorerPlanId` 是"当前选中哪个需求"的**常规路由状态**
  ——每选中一个需求都会写进 URL，而加载路径按它打开抽屉，等于"每次刷新都弹一次面板"。
  改成：**只按 URL 记住页签，不打开**，要看得用户自己点（点开时落在原来那一页）。
  `runId` 那条深链接不在此列：它只在明确"看这条 Run"时才会出现在地址里。

### 验证

- 领域 3 条新用例：可丢与不可丢的两侧逐个断言（`ALL_STATUSES` 全覆盖 + 六个执行态明确排除）；
  丢弃清掉调度投影；**丢弃之后不再按 Run 的状态重建**（这条验过：把守卫注释掉它就会红）。
- web 2 条：客户端判据在 `BLOCKED` 上真的发出请求、在 `IN_PROGRESS` 上仍然不发；刷新路径里那句
  "紧跟页签赋值的打开"没有了。
- **真跑一次**：对探针方案 `plan-944bb076-899`（`BLOCKED`）调
  `POST /api/v4/plans/:id/discard` → **HTTP 200**，库里变成 `DISCARDED`，`plan.discarded` 事件在位。
- `pnpm verify` 六阶段全绿：domain 428 / api 117 / web 583。

### 收尾：把探针的行从库里删掉

探针那条需求已经 `DISCARDED`（产品层面看不见了），但它留下的事实还在库里。删了。

**第一版范围（"四个 id、16 张表、555 行"）是错的，而且错在会留下孤儿行**——它只按那四个 id 去扫，
于是漏掉了三类：`agent_loop_steps`（**288 行**，它按 `loop_id` 挂，扫 id 扫不到）、
"owner 是回合"的那条探索 loop（`agent_loops.owner_id` 存的是**回合 id**，既不是 run 也不是需求，
按 run 找只会找到两条）、以及聚合在 **loop / merge 请求**上的领域事件（那两个 aggregate 从来不在四 id 里）。
真正的数字是 **1398 行 + 1 行修补**，分布在 17 张表：

| 表 | 行 | | 表 | 行 |
|---|---|---|---|---|
| `domain_events` | 836 | | `plan_revisions` / `candidate_plan_versions` / `candidate_plans` | 各 1 |
| `agent_loop_steps` | 288 | | `explorer_plans` | 1 |
| `execution_journal` | 257 | | `explorer_turns`（#19/#20） | 2 |
| `agent_loops` | 3 | | `runs` | 1 |
| 其余 9 张单行表 | 各 1 | | | |

那 836 条事件的**聚合**也值得记一笔：`agent-loop-96f66c47-b66` 304、run 254、`agent-loop-b5ea4ee1-4d9` 164、
探索 loop 77、plan 28、merge 请求 2 —— 光看 plan 与 run 两个聚合只能数到 282。

**唯一不能删、只能改的一行**是 `explorer_threads` 的 `explorer-36c7fd77-f5f`：这条线程下有 **10 条需求**，
探针只是最后一条，而线程行的三个指针指着它——`candidate_plan_id`、`last_assessed_turn_id`、
以及 `context_summary_json.completedPlans` 里探针那一项。退回**第 9 条需求**当时的值（那是探针之前最后一次
评估的状态），`message_count` 20 → 18，回合数 20 → 18。

线程上还有 **7 条**事件（`explorer.plan.created` / `plan.ready` / `requirement.status.changed` ×2 /
`turn.accepted` / `started` / `completed`）讲的就是探针，它们**共用一个 aggregate**、删不到。
判断是删：留着的话，库里会一半有探针（探索侧留痕）一半没有（执行侧已删），那是最糟的中间态。

**验证**：删完把那 4 个 id（外加两个回合 id）在**每张表的每一列**上重扫一遍——**0 命中**；
隔 20 秒再扫一次仍是 0（确认没被服务端写回来）。线程行落成 9 条需求 / 18 个回合，
指针指向存活的行。Run 的 worktree 目录与分支 `factory/20261007-document-readme-structure` 早已随取消清掉，
磁盘上没有残留。

备份：`.runtime/pipeline-factory.sqlite.before-probe-delete`（17.6 MB，`VACUUM INTO` 取的，
比早先那份 `before-probe-cleanup` 更贴近删除前的状态）。清理脚本留在
`.runtime/cleanup-probe.mjs`，**不带 `apply` 参数跑就是只报数的 dry-run**。


## 2026-10-07 — 补充要求：真跑一次之后挖出来的五个问题

上一轮把「补充要求」接通之后做了一次真跑（在 project4 新建一条需求：改 `code/README.md`，确认 → 派发 →
跑完 → 再发一条补充要求）。**这一跑把五个问题全暴露了**，其中四个是设计时没想到的。

### 1. 门禁的重试不说"差在哪"，于是空转到被人工取消

续跑那一轮里，模型把补充要求带来的额外工作自己编成了一个计划里没有的 **`task-3`** 一并报上来。而
`allTasksComplete` 要求 `completedTaskIds` **恰好**等于计划的 id 集合（多一个少一个都为假），于是它永远
为假；偏偏 `TaskProgressGate` 当时只回一句 `TASKS_INCOMPLETE`——**模型不知道自己错在哪，就照原样再报
一遍**。实测：这条循环跑满 **25 步**（约 6k tokens/步）才被人工取消，loop 的诊断字段里留着
`lastGate: { action: "continue", reason: "TASKS_INCOMPLETE" }`。

- `GateContext` 增加 `planTaskIds` / `missingTaskIds` / `unknownTaskIds`，由 `progressContext` 从
  "计划的权威清单"与"本轮报告"算出来。
- `TaskProgressGate` 在 `TASKS_INCOMPLETE` / `reportError` / `EXECUTION_REPORT_MISSING` 三条路上都给出
  续跑提示：计划的 id 清单、漏报的、多报的，并明说**不要重做已完成的工作**。
- 续跑提示里同时写出计划的那几个 id，并声明"不许为额外工作新造 id"（要加任务得走「创建更新版本」）。

### 2. 补充要求那一轮的产物被归给最后一个计划任务（用户报的）

"如果有多个步骤的时候，补充要求是合并到最后一个步骤中，感觉是在做第二个步骤。我希望补充要求独立于任何步骤。"

它确实是这样：`ExecutorAgent` 按 Run 记着"当前任务"，跨轮不清，于是新那一轮的 journal 条目全盖着上一步的
`taskId`，被折进那个任务的过程组。现在**补充要求那一轮不归属任何计划任务**（起跑时清掉继承下来的归属，
并在整轮期间不为产物盖 `taskId`）。**只影响归属**：`TASK_PROGRESS` 的 `task-lifecycle` / `task-status`
自带 taskId，"哪些步骤完成了"照旧读得出来。

### 3. 报告跨轮合并，把上一轮那一行"改写活了"（用户报的）

"已完成 2 个任务，改动 1 个文件的地方。在补充需求后，变成了动画，感觉还在执行中。"

折叠重复报告的逻辑（`sameReportProgress`）本来是为了把**同一轮里**反复重报同一份进度折成一条；而新一轮的
第一份报告数字往往与上一轮**完全相同**（任务没变、文件也还没改），于是它被并进上一轮那一行——内容被覆盖、
序号与时间被改写成新的。判据加上了 loopId：**合并不跨轮**。

### 4. `MERGE_READY` 被当成终态（用户报的那两条的共同放大器）

它曾经是终点，现在不是了——补充要求可以让同一个 Run 从它回到 `IN_PROGRESS`。两处仍在把它当终态：

- `connectRunEvents()` 一见 `MERGE_READY` 就**不建立事件流**；`handleRunEvent` 一见它就**关掉**事件流。
  于是补充要求开始之后页面收不到任何事件：用户看到「已完成 / 等待合并」一动不动，直到手动刷新。
- 页头的执行 Loop 用 `agentLoops.find(role === "executor")`，**永远返回第一轮**——补充要求跑起来了，
  页头还停在上一轮的"已完成 1/40 步"。改成按 `startedAt` 取最新。

### 5. 「需求9 补充要求后大模型没有返回任何内容」——**不是模型，也不是这条链**

查下来是**开发服务器重启把这一轮打断了**：需求9 的续跑 loop `08:47:09` 起跑、`08:47:14` 跑了一个
Bash 工具调用并成功、`08:47:23` 就收到 `agent.loop.recovery_required`，reason 是 **`PROCESS_RESTARTED`**。
`.runtime/api.log` 里 `Restarting` 出现 **389 次**——API 跑在 `node --watch` 下，**仓库里任何一次文件
保存都会重启它**，而当时正在改的就是这些源码。日志里还有 30 次 `database is locked`（同时在跑 3 个 API
实例，互锁 SQLite）与几处 tsx 半成品状态的 `ERR_MODULE_NOT_FOUND`。

**所以：跑 Run 的时候别编辑这个仓库；也别同时开多个 API 实例。** 被打断的 Run 会停在 `RECOVERING`——
而那正是「补充要求」支持续跑的状态，发一条要求就能接着走。

### 验证

- domain 5 条新用例：门禁的点名（多报 / 漏报 / 报告缺失三条路 + 全部满足时不带提示）；执行侧
  **补充要求那一轮的产物不盖 taskId、普通那一轮照旧盖**（同一条用例里对照，否则这条修复会顺手把原来
  正确的行为也关掉）。
- web 2 条：报告不跨轮合并（带 `agent.model.completed` 边界，报告是在那一刻渲染的）；页头取最新的
  Loop、事件流不再在 `MERGE_READY` 关。
- `pnpm verify` 六阶段全绿：domain 425 / api 117 / web 581。


## 2026-10-07 — pre-commit 钩子：提交前只排版这次暂存的文件

`pnpm format` 是一次全量动作，日常提交更需要的是"只碰我这次改的东西"。钩子放在
`code/scripts/git-hooks/pre-commit`，用 `core.hooksPath` 指过去。

### 为什么不是 husky

本仓的 **git 根在上一级**（`pipeline-factory/`），而工作区与 `package.json` 在 `code/`。husky 要求
`.git` 就在它运行的那个目录里——`pnpm exec husky` 直接报 `.git can't be found`，**连 `--help` 都到不了**。
要它可用就得把仓库结构改成"package.json 在 git 根"，那是另一个量级的改动。所以这里只做 husky 真正必要的
那一件事：设 `core.hooksPath`（`scripts/install-git-hooks.mjs`，幂等，`prepare` 里调用；另加一个
`pnpm hooks` 供已装过依赖的仓库手动重装——pnpm 在"依赖没变化"时会跳过 `prepare`）。

### 为什么不是 lint-staged

装了才发现它在这台机器上**用不了**：`/usr/local/bin/git` 是一个陈旧的 **2.15.0**，而 lint-staged 17 要求
≥ 2.32——它解析到的正是那一个（同一台机器上 `git --version` 是 2.55.0），于是每次提交直接
`✖ requires at least Git version 2.32.0` 退出。改用显式 PATH、把正确的 git 排在最前都没用。那段逻辑手写
几十行就够，还少一个依赖。

### 钩子做什么、不做什么

- 只处理**这次暂存**的、`code/` 下、已知后缀的文件：`prettier --write` → `eslint --fix --max-warnings=0`
  → 把结果重新暂存。
- **部分暂存的文件会拦下提交，而不是偷偷替你决定**：一个文件同时有暂存与未暂存改动时，对工作区文件跑
  `--write` 会把你还没打算提交的那部分一起格式化，紧接着的 `git add` 又会把它一并暂存——提交范围被
  静默放大。钩子列出这些文件并给出三种处理方式。
- 不碰 `docs/`、`CHANGELOG.md` 这些手写文档（它们的排版是作者的事）。
- 跳过：`git commit --no-verify`。

### 验证

三条都用临时文件走完整提交实测过：（1）提交未格式化的内容后，仓库里存的是**格式化后**的版本，钩子打印
「已排版并检查 1 个文件」；（2）部分暂存时提交被拦下并打印三种处理方式；（3）留一个未使用的变量 →
ESLint 报错、提交中止、没有产生提交。

调试这段脚本时**同一个坑踩了两次**，值得记下来：**git 按它自己的 cwd 解析 pathspec**。工具跑在 `code/`，
而 `git diff --cached` 给的是**仓库根相对**的路径——拿后者配 `code/` 的 cwd，`git add` 会报"未匹配任何
文件"，而 `git diff --quiet` 只是**静默地找不到差异**（于是"部分暂存"那道护栏根本不生效，提交范围被悄悄
放大）。两种失败都不指向真正的原因，所以现在文件里所有 pathspec 都先换算成 `code/` 相对再传，并把这条写进了注释。

顺带把 README 的「验证」一节补上 `pnpm --dir code verify`（原文还在列几条手敲的 `.bin` 命令），并新增
「代码规范与提交钩子」一节。


## 2026-10-07 — 全量格式化（267 个文件）+ 把 `format:check` 接进门禁

工具装好之后跑了 `pnpm --dir code format`，Prettier 重排了 **267 个文件**。这一步的真实代价不在
源码上，而在**测试**上：本仓有 23 条用例断言的是**源码文本**（`expect(explorerViewSource).toContain(...)`），
而格式化改的正是换行与缩进——于是它们全部报红。

### Fixed：把那些断言从"测排版"改回"测接线"

这些断言要证的是"这里接上了某个东西"，不是"它是怎么排版的"。所以给它们加了一层折叠：两边都先规范化
再比。折叠的规则是**只吃掉断行带进来的空格**，而且踩了三个坑才写对：

1. 只把连续空白压成单个空格**不够**：断行处会留下一个空格（`foo(\n  bar,` → `foo( bar,`），
   而断言里写的是 `foo(bar,`。还要去掉开括号后、闭括号/分号/逗号/**收尾引号**前的那些空格
   ——最后一条是 `:disabled="… || busy\n"` 这种"引号被挤到下一行"的情况。
2. **不能**顺手去掉 `(` 前面的空格：`@media (max-width: 720px)` 会变成 `@media(max-width:`，
   而**正则断言不会被折叠**（正则不会被"规范化"），一改就再也匹配不上。
3. Prettier 会给长参数列表**补尾逗号**（`f(a, b,)`），所以还得把闭括号前的逗号一并吃掉。

两条断言不是排版问题，是**真的变了**，所以照实改了期望值：Prettier 给 `computed(() => typeof … ? … : null)`
补了外层括号，并把模板里的小括号表达式 `resolved ? '…'` 统一成了双引号。

CSS 那几条（`styles.css` 从"一行一条规则"被拆成"一行一声明"）用的是同一层折叠——顺便把一条
媒体查询正则的冒号后空格也对齐了（折叠不动 `:` 旁边的空格）。

### Changed

- `scripts/verify.mjs` 增加 **format 阶段**（`format:check` 而不是 `format`：门禁只判断合不合格，
  **不改文件**）。在此之前它加不进来——那时 Prettier 对 267 个文件有意见，加进去只会让门禁永远是红的。
  现在 `pnpm verify` 是七个阶段：domain build → typecheck → lint → **format** → 三个包的用例 → 循环依赖。

### 验证

- `pnpm format:check`：全部通过（`All matched files use Prettier code style!`）。
- `pnpm verify` 全绿：domain 420 / api 117 / web **578** 用例，一个都没少。
- 顺带记一笔排查过程里的一个假警报：中途 `verify` 报 web 只有 496 个用例，看着像丢了 82 个。实际是我在
  批量改断言时把四个测试文件的 `flat` 助手写坏了（正则里的字符类拼错），**解析失败的文件其用例不被计入**。
  修好之后回到 578，数目本来就是对的——"用例数变少"在这种情况下是语法错误的症状，不是删了测试。


## 2026-10-07 — 接入 ESLint / typescript-eslint / eslint-plugin-vue / Prettier

装之前先量了一遍仓库的形状，因为**"装上工具"与"把现有代码全量重排"是两件事**，代价差了两个数量级：
342 个 TS/Vue 文件，最长的一行 6317 字符（`ProjectSettingsDialog.vue` 的样式块），代码行的行长中位数 46、
p90 是 125、p99 是 283。

### Added

- 根 `eslint.config.js`（flat config，ESLint 10 只有这一种）。三条范围约定都写在文件头：只查
  `src` 与 `scripts` 不碰 `dist`；**Node 与浏览器全局变量按目录分开**（混在一起会让 `apps/api` 里写
  `document`、`apps/web` 里写 `process` 都不报错）；Prettier 放最后。
- 根 `.prettierrc.json` + `.prettierignore`。`printWidth: 140` 是照仓库自己的分布挑的——p90 = 125、
  p95 = 163，140 落在作者本来就在写的区间里，只打断真正的离群行。其余取值（双引号、分号、两空格、
  `trailingComma: all`）与现有代码一致。
- 根 `package.json` 补 `lint` / `lint:fix` / `format` / `format:check` 四个脚本；
  `scripts/verify.mjs` 增加 **lint 阶段**。

### Changed

- **删掉 73 处死代码**（ESLint 报出来、逐条确认过）：未使用的 import 与局部绑定、再往上一层的级联
  （删掉一个 computed 之后它依赖的计数器也变成没人用）。其中 `ExplorerView.vue` 一个人就 26 处，
  最深处连删三层——`contextMenuItems` → `candidateCount`/`dispatchedCount`/… → 它们依赖的
  `activeRuns`、`dispatched`。这些都是功能删掉后留下的残骸，删之前逐条 grep 确认过只有声明那一处
  引用，之后由 `vue-tsc`（会检查模板）与 578 条 web 用例兜底。
- 7 处 `throw new Error(...)` 在 `catch` 里补上 `{ cause: error }`：外层那句是给人看的摘要，底下
  Provider/SQLite/网络报的原文只有 `cause` 留得住。
- `codex-app-server.ts` 的 `removeAbortListener` 由 `let` + 事后赋值改成 `const`（只赋一次；唯一读它的是
  超时回调，那个回调在初始化之后才跑，没有暂时性死区问题）。

### 两处**有意的**规则取舍（都写在配置里，不是沉默地关掉）

- **Vue 插件只挂在 `.vue` 上**，不是整个 web 目录。`one-component-per-file` /
  `component-definition-name-casing` / `require-default-prop` 说的是**单文件组件**的形状，而本仓库
  `.ts` 里唯一出现组件的地方是测试的 `defineComponent` 桩件（一个文件给 ElDialog / ElButton / ElTag
  各造一个）；对它们套 SFC 规则会报出 53 条与实际风险无关的噪声。
- **`vue/require-default-prop` 关闭**：本仓库的 SFC 全是 `<script setup lang="ts">`，可选 prop 已由类型
  说清楚（`project?: Project`），再加 JS 层 `default` 是把同一件事写两遍。

`vue/no-v-html` **没有关**——那一条是真信号，所以给唯一一处注入了行内豁免并写明理由（内容来自
`utils/markdown.ts` 的清洗结果，不是用户原文）。

### 明确不做：没有跑 `prettier --write`

`prettier --check .` 此刻对 **267 个文件**有意见。全量重排是一次覆盖全仓的改动，而且现在有别的会话
正在改这些文件——它该是一次**独立的、可以单独回滚的决定**，不是夹在"装工具"里顺手做的事。
工具已经就位：`pnpm format` 一条命令。等真跑了，再把 `format:check` 加进 verify 的那一行是现成的
（注释里已经写好位置）。

### 验证

- `pnpm lint` 干净（`--max-warnings=0` 语义上等价，当前 0 error / 0 warning）。
- `pnpm verify` 六阶段全绿：domain build → typecheck → **lint** → 三个包的用例
  （domain 420 / api 117 / web 578）→ 循环依赖检查。
- 三条 web 用例的源码断言跟着改（它们断言的是被删掉的那几行 destructuring 的字面量）；改的是断言
  文本，判据没变——它们要证的仍是"ExplorerView 把这些 composable 的返回值接上了"。


## 2026-10-07 — 执行完了但没合并，想再让 Agent 补一轮：输入框点不动

报障原话："执行线程执行完成了，但是未合并。状态还是运行中…我需要继续让 agent 做一些工作，补充探索
未发现的问题。问题是现在页面上文本输入框无法点击。"

查下来**不是一个坏按钮，是这条能力从来没接通**，而且断在不止一处：

1. **输入框为什么禁用**：`executor-agent` 在 Loop 一收尾（`READY_FOR_VERIFY`）就把 ExecutionThread
   置成 `COMPLETED`，而 `canSendExecutionMessage` 与 `Scheduler.addGuidance` 都拒绝 `COMPLETED`
   线程。判据用错了对象——线程状态回答的是"上一轮 Loop 还在不在"，Run 状态才回答"这个 Run 还需不需要
   人说话"，于是输入框**恰好在最需要它的那一刻**禁用。
2. **就算放开也没用**：`USER_GUIDANCE` 全仓只有一个消费方——web 时间线的渲染。执行侧 Loop 只读
   `MODEL_OUTPUT` 拼报告，**从不读这条**。实测：全库仅 2 条 `USER_GUIDANCE`，两条**之后**的
   `MODEL_OUTPUT` 都是 **0 条**。
3. **还有第二个同样的死胡同**：进程重启后 Loop 被判死，Run 进入 `RECOVERING`（project4 有 3 条），
   界面标着「需要恢复」，能做的只有取消。

### Added

- **补充要求的两种投递方式**（按 Codex 的排队/引导，但实现在领域层）：
  - 新表 `run_guidance`（`id/runId/content/mode/status/authorId/createdAt/consumedAt`），两种模式共用。
    落库是必须的：排队要活到这一轮结束、引导要活到下一个步骤边界，都可能跨进程重启。
  - **引导（STEER）**：`AgentLoopEngine` 在**每个步骤边界**（下一次 `stream()` 之前）通过
    `AgentLoopInput.takePendingGuidance` 取走该 Run 的待投递项，作为 `user` 消息推进会话。
    **只在下一个 Provider 回合生效**——插不进正在跑的那一个回合中间，界面据此写「引导 · 下一轮生效」。
  - **排队（QUEUE）**：留在表里，Loop 进终态时由 `Scheduler.consumeQueuedGuidance` 取走并**起新的一轮**。
- `Scheduler.continueRun(runId, guidance)`：用补充要求为**同一个 Run** 起一轮新的 Executor Loop。
  状态回退走既有写入口——Run → `IN_PROGRESS`、Plan → `IN_PROGRESS`（`MERGE_READY → IN_PROGRESS`
  是状态表里**已经声明过的合法边**，此前由恢复对账在用）、ExecutionThread → `ACTIVE`。
  新那一轮的提问里带着补充要求与**已完成步骤清单**，并沿用上一轮 Loop 的 `providerThreadId`
  （两个网关都支持续用同一个会话，而 `conversationId` 恒为 `run.id`）。
- 设置页/Run 详情：输入框的可用性判据改成 `canContinueRun(runStatus)`；一轮还在跑时给「排队 / 引导」
  二选一；草稿占位文案随状态变化，不可用时**说明原因**而不是只把框灰掉。
- `POST /api/v4/runs/:runId/guidance` 扩成 `{ content, mode: "auto" | "steer" | "queue" }`，
  返回 `{ thread, guidance, continued, run }`。

### Fixed

- **`MergeRequest` 加 `SUPERSEDED`**，`createRequest` 的幂等判据从"这个 run 已有请求"收窄成
  "**同一个 sourceCommit**"。不修的话：从 `MERGE_READY` 回去重做后，旧请求会被原样返回，而
  `confirmMerged` 只校验"旧 sourceCommit 是新 targetCommit 的祖先"——**没重新验证过的改动会跟着
  一起被合进去**。`findMergeRequestByRun` 现在跳过被作废的那些。
- 暂停中的 Run 只收下补充要求、不当场发动：随手把 `PAUSED` 线程翻回 `ACTIVE` 等于把用户的暂停作废，
  而且紧接着的 `resume` 会因线程已不是 `PAUSED` 而失败（这条是被既有 API 测试当场抓住的）。
- `addGuidance` 返回的是**重新读出来的**那一行：`continueRun` 刚把它标成已消费，返回构造时那份会让
  界面以为它还挂着。

### 语义（用户定下的）

**起续跑那一轮时，Run 按业务流程重走一遍，但任务/步骤状态一个字都不动。** 后者不是"顺便"做到的：
任务完成度从来不是持久状态（`allTasksComplete` 由本轮报告的 `completedTaskIds` 现算），任务行是 UI
从 journal 的 `TASK_PROGRESS` 推导的——**不动 journal 就自然保持原样**，某个未完成步骤被这次补完了
则靠新报告翻成完成。由此有两条必须写进提示词的约束：报告里的 `completedTaskIds` 要覆盖**全部**任务 id
（否则判定永远是 `TASKS_INCOMPLETE`，白跑步骤并可能撞上 `MAX_STEPS_EXCEEDED`），以及补充要求
**突破不了冻结的计划范围**（越界会被 gate 以 `PATH_OUTSIDE_SCOPE` 拦下，那种情况该走「创建更新版本」）。

### 明确不做

`BLOCKED` / `NEEDS_PLAN_CHANGE` 不放行——它们常常意味着"计划本身有问题"，用一句话把它们顶开会把真
问题盖住。也不使用 Codex 的 `thread/queue/add`：队列必须是我方 Run 生命周期看得见的东西（验证与合并
要等"没有待办补充要求"才能往下走），Provider 的队列在它自己的内存里、重启就没了，Claude 侧也没有对应能力。

### 验证

- 领域 11 条新用例（`src/run/run-continuation.test.ts`）：MERGE_READY / RECOVERING 上续跑的三处状态
  回退与"接着上一轮会话"；**任务状态不重置**（续跑前后 `task-lifecycle` 事实逐字一致）；四种不该受理
  的状态被拒且**零写入**；暂停中只收下不发动；正在跑时只排队；`steer` 记成 STEER；排队项在 Run 停下时
  被取走；旧合并请求被作废。另有 executor 侧 1 条钉住"引导真的进了模型收到的 messages 且只消费一次"，
  以及 store 契约 2 条（两种实现一致）。
- API 1 条新用例：认不出来的 `mode` 在入口被 400 拒掉；没有在跑的 Loop 时 `auto` 收下并记成
  `QUEUE`/`PENDING`（那正是接下来实际走的那条路）。既有那条 guidance 用例改为覆盖新语义。
- web：`canContinueRun` 的可用性表、Run 详情输入框判据与投递方式的源码断言。
- 浏览器实测（project4 那条真实的 `MERGE_READY` Run）：输入框由**禁用**变为可用、占位文案是
  「补充要求，执行线程会重新开工…」、没在跑的 Loop 时**不出现**投递方式选择器、任务行仍显示
  「已完成」；控制台无报错。**没有真的发出去**——那会起一个真实的 Run（改 worktree、花额度），
  留给用户自己按第一下。
- `pnpm verify`：domain 420 / api 117 / web 578 全绿，无新增值级循环依赖。


## 2026-10-07 — 用量栏的 Agent 显示成 codex：端点指纹只吃了角色名

报障：项目里把执行侧 Agent 设成 Claude Code，"执行页面看着也像 Claude，但左下方那个 Agent 显示
的还是 codex；模型显示的 claude 是对的"。

**"模型对、Agent 不对"这条线索就是答案**——两者读的不是同一处。查 project4 那条 Run 的三份数据：

| 来源 | 值 |
|---|---|
| Plan 确认时冻结的 executor 配置 | `{ model: claude-opus-5, backend: claude-agent-sdk }` |
| 项目**当前**设置 | 同上 |
| 线程里**记录**的 telemetry | `{ model: "claude-opus-5", backend: "codex-app-server" }` ← 错的是这个 |

模型来自 `effectiveModelConfig`（项目覆盖当时就生效），后端来自 `agent.loop.started` 的**端点指纹**，
而那个指纹是 `this.model.describeEndpoint?.(input.role)`——**只传角色名**。路由网关的
`backendIdFor(role, config?)` 本来就支持"请求覆盖优先于角色默认"（`capabilities` 一直在传第二个
参数），`describeEndpoint` 却没有那个参数，于是永远按**全局**角色默认回答。全局执行侧是 codex，
项目把执行侧覆盖成 claude，指纹就指向了一个这次根本没跑过的后端。

这条错值还会一路走到底：指纹 → telemetry → 用量栏的 Agent 那一格，而且因为
`executionModelSourceNote` 只比较**模型名**，模型名恰好相同，连"配置改过了"的提示都不会出现。

### Changed

- `ModelGateway.describeEndpoint?(role?, config?)` 补上第二个参数；路由网关按 `backendIdFor(role, config)`
  回答，不传角色时那份覆盖配置**无从归属**，一律按角色默认（两个角色指向不同后端时仍如实回答
  `mixed`）。
- `agent-loop.ts` 把 `effectiveModelConfig` 传下去——与它上面那行 `capabilities` 同源，那一行一直在传。
- `run-telemetry` 投影里 `backend` 的优先级翻成**冻结配置优先**。这不是"顺手调顺序"：`backend` 只由
  那个**配置推导**的指纹写入（不是 Provider 上报），所以冻结配置写了后端时它才是路由真正用的那个；
  冻结配置没写（跟随全局）时才轮到指纹回答"那时全局是哪个"。**修好之后两个来源本就一致**，
  这条翻转只会纠正旧记录、不会覆盖新事实——也正因为如此，那条已经落库的错记录现在能正确显示。

### 验证

- `model-gateway.test.ts`：新增"端点指纹取自 Project 真正会用的后端"（覆盖成 claude → 指纹返回
  claude；覆盖里没写 backend → 退回角色默认；不传角色 → 覆盖配置不生效）。
- `run-telemetry.test.ts`：原来那条"记录的 backend 原样带过去"的用例，fixture 恰好就是
  `记录=codex / 冻结=claude` 这个**错误组合**——它一直在断言错值。改成断言修正后的优先级，并补一条
  "冻结没写后端时由指纹回答"。
- 浏览器实测：project4 的用量栏现在显示 `Agent Claude Agent SDK`（此前是 `Codex App Server`）。

## 2026-10-07 — 清掉 `autoResolutionMs`：一个从来不到达、也没人读的字段

同一轮排查里发现的：Codex 的 `requestUserInput` 载荷里有 `autoResolutionMs`，我们把它一路带着
（模型类型 → 领域事实 → SQLite 列 → SSE 载荷 → web 类型），**却没有任何消费方**。本机 40 条真实
请求里它**一次都不是非空**（40/40 NULL），Claude 侧更是硬编码 `null`。

一个不到达、也没人读的字段，唯一的作用是让人以为"超时自动应答"已经实现了——用户关于"输入框会不会
自己解决"的疑问正来自这类模糊。它和之前删掉的 `AUTO_RESOLVED` 状态是同一件事的两半（见
`explorer/types.ts` 里那段记录），所以按同样的方式清掉。

### Changed

- 从 `ModelInputRequest` / `ExplorerInputRequest` / SSE 载荷 / web 类型里删除该字段；两个适配器不再读它。
- 建表语句去掉 `auto_resolution_ms`，并加一条 best-effort 的 `DROP COLUMN` 迁移（老库上删列，
  不支持 DROP COLUMN 或有异常时静默保留——与同区那几条老库清理同一个写法）。
- `explorer/types.ts` 与 `claude-agent-sdk.ts` 把"为什么它当初在 Claude 侧只能是 null"记进注释
  （"用户离开后自动继续"由 CLI 自己处理，宿主拿不到这个时长）。

### 验证

- `grep autoResolutionMs` 只剩注释与迁移语句；14 个测试文件的 fixture 一并清掉。
- `pnpm verify`：domain 406 / api 116 / web 576 全绿。

## 2026-10-07 — 产物模式改成项目级默认值：探索不再每次都问

Explore 每次都要先问一遍"要 CONVERSATION 还是 REPOSITORY_FILE"，而这两者的代价完全不对称：

- 该落盘却选了 **CONVERSATION** → **死路**。方案能确认、能审阅，但 `PlanService.enqueue` 与
  `dispatch` 都抛 `CONVERSATION_ARTIFACT_NOT_EXECUTABLE`，只能重新探索一轮换一份。
- 该对话却给了 **REPOSITORY_FILE** → 没有损失。不确认、不入队，一个文件都不会被写。

所以要的只是一个**默认值**，由项目定，而不是每次问。

### Changed

- `ProjectSettings.defaultArtifactMode`（缺省 `REPOSITORY_FILE`，老配置行读路径按缺省补上，不改写已有数据）。
- 工厂把它注入探索的仓库上下文（`RepositoryContextCache`：「`Plan artifact mode: …`」那一行，
  与 Verification tags 同一条通道——那是唯一按 Project 注入模型的出口）。
- 探索提示词随之改写：**不再"必须询问、不得自行假设"**，改成"按仓库上下文里那一行为准，默认
  REPOSITORY_FILE 时不要提问"；仍然禁止把 CONVERSATION 标成推荐/默认，也仍然要求在"项目默认是
  CONVERSATION、而需求明显要改仓库文件"时把这一项提出来。安全论证（只有 REPOSITORY_FILE 能执行）
  原样保留。
- 设置对话框的「执行」页签加「默认产物模式」下拉，带一句说明；`docs/消息类型及事件状态机流程图.md`
  的 `USER_GUIDANCE` 一节补上"它现在还是一条只进不出的消息"（见下面的已知缺口）。

### 验证

- domain：缺省值、显式改值、老配置行读回来都不是 `undefined`、非法取值被拒。
- api：上下文里出现 `Plan artifact mode: …`，缺省补 `REPOSITORY_FILE`，显式 `CONVERSATION` 时如实反映。
- web：对话框缺省选中 `REPOSITORY_FILE`，改成 `CONVERSATION` 后确实进载荷。
- 浏览器实测：project4 的「执行」页签渲染出新下拉，缺省 `REPOSITORY_FILE`，说明文案在位，控制台无报错。

### 已知缺口（本轮**没有**修）

执行线程的**补充要求目前不影响 Agent**：`USER_GUIDANCE` 渲染成「你补充了要求」并进 journal，但
**没有任何地方把它送进模型**——执行侧 Loop 只读 `MODEL_OUTPUT` 拼报告。本机实测：全库仅 2 条
`USER_GUIDANCE`，两条**之后**的 `MODEL_OUTPUT` 都是 0 条。而且 Loop 跑完时线程被置为 `COMPLETED`，
`Scheduler.addGuidance` 与输入框都拒绝 `COMPLETED` 线程——所以"执行完了但没合并、想再让 Agent
补做一轮"这条**两头都不通**（报障的现场：Run 是 `MERGE_READY`、线程已是 `COMPLETED`，输入框不可点）。
要真能用，先得回答两个问题：补充的要求怎么进模型上下文、Loop 结束后怎么起新一轮。


## 2026-10-07 — 退役整页「项目设置」，只留 Explorer 里的对话框

上一轮给 project4 配启动钩子时撞到的一件事：整页设置（`/projects/:id/settings`）的**命令编辑器
根本登记不出一条 lifecycle 命令**。它只有「命令 ID / 参数 / 验证标签 / 环境变量白名单」，
分类与启用是**从库里已有的那条原样带回去**的（见它 payload 里那段 `stored`）——所以新登记的命令
会落成 `category: "unclassified"` + `enabled: false`，而钩子校验要求引用一条**已启用的 lifecycle
命令**，必然被拒。对话框那版编辑器字段是全的，两个界面看起来在做同一件事，能力不一样。

查下去，那一页本来就是退役途中的残留，不是"另一个功能更弱的入口"：

- `ExplorerView.test.ts` 早就在断言 **"opens project settings in a modal without leaving the
  Explorer"**，并且显式 `not.toContain("/settings`);")`——方向早就定了；
- `ProjectWorkspaceModule` 里的 `"settings"` 只有一处消费（`App.vue` 拿它算 router-view 的 key），
  而那个模块现在已经不是一个"可停留的页面"；
- `ProjectManagementDialog` 的 `open-settings` 事件**没有任何消费方**（顺带记一笔：那个组件本身
  也是不可达的，与刚删掉的 HookSettingsView 同属一批残留，本次没动）。

### Changed

- **删掉 `views/ProjectSettingsView.vue`**（约 340 行，含它自己那份 scoped 样式）。
- **两条老地址改成重定向**而不是直接删：`/projects/:id/settings` 与 `/settings/hooks` 都指向
  Explorer，并带上 `settings=1`。删掉的代价是旧链接静默落到目录页，看起来像"这个项目坏了"；
  带 flag 是为了**保住语义**——用户输的那个地址本来就想要设置，重定向过去就得把对话框打开。
  `/settings/hooks` 额外补一个默认页签 `hooks`（旧页面与对话框用的是同一套页签键）。
- **ExplorerView 一次性消费** `settings=1`：`onMounted`（冷跳转）与 `watch(route.query.settings)`
  （已经在 Explorer 里时不重挂）两处都要，打开后立刻把参数摘掉——不摘的话关掉对话框刷新会自己
  又弹开。`tab` 一并透传给对话框的 `initialTab`。
- **`ProjectWorkspaceModule` 去掉 `"settings"`**：留着它，"设置页"就仍然是一个能被寻址的工作区。
- `ProjectSettingsDialog` 的页签清单提成 `SETTINGS_TABS`，导航与取值校验共用；`initialTab` 只认
  清单里的键——旧 `?tab=` 可能是任意字符串，不认时会把 `activeTab` 设成一个没有对应 section 的
  值，落到模板末尾的 `v-else`，显示「模型与工具」而导航上一个按钮都不高亮。

### 验证

- 浏览器实测四条（project4 的真实数据）：`/settings?tab=commands` → 落到 Explorer、对话框开在
  「命令」页签、地址栏里的 `settings` 与 `tab` 都已被摘掉；`/settings/hooks` → 「钩子」页签；
  重定向后的地址**刷新不会自动弹开**（一次性消费生效）；左侧项目列表那条路照旧打开在「常规」
  （没带页签时保持默认）。控制台无报错。
- 无孤儿全局 CSS 需要清：被删组件的样式是 `<style scoped>`，随文件一起消失；它与 `styles.css`
  共用的三个类（`saved-note` / `settings-notice` / `eyebrow`）都还有别的使用方。
- `pnpm verify`：domain 405 / api 112 / web **579**（+6）全绿，无新增值级循环依赖。


## 2026-10-07 — 启动钩子：Worktree 初始化不必硬编码，且失败策略可配

起因是执行线程里反复出现的一句话：

> CodeGraph isn't available here — no .codegraph/ index exists in
> /Users/Bill/Project/projecttest/.project4-pipeline-worktrees/20261007-fix-task-project-ownership.

先纠正一个猜错的方向：**不是 `.gitignore` 把 codegraph 忽略了**。根 `.gitignore` 从头到尾没提过它。
规则在 CodeGraph 自己写的、而且**被提交了**的 `.codegraph/.gitignore` 里（`*` + `!.gitignore`）。
worktree 只检出被跟踪的文件，于是每个 worktree 都得到一个**只有 `.gitignore` 的空 `.codegraph/`**；
而 CodeGraph 的 `isInitialized()` 要目录和 `codegraph.db` **两样都在**——所以每次都判"未索引"。
换句话说，**删掉那条 ignore 规则没有用**：`codegraph.db` 会变成 untracked，一样不进 worktree。

让 worktree 有索引只有两条路：把 `codegraph.db` 提交进版控（79 MB 二进制、每次 reindex 一个 commit、
而且索引在提交那一刻就已经过期），或者**每个 worktree 建一次**。实测后者（`/tmp` 的一次性 worktree）：
18 文件 121 ms、349 文件 295 ms，进程总计 0.35 / 1.07 s，**不留 daemon**；索引写进已被忽略的
`.codegraph/`，worktree 的 `git status` 干净，并随 worktree 一起被删。取后者。

**而这件事不需要新机制，也跟 codegraph 无关。** 「启动钩子」本来就是 Worktree 的初始化入口——
它在 `worktree add` 之后、Executor 第一个回合之前执行，cwd 就是新 Worktree（见 `run/hooks.ts`
维护提示 2）。建索引、装依赖、预热缓存都该配在这里：命令 argv 在「命令」页签登记，钩子只按
**命令 ID** 引用它——那条"模型永远不能提供 argv"的不变量因此一个字都不用动。

所以本次只补了一个缺口：**启动钩子失败会阻塞整个 Run**。对"建索引"这类命令这是错的——它失败只是
慢一点，不该拦住 Run；而对"装依赖"这类命令阻塞又是对的。一个开关才能同时表达这两件事。

（顺带记一句：CodeGraph 那句 `indexing is the user's decision, do not run it yourself` 反对的是
**agent 自作主张**建索引——它源码里记着一次在 `$HOME` 上 init 把整机文件描述符耗尽的真实事故。
由项目所有者在设置里配置一次、Scheduler 在每个 Run 上机械执行，不是它反对的那件事。）

### Changed

- **`HookDefinition.blocking`**（`packages/domain/src/run/hooks.ts`）。缺省 `true` = 现状，
  不写这个键的项目行为与引入前逐字一致；配成 `false` 时失败仍写 journal 与 `HookExecution` 审计，
  但 Run 继续。**只对 `start` 有效**：cleanup 恒为不阻塞（Run 已经结束，没有"往下走"可言）。
- **Scheduler 的判定从 `status === "failed"` 改成 `blocked`**（`run/scheduler.ts`）。非阻塞失败
  写一条带 `blocking: false` 的 `HOOK_FAILED` 后继续——没有 BLOCKED 状态供人事后回看，这条 journal
  就是唯一现场；**并且不再补写 `HOOK_COMPLETED`**（那会让"失败"在会话里看起来像"成功"）。
- **校验拒绝而不是忽略**（`project/project.ts`）：`blocking` 必须是布尔，且配在 cleanup 上直接报错。
  静默吞掉它等于让"我明明配了阻塞"在 `finish()` 里无声失效。API schema 只给 `start` 声明这个字段，
  让多余的键在入口就被丢弃而不是走到领域层才 422。
- **设置页两处都加了「失败时阻塞 Run」**（对话框 `ProjectSettingsDialog.vue` 与整页
  `ProjectSettingsView.vue`），并把钩子一节说明改成"命令在「命令」页签登记（类别选生命周期），
  这里只按命令 ID 引用它"。原来的文案只说了执行时机，没说这是**初始化入口**——正是这一点让
  "worktree 里少点什么"这类需求找不到落点。
- 设计文档 `docs/spec/ai-software- pipeline-factory-design-v3.0.md` §4.3 派发步骤 7/8 补上
  `blocking: false` 这条分支。

### 验证

- 领域侧 3 条：`runStart` 在 `blocking: false` / 缺省 / `true` 三种取值下的 `blocked` 与
  `needsAttention`，以及 cleanup 配 `blocking: true` 也不阻塞；Scheduler 走非阻塞路径后
  `IN_PROGRESS` + 唯一一条 `HOOK_FAILED` + 没有 `HOOK_COMPLETED` + 审计里那次尝试照旧。
- 校验 2 条：`blocking` 非布尔、以及配在 cleanup 上。
- Web 4 条：命令 ID 读得回来、缺省勾着、取消勾选后载荷里是 `false`、库里存 `false` 时重开就是没勾上。
- API 1 条（HTTP 一跳，`server.test.ts`）：`blocking: false` 能存进库、不写这个键时库里**不出现**
  这个键、配在 `cleanup` 上在入口就被丢掉——zod 默认丢弃未知字段，这一跳漏了的表现是
  "取消了勾、保存了、值没变"且不报错，所以它值得一条用例。
- 浏览器实测（project-demo 的设置页）：钩子一节渲染出「失败时阻塞 Run」、缺省为勾选、勾选状态可来回
  切换、说明文案与「命令页签登记」那句都在位；控制台无报错。**只在页面上切了状态、没有保存**——
  这次要证明的是控件接线，不是往项目的真配置里写一条假命令。
- `pnpm verify`：domain 405 / api 112 / web 573 全绿，无新增值级循环依赖。


## 2026-10-07 — 设置对话框的页脚按钮根本不保存（"改成 Claude 了，重开还是 codex"）

用户报的：在项目设置里把**执行侧 Agent** 改成 Claude，确定后重进设置页还是 codex；
原话是"这个问题之前就出现过，改过几次了，还是同样的问题"。

查下来**不是保存失败**——域侧与 API 侧都是好的。实测（project4，用界面发的同一份 payload）：

- 直接 PATCH `settings.models.executor.backend = "claude-agent-sdk"` → 200，GET 读得回来；
- 走 `/projects/:id/settings` 那个**页面**改 + 点「保存项目配置」→ 存下来了，刷新还在；
- 走**对话框**改 + 点页脚那颗按钮 → **什么都没发生**。

根因在最后一条：那个对话框的页脚**只有一颗「完成」**，而真正的保存按钮在**滚动区底部**
（模型与工具那一节的「保存项目配置」）。用户改完 Agent 顺手点页脚那颗 = 关掉对话框，
改动一个字都不落库，而且**没有任何提示**。重开设置页看到还是旧值——于是"改了没生效"
可以无限重演，每次都一模一样。这也解释了为什么前几次"修"都不见效：前几次动的是模型随 Agent 切换
（那一半确实是好的），而没动"这一下点的是哪个按钮"。

### Changed

- 对话框自己记 `dirty`（载入时与保存成功后的表单快照对比）。
- **有改动时页脚那颗变成「保存并关闭」**：点它先 `save()`、成功才 `close()`；没改动时仍是「完成」
  （关掉一个没动过的表单不需要"保存"这个词）。
- 点遮罩 / Esc / 右上角 × 关窗时若有未保存改动，先问一句（`ElMessageBox.confirm`，
  「保存并关闭」/「放弃改动」）。
- 两条组件测试：一有改动页脚就变字；点它**先发 updateProject、再关**（`updates` 收到 `false`）。
  第二条就是这次报障的回归。

### 验证

浏览器实测（project4 的真实对话框）：载入时是「完成」→ 把执行侧 Agent 从 Claude 改成 Codex →
页脚立刻变「保存并关闭」→ 点它 → 配置版本 2 → 3、`backend` 变成 `codex-app-server`、模型自动跟到
`gpt-6-astra`、对话框关掉。随后再用同一个对话框把它改回 `claude-agent-sdk` / `claude-opus-5`
（版本 4）——**用户要的那份配置现在是真存下来了**。

`pnpm verify`：domain 403 / api 111 / web 569 全绿。

## 2026-10-07 — 推理行：拿不到就明说；正文上限从 240/600 放到 2000

起因是上一轮把话收回来之后问的一句"具体是什么消息，探索线程中我没看到有什么消息是看不到的"——
答案是：**没有哪条消息看不见，看不见的是推理那一行的正文**，而且它没正文时**看起来像本来就没话说**，
所以不容易被发现。这一段把它做成"看得出来"。

背景（查证过）：Codex 的 `reasoning` item 只有 `encrypted_content`，正文是加密的
（`openai/codex#38160` 至今 open；OpenClaw 撞的是同一面墙，`openclaw/openclaw#80039` 最后用
"进度/活动"代替、关掉了）。Claude 侧的 `thinking` 块**有**正文——实测同一个计划、同一天：
Claude 执行侧 5/5 条有正文，Codex 执行侧 0/5。

### Changed

- **推理正文上限分开处理**：探索侧投影 `240 → 2000`、执行侧写入 `boundedText(..., 600) → 2000`
  （`activityKind === "reasoning"` 时）。命令原文、文件路径那类摘要本来就短，仍是 240 / 600。
  执行侧那 600 是**写库时就截**——实测 Claude 侧五条推理里有两条正好停在 600 字，光改显示层补不回来。
- **没有正文时明说**，而且**分清两种情况**（判据 `isProviderControlled`）：
  - Provider 报了这次推理却没给可读正文 → 探索侧 `推理 · 未提供正文`，执行侧
    `Provider 未提供可读的推理正文。`。不明说的话，那一行就是一个光秃秃的「推理」，
    看着像这一轮根本没推理过——用户没法知道是"没有"还是"读不到"。
  - Factory 自己的 `MODEL_STARTED` 标记（"这一轮跑起来了"）→ 留空，不编句子。
  - 两种情况都**不摆折叠**。
- **推理正文过一遍脱敏**（`presentableText`，与工具结果同一个口）：模型可能把它读到的令牌、邮箱
  原样复述进推理里——正文从 240 放到 2000 之后尤其值得挡一道。两个推理行组件都走这个口，
  两条用例（复述出的凭据被抹掉；普通推理一个字不动）。
- 顺带修掉**上一轮我自己引入的一个死折叠**：探索侧的 `explorerActivityLine` 对空推理退回标签
  （`body = item.summary || label`），行组件于是渲染出一个 `<details>`，点开只有重复的「推理」两个字。
  现在 body 就是摘要本身，空就是空。

### 验证

- 单测：探索侧投影（推理 2000 / 命令 240）、执行侧写入（推理 2000 / 命令 600）、
  两种"没正文"的分支各一条。
- 真实数据（Codex 探索线程）：5 条推理行 → 0 条有正文、**3 条判为"来自 Provider"**（会显示未提供正文）、
  2 条是 Factory 标记（留空）。这个 3:2 就是这次改动要分出来的东西。
- **两条后端各跑了一次做对照**（同一个计划、同一天、同一个仓库，只换后端）：

  | 侧 | 后端 | 推理条目 | 有正文 |
  |---|---|---|---|
  | 执行 | Codex `gpt-5.6-luna` | 5 | **0** |
  | 执行 | Claude `claude-opus-5` | 5 | **5**（600 / 600 / 337 / 68 / 330 字） |
  | 探索 | Codex | 5 | **0** |
  | 探索 | Claude | 4 | **2**（其中一条 **1708 字**——旧的 240 上限只够开头） |

  也就是说"换个 Agent 推理行就空了"是**字面成立**的，不是错觉；而 2000 这个上限对真实的一段推理
  是够用的（1708 < 2000）。
- `pnpm verify`：domain 403 / api 111 / web 563 全绿。

## 2026-10-07 — 命令行的「显示结果」永远不出现

跑真实 Run 时抓到的第二个"数据在、界面没有"：同一个 Run 里两行**命令**都没有那个按钮，
而同一轮的 `fileChange` 有。

条目的形态是 `started` 先建出来的，而命令的 `output` / `exitCode` / `durationMs` 只在**结束**那条上
（`fileChange` 的 `changes` 不同，它在 started 上就带着了——所以只有命令中招）。PROVIDER_ACTIVITY
的合并那几行搬了 title / detail / status / 各种 id，唯独没搬结构化载荷，于是 journal 里躺着完整
stdout，界面上连那个按钮都不出现。

### Changed

- 合并时把这五个字段也带上（后来者优先，给空值不覆盖）。
- 两条回归用例，照真实 journal 的形状写：载荷跟着后到的那一条走；先到的那条已有载荷时不被空值抹掉。

### 验证

`run-97e581c2-d2f`（SmokeRun 项目）重投影后：结果按钮 **1 个 → 3 个**（两行命令各一个），
命令行展开是这次运行的真实 stdout（worktree 路径、`git status`、回读的 README、
`ls: package.json: No such file or directory`），meta 是「退出码 0 · 耗时 不足 1 秒」。

## 2026-10-07 — 推理正文一直没被读出来（Codex 的推理放在数组里）

跑真实 Run 时抓到的第一个：执行线程里的推理行**每一条都是空的**——不是"这一轮没推理"，
是文字根本没被读出来。

Codex 的 `reasoning` item 形状是 `{ content: string[], summary: string[] }`，而适配器那一行读的是
`getString(item, "command") ?? getString(item, "text")`——两个都是**字符串**字段，取数组只会得到
`undefined`。于是 `summary` 是 null，推理正文整段丢掉，界面上只剩一个「推理」标签。

影响面比看上去大：本机 900 多条推理行全是这个形状（Claude 侧同类问题上一轮已补——读
`thinking` 块——所以只有 Codex 这一半还漏着）。

### Changed

- `mapCodexEvent` 对 `reasoning` 走一条自己的分支：读 `summary[]` 拼成一段（**只取摘要**，
  `content[]` 是原始思维链，按本仓立场不展示），拿不到就给 `null` 而不是空串。
- 新增 `joinStrings()`：取字符串数组字段并拼接，空数组与全是空串都算"没有内容"。
- 两条用例：摘要被逐段读出来且用空行连成一段；只有 `content[]` 时不给内容。

### 验证与一个更正

`pnpm verify`：domain 401 / api 111 / web 561 全绿。

**更正（同日补）**：修复本身是对的，但它**不会让 Codex 的推理行长出正文**——当时的说法过头了。
新一轮 Run（`run-f23263e6-12c`）把 API 重启后再跑一次，10 条推理全是 `summary: null`。
翻 Codex 自己的 rollout 才看清：`reasoning` item 是

```json
{ "type": "reasoning", "id": "rs_…", "summary": [], "encrypted_content": "<2084 字符>" }
```

——`summary` 永远是空数组，正文在 `encrypted_content` 里（加密、不可读）。抽查最近 25 个会话、
**140 条推理 item，140 条 `summary: []`**，连 `content` 字段都没有。

所以：**Codex 侧的推理正文拿不到，不是本仓的 bug**。适配器读 `summary[]` 仍然是对的（哪个 build
开始给就自动有了），读不到就不编。界面上推理行没有正文、也不摆一个空折叠，是**如实**的。
Claude 侧的 `thinking` 块是真有文字的——那条路跑起来推理行会有正文。

## 2026-10-06 — 调研文档并入流程图文档；顺带按代码更正三处数字

`docs/Provider消息格式与消息大类调研.md` 的内容**并进** `docs/消息类型及事件状态机流程图.md`，
原文件删除。合并后全文按代码核了一遍，改掉三处对不上的地方。

### 合并

| 并入哪 | 内容 |
|---|---|
| **§0.4**（新增，短） | 这些消息类型是从哪来的——两个 Provider 各有多少种原生消息，以及"某个字段没读"的后果 |
| **§5 接入链路**（新增） | 四层图与每层做什么；两个 Provider 的原生消息清单（Codex 75 通知 / 18 `ThreadItem`；Claude 39 `SDKMessage`）；同一个事实两个名字的对照表；老数据的实测快照 |
| **§6 呈现参考**（新增） | OpenClaw 与 Hermes 的做法、两者的七条共识、以及本仓与它们逐项对照（含仍然缺的那一件） |
| **§0.1**（补） | 两个轴各自决定什么，以及这套分类能直接回答的三个设计问题 |
| **§7.1**（新增） | 还没做的只有一件：子代理 / 搜索 / 生图的**专属卡片**——本轮只做到分类与标签 |

原 §5/§6/§7（空转项 / V1 清点 / 落库粒度）顺延为 §7/§8/§9，交叉引用一并改。

### 按代码更正的三处

- **Claude `SDKMessage` 的分组数字错了**：原调研文档按 `type` 分成 5 + 26 + 8，取 `sdk.d.ts` 的
  联合重新归类是 **5 + 28 + 6**（`files_persisted` 与 `notification` 属于 `type: "system"`，
  被重复算进了"独立 type"那一组）。总数 39 不变。
- **Codex 通知的分组数字是估的**：改成按 schema 的实际枚举算，六组合计 54 + 其它 21 = **75**。
- **"④⑤ 默认不进正文"有一半是错的**：⑤ 里 `GATE`/`CONTEXT`/`TURN_STATUS`/`TASK_LIFECYCLE`
  在执行侧是**过程记录**——跑的时候原样显示，所属步骤跑完折进上方那一行；只有需要你决策的那几条
  （门禁拦截、恢复、方案卡）升级成常驻。① ② 与 ⑤ 的"决策项"进正文，**④ 一条都不进**。

另外把两处会随时间漂的实测数字（推理行数、门禁判定数）刷新到当前值，
并在 §5.4 明确标注这是**时点快照**——判据看的是"哪些 `itemType` 到达过"，不是具体条数。

## 2026-10-06 — 补上 Provider 数据层的三处硬缺口，消息按五类重排，呈现对齐 OpenClaw

调研（该调研文档当天稍后并入 `docs/消息类型及事件状态机流程图.md` §5–§6）查出两件事，这一轮把它们做完：数据层丢了
Provider 明明给了的东西；消息大类只分"用户 / 模型 / 运行时"三堆，不够用。

### 为什么做

三条可复核的证据：

- **全仓 `grep thinking` 在 domain/web 的 src 里 0 命中**。Claude 适配器只认 `assistant` 的
  `tool_use` 块，`thinking` 块整块被丢——换个 Agent，推理就整片消失（Codex 侧有，本机 868 条）。
- **`codexActivityKind` 的 needle 表里没有 `plan` 与 `contextCompaction`**，实测 58 条 + 3 条落进
  `other`：整篇规划文档与"上下文压缩发生在此处"在界面上是「未识别」。
- **`activityOutcome` 的失败词表缺 `declined`**，而它是 Codex `CommandExecutionStatus` 的四个取值
  之一——"Provider 说这条命令被拒了"因此显示成「状态未知」。

再加一条结构性的：Codex 有 18 种 `ThreadItem`、Claude 有 39 种 `SDKMessage`，而中立词表只有
8 个类别、其中 ④「Provider 说的」只占 3 个位置（2 个还是 `hidden`）。配额、重试、子任务、
钩子这些**每次都被丢弃**。

### 数据层

- **读 Claude 的 `thinking` 块**（`redacted_thinking` 留一条"内容不可读"的事实，不是静默丢掉）。
- **读 Codex 的 `agentMessage.phase`**：它只在 item 上、不在 `item/agentMessage/delta` 的载荷里，
  所以新增一条 `ModelEvent.text.phase` 单独送。它决定一段正文是"过程叙述"还是"最终回答"。
- **工具的载荷进 journal**：`arguments` / `result` / `aggregatedOutput` / `exitCode` / `durationMs`
  走新增的 `platform/provider-payload.ts`（上限与取值规则只此一处，两处消费方共用）。
- **`declined` 补进失败词表**；`plan` → `message`（回声）、`contextCompaction` → `compaction`；
  中立词表按 ②③④ 分组扩到 19 个类别，`isRuntimeKind` / `isRuntimeAlertKind` 是 ④ 的唯一判据。
  探索侧为此写的 `PLAN_ECHO_ITEM_TYPES` 特判随之删掉。

### 五类

`conversationTypes.ts` 新增 `MessageClass` 与 `SHARED_MESSAGE_CLASSES`（分类的**唯一定义处**），
两张呈现表从它派生：① 你说的 / ② 模型说的 / ③ 模型做的 / ④ Provider 说的 / ⑤ Factory 说的。
共用词表从 13 类涨到 23 类，合计 **53 种消息类型**（探索 25 + 执行 28）。

**④ 一律不进会话正文**，落点是头部状态卡新增的「Provider 运行事实」一节（常态不打扰），
异常时（配额 / 重试 / 权限被拒 / 告警，以及任何失败）把那张卡染成告警色并写出原因。

### 呈现（对齐 OpenClaw）

- **执行侧的过程记录折到结论上方**（`Worked for …` 同形），标题带用时与失败数；
  展开后是**真实的行**，不再是只写标题的清单。
- **进行中的一步不折**、**失败永远留在外面**——判据收在 `foldsIntoProcess()` 一处。
- **用时来自任务自己的生命周期事实**（`task-lifecycle` 的 `IN_PROGRESS` 与 `DONE`），
  不从消息时间戳估（OpenClaw 在这一点上很明确：没有时长就写 `Worked`）；拿不到就不显示那一格。
- 执行侧 `CONTEXT` 改成**分隔线**、推理改成**可折叠推理卡**；探索侧推理行同步改成同形的卡。
- 动作行可**展开看结果**（参数 / 返回 / 输出 / 退出码 / 耗时）。两处维护提示从"不得输出工具参数、
  成功结果"改成"**脱敏 + 截断后可见**"；脱敏与截断收敛到 `utils/sensitiveValue.ts` 一处
  （与 `platform/redaction.ts` 是一对镜像，有 parity 测试）。**模型的私有思维链仍然不展示。**
- 呈现表拆成两个轴：`kind`（形，7 种）+ `EXECUTION_MESSAGE_WEIGHTS`（重，`answer`/`process`/`hidden`）。
- 新增 `ExecutionMessageRow.vue`：同一条消息要在可见区与折叠区两处渲染，两处各写一份模板
  就是"折叠前后长得不一样"的成因。

### 实测

- 探索侧一条真线程：251 条活动里 227 条渲染，24 条隐藏（21 条回声 + **3 条 `PROVIDER_COMPACTION`**，
  后者此前显示成「未识别」）。
- 执行侧一个 41 条条目的 Run：折起 22 条过程记录，留 7 条可见（终答 + **5 条真失败的命令**，
  退出码 1 / 127）——失败确实没被折叠吃掉。

### 文档

`docs/消息类型及事件状态机流程图.md`：§0 新增「五类」「形与重两个轴」「④ 落在哪」三节，
三张清单表各加一列**分类**（并改用编号引用，①–⑤ 从此专指大类），§2.2 示例改成折叠组在上，
§4.4 共用词表补到 23 类，§5 补 13 行。
调研文档（现已并入流程图文档）的建议一节标注实施情况。

## 2026-10-06 — 调研：两个 Provider 的消息格式、消息大类的重新划分、呈现参考

纯调研，**无代码改动**。产出 `docs/Provider消息格式与消息大类调研.md`——**当天稍后并入 `docs/消息类型及事件状态机流程图.md` §5–§6，该文件已删除**。四条结论：

- **格式**：Codex App Server 是 75 条 JSON-RPC 通知 + 18 种 ThreadItem；Claude Agent SDK 是
  39 种 `SDKMessage`（外加一套 content block）。适配器各读 5 条，两边只有"正文增量 / 工具调用 /
  用量 / 回合结束"对得上。协议取自本机 `codex app-server generate-json-schema`（0.149.0）
  与 SDK 自带的 `sdk.d.ts`（0.3.283）。
- **实锤的丢失**：全仓 `grep thinking` **0 命中** —— Claude 的 `thinking` 块与 thinking delta
  从未被读，所以 **Claude 侧的推理在界面上不存在**（Codex 侧有，本机 868 条）。
  另：`plan` / `contextCompaction` 落进 `other`（实测 58 条 + 3 条）、
  Codex 的 `declined` 不在失败词表里（被拒的命令显示成"状态未知"）、
  `agentMessage.phase`（`commentary` / `final_answer`）没读。
  本机 19 条执行线程 **backend 全是 codex-app-server，零条 Claude**。
- **消息大类**：三分法（用户 / 模型 / 运行时）不够用——它把"模型说的"与"模型做的"合成一类
  （这两类在 OpenClaw 与 Hermes 里是两种排版），也把"Provider 的运行事实"与"Factory 自己的
  生命周期"合成一类（归属层不同）。改按 **① 你说的 / ② 模型说的 / ③ 模型做的 /
  ④ Provider 说的 / ⑤ Factory 说的** 五类，两个清单 33 个类型逐条归类。
  ④ 现在只有 3 个位置（2 个 hidden），而 Provider 有 18/39 种消息——这是最实的一块缺口。
- **接入网关**：**已经有了**且形状正确——`RoutingModelGateway`（路由，凭据唯一读取点）→
  各 Provider 适配器 → `provider-activity.ts`（中立词表）→ `AgentLoop` → SSE → 两张呈现表。
  缺的不是架构，是**中立词表的分辨率**。
- **呈现参考**：OpenClaw 与 Hermes 的共识七条（正文之外一律折、推理不进正文、压缩是分隔线、
  失败不被折叠吃掉、动作可展开看结果、声明这一轮到底做了什么、持久化对话只有少数角色）。
  我们的**排版档位已经基本一致**，差的是"折起来的能展开看""Provider 运行事实有地方放"
  "动作种类能分辨"。

## 2026-10-06 — 两条对话线：同一个"模型说的正文"、同一个"紧凑动作行"

### 为什么做

用户在页面上看到两处不一致，问是不是设计如此：

1. 执行线程的 `ASSISTANT_MESSAGE` 是 `card`（带头像、白底气泡），探索线程的是 `prose`（铺开的正文）；
2. 四类调用（`TOOL_CALL` / `MCP_CALL` / `COMMAND` / `FILE_CHANGE`）在探索侧叫 `tool`，在执行侧叫 `line`。

两处都**不是取舍，是漏改**：探索侧引入 `prose` 之后执行侧没跟着改（同一个"模型说的正文"两条线
长得不一样，而执行线程本质也是模型输出）；`tool` 与 `line` 是同一个"紧凑动作行"的两个名字。
用户的原话是"执行线程本质上也是大模型的输出，显示方式应该和探索线程差不多，只是执行线程多一个数据类型而已"。

### Changed

- `EXPLORER_DISPLAY_MODES`：`COMMAND` / `FILE_CHANGE` / `TOOL_CALL` / `MCP_CALL` 由 `tool` 改为 **`line`**；
  `EXPLORER_ROW_MODES` 与 `ExplorerDisplayMode` 联合类型同步（`tool` 这个取值从词表里消失），
  `ExplorerActivityRow.vue` 的 `mode` prop 由 `"tool" | …` 改为 `"line" | …`，
  `styles.css` 的 `.activity-tool` 改名 `.activity-line`。
- `EXECUTION_DISPLAY_MODES`：`ASSISTANT_MESSAGE` 与 `MODEL_REPORT` 由 `card` 改为 **`prose`**，
  `ExecutionDisplayMode` 联合类型加上 `prose`。
- `RunDetailView.vue`：头像条件改成 `item.kind !== 'user' && executionDisplayMode(item) !== 'prose'`——
  助手正文不再带头像；`styles.css` 里 `.execution-message-model .markdown-body` 的白底气泡
  （`max-width` / `padding` / `border` / `border-radius` / `background`）撤掉，改成与探索侧同形的铺开正文。

现在 §0 的两张表有 **5 个共用档位**（`card` / `text` / `prose` / `line` / `hidden`）**同名同义**，
各自独有四项（A：`reasoning` / `divider` / `gate` / `turn-status`；B：`folded`），两边**同一个概念只有一个名字**。

### 测试

`explorerPresentation.test.ts`、`executionStream.test.ts`、`RunDetailView.test.ts` 的断言随之更新
（后者新增一条：助手 `prose` 那一行不渲染头像）。`pnpm --filter @pipeline-factory/web test`：
72 个文件 / 532 条全绿，vue-tsc 干净。

浏览器实测 `run-419e7060-fef`：4 条助手行 `avatar: false`、`markdown-body` 计算样式
`border: 0px / background: rgba(0, 0, 0, 0)`（无气泡），其余 18 个头像照旧在 plan / activity 行上。

### 文档

`docs/消息类型及事件状态机流程图.md`：§0 的取值行与"共用档位表"重写（含为什么此前不一致的说明）、
§1.1 与 §2.1 两张清单表的呈现方式列、§2.2 示例注解、§5 补一行。

## 2026-10-05 — 切 Agent 时模型跟着换；项目执行线程里改 Agent 不生效的问题

### 为什么做

现象（用户报的）：在项目设置里把**执行侧 Agent** 从 Codex 改成 Claude 之后——

1. 重新打开设置，那一格显示的还是修改前的配置；
2. 去执行线程看，显示的也还是旧 agent 的信息；
3. 切 Agent 后，模型下拉里列的还是**上一个 agent 的模型**。

根因是同一个：**切 Agent 时不换模型**。

`modelCatalog.modelOptionsFor` 会把"当前模型值"并进候选（那是为了**打开设置页时**不弄丢手写模型名，
是一条有意的维护立场），但它同时带来一个后果：切到 Claude 后，下拉里列的是 Claude 的模型**加上**
上一个后端的 slug，而**选中项仍然是那个旧 slug**。用户不改模型直接保存，存下去的就是：

```json
{ "backend": "claude-agent-sdk", "model": "gpt-5.6-luna" }
```

这一组永远不会被自动修正——域里的 `migrateForeignFamilyModels` **刻意跳过显式写了 backend 的项目**
（它认为"那是用户有意为这个项目选的后端，slug 该由 Provider 侧报错暴露"）。于是：

- 设置页重开：Agent 是 Claude、模型那格还是 `gpt-5.6-luna` → 读起来就是"配置没改"；
- 执行线程：`snapshot.backend` 与 `defaultModel` 都读 Project 当前设置，显示的也还是旧模型；
- 真正跑起来时，执行侧第一个回合会在 Provider 侧失败，而错误离配置很远。

### Changed

- 新增 `modelCatalog.backendSwitchAdjustment`：**切换 Agent 之后，模型（必要时还有推理强度）该跟着怎么变**。
  设置的 Agent 下拉加了 `@change` 处理器（`ProjectSettingsDialog.vue` 与 `/settings` 的
  `ProjectSettingsView.vue` **两处都有同一份表单**，一起改）。判据：
  - 当前模型属于**另一个已知 kind** 的后端 → 换成新后端的候选模型；
  - 目录里查不到的名字（手写别名、cc-switch 这类代理的映射名）→ **不动**——那正是要被保护的东西；
  - 同 kind 内部换后端（两个 Claude 网关之间）→ 不动；
  - 新后端**不接受**的推理强度 → 清回"默认"（否则保存会被域直接拒绝：
    `validateRoleBackend` 抛 `reasoningEffort "ultra" is not supported by backend …`）。
- 新增 `modelCatalog.test.ts`（5 条），其中一条专门钉住 `modelOptionsFor` 的合并行为——
  它是上面那条调整的**前提**，删了会让"打开设置页不动手写名"这条保护消失。

实测（浏览器）：把执行侧 Agent 切成 `claude-agent-sdk` 后，执行侧模型的下拉变成
`claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5` 且**选中 `claude-opus-5`**（此前会停在 `gpt-5.6-luna`），
推理强度也换成 Claude 的 5 档（`minimal` / `ultra` 消失）。

### 文档

`docs/消息类型及事件状态机流程图.md` §2.3 C 补上"这条线用哪个模型、从哪来、为什么切 Agent 必须带上模型"，
§5 补一行。

## 2026-10-05 — 被中断的 Run 现在真的会被恢复；顺带修需求清单漏判的四个 Run 状态

### 为什么做

现象：新派发的方案一直停在「等待 free slot in this Project (2/2 in use)」，而需求清单上两条
几天前的需求始终显示「运行中」。

查下去是同一个根因——**启动恢复的判据反了**。`RecoveryCoordinator.recover()` 在组合根启动时跑一次，
它对一条 Run Loop 的处理条件此前是：

```ts
} else if (loop.state === "RUNNING" && (!loop.providerThreadId || !loop.providerTurnId)) {
  this.transition(loop, "RECOVERING", "PROVIDER_TURN_NOT_ACTIVE");
```

也就是说"**没记下会话标识**"才恢复。而记下标识恰恰是它**已经向 Provider 发起过回合**的证据，
不是"不用管"——于是每一个跑过一步就被中断的 Run 都落进 `else` 原样留着：

- 实测本机 **3 个 RUNNING 的 Run Loop，3/3 都记着 `providerThreadId` 与 `providerTurnId`**，一个都没被恢复；
- 它们连着 Run 一起停在 `IN_PROGRESS`，而 `IN_PROGRESS` 是**占并发槽位**的状态
  （`EXECUTION_SLOT_RUN_STATUSES` 只有 `STARTING` / `IN_PROGRESS` / `VERIFYING`，`RECOVERING` 不在其中）；
- 于是该项目的两个槽位被三天前的僵尸长期占满，后续派发永远排队，界面上那两条需求一直是「运行中」。

### Changed

- **启动那一刻仍停在 `RUNNING` 的 Run Loop 一律转 `RECOVERING`**（判据只留"还在不在跑"，
  去掉"有没有记下标识"）：进程刚起来，没有任何 Provider 回合是活的。`RECOVERING` 不占槽位，
  槽位立刻还回去，由人决定终止还是重来（Run Control 的「终止 Run」在 `RECOVERING` 上可用）。
  本机实测：重启后两个僵尸 Run `IN_PROGRESS → RECOVERING`，该项目占用的槽位 **2 → 0**。
- **需求清单的「任务状态」补上四个漏判的 Run 状态**：`READY_FOR_VERIFY`（待验证）、
  `NEEDS_PLAN_CHANGE` / `STALE`（待处理）、**`RECOVERING`（需要恢复）**。
  此前它们全掉进兜底，显示成"未知状态：RECOVERING"这种半截枚举值——而恢复流程把 Run
  交回给人时，那正是需求清单上唯一的现场证据。现在 `RunStatus` 的 11 个取值逐个接住（新增用例逐个钉住）。

### 测试

- 新增回归用例：**记着 provider 标识的 Run Loop 同样要恢复**（正是这次修的缺口），
  并断言 `RECOVERING` 不占槽位。
- 两条 API 用例的夹具改成"Loop 摆在 `createApp` 之后"——应用创建时会先跑一次启动恢复，
  那一刻仍停在 `RUNNING` 的 Loop 必然是僵尸，会被收成 `RECOVERING`。用例考的是读接口，不是恢复。

### 文档

`docs/消息类型及事件状态机流程图.md`：

- §2 的正文**不再把 `ExecutionThread.journal` 叫作 journal**，一律写「执行日志」——
  journal 是日记 / 日记账，而这东西是一台机器写的、只追加、按 `sequence` 排序的执行事实，
  日志（log）才是它的本义。（代码符号名不变；那是另一次纯重命名。）
- §2.3 C 补上启动恢复的判据与这次的修复（含实测数字），§5 补三行。



### 为什么做

`PlanStatus` 有 14 个取值，但"哪些转换合法"这件事**没有任何地方管**：22 个 `updatePlanStatus` 调用点
各自传一个 `Partial<CandidatePlan>`，函数只做"状态变了就追加一条 `plan.status.changed`"——
从 `BLOCKED` 直接跳回 `READY` 也只是安静地落库。

而"哪些转换存在"有**四份互不知道的副本**：四处散落的 `includes([...])` 白名单；
`planLifecycle.ts` 的 `normalizedLifecycleStatus`（`QUEUED→ENQUEUED`、`STARTING/RUNNING→IN_PROGRESS`、
`NEEDS_REVIEW→MERGE_READY` 三块补丁）；`recovery-coordinator.ts` 的 `RECONCILIABLE_PLAN_STATUSES`
+ `planStatusForRun`；前端 `explorerRequirementRows.ts` 的 `CONFIRMED_PLAN_STATUSES`。

**顺带查出三个幽灵状态**：`DESIGNED` / `PLANNED` / `QUEUED` 在 `PlanStatus` 里，但全仓没有任何写入点——
前两个只出现在几处守卫的白名单里，后者那两处 `status: "QUEUED"` 写的是 `PlanDispatchState`（另一个类型）。
**8 个库全查过，三个值一行数据都没有**（所谓"老数据里两种写法并存"在本机从未成立）。

### Changed

- **删掉三个幽灵状态**（`PlanStatus` 14 → 11），连同四处白名单引用、`sqlite-store` 启动修复那两条 SQL
  里的 `"QUEUED"`、以及 `planStatusLabel` 里的三条文案。`STARTING` 也从 `planStatusLabel` 删了——
  它是 `RunStatus`，不是 Plan 状态。
- **新增转换表**（`plan/status-transition.ts` 的 `canTransitionPlanStatus`），由 `updatePlanStatus`
  在**写入之前**强制：非法转换抛错，且抛错时状态没有被改动过（先判后写——写完再检查就晚了）。
  表的形状不是一条链：主路径 + `VERIFYING/MERGE_READY → IN_PROGRESS` 等恢复边 +
  **三个"从任意非终态进入"的入口**（`BLOCKED` / `READY` / `NEEDS_PLAN_CHANGE`）+
  `DRAFT → DISCARDED`。`MERGED` 不是终态（启动修复会把它拉回 `BLOCKED`），**真正不可逆的只有 `DISCARDED`**。
- **删掉三块归一化补丁**（web 的 `normalizedLifecycleStatus`、api 投影的同名函数）——它们的存在本身
  就是"表缺边"的证据：喂进来的值根本不该是 Plan 状态。补丁与表一收一放，两处同时消失。
- 新增 `plan/status-transition.test.ts`（6 条）：主路径逐步走通、三个入口从任意非终态可进、
  `DISCARDED` 只能从 `DRAFT` 进且出不去、跨级边不合法、**非法转换抛错且 store 里的状态没被动过**。

### 顺带修正的测试夹具

`m4-verify-merge.test.ts` 与 `api/projections/activity.test.ts` 里有几处"把 Plan 直接摆成终态"的夹具
（`DRAFT → MERGE_READY`、`DRAFT → MERGED`、`READY → MERGED`）。它们在真实流程里到不了——
`MERGE_READY → MERGED` 是进 `MERGED` 的唯一一条边——所以夹具改成走合法路径（新增一个小 helper），
并把"已合并的 Plan 不算今天执行完成"那条断言按新事实改写并注明理由。

`pnpm verify` 通过：381 + 111 + 526 个用例；本机库启动修复正常，两个对话框页面实测无异常。

## 2026-10-05 — 两个对话框的模板按"形态"拆成行组件，兜底不再静默

### 为什么做

两个对话框的时间线都是**一条长 `v-if / v-else-if` 链 + 一个 `v-else` 兜底**。这套写法的真实风险不是
"模板长"，而是**新形态会静默掉进兜底**：探索侧的 class 是 `` `activity-${mode}` `` **拼**出来的，
新增一种行型时 `styles.css` 里没有对应规则，那一行就变成一张**没有样式的裸卡**——不报错、不显眼。

### Changed

- **按形态拆行组件，不按消息类型拆**：探索侧 15 个类型映射到 8 种取值，其中 `tool` 一条承担
  命令 / 文件变更 / 工具调用 / MCP 调用四类；执行侧 18 个类型映射到 5 种形态，`activity`/`tool`
  承担其余 13 类。**按消息类型拆会得到四份逐字相同的同构组件**——渲染只跟形态走。
  - 探索侧：`ExplorerReasoningRow` / `ExplorerDividerRow` / `ExplorerActivityRow`（tool+gate+turn-status）+
    `ExplorerCandidatePlanCard`（从助手消息分支里抽出来）。
  - 执行侧：`ExecutionPlanCard`（自带展开态）/ `ExecutionModelRow` / `ExecutionUserRow` / `ExecutionActivityRow`。
- **两道护栏**：编译期用 `EXPLORER_ROW_MODES` + `EXPLORER_INLINE_MODES`（合起来必须正好是
  `ExplorerDisplayMode` 的全部取值）与 `EXECUTION_ROW_KINDS`（必须正好是 `ExecutionStreamItem["kind"]`），
  新增取值却没归到任何一边就**编译不过**；运行时各留一条 `.timeline-unknown-row` /
  `.execution-unknown-row` 兜底，漏网的取值**当场显示成一行红字**。
- 执行会话里的方案卡统计文案中文化（`tasks` / `acceptance criteria` / `verification commands` →
  个任务 / 条验收标准 / 条验证命令），与上一轮的"界面在说话就中文"一致。

`pnpm verify` 通过：375 + 111 + 526 个用例；浏览器实测探索侧 13 行 0 兜底、执行侧 22 行 0 兜底。

## 2026-10-05 — 线程侧的每一行都带同一个记号；Factory 的三类点名；收掉 INPUT_*

### 为什么做

状态词、小节标题、表单都中文化之后，探索时间线上还剩一个说不清的地方：**这条是从哪来的**。
助手消息有 `● Plan Explorer`，可推理行、门禁行、模型轮次行什么都没有——看不出它们是同一侧产生的。
而线程侧里其实有**两个产者**：模型（正文 / 推理 / 调用）与 **Factory**（终止门禁、上下文压缩、
轮次标记与调度占位），后者是工厂自己的机械记录，不是模型说的话。

### Changed

- **线程侧的每一行行首都是同一个蓝点**（`.thread-mark`）：正文、推理、调用、以及 Factory 的三类。
  用户那一侧仍然是靠右的 `›`。这样"是哪一侧"一眼可见，且不必在每行重复名字；
  `RUNNING` 时它闪动，表示这一轮还在跑。
- **Factory 自己的三类在标签里点名**：`Factory · 执行门禁` / `Factory · 上下文压缩` / `Factory · 模型轮次`。
  模型那一侧不点名——它就是这条线程本身。判据是"这是谁说/做的，还是 Factory 自己记的"。
- **`回合状态` 这个标签不准，一并改掉**：它实际是**模型轮次**（model step）结束的标记，
  读成"整个回合结束了"会与助手正文上的状态标签打架；执行侧同一件事写的就是「模型轮次」。
- **行首的图标盒去掉了**（✓ / ⚠ / ⓘ）：状态标签已经在说"已完成 / 失败 / 进行中"，图标是重复的记号。
  `activityIconKind` 随之删除。
- **收掉 `INPUT_REQUIRED` / `INPUT_RESOLVED`**：它们被整张输入卡取代，而且是**到达不了**——
  `agent-loop` 写下 `INPUT_REQUIRED` 步骤的**同一次调用**里就 emit 了 `agent.input.required`，
  `thread-service` 收到后立刻落一条 `input_requests` 行，所以只要步骤存在就必然有那张卡。
  实测本机库 29/29 个有这两类步骤的回合都有对应的输入请求行。类型、标签、呈现表、
  `buildExplorerTimeline` 的过滤集一并删掉（屏幕上一行不变）。

`pnpm verify` 通过：375 + 111 + 523 个用例；浏览器实测线程侧 11/11 行都带标记，无遗漏。

## 2026-10-05 — 删掉时间线顶部那张"需求 N"卡：需求描述本来就由用户消息承载

### 为什么做

探索对话的时间线顶部钉着一张卡：`需求 6` / `需求6：当我为现有项目添加任务的时候，提示所属项目不合法` /
`当我为现有项目添加任务的时候，提示所属项目不合法`。三行里有两行是**同一句话**
（标题由最新那条用户消息生成，见 `taskDisplayTitle`），而那句话又是对话里第一条用户消息。

于是同一个需求描述在一屏里出现三次，而卡片占的位置比它承载的信息多。需求序号在左侧需求清单里，
标题在抽屉标题里，都不缺。

### Changed

- 删除 `.active-plan-banner` 与它的样式；时间线现在直接从「探索活动」这天开始，接着就是你发出的那条消息。
- **不可见的滚动锚点 `.explorer-plan-anchor` 保留**：时间线的导航键（`data-nav-key="explorer-plan-…"`）
  与 `useTimelineScroll` 的激活态都靠它，删卡不等于删锚点。
- 需求一条消息都还没有时的空态照旧显示需求标题（`.timeline-empty`），那里没有重复的问题。

`pnpm verify` 通过：375 + 111 + 524 个用例；浏览器实测时间线首屏为「探索活动」+ 用户消息。

## 2026-10-05 — 助手消息也去掉气泡，与用户消息同一档重量

### 为什么做

用户消息改成「`›` + 纯文本」之后，助手消息还是"头像 + 气泡"的卡片：白底、边框、内边距。
但那层框不承载任何信息——正文本来就是一段 markdown，和用户那句话是同一种东西。

### Changed

- **`ASSISTANT_MESSAGE` 的呈现方式从 `card` 改成新的 `prose`**（`EXPLORER_DISPLAY_MODES`）：
  正文直接铺开，去掉了 `25px` 的头像圆圈与气泡的边框、白底、内边距。
- **meta 行留着**，只是从"气泡上方的独立一行"变成正文的题注：线程侧标记点（`●`，复用顶栏 logo 的类；跑动时闪动）+
  `Plan Explorer` + 状态标签 + 时间。理由是**助手消息是探索侧少数会变的那一类**
  （进行中 → 已完成 / 失败），"还在跑"得有地方说。
- **内嵌的候选方案卡照旧挂在这一块里**：`CANDIDATE_PLAN` 不是独立时间线条目，它挂载的宿主就是助手消息。
- 一并删掉随之失效的 CSS（`.message-card` / `.message-avatar` / `.agent-avatar` /
  `.assistant-message` / `.processing-message` 那一族，以及两个只被它们使用的 keyframes）。

### 为什么 `prose` 不并进 `text`

两者的**观感**是同一档（都是铺开的正文、都不套气泡），但助手消息要多带两样东西：
一行会变的状态、以及内嵌的方案卡。合成一个取值的话，渲染就得分叉回 `kind`，
"一个取值一种渲染"这条就不成立了。

`pnpm verify` 通过：375 + 111 + 524 个用例；浏览器实测助手消息正文无边框、透明底、靠左带 meta 行。

## 2026-10-05 — 表单字段名、按钮与提示消息中文化

### 为什么做

状态词与小节标题都中文化之后，界面上剩的英文只剩"界面在说话"的那一半：表单字段名与说明、
动作按钮、提示消息、空态与占位符。它们和刚改完的那些**长在同一屏里**，留着就是半张脸中文。

### Changed

- **表单字段名与说明**：`Worktree root` / `Max attempts` / `Default timeout (ms)` /
  `Environment allowlist` / `Git repository root` / `Save Project configuration` /
  `Registered commands run through ToolGateway with fixed argv, timeout and HookContext.` … →
  项目设置、新建项目、生命周期钩子三个表单全中文。
- **动作按钮**：`View full plan` / `Confirm plan` / `Enqueue plan` / `Discard plan` /
  `Pause loop` / `Resume loop` / `Cancel loop` / `View verification` / `Start run` /
  `Terminate run` / `Create review` / `Confirm merged` / `Retry` / `Back` / `Done` / `Cancel` /
  `Archive` / `Activate` / `Settings` / `Validate & Create` …
- **提示与确认消息**（`usePlanLifecycleActions.ts`）：`Plan discarded` /
  `Revision 3 discarded` / `Confirm revision failed` / `Discard plan` 确认框的三段文案 …
- **提示与错误**：`API service is reachable. Click to refresh.` / `Request failed: 500` /
  `Plan lifecycle is invalid: …`
- **空态与占位符**：`No include paths` / `No dependencies` / `Not selected` / `Not created` /
  `The execution conversation will appear here when the Run starts.` / `Actual target commit after manual merge` …
- **会话头部的实时流状态**：`Live` / `Reconnecting` / `Saved` → 实时 / 重连中 / 已保存；
  方案卡标题 `Plan received` → 已收到方案。
- 项目设置的分页标签（`General` / `Execution` / `Commands` / `Hooks` / `Models & Tools`）→
  常规 / 执行 / 命令 / 钩子 / 模型与工具。

### 仍然保留英文的只剩两类

产品名与专有名词（`PIPELINE FACTORY` / `Agent` / `Executor` / `Provider` / `Explorer` / `Plan` /
`Run` / `MCP` / `Worktree` / `Git`），以及命令、标签、路径这类**本来就是英文的值**
（`pnpm test` / `unit, types, docs` / `/Users/you/Project/repository`）。
判据是"这是界面在说话，还是数据本身长这样"——前者中文，后者原样。

`pnpm verify` 通过：375 + 111 + 524 个用例；Run 详情页、探索视图、项目列表页扫过一遍，
已无"界面在说话"的英文残留。

## 2026-10-05 — 小节标题不再是装饰性英文；顺手修一处 Markdown 表格

### 为什么做

状态词都中文化之后，它们**落点的那一行**还是 ASCII 大写：`RUN CONTEXT` / `PLAN PROGRESS` /
`AGENT LOOP` / `RUN CONTROL` / `REVIEW` / `EXECUTION STEPS` / `VERIFICATION RUN` / `REQUIREMENTS` /
`PROVIDER LOOP` / `EXPLORATION` / `LIFECYCLE HOOKS` / `ACTIVITY CENTER` / `THREAD ACTION` / `TASKS` …
契约区与遥测区的字段标签（`AUDIENCE` / `INCLUDE` / `EXCLUDE` / `OUT OF SCOPE` / `FROZEN PROJECT` /
`REPAIR LIMIT` / `BASE BRANCH` / `EXECUTION BRANCH` / `SOURCE COMMIT` / `TARGET` / `MODEL` /
`REASONING` / `TOKENS USED` / `EXECUTION TIME` / `WORKSPACE` / `THREAD` …）也一样。
大写只是排版，不该变成"这一行还没翻译"的记号——它们标的那一格值已经是中文了。

### Changed

- 上述小节标题与字段标签全部中文化（运行上下文 / 方案进度 / Agent 循环 / 运行控制 / 审阅与合并 /
  执行步骤 / 验证运行 / 必填项 / Provider 循环 / 探索进度 / 生命周期钩子 / 活动中心 / 线程操作 /
  任务 / 受众 / 包含 / 排除 / 范围外 / 冻结项目 / 修复上限 / 基线分支 / 执行分支 / 源提交 / 目标 /
  模型 / 推理 / 已用 token / 执行时长 / 工作区 / 线程 …）。品牌与专有名词保留：
  `PIPELINE FACTORY` / `Agent` / `Executor` / `Provider` / `Explorer` / `Plan` / `Run` / `MCP`。
- 带版本号的三处改成「第 n 版」：`CANDIDATE PLAN · REVISION 3` → 「候选方案 · 第 3 版」、
  `EXECUTION · REVISION n`、`PLAN INSPECTOR · REVISION n`；`MERGE REQUEST · id` → 「合并请求 · id」。
- 同一排卡片里的计数单位一并中文化：`Turns 1/40` → `回合 1/40`、`1/40 steps` → `1/40 步`、
  `Provider Turns 1 / 40 · Activities 2` → `Provider 回合 1 / 40 · 活动 2`。

### Fixed

- `docs/消息类型及事件状态机流程图.md` §2.1 的表格分隔行比表头多一列（上一轮加「侧」列时留下的），
  整张表因此渲染不出来。已改回 7 列，并加了一次全文件表格列数复核。

### 还没动（不是状态词，也没有"同一件事两个词"的问题）

表单字段名与说明句（`Worktree root` / `Max attempts` / `Save Project configuration` /
`Controls append facts to the ExecutionThread…`）与动作按钮
（`View full plan` / `Confirm plan` / `Pause loop` / `Cancel` / `Retry`）。

## 2026-10-05 — 另外两套状态机中文化，顺手收掉三份重复的状态文案

### 为什么做

上一条把 Plan 生命周期的状态词收成了一份，但界面上还剩两套英文状态机——它们与 Plan 状态
**同时出现在 Run 头部那一排卡片里**，只改一半就是"半张脸中文"：

- **Agent Loop**（`AGENT LOOP` 卡与探索侧头部）：`Running` / `Blocked` / `Completed` …
- **Run 审阅阶段**（`REVIEW` 卡）：`Not started` / `Verification pending` / `Ready for review` /
  `Awaiting merge` / `Merged` / `Needs attention`
- **Run 级活动标题**（`RUN ACTIVITY` / `RUN CONTEXT`）：`Run created` / `Hook completed` /
  `Context compacted` / `Execution gate` / `Verification` …

顺带发现另外三处同类问题：`ExplorerHeaderStatus` 把 `PAUSED` 硬编码成英文 `Paused` 覆盖掉传进来的
标签（同一个状态两处两个词）；`StatusVisual` 之外，Project 的 `Active` / `Archived` 在三个文件里
各写了一遍；`ExecutionHeaderStatus` 把 `PASSED` / `OPEN` 这样的**枚举值**直接渲染给用户看。

### Changed

- **Agent Loop 中文化**（`utils/agentLoopPresentation.ts`）：已创建 / 运行中 / 等待输入 / 已暂停 /
  需要恢复 / 已阻塞 / 已完成 / 失败 / 已取消 / 需要对账；门禁判定改成"方案已就绪 / 方案未完成 · … /
  已阻塞 · …"；收尾文案改成"已完成 N 个 Provider 回合"。
- **REVIEW 卡中文化**（`components/ExecutionHeaderStatus.vue`）：尚未开始 / 等待验证 / 进行中 /
  待人工审阅 / 等待合并 / 已合并 / 需要处理。标签与语气色同处算出（此前模板拿中文串当"配色键"去比，
  改一个词就会静默丢掉配色）。同卡内的裸枚举（`verification.status`、`mergeRequest.status`）、
  `PLAN PROGRESS` / `RUN CONTROL` 两个卡片的值与计数、以及任务行的
  `Waiting for N prerequisite(s)` / `Not reached yet` 一并中文化。
- **Run 级活动标题中文化**（`utils/executionStream.ts`）：Run 已创建 / 已跳过生命周期钩子 /
  生命周期钩子已完成 / 生命周期钩子失败 / 验证 / Run 已阻塞 / Run 已取消 / 上下文已压缩 / 执行门禁 /
  Executor 已启动 / 旧版 Plan 修订 / 执行已暂停 / 执行已恢复 / 执行活动。
- **执行报告末尾那行也中文化**（`已完成 N 个任务 · 改动 N 个文件`）。它是**被解析的**——
  `sameReportProgress` 靠匹配这行的两个数字把重复报告合并成一条，所以正则与措辞一起改，
  并在代码里写明这条耦合。
- **左侧栏实体状态收成一份**（新增 `utils/entityStatus.ts`）：Project 与其他两处共用同一句文案；
  ExplorerThread 拆分四档（此前 `WAITING_FOR_INPUT` 与 `COMPRESSED` 都显示 `Completed`，是一句错话）。
- `utils/executionTasks.ts` 的任务状态与验证结果中文化；`ExplorerHeaderStatus` 的
  `Plan ready` / `Exploring`、`RunDetailView` 的 `No loop` 兜底、项目卡片的
  `0 running` / `0 attention` / `No activity` 一并中文化。

### 实测

Run 详情页与项目列表页扫描一遍，已无英文状态词残留（只剩全大写的小节标题与计数单位，如 `1/40 steps`）。
`pnpm verify` 通过：375 + 111 + 524 个用例。

## 2026-10-05 — Plan 生命周期状态：文案收成一份，并把枚举值从界面上撤下来

### 为什么做

同一个 Plan 状态在界面上能有三四个词，因为它们来自**三份互不相干的表**：

| 状态 | 抽屉标题 | 候选方案卡 | 工作台 | 生命周期条 |
|---|---|---|---|---|
| `DRAFT` | `DRAFT`（**直接渲染枚举值**） | `Candidate` | `Draft` | `Candidate` |
| `READY` | `READY` | `Confirmed` | `Ready` | `Confirmed` |
| `MERGE_READY` | `MERGE_READY` | `Ready for review` | `Needs review` | `Ready for review` |
| `MERGED` | `MERGED` | `Merged` | `Merged` | **`Completed`** |

`PlanDetailContent.vue` 那句 `<el-tag>{{ plan.status }}</el-tag>` 是把**枚举值本身**端给用户看；
`utils/statusVisual.ts` 另有一张自己的文案表，与 `utils/planStatus.ts` 早已漂成两套词。

### Changed

- **Plan 状态文案中文化**（`utils/planStatus.ts`）：草稿 / 已丢弃 / 已设计 / 已规划 / 已确认 / 已入队 /
  已派发 / 排队中 / 启动中 / 执行中 / 验证中 / 待合并 / 已合并 / 已阻塞 / 需要改计划。
  补上此前缺的 `DESIGNED` / `PLANNED` 两项（它们此前回落成原字符串）。
- **`utils/statusVisual.ts` 不再自带 Plan 状态的文案**：它只留 PlanStatus **之外**的派发 / 等待 /
  运行态（`WAITING_*`、`NEEDS_CONFIGURATION`、`DISPATCHING` 等，一并中文化），Plan 状态一律从
  `planStatusLabel` 取——同一个状态一个词。`statusVisual.test.ts` 断言源文件里不许再出现同名条目。
- **抽屉标题不再渲染枚举值**：`{{ plan.status }}` → `planStatusLabel(plan.status)`；它的语气色也改成
  `statusVisualFor(...).tone`，去掉那份自己写的三元判断。
- `planLifecycle.ts` 的 `NEEDS_CONFIGURATION`、以及两处把状态名写进句子的提示文案一并中文化。

### 还没动的（另一套状态机，不在本轮范围）

Run 详情头的 REVIEW 卡（`Not started` / `Verification pending` / `Ready for review` / `Awaiting merge` …）、
Agent Loop 状态（`Running` / `Blocked` / `Completed` …）、Run 级活动标题
（`Run created` / `Hook completed` / `Verification`）。

## 2026-10-04 — 两条对话线共用一份消息词表；一次调用只占一行

### 为什么做

清点探索线程（对话框 A）与执行线程（对话框 B）的类型表时发现三层不一致：

1. **名字**：同一个概念两边不同名——"你发的消息"在 A 叫 `USER_MESSAGE`、在 B 叫 `guidance`；
   同一次工具调用，A 按生命周期拆成 `TOOL_STARTED` / `TOOL_COMPLETED` / `TOOL_DENIED` 三条，B 合成一个 `tool`。
2. **大小写**：A 的类型值全大写（它直接来自领域枚举），B 的 17 个值是手写的小写串。
3. **语言**：同一组状态，A 写 `Running` / `Read only` / `Failed`，B 写 `进行中` / `已完成` / `失败`。

再加上三处具体的呈现缺陷，依据都是本机运行库的实测：

- **一次调用在 A 占两行**：`TOOL_REQUESTED → TOOL_COMPLETED` 是同一件事的两端，B 按 `callId` 合并成一条，
  A 没有。顺带发现 `TOOL_FAILED` / `TOOL_NEEDS_RECONCILIATION` 两个步骤类型在 A **连一行都没有**
  （投影里没有分支，静默掉了）——"工具失败了"在探索时间线上看不见。
- **Provider 回声冒充工具行**：A 只按 `itemType` 里有没有 `mcp` / `reason` 三个子串判类，
  于是 `userMessage`（Provider 把你那句话回显一次）与 `plan`（整篇规划文档）都落进了
  "Tool started / Tool completed"——实测 112 个与 29 个。
- **门禁刷屏**：90 条 `GATE_CHECKED` 里 `complete` 51、`continue` 39、**`blocked` 0**，每轮都写一行"一切正常"。

### Changed

- **共用词表**（新增 `apps/web/src/utils/conversationTypes.ts`）：13 类共用项在两条线上同名、同中文文案，
  两张呈现表都必须为每一项给出一行——`type-parity.test.ts` 编译期拦、`conversationTypes.test.ts` 运行时拦。
  命名一律大写下划线；执行侧只此一份的 5 类（`PLAN` / `MODEL_REPORT` / `TASK_LIFECYCLE` /
  `RUN_ACTIVITY` / `RECOVERY`）与探索侧独有的 4 类逐条登记了理由。
- **一次调用只产出一条条目**（`explorer-activity.ts`）：按身份键（Loop 步骤的 `callId` / Provider 活动的
  `itemId`）合成一条，后到的事件覆盖状态与正文——与执行侧 `projectExecutionJournal` 同一条规则。
  名字留住开始那一条的、原因覆盖成结束那一条的；回合结束后仍没有结束事件的标成 `状态未知`，
  不再一直显示"进行中"。推理与 Provider 回声同样按身份合并。
- **Provider 活动改按中立类别归类**（复用 `model/provider-activity.ts`）：`command` / `file-change` /
  `tool` / `mcp` 各成一类，`message` / `session` 落 `hidden`，`plan` 回声不再产出，
  真正认不出来的仍以「未识别」一行保留（标签直接摆原生 `itemType`）。
- **门禁只在 `blocked` 时成行**；`TOOL_FAILED` / `TOOL_NEEDS_RECONCILIATION` 补上分支。
- **用户消息改成纯文本**：三个界面统一成 Codex 那种「`› + 原文`」，去掉头像、卡片与展开按钮，
  仍然靠右。`messageSummary.ts` 随之删除。
- **状态文案与行首标签中文化**，与执行侧、项目执行线程、需求清单同一套词。
- **修一个会静默丢消息的判据**：`RunDetailView` 的 `visibleItems` 此前写死"属于 `card` 或 `line`"，
  新增的 `text` 会让那类消息**从会话里消失**——改成"除折叠与不渲染之外"。

实测同一条需求的渲染行数 **432 → 229**，本机 27 个需求合计 **1,274 → 653**：少掉的不是信息，
是同一次事实的第二行、每一轮的"一切正常"，以及内容在别处已经有的回声。
`docs/消息类型及事件状态机流程图.md` 按改后的代码逐节核过（含新增的 §4.4「两条线共用的词表」）。

## 2026-10-03 — journal：条目不再按 40ms 一片，也不再每次重写整体快照

### 为什么做

执行会话页看起来像"一行两个字"。查下去发现根因不在渲染：`agent-loop` 的正文刷新是
**160 字符阈值或 40ms 定时器**，低速率输出下定时器主导——实测本机库 3,933 条 `MODEL_OUTPUT`
的文本长度**中位数是 2 个字符**，66% 不超过 3 个（单个 Run 最多 1,536 条正文条目）。
它们还逐条镜像成 `run.executor.event` 领域事件，于是同一份碎片在库里存了两遍（15,458 条）。

顺带查清了两件事：前端的 `projectExecutionJournal` **已经在**按"模型轮次 + provider 条目 id"
把连续正文合并成一条消息（1,647 条 journal → 94 条消息、17 条正文、平均 52 字），
所以页面上并不缺合并逻辑；缺的是**写侧的粒度**。而 `execution_threads.journal_json`
（journal 的整体快照）既贵又错：写侧每次 `saveExecutionThread` 都要序列化整份（实测最大 579 KB），
它却只在那一处更新、`appendExecutionJournal` 不碰它——实测 18 个线程里 **13 个的快照与执行日志表
已经对不上**。

### Changed

- **正文按"连续段"落一条**（`executor-agent.ts`）：攒进内存，遇到下一条非正文条目或 Run 终止时写一条。
  分段依据与前端投影**逐字相同**，所以条目顺序、分组、页面呈现都不变，只是条目数少一两个数量级。
- **`execution_threads.journal_json` 整体快照删除**：启动时先把"只有快照、表里没有行"的历史线程
  搬进 `execution_journal`，再 `DROP COLUMN`。`backfillLegacyVerificationRuns` 一并从快照改读表
  （拿一份已经过期的副本当修复依据，会漏掉最近的条目）。
- **`appendExecutionJournal` 的归属校验**从 `getExecutionThread`（读整条日志并解析）改成一次主键查询。
  它逐条追加调用，此前整体是 O(n²)。

### 随后一并处理

- **`agent_loop_steps` 同一处碎片也收掉了**：模式一样（段内照旧实时派发 `agent.model.text.delta`，
  只在段结束时落一条步骤），封段边界与读取方 `explorer-activity` 合并卡片的边界逐字相同。
  改这里的前提是 `routes/explorers.ts` 里那句"没有等价性测试不要改这里"——
  已补上等价性用例（同一段正文按 3 条 / 1 条两种形态投影，结果逐字段相同）与引擎级用例。
- **历史碎片合并成段**（经确认的一次性历史改写）：启动时把库里已有的连续碎片按同一规则并成段。
  实测本机：`agent_loop_steps` 60,161 → 2,963 行、`execution_journal` 4,547 → 739 行、`domain_events` 133,464 → 90,031 行，
  而同一个 Run 的执行会话投影逐条完全一致（94 条消息、类型直方图、正文长度分布全部与合并前相同）。
- **`domain_events` 里带序号的两簇也合并成段了**：`agent.step.model_text_delta` 40,245 → 221 行、
  `run.executor.event` 的 MODEL_OUTPUT（带 `payload.sequence` 的）3,529 → 120 行。
  这里踩到一个坑值得记下来：**事件流是交错的**——每 40ms 一次刷新会同时写步骤镜像与那条遗留重复
  （`agent.model.text.delta`），两者把对方的序号隔开，所以"事件序号相邻"这个在两张表上成立的判据
  在事件表上**匹配数是 0**（第一版跑了个空）。改成用载荷里的**序号**（步骤号 / journal 号）才对得上。
- **剩下两簇改动为删**：`agent.model.text.delta`（35,961 行）与 `explorer.turn.text.delta`（35,007 行）
  不能合并——合并会把正文挪到别的活动事件之后、打乱时序——只能**确认副本存在后删除**，判据逐个聚合验证、不抽样：
  前者比对该 loop 的步骤行正文总量（50 个 loop 全部满足），后者要求剥掉计划协议块后逐字等于
  `explorer_turns.content`（33 个回合里 **3 个不满足，全部保留**：两个被取消的回合——content 被替换成
  "本轮已取消"，模型原始输出只在这批事件里——与一个 content 被后续覆盖的回合）。
  为此把 `stripPlanProtocol` 挪到 `plan/completion.ts` 共用：删除的唯一判据不能与展示投影各写一份。
- **实测总账**：`domain_events` 133,464 → 19,549 行、19.72 → 3.61 MB；库文件 81.58 MB → 12.20 MB。

## 2026-10-03 — 删掉 V1 扁平合同镜像（Plan 契约只剩一份）

### 为什么做

`ResolvedPlanContract` 之外还并存着一份 V1 扁平合同（`CandidatePlan.contract`）。它不是"另一种契约"，
而是已解析契约的**有损投影**：`dependsOnPlanIds` 恒填 `[]`、`priority` 恒为 0。字段名却更短，
于是界面与调度里到处是"优先读 `resolvedContract`、缺它才回退到 `contract`"的读点——
两份形状迟早对不上，而 `planQueryProjectionFor` 曾是这份镜像最后一个**无条件**读者。

库里的数据支持直接删：本机 3 个库、35 份候选计划，`schemaVersion = 1` 的 **0 份**，
没有 `generatedSpec` 的也是 **0 份**——也就是说这份镜像在库里**完全可推导**，删列不丢事实。
（清点见 `docs/消息类型及事件状态机流程图.md` 的 §6。）

### Changed

**1. 契约只剩 `resolvedContract`（domain）**

- 删 `PlanContract` / `PlanTask` 类型、`executionContractFromResolved`（投影函数）、
  `defaultPlanContract`（兜底合同）、`validatePlanContract`（V1 结构校验），以及三处
  `contract.schemaVersion === 1` 只读闸门——没有可表达的 V1 形状，闸门成了空转。
- `CandidatePlan` / `PlanRevision` / `PlanRevisionDraft` / `ChangeProposal` 的 `contract` 改成
  必填的 `resolvedContract`；`PlanArtifact` 的 `contract` 入口换成 `resolvedContract`。
- `createCandidatePlan` 现在**必须**拿到 `generatedSpec` 或 `resolvedContract`，两者都没有直接拒绝；
  落盘、审计哈希、预检全部改读 `resolvedContract`。

**2. 计划依赖与自然语言先决条件分开（这是删镜像暴露出的真问题）**

`dependsOnPlanIds` 与 `dependencies` 原先共用镜像的同一个字段，而 `resolvePlanContract` 往
`dependencies` 里填的是模型写的**自然语言先决条件**（"需要 Node.js 22"）。镜像一删，两条读点
（`validatePlanDependencies`、`dispatch-coordinator.evaluateWait`）就会把先决条件当成 Plan id，
去等一个不存在的 Plan——表现为 `BLOCKED / depends on unknown plan 需要 Node.js 22`。

处置：`ResolvedPlanContract` 新增 Factory-owned 的 `dependsOnPlanIds`（解析时恒为 `[]`，
只有 `PlanService.setDependencies` 能写），`dependencies` 保持原义。

**3. 存储与 API**

- 四张表的 `contract_json` 列删掉，老库启动时 `DROP COLUMN`；`pruneLegacyV1Plans` 随之删除
  （它靠 `json_extract(contract_json, ...)` 找行，列一没就没有识别依据）。
- 读契约失败**抛错**而不是回落到一个（看着像契约、其实什么都没有的）空形状：
  空任务清单会让执行者开工、空命令集会让验证静默判 `SKIPPED`。
- 老库回填 `resolvedContract.dependsOnPlanIds`：字段是新加的必填项，老行里没有这个键，
  读点虽然都写了 `?? []`，但让数据对得上比要求每个新读点都记得兜底可靠。
- `change_proposals` 补上 `resolved_contract_json` 列。提案的契约此前存在 `contract_json` 里，
  改列时漏了建表——**内存实现不经过 SQL 列，所有用例照样绿**，只有真开一个 SQLite 库才暴露。
  已补一条 SQLite 往返用例。
- API：workbench 投影与 change-proposal 请求体暴露 `resolvedContract`；`Plan.contract` 响应字段消失。
  `PlanIndexRow.priority` 保留但恒为 0（响应形状与 `sort=priority` 还引用它），dispatch 的优先级排序删掉。

**4. Web：从三层回落到两层**

`PlanDetailContent` / `RunDetailView` / `planContract.ts` / `explorerRequirementRows` 里所有
`plan.contract` 的读取与回落都删掉，只剩 `resolvedContract → generatedSpec`。

**5. 测试夹具**

不再有兜底合同之后，造一个 Plan 必须显式给契约。新增跨包夹具 `plan/plan-fixture.ts`
（domain 导出、api 与 web 共用），每个包各写一份必然与领域形状漂移。

### 验证

- `pnpm verify`：986 个用例全绿（domain 366 / api 111 / web 509），typecheck 全过，无新增值级环。
- 真库升级：重启服务后本机运行库 21 份 Plan / 21 个 Revision / 6 份草稿全部读得出契约，
  四列成功丢弃，`dependsOnPlanIds` 回填完成；`/workbench`、`/plans/:id`、Plan Center 查询
  返回的都是 `resolvedContract`，没有 `contract` 字段。

## 2026-10-01（其十五）— Plan 结构对齐 Claude Code：现状、风险、文件变更真正传给 Executor

### 为什么做

对比 Claude Code 的 Plan 后发现，项目当前的 Plan **有目标、有任务标题，但没有"为什么这么做、具体动哪些文件"**。
更严重的是：Executor 的 system prompt 嵌的是 `revision.contract` 的 V1 投影，V2 的 `design` 整节在
`executionContractFromResolvedV2`（`plan/service.ts`）里被丢掉了——`technicalConstraints`、
`dataSecurity`、`failureHandling`，以及 `dependencies` 并入的技术约束，**从未到达执行者**。

这与真实阻塞原因直接对上：`package.json remains missing in expected project directory` 反复出现，
而 Plan 的 dependencies 里明明写着「需要在 code/ 目录使用仓库现有 package.json 和锁文件安装依赖」。
执行者没见过这句话，只能对着一个任务标题重新探索。

### Changed

**1. V2 Plan 增加三个结构字段（不升 schemaVersion）**

- `objective.context`：现状与调查发现（Explorer 在仓库里看到了什么、依据是什么）。
- `design.risks`：风险与回滚。
- `tasks[].changes[]`：这一步要动哪些文件、怎么动；每项包含 `path`、`action`（`create` /
  `modify` / `delete`）、`detail`。

三个字段在底层校验器里**保持可选**，确保历史 V2 spec 能继续被
`reviseConfiguration` / `setVerificationSuites` 重新解析；但新 Explorer 产物在 `assessPlanCompletion`
门禁里必须提供这三类细节，缺失会生成逐字段诊断并自动续探索补齐。这样兼顾了新计划质量与旧数据兼容。

`tasks[].changes[].path` 复用已有 `safePaths`，不另写路径安全规则；非法 action、空 detail、空数组都会
被具体指出。

**2. Executor 拿到完整的 V2 精选视图**

有 `resolvedContract` 的 V2 Revision 现在给 Executor 的 system prompt 包含：
`objective`、`design`、`scope`、`tasks`（含 changes）、`dependencies`、`conflicts`、产物和验证信息。
不再把 `repository` 哈希等无关元数据塞进提示词；历史 V1 Revision 仍原样使用旧 contract。

**3. Plan 文档与 Plan 详情抽屉同步展示**

- 落盘 Markdown 新增「现状与发现」「风险与回滚」，每个实施步骤列出动作、路径和 detail。
- Plan 详情抽屉新增同样的现状、风险、文件变更展示：动作以新建 / 修改 / 删除标签区分，
  不再只有任务标题。
- Explorer requirements manifest 与 web fallback 镜像同步更新，明确三项为新产物必填。

### 验证

- `pnpm verify` 全绿：domain **362** / api **111** / web **497**，无新增 value 级环。
- 向后兼容：历史 V2 spec 没有新字段仍能 parse / resolve；新门禁会明确指出
  `objective.context`、`design.risks`、`tasks[n].changes` 的缺失。
- Executor 测试断言 system prompt 真包含调查上下文、风险、dependencies、changes 路径与 detail，
  防止新字段只停留在页面/数据库而没有真正进入执行。
- Plan archive 与 PlanDetailContent 测试覆盖新字段渲染。

## 2026-10-01（其十四）— 执行会话：消息类型清单化、说人话、修掉漏进正文的标记

### 为什么做

用户报"执行线程的消息我看不懂"，并给了截图。把截图里那几条逐条翻译之后，问题分成三类，
都不是"结构错了"：

- **说的是 Provider 的机械话**：「命令 · 已完成 · **Provider reported success**」——跑的是什么、为什么跑，一个字没说。
- **标题只写角色名**：模型正文的卡片标题是「**Executor**」，那不是内容。
- **同一件事说了两遍**：「任务 开始 · 新增项目级任务创建接口…」与它上方步骤头说的是同一件事。

用户还要求"把大模型的消息类型列个清单，我来决定每种怎么呈现"。清单按真实数据做，
结论落成**一张呈现方式表**（见下）。

### Changed

**1. 消息类型清单 → 一张呈现方式表**（`apps/web/src/utils/executionStream.ts`）

新增 `ExecutionMessageType`（17 类）与 `EXECUTION_DISPLAY_MODES`：每类映射到
`card` / `line` / `folded` / `hidden` 四档。**视图只问 `executionDisplayMode(item)`**，
不再自己判断——此前判断散在三处：按 `kind` 分支、按 `outcome` 猜、按标题字符串相等
（`title === "Executor report"`）。改呈现方式从此只改这张表。

实际落到界面上：推理与门禁 → 折叠（`N 条过程记录`）；Provider 回显、会话重建、
上下文压缩、循环启动 → 不显示；命令 / 文件变更 / 工具 / 步骤 → 一行；正文与结论 → 卡片。
**异常类（阻塞、取消、恢复、你的插话）无论呈现方式怎么调都是卡片。**

**2. 说人话：动作卡片说清"做的是什么"**

- **journal 记下 `summary`**（`executor-agent.ts`）：命令原文、被改动的文件路径都在里面。
  不记它，卡片只能写「命令 · Provider reported success」。这是可读性的关键一条，
  老事件没有这个字段，仍退回类别标签（不编内容）。
- 文案中文化：`Provider reported success` → 「执行成功」、`Provider activity started` → 「执行中」、
  失败原因 `Provider command exited with code 1` → 「命令退出码 1」（**只在显示层翻译**，
  journal 保留原文；认不出来的形状原样显示，不猜意思）。
- 模型正文标题 `Executor` → 「执行说明」；完成报告 `Executor report` → 「执行报告」；
  工具卡片 `Provider tool call` → 「工具调用」。标题里的长命令截断到 80 字。

**3. 修掉漏进正文的任务标记**（实见缺陷）

截图里有一张卡片的正文第一行是 `actory-task-progress>{"taskId":"task-1","state":"started"}`——
任务标记跨了两条事件，上一条的尾巴被"结尾未闭合"规则削掉，剩下的一半落在下一条的**开头**，
而清理只处理结尾。现在按"开头这一截是标记的任意一段后缀"识别并削掉，两种后续形态都覆盖：
后面接标记的 JSON 载荷（连闭合标记一起去掉）、后面直接接正文（只削尾巴）。
正文被清空时**不产生卡片**——只剩标题与时间的空卡片是纯噪音。

### 未做

- **方案结构（第 3 件）另立计划**：参考 Claude Code 的 plan 结构给契约补
  `objective.context` / `tasks[].changes` / `design.risks`，属于契约变更，不混在本轮。

### 验证

- `pnpm verify` 全绿：domain **358** / api **111** / web **496**，无新增值级环。
- 新增/更新用例：`executionStream.test.ts`（呈现方式表抽查、"异常永远是卡片"、"认不出来的活动标成未识别"、
  `summary` 决定标题、老事件退回类别标签、长命令截断、失败原因翻译、**跨事件切断的标记两种形态**、
  空正文不产生卡片、普通正文不被误伤）；`executor-agent.test.ts`（**journal 确实记下 summary**）；
  `RunDetailView.test.ts`（视图只问呈现方式表，`isActivityNoise` 已移除）。
- 浏览器实测同一个 Run：卡片从 16 张降到 10 张，`Provider reported success` 与
  `Provider activity started` 均已消失，正文里不再有标记残留，折叠区显示「9 条过程记录」。
- ⚠️ **`summary` 只对新事件生效**：这次实测里命令卡还没显示命令原文（那些事件写在改动之前）。
  新 Run 才会带上。

## 2026-10-01（其十三）— 「Confirm Plan 慢」：先量化，再收掉两处潜伏阻塞

### 为什么做

报障是"确认 Plan 要等很久"，并明确是**请求本身慢**（点下去要等），不是"确认后等执行开始"。

按"先量不猜"逐段实测（project4 / 本机现状），结果是**复现不出来**：确认→Run 创建 10–20ms
（真实时间戳）、Run 创建→执行循环建好 ~60ms、刷新端点 0.6–55ms、Plan 详情 1.6–32ms、
整页 72ms（21 个请求共 290ms）、预检的 `git status -uall` 0–10ms、`git worktree add` 39ms。
`domain_events` 已 13.7 万行但索引齐备，`candidate_plans` 只 20 行。

**没有证据就不做性能改动**——那只会改坏现在正常的东西。所以这一轮交付的是两件**由构造证明、
不依赖复现**的修复，加一件让下次不再靠猜的工具。

### Changed

**1. `wake()` 不再同步跑**别的** Run 的验证**（`run/dispatch-coordinator.ts`）

`confirmAndDispatch` 末尾 `await this.wake()`，而 `wake()` 对**每一个 Run** 调 `syncRun`——其中
`READY_FOR_VERIFY` 的 Run 会当场执行该项目的验证命令（build/test，**分钟级**），且是 `await` 的。
于是"确认一个 Plan"会一直等到**另一个 Run 的验证跑完**才返回。改成后台跑
（`runVerification`，并发仍由 `verifyingRuns` 保证）：状态在分离前已写成 `VERIFYING` 并由 SSE
推给前端，结果由后台回写。

project4 没登记任何验证命令，所以这条**现在触发不到**——但真实项目里一定会踩到。

**2. 预检从"每个路径一次进程"改成"一次批量查询"**（`plan/preflight.ts`）

原来对每个 include 路径 spawn 一次 `git cat-file -e`（每次 5–10ms，全部卡在事件循环上）；
现在一次 `git cat-file --batch-check` 问完所有路径（产物路径一并问，省掉第二次 spawn）。
顺带补一条安全边界：**批量查询本身失败时不阻断**，只出一句"本次未做路径预检"——
一次失败的 git 调用不该让每个 Plan 都被判成非法。

**3. 慢请求日志**（`apps/api/src/server.ts`）

`onResponse` 钩子：超过 **1 秒**的请求往 `.runtime/api.log` 写一行
`[slow] METHOD URL <ms> <status>`，排除 SSE（天然长命，会刷屏）。
这是本轮**最关键**的产出：既然复现不出，就让真实场景自己留下痕迹——
下次报"慢"时能直接拿到路径与耗时，而不是继续猜。

### 未做（等证据）

- **`performWake()` 的全库线性扫描没有动。** 它 `listDispatchStates()` + `listPlans()`（逐行
  JSON.parse）+ 遍历所有 Run 调 `syncRun` + 遍历所有 `DISPATCHED` 计划，而 `handleEvent` 对每个
  非流式事件都触发一次。**这是整条链上唯一会随使用量变慢的环节**（18 个 Run 无感，几百个 Run 时
  会到秒级），但它落在调度热路径上，且**没有数据证明它就是这次的慢**。列入候补，等日志说话。
- `PlanService.confirm` 里 `projects.snapshot()` 被取两次，可合并——属清理，不是性能关键。
- UI 侧"同一批 15+ 请求连发三遍"未动：单个都是毫秒级，且没有证据说它是原因。

### 验证

- `pnpm verify` 全绿：domain **357** / api **111** / web **485**，无新增值级环。
- 新增/更新用例：`dispatch-coordinator.test.ts` 增一条
  「**不等待**验证跑完就返回」——把 `verify` 挂在 gate 上，断言 `wake()` 仍然返回且状态是
  `VERIFYING`（旧实现下它会一直等，测试超时）。原有那条"自动验证 READY_FOR_VERIFY"改成
  轮询等状态落定，不再靠微任务时序侥幸通过。
- `plan/preflight.test.ts` 的假 git 改成如实模拟 `cat-file --batch-check`（按 stdin 行、
  顺序对应、` missing` 结尾），并新增「多路径只 spawn 一次」「批量失败不阻断」两条。

## 2026-10-01（其十二）— 「结构化计划校验失败」是解析器的误报，不是模型的问题

### 为什么做

用户看到探索时间线上写着 **"结构化计划校验失败，请继续完善。"**，问"模型做了什么事情？"。

查下来**模型没有问题**。那一轮（需求5，`turn-aafb90bb-a42`）它：读了仓库定位到根因
（任务新增表单不传 `project_id`，`POST /api/tasks` 于是报"所属项目不合法"）、两次结构化提问锁定
产物模式与路径、第一次门禁因 `MODE_CONFLICT` 没过、补齐后第二次 `PLAN_READY` 并生成了
`plan-b2734ed8-224`。**方案是完整合法的**——同一屏下方紧跟着 PLAN_CREATED 卡片，页面自相矛盾。

问题在解析器：它判的是 **V1 的字段形状**。

| | 模型给的（V2） | 解析器找的（V1） |
|---|---|---|
| 目标 | `objective.goal` | 顶层 `goal` ← 不存在 |
| 范围 | `scope.includePaths` | 顶层 `include` |
| 验收 | `objective.acceptanceCriteria` | 顶层 `acceptanceCriteria` |
| 验证命令 | `verification.commandIds` | 顶层 `verificationCommandIds` |

顶层没有 `goal` → 直接落到"校验失败"。**从 Plan V2 落地起，每一份新方案都会这样显示。**

### Changed

**1. 两份实现都要改——这是本次最值得记的一点**

解析 Plan 协议的逻辑有**两份必要的镜像**，而**两份都只认 V1**：

- `packages/domain/src/explorer/explorer-activity.ts` 的 `parsePlanArtifact`（活动摘要落库用）；
- `apps/web/src/utils/planProtocolDisplay.ts`（流式期间 web 必须自己解析一遍，因为活动摘要要等回合
  结束才落库；而 web 不能运行时依赖领域层，那会把整个领域打进浏览器包）。

镜像的存在是必要的，但**两边的测试夹具当时也全是 V1**——所以两边同时错、谁也没暴露谁。
两份都改成同时认 V1 与 V2（V1 只用于读历史消息），并在两处都补了 **V2 夹具**，
字段直接取自那次真实输出。

**2. 新增跨实现一致性测试**

`apps/web/src/utils/planProtocolDisplay.parity.test.ts`：同一批夹具同时喂给领域层与 web 两份实现，
断言 READY / INVALID / GENERATING / plain 四种结论与全部摘要字段一致。任何一边改了判定都会红。
（与 `executionStream.parity.test.ts` 同一手法，理由也相同。）

**3. 消除歧义的两条边界**

- 用 `undefined` 判空而不是真值判断：空字符串在旧实现里算合法，不改那条语义。
- `verificationCount` 为 0 是**正确值**：模型只声明 `verification.mode`，命令 ID 由 Factory 解析。

### 验证

- `pnpm verify` 全绿：domain **354** / api **111** / web **485**，无新增值级环。
- **活动摘要是读时投影**，所以修复对历史线程同样生效。已用真实数据核对：
  `GET /explorers/explorer-36c7fd77-f5f/activity?explorerPlanId=explorer-plan-ba2db4ca-5ac`
  里两条原本 `status: INVALID` 的助手活动，现在返回 `status: READY` 与
  「完整执行方案已生成：需求5：修复现有项目添加任务时所属项目不合法」；
  浏览器打开同一线程，"校验失败"已消失、两处都显示方案标题。

## 2026-10-01（其十一）— 执行会话的阶段感与降噪

### 为什么做

执行线程页反复打补丁，但"不好理解"一直在。这一轮把根因拆成三条，都是**看得见的具体现象**：

1. **没有阶段感。** 页面只有一条平铺的消息流 + 顶部六个状态卡，回答不了"现在在干什么、下一步是什么"。
2. **噪音淹没正文。** `reasoning` / Provider 消息 / 会话重建这类**没有成败概念**的活动各占一张卡：
   全库 343 条 `PROVIDER_ACTIVITY` 里有 210 条属于这一类。它们和"命令失败""任务完成"长得一样大。
3. **空执行步骤各占一张卡。** 5 个还没轮到的步骤就是 5 张"尚无结构化进度事件表明此任务已开始"。

### Changed

**1. 三阶段条**（`execution-phase-strip`）

执行 / 验证 / 合并 三步，当前步高亮、已完成打勾，各带一句人话（`0/6 步骤`、`已跳过`、`等待人工合并`）。
当前步由 Run 状态推出：`MERGE_READY` 或已建 Merge request → 合并；有验证结果或处于
`VERIFYING` / `READY_FOR_VERIFY` → 验证；否则执行。**BLOCKED / CANCELLED 停在它当时所在那一步**，
不往前推——否则"卡住了"会被显示成"正在进行下一步"。

**偏差说明**：计划里写的是**四**阶段（准备 / 执行 / 验证 / 合并），实际交付**三**条。原因：
"准备"的事实（工作树、基线、生命周期钩子、Run 级活动）上一轮刚收进顶部 RUN CONTEXT 卡片，
再在会话区放一条"准备"会变成两处讲同一件事。阶段条因此只覆盖会话区能回答的那三步。

**2. 活动噪音折叠**

`outcome === "not-applicable"` 的条目不再各渲染一张卡，收进该执行步骤下的一个
`<details>`（默认一行：「N 条活动记录（推理 / 消息）」），展开是紧凑的一行一条。
**没有丢数据**：它们仍可回溯，只是默认不占视线。步骤头的计数也随之分成两段
（`10 条` + `6 条活动`），一眼能看出"这一步真正发生了什么"有多少。

**3. 连续的空执行步骤并成一行**

`collapsePendingTaskGroups` 把**连续的**空步骤合成一行「N 个执行步骤尚未开始」并列出标题。
只在连续时合并：中间夹着有内容的步骤时分开显示，"跳过第 2 步先做第 3 步"这种事实才看得出来。

### 未做

- **时间线仍是"按执行步骤分组"，没有整体重排成阶段分区。** 阶段条是**导航**，不是容器：
  它告诉你现在在哪一步，但下面的消息流依然按执行步骤组织。把整个会话重排成四个分区是更大的改动，
  且会把"某一步跨了验证阶段"这类真实的交叉情况压平，本轮不做。
- 执行步骤之间仍按方案顺序而非时间顺序排列（既有性质）。

### 验证

- `pnpm verify` 全绿：domain **353** / api **111** / web **475**，无新增值级环。
- 新增用例（`RunDetailView.test.ts`）：阶段条存在且 `.execution-phase.current` 有样式、
  噪音判据是 `outcome === "not-applicable"`、卡片循环改用 `visibleItems`、噪音进 `<details>`、
  空步骤折叠只在**连续**时合并。
- 浏览器实测（dev 5174）：
  - `run-88084cfe-12d`（IN_PROGRESS）：阶段条显示「① 执行 0/6 步骤 ←当前 / ② 验证 未开始 /
    ③ 合并 未开始」；5 张空步骤卡变成一行「5 个执行步骤尚未开始」；task-1 组从 16 张卡变成
    10 张卡 + 一行「6 条活动记录（推理 / 消息）」。
  - `run-a1aa1eae-f43`（MERGE_READY）：阶段条正确推进为「执行 1/1 ✓ / 验证 已跳过 ✓ /
    合并 等待人工合并 ←当前」。
  - **同时确认了上一轮改造在界面上的效果**：同一条命令活动现在显示「命令 · 已完成 ·
    Provider reported success」，改造前它是「状态未知 · Provider 已结束调用，但成败状态未记录」。

## 2026-10-01（其十）— agent 词表中立化、工作区干净闸门、路径预检、Plan 落盘

### 为什么做

三件事都由使用中的事实推动，不是重构偏好：

**1）执行成功率低，且原因高度集中。** 全库 Run 结局 `MERGE_READY` 10 / `CANCELLED` 3 / `BLOCKED` 3，
阻塞原因里 `PROVIDER_COMMAND_TIMEOUT` 6 次、`package.json remains missing in expected project directory`
4 次、各种"目标文件缺失 / 工作树为空"8 次以上。**没有一条是"模型不会写代码"**——全是计划假设的
前置条件与现实不符。而 Explorer 是只读的、读得到仓库，这些事实在生成 Plan 时就能查出来。
仓库里的 `docs/execution-preflight-and-recovery.md` 正是上次同类事故的人工复盘，但**它只是文档**。

**2）同一个动作换个 agent 就换个名字，成败基本读不出来。** 两个 Provider 的原生词表完全不通用
（Codex：`reasoning`/`commandExecution`/`fileChange`/`userMessage`/`mcpToolCall` + `completed`/`failed`；
Claude：`tool_use`/`tool_result`/`providerSession` + `started`/`succeeded`/`failed`），而消费方此前
各自正则猜标签、各自维护成败白名单。后果：全库 `PROVIDER_ACTIVITY` **343 条"状态未知"、11 条失败、
0 条成功**——Codex 的成功词 `completed` 不在成功白名单里，成功从未被识别过；其中 210 条是 `reasoning`
与 `userMessage`，它们**本来就没有成败概念**。

**3）Plan 只存在于页面里。** 落不到盘上，就无法随工程被审阅、被 diff、被版本化。

### Changed

**1. Provider 活动语义中立化**（`model/provider-activity.ts` 新增）

- 中立词表：`activityKind`（command / file-change / tool / mcp / reasoning / message / session / other）
  与 `outcome`（running / succeeded / failed / unknown / **not-applicable**）。
- **`not-applicable` 与 `unknown` 分开是这次的关键**：前者是"这类活动没有成败概念"（推理流、用户消息、
  会话重建，UI 不再给它们挂状态标签），后者是"应该有成败但 Provider 没给"。两者此前混成同一个
  "状态未知"，是 210/343 条噪音的来源。
- 两个 Provider 的映射表**集中在一处、并排写**，"同一逻辑活动 → 同一类别 + 同一成败"因此可读可测；
  `ModelEvent.provider.activity` 的两个新字段**必填**，编译器会指到所有需要更新的夹具。
- 顺带修掉两处**只认 Codex 词表**的判定：`agent-loop.ts` 的单条命令超时此前判
  `itemType === "commandExecution"`，于是**执行器跑在 Claude 上时 Bash 命令根本没有单条超时**，
  只能等整个 Loop 超时（`PROVIDER_COMMAND_TIMEOUT` 那一类阻塞有一半来自这个盲区）；
  `executor-agent.ts` 的 TOOL_CALL 账本现在与 UI 共用同一个 outcome。
- Claude 侧顺带修掉一个显示缺陷：`tool_result` 不带工具名，合并后标题会退化成 `toolUseId`——
  现在由 gateway 记住本轮的工具名，标题与类别都与它的 `tool_use` 一致。
- **向后兼容**：旧 journal 事件没有这两个字段，web 投影保留回退路径（同样修掉 `completed → 成功`），
  `executionStream.parity.test.ts` 用同一批样例断言"镜像与领域实现给出相同结论"。

**2. 派发前的工作区干净闸门**（`git/working-tree.ts` 新增）

- 判据：`git status --porcelain -uall -- . ':(exclude)<planDirectory>'` 为空。白名单用 **git pathspec
  magic** 而不是自己解析 porcelain——后者要处理 rename 的 `old -> new` 与引号转义，漏一个就会把
  Factory 自己写的计划文件算成脏。
- 闸门在建 worktree 时**硬阻断**（`LocalGitWorktreeAdapter.create`，位置在 `worktree add` **之前**：
  顺序颠倒会白建一个工作树再回滚），由 `Scheduler` 落成 Run 的 BLOCKED 原因；确认 Plan 时只**提示**
  不阻断（确认计划与工作区干净是两件事）。
- **基线因此恒等于 `baseCommit`**：`snapshotProjectWorkingTree` 的"把未提交改动铺进工作树"随之删除
  （模块一并移除），`git/worktree.ts` 的维护提示第 2、3 条与它相反的事实一起改掉。
  理由：那会让"你本地看到的树"与"Agent 改的树"成为两棵不同的树，"我本地明明是好的"这类纠纷
  无法收敛。未提交改动被挡在门外是**有意**的。

**3. 派发前的路径预检**（`plan/preflight.ts` 新增，`PlanService.confirm` / `confirmRevisionDraft` 落闸门）

- 只查 **include 里带扩展名的具体文件**：`artifact.path` 与通配范围都不查——产物天然可能是要新建的
  文件（"添加甘特图"就要新建组件），通配描述的是"在哪个范围里干活"。具体的**输入文件**不存在，
  才是"计划建立在幻觉上"。
- 判定用 `git cat-file -e <baseCommit>:<path>`（一条命令同时覆盖文件与目录），**同步实现**——
  它跑在 `confirm` 这条同步短路径上，与 `git/merge-inspector.ts` 同样的理由。
- 闸门放在 **service 而不是 route**：`routes/plans.ts` 有 `confirmAndDispatch` 与 `plans.confirm`
  两条路径，service 是唯一必经点。`PLAN_PREFLIGHT_FAILED` 由路由拆成 `code` + `error` 返回 409。
- **Explorer 侧闭环**（不做的话用户会"生成 → 阻断 → 再生成"空转）：`EXPLORER_PLAN_INSTRUCTIONS`
  补一条——声明方案前必须自行核对具体文件是否存在；要新建文件就写目录范围。闸门是兜底，不是主交互。

**4. Plan 落盘**（`plan/plan-archive.ts` 新增，`project.planDirectory` 新增配置）

- **只在确认时写**，每版一个文件 `<planId>-v<revision>.md`，**不覆盖旧版**；目录不存在自动创建。
- 内容是人读的 Markdown：目标、验收标准、范围、实施步骤与依赖、验证命令、产物路径、基线、
  契约哈希、确认人与时间。
- **写盘先于冻结 Revision**：写失败就阻断确认（可重试、无副作用）；反过来先冻结再写，会留下
  "确认成功了但文件没写成"的中间态。
- 落盘路径**持久化**进 Revision（`plan_document_path`，按仓库既有 `ALTER TABLE` 迁移惯例加列）
  而不是运行时推算——推算值会随配置漂移，"文件在哪"就成了一条会变的事实。
- 这些文件会出现在受管仓库的 `git status` 里（这正是"随工程版本化"的用意），且**不会**阻断派发：
  干净检查对该目录放行。两条规则共用 `plan/plan-directory.ts` 的同一处解析，避免"确认时不脏、
  建 worktree 时脏"。

### 未做

- **执行线程页面重做（四阶段 + 降噪）尚未开始**：本条目只交付了它依赖的数据层与闸门。
  页面改版是下一轮。
- 命令 / manifest 缺失**不做硬阻断**（可能由 Agent 自行创建），只作信息级提示。
- `docs/execution-preflight-and-recovery.md` 的人工流程未改（其第 6、7 条在"工作区必须干净"之后
  语义已变），本轮只更新了代码注释。

### 验证

- `pnpm verify` 全绿：domain **353** / api **111** / web **474**，无新增值级环。
- 新增用例：`model/provider-activity.test.ts`（跨 Provider 等价：同一条命令 / 失败 / 文件修改
  两个 Provider 给出同一类别与同一成败；Codex 的 `completed` 就是成功；没有成败概念的类别返回
  not-applicable）、`git/working-tree.test.ts`（判据、白名单路径、**先检查再建树**的顺序、
  基线恒等于 baseCommit、porcelain 解析含 rename 与引号路径）、`plan/plan-directory.test.ts`
  （缺省位置、仓库外返回 null、前缀相似的兄弟目录不算"之内"）、`plan/preflight.test.ts`
  （通配不查 / 产物缺失只警告 / 绝对路径与 `..` 不查 / 仓库读不到时不做判断 / 阻断时**没有冻结
  Revision**）、`plan/plan-archive.test.ts`（渲染内容、目录自动创建、**每版一个文件不覆盖**、
  同一版幂等、路径记进 Revision）。
- `m3-run.test.ts` 的 git 调用序列守卫随之更新（那条断言钉的是旧的三步序列，属**有意的行为变更**，
  不是回归，故改测试而非登记基线）。

## 2026-10-01（其九）— 把「Run 级活动」移出执行会话，并给归因缺口正名

### 为什么做

起因是一句提问："`未关联执行步骤` 是什么意思？"——**用户看不懂自己界面上的一个标题**，这本身就是结论。
查真实数据（`execution_journal` 表）之后发现两件事：

- 那个桶的日常内容是 `RUN_CREATED`(15) / `HOOK_SKIPPED`(17) / `VERIFICATION`(9) / `USER_GUIDANCE`(2)，
  它们**结构上永远没有 `taskId`**——讲的是整个 Run，本来就不属于任何一步。这是**常态**。
- 文案「未关联执行步骤 ← 此处保留旧 Run 或未提供执行步骤标识的事件」却在描述**异常**，
  而且先说了少数派（老数据）。真正的老数据只有 404 条无 `modelStep` 的 `MODEL_OUTPUT`，
  **全部集中在 2026-09-18 ~ 09-25，之后再没出现过**。

还有一个更根本的展示问题：桶永远排在时间线最后，但里面的 `Run created` 永远**最早**发生。
截图里的视线路径是：5 张「尚无结构化进度事件表明此任务已开始」的空卡片 → 才看到实际发生的两件事。

### Changed

**1. 判据改为一行：`kind === "activity" && !taskId`**

- 即「没有归属于任何执行步骤的 Run 级事件」。原先按事件类型列举（RUN_CREATED / HOOK_* / VERIFICATION）
  的写法每加一种 Run 级事件都要回来补一次，且同样无归属的 `Executor started` / `Execution gate`
  会被漏在会话里名不副实。
- 投影层（`utils/executionStream.ts`）**没有改动**——判据只用既有字段。

**2. 时间线不再有 Run 级活动组，改由顶部 RUN CONTEXT 卡片承载**

- `ExecutionHeaderStatus` 新增 `runActivity` prop，在 RUN CONTEXT 弹层（原本只有
  WORKSPACE / BASE COMMIT / THREAD / STARTED）下方加一节 **RUN ACTIVITY · Run 级活动**：
  说明改成「Run 的创建、生命周期钩子与验证等事件，属于整个 Run，不归属于任何单个执行步骤。」，
  下面按时间列出事件。它讲的是「这个 Run 怎么起来的」，与那一格的既有字段同性质。
- **有 Run 级活动失败时卡片本身变红**（如 `HOOK_FAILED`）——否则失败只藏在弹层里，不点开看不见。
- 时间线由此收敛为：冻结方案 → 执行步骤 → 你说的话（＋老数据的归因缺口）。

**3. 归因缺口组正名：`unassigned` → `unattributed`**

- 标题「未关联执行步骤」→「**未归属事件**」，说明改成「这些事件没有记录所属的执行步骤，
  只出现在早期 Run 的数据里。」
- **说明文案不再需要判断"要不要显示"**：该组现在只在真有归因缺口时才存在，条件显示自然成立。
- 模板与 CSS 一起改名（`.execution-unassigned-heading` → `.execution-unattributed-heading`），不留死样式。

**4. guidance 独立成组（无组头）**

- 无 `taskId` 的 guidance 自成一格 `.execution-conversation-group-guidance`，**不渲染组头**——
  条目标题已经是「你补充了要求」，再加一层组头是重复。

### 一处计划外的发现（纠正本轮计划里的假设）

计划里写的是「你自己发的消息现在也被标成"未关联执行步骤"」。**实测不成立**：
`run-8d0b9489-06d` 第 86 条的 guidance 带上了 `taskId`——投影用「当前模型轮次」给它归了因，
所以它一直显示在对应的执行步骤组内，时序也是对的。只有**早于任何步骤归因**的 guidance
（`run-5fd6449b-c0d` 第 5 条，前面只有 RUN_CREATED / HOOK_SKIPPED）才会落进那个桶，
第 4 条改的正是这一种。规则本身以数据为准，不是以假设为准。

### 未做

- **分组模型仍按「方案 → 步骤顺序」排列，不按时间穿插。** 无 `taskId` 的 guidance 因此仍是
  独立一组排在末尾，而不是插在它真正发生的位置。修它等于重做分组模型（任务组之间也不是严格时序），
  属于另一件事；本次只保证它不再被错标。

### 验证

- `pnpm verify` 全绿：domain **309** / api **111** / web **460**，无新增值级环。
- 新增用例：`ExecutionHeaderStatus.test.ts`（列出 Run 级活动、没有时不渲染这一节、失败时卡片变红）、
  `RunDetailView.test.ts`（判据是 activity+无 taskId、旧标题与旧说明不再出现、模板与样式两侧同步改名、
  guidance 独立成组）。
- 浏览器实测四个 Run（dev 5174）：
  - `run-88084cfe-12d`（现代 Run）：时间线**不再有** RUN ACTIVITY 组；RUN CONTEXT 弹层出现
    「Run 级活动 2 条」，列出 `Run created 10:55:40` 与 `Hook skipped start`。
  - `run-5fd6449b-c0d`：第 5 条的 guidance 渲染为独立一格、无组头，不再挂在旧桶下。
  - `run-8d0b9489-06d`：带归因的 guidance 仍在任务组内、时序不变（确认第 4 条没有误伤）。
  - `run-bbf57894-513`（老数据）：`UNATTRIBUTED 未归属事件 1 条` + 新说明正常渲染，
    另有 7 条 Run 级活动被移到了顶部。
- **本条补完的改动有一半先随 `bb5a6ce` 落库**（分组类型与判据两处 hunk 被那次提交一起 `git add` 了），
  当时仓库处于"新判据已生效、模板仍判断旧 kind"的半成品状态；本条把模板、样式、测试一并补齐。

## 2026-10-01（其八）— 执行对话按步骤折叠；用横线分段取代左侧竖线

### 为什么做

两条反馈都关于"按 task 分组"这件事做得不够：

1. **步骤的存在感弱、也不能收**。分组本身是对的，但从这一步切到那一步时，只能一路滚——想"逐个
   看每个 task 执行得怎么样"就会乱。
2. **每个步骤左边那根竖线占地方**。它把整组内容往右推 53px（`margin-left: 39px` + `padding-left: 14px`），
   而它想表达的"这是一组"其实已经有分组头在说了。

### Changed

- **步骤头变成折叠开关**（`<header>` → `<button>`，带 `aria-expanded` / `aria-controls`）：
  整条可点，右侧有箭头，收起的是**这一组的消息**——步骤头始终留着，它就是"这里还有一个 task"的那一行。
  头部同时补强了可读性：`PLAN TASK` 变成小圆角标签、标题加大、状态变成带色标签
  （完成绿 / 进行中蓝 / 阻塞红）、右侧显示条数（`19 条`），阻塞原因照旧在最下面一行。
- **去掉左侧竖线**，改成**组与组之间一条 2px 横线**：省下横向空间，任务边界反而更醒目。
  "从状态卡选中某一步"的高亮也从"竖线变蓝"改成整条头部高亮。
- **从状态卡跳到被收起的步骤时先自动展开**（`focusExecutionTask` → `expandTaskGroup`）——
  否则"跳过去"看起来像没反应，而这正是这个折叠功能最容易踩的坑。

### 验证

- `pnpm verify` 全绿：domain 309 / api 111 / web **456**。新增断言：步骤头是带 `aria-expanded`
  的按钮、`toggleTaskGroup` 有没有接上、条目容器存在、聚焦时先展开，以及**样式表里不再出现
  `.execution-conversation-group-task { … border-left … }`**、且组间是 `border-top: 2px solid`
  （竖线不许悄悄回来）。
- 浏览器实测（真实 Run `run-14f0417a-5cb`）：
  - 计算样式：组 `border-left: 0px none`、`border-top: 2px solid rgb(215,224,236)`、`margin-left: 0`。
  - 头部为 `BUTTON`，`aria-expanded=true`、`aria-controls=execution-task-stream-task-task-1`，
    文案 "PLAN TASK | … | Completed | 19 条"。
  - 点一下：`aria-expanded=false`、组多出 `.collapsed`、条目容器从 DOM 移除、可见消息 0 条；
    再点恢复。

## 2026-10-01（其七）— 设置页改执行模型不再被"有 Run 在跑"挡住

### 为什么做

报障："project4 我把执行模型换成 claude 了，执行线程底部还是 codex 与 gpt-5.6-luna。"

查下来是两件事叠在一起：

1. **那次保存根本没成功**。`ProjectService.update` 把**任何** settings 变更都算作"高风险"，
   而高风险变更要求没有活动 Run（`hasActiveRun`，含 `STARTING / IN_PROGRESS / VERIFYING`）。
   project4 当时有两个 `IN_PROGRESS` 的 Run，于是返回 409 `PROJECT_HAS_ACTIVE_RUNS`——
   而用户看到的只是一句英文 "has active runs"，很容易当成无关提示划过去。
2. 即便存成功，**已确认的 Plan 与它派生的 Run 用的是确认时冻结的那份配置**
   （`executor-agent` 从 `revision.projectConfigSnapshot.settings.models.executor` 取模型），
   所以那份 Run 仍会显示 codex。这一条是设计不是 bug，但页面上没写清楚，用户第二次困惑就在这。

数据库侧的佐证：project4 的 `config_version` 一直是 **1**、`project_config_revisions` 只有建项目那一条、
`domain_events` 里今天**没有任何** `project.config.updated`——那次修改从未落库。

### Changed

- **`ProjectService.update`：把"高风险"收窄到真正会动到运行中 Run 脚下那块地的改动** ——
  仓库 / Worktree 路径、默认分支，加上 hooks。模型、并发、命令、工具白名单不再被活动 Run 挡住：
  它们在 Plan Confirm 时就冻结进 Revision 快照，运行中的 Run 只读自己那份。
  设置页三处提示本来也是这么承诺的（General 栏"仓库目录、Worktree 和分支修改需要没有运行中的 Run"
  vs 执行/模型栏"这些设置会在下一次 Plan Confirm 时冻结"），**是实现比文案更严**。
  hooks 保留在守卫内：`PATCH /hooks` 那条路由本来就有同一道守卫，不能从这里开后门。
  拒绝信息补了中文说明（哪些被挡、哪些可以随时改），不再只有一句 "has active runs"。
- **Models & Tools 栏文案**（弹框与独立设置页各一处）：补上"已确认的 Plan 与正在跑的 Run 继续用
  它们冻结的那份，改动从下一次 Plan Confirm 起生效"。
- **执行线程底部的来源说明**：当项目当前配置与这份 Run 用的模型不一致时，写成
  `本次执行记录 · 项目当前配置 claude-opus-5（改在下一个 Plan Revision 生效）`——
  把"为什么还是旧的"直接写在页面上（`utils/executionTelemetry.ts` 的 `executionModelSourceNote`，纯函数 + 单测）。

### 验证

- `pnpm verify` 全绿：domain **309** / api **111** / web **455**。新增用例：
  `project.test.ts`（活动 Run 下改模型可以存、路径/分支/hooks 仍被挡）、
  `server.test.ts`（同一条经 HTTP 走通，`configVersion` 1→2）、
  `executionTelemetry.test.ts`（来源说明 + 配置漂移提示）。
- 先写了一条会失败的用例复现报障（`→ Project project-1 has active runs`），再改实现——它现在留在
  测试里当回归守卫。
- **没有在你的 project4 上实测保存**：那会真的改你的项目配置，我没动。修好后在设置里再存一次即可。

## 2026-10-01（其六）— 执行线程改成对话观感；底部回答"现在用的是什么模型"

### 为什么做

两条反馈，都在执行页签（抽屉里的 Run）里：

1. **"内容结构混乱"**：一屏都是卡片墙，`Turn #1`、`Call …`、`Provider item msg_…`、
   `Provider session linked` 全挤在每条消息的标题行上，像日志不像对话。期望"我和大模型沟通"的观感：
   我的消息在右、执行者的在左。
2. **"底部不知道当前用的是什么模型"**：底部那条 `AGENT / MODEL / CONTEXT` 三格都是"未记录"。

### Changed

**执行对话：左右分栏 + 降噪（只改渲染与样式，不动 journal 投影）**

- 我的消息（`role === 'user'`，即 guidance）靠右、执行者的靠左。原来 `flex-basis: 92%` 几乎占满整行，
  右对齐等于没做——现在收到 `min(620px, 78%)`。
- 诊断字段收进"详情"：常驻只留 **标题 · 状态 · 时间**；`Turn #`/`Call`/`Provider item`/`Provider session`
  移到 hover（`title`）与"详情"折叠里。规则抽成 `utils/executionMessageDetails.ts` 并单测——
  它同时是安全边界的外沿：**只排版已有字段，不新增暴露面**（`executionStream.ts` 定过：不出工具参数、
  成功结果与思维链）。
- `状态未知` 不再整卡染黄（截图里三张黄卡很扎眼），改成中性卡片 + 状态标签。

**探索线程：同一套读法（靠右 + 右侧身份标识）**

- `.user-message` 从"整块左对齐卡片"改成靠右：`display: flex; flex-direction: row-reverse; margin-left: auto`，
  并补上右侧的 `LS` 头像（`title="我"`）。左边 assistant 有头像、右边什么都没有的话，
  一眼看不出那句是谁说的。右上角收一点圆角作为"这是我说的"记号，与执行线程一致。
- 记账：**"探索线程本来就是我的消息在右"这个印象与代码不符**。早先那套 `row-reverse` 右对齐规则还在
  文件里，但被后面那次"Codex Desktop 风格"改造的 `.user-message { display: block; max-width: 760px }`
  压在下面，早已失效——两条规则同时存在、只有一条生效，是本轮最容易误判的地方。

**底部：模型与 agent 必须有答案**
- **修一个真缺陷**：`projectRunThreadTelemetry` 重建 telemetry 对象时漏搬 `backend`，于是库里记着
  `codex-app-server`、界面上 AGENT 一栏**永远是"未记录"**。现在 `existing` 有的字段逐个带过去，
  缺失时才回退 Revision 快照。
- **运行中也要有答案**：遥测是**每一轮结束时**才落库的，所以"正在跑"时三格必然空白——而这正是
  想问"现在用什么模型"的时刻。新增 `resolveRunExecutorConfig`（Revision 快照优先、否则当前项目设置），
  `GET /api/v4/runs/:runId` 把它作为 `executorConfig` 单独返回，前端在"本次没有记录"时用它，
  并标注来源（`本次执行记录` / `按本 Run 冻结的项目配置`）。项目没覆盖 backend 时再回退该角色生效的
  全局后端（`/model-backends` 的 roles），否则 AGENT 一栏仍会空着。
- `context-note` 从 `provider exact` 改成 `仅结束时由 provider 上报`：运行中拿不到就是拿不到，
  说清楚比让人以为坏了强。
- **本次记录整份优先、不与配置混搭**：model 与 backend 是同一次写入的一对事实，
  混搭会造出一个从未存在过的组合。所以 09-26 那类"遥测里还没有 backend 字段"的老 Run 仍显示
  `未记录` —— 那是诚实的，不是漏修。

### 验证

- `pnpm verify` 全绿：domain 308 / api **110** / web **453**。新增/更新用例：
  `projections/run-telemetry.test.ts`（新文件：existing 优先、backend 被保留、快照兜底、都没有时为 null）、
  `server.test.ts`（`executorConfig` 与 telemetry.backend 的 HTTP 断言）、
  `utils/executionTelemetry.test.ts`（记录优先 / 配置兜底 / 都没有）、
  `utils/executionMessageDetails.test.ts`（新文件）、`components/ProviderUsageFooter.test.ts`（新文件，
  挂真实组件）、`RunDetailView.test.ts`（源码级断言跟着新模板走）。
- 浏览器实测（用**数据库副本**在 4313 起独立实例，不动正在跑的 4310）：
  - 用户给的 Run `run-62e320ce-d60` 底部从"三格未记录"变成
    `AGENT Codex App Server · MODEL gpt-5.6-luna · CONTEXT 191,197 tokens · 本次执行记录`。
  - `GET /api/v4/runs/run-62e320ce-d60` 的 telemetry 里 `backend` 回来了（修前被投影丢掉）。
  - 另一条带 guidance 的 Run：我的消息在右侧、矮而窄（body 左 1803/右 2382，其余消息左 1731/右 2408），
    每条活动只剩"标题 · 状态 · 时间 · 详情"，点"详情"展开 `Turn #1` 且 `aria-expanded=true`，
    hover 有 `Turn #1` 提示。
  - 探索线程：用户消息从"左 224 起、852 宽"变成"右贴边、760 宽"（左 316 → 右 1076），
    右侧 `LS` 头像落在 951→976，与左侧 assistant 头像（124→149）对称；抽屉里的探索对话同一套 class，同样生效。
- **未实测**：`executorConfig` 那条"运行中"回退路径只跑过单测——真实数据库里所有 Run 都已有遥测，
  我改副本数据库后又想重起实例时被权限拦下了。要用真实数据看这一条，把某个 Run 的
  `execution_threads.telemetry_json` 置空再打开页面即可。

## 2026-10-01（其五）— 新建 Project 时用系统对话框选目录

### 为什么做

反馈很直接："Git repository root 能不能改成选择文件夹？我不想输入路径，容易输错。"

**浏览器给不了这个能力，不是没做而是故意不做**：`showDirectoryPicker()` 只返回目录句柄（拿不到
`/Users/...` 这种绝对路径，且 Firefox 没有这个接口）；`<input webkitdirectory>` 只给
`webkitRelativePath`（相对路径）；拖拽文件夹的 `webkitGetAsEntry()` 同样只有相对 `fullPath`。
规范刻意不暴露路径，否则任意网页都能刺探本地目录结构。而 `repoRoot` 必须是本机绝对路径
（服务端要拿它跑 git、建 Worktree），所以**只能由跑在同一台机器上的本地 API 去问操作系统**。

### Changed

**后端：一处系统对话框，三种结果都当正常响应**

- 新增 `runtime/directory-dialog.ts`：macOS 用 `osascript` 的 `choose folder`，Windows 用
  PowerShell 的 WinForms `FolderBrowserDialog`，Linux 用 `zenity` / `kdialog`（zenity 没装才轮到
  kdialog——只有 ENOENT 才算"没装"，装了的那个报错就如实上报，不静默换一个再弹）。
- 新增 `POST /api/v4/dialogs/select-directory`。**它是 POST 不是 GET**：会在服务端弹 GUI，
  不是可以缓存或预取的读。**只接受回环地址**的调用（否则 403）——服务将来若被配成监听
  `0.0.0.0`，不该由远端决定什么时候在你屏幕上弹东西。
- 结果语义分开且都可断言：`{ cancelled: true }`（用户点了取消，**200，不是错误**）、
  `{ cancelled: false, path }`、501（平台不支持，提示手输）、504（等超时）、502（命令失败）。
- 平台命令都缺时抛 `DIALOG_UNSUPPORTED` 而不是静默返回空——"点了没反应"在这一轮里已经反复
  被判定为缺陷，不该在新按钮上重演。

**前端：两个新建入口共用一段交互**

- `api.selectDirectory()` + `composables/useDirectoryPicker.ts`（点按钮 → 弹框 → 回填；
  取消什么都不做，失败把后端那句话原样显示在弹框里）。
- `ProjectCreateDialog` 与 `ProjectManagementDialog` 的创建态各加一个 `选择文件夹…` 按钮，
  输入框保留（手输与粘贴照旧）。

### 验证

- `pnpm verify` 全绿：domain 308 / api **104** / web **444**。新增用例：三个平台各自的"取消长什么样"
  （含**中文系统**的 AppleScript 文案）、成功的路径取用、真失败与"被信号打断"的区分、
  路由的 200 取消 / 200 选到 / 501。
- 浏览器 + 系统实测（独立测试实例 4312，不碰正在跑的 4310）：点按钮后请求**一直挂起**，
  在 `ps` 里能看到 API 进程下的 `osascript -e POSIX path of (choose folder …)` 子进程
  —— 对话框确实弹出来了；杀掉该子进程后，页面显示
  `打开文件夹选择框失败：osascript 未能返回目录：进程被信号中断（SIGTERM）`（502 / `DIALOG_FAILED`）；
  从局域网地址（`192.168.2.107`）请求得到 **403 `DIALOG_LOCAL_ONLY`**，且不弹窗。
- **实测中修掉一个错误**：第一版把"子进程被外部杀掉"和"等超时"都算成 504 `DIALOG_TIMEOUT`，
  于是页面会写"等待选择超时（300 秒）"——当时只过了 16 秒。现在只有 Node 自己按 timeout 杀的
  （`error.killed`）才算超时，别的信号如实报 `DIALOG_FAILED` 并带上信号名。
- **未验证**：Windows / Linux 的命令是照各自文档写的，本机（macOS）无法实测；"用户真的选中一个
  目录 → 路径回填"这一步需要真人点对话框，由使用者验收（取消/失败两条路已实测）。

## 2026-10-01（其四）— dev 下 API 热重载，改 domain 不再需要重建

### 为什么做

dev 模式下 API 跑的是 `src/main.ts`（tsx），但 `@pipeline-factory/domain` 是通过包的
`exports` 解析到 `packages/domain/dist/index.js` 的。于是"改 domain"实际上要走三步：
`tsc` 重新构建 domain → 停掉 API → 再启动，中间任何一步漏掉，跑的就是旧代码，而且**没有任何
提示**——进程活着、健康检查通过、行为却是上一版。这正好是本地调试最费时间的那类假象。

### Changed

**1. dev 下 domain 走源码，不再经过 dist**

- `packages/domain/package.json` 的 `exports["."]` 增加最高优先级条件
  `"pipeline-dev": "./src/index.ts"`；`apps/api` 的 `dev` 脚本加 `--conditions=pipeline-dev`，
  于是运行时命中该条件，直接加载 `packages/domain/src/index.ts`，由 tsx 现场编译。
- 条件名取 `pipeline-dev` 而不是通用的 `development`：后者可能被依赖树里别的包或工具默认打开，
  污染面不可控；自定义名只有显式传 `--conditions` 才会命中。
- **没有用 tsconfig `paths` 指向源码**：那样 `apps/api` 的 `tsc --outDir dist` 会把
  `packages/domain/src/**` 拉进 program，而它不在 `rootDir`（`apps/api/src`）之内，
  构建会以 TS6059 失败。exports 条件只作用于运行时解析，`tsc` 看不见，构建链路零改动。
- `predev` 仍然构建 domain——那是给 `tsc` 与编辑器解析 `types` 用的，已经不是运行时依赖。

**2. API 以 `node --watch` 启动**

- `dev` 脚本由 `node --import tsx/esm src/main.ts` 改为
  `node --watch --conditions=pipeline-dev --import tsx/esm src/main.ts`。
  `--watch` 监听**已加载的源码模块**，因此改 `apps/api/src` 与 `packages/domain/src` 都会自动重启；
  它默认跳过 `node_modules`，而 domain 源码解析出的是真实路径 `packages/domain/src/`，
  不在 `node_modules` 下，不会被漏掉。
- 用 `node --watch` 而不是 `tsx watch`：条件解析要的是 Node 自己的 `--conditions`（否则得退化成
  `NODE_OPTIONS` 环境变量），而 `--watch` 与 `--import tsx/esm` 本就配套。
- 代价写进了 `code/README.md`：重启会切断 SSE 连接、重置调度器内存状态，数据库与事件流本身是持久的。

**3. `apps/web` 不动**

- web 只在 `*.test.ts` 里引用 domain（`type-parity.test.ts`、`explorerPlanRequirements.test.ts`），
  运行时不依赖它，所以 vite 侧不需要任何 alias 或条件。

### 未做

- **prod 不受影响，也没有改动**：`pnpm build && pnpm start` 不传 `--conditions`，仍加载 `dist/`。
  两条路径（源码 / 产物）按设计并存，不是"临时绕过"。
- 没给 web 加 HMR 相关配置：vite 本来就带，问题只在 API 这一侧。

### 验证

- **源码 vs 产物的直接证据**：临时在 `packages/domain/src/index.ts` 顶部插入
  `throw new Error("WATCH-PROBE: domain src 被加载")`，API 自动重启后崩溃，栈顶为
  `at <anonymous> (/Users/Bill/Downloads/pipeline-factory/code/packages/domain/src/index.ts:62:7)`
  ——加载的确实是源码，且**改动是被自动发现的**。随后删除探针，日志出现
  `Restarting 'src/main.ts ...'`，`GET /health` 恢复 `{"status":"ok",...}`。
- `touch apps/api/src/server.ts` 同样触发重启（PID 换新），确认 api 侧源码也在监听范围内。
- `pnpm build` 与 `pnpm typecheck` 全绿（domain / api / web 三包），确认新增 exports 条件没有
  影响 `tsc` 的 `types` 解析与产物构建。
- 服务以 `node scripts/service.mjs start --mode dev` 正常起停，`stop` 的进程树清理未受影响。

## 2026-10-01（其三）— 对话产物的确认边界、Explorer 指令与一处死代码清理

### 为什么做

从一次用户报障开始："需求7 确认了 V2 之后，执行页签点不动。"查下去是三件独立的事叠在一起，
最后顺手清掉一处死代码。三件事都绕着同一条边界：**对话产物（CONVERSATION）可以被确认，但不能被执行。**

### Changed

**1. 抽屉里的 "Confirm V2" 点了没反应**

- 根因不在按钮，而在"确认哪一版"。工作区投影**只把 DRAFT 的 Plan 当候选**：已确认 Plan 上挂着修订草稿时
  `candidate` 是 `null`，而 `confirmPlan` 第一行就固定读它——于是直接早退，没有请求、没有报错、没有提示。
  抽屉却照常渲染出草稿投影的 "Confirm V2"（它走的是 `detailPlan`），**两边认的不是同一份 Plan**。
- 改法：`confirmPlan` / `discardPlan` 的**目标由调用方给**（抽屉传 `detailPlan`，时间线内联卡传卡片自己那份），
  缺省才回落到 `candidate`——与 `enqueuePlan(plan)` 一直以来的写法一致。
- 顺带修掉一处同类缺陷：内联卡的 `@click="enqueuePlan"` 会把 MouseEvent 当 Plan 传进去，
  `plan.status !== "READY"` 直接早退——**那个 "Enqueue plan" 按钮此前同样是死的**。
- 一并发现："Discard plan" 在同样的状态下也点不动（同一个读 `candidate` 的守卫）。

**2. Explorer 不再把 CONVERSATION 标成"推荐"**

- `EXPLORER_PLAN_INSTRUCTIONS` 补一条：不得把 CONVERSATION 标成推荐、默认项或首选；需求要改仓库里的文件时
  只有 REPOSITORY_FILE 能被执行；只有"只要一份对话内的结论、不落盘"的需求才适合 CONVERSATION。
  起因是需求7 那次提问把 CONVERSATION 标成"（推荐）"，而同一组回答里用户选的目标与范围
  （补充/修改作品集 + 仅 `code/personal-site/**`）明明是仓库改动——**模型推荐错了模式，系统也没提示这个矛盾**。
- **生效范围**：这段指令只在 `role === "explorer" && mode === "plan"` 且**新建 provider thread** 时注入
  （`codex-app-server.ts`），所以**已存在的探索线程拿不到新提示词**，要新建线程/需求才会用上。

**3. 确认前给警告（只警告、不拦截）**

- Plan 详情抽屉：确认按钮上方说明"确认后仍不能入队或启动 Run"以及出路（改成 REPOSITORY_FILE 并确认新版本）。
- 时间线内联卡（PLAN CREATED 卡与 assistant 活动卡各一处）：同一句话的紧凑版。
- 之所以只警告不拦截：对话产物是**合法契约**（设计文档 §14：两种模式都可 Confirm，只是禁止 Enqueue/Dispatch/Start Run），
  确认入口不该被拿掉；要拦的是"不知道自己正在确认什么"。

**4. 删除死代码 `PlanCenterPanel`**

- 它在 ac4d794（consolidate explorer requirement workspace）之后就没有任何地方渲染了：全仓库只剩它自己、
  它自己的测试，以及 `ExplorerView.test.ts` 里一个从未被使用的 `planCenterSource` 声明。
  它做过的事已由 Explorer 的需求工作区承接（配置项目命令、创建更新版本都在任务面板里）。
- 同时删掉它的测试与那个未使用的声明；保留 `not.toContain("<PlanCenterPanel")` 守卫并注明新含义——
  **不要再长出第二套 Plan 中心**（与它并列的两条旧上下文面板守卫同理）。
- 两条账要记：
  - `utils/runPrerequisites.ts` 的 `parseMissingRunCommands` 现在只剩测试在调它（面板是唯一生产调用方）。
    **本轮没动它**——删不删取决于还要不要那个提示文案。
  - 面板里的 **"Retry dispatch"（自动派发失败后重试）目前界面上没有入口**：它只存在于这个面板，
    随 ac4d794 一起失去可达性。删死代码不会让它更差，但这是真实的能力缺口，需要时得在需求工作区补一个。

### 验证

- `pnpm verify` 全绿：domain **308** / api **96** / web **441**（比上一轮少 4 条 = 随面板删掉的用例）。
- 新增/更新用例：`usePlanLifecycleActions.test.ts`（候选为 null 时确认与丢弃仍走草稿端点）、
  `ExplorerView.test.ts`（抽屉 `@confirm` 传 `detailPlan`、两张内联卡的警告句）、
  `PlanDetailContent.test.ts`（**挂真实组件**：对话产物有警告且仍可确认、可执行方案没有警告）、
  `plan-requirements.test.ts`（锁住"不得标成推荐"那句，并与 `artifactModes` 交叉校验）。
- 浏览器实测（dev server 5173，代理到同一个 4310 API）：需求7 的 V2 草稿点 "Confirm V2" 会发出
  `POST /api/v4/plans/plan-f8801424-f30/revision-drafts/revision-draft-c535f61f-0b1/confirm`
  （用 fetch 拦截器拦下记录，**未真的落库**，草稿确认是用户自己点的）；对话产物草稿上抽屉与内联卡都出现警告、
  按钮仍在；REPOSITORY_FILE 的方案没有警告。

## 2026-10-01（其二）— 冲突判定范围可选、验证子集可人工重挑

### 为什么做

补齐上一轮记账的最后两项。两处都不是"加功能"，而是把已经存在但只能靠模型/只能看不能改的东西
交回人手里：

- 冲突判定此前**只认模型声明的 `conflicts` 语义键**——探索产出的键不可靠时，两道并行 Run 就可能改到
  同一片代码。派生策略的方向是有的，但"该不该保守"取决于项目，所以做**可选策略**而不是改默认。
- `verification.suites` 只能由 Explorer 产出，想调整就得让模型重出一版方案。上一轮以为需要"浏览器端
  方案草稿编辑能力"，实际与前置 Plan 是同一条路子（Factory-owned 字段 + 人来设 + Confirm 时冻结）。

### Changed

**冲突判定范围（`concurrency.conflictScope`）**

- 新增 Project 设置 `concurrency.conflictScope: "declared" | "overlap"`，**默认 `declared`**——
  与引入本字段之前逐字相同，升级不会让同目录下不相关的 Plan 突然互相排队。
- `overlap` 时**另外**比较两个 Plan 的 `scope.includePaths`：相等或一个是另一个的父路径即视为冲突
  （按路径段比较，不是字符串前缀；`code/apps/web/**` 与 `code/apps/web` 经 `scopeRoot` 归一后同义）。
- **只在同一 Project 内比较**：include 是项目相对路径，跨项目同名的 `src/index.ts` 不代表碰同一份文件。
  **这条是写测试时才发现的**——第一版没加项目过滤，测试里两个项目用了相同路径字符串，直接串到一起。
- 等待原因带上具体是哪一片范围重叠（`Waiting for conflicting Run … (overlapping scope code/apps/web/src)`），
  排障不用再去比对两个 Plan 的 scope。
- 字段**可选**：本字段之前落库的 Project 没有它，读路径一律按 `declared` 处理，不为一个新开关改写用户配置行。
- 控制台：两个设置入口的 Execution policy 各加一个 `Conflict scope` 选择器（带说明，避免误以为越保守越好）。

**验证子集的人工重挑**

- `PlanService.setVerificationSuites()` + `PUT /api/v4/plans/:planId/verification-suites`：
  候选态可改，**只有 tag 可选**（词表来自项目登记的 tags），命令 ID 依旧由 Factory 用同一套规则解析。
  空数组 = 回到项目默认全集（不是"什么都不跑"）。会**重新解析** resolvedContract 与 V1 投影
  （用当前 Project 快照 + 原有 Git 基线），既让 commandIds 跟着 tag 变，也让候选与当前配置版本对齐。
- 项目没有任何默认验证命令时明确拒绝，而不是把请求当成功。
- 控制台：Plan 详情新增 `03D Verification subset`（勾选项来自项目 tag 词表；空词表时如实说明
  "还没有登记任何验证 tag"）。顺带修正该文件里一处段落编号笔误（Merge detection 复用了 03B）。

### 验证

- domain **306** / api **96** / web **438** 全通过；三个 typecheck 无错误。
- 新增用例：`dispatch-coordinator.test.ts`（overlap 生效、declared 不生效、范围不重叠不冲突）、
  `plan-v2.test.ts`（人工改子集 → commandIds 跟着变、V1 投影同步、空数组回全集、未登记 tag 被拒、
  Confirm 后锁定）、`server.test.ts`（HTTP 路由 200/409/404）、
  `PlanDetailContent.test.ts`（**挂真实组件**验证两个编辑器：勾选 → 保存 → 抛事件、脏值前禁用保存、
  只读态只展示、空词表的说明文案）。
- 浏览器实测：Project 设置的 Execution policy 出现 `Conflict scope` 选择器与两项选项。
- `pnpm verify` 全绿（含循环依赖检查）。

## 2026-10-01 — 线程按天分组、术语统一、任务中心四分区、按 tag 选验证子集

### 为什么做

上一轮记了四项"未做"，本轮补齐。过程中发现两件事值得单独说明：

1. **`explorerTimestampTitle` 是多余的**（同日回退）。加它之前我以为"以创建时间命名"没实现，
   实际上 `placeholderExplorerTitle` / `composeExplorerTitle` **本来就是"项目简称-日期-时间"**，
   首条消息后还会升级成"时间-内容摘要"。我的改动反而把内容摘要那一半关掉了，所以整个回退，
   只在 `ExplorerService.create` 里保留原样。**需求本来就满足，且比我的实现更好。**
2. **Project 设置页保存会丢命令字段**：`ProjectSettingsView.settingsPayload` 只回传
   `commandId/argv/environment`，于是 `category`/`enabled`/`description`/`timeoutMs` 在保存时被抹掉，
   而 `defaultVerificationCommandIds` 仍指向那些命令 → domain 校验直接 409
   （"must be an enabled verification command"）。顺带修掉，否则新加的 tags 也会被同样抹掉。

### Changed

**任务中心四分区（共享一份定义）**
- 新增 `utils/taskBuckets.ts`：`taskBucketFor` / `countTaskBuckets` / `filterTasksByBucket` +
  `TASK_BUCKETS`（待执行 / 执行中 / 已完成 / 待处理）。判定**同时看 Plan 状态与 dispatch 状态**
  （排队等容量时 Plan 仍是 DISPATCHED，只看 `status` 会错报成"待执行"）。
- `PlanCenterPanel`：原来是**藏在下拉里**的状态筛选，现在是四个**看得见的**分区按钮（带数量），
  与 `全部` 并列。
- `WorkbenchView`：左侧列表加同一组分区按钮（此前没有任何分区），列表与计数一起按档过滤；
  空状态文案区分"这一档为空"与"还没有任务"。

**ThreadRail 按天分组**

- `utils/explorerGroups.ts`：按**创建日**分组（今天 / 昨天 / 具体日期；缺失或坏时间戳归"创建时间未知"），
  摊平成"日期头 + 行"供模板一次渲染。按本地日期算日键（不用 UTC 的 `toISOString().slice(0,10)`，
  东八区晚上会把"今天"算成"昨天"）。
- **组按日期倒序、组内保持原顺序**：线程列表按最近活动倒序、组名却是创建日，不排组会出现
  "9-26、9-25、9-27" 这种看着像坏了的顺序。**这条是浏览器实测发现的**（DOM 断言拿到的组序不对），
  单测当时只覆盖了"组内顺序"，没有覆盖"组间顺序"——已补用例。

**术语统一（web 文案与注释，不动 API / 领域命名）**

- 三层命名固化在 `utils/taskTree.ts` 的文件头：**需求**（ExplorerPlan）/ **方案**（Plan、Revision）/
  **任务**（已确认并进入调度的方案）/ **执行步骤**（契约里的 `contract.tasks`）。
- 逐处改掉的混用：`Tasks & dependencies` → 执行步骤与依赖、`暂无执行任务`/`Plan task` →
  执行步骤、`任务关联未记录` → 未关联执行步骤、需求清单表头 `Plan 状态`/`结构化 Plan` →
  方案状态/方案契约、候选卡的 `Tasks` 计数 → 执行步骤、项目执行会话标题不再叫"项目任务"。

**`verification.suites`：按 tag 选验证子集**

- `RegisteredCommandDefinition.tags` 新增（只对 verification 命令有意义）；Project 设置与
  `config.project.commands` 都能声明；domain 校验拒绝重复、带空白和空字符串的 tag。
- `GeneratedPlanSpecV2.verification.suites?: string[]` 新增：**模型只能声明 tag 词表**，
  仍然不能指定命令 ID。与 `mode: "NONE"` 互斥（MODE_CONFLICT），空数组也是无效写法。
- Factory 解析规则（`selectVerificationCommands`）三条都是"宁可失败也不静默改语义"：
  没声明 → 项目默认全集；声明了未登记的 tag → 抛错并列出已登记词表；命中为空 → 抛错，
  而不是退化成一个空的验证集。**解析后的 `commandIds` 才是执行事实**，请求过的 suites
  留在 `generatedSpec` 里可审计。
- tag 词表通过**仓库上下文**注入 Explorer 回合（`RepositoryContextCache` 新增
  `Verification tags: …` 一行，只给 tag、不给命令 ID），缓存键含 configHash，改配置即失效。
- 控制台：两个设置入口的命令编辑器都加 `Verification tags`（逗号分隔）；Plan 详情在
  VERIFICATION 一格上标出"按 tag 选子集"。

### 未做

- 「Explore 的 Plan 详情里直接编辑 suites」没做：那需要浏览器端的 Plan 草稿编辑能力（当前只有
  Confirm 前的 RevisionDraft 流程），超出本轮范围。要改 suites 目前是让 Explorer 重新产出方案。

### 验证

- `vitest run packages/domain` **303 通过**；`vitest run apps/api` **95 通过**；
  `apps/web` 下 `vitest run` **433 通过**；三个 typecheck（domain / api / vue-tsc）无错误。
- **浏览器实测**（`apps/web/dist` + 验收库 / Project3 的真实数据）：Workbench 任务中心四档计数
  `全部 8 / 待执行 0 / 执行中 0 / 已完成 0 / 待处理 8`，点"已完成"后列表清空并显示新文案；
  Explorer 线程列表按 `2026-09-27 (2) / 2026-09-26 (1) / 2026-09-25 (1)` 分组；需求清单表头为
  需求名称 / 方案状态 / 方案契约 / 任务状态；375px 窄屏下分区按钮不溢出。
- 新增用例：`utils/taskBuckets.test.ts`（4）、`utils/explorerGroups.test.ts`（6）、
  线程按天分组的组件用例、任务中心四分区的组件用例（数量 + 点筛选）、
  `plan-v2.test.ts` 的 suites 解析（子集/顺序/未知 tag/命中为空/空数组/NONE 冲突）、
  `project.test.ts` 的 tag 校验、`repository-context-cache.test.ts` 的词表注入（且不含命令 ID）。
- `pnpm verify` 全绿（domain 303 / api 95 / web 434）。**本轮抓到并修正一处被 stale dist 掩盖的回归**：上一轮改了 `ExplorerService.create` 的标题规则，
  但 API 测试跑的是未重建的 domain `dist`，所以当时"47 通过"是假象；重建后才暴露。
  该改动已随本轮回退，API 用例恢复原断言。

## 2026-09-29 — 容量闸门接回活路径、今日活动、合并后回收 Worktree、探索线程按时间命名

### 为什么做

调度里有两类"死状态"和两处"只增不减"：

- `WAITING_PROJECT_CAPACITY` / `WAITING_GLOBAL_CAPACITY` 在联合类型里声明、在前端有文案与测试
  （`statusVisual.ts`），但 `PlanDispatchCoordinator.evaluateWait` **从来没有容量判定**，
  也没有任何代码抛 `concurrency limit reached`；`Scheduler.globalConcurrency()` 恒返回 `undefined`
  且被标 deprecated，`maxParallelRuns` 也标了 deprecated。选项 `globalConcurrency` 声明了却没人读。
- 合并后不回收 Worktree：`Scheduler.finish()` 只在取消/显式退出时被调用，而 `confirmMerged`
  只翻 Plan 状态——`storage.worktreeRoot` 因此只增不减。
- Workbench 只能回答"现在有什么"，回答不了"今天做了什么"（原始需求里那条"今日已完成任务清单"）。

### Changed

**容量闸门（行为变化，请留意）**

- `evaluateWait` 新增两段判定：全局活跃 Run ≥ `runtime.globalConcurrency` → `WAITING_GLOBAL_CAPACITY`；
  同 Project 活跃 Run ≥ 冻结快照的 `settings.concurrency.maxParallelRuns` → `WAITING_PROJECT_CAPACITY`。
- 判定顺序（即优先级）固定为：依赖 → 缺命令 → 全局容量 → 项目容量 → 冲突，写进了文件头维护提示。
- **只算占槽位的状态**（`EXECUTION_SLOT_RUN_STATUSES`）：`READY_FOR_VERIFY` / `MERGE_READY` 已经在等人，
  不算在容量内，否则"验证完等合并"的 Run 会堵住后面的 Plan。
- **同一 Plan 同一 Revision 的既有 Run 不与自己抢名额**：那条路径是重试/续跑，算进去会让重试永远排队。
- 缺省的语义是"不限制"：`globalConcurrency` 未传即不限，`revision.projectConfigSnapshot` 缺失
  （旧 Revision）时不做 Project 级判定——**不给缺省编一个数字**，否则升级会悄悄改变历史行为的可重跑性。
- 删掉 `Scheduler.globalConcurrency()` 与 `SchedulerOptions.globalConcurrency`（声明了却没人用），
  以及 `dispatchOne` 里匹配 `concurrency limit reached` 的死分支；`maxParallelRuns` 的
  `@deprecated` 注释改回真实语义。
- **行为变化**：原本"确认即并发跑"，现在会按配置排队。两个用例因此**翻转**——原来断言
  "不设上限"，现在断言"等待并让位"（`dispatch-coordinator.test.ts`）。

**今日活动（新增）**

- `projections/activity.ts` + `GET /api/v4/projects/:projectId/activity?date=`：四组事实 ——
  **今日执行完成**（当天首次进入 MERGE_READY）、**今日已合并**（当天进入 MERGED）、
  **今日失败或阻塞**、**跨日仍在运行**。只读事件与 Run，**不新增表**。
- 执行完成与人工合并是两个时点，界面上分开显示——只统计"今日已合并"会把"跑了但没合"整个漏掉。
- 按**本地时区**切天；`2026-02-31` 这类会被 `Date` 静默滚动的输入被拒绝，而不是汇报一个别的一天。
- Workbench 顶部加「今日」条（四格 + 前 5 条可点进对应 Plan）；取不到时降级为一行提示，不阻塞整页。

**合并后回收 Worktree（新增）**

- `Scheduler.releaseWorkspace(runId, hooks)`：删 Worktree（**分支保留**）+ 跑一次 cleanup hook，
  **不改任何状态**；失败只写 `attentionReason` 与 journal。
- `confirmMerged` 成功后由 Merge 路由调用它，回收结果随响应返回。
- 幂等：成功后清空 `run.workspacePath`；目录本就不存在时算作已回收（`finish()` 可能先删过），
  不会把"已经没了"报成失败。

**探索线程按时间命名（已回退，见 2026-10-01 条目）**

- `explorerTimestampTitle()` + `ExplorerService.create` 的默认标题改为**创建时刻**
  （本地 `YYYY-MM-DD HH:mm`），并按 `MANUAL` 落库——时间就是它的名字，不再被自动起标题覆盖。
  显式传入的标题仍然优先。
- **同日回退**：既有机制本来就是「项目简称-日期-时间」，首条消息后升级成「时间-内容摘要」；
  这次改动把内容摘要那一半关掉了，属于把已满足的需求改坏。现已还原为原样，只在
  `ExplorerService.create` 里保留不变。ThreadRail 的按天分组（下一轮）与它无关，保留。

### 未做（明确记账）

- 3.4 的界面部分（ThreadRail 按"今天 / 昨天 / 更早"分组）与 3.5 术语统一、3.6 任务中心四分区：
  均为纯界面改动，本轮未做。
- 2.4 冲突键派生策略、2.5 `verification.suites` 按 tag 选验证子集：见上一条 CHANGELOG 的记账。

### 验证

- 定向用例全绿：`dispatch-coordinator.test.ts`（15，含 3 条新容量用例）、`m3-run.test.ts`（13，
  含 `releaseWorkspace` 的回收/幂等/分支保留）、`projections/activity.test.ts`（4）、
  `explorer-service.test.ts`（6，含时间命名）、`apps/api/src/server.test.ts`（47）。
- 当时 `pnpm verify` 被权限分类器拦截，改为逐项跑（三个 typecheck + 三个测试包）；**后经用户授权
  重跑聚合命令，同一份代码全绿**：domain 303 / api 95 / web 434，无新增值级环。

## 2026-09-29 — Plan 契约去掉"会说谎的字段"，依赖闸门变成可达

### 为什么做

`GeneratedPlanSpecV2` 是「模型能声明什么」的契约，但其中几个字段**填了也没有消费方**：

- `execution.executorModelRole` / `toolPolicy`：执行侧读的是 Project 快照里的 executor 配置
  （`ExecutorAgent.executorModelConfig`），从不读它们；界面却把它们当 "Execution policy" 展示。
- `tasks[].status`：从来没有任何代码推进过它，Workbench 却按实时状态显示恒定的 `READY`。
- `dependsOnPlanIds`（V1 契约字段）：V2 的投影**恒填 `[]`**，于是 `dispatch-coordinator` 里那两道
  真实的闸门（`WAITING_DEPENDENCY` 要求前置 Plan 已 MERGED、`WAITING_CONFLICT` 取冲突键交集）
  **有一半从 Explorer 侧不可达**——模型不知道 plan id，V2 契约里也没有对应字段。

### Changed

- `GeneratedPlanSpecV2.execution` 只保留 `maxRepairAttempts`；执行角色与工具策略由
  `resolvePlanContractV2` 以常量 `EXECUTOR_ROLE` / `EXECUTOR_TOOL_POLICY` 固定填进
  `ResolvedPlanContractV2`（下游 `PlanContract` 投影与审计视图不受影响）。
  校验器对这两个键**接受但忽略**（不报 FORBIDDEN）：库里已有的 CandidatePlan 带着它们，
  报错会让旧数据连 confirm 都过不去。prompt、`EXPLORER_PLAN_REQUIREMENTS.optionalFields`
  与 web 侧 fallback 副本三处同步更新。
- `PlanTaskShape` 新增并注明 `status` 是**计划态**；prompt 不再示范、Workbench 的
  "Execution tasks" 改为 "Approved plan steps" 并说明每步实际进度在 Run 日志里
  （`Open Run` 查看），不再把一个恒为 READY 的字段显示成实时状态。
- **跨 plan 依赖改为 Factory-owned 且可达**：新增 `PlanService.setDependencies()` 与
  `PUT /api/v4/plans/:planId/dependencies`，只允许在 Confirm 前设置，合法性复用 Confirm 的
  那套规则（未知 id / 自环 / 环）。界面在 Plan 详情抽屉里加 "Prerequisite plans" 选择器
  （候选来自本项目其他 Plan），候选态且非历史版本时才可编辑。
- **删掉 `confirm()` 里那段"净化"启发式**：它把「恰好出现在自然语言先决条件里的 id」从
  `dependsOnPlanIds` 中剔除——那既会删掉用户显式设置的依赖，也让依赖语义取决于文本巧合。
  现在只校验不动数据：引用未知 Plan 会在 confirm 时明确失败。**这是一处行为变化**：
  若历史数据里 `dependsOnPlanIds` 被自然语言污染过，confirm 会报 `unknown plan`，
  在 Plan 详情的依赖编辑器里清掉即可。
- 新增 `utils/planContract.ts`（web）：界面读 Plan 契约的唯一入口，固定
  `resolvedContract → generatedSpec → contract` 的取值顺序。Workbench inspector 改用
  `planContractView()`，不再优先读那份**有损投影** `contract`（它的 `dependsOnPlanIds` 恒为 []）。

### 未做（明确记账，不是遗漏）

- `verification.suites`（按 tag 选验证子集）：需要 Project 命令加 `tags`、spec 加字段、
  并把可用 suites 注入 Explorer 回合（现有 prompt 是静态常量，得走仓库上下文那条通道）。
  半成品比没有更糟——留待下一轮。
- `conflicts`（冲突键）由 includePaths 派生的策略：模型声明的语义键已经可用且可审计，
  派生规则会改变串行度（保守方向），值得单独设计 + 可配置，不与本轮混在一起。

### 验证

- `pnpm verify` 全绿（domain 294 / api 90 / web 422）。
- 新增 domain 用例：自然语言先决条件仍进 `design.technicalConstraints` 且**不再被静默删除**；
  `setDependencies` 的正常路径、Confirm 后拒绝修改、未知 id 与自环被拒绝。
- 新增 HTTP 用例：`PUT /plans/:planId/dependencies` 保存成功、未知依赖映射 409、未知 Plan 映射 404。

## 2026-09-29 — 多后端：探索与执行各用一个 agent（按角色路由）

### 为什么做

「探索用强模型、执行用便宜模型」这件事此前**只能表达一半**：`model.backend` 是进程级单选，
一个 `ModelGateway` 实例被 Explorer、Scheduler/Executor、ProjectExecutionThread 和分支名生成器
共用（`server.ts` 一处构造、四处消费）。想「探索走 Codex、执行走 Claude（DeepSeek 兼容端点）」，
在旧结构里没有第二种写法。Project 级的 `settings.models.<role>` 也只能改模型名与推理强度，
改不了 agent。

### Changed

配置层（`apps/api/src/config.ts`）：

- `model.roles.<role>.backend` 新增：**这是"探索用 Codex、执行用 Claude"的唯一开关**，取值是
  后端 id（字符串，不是 enum）。缺省跟随 `model.backend`。
- `model.backends` 新增具名后端注册表；`backendEntrySchema` 与 `codexAppServer` / `claudeAgent` /
  `openai` 共用同一份字段定义，避免"注册表里少一个字段"这类分叉。**整块缺省是合法且常见的用法**：
  四个 kind 名本身就能当 id 用，端点由那三块兼容配置提供。注册表只在需要「同类两个不同端点」时才用。
- `resolveModelBackends()` / `roleBackendId()` 新增：把配置解析成"id → 后端定义"，并校验
  **每个角色引用的 id 都能解析**，不可解析则启动期抛错并列出可用 id。
- **迁移改成按角色各自判定**（`migrateForeignFamilyModels` 的 `familyForRole`）：旧实现用单一家族
  判定，在 explorer=codex + executor=claude 下会把其中一个角色**正确**的 slug 改坏。另外，
  **Project 显式写了 `backend` 的角色一律不迁移**——那是用户有意的选择，该由 Provider 侧报错暴露。
- server 的 `bootstrapLegacy` **不再把 `backend` 抄进种子 Project**：抄进去等于让该项目从此脱离
  "跟随全局"，连家族迁移都会跳过它。

领域层（`packages/domain`）：

- `ModelRoleConfig.backend` 新增。**这是让"项目级覆盖 agent"零管道生效的支点**：explorer 侧已经
  `modelConfigForProject` 整块传入项目设置、executor 侧已经 `{...configFor("executor"), ...snapshot.settings.models.executor}`
  合并，所以覆盖不需要新的传递路径。
- `ModelGateway.capabilities(role, config?)` 与 `describeEndpoint(role?)` 加可选参数。**不修的后果很具体**：
  全局 executor=codex（支持两种 Loop 模式）、某 Project 覆盖为 claude（只支持 provider-controlled）时，
  按角色默认判定会放过 factory-controlled 配置，失败被推迟到第一次模型调用。
- `ProjectSettings.models.<role>.backend` 与 `ModelBackendCatalog` 新增；有目录时校验后端 id 与
  该后端的推理强度。**`backend: null` 表示"清除覆盖、跟随全局"**——不区分它的话，控制台第一次保存
  就会把当前全局后端固化进 Project。
- `ExecutionTelemetry.backend` 新增（可选，旧行为 null）：这次 Run 由哪个 agent 执行，取自
  `agent.loop.started` 的端点指纹。与 `model` 是两件事——同一个模型名可能来自不同后端。
- `ProjectExecutionThreadSnapshot.backend` 新增（只读展示）与其模型/推理强度目录改为**按该项目 executor
  后端**提供（`modelCatalogForProject`）；`updatePreferences` 的校验与给出的选项**同源**，
  消掉"下拉里有、选了却被拒"的死路。

组合根（`apps/api`）：

- `RoutingModelGateway` 新增：按"请求覆盖 → 角色默认 → 全局默认"解析后端并委派。
  `answerUserInput` 按 Provider 发出的 requestId 反查归属，**查不到就抛错**（静默丢弃会让模型一直等输入）；
  `cancel` 查不到归属则**广播**给已实例化的后端（漏掉一次取消会留下还在跑的 Provider turn）。
  `describeEndpoint()` 不传角色且两角色指不同后端时返回 `backend: "mixed"`——**如实回答，不假装成某一个**。
- **角色默认后端在启动期构造**（`warmUp`），注册表里没被引用的后端保持懒构造。这条是启动验证时
  现场发现的回归：懒构造单独用会把"缺 `codexAppServer` 块"从启动期失败推迟成第一次 `/health` 500。
- `apps/api/src/runtime/model-catalog.ts` 新增：`GET /api/v4/model-backends` 的投影与
  `ModelBackendCatalog` 的数据源。模型清单只驱动控制台下拉（Factory 不知道 provider 支持什么），
  推理强度**由后端决定、不是建议**（Claude 侧只透传 5 个取值）。`/health` 增加 `modelBackends`，`modelBackend`
  保留为 explorer 生效后端的兼容键。

控制台（`apps/web`）：

- Project 设置页与设置弹窗各加一个 **Agent 选择器**（`Explorer agent` / `Executor agent`），
  模型与推理强度的候选项跟着所选后端变；空值显示为"跟随全局（<生效后端>）"，保存为 `backend: null`。
- `utils/modelOptions.ts`（一份写死的 Codex 模型清单）删除，换成 `utils/modelCatalog.ts`
  + `composables/useModelBackends.ts`（模块级缓存一次目录）。未知的已配置模型**永远保持可选**。
- 用量栏新增 **AGENT** 一格（`ProviderUsageFooter` 的可选 `backend` prop）：Explorer 侧取
  Project 覆盖后的探索后端，Run 侧取遥测里的 `backend`。"这一轮到底是谁跑的"在页面上第一次有了答案。

### 验证

- `pnpm verify` 全绿（domain 293 / api 85 / web 421，无新增失败，无新增值级环）。
- 新增 `RoutingModelGateway` 单测 12 条（分派、请求覆盖、输入/取消归属、mixed 指纹、懒构造与释放、
  启动期失败与"未被引用的后端不拖垮启动"）。
- 新增 `apps/api/src/server.test.ts` 的 HTTP 集成用例：双后端配置下 `/health` 返回
  `modelBackends: { explorer: codex-app-server, executor: deepseek }`、`/api/v4/model-backends`
  给出注册表后端的模型与推理强度。
- 真机启动验证：用 `/tmp/pf-routing/config.json`（explorer=codex、executor=deepseek）启动，
  `/api/v4/model-backends` 输出符合预期；把 `codexAppServer` 块去掉后**启动即失败**（与改动前一致）。
- **未做真机模型调用**：本机 Codex 刷新令牌已过期、DeepSeek 端点也没有可用凭据，因此
  "一次探索回合真的打到 Codex、一次 Run 真的打到 DeepSeek"这条链路没有实测，只有分派逻辑的单测。

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
但它的主体是 `sendTurn`——**全应用最热的路径**（回合的抢先显示、SSE 重试、失败重发、按需求暂存草稿）。
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
- 启动期这套逻辑新增 1 条用例（`store-startup-repair.test.ts`）：不配置回收时一条不删、配置后只删白名单内那条、且删完追加的事件序号仍大于历史。用独立连接直接写库造"2020 年的事件"，因为 `appendEvent` 给不出过去的时间戳。
- `store-startup-repair.test.ts` 的 `corrupt()` 改名 `runRawSql()`：它在本文件里多数时候确实在制造损坏，但回收那组用例只是用它塞一条旧事件，用 `corrupt` 会让那句读起来像在"制造损坏"。

## 2026-09-28 — Explorer 活动取数去重，并把"产出依赖逐条增量"这个事实钉住（B1 的结论）

### 结论：B1 作为"等价优化"不成立，改为记账 + 加守卫

原计划是"正文改取 `explorer_turns.content`，只取每个 loop 最后一条增量步骤"，理由是
`content` 已经是增量的逐字拼接、投影真正还需要的是 `providerItemId`/`occurredAt`/排序序号。
**这个前提是错的。** `projectExplorerActivity` 的产出确实依赖逐条 `MODEL_TEXT_DELTA`，两处：

- **卡片数量**取决于增量步与非增量步的先后。相邻增量合并进同一条 `ASSISTANT_MESSAGE`，但中间只要夹了任何其它步骤（工具、门禁、Provider 活动）就会另起一条。一个回合有几张助手卡片，拿拼好的 `content` 分不出来。
- **合并后那张卡片的 `occurredAt` 与排序序号取的是第一条增量**（它参与最终按 `occurredAt` 的排序，换成最后一条会改变该卡片与其它活动的相对顺序），而挂在那张卡片上的 `providerItemId` 取的是最后一条非空增量。两个值 `content` 里都没有。

所以"只取最后一条增量"与"改读 `content`"都会改变可见产出，不是等价优化。真要收敛，得让**写侧**按"文本段"落一条事实（见 `agent/agent-loop.ts` 的 `flushTextDelta`），而不是在读侧猜。本次不硬做。

### Changed

- `routes/explorers.ts` 的两处活动取数（workspace 快照与 activity 时间线）原本是逐字重复的四行查表，抽成 `planActivityInput`。抽出来的主要目的是**给上面的结论一个落点**——两处各写一遍注释必然会漂移，而且这段代码正是下一个想"优化掉步骤读取"的人会盯上的地方，提示必须写在他看得见的位置。

### Added

- `explorer-activity.test.ts` 新增两条用例，把上面两个事实钉住：增量之间夹了非增量步骤会另起一张卡片（且用例把 `turn.content` 设成两段增量的完整拼接，正是为了说明"有 content 也分不出来"）；合并后卡片的时间取第一条增量、`providerItemId` 取最后一条非空增量。**这两条不是描述理想行为，而是守卫**——谁想按原计划那样优化，先让它们变绿。

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
- API 冒烟检查：health、Project、Explorer、ExplorerPlan、workspace 和 Plan 这些接口均返回成功；跨项目访问按预期拒绝。
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
