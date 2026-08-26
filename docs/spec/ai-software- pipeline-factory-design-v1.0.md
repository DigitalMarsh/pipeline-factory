# AI Software Pipeline Factory 设计规格

> 版本：v1.0

## 1. 目标与边界

本系统是一个本地单用户 AI Software Pipeline Factory 控制台。系统维护一个持久化的Exploration Thread，在Exploration Thread使用Plan Mode探索任务并生成执行计划，经过用户批准后转换成可排队、可执行、可恢复、可审查的生产工单。

Pipeline Factory 的职责是管理工作与事实状态；Codex App 的职责是运行 Agent；Superpowers 的职责是提供计划编写与执行方法；Git 的职责是提供分支和 Worktree 隔离。

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

## 2.1 整体流程

Factory 的一次生产闭环由“设计确认、计划发布、排队调度、隔离执行、验证提交、审查合并、结果归档”七个阶段组成。阶段之间通过 Registry 中的事实状态和事件连接，不通过 UI 页面是否打开或某个 Thread 是否可见来判断进度。

~~~text
┌──────────────────────────────────────────────────────────────────────┐
│ 0. 项目准备                                                          │
│    登记项目、默认分支、验证命令、并发上限、Executor Profile            │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 1. 设计与计划                                                        │
│    Explorer 讨论 → 用户确认 → factory-write-plan → Plan Artifact      │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. 发布检查                                                          │
│    解析、Schema、范围、依赖、冲突、基线 Commit、命令白名单、幂等键      │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 3. 排队与调度                                                        │
│    用户批准发布 → QUEUED → 依赖/冲突/容量检查 → Run + Lease             │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. 执行                                                              │
│    创建 Workspace/Branch → 绑定或创建 Thread → 按 Task 执行并记录心跳    │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. 验证与证据                                                        │
│    执行白名单命令 → 失败有限修复/重试 → 成功后创建提交 → 生成证据包       │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 6. 审查与合并                                                        │
│    Review → MERGE_READY → 人工合并目标分支 → confirm_merged → MERGED      │
└──────────────────────────────────────────────────────────────────────┘
~~~

每个阶段的进入条件、责任人和产物如下：

| 阶段 | 进入条件 | 主要责任人 | 必须产物 | 失败后的处理 |
|---|---|---|---|---|
| 项目准备 | FactoryProject 尚未登记或配置已变化 | Factory 管理员 | 项目配置、验证命令注册、能力配置 | 配置不完整时禁止发布 |
| 设计与计划 | Explorer 已完成设计讨论 | Explorer、Plan Author | Approved Design、Plan Artifact | 回到设计讨论，不创建 Run |
| 发布检查 | Artifact 已生成 | Factory | PlanRevision、解析索引、ValidationReport | 保持 PLANNED 或 BLOCKED，修订后生成新 Revision |
| 排队与调度 | Revision 为 READY 且用户批准发布 | 计划负责人、Scheduler | QUEUED Plan、Run、Assignment、资源锁 | WAITING_DEPENDENCY / WAITING_CONFLICT / 保持 QUEUED |
| 执行 | Run 已分配且 Runtime 具备所需能力 | Executor、Codex Runtime | Workspace、ThreadRef、Task 事件、心跳 | FAILED、STALE、CANCELLED 或 BLOCKED |
| 验证与证据 | 所有必需 Task 已完成 | Executor、Factory | VerificationResult、Commit SHA、Diff 摘要 | 有限修复；超过上限进入 BLOCKED |
| 审查与合并 | 验证成功且提交存在 | Reviewer、合并人 | Review、MergeRequest、目标 Commit | 驳回回到修复；目标不匹配时不确认合并 |

### 2.2 标准操作流程

以下流程是 V1 的正常操作路径。页面、CLI 或 API 可以不同，但必须调用同一组 Application Service，并产生相同的状态变化和事件。

#### A. 一次性登记项目

1. 管理员登记项目根目录、项目标识、默认分支和时区。
2. 登记项目级并发上限、允许的 Executor Profile 以及验证命令标识。
3. 为每个验证命令固定 argv、cwd、timeout、环境变量白名单和结果解析方式；Artifact 只能引用命令标识。
4. Factory 读取默认分支的当前 Commit，确认根目录可访问、Git 状态可读取、基线 Commit 可解析。
5. 管理员确认 Worktree 根目录、分支命名规则和清理策略。V1 只登记清理策略，不自动删除历史 Workspace。

项目登记完成后才允许创建或发布 Plan。项目配置发生变化时，必须记录配置版本；已经发布的 PlanRevision 仍按发布时保存的基线和命令索引执行。

#### B. 从 Explorer 设计生成 Plan

1. Explorer 在长期 Thread 中说明目标、范围、验收标准、依赖、冲突键和验证方式。
2. 用户完成设计确认；未确认的讨论内容只能停留在 Explorer 侧，不得直接进入队列。
3. Factory Plan Writer 调用 `factory-write-plan`，生成 Markdown + YAML Front Matter 的 Plan Artifact。
4. 发布前展示摘要供用户复核：目标、项目、基线 Commit、include/exclude、依赖、冲突键、Task、验证命令、修复上限和 Executor Profile。
5. 用户确认 Artifact 内容后，Factory 计算 SHA-256，创建不可变 PlanRevision，并把可调度字段写入 Registry。

此步骤只创建长期计划，不创建 Run、Assignment、Workspace 或 Codex Thread。修改已发布内容必须生成新的 Revision，旧 Revision 只能被标记为 SUPERSEDED。

#### C. 发布检查与进入队列

Factory 按以下顺序执行发布检查，任何一步失败都不能进入 QUEUED：

1. 校验 schema_version、必填字段、ID 格式和字段类型。
2. 校验项目存在、基线 branch/commit 可解析，且 include/exclude 使用项目相对路径。
3. 校验 include 与 exclude 不产生越界范围；禁止访问项目外路径、敏感目录和未声明资源。
4. 校验每个 Task 的 ID 唯一、依赖存在且无环，acceptance_refs 均能解析。
5. 校验依赖 Plan 存在，冲突键格式正确，验证命令全部在项目白名单内。
6. 校验 Executor Profile 和 `max_fix_attempts` 在项目允许范围内。
7. 写入 ValidationReport、artifact_sha256 和发布事件；同一幂等键重复提交时返回原 Plan，不创建重复 Revision 或 Run。

检查通过后 Plan 进入 READY。计划负责人复核检查报告并明确执行范围，调用“批准发布”操作；该操作将 READY 原子地变为 QUEUED，并记录 actor、时间和幂等键。只有 QUEUED Plan 才能被 Scheduler 选中。

#### D. 调度、分配和资源准备

Scheduler 周期运行或被事件唤醒，对 QUEUED、WAITING_DEPENDENCY 和 WAITING_CONFLICT 的 Plan 重新评估：

1. 先判断依赖是否全部 MERGED；否则标记 WAITING_DEPENDENCY，并记录未满足的 Plan 和目标状态。
2. 再判断冲突键是否被活动 Assignment 持有；否则标记 WAITING_CONFLICT，并记录持有 Run。
3. 再判断项目和全局容量、兼容 Slot、基线 Commit 以及工作树安全前提。
4. 条件满足时，在一个短事务中创建 Run、Assignment、Lease，锁定冲突键，并将 Plan 投影为 IN_PROGRESS。
5. Dispatcher 创建或登记 Workspace、Branch 和基线 Commit，随后按 Runtime 能力决定绑定已有 Thread、请求用户创建 Thread，或自动驱动 Thread。
6. 资源映射完成后写入 DISPATCHED 事件；Executor 开始工作并定期更新心跳。

资源不足不是失败。依赖、冲突或容量发生变化时必须重新唤醒 Scheduler；只有资源无法恢复、基线不安全或 Runtime 能力缺失等明确原因才进入 BLOCKED。

#### E. Executor 执行 Task

Executor 只能在 Factory 分配的 Workspace 中工作，执行提示必须包含以下固定上下文：PlanRevision 摘要、当前 Task、include/exclude、验收标准、验证命令标识、禁止操作和当前 Run ID。

1. Executor 启动时确认 Workspace 路径、Branch、base_commit 和 Run ID 与 Registry 一致。
2. 按 `PlanTask.depends_on` 的拓扑顺序执行 Task；每完成一个 Task 都写入 `run_task.completed` 或 `run_task.failed` 事件。
3. 只修改声明范围内的文件；发现需要扩大范围、改变依赖、修改验证命令或修改项目配置时，暂停并请求人工修订 Plan，不得自行扩大权限。
4. Executor 每次获得工作、等待外部操作或完成一个阶段时更新心跳；长时间命令必须同时写入可观察的进程状态。
5. Runtime 只有 Observe 能力时，Factory 可以登记和观测用户创建的资源，但不能自动发送执行提示，也不能把 Run 标记为自动执行成功。

#### F. 验证、有限修复和提交

1. 所有必需 Task 完成后，Run 进入 VERIFYING，Factory 按顺序执行白名单验证命令。
2. 每条命令记录 command_id、解析后的 argv 摘要、退出码、开始/结束时间、超时标记和日志引用；不把完整敏感环境变量写入事件。
3. 验证失败时，Executor 只能在 `max_fix_attempts` 范围内修复，然后重新执行受影响的验证命令；每次修复都记录原因和差异。
4. 达到上限、出现越界修改、命令未登记或运行环境不满足时，Run 进入 FAILED 或 BLOCKED，并生成 Needs Attention 项。
5. 全部验证通过后，Factory 检查提交 SHA 存在、提交祖先为 Run 的 base_commit、提交范围未越界，然后生成 Review 和 MergeRequest。
6. 提交成功并完成证据收集后，Run 进入 SUCCEEDED，Plan 在同一事务中投影为 MERGE_READY。缺少提交时不得进入 MERGE_READY。

#### G. Review、人工合并和闭环

Reviewer 在 Review Queue 中检查：

- PlanRevision 是否与 Run 一致，是否使用正确的 base_commit；
- Diff 是否只覆盖声明范围，是否包含不应提交的配置、凭据或生成物；
- 验证命令是否全部通过，是否存在超时、跳过或人工豁免；
- 提交、日志、验证结果、Task 结果和 CodexThreadRef 是否可以互相追溯。

审查通过只表示证据包可合并，不等于目标分支已经合并。合并人在线下或受控 Git 流程中完成合并后，调用 `confirm_merged(plan_id, target_branch, target_commit)`：

1. Factory 验证目标分支、目标 Commit 和 MergeRequest 中的提交信息完整。
2. Factory 通过只读 Git 检查确认目标 Commit 包含 Run 的提交；若检查不可用，必须保留为待确认，不得乐观推进状态。
3. Factory 原子写入 merge confirmation 事件和目标 Commit，将 Plan 从 MERGE_READY 变为 MERGED。
4. 若目标分支发生冲突、提交不匹配或合并后验证信息缺失，保持 MERGE_READY，创建 Needs Attention，不自动重跑或自动删除 Workspace。

### 2.3 角色与操作边界

| 角色 | 可以操作 | 不可以操作 | 主要交接物 |
|---|---|---|---|
| Explorer / 需求负责人 | 讨论目标、范围和验收标准；确认设计 | 直接创建 Run、修改已发布 Revision 状态 | Approved Design |
| Plan Author | 生成 Artifact；修订并生成新 Revision | 绕过 Schema、写入任意 Shell、修改已发布 Revision | Plan Artifact、ValidationReport |
| 计划负责人 | 复核发布检查；批准 READY → QUEUED；取消尚未完成的计划 | 绕过依赖/冲突检查；直接写库推进状态 | Publish decision、Cancel reason |
| Scheduler | 计算依赖、冲突、容量；创建 Run 和 Lease | 修改 Plan 内容；自动合并或扩大锁范围 | Assignment、resource locks |
| Executor / Codex Agent | 在 Workspace 内实现 Task、运行白名单验证、创建提交 | merge、push、deploy、删除 Workspace、修改项目配置 | Task events、verification results、commit SHA |
| Reviewer | 审查范围、证据和差异；驳回并说明原因 | 代替验证命令；未经合并确认推进 MERGED | Review decision、MergeRequest |
| 合并人 | 将已审查提交合并到目标分支；确认目标 Commit | 把未审查或未验证提交标记为已合并 | `confirm_merged`、target Commit |
| Factory 管理员 | 登记项目、命令、Slot、Runtime 能力；处理恢复和清理 | 通过后台直接绕过状态机；无确认删除资源 | 配置版本、恢复/清理记录 |

### 2.4 日常操作入口与结果

| 操作入口 | 适用场景 | 前置条件 | 成功结果 | 不满足条件时 |
|---|---|---|---|---|
| `validate_plan` | 发布前检查 Artifact | 有效项目和 Artifact | 返回可读 ValidationReport | 不创建 Revision、Run 或执行资源 |
| `publish_plan` | 创建或登记不可变 Revision | 幂等键、Artifact 校验通过 | Plan 进入 READY | 返回可定位的字段错误 |
| `approve_enqueue` | 明确批准执行 | Plan 为 READY，用户确认范围 | Plan 进入 QUEUED | 保持 READY，记录拒绝原因 |
| `schedule_once` | 立即触发一次调度 | 有待评估计划 | 创建 Run 或记录等待原因 | 不产生重复 Run |
| `retry_run` | 对失败或取消的尝试重试 | 原 Run 已终止，Revision 未过期 | 创建新的 attempt 和 Workspace 映射 | 不复用旧 Run 的 Lease |
| `cancel_run` | 停止尚未完成的 Run | actor 有权限 | 在当前边界停止并进入 CANCELLED | 仍需继续观察已启动进程 |
| `recover_stale` | 处理 Lease 过期或服务重启 | Run 有资源快照 | 继续、重试或 BLOCKED，三者择一并有证据 | 不直接恢复为 RUNNING |
| `review_run` | 审查已生成的证据包 | Run 为 SUCCEEDED / MERGE_READY | 通过或驳回并记录理由 | 不改变验证结果 |
| `confirm_merged` | 登记人工合并事实 | 目标 Commit 可验证 | Plan 进入 MERGED | 保持 MERGE_READY |

所有入口都必须支持幂等键或明确的状态前置条件。重复点击“发布、调度、取消、确认合并”不能产生重复 Run、重复锁或相互矛盾的终态。

### 2.5 异常、恢复与人工介入流程

~~~text
依赖未满足 ───────► WAITING_DEPENDENCY ──依赖 MERGED──► 重新调度
冲突键被占用 ─────► WAITING_CONFLICT ───锁释放──────► 重新调度
无兼容 Slot ──────► 保持 QUEUED ───────容量释放────► 重新调度
Runtime 无控制能力 ► BLOCKED ──────────人工准备资源──► 新 Run 或恢复
Lease 过期/服务重启 ► STALE → RECOVERING ───────────► 继续/重试/BLOCKED
验证失败 ─────────► 修复重试 ──达到上限──► FAILED/BLOCKED
用户取消 ─────────► CANCELLED ──────────────────────► 释放 Lease/锁
审查驳回 ─────────► Needs Attention ───────────────► 修订 Revision 后新 Run
目标提交不匹配 ───► MERGE_READY ───────────────────► 人工补齐/重新合并
~~~

人工介入必须遵循“先保留证据、再改变状态”的顺序：

1. 先查看最后事件、当前 Lease、Workspace、ThreadRef、进程和验证结果。
2. 明确选择继续、取消、重试、修订计划或补齐合并证据中的一种动作。
3. 通过 Application Service 执行动作，写入 actor、reason、时间和关联资源。
4. 再次读取聚合状态，确认资源锁、Slot 和 Needs Attention 项与终态一致。

人工不能通过修改数据库状态、删除事件或移动 Desktop 私有文件来“修复”流程。无法获得可靠事实时，宁可保持 BLOCKED 或 MERGE_READY，并把下一步检查记录在 Needs Attention 中。

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
