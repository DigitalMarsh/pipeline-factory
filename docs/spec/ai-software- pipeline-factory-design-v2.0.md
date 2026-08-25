# AI Software Pipeline Factory 设计规格

> 版本：v2.0
> 状态：设计基线
> 日期：2026-08-25
> 前置基线：`ai-software- pipeline-factory-design-v1.0.md`

## 1. 目标与边界

v2 将 Pipeline Factory 从“编排外部 Agent Runtime”升级为“自带 Agent Runtime 的本地软件交付控制平面”。Factory 内部完成 Plan Mode 探索、计划确认、计划下发、隔离执行、执行过程补充、确定性验证和人工合并确认。

v2 的主链路是：

~~~text
ExplorerSession
      │ interactive Plan Mode / read-only repository exploration
      ▼
CandidatePlan ── schema + scope + dependency checks ──┐
      │                                                │ user confirm
      ▼                                                ▼
PlanRevision ── explicit enqueue ──► Scheduler ──► Run
                                                  │
                                                  ├─ Workspace / Branch / Lease
                                                  ├─ ExecutionThread
                                                  └─ ExecutionJournal
                                                  │
                                                  ▼
                                         ToolGateway + Executor
                                                  │
                                                  ▼
                                         Verifier / Commit Evidence
                                                  │
                                                  ▼
                                  Review / MergeRequest / human confirm
                                                  │
                                                  ▼
                                               MERGED
~~~

### 1.1 必须满足

- Factory 原生提供 Plan Explorer 和 Run Executor，不依赖外部桌面应用运行 Agent。
- Explorer 和 Executor 使用统一的 `ModelGateway`，但拥有不同模型角色、上下文和工具权限。
- Plan Mode 是受状态机、工具隔离和结构化输出约束的产品能力，不是仅依赖提示词的约定。
- Explorer 只能读取仓库和 Git 事实，不能在探索阶段写文件、执行命令、运行测试或创建提交。
- 每个 Run 固定一个不可变 `PlanRevision`、一个 Workspace、一个 Branch 和一个 `ExecutionThread`。
- ExecutionThread 可以持续补充执行过程，但不能修改已确认的 PlanRevision、Run 状态或合并事实。
- 计划确认和计划下发是两个独立操作；重复操作必须幂等。
- 验证由 Factory 的 Verifier 执行，不以模型最后一句话或会话是否正常结束作为成功依据。
- 只有验证成功、提交证据完整并通过人工合并确认，Plan 才能进入 `MERGED`。
- 服务重启、模型超时、工具调用不确定、命令超时、用户取消和执行范围变化都必须产生明确状态与审计事件。

### 1.2 默认运行边界

- 本地单用户控制台。
- SQLite WAL 作为唯一事实存储；Git Worktree 作为执行隔离边界。
- 全局并发默认 4，单项目并发默认 2，实际值由项目配置覆盖。
- OpenAI API 是首发模型后端；模型调用通过 `ModelGateway` 隔离，领域层不绑定具体模型名称。
- 验证自动执行，合并人工确认。
- 不自动部署、不自动删除 Branch 或 Worktree、不引入多用户、远程 Worker、消息队列或云端 CI。

### 1.3 明确不做

- 不把桌面客户端、桌面可见性或私有 IPC 作为运行条件。
- 不把任意 Shell 字符串从 Plan 直接传给执行器；命令只能引用项目预登记的命令标识。
- 不允许模型直接写数据库、推进业务状态或修改资源锁。
- 不允许 Executor push、merge、deploy、删除 Worktree 或修改项目配置。
- 不允许执行线程直接扩大 Scope、改变依赖、修改验收标准或替换验证命令。
- 不承诺直接读取 v1 Plan Artifact；v2 使用全新的 Plan Schema。

## 2. 总体架构

### 2.1 分层模型

| 层 | 组件 | 责任 | 不负责 |
|---|---|---|---|
| Domain | Plan、Run、Revision、Session、状态规则 | 实体、不变量、状态转换和领域事件 | 调用模型、执行文件或命令 |
| Application | ExplorerService、PlanService、RunService、ChangeService、MergeService | 编排用例、权限、幂等、事务和状态推进 | 保存 UI 临时状态 |
| Model Runtime | ModelGateway、ExplorerAgent、ExecutorAgent | 模型会话、流式输出、取消、恢复和上下文摘要 | 直接访问本地资源 |
| Tool Runtime | ToolGateway、ToolPolicy、ToolExecutor | 文件、Git、补丁、命令和进程能力的策略执行 | 修改业务状态 |
| Infrastructure | SQLite、Git、进程、日志、时钟 | 持久化、隔离目录、命令执行和外部 IO | 解释业务状态 |
| Verification | Verifier、VerificationRegistry | 确定性验证、结果解析和证据生成 | 修改代码或修复失败 |
| API/UI | Explorer、Plan Board、Run Board、Review Queue | 展示状态、发起用户操作、流式展示事件 | 绕过 Application Service |

### 2.2 核心组件关系

~~~text
                         ┌─────────────────────┐
                         │      User / UI       │
                         └──────────┬──────────┘
                                    │ messages / confirmations
                                    ▼
┌──────────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│ ExplorerService  │──────►│   PlanService       │──────►│    Scheduler     │
│ read-only Plan   │       │ candidate / revise  │       │ dependency/lock  │
└────────┬─────────┘       └─────────────────────┘       └────────┬─────────┘
         │ ModelGateway                                            │ Run
         ▼                                                         ▼
┌──────────────────┐       ┌─────────────────────┐       ┌──────────────────┐
│  Plan Explorer    │       │     Registry        │◄──────│   RunService     │
│  structured plan  │       │ SQLite + events     │       │ lease/workspace  │
└──────────────────┘       └──────────┬──────────┘       └────────┬─────────┘
                                      │                            │
                                      │ journal/events             │ execution turn
                                      ▼                            ▼
                             ┌─────────────────────┐       ┌──────────────────┐
                             │ ExecutionJournal    │◄──────│  ExecutionThread │
                             │ append-only facts   │       │  ExecutorAgent   │
                             └──────────┬──────────┘       └────────┬─────────┘
                                        │                           │ ToolGateway
                                        ▼                           ▼
                             ┌─────────────────────┐       ┌──────────────────┐
                             │      Verifier       │──────►│ Review / Merge   │
                             │ registered commands │       │ human confirmation│
                             └─────────────────────┘       └──────────────────┘
~~~

### 2.3 设计原则

1. Registry 是业务事实来源；模型消息、UI 缓存和日志摘要不能取代 Registry 状态。
2. PlanRevision 是执行契约；发布后不可修改，执行过程只能产生新的 Journal 和 ChangeProposal。
3. 模型只提出工具调用；ToolGateway 决定调用是否允许、如何执行以及如何审计。
4. Verifier 与 Executor 解耦；模型可以修复代码，但不能伪造验证成功。
5. 外部副作用采用显式确认和幂等键；不确定的副作用宁可进入待核验状态，不自动重放。
6. 资源锁从调度成功保持到 Run 终止或人工确认合并，避免并行任务在 Review 阶段产生隐性冲突。

## 3. 整体操作流程

### 3.1 计划探索

1. 用户创建或恢复一个 `ExplorerSession`，填写目标、项目和初始约束。
2. Explorer Agent 在 Plan Mode 下读取目录、文件、符号、配置和 Git 状态/历史/差异。
3. 用户与 Explorer 继续对话，补充目标、范围、验收标准、依赖、冲突键和验证意图。
4. Explorer 只能输出设计建议和结构化 `CandidatePlan`，不能调用任何写入或执行工具。
5. Factory 对 CandidatePlan 执行 Schema、路径范围、依赖环、冲突键、基线 Commit 和验证命令检查。
6. 检查通过后，Session 进入 `CANDIDATE_READY`；检查失败进入 `NEEDS_REVISION` 并展示可定位错误。

Explorer 的结果不是事实计划。只有用户明确确认后，CandidatePlan 才能被冻结为 PlanRevision。

### 3.2 计划确认与下发

“确认计划”和“下发”必须是两个可审计的操作：

1. 用户查看 CandidatePlan 摘要、范围、依赖、冲突、基线、Task、验证命令和模型策略。
2. 用户调用 `confirm_plan`，Factory 计算 Artifact hash、固定 base Commit、创建 PlanRevision，并将 Plan 置为 `READY`。
3. PlanRevision 保存确认人、确认时间、来源 ExplorerSession、Schema 版本和完整 Artifact 快照。
4. 用户再次检查 READY 计划后调用 `enqueue_plan`，Plan 原子地变为 `QUEUED`。
5. 重复确认使用同一幂等键时返回原 Revision；同一 Plan 已有不同内容时拒绝复用旧幂等键。
6. 只有 QUEUED Plan 才能被 Scheduler 选中；READY Plan 不会自动执行。

### 3.3 调度和资源准备

Scheduler 对 QUEUED 计划按 `priority DESC、queued_at ASC、plan_id ASC` 排序：

1. 检查所有依赖 Plan 是否达到 `MERGED`。
2. 检查显式冲突键是否被活动 Run 持有。
3. 检查全局和项目并发上限、兼容 Executor Profile 与 Lease 容量。
4. 检查 base Commit 是否仍可解析，项目根目录和 Worktree 根目录是否满足安全前提。
5. 在短事务中创建 Run、Assignment、Lease 和资源锁，并将 Plan 投影为 `IN_PROGRESS`。
6. 创建隔离 Workspace 和 Branch，登记 base Commit。
7. 创建独立 ExecutionThread，写入 Run 的执行契约和 PlanRevision 引用。
8. 资源准备完成后发送第一个 Executor turn；若准备失败，Run 进入 BLOCKED 或 RECOVERING，不伪造 RUNNING。

依赖、冲突和容量不足属于等待，不属于失败。依赖合并、锁释放或容量释放时，Scheduler 必须被事件重新唤醒。

### 3.4 执行线程

ExecutorThread 每次模型调用都携带最小必要上下文：

- PlanRevision 摘要和 Artifact hash；
- 当前 Task、Task 依赖和验收引用；
- include/exclude 与冲突边界；
- 当前 Workspace、Branch、base Commit 和 Run ID；
- 可用 ToolPolicy、验证命令标识和禁止操作；
- 最近 Journal Snapshot、未完成工具调用和用户指导。

执行规则：

1. Executor 先确认 Workspace、Branch、Run 和 Revision 匹配。
2. 按 Task 依赖拓扑顺序执行，每完成一个 Task 写入检查点。
3. 每次工具调用先经过 ToolGateway；模型不得自行组合未登记命令或绕过路径策略。
4. 用户可以查看流式消息和工具结果，可以暂停、取消或追加范围内说明。
5. 用户说明以 `USER_GUIDANCE` 事件写入 Journal；它不能替换 PlanRevision 的约束。
6. 发现范围、依赖或验收不足时，Executor 必须创建 ChangeProposal 并暂停，不得自行扩大范围。
7. 长时间调用、等待用户或等待进程时必须更新心跳和阶段状态。

### 3.5 验证、修复与证据

1. 必需 Task 完成后，Run 进入 `VERIFYING`。
2. Verifier 根据项目注册的命令 ID 解析固定 argv、cwd、timeout 和环境白名单。
3. 每条命令记录开始/结束时间、退出码、超时、日志引用和结果解析。
4. 验证失败时，Executor 可以在同一 ExecutionThread 中有限修复；每次修复必须关联失败结果和变更摘要。
5. `max_fix_attempts` 达到上限后，Run 进入 BLOCKED 或 FAILED，生成 Needs Attention。
6. 全部验证通过后，Factory 检查提交存在、提交祖先为 base Commit、Diff 未越界，并生成 MergeRequest。
7. 验证结果、提交 SHA、Diff 摘要、Task 完成情况和工具审计记录必须组成完整证据包。

### 3.6 人工审查与合并

Reviewer 检查：

- PlanRevision、Run、Workspace 和 base Commit 是否一致；
- Diff 是否只覆盖批准范围，是否包含凭据、生成物或项目外文件；
- 验证命令是否全部通过，是否存在跳过、超时或人工豁免；
- ExecutionJournal 是否能解释重要决策、修复和工具调用；
- ChangeProposal 是否全部处理且没有隐式扩大范围。

审查通过只代表证据包可以合并，不代表已经合并。合并人完成目标分支合并后调用：

~~~text
confirm_merged(
  merge_request_id,
  target_branch,
  target_commit,
  actor,
  idempotency_key
)
~~~

Factory 只读验证目标 Commit 包含 Run 提交，并在同一事务写入确认事件、释放资源锁和将 Plan 置为 `MERGED`。目标不匹配、Git 不可读或证据缺失时保持 `MERGE_READY`。

## 4. 领域模型

### 4.1 实体关系

~~~text
FactoryProject
 ├── ExplorerSession[]
 │    ├── ExplorerMessage[]
 │    └── CandidatePlan[]
 │
 ├── Feature
 │    └── Plan
 │         └── PlanRevision[]（不可变）
 │              ├── PlanTask[]
 │              ├── Dependency[]
 │              ├── ConflictScope[]
 │              └── ToolPolicy
 │
 ├── Run[]
 │    ├── Assignment / Lease
 │    ├── Workspace
 │    ├── ExecutionThread
 │    ├── ExecutionJournal[]
 │    ├── VerificationRun[]
 │    ├── ChangeProposal[]
 │    └── Review / MergeRequest
 │
 └── FactoryEvent[]
~~~

### 4.2 核心实体

| 实体 | 说明 | 关键规则 |
|---|---|---|
| FactoryProject | Factory 管理的代码项目 | 保存根目录、默认分支、并发上限、命令注册和工具策略 |
| ExplorerSession | 一次持续的计划探索会话 | 可产生多个 CandidatePlan；不直接拥有执行资源 |
| ExplorerMessage | Explorer 用户/模型消息 | 追加式保存，敏感内容脱敏，不能直接推进业务状态 |
| CandidatePlan | 尚未确认的结构化计划 | 可反复修订；未确认前不能调度 |
| Plan | 长期生产工单 | 逻辑 ID 稳定，内容通过 Revision 演进 |
| PlanRevision | 已确认的不可变执行契约 | 保存完整 Artifact、hash、base Commit 和确认信息 |
| PlanTask | Revision 中最小可验证任务 | 有序、可依赖、关联验收标准和范围 |
| Run | 一次执行尝试 | 固定一个 Revision；重试产生新 Run |
| ExecutionThread | 一个 Run 的持久执行会话 | 只承载 Agent 上下文，不拥有业务事实 |
| ExecutionJournal | Run 的追加式执行账本 | 记录消息、工具、检查点、指导、修复和验证引用 |
| ChangeProposal | 执行中发现的计划变更请求 | 批准后生成新 Revision 和新 Run |
| ToolPolicy | 角色和 Run 的工具权限 | Explorer 与 Executor 权限必须分离 |
| VerificationRun | 一次命令验证执行 | 只执行项目登记命令，结果不可由模型伪造 |
| MergeRequest | 待人工合并的证据包 | 包含提交、验证、Diff 和目标基线 |
| FactoryEvent | 追加式审计事件 | 所有 Application Service 状态变化必须有事件 |

### 4.3 生命周期

ExplorerSession：

~~~text
CREATED → EXPLORING → CANDIDATE_READY → NEEDS_REVISION
                                      │
                                      ▼
                                  CONFIRMED → ARCHIVED
~~~

Plan：

~~~text
DRAFT → DESIGNED → PLANNED → READY → QUEUED → IN_PROGRESS
                                               │
                                               ▼
                                          MERGE_READY
                                               │
                                  human merge confirmation
                                               ▼
                                            MERGED
~~~

Plan 旁路状态：`WAITING_DEPENDENCY`、`WAITING_CONFLICT`、`BLOCKED`、`CANCELLED`、`SUPERSEDED`。

Run：

~~~text
CREATED → ALLOCATING → DISPATCHED → RUNNING → VERIFYING → SUCCEEDED
                                      │            │            │
                                      │            ├→ FAILED     │
                                      │            └→ BLOCKED    │
                                      ├→ STALE → RECOVERING    │
                                      ├→ NEEDS_PLAN_CHANGE    │
                                      └→ CANCELLED ◄───────────┘
~~~

ExecutionThread：

~~~text
CREATED → ACTIVE → WAITING_INPUT → ACTIVE
             │          │
             ├──────────► PAUSED
             │
             └──────────► COMPLETED / FAILED / CANCELLED
~~~

状态规则：

- `READY → QUEUED` 只能由用户显式下发操作触发。
- `QUEUED → IN_PROGRESS` 必须在创建 Run、Lease 和资源锁的同一事务中完成。
- `IN_PROGRESS → MERGE_READY` 必须同时满足验证成功、提交存在和证据完整。
- `MERGE_READY → MERGED` 必须有人工确认和目标 Commit 证据。
- Run 一旦绑定 PlanRevision，不得切换 Revision。
- ChangeProposal 批准后，旧 Run 进入 `SUPERSEDED` 或 `BLOCKED`，新 Revision 和新 Run 通过 `continued_from_run_id` 关联。

### 4.4 v2 Plan Artifact

v2 使用全新的 Schema，Artifact 的状态不由正文维护，而由 Registry 投影维护。

~~~yaml
schema_version: "2"
plan_id: PLN-20260825-001
feature_id: FEAT-20260825-001
title: 用户权限管理
goal: 完成权限查询、校验和管理界面
project: tpm
priority: 80

source:
  explorer_session_id: EXPL-20260825-001
  candidate_plan_id: CAND-20260825-001
  confirmed_by: user
  confirmed_at: 2026-08-25T16:30:00+08:00

base:
  branch: main
  commit: 0123456789abcdef

scope:
  include:
    - backend/src/permission/**
    - backend/tests/permission/**
  exclude:
    - deployment/**
    - infrastructure/**

dependencies:
  - plan_id: PLN-20260824-004
    required_state: MERGED

conflicts:
  keys:
    - repo:tpm/backend
    - module:permission
    - file:backend/src/permission/PermissionService.java

implementation:
  - id: task-01
    title: 添加权限领域服务
    files:
      - backend/src/permission/PermissionService.java
    depends_on: []
    acceptance_refs: [AC-01]

executor:
  model_role: executor
  tool_policy: executor-default
  max_fix_attempts: 2

verification:
  commands: [backend.test, backend.lint]

merge:
  policy: human-confirmation
  target_branch: main

acceptance:
  - id: AC-01
    description: 权限查询返回有效权限集合
~~~

发布时必须保存 `artifact_path`、`artifact_sha256`、`schema_version`、`base_commit`、解析后的 Task、依赖、冲突键、ToolPolicy 和来源会话。原始 Artifact 给 Agent 阅读，Registry 字段给 Scheduler 查询。

## 5. ModelGateway 与 Agent 会话

### 5.1 ModelGateway 契约

ModelGateway 是模型供应商和领域层之间的唯一接口。首发实现使用 OpenAI API，但不在 Domain 层出现具体供应商类型。

~~~python
class ModelGateway(Protocol):
    def start_session(
        self,
        role: Literal["explorer", "executor"],
        model_profile: str,
        context: SessionContext,
        tool_policy: ToolPolicy,
    ) -> ModelSession: ...

    def send_turn(
        self,
        session_id: str,
        messages: list[ModelMessage],
        idempotency_key: str,
    ) -> Iterator[ModelEvent]: ...

    def cancel(self, session_id: str, reason: str) -> None: ...
    def resume(self, session_id: str, snapshot: SessionSnapshot) -> ModelSession: ...
    def compact(self, session_id: str, journal: JournalSlice) -> SessionSnapshot: ...
~~~

ModelEvent 至少包含 turn ID、消息增量、工具请求、完成原因、usage 摘要、错误类型和供应商请求引用。完整提示词、密钥和敏感环境变量不得写入普通事件。

### 5.2 ExplorerAgent

ExplorerAgent 只接受用户目标、只读仓库事实和 Plan Mode 系统规则。其工具权限为：

- `repo.list`：列出允许范围内目录；
- `repo.read`：读取文本、配置和文档；
- `repo.search`：搜索文本或结构化符号；
- `git.status`、`git.log`、`git.diff`：读取 Git 事实；
- `project.inspect`：读取已登记项目、命令和并发配置。

ExplorerAgent 不可调用 `patch.apply`、`command.run`、`git.commit`、`process.terminate` 或任何改变本地状态的工具。

### 5.3 ExecutorAgent

ExecutorAgent 接收不可变 PlanRevision、Run Context 和 Journal Snapshot。其权限为：

- 读取已批准范围和必要的项目文件；
- `patch.apply`，且每个路径必须经过 include/exclude 校验；
- `command.run`，且只能引用项目登记的命令 ID；
- `git.status`、`git.diff`、`git.commit`；
- 查询和终止属于当前 Run 的进程树。

ExecutorAgent 不可调用 push、merge、deploy、删除 Worktree、修改项目命令注册、修改数据库或扩大 ToolPolicy。

### 5.4 执行循环

~~~text
load PlanRevision + Journal Snapshot
             │
             ▼
      send executor turn
             │
             ├─ assistant message ─────► append journal
             ├─ tool request ───────────► ToolGateway policy check
             │                              │
             │                              ├─ allowed → execute → result
             │                              └─ denied  → audit denial
             ├─ task checkpoint ─────────► persist state + heartbeat
             ├─ change proposal ─────────► pause Run
             └─ turn completed ──────────► schedule next turn or verify
~~~

每个模型 turn、工具调用和检查点都必须可恢复。模型返回 `completed` 不代表 Run 成功；只有 Task、Verifier 和提交证据全部完成才可推进业务状态。

## 6. ToolGateway 与安全策略

### 6.1 ToolGateway 契约

~~~python
class ToolGateway(Protocol):
    def describe(self, policy_id: str) -> list[ToolDescriptor]: ...

    def invoke(
        self,
        call: ToolCall,
        context: ToolContext,
        idempotency_key: str,
    ) -> ToolResult: ...

    def cancel(self, call_id: str, reason: str) -> None: ...
~~~

ToolGateway 必须在执行前校验：角色、Run、Workspace、路径、命令 ID、参数、超时、环境白名单、进程归属和幂等键。ToolResult 只返回模型继续工作所需的最小信息，并把大日志保存为脱敏引用。

### 6.2 文件与范围策略

- 所有路径解析为项目相对路径，再通过真实路径检查防止符号链接越界。
- `scope.include` 为空或包含项目外路径时拒绝执行。
- `scope.exclude` 优先于 include；任何排除路径写入都必须拒绝。
- `patch.apply` 应在应用前预览文件列表和 Diff 摘要，并在应用后重新检查范围。
- Agent 不得修改 `.git`、Factory 数据库、项目配置注册目录、密钥目录和 Worktree 外路径。

### 6.3 命令策略

项目配置为每个命令 ID 固定：argv、cwd、timeout、环境变量白名单、网络策略和结果解析器。Plan 只能写命令 ID，例如 `backend.test`，不能写任意命令字符串。

命令执行必须记录命令 ID、参数摘要、退出码、超时、进程树、日志引用和调用者。完整环境变量不写入事件；执行失败不能自动改用另一个命令。

### 6.4 取消与副作用

- 取消在排队、模型调用、工具调用、验证和提交边界重复检查。
- 取消命令必须终止属于当前 Run 的整个进程树，并等待确认结果。
- `patch.apply`、`git.commit` 等副作用工具必须使用 `call_id` 和幂等键。
- 工具进程在结果写回前崩溃时，调用状态为 `UNCERTAIN`；恢复器先检查实际文件/Diff，再决定是否重试。
- 不允许通过重复调用解决不确定的 push、merge 或 deploy，因为这些能力本身不开放给 Executor。

## 7. 持久化与事件

### 7.1 最小表集合

~~~text
factory_projects
features
explorer_sessions
explorer_messages
candidate_plans
plans
plan_revisions
plan_dependencies
plan_tasks
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
resource_locks
factory_events
idempotency_keys
~~~

v2 不创建外部 Agent Thread 引用表。ExecutionThread 是 Factory 自己管理的领域资源，保存会话 ID、角色、模型配置、状态、最后心跳和 Journal Snapshot 引用。

### 7.2 关键约束

- `plan_revisions(plan_id, version)` 唯一。
- `plan_revisions(artifact_sha256)` 建索引，避免同一内容重复注册。
- `idempotency_keys(scope, key)` 唯一。
- `runs(plan_revision_id, attempt)` 唯一。
- `execution_threads(run_id)` 唯一。
- `resource_locks(resource_key)` 只允许一个活动持有者。
- `assignments(executor_slot_id)` 只允许一个活动 Lease。
- ExecutionJournal 只能追加，不能更新或删除已经发布的条目。
- 所有外键启用 `PRAGMA foreign_keys = ON`。

### 7.3 Journal 条目

~~~json
{
  "journal_id": "JRN-001",
  "run_id": "RUN-001",
  "sequence": 42,
  "entry_type": "tool.completed",
  "actor": "executor",
  "occurred_at": "2026-08-25T17:10:00+08:00",
  "call_id": "CALL-007",
  "task_id": "task-01",
  "payload": {
    "tool": "command.run",
    "command_id": "backend.test",
    "exit_code": 0,
    "log_ref": "log://RUN-001/007"
  }
}
~~~

Journal 保存结构化摘要和引用，不把完整模型提示词、密钥、完整环境变量或未经脱敏的日志作为普通事实写入。

### 7.4 事件和恢复

事件至少覆盖：

- `explorer.session_started`、`explorer.turn_completed`、`candidate_plan.created`、`candidate_plan.rejected`；
- `plan.confirmed`、`plan.enqueued`、`plan.superseded`；
- `run.created`、`run.dispatched`、`run.paused`、`run.resumed`、`run.cancelled`、`run.stale`；
- `execution_thread.started`、`execution_thread.waiting_input`、`execution_thread.failed`；
- `tool.requested`、`tool.denied`、`tool.completed`、`tool.failed`、`tool.uncertain`；
- `change_proposal.created`、`change_proposal.approved`、`change_proposal.rejected`；
- `verification.started`、`verification.failed`、`verification.passed`；
- `commit.created`、`review.completed`、`merge.confirmed`。

所有 Application Service 的状态变化和事件必须在同一事务中提交。服务启动时：

1. 扫描活动 Run、Assignment、Lease、ExecutionThread 和 ToolCall。
2. 对 Lease 过期的 Run 进入 `STALE`，保留最后事件和资源引用。
3. 对 `UNCERTAIN` 工具调用先执行事实检查，不直接重放。
4. 使用 Journal Snapshot 和未完成 Task 恢复模型上下文。
5. 无法证明资源或副作用状态时进入 `RECOVERING` 或 `BLOCKED`，生成 Needs Attention。

## 8. Application Service 与操作接口

### 8.1 计划接口

| 操作 | 前置条件 | 结果 |
|---|---|---|
| `create_explorer_session` | 项目存在、actor 有权限 | 创建 ExplorerSession |
| `send_explorer_turn` | Session 为 EXPLORING | 追加消息并产生 CandidatePlan 或校验结果 |
| `validate_candidate_plan` | CandidatePlan 存在 | 返回结构化 ValidationReport，不创建 Run |
| `confirm_plan` | CandidatePlan 校验通过、用户确认 | 创建不可变 PlanRevision，Plan 进入 READY |
| `enqueue_plan` | Plan 为 READY | Plan 原子进入 QUEUED |
| `supersede_plan` | 尚未 MERGED 且有新 Revision | 旧 Revision 只读并标记 SUPERSEDED |

### 8.2 运行接口

| 操作 | 前置条件 | 结果 |
|---|---|---|
| `schedule_once` | 有 QUEUED 或等待中的 Plan | 创建 Run 或记录等待原因 |
| `pause_run` | Run 尚未终止 | 停止新 turn，等待活动工具收敛 |
| `resume_run` | Run 为 PAUSED/RECOVERING 且资源安全 | 恢复 Journal Snapshot 和执行循环 |
| `add_user_guidance` | Run 可接受输入 | 写入 USER_GUIDANCE，不修改 Revision |
| `cancel_run` | actor 有权限 | 终止边界内进程并进入 CANCELLED |
| `retry_run` | 原 Run 已终止 | 创建新 attempt，不复用旧 Lease |
| `approve_change_proposal` | Proposal 已完成审查 | 创建新 Revision 和新 Run |
| `confirm_merged` | MergeRequest 完整、目标 Commit 可验证 | Plan 进入 MERGED 并释放资源 |

所有接口都必须支持幂等键或严格状态前置条件。API/UI 只能调用 Application Service，不能直接写 Registry。

## 9. 异常、恢复与人工介入

~~~text
依赖未合并 ─────────► WAITING_DEPENDENCY ──依赖 MERGED──► 重新调度
冲突键占用 ─────────► WAITING_CONFLICT ───锁释放──────► 重新调度
无可用容量 ─────────► QUEUED ────────────容量释放────► 重新调度
模型调用超时 ───────► RECOVERING ───────可恢复───────► 继续 / 重试
工具被拒绝 ─────────► BLOCKED ──────────修订权限/计划─► 新 Run
工具结果不确定 ─────► UNCERTAIN ────────事实检查─────► 继续 / BLOCKED
执行线程失联 ───────► STALE → RECOVERING ────────────► 恢复 / 重试
验证失败 ───────────► 修复重试 ──达到上限───────────► FAILED/BLOCKED
范围不足 ───────────► NEEDS_PLAN_CHANGE ────────────► ChangeProposal
用户取消 ───────────► CANCELLED ────────────────────► 释放 Lease/锁
审查驳回 ───────────► Needs Attention ──────────────► 修订后新 Run
目标 Commit 不匹配 ─► MERGE_READY ──────────────────► 人工补齐证据
~~~

人工介入顺序：

1. 读取最后事件、Lease、Workspace、进程、ToolCall、Journal 和 VerificationRun。
2. 选择继续、暂停、取消、重试、批准变更提案或补齐合并证据。
3. 通过 Application Service 执行，并写入 actor、reason、时间和关联资源。
4. 重新读取聚合状态，确认 Slot、Lease、锁和 Needs Attention 与终态一致。

不能通过修改数据库、删除事件、手动修改 PlanRevision 或删除 Journal 来修复状态。无法获得可靠事实时保持 BLOCKED、RECOVERING 或 MERGE_READY。

## 10. 安全、隐私与资源治理

- OpenAI API 密钥只由 ModelGateway 管理，不注入模型可读的普通消息或 Journal。
- 项目环境变量采用白名单，禁止将完整宿主环境传给模型或命令。
- 默认关闭外网访问；项目如需网络验证，必须由项目配置显式声明并记录。
- ToolGateway 对路径、命令、进程、Workspace 和 Run 逐项授权。
- 模型输出中的 Markdown、Shell、路径和链接都视为不可信数据，不能自动提升权限。
- 日志、消息和 Diff 中的密钥、令牌、Cookie、个人信息需要在持久化前脱敏。
- Lease、心跳、进程树和 Workspace 映射必须可查询，避免服务重启留下虚假活动状态。
- v2 不自动清理 Workspace、Branch 或 Journal；清理必须是独立、可确认、可恢复的操作。

## 11. MVP 开发分期

### M0：v2 契约与 Registry

交付新 Plan Schema、ExplorerSession、CandidatePlan、PlanRevision、Run/Thread 状态机、事件格式、幂等约束和 v1 废弃映射。

验收：非法计划、未确认计划、越界范围和未登记命令均被拒绝；确认与下发重复操作不产生重复对象。

### M1：ModelGateway 与 ToolGateway

交付 OpenAI API 首发适配、角色模型配置、流式事件、ToolPolicy、只读 Explorer 工具、Executor 工具、路径检查、命令注册和审计。

验收：Explorer 无法写文件或执行命令；Executor 无法访问范围外路径、未登记命令、push、merge、deploy 或项目配置。

### M2：Plan Explorer

交付 Factory 内交互式 Plan Mode、仓库/Git 只读探索、CandidatePlan 生成、结构化校验、确认冻结和下发队列。

验收：用户可以完成多轮探索；未确认 CandidatePlan 不能进入调度；PlanRevision 能保存来源、hash、base Commit 和确认信息。

### M3：Scheduler 与 ExecutionThread

交付依赖、冲突、容量、Lease、Worktree、Run、ExecutionThread、Journal Snapshot、暂停/恢复、用户指导和 ChangeProposal。

验收：每个 Run 有独立执行上下文；服务重启和模型中断可恢复；用户补充不扩大批准范围；变更提案批准后生成新 Revision/Run。

### M4：Verifier 与 Merge Pipeline

交付确定性验证、有限修复、提交证据、Review/MergeRequest、人工 confirm_merged 和资源释放。

验收：验证失败按上限重试；没有有效提交或目标 Commit 不匹配时不能进入 MERGED。

### M5：硬化与管理视图

交付故障注入、调用幂等、UNCERTAIN 事实核验、Needs Attention、运行日报、审计查询、跨平台进程治理和性能指标。

验收：取消、停机、命令超时、工具不确定、未预期异常都不会遗留活动状态或孤儿进程。

## 12. v1 废弃映射

v2 不承诺读取 v1 Artifact，但实现迁移时应按以下规则清理旧边界：

| v1 概念 | v2 处理 |
|---|---|
| 外部 Explorer Thread | 替换为 Factory 管理的 ExplorerSession |
| Codex Thread / CodexThreadRef | 替换为 Factory 管理的 ExecutionThread |
| Codex Runtime Adapter | 删除，改由 ModelGateway + ToolGateway 承担 |
| Desktop visibility / App Server / IPC | 删除，不进入领域模型和成功条件 |
| Superpowers Adapter | 删除运行依赖；Plan Mode 和执行规则由 Factory 原生实现 |
| Plan Artifact v1 | 不直接读取；通过显式人工重建为 v2 CandidatePlan |
| Runtime capability gating | 替换为 ModelGateway、ToolGateway 和 ToolPolicy 能力检查 |
| Observe/Assist/Native Control | 删除，不再作为 Run 能力阶段 |

SQLite 迁移时不直接复用外部 Thread 引用。旧运行记录如需保留，只作为历史审计导入，并标记为 `LEGACY_V1`，不能作为 v2 活动 Run 恢复来源。

## 13. 验收标准

### 13.1 计划与权限

- Plan Mode 阶段不能调用写入、Shell、测试、提交或数据库工具。
- CandidatePlan 未通过 Schema、范围、依赖、冲突和命令检查时不能确认。
- 未确认 CandidatePlan 不能生成可调度 PlanRevision。
- 确认和下发分离，重复操作不会生成重复 Revision、Run 或资源锁。
- PlanRevision 发布后不可修改，Run 始终绑定单一 Revision。

### 13.2 执行与恢复

- 每个 Run 都有独立 ExecutionThread、Workspace、Lease 和 ExecutionJournal。
- 不冲突计划可以并行，冲突计划严格串行。
- 用户暂停、取消和补充说明不会越过批准范围或误进入 MERGE_READY。
- 工具越权、超时、重复调用、不确定结果和服务重启都有明确事件与处理结果。
- ChangeProposal 批准后创建新 Revision/Run，不修改旧 Run 或旧 Journal。
- 验证失败可以在同一 ExecutionThread 中有限修复，超过上限进入 FAILED/BLOCKED。

### 13.3 验证与合并

- Verifier 只运行项目登记的命令，模型不能伪造 VerificationRun 结果。
- 未验证通过或无有效 commit 时不能进入 MERGE_READY。
- Diff 越界、提交祖先不匹配或证据缺失时不能生成可合并结果。
- 未实际合并到目标 Commit 时不能通过 `confirm_merged`。
- 只有人工确认目标 Commit 后 Plan 才能进入 MERGED。

### 13.4 文档和架构边界

- v2 的运行时架构不包含 Codex App、外部 Desktop Thread、App Server、私有 IPC 或 Superpowers Adapter。
- v2 的事实来源只有 Factory Registry、事件流、ExecutionJournal、Git 和登记的验证结果。
- 所有危险动作都有显式权限边界、审计事件和可恢复失败状态。
