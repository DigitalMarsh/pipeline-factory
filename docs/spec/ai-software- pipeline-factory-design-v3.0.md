# AI Software Pipeline Factory 设计规格

> 版本：v3.0
> 状态：设计基线
> 日期：2026-08-26
> 前置基线：`ai-software- pipeline-factory-design-v2.0.md`

## 1. 目标与边界

v3 将 Pipeline Factory 从“原生 Agent Runtime + 执行流水线”继续升级为“ExplorerThread-first 的 TypeScript 软件交付控制台”。Factory 内部完成长期项目探索、Plan Mode、计划确认、计划下发、隔离执行、验证、审查和人工合并确认。

主链路：

~~~text
Project ExplorerThread
        │ Plan Mode / repository read-only facts
        ▼
CandidatePlan
        │ validate + user confirm
        ▼
PlanRevision ── enqueue ──► Scheduler
                              │
                              ▼
                    Run / Worktree / Branch / Lease
                              │
                              ├── start hook
                              ├── ExecutionThread
                              ├── ExecutionJournal
                              └── ToolGateway + Executor
                              │
                              ▼
                         Verifier
                              │
                              ▼
                 Review / MergeRequest / human merge
                              │
                              ▼
                           MERGED
~~~

### 1.1 必须满足

- Factory 后端、CLI、Scheduler、Agent Runtime、ToolGateway 和 Verifier 全部使用 Node.js + TypeScript。
- 前端使用 Vue 3、Vite、TypeScript 和 Element Plus。
- Factory 本身不使用 Python；受管项目可以保留自身技术栈，并通过注册命令和生命周期脚本接入。
- 每个项目默认拥有一个长期 ExplorerThread，ExplorerThread 可以连续产生多个 Plan。
- ExplorerThread 只拥有 Plan Mode 和仓库/Git 只读工具，不拥有 Worktree、Run、写入、命令执行或提交权限。
- 每个 Run 固定一个不可变 PlanRevision、一个 Worktree、一个 Branch、一个 ExecutionThread 和一组生命周期执行记录。
- 每个项目可以配置可选的 start 和 cleanup 生命周期脚本。
- start 在 Worktree 创建并校验成功后立即执行；配置了 start 但执行失败时 Run 不得进入 Executor。
- cleanup 在 Worktree 删除成功后执行；配置了 cleanup 但执行失败时生成 Needs Attention。
- 可以查询当前 ExplorerThread 及其 parent/successor 线程谱系下已下发的 Plan 清单和每个 Plan 的权威状态。
- 验证由 Factory 的 Verifier 执行，不以模型响应、会话结束或页面可见性作为成功依据。
- 只有验证成功、提交证据完整并人工确认目标 Commit 后，Plan 才能进入 MERGED。

### 1.2 默认运行边界

- 本地单用户控制台。
- Node.js + TypeScript + Fastify + SQLite WAL + Git Worktree。
- Vue 3 + Vite + TypeScript + Element Plus。
- 全局并发默认 4，单项目并发默认 2，实际值由项目配置覆盖。
- OpenAI API 为首发模型后端，领域层通过 ModelGateway 隔离具体供应商。
- 验证自动执行，合并人工确认。
- 不自动部署、不自动删除 Branch 或 Worktree、不引入多用户、远程 Worker、消息队列或云端 CI。

### 1.3 明确不做

- 不在 Factory Runtime、脚本工具或验证工具中使用 Python。
- 不依赖外部桌面应用、外部线程可见性、私有 IPC 或外部 Agent 数据库。
- 不把 Plan 中的任意 Shell 字符串直接传给执行器。
- 不允许模型直接写数据库、推进业务状态或修改资源锁。
- 不允许 Executor push、merge、deploy、删除 Worktree 或修改项目配置。
- 不允许执行线程直接扩大 Scope、改变依赖、修改验收标准或替换验证命令。
- 不承诺直接读取 v2 Plan Artifact；v3 通过显式版本转换或人工重建进入 v3 Schema。

## 2. 技术架构

### 2.1 技术栈

| 层 | 技术 | 责任 |
|---|---|---|
| Backend | Node.js、TypeScript、Fastify | REST、SSE、Application Service 和本地控制台 API |
| Storage | SQLite WAL、外键、短事务 | Registry、事件、Journal、查询投影和幂等键 |
| Validation | Zod、TypeScript type-check | API、Plan Artifact、配置和 Tool 参数校验 |
| Agent Runtime | ModelGateway、ToolGateway | 模型会话、流式消息、工具策略和本地资源执行 |
| Frontend | Vue 3、Vite、TypeScript、Element Plus | ExplorerThread、Plan Center、Run 和 Review UI |
| Test | Vitest、Fastify inject、Vue Test Utils | 单元、API、状态机和组件测试 |
| Quality | ESLint、Prettier、vue-tsc、Vite build | 静态检查、格式、类型和构建门禁 |

### 2.2 分层规则

| 层 | 组件 | 责任 | 不负责 |
|---|---|---|---|
| Domain | Project、ExplorerThread、Plan、Run、Hook | 实体、不变量、状态转换和领域事件 | 模型、文件、Shell 和 UI |
| Application | ExplorerService、PlanService、RunService、HookService、MergeService | 用例、权限、幂等、事务和状态推进 | 保存页面临时状态 |
| Model Runtime | ModelGateway、ExplorerAgent、ExecutorAgent | 模型会话、流式输出、取消、恢复和上下文摘要 | 直接访问本地资源 |
| Tool Runtime | ToolGateway、ToolPolicy、CommandRunner | 文件、Git、补丁、脚本、命令和进程能力 | 修改业务状态 |
| Infrastructure | SQLite、Git、Process、Clock、Log | 外部 IO、持久化、隔离目录和日志 | 解释业务状态 |
| Verification | Verifier、VerificationRegistry | 确定性验证、结果解析和证据生成 | 修改代码或伪造结果 |
| UI/API | Vue 页面、REST/SSE | 展示状态、发起操作、流式更新 | 绕过 Application Service |

### 2.3 核心原则

1. Registry 是业务事实来源；UI、模型消息和日志摘要不能取代 Registry 状态。
2. ExplorerThread 是项目长期上下文；PlanRevision 是一次不可变执行契约。
3. 模型只能提出工具调用，ToolGateway 决定工具是否允许和如何执行。
4. Verifier 与 Executor 解耦，模型不能伪造验证成功。
5. 已下发 Plan 的查询使用持久化投影，不依赖模型会话在线。
6. 生命周期脚本是项目资源准备/清理钩子，不是 Plan 的自由命令。

## 3. ExplorerThread 设计

### 3.1 长期线程模型

ExplorerThread 是 Factory 的一级长期对象，默认一个项目一个活动线程：

~~~text
FactoryProject
 └── ExplorerThread（active）
      ├── ExplorerTurn[]
      ├── ExplorerSummary[]
      ├── CandidatePlan[]
      ├── PlanRevision source refs
      └── successor ExplorerThread[]
~~~

规则：

- ExplorerThread 不等同于某次模型会话；模型会话可被替换，逻辑线程 ID 不变。
- 每个用户消息、模型响应、只读工具调用和 CandidatePlan 引用追加保存。
- 上下文接近预算上限时，Factory 生成摘要并创建 successor 线程。
- successor 保存 `parent_thread_id`、摘要引用、转移时间和转移原因。
- PlanRevision 保存来源线程和 turn 范围，便于从计划回到原始探索依据。
- ExplorerThread 可以在 Plan 下发后继续产生下一个 Plan，但不能直接修改已确认 Revision。

### 3.2 ExplorerThread 状态

~~~text
CREATED → EXPLORING → WAITING_USER → EXPLORING
             │              │
             ├──────────────► CANDIDATE_READY
             │                      │
             │                      ├→ NEEDS_REVISION → EXPLORING
             │                      └→ CONFIRMED
             │
             └──────────────► COMPACTING → EXPLORING

CONFIRMED → ACTIVE_FOR_NEXT_PLAN
successor  → ARCHIVED
~~~

状态说明：

- `EXPLORING`：可发送 Plan Mode turn，只开放只读工具。
- `WAITING_USER`：等待用户回答、补充约束或确认候选计划。
- `CANDIDATE_READY`：结构化 CandidatePlan 已通过基本检查。
- `NEEDS_REVISION`：CandidatePlan 校验失败或用户要求修改。
- `CONFIRMED`：当前 CandidatePlan 已生成 PlanRevision。
- `ACTIVE_FOR_NEXT_PLAN`：该线程继续作为项目探索入口。
- `COMPACTING`：正在生成上下文摘要，期间禁止并发写入 turn。
- `ARCHIVED`：被 successor 替代或项目明确归档。

### 3.3 Plan Mode 工具边界

Explorer 只允许：

- `repo.list`
- `repo.read`
- `repo.search`
- `git.status`
- `git.log`
- `git.diff`
- `project.inspect`

Explorer 禁止：

- `patch.apply`
- `command.run`
- `git.commit`
- `git.push`
- `git.merge`
- Worktree、数据库和项目配置写入

Plan Mode 必须由状态机、ToolPolicy 和结构化 CandidatePlan 同时约束，不能只依赖系统提示词。

## 4. Plan 与运行流程

### 4.1 计划探索

1. 用户进入项目 ExplorerThread，提交目标和初始约束。
2. ExplorerAgent 读取仓库、配置和 Git 事实，不修改任何文件。
3. 用户继续补充目标、范围、验收、依赖、冲突和验证意图。
4. ExplorerAgent 输出结构化 CandidatePlan。
5. Factory 执行 Schema、路径范围、依赖环、冲突键、基线 Commit 和验证命令检查。
6. 检查通过后，CandidatePlan 在对话时间线中显示为可审阅计划卡片。

### 4.2 确认与下发

确认和下发是两个独立操作：

1. 用户点击 `View full plan` 打开 Plan Detail Drawer。
2. 用户查看 Goal、Scope、Task、依赖、冲突、验证、Executor 和来源 turn。
3. 用户调用 `confirm_plan`，Factory 固定 Artifact hash、base Commit、确认人和确认时间，创建不可变 PlanRevision，Plan 进入 READY。
4. 用户再次复核 READY 计划后调用 `enqueue_plan`，Plan 原子进入 QUEUED。
5. READY Plan 不会自动执行，只有 QUEUED Plan 才能被 Scheduler 选中。
6. 重复确认、重复下发必须由幂等键和状态前置条件保护。

### 4.3 调度与 Worktree

Scheduler 按 `priority DESC、queued_at ASC、plan_id ASC` 选择任务：

1. 检查依赖 Plan 是否全部 MERGED。
2. 检查显式冲突键是否被活动 Run 持有。
3. 检查项目/全局容量、Executor Profile 和 Lease。
4. 检查 base Commit、项目根目录和 Worktree 根目录。
5. 在一个短事务中创建 Run、Assignment、Lease 和资源锁。
6. 创建 Worktree 和 Branch，并登记 base Commit。
7. Worktree 创建成功后立即执行可选 start hook。
8. start hook 成功或未配置后，创建 ExecutionThread 并启动 Executor。

依赖、冲突和容量不足属于等待，不属于失败；条件变化时重新唤醒 Scheduler。

### 4.4 ExecutionThread

每个 Run 一个独立 ExecutionThread，携带：

- PlanRevision 摘要和 Artifact hash；
- 当前 Task、依赖和验收引用；
- include/exclude 和冲突边界；
- Workspace、Branch、base Commit 和 Run ID；
- ToolPolicy、验证命令和禁止操作；
- 最近 Journal Snapshot 和未完成工具调用；
- 用户追加的 `USER_GUIDANCE`。

Executor 必须：

1. 先确认 Workspace、Branch、Run 和 Revision 匹配。
2. 按 Task 依赖顺序执行并写入检查点。
3. 所有工具调用经过 ToolGateway。
4. 只修改批准范围内的文件。
5. 发现范围、依赖或验收不足时创建 ChangeProposal 并暂停。
6. 持续更新心跳、当前 Task 和长时间命令状态。

### 4.5 验证、清理与合并

1. Task 完成后 Run 进入 VERIFYING。
2. Verifier 执行项目登记的验证命令。
3. 验证失败时可在同一 ExecutionThread 中有限修复。
4. 超过 `max_fix_attempts` 后进入 FAILED/BLOCKED。
5. 验证成功后检查 commit、祖先关系、Diff 范围和证据完整性。
6. 生成 Review/MergeRequest，Plan 进入 MERGE_READY。
7. 人工完成目标分支合并后调用 `confirm_merged`。
8. Factory 验证目标 Commit 包含 Run commit，记录合并事件并释放锁。
9. Worktree 清理成功后执行可选 cleanup hook。
10. cleanup 失败时保留主流程终态并创建 Needs Attention。

## 5. 生命周期脚本

### 5.1 项目配置

两个脚本都是选填的逻辑 Hook ID，平台入口由项目配置映射：

~~~yaml
lifecycle:
  start:
    enabled: true
    command_id: project.start
    platforms:
      darwin: project.start.macos
      linux: project.start.linux
      win32: project.start.windows
  cleanup:
    enabled: true
    command_id: project.cleanup
    platforms:
      darwin: project.cleanup.macos
      linux: project.cleanup.linux
      win32: project.cleanup.windows
~~~

HookDefinition 固定：command_id、platform_commands、cwd_policy、timeout、environment_allowlist、network_policy 和 enabled。

### 5.2 start Hook

start 执行顺序：

~~~text
git worktree add
       │
       ▼
validate branch / base commit / workspace
       │
       ▼
execute optional start hook
       │
       ├─ skipped → create ExecutionThread
       ├─ success → create ExecutionThread
       └─ failed  → BLOCKED, no Executor turn
~~~

start 的 cwd 必须是新 Worktree，HookContext 至少包含：

```typescript
type HookContext = {
  projectId: string;
  runId: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  exitReason?: string;
};
```

### 5.3 cleanup Hook

cleanup 执行顺序：

~~~text
review / merge / run terminal state
       │
       ▼
remove Worktree
       │
       ├─ failed → keep cleanup pending + Needs Attention
       └─ success
             │
             ▼
       execute optional cleanup hook
             │
             ├─ skipped → cleanup complete
             ├─ success → cleanup complete
             └─ failed  → cleanup complete with attention
~~~

cleanup 的 cwd 必须是项目主目录或 Factory 指定的稳定目录，不能依赖已删除的 Worktree。cleanup 失败不回滚已完成的合并，但必须支持人工重试。

### 5.4 Hook 事件

- `hook.skipped`
- `hook.started`
- `hook.completed`
- `hook.failed`
- `hook.uncertain`
- `hook.retry_requested`

脚本只能由项目配置登记，不允许从 Plan Artifact 或模型输出注入任意 argv。

## 6. Plan 查询与 Plan Center

### 6.1 查询接口

~~~text
GET /api/v3/projects/{projectId}/explorer-thread/plans
~~~

查询参数：

| 参数 | 说明 |
|---|---|
| `explorerThreadId` | 当前 ExplorerThread ID |
| `includeLineage` | 是否包含 parent/successor 谱系，默认 true |
| `status` | 一个或多个 PlanStatus |
| `q` | title、plan_id、goal 关键词 |
| `from` / `to` | queued_at 时间范围 |
| `cursor` | 游标分页位置 |
| `limit` | 返回数量上限 |
| `sort` | queued_at、last_event_at、priority、status |

只返回已经执行 `enqueue_plan` 的计划，不返回仍在探索中的 CandidatePlan。

### 6.2 类型

```typescript
type PlanQuery = {
  projectId: string;
  explorerThreadId: string;
  includeLineage: boolean;
  status?: PlanStatus[];
  query?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

type PlanIndexRow = {
  planId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  project: string;
  sourceExplorerThreadId: string;
  queuedAt: string;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
};
```

### 6.3 查询投影

Plan 查询从 `plan_query_projection` 读取，不调用模型、不读取执行线程消息，也不依赖 ExplorerThread 在线。状态变化通过事件更新投影，查询接口支持游标分页和稳定排序。

默认排序为 `queued_at DESC、plan_id DESC`。同一 Plan 的状态以 Registry 当前状态为准，事件时间用于展示最后变化。

## 7. 页面信息架构与视觉设计

### 7.1 主页面

主路由：

```text
/projects/:projectId/explorer
```

~~~text
┌─────────────────────────────────────────────────────────────┐
│ 顶部：项目切换 / 全局搜索 / 系统状态 / 用户菜单               │
├───────────────┬───────────────────────────┬─────────────────┤
│ ExplorerThread│ 对话时间线                 │ Thread Context  │
│ 固定左栏       │ Plan Mode 对话             │ 当前 Candidate  │
│               │ Plan 事件卡片               │ Plan 清单投影    │
│ 项目入口       │ Confirm / Enqueue 节点      │ Plan 详情抽屉    │
│ Plan Center   │ Run / Verify / Merge 事件   │                 │
└───────────────┴───────────────────────────┴─────────────────┘
~~~

左侧固定栏：

- 项目选择器和项目状态；
- ExplorerThread ID、状态、消息数、上下文摘要；
- Conversation、Plan candidates、Dispatched plans、Active Runs、Needs Attention；
- Successor threads、Thread memory 和生命周期脚本配置入口。

中间对话区：

- 连续 ExplorerThread 对话；
- `PLAN MODE · READ ONLY` 标识；
- 用户消息、模型消息和只读事实；
- CandidatePlan、确认、下发、执行、验证和合并事件卡片；
- 流式消息、暂停、取消和范围内 `USER_GUIDANCE`。

右侧上下文区：

- 当前 CandidatePlan 摘要；
- 当前线程谱系的已下发 Plan；
- 状态、Revision、Run ID、最近事件时间；
- `View full plan` 打开的详情抽屉。

### 7.2 Plan Detail Drawer

`View full plan` 打开右侧抽屉，不离开 ExplorerThread：

- Plan 标题、ID、Revision、状态；
- Goal 和验收标准；
- Scope include/exclude；
- Task、依赖和验收引用；
- 冲突键；
- Base Branch/Commit；
- Verification 命令；
- Executor 模型角色、ToolPolicy 和修复上限；
- ExplorerThread 来源、turn 区间和 Artifact hash；
- 底部固定操作：Keep editing、Confirm plan、Enqueue plan。

Confirm plan 与 Enqueue plan 必须使用不同按钮和不同状态说明。

### 7.3 Plan Center

页面路由：

```text
/projects/:projectId/plans
```

页面内容：

- 页面标题和项目上下文；
- All、Queued、Running、Verifying、Review、Merged、Blocked 状态统计；
- 搜索、状态、项目、时间和来源线程筛选；
- Plan 表格：ID、标题、Revision、状态、来源 Thread、Run、更新时间、Needs Attention；
- 行点击进入 Plan Detail；
- 跳转 ExplorerThread、ExecutionThread、Verification 和 MergeRequest；
- 明确的 Loading、Empty、Error、Blocked 和无权限状态。

### 7.4 项目 Hook 配置页

页面路由：

```text
/projects/:projectId/settings/hooks
```

页面内容：

- start/cleanup 启用开关；
- 平台入口映射；
- cwd、timeout 和环境变量白名单；
- Hook 测试按钮；
- 最近 HookExecution；
- 失败原因和 Needs Attention 入口。

### 7.5 视觉规范

- Element Plus 作为组件基础，通过 Design Tokens 覆盖默认后台样式。
- 深色固定导航栏、浅色工作区和白色内容面板。
- 蓝色表示活动，绿色表示成功，琥珀色表示等待，红色表示失败，灰色表示归档。
- 状态同时使用颜色、文字和图标，不能只依赖颜色。
- Confirm、Enqueue、Cancel 同时出现时只能有一个视觉主按钮。
- 抽屉、时间线、Plan 卡片和表格统一间距、圆角、阴影和键盘焦点。
- 窄屏折叠右侧面板，移动端改为页面切换，不强行维持三列。
- 支持 `prefers-reduced-motion`，所有重要操作有键盘焦点状态。

## 8. 公共接口与服务

### 8.1 ModelGateway

```typescript
interface ModelGateway {
  startSession(input: StartModelSessionInput): Promise<ModelSession>;
  sendTurn(input: SendModelTurnInput): AsyncIterable<ModelEvent>;
  cancel(sessionId: string, reason: string): Promise<void>;
  resume(sessionId: string, snapshot: SessionSnapshot): Promise<ModelSession>;
  compact(sessionId: string, journal: JournalSlice): Promise<SessionSnapshot>;
}
```

Explorer 和 Executor 使用不同 role、model_profile、context 和 ToolPolicy。

### 8.2 ToolGateway

```typescript
interface ToolGateway {
  describe(policyId: string): Promise<ToolDescriptor[]>;
  invoke(input: ToolCallInput): Promise<ToolResult>;
  cancel(callId: string, reason: string): Promise<void>;
}
```

ToolGateway 在执行前校验角色、Run、Workspace、路径、命令 ID、参数、超时、环境白名单、进程归属和幂等键。

### 8.3 生命周期与查询类型

```typescript
type ProjectLifecycleHooks = {
  start?: HookDefinition;
  cleanup?: HookDefinition;
};

type ExplorerThread = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  state: ExplorerThreadState;
  messageCount: number;
  summaryRef: string | null;
  lastActivityAt: string;
};

type PlanQuery = {
  projectId: string;
  explorerThreadId: string;
  includeLineage: boolean;
  status?: PlanStatus[];
  query?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};
```

### 8.4 Application Service 操作

- `create_explorer_thread`
- `send_explorer_turn`
- `validate_candidate_plan`
- `confirm_plan`
- `enqueue_plan`
- `list_thread_plans`
- `get_plan_detail`
- `pause_run`
- `resume_run`
- `add_user_guidance`
- `approve_change_proposal`
- `confirm_merged`
- `test_project_hook`

所有接口都使用严格状态前置条件或幂等键，UI 不允许直接写 Registry。

## 9. 持久化、事件与恢复

### 9.1 表集合

~~~text
factory_projects
features
explorer_threads
explorer_turns
explorer_summaries
candidate_plans
plans
plan_revisions
plan_dependencies
plan_tasks
project_lifecycle_hooks
hook_executions
runs
run_tasks
executor_slots
assignments
workspaces
execution_threads
execution_journal
change_proposals
tool_calls
verification_runs
reviews
merge_requests
plan_query_projection
resource_locks
factory_events
idempotency_keys
~~~

### 9.2 关键约束

- 一个项目只有一个活动 ExplorerThread；successor 通过 parent_thread_id 关联。
- `plan_revisions(plan_id, version)` 唯一。
- `runs(plan_revision_id, attempt)` 唯一。
- `execution_threads(run_id)` 唯一。
- `hook_executions(run_id, hook_type, attempt)` 唯一。
- `idempotency_keys(scope, key)` 唯一。
- `resource_locks(resource_key)` 只允许一个活动持有者。
- ExecutionJournal、ExplorerTurn 和 FactoryEvent 只能追加。
- 所有外键启用 `PRAGMA foreign_keys = ON`。

### 9.3 事件

至少覆盖：

- `explorer.thread_created`、`explorer.turn_completed`、`explorer.summary_created`；
- `candidate_plan.created`、`candidate_plan.validated`、`candidate_plan.rejected`；
- `plan.confirmed`、`plan.enqueued`、`plan.superseded`；
- `run.created`、`run.dispatched`、`run.paused`、`run.resumed`、`run.cancelled`、`run.stale`；
- `hook.skipped`、`hook.started`、`hook.completed`、`hook.failed`、`hook.uncertain`；
- `execution_thread.started`、`execution_thread.waiting_input`、`execution_thread.failed`；
- `tool.requested`、`tool.denied`、`tool.completed`、`tool.failed`、`tool.uncertain`；
- `change_proposal.created`、`change_proposal.approved`、`change_proposal.rejected`；
- `verification.started`、`verification.failed`、`verification.passed`；
- `commit.created`、`review.completed`、`merge.confirmed`。

### 9.4 恢复流程

服务启动时：

1. 扫描活动 Run、Assignment、Lease、ExplorerThread、ExecutionThread 和 HookExecution。
2. Lease 过期的 Run 进入 STALE，保留资源引用和最后事件。
3. 未确定的 ToolCall/HookExecution 先检查实际文件、进程和 Worktree，不直接重放。
4. 使用 ExplorerSummary 和 Journal Snapshot 恢复上下文。
5. 无法证明资源或副作用状态时进入 RECOVERING/BLOCKED，并生成 Needs Attention。
6. 清理脚本失败时允许单独人工重试，不重复执行 start。

## 10. 安全与资源治理

- OpenAI API 密钥只由 ModelGateway 管理，不写入模型普通消息或 Journal。
- 项目环境变量采用白名单，禁止传入完整宿主环境。
- 默认关闭外网访问，网络验证必须显式配置。
- ToolGateway 对角色、路径、命令、进程、Workspace 和 Run 逐项授权。
- 模型输出中的 Shell、路径、链接和脚本均视为不可信数据。
- 日志、消息、Diff 和 Hook 输出中的密钥、令牌、Cookie 和个人信息在持久化前脱敏。
- Hook、Lease、心跳、进程树和 Workspace 映射必须可查询。
- 不自动清理 Workspace、Branch 或 Journal；清理必须是独立、可确认操作。

## 11. MVP 开发分期

### M0：TypeScript 工程与 v3 Schema

建立 Node.js + TypeScript + Fastify + SQLite + Vue 3 + Vite + Element Plus 工程；定义 v3 Schema、领域类型、状态机、Hook 类型、PlanQuery 和事件模型。

验收：Factory 运行时和脚本工具无 Python 依赖；非法计划、越界范围、未登记命令和非法 Hook 配置均被拒绝。

### M1：ModelGateway 与 ToolGateway

实现 OpenAI API 首发适配、角色模型配置、流式事件、Explorer 只读工具、Executor 受控工具、路径检查、命令注册和审计。

验收：Explorer 无法写文件或执行命令；Executor 无法越权访问路径、push、merge、deploy 或项目配置。

### M2：ExplorerThread 与 Plan Mode

实现每项目长期 ExplorerThread、只读 Plan Mode、CandidatePlan、确认冻结、下发和 successor thread。

验收：用户可以多轮探索；未确认 CandidatePlan 不能下发；PlanRevision 可追溯来源线程和 turn 区间。

### M3：Scheduler 与生命周期脚本

实现依赖、冲突、容量、Lease、Worktree、Run、start/cleanup Hook、ExecutionThread、ExecutionJournal、暂停/恢复、用户指导和 ChangeProposal。

验收：Worktree → start → Executor 和 Worktree 删除 → cleanup 顺序正确；start 失败阻断，cleanup 失败告警；服务重启可恢复。

### M4：Verifier、Plan 查询与 Merge

实现确定性验证、有限修复、提交证据、Plan 查询投影、Plan Center API、Review/MergeRequest 和人工 confirm_merged。

验收：查询正确覆盖线程谱系；验证失败按上限重试；没有有效提交或目标 Commit 不匹配时不能进入 MERGED。

### M5：Vue 控制台

实现固定左侧 ExplorerThread 栏、时间线 Plan 卡片、Plan Detail Drawer、Plan Center、项目 Hook 配置页和 Run/Verification/Merge 详情页。

验收：桌面、平板和窄屏布局稳定；状态、错误、空状态、键盘焦点和可访问性符合规范。

## 12. v2 到 v3 的迁移

| v2 概念 | v3 处理 |
|---|---|
| ExplorerSession | 升级为长期 ExplorerThread |
| 外部或临时执行线程 | 保留为 Factory 管理的 ExecutionThread |
| v2 PlanRevision | 显式转换为 v3 PlanRevision，保留 hash 和来源信息 |
| 运行时配置 | 替换为 Node/TypeScript ModelGateway 和 ToolGateway |
| 外部 Thread 依赖 | 删除，Factory Registry 成为唯一事实来源 |
| 项目 setup 命令 | 拆分为 start Hook、registered verification command 和 Executor 工具 |
| Worktree 清理 | 增加 cleanup Hook，清理后执行并记录结果 |
| Plan 列表 | 增加线程谱系查询和 `plan_query_projection` |
| Dashboard | 改为 ExplorerThread-first、Plan Center 和详情抽屉 |

v3 不直接读取旧版本 Artifact；历史数据如需保留，必须经过显式转换并标记 schema 来源。旧运行记录不能作为 v3 活动 Run 的恢复来源。

## 13. 验收标准

### 13.1 技术栈

- Factory 后端、CLI、Runtime、Scheduler、ToolGateway 和 Verifier 使用 TypeScript。
- Factory 运行时、脚本工具和测试不依赖 Python。
- Vue 3/Vite/TypeScript/Element Plus 前端可以完成类型检查、测试和构建。

### 13.2 ExplorerThread 与 Plan

- 每个项目默认只有一个活动 ExplorerThread。
- successor thread 保留 parent 关系、摘要和历史来源。
- Plan Mode 阶段不能写文件、执行命令、测试或提交。
- CandidatePlan 未通过检查和用户确认时不能生成可调度 Revision。
- PlanRevision 保存来源 ExplorerThread、turn 区间、hash 和确认信息。
- Plan 查询只返回已下发计划，并覆盖当前线程谱系。
- 重复确认、下发和查询不会产生重复对象或不稳定结果。

### 13.3 生命周期脚本

- start/cleanup 未配置时安全跳过。
- start 在 Worktree 创建后、Executor 第一个 turn 前执行。
- 配置的 start 失败时 Run 阻断且不执行代码。
- cleanup 在 Worktree 删除成功后执行。
- 配置的 cleanup 失败时主流程状态不被伪造，同时生成 Needs Attention。
- Hook 参数、输出、退出码、超时和重试都可审计。

### 13.4 执行与合并

- 每个 Run 有独立 ExecutionThread、ExecutionJournal、Workspace、Lease 和 HookExecution。
- ExecutionThread 不能修改 PlanRevision 或业务状态。
- ChangeProposal 批准后创建新 Revision/Run，不修改旧 Run/Journal。
- 验证只执行已登记命令，模型不能伪造 VerificationRun。
- 未验证、无有效 commit 或目标 Commit 不匹配时不能进入 MERGED。
- 服务重启、工具不确定、脚本超时、进程终止和用户取消都有明确状态和恢复路径。

### 13.5 页面与交互

- ExplorerThread 是项目主工作区，不是 Dashboard 卡片。
- 对话时间线内显示 CandidatePlan、确认、下发、执行、验证和合并事件。
- Plan Detail Drawer 保留对话上下文，并显示完整执行契约。
- Confirm plan 与 Enqueue plan 是独立操作。
- Plan Center 支持状态、关键词、项目、时间、来源线程、分页和排序。
- 页面在桌面、平板和窄屏下不溢出。
- 关键状态同时使用文字、图标和颜色表达。
