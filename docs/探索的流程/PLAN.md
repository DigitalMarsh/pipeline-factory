# 系统开发流程优化：最终整合方案

## 一、综合结论

采用“方案1/2/3的任务驱动架构 + 方案6的计划契约”，并以现有 `codex-orchestrator` 为实现基线。

| 方案 | 结论 |
|---|---|
| 方案1 | 架构、状态机、冲突控制和失败恢复最均衡，作为主体 |
| 方案2 | 动态线程、显式发布和人工合并边界清晰，吸收其操作流程 |
| 方案3 | 分阶段建设和双 Inbox 思路优秀，吸收其管理视角 |
| 方案4 | JSON 状态文件可靠性不足，不采用 |
| 方案5 | PostgreSQL、Java 控制层过重，不适合本地单用户场景 |
| 方案6 | 适合作为 Plan Handoff 契约，但不能独立承担调度和状态管理 |

最终核心原则：

> **Plan 是长期业务对象，Run 是一次执行记录，Codex Thread 和 Worktree 是临时执行资源，SQLite 是唯一事实来源。**

官方定位支持使用 Sol 处理复杂规划、Luna 承担高吞吐执行；App Server 支持按 `model` 和 `cwd` 创建或派生线程，Git Worktree 适合隔离并行任务。[模型说明](https://developers.openai.com/api/docs/guides/latest-model) · [App Server](https://learn.chatgpt.com/docs/app-server) · [Worktree](https://learn.chatgpt.com/docs/environments/git-worktrees)

## 二、最终运行流程

```text
每个项目一个 Exploration Thread
GPT-5.6 Sol + Plan Mode
        │
        │ 需求讨论、方案决策、人工 Review
        ▼
生成标准 Plan Handoff
        │
        │ plan render / plan check
        ▼
显式“批准并发布”
submit_plan_file(confirm=true)
        │
        ▼
SQLite Plan Registry
        │
        │ 依赖、优先级、冲突键、并发容量检查
        ▼
Dispatcher
        │
        ├─ 创建独立 Worktree 和分支
        ├─ Fork/创建 GPT-5.6 Luna Thread
        ├─ 执行已登记的 setup 命令
        ├─ 按批准后的 Plan 实现
        ├─ 执行 verify 命令
        ├─ 失败时在同一 Thread 自动修复，最多 2 次
        └─ 验证通过后创建 Conventional Commit
        ▼
MERGE_READY
        │
        │ 人工检查 Diff、测试结果和功能
        ▼
人工 Merge + confirm_merged
        │
        ▼
MERGED
```

运行规则：

- 不保留10个固定执行线程；并发度是配置，不是线程数量。默认全局4个、单项目2个，测量本机资源后再提升。
- 每个 Plan 可以产生多个 Run；自动修复复用当前 Thread，人工重试可选择恢复原 Run 或创建全新 Run。
- 依赖 Plan 必须达到 `MERGED` 后才允许下游执行，避免基于未合并代码启动。
- 冲突锁从调度开始保留到人工确认合并；相同模块、数据表、API或共享文件的任务串行执行。
- Executor 不得合并主分支、删除 Worktree、执行部署或扩大批准范围。
- Desktop 是否立即显示、归类新线程只作为可观测信息，不作为执行成功条件；数据库中的 Plan、Run和事件记录才是权威状态。
- Exploration Thread 按项目保留；上下文过长时创建继任线程，并记录前后关系，而不是无限延长单一全局线程。

## 三、计划契约与管理界面

标准 Plan 继续使用现有 Schema，必须包含：

- `project`、`title`、`goal`、`priority`。
- `base.branch`；批准时固定 `base.commit`。
- `dependencies` 和人工审阅过的 `conflicts.keys`。
- `scope.include` 与 `scope.exclude`，明确做什么和不做什么。
- `implementation`，每一步通过 `acceptance_refs` 对应验收项。
- `verification.commands` 只能引用项目设置中预登记的安全命令；Plan 不得携带任意 Shell。
- `executor.profile` 和 `max_fix_attempts`，默认 `luna-default`、2次。
- Conventional Commit 类型和主题。

保留两个主视角，并增加一个异常收件箱：

1. Plan 视角：展示 DRAFT、QUEUED、等待依赖、等待冲突、执行中、验证中、待合并、已合并。
2. Executor 视角：展示当前槽位、Plan、Thread、Worktree、阶段、耗时、心跳和最近事件。
3. Needs Attention：只聚合 BLOCKED、FAILED、恢复失败、长期无心跳和人工 Review 被驳回的任务。

日报不能只统计“今日已合并”，需要区分：

- 今日执行完成：当天首次进入 `MERGE_READY` 的 Plan。
- 今日已合并：当天进入 `MERGED` 的 Plan。
- 今日失败或阻塞：当天终止的 Run及其错误摘要。
- 跨日运行中：开始于此前、当前仍活跃的 Run。

为此增加统一的 `get_daily_activity(project?, date?)` REST/MCP 查询；现有 `get_today_completed` 保留兼容，但明确其语义为“今日已合并”。

## 四、稳定性与实施重点

现有主链路保持不变，后续建设集中在运行治理：

- 保留 SQLite WAL、单实例锁、短事务调度、乐观锁和提交幂等键；不引入 PostgreSQL、消息队列或云端 CI。
- 服务重启后把中断任务转入 `RECOVERING`，继续原 Thread和Worktree；缺失资源时进入 BLOCKED并保留证据。
- 用户取消必须在 Codex、验证和提交等阶段边界重复检查，禁止取消后误进入 `MERGE_READY`。
- 命令超时或服务取消时终止整个子进程树；未预期异常统一写入事件、释放冲突锁并形成明确终态。
- 基础设施瞬时错误按有界退避重试；验证失败最多自动修复2次，之后交给用户，不自动升级 Terra或Sol，避免成本和范围失控。
- 保留所有执行摘要、验证日志、Diff、错误码和事件轨迹；敏感环境变量只允许通过项目白名单传入。
- 在看板补齐日报、异常聚合、长期无心跳提示和运行时长，不建设复杂的 Kubernetes式 Agent 管理界面。
- 本地质量门禁继续覆盖后端静态检查、测试以及前端格式、Lint、类型、测试和构建；不默认新增云端流水线。

## 五、验收测试与默认边界

必须覆盖以下场景：

- 同一幂等键重复发布只创建一个 Plan；不同内容复用同一键被拒绝。
- 未经 `confirm=true` 批准的计划不能进入调度队列。
- 依赖未合并、冲突键占用、全局或项目容量耗尽时正确等待并自动恢复调度。
- 不冲突的多项目任务可以并行，冲突任务严格串行。
- Worktree、Branch、Run、Thread和Plan映射在服务重启后保持一致。
- 验证失败能在同一 Thread修复；达到次数上限进入 BLOCKED。
- 取消、停机、命令超时和未预期异常均不会遗留活动状态或子进程。
- 只有验证通过且提交成功的任务可以进入 `MERGE_READY`。
- 未实际合并到目标分支的提交不能通过 `confirm_merged`。
- 日报按 `Asia/Shanghai` 自然日正确区分执行完成、已合并、失败和跨日运行。
- Desktop线程不可见或 Fork失败时能够记录原因并安全降级，不虚报可见性。
- Windows与macOS本地质量门禁通过，并单独执行一次真实 Codex SDK烟雾测试。

默认边界：本地单用户、Windows/macOS、Python 3.14.4、SQLite、Git Worktree、Sol负责规划、Luna负责执行、人工批准计划、人工 Review和Merge、不自动部署、不自动清理分支和Worktree。
