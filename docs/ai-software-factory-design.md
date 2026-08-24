# AI Software Factory 设计规格

> 状态：设计基线 v1.0  
> 日期：2026-08-24  
> 关联方案：[现有最终整合方案](探索的流程/PLAN.md)

## 1. 目标与边界

本系统是一个本地单用户 AI Software Factory 控制平面。它把一个长期存在的 Exploration Thread 中经过 Codex Plan Mode 讨论并由用户批准的设计，转换成可排队、可执行、可恢复、可审查的生产工单。

Factory 的职责是管理工作与事实状态；Codex App 的职责是运行 Agent；Superpowers 的职责是提供计划编写与执行方法；Git 的职责是提供分支和 Worktree 隔离。

### 1.1 必须满足

- 一个 Explorer 可以连续产生多个相互独立的 Plan。
- Plan 是长期业务对象，执行尝试必须另建 Run。
- 每个 Run 固定一个不可变 Plan Revision、一个 Worktree、一个 Branch 和一个 Codex Thread 引用。
- 依赖和代码冲突在调度前可计算，调度结果可解释、可重放。
- 服务重启、Codex 中断、命令超时和用户取消不会留下虚假的活动状态。
- 只有验证成功并完成提交的 Run 才能进入 MERGE_READY；只有人工确认目标分支已合并，Plan 才能进入 MERGED。
- Desktop 是否显示外部创建的 Thread 只能作为观测信息，不能作为执行成功条件。

### 1.2 明确不做

- 不研究或写入 Codex Desktop 私有 ipc.sock。
- 不直接修改 Codex Desktop 的 SQLite、Rollout 或全局状态数据库。
- 不把固定的 executor-01 到 executor-10 当作核心 Thread；它们最多只是并发槽位。
- V1 不使用 LLM 做调度，不做自动合并，不做自动部署，不自动删除用户的 Branch 或 Worktree。
- Plan 不携带任意 Shell 字符串；验证命令只能引用项目预登记的命令标识。

## 2. 总体架构

~~~text
Explorer Thread / Sol / Codex Plan Mode
                 │ 设计确认
                 ▼
       Factory Plan Writer / Superpowers Adapter
                 │ immutable Plan Revision
                 ▼
          Plan Registry（SQLite WAL）
                 │
       dependency + conflict + capacity checks
                 ▼
              Deterministic Scheduler
                 │ Assignment + Lease
                 ▼
        Run / Worktree / Branch / Thread
                 │
       Codex App Adapter + Superpowers Adapter
                 ▼
       implement → verify → commit → review
                 │
                 ▼
         MERGE_READY → human merge → MERGED
~~~

分层规则：

| 层 | 责任 | 不负责 |
|---|---|---|
| Domain | 状态、实体、规则、不变量 | 读取 Codex 或执行 Shell |
| Application | 发布、调度、恢复、取消、合并确认用例 | 保存 UI 临时状态 |
| Infrastructure | SQLite、Git、进程、文件、时钟 | 解释业务状态 |
| Adapter | Codex App、Superpowers、Git 能力映射 | 修改核心领域规则 |
| API/UI | 展示状态、触发用户操作 | 绕过 Application Service 写库 |

## 3. 领域模型

### 3.1 实体关系

~~~text
FactoryProject
 ├── Feature
 │    └── Plan
 │         └── PlanRevision（不可变）
 │              ├── PlanTask[]
 │              ├── Dependency[]
 │              └── ConflictScope[]
 │
 ├── Run[]
 │    ├── Assignment / Lease
 │    ├── Workspace
 │    ├── CodexThreadRef
 │    ├── VerificationResult[]
 │    └── Review / MergeRequest
 │
 └── Event[]
~~~

### 3.2 核心实体

| 实体 | 说明 | 关键规则 |
|---|---|---|
| FactoryProject | Factory 管理的代码项目 | 保存根目录、默认分支、并发上限和允许的验证命令 |
| Feature | Explorer 侧的业务目标 | 可有多个 Plan；不参与一次 Run 的资源分配 |
| Plan | 长期生产工单 | 逻辑 ID 稳定，内容通过 Revision 演进 |
| PlanRevision | 某一版已审阅的计划快照 | 发布后不可修改，保存内容哈希和基线 Commit |
| PlanTask | Revision 中可验证的最小任务 | 有序、可依赖、可报告进度；状态由 Run 投影产生 |
| Run | 一次执行尝试 | 每次失败、取消或人工重试都可产生新 Run |
| ExecutorSlot | 逻辑并发容量 | 没有业务上下文，不等同于 Codex Thread |
| Assignment | Run 对 Slot 的一次占用 | 通过 Lease 防止服务失联后永久占用资源 |
| Workspace | Run 的工作目录、Branch 和基线 Commit | 由 Factory 创建和登记，V1 不自动删除 |
| CodexThreadRef | 外部 Codex Thread 的引用 | 保存 provider、Thread ID、可见性和最后观测时间 |
| Review | 执行结果的人工或自动审查记录 | 不能替代验证结果；驳回后回到修复流程 |
| MergeRequest | 待人工合并的证据包 | 包含提交、验证、Diff 摘要和目标基线 |
| FactoryEvent | 追加式审计事件 | 所有状态变化必须有事件和 actor |

### 3.3 计划契约

Plan Artifact 使用 Markdown 正文加 YAML Front Matter。status 不由 Artifact 自己维护，而由 Registry 维护；这样执行过程中不会因为 Agent 修改文档而篡改事实状态。

~~~yaml
schema_version: "1"
plan_id: PLN-20260824-001
feature_id: FEAT-20260824-001
title: 用户权限管理
goal: 完成权限查询、校验和管理界面
project: tpm
priority: 80

base:
  branch: main
  commit: 0123456789abcdef

dependencies:
  - plan_id: PLN-20260823-004
    required_state: MERGED

scope:
  include:
    - backend/src/permission/**
    - backend/tests/permission/**
  exclude:
    - deployment/**
    - infrastructure/**

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

verification:
  commands: [backend.test, backend.lint]

executor:
  profile: luna-default
  max_fix_attempts: 2

acceptance:
  - id: AC-01
    description: 权限查询返回有效权限集合
~~~

发布时必须保存：artifact_path、artifact_sha256、schema_version、base_commit、解析后的 Tasks、依赖和冲突键。原始 Artifact 是给 Agent 阅读的输入，Registry 字段是给 Scheduler 查询的索引。

## 4. 生命周期设计

### 4.1 Plan 生命周期

Plan 状态描述业务工单，不描述某一个 Thread 的瞬时状态。

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

异常或旁路状态：WAITING_DEPENDENCY、WAITING_CONFLICT、BLOCKED、CANCELLED、SUPERSEDED。

状态规则：

- DRAFT → DESIGNED：Explorer 完成设计确认。
- DESIGNED → PLANNED：Superpowers Adapter 生成符合契约的 Artifact。
- PLANNED → READY：解析、Schema、范围、依赖和命令白名单检查全部通过。
- READY → QUEUED：用户明确批准发布，生成幂等发布记录。
- QUEUED → IN_PROGRESS：Scheduler 成功创建 Assignment 和 Run。
- IN_PROGRESS → MERGE_READY：Run 验证成功且提交已创建。
- MERGE_READY → MERGED：用户确认目标分支包含该提交，并提供目标 Commit。
- 运行中产生新设计时，旧 Revision 只能 SUPERSEDED，不能原地编辑。

### 4.2 Run 生命周期

~~~text
CREATED → ALLOCATING → DISPATCHED → RUNNING → VERIFYING → SUCCEEDED
                                      │            │            │
                                      │            ├→ FAILED   └→ MERGE_READY
                                      ├→ STALE → RECOVERING
                                      └→ CANCELLED
~~~

SUCCEEDED 表示执行与验证成功；Run 的可合并投影为 MERGE_READY，Plan 在同一事务中进入 MERGE_READY。

Run 必须记录：plan_revision_id、attempt、base_commit、workspace_id、codex_thread_ref_id、当前 Task、开始/结束时间、最后心跳、验证结果、提交 SHA 和错误摘要。

### 4.3 ExecutorSlot 与 Lease

~~~text
OFFLINE → IDLE → RESERVED → RUNNING → IDLE
   ▲                 │           │
   └── RECOVERING ←──┴──── ERROR ┘
~~~

Scheduler 不直接把 Slot 写成 RUNNING，而是创建 Assignment：

~~~yaml
assignment_id: ASN-001
run_id: RUN-001
executor_slot_id: SLOT-02
lease_until: 2026-08-24T15:05:00+08:00
heartbeat_at: 2026-08-24T15:04:30+08:00
status: ACTIVE
~~~

超过 Lease 且没有新的心跳时：

1. Run 转为 STALE，保留最后事件和资源引用。
2. Assignment 转为 EXPIRED，释放冲突锁。
3. Slot 转为 RECOVERING，由恢复器决定继续、重试或 BLOCKED。

## 5. Scheduler 设计

### 5.1 V1 调度条件

一个 Plan 只有同时满足以下条件才可分配：

1. 处于 QUEUED。
2. 所有依赖 Plan 已进入 MERGED。
3. 所有 conflicts.keys 没有被活动 Assignment 持有。
4. 项目并发数和全局并发数未达到上限。
5. 存在满足 executor.profile 的空闲 Slot。
6. base.commit 仍然可解析，且项目工作树没有违反安全前提。

不能调度时不报失败，而是投影为 WAITING_DEPENDENCY 或 WAITING_CONFLICT，依赖/锁变化后重新评估。

### 5.2 V1 算法

~~~python
def schedule_once(now):
    candidates = registry.queued_plans()
    for plan in sorted(candidates, key=priority_waiting_id):
        if not dependencies_merged(plan):
            registry.mark_waiting_dependency(plan.id)
            continue
        if conflicts_held(plan.conflict_keys):
            registry.mark_waiting_conflict(plan.id)
            continue
        slot = find_idle_compatible_slot(plan.executor_profile)
        if slot is None:
            continue
        with registry.immediate_transaction():
            run = registry.create_run(plan.revision_id)
            assignment = registry.reserve_slot(run.id, slot.id, now)
            registry.acquire_conflict_locks(run.id, plan.conflict_keys)
            registry.mark_dispatched(plan.id, run.id, assignment.id)
        dispatcher.wake(run.id)
~~~

同一轮调度必须使用 SQLite BEGIN IMMEDIATE 或等价的短事务，避免两个 Scheduler 实例同时占用同一 Slot 或同一冲突键。排序规则 V1 固定为 priority DESC、queued_at ASC、plan_id ASC，不引入不可解释的 LLM 评分。

### 5.3 冲突模型

V1 只接受显式冲突键，来源为人工审阅后的 Plan Artifact：

- file:<repo-relative-path>：最强约束。
- module:<name>：模块级串行。
- repo:<name>：仓库级串行。

后续可增加数据库表、API 或资源容量，但不能在没有证据时自动推断并扩大锁范围。

## 6. Codex App Adapter

采用 Capability-based Adapter，不把 Desktop 私有实现写入领域层。

~~~python
class CodexRuntimeAdapter(Protocol):
    def capabilities(self) -> RuntimeCapabilities: ...
    def discover_threads(self, query: ThreadQuery) -> list[ThreadSnapshot]: ...
    def inspect_thread(self, thread_id: str) -> ThreadSnapshot: ...
    def discover_workspaces(self, root: str) -> list[WorkspaceSnapshot]: ...
    def observe_execution(self, thread_id: str) -> Iterator[RuntimeEvent]: ...
    def bind_thread(self, run_id: str, ref: ThreadRef) -> None: ...
~~~

### 6.1 三个成熟阶段

| 阶段 | 能力 | Factory 依赖 |
|---|---|---|
| V1 Observe | 发现 Thread、Worktree、状态和事件 | 只读；Thread 不可见不影响 Run |
| V2 Assist | 用户在 Codex App 中创建资源后自动匹配并绑定 | 需要匹配置信度和人工确认 |
| V3 Native Control | 使用稳定的公开 App Server/SDK 创建、恢复、驱动 Thread | 必须有能力探测、超时和降级 |

V1 的执行适配可以先接收一个用户创建的 Thread/Worktree 引用，再由 Factory 观察；不向 Desktop 的私有数据库补写记录。V3 只允许使用稳定、公开的 App Server/SDK primitive，不把 ipc.sock 作为 fallback。

能力门禁：只有具备 Assist 或 Native Control 能力时，Dispatcher 才能自动发送执行提示并推进 Run；只有 Observe 能力时，Factory 只能登记、绑定和观测用户已创建的资源，不能把 Run 标记为自动执行成功。若当前 Runtime 没有可用控制能力，Run 必须停留在 BLOCKED，并记录 RUNTIME_CONTROL_UNAVAILABLE。

### 6.2 可见性降级

CodexThreadRef.visibility 取值为 VISIBLE、HEADLESS、UNKNOWN、UNAVAILABLE。适配器必须把可见性当作观测字段；Run 的成功条件是验证和提交，不是 VISIBLE。

## 7. Superpowers Adapter

Factory 不 Fork Superpowers，也不把 using-superpowers 的流程硬编码为领域状态。增加一个 Factory 专用入口 factory-write-plan，把已由 Codex Plan Mode 确认的设计直接交给 writing-plans，不重复触发 brainstorming。

~~~python
class SuperpowersAdapter(Protocol):
    def write_plan(self, design: ApprovedDesign) -> PlanArtifact: ...
    def validate_plan(self, artifact: PlanArtifact) -> ValidationReport: ...
    def execution_prompt(self, artifact: PlanArtifact, run: Run) -> str: ...
    def review_prompt(self, artifact: PlanArtifact, result: RunResult) -> str: ...
~~~

执行模式：

- direct：使用 executing-plans，适合任务拆分已经足够细且不需要额外子 Agent 的 Run。
- reviewed：使用 subagent-driven-development，每个 Task 依次经过实现、规格审查和代码质量审查。

V1 默认 reviewed，但是否具备 multi-agent 能力由 Runtime Capabilities 决定；不具备时安全降级为 direct 并记录事件。Superpowers 只能建议或生成提示，不得改变 Plan Revision、Scope、依赖和验证白名单。

## 8. 持久化与事件

SQLite 采用 WAL、外键、短事务和单实例锁。最小表集合：

~~~text
factory_projects
features
plans
plan_revisions
plan_dependencies
plan_tasks
runs
run_tasks
executor_slots
assignments
workspaces
codex_thread_refs
reviews
merge_requests
resource_locks
factory_events
idempotency_keys
~~~

### 8.1 关键索引与约束

- plan_revisions(plan_id, version) 唯一。
- plan_revisions(artifact_sha256) 建索引，避免同一内容重复注册。
- idempotency_keys(scope, key) 唯一，重复发布必须返回同一 Plan。
- resource_locks(resource_key) 只允许一个活动持有者。
- assignments(executor_slot_id) 只允许一个活动 Lease。
- runs(plan_revision_id, attempt) 唯一。
- 所有外键启用 PRAGMA foreign_keys = ON。

### 8.2 事件格式

~~~json
{
  "event_id": "EVT-001",
  "aggregate_type": "run",
  "aggregate_id": "RUN-001",
  "event_type": "run.verification_failed",
  "from_state": "VERIFYING",
  "to_state": "FAILED",
  "actor": "executor",
  "occurred_at": "2026-08-24T15:10:00+08:00",
  "payload": {
    "command": "backend.test",
    "exit_code": 1,
    "attempt": 1
  }
}
~~~

事件是审计和恢复依据；当前状态是可重建投影。任何 Application Service 状态变化都必须在同一事务写入事件。

## 9. 安全与恢复

- Plan 的 scope.include/exclude 在发布时校验，Executor 不得越界修改。
- 验证命令由项目配置注册，例如 backend.test 映射到固定 argv、cwd 和 timeout；Artifact 只能引用标识。
- Executor 不得 merge、push、deploy、删除 Worktree 或更改项目配置。
- 环境变量采用项目白名单，禁止把整个宿主环境传入 Thread。
- 服务启动时扫描 RUNNING、VERIFYING、DISPATCHED 的 Run，依据 Lease 和资源快照转入 RECOVERING 或 BLOCKED。
- 自动修复最多 max_fix_attempts 次；达到上限转 BLOCKED，不自动升级模型、不扩大 Scope。
- 取消操作在分配、Codex、验证和提交边界重复检查，取消后不得进入 MERGE_READY。
- V1 不自动清理 Worktree；清理必须是显式、可确认的独立操作。

## 10. MVP 开发分期

### M0：契约与 Registry

交付 Plan Artifact Schema、解析器、Plan Revision、发布幂等性、状态转换和事件日志。验收：同一 idempotency key 只产生一个 Plan，非法范围和未登记命令被拒绝。

### M1：Deterministic Scheduler

交付依赖过滤、显式冲突锁、Slot/Assignment/Lease、容量限制和服务重启恢复。验收：依赖未合并和冲突占用时等待；不冲突任务可并行；重复调度不会产生双 Run。

### M2：Workspace 与 Runtime Observe

交付 Git Worktree/Branch 生命周期登记、Codex Runtime Adapter V1、Thread/Worktree 绑定和事件观测。验收：Run 能恢复资源映射；Thread 不可见时仍可完成状态闭环。

### M3：Superpowers Execution

交付 factory-write-plan、direct/reviewed 两种执行提示、Runtime 能力门禁、验证命令白名单、有限自动修复和提交证据。自动执行只在 Codex Adapter 报告 Assist 或 Native Control 时开启；只有 Observe 时进入 BLOCKED/RUNTIME_CONTROL_UNAVAILABLE。验收：验证失败按次数限制重试；通过后才进入 MERGE_READY。

### M4：Review/Merge 与管理界面

交付 Plan Board、Executor Board、Needs Attention、Review/Merge Queue、日报和人工 confirm_merged。验收：未经人工确认不能进入 MERGED；日报按 Asia/Shanghai 正确区分执行完成、已合并、失败和跨日运行。

### M5：硬化与可选 Native Control

交付跨平台进程树终止、故障注入、性能指标和 Codex App Adapter V3 能力探测。只有公开接口稳定且有明确降级路径时才启用 Native Control。

## 11. 最终验收标准

- Feature → Plan Revision → Run → Review/Merge 关系完整且可追溯。
- Plan Revision 发布后不可变，执行结果不会回写计划正文。
- 依赖、冲突、容量和 Lease 规则在并发情况下仍保持一致。
- 服务重启、Codex 中断、验证失败、取消和超时都有明确终态与事件证据。
- 只有验证成功、提交存在且人工确认目标 Commit 后，状态才可达到 MERGED。
- Codex Desktop Thread 的可见性不会被误报为执行成功或失败。
- 所有危险动作均有显式边界：无私有 IPC、无数据库补写、无自动部署、无自动清理。
