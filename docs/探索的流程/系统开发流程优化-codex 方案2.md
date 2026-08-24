你的方向基本就是把 Codex 从“人盯着多个线程操作”，升级成一个**本地 Agent 调度系统**。我建议不要继续围绕“固定 10 个 `plan-executer` 线程”设计，而是改成：

> **1 个长期 Sol 探索线程 + 任务注册中心 + 动态 Luna 执行线程 + 动态 Git Worktree + 状态采集器 + Review/Merge 队列**

这样最终确实可以把你的人工工作压缩到你说的两件事：**持续做 Plan/Review**，以及**Review/Merge 已完成代码**。

截至 **2026-08-15**，Codex 当前公开能力已经足够支撑这个架构。Python SDK 的 `thread_start()` 已正式支持 `cwd`、`model`、`sandbox`、`developer_instructions` 等参数，而且一个 `AsyncCodex` 实例能够并发消费多个 active turn。[GitHub](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

------

# 一、我建议你最终不要保留“固定 10 个线程”

你现在设想的是：

```
plan-executer1
plan-executer2
...
plan-executer10
```

我建议把它们改成**10 个并发执行槽位，而不是 10 个永久线程**。

也就是：

```
MAX_CONCURRENCY = 10
```

任务来的时候：

```
Plan-001
   ↓
创建 worktree
   ↓
动态创建 Codex thread
   ↓
GPT-5.6 Luna
   ↓
执行
   ↓
测试
   ↓
DONE
```

然后线程完成使命。

下一个任务：

```
Plan-002
   ↓
新的 worktree
   ↓
新的 thread
```

这样会比复用 `plan-executer1` 稳定很多，因为**不同任务不会互相污染上下文**。

例如线程名称直接变成：

```
exec-PLN-20260815-001-login
exec-PLN-20260815-002-order-export
exec-PLN-20260815-003-permission
```

而不是：

```
plan-executer1
```

你看到名字就知道它在干什么。

Codex App Server 本身已经支持 `thread/name/set`，Python SDK 也已经公开 `Thread.set_name()`。[GitHub](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

------

# 二、整个系统应该分成 5 层

我会给你的系统做成下面这样：

```
                    你
                    │
                    ▼
        ┌────────────────────────┐
        │ Explorer Thread        │
        │ GPT-5.6 Sol + /plan    │
        │ 长期存在                │
        └───────────┬────────────┘
                    │
             Plan Review/批准
                    │
                    ▼
        ┌────────────────────────┐
        │ Plan Registry          │
        │ SQLite                 │
        │ 所有任务唯一事实源       │
        └───────────┬────────────┘
                    │
                    ▼
        ┌────────────────────────┐
        │ Dispatcher             │
        │ max concurrency = 10   │
        └───────────┬────────────┘
                    │
       ┌────────────┼──────────────┐
       ▼            ▼              ▼
    Worktree     Worktree       Worktree
    PLN-001      PLN-002        PLN-003
       │            │              │
     Luna          Luna           Luna
     Thread        Thread         Thread
       │            │              │
       └────────────┼──────────────┘
                    ▼
          Test / Build / Verify
                    │
                    ▼
             READY_FOR_REVIEW
                    │
                    ▼
                   你
              Review + Merge
```

这里最重要的一点是：

**Codex thread 不是你的任务数据库。**

不要通过“读取 10 个线程”来推断项目执行状态。

应该反过来：

```
Plan Registry = 真相
Codex Thread  = 某个任务的一次执行实例
Worktree      = 某个任务的代码工作空间
```

这是整个系统稳定性的关键。

------

# 三、Plan Registry 是核心

第一版甚至不用 PostgreSQL，直接一个：

```
.codex-orchestrator/
    orchestrator.db
```

SQLite 足够。

一个任务大概记录：

```
plan_id: PLN-20260815-003

title: 用户权限批量授权

status: RUNNING

planner:
  thread_id: thr_xxx
  model: gpt-5.6-sol

executor:
  thread_id: thr_yyy
  model: gpt-5.6-luna

git:
  repository: backend
  base_branch: develop
  base_commit: 81ac902
  branch: codex/PLN-20260815-003
  worktree: D:/codex-worktrees/PLN-20260815-003

plan:
  created_at: 2026-08-15T14:32:00
  approved_at: 2026-08-15T14:48:00

execution:
  started_at: 2026-08-15T14:49:05
  completed_at:
  retry_count: 0
```

状态机我建议固定成：

```
DRAFT
  ↓
APPROVED
  ↓
QUEUED
  ↓
RUNNING
  ↓
VERIFYING
  ↓
READY_FOR_REVIEW
  ↓
MERGED
```

异常另外进入：

```
BLOCKED
FAILED
CANCELLED
```

这样你刚才提出的所有管理问题都会自然解决。

------

# 四、你的两个“视角”可以直接这样实现

### Executor 视角

不是看固定 10 个线程，而是看当前 **10 个执行槽**：

| Slot  | Thread       | Plan             | 状态      | Worktree |
| ----- | ------------ | ---------------- | --------- | -------- |
| #1    | exec-PLN-021 | PLN-021 登录优化 | RUNNING   | wt/021   |
| #2    | exec-PLN-022 | PLN-022 导出功能 | VERIFYING | wt/022   |
| #3    | -            | -                | IDLE      | -        |
| #4    | exec-PLN-024 | PLN-024 权限模块 | BLOCKED   | wt/024   |
| #5-10 | -            | -                | IDLE      | -        |

Codex App Server 已经公开了非常适合做这个面板的状态接口：`thread/list`、`thread/read` 和 `thread/status/changed`。runtime status 包括 `notLoaded`、`idle`、`systemError`、`active`，active 还会带 `activeFlags`；例如正在等审批时可以出现 `waitingOnApproval`。[OpenAI Developers](https://developers.openai.com/codex/app-server)

所以：

```
RUNNING
BLOCKED
IDLE
ERROR
```

都可以实时显示。

你要的：

> 这 10 个线程今天完成过什么

实际上变成 SQL：

```
select *
from task_execution
where completed_at >= today();
```

而不是去解析 Codex 历史对话。

------

### Explorer 视角

这个更简单。

显示：

| Plan    | 名称       | 状态             | Executor | Worktree |
| ------- | ---------- | ---------------- | -------- | -------- |
| PLN-001 | 登录重构   | MERGED           | exec-001 | 已删除   |
| PLN-002 | 报表导出   | READY_FOR_REVIEW | exec-002 | wt/002   |
| PLN-003 | 权限重构   | RUNNING          | exec-003 | wt/003   |
| PLN-004 | Redis 优化 | QUEUED           | -        | -        |
| PLN-005 | 日志模块   | APPROVED         | -        | -        |

顶部直接：

```
今日 Plan：18

已完成       7
等待 Review  3
执行中       4
队列中       2
阻塞         1
失败         1
```

这已经基本就是一个“AI 开发流水线控制台”。

------

# 五、动态创建 Luna Thread 现在完全可以做

你之前最关心的这一块，当前 Python SDK 已经正式提供：

```
thread_start(
    approval_mode=...,
    base_instructions=...,
    config=...,
    cwd=...,
    developer_instructions=...,
    ephemeral=...,
    model=...,
    model_provider=...,
    personality=...,
    sandbox=...
)
​``` citeturn503192view0


因此调度器核心代码其实不会复杂：

​```python
from openai_codex import AsyncCodex, Sandbox

thread = await codex.thread_start(
    model="gpt-5.6-luna",
    cwd=worktree_path,
    sandbox=Sandbox.workspace_write,
    developer_instructions=EXECUTOR_INSTRUCTIONS,
)

await thread.set_name(
    f"exec-{plan_id}-{slug}"
)

result = await thread.run(
    execution_prompt
)
```

Python SDK 当前官方模型体系里有 Sol、Terra、Luna；其中官方把 Luna 定位为快速、窄范围、重复性/高吞吐任务，因此它很适合你这种“Plan 已经确定，executor 负责落代码”的工作方式。[OpenAI Developers](https://developers.openai.com/codex/models?utm_source=chatgpt.com)

所以你的思路：

```
Sol
负责：
需求理解
架构决策
Plan
Review

Luna
负责：
按照明确 Plan
修改代码
测试
修复
```

是很合理的模型分工。

我甚至建议再加一个**自动升级机制**：

```
第一次执行
    Luna

失败一次
    Luna retry

仍失败 / 复杂架构问题
    ↓
Terra / GPT-5.6

仍无法解决
    ↓
返回 NEED_HUMAN
```

这样成本会非常漂亮。

------

# 六、Worktree 不要让 Executor 自己管理

这里是整个架构中我最建议你主动控制的地方。

当前 Codex Desktop 确实有非常完善的 managed worktree：一个 chat 通常绑定一个 managed worktree，Codex 会负责生命周期、Handoff、恢复等。[OpenAI Developers](https://developers.openai.com/codex/app/worktrees)

但是公开 Python SDK/App Server 的 `thread_start` 目前暴露的是：

```
cwd
```

并没有一个公开稳定的：

```
worktree=True
```

或者：

```
create_managed_worktree(...)
```

API。[GitHub](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

所以你的 Orchestrator 自己执行：

```
git worktree add \
  D:/codex-worktrees/PLN-003 \
  -b codex/PLN-003 \
  develop
```

然后：

```
thread_start(
    cwd="D:/codex-worktrees/PLN-003",
    model="gpt-5.6-luna"
)
```

这是目前最干净的方案。

------

# 七、探索线程怎么“发布”Plan，是另外一个关键设计

不要让系统自动判断：

> “Codex 好像已经写完计划了，所以执行吧。”

太危险。

应该有明确的 **Plan Approval Gate**。

你的探索线程一直：

```
你
 ↓
Sol /plan
 ↓
讨论
 ↓
修改计划
 ↓
讨论
 ↓
最终计划
```

当你满意后，只需要一句统一指令：

```
批准这个计划并发布执行
```

Orchestrator 捕获：

```
Planner Thread
      │
      ├─ final plan
      │
      └─ 用户：批准这个计划并发布执行
                 │
                 ▼
             APPROVED
                 │
                 ▼
              QUEUED
```

App Server 其实已经提供了非常有价值的结构化 plan 事件：

```
turn/plan/updated
```

其中每一步带：

```
pending
inProgress
completed
```

而且最终 `plan` item 可以作为该轮 Plan 的权威版本。[OpenAI Developers](https://developers.openai.com/codex/app-server)

所以你甚至不需要从 Markdown 文本里硬解析 Plan。

这比：

```
让 Sol 写一个文件
然后 watcher 轮询文件
```

更加干净。

------

# 八、执行线程 Prompt 应该高度标准化

每一个 Luna executor 不应该重新分析需求。

它应该收到：

```
PLAN_ID

目标

已经批准的 Plan

允许修改的 repo

Base commit

Acceptance Criteria

验证命令

禁止事项

Done Definition
```

类似：

```
你是 Executor。

不要重新设计方案。

Plan PLN-20260815-003 已由 Planner 和用户审核批准。

严格按照 Plan 实施。

要求：

1. 不扩大任务范围。
2. 每完成一个 milestone 执行对应测试。
3. 测试失败先修复，不进入下一阶段。
4. 完成后运行完整验证。
5. 不执行 git merge。
6. 不修改主分支。
7. 完成时输出 implementation summary。
```

OpenAI 自己关于 Codex 长任务的实践也特别强调：把 spec、plan、执行规则和状态外部化，并给每个 milestone 配置明确验证标准，这样比完全依赖长对话上下文稳定得多。[OpenAI Developers](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

这一点和你现在的思路非常吻合。

------

# 九、你的日常操作最后会变得很简单

完整自动流程我建议最终做成下面这一条：

1. 你在唯一一个 **Explorer / GPT-5.6 Sol / Plan Mode** 线程持续讨论功能；计划满意后说“批准并发布执行”。调度器生成 `PLN-xxx`，进入 QUEUED；只要当前运行任务少于 10，自动创建 Git worktree、创建 Luna thread、设置线程名称和 `cwd`，把批准后的 Plan 发进去。Executor 自动修改、build、test、修复；App Server 事件实时更新 RUNNING / BLOCKED / VERIFYING / FAILED；通过所有验收后进入 `READY_FOR_REVIEW`。你看到 Review 队列，只负责打开对应 worktree、检查 diff、测试功能并 Merge；Merge 后系统自动标记 `MERGED`、archive thread、删除 worktree；队列中的下一个 Plan 自动开始。

这时你基本不用再干：

```
创建 thread
选模型
复制 plan
创建 worktree
把 plan 粘进去
判断是否执行完
记录今天做了什么
寻找哪个线程执行哪个任务
```

这些全部由 Orchestrator 做。

------

# 十、还有一个我认为非常重要的变化

你的目标其实已经不应该是：

> “如何管理 10 个 Codex 执行线程？”

而应该升级成：

> **“如何管理 Plan 的生命周期？”**

线程只是计算资源。

真正长期存在的是：

```
Explorer
+
Plan Registry
+
Git history
```

执行线程可以完全 disposable：

```
Plan
  ↓
Thread
  ↓
Commit
  ↓
Thread archive
```

所以你的 dashboard 中：

**Plan 是一级对象，Thread 是二级对象。**

这是我最推荐的设计原则。

------

## 最终我建议的技术栈

我会尽量控制得非常轻：

```
Python 3.12
FastAPI
SQLite
OpenAI Codex Python SDK
Git CLI
WebSocket / SSE
Vue 3
```

你现有项目本身就是 Java + Vue，也不影响。这个 Orchestrator 没必要用 Java 做，Python 调 SDK 非常方便。

而且 Codex Python SDK 当前已经是 stable release，官方推荐用 `pip install openai-codex`，并且它直接控制本地 app-server。[OpenAI Developers](https://developers.openai.com/codex/codex-sdk)

------

**所以我会建议你直接跳过“10 个预创建 `plan-executer`”这个阶段。**

直接做：

```
Codex Development Orchestrator

Explorer
    GPT-5.6 Sol

Scheduler
    concurrency = 10

Executor
    dynamic thread
    GPT-5.6 Luna

Workspace
    dynamic Git worktree

Registry
    SQLite

Human Gate #1
    Plan approval

Human Gate #2
    Code review + merge
```

这基本就是你描述的理想工作状态，而且以 **2026-08-15 当前 Codex Python SDK / App Server 的能力，核心部分已经可以真正实现，不只是概念方案**。[GitHub](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

如果下一步直接落地，我建议第一版先只实现 **`Plan Registry + Dispatcher + 动态 worktree + 动态 Luna thread + 两个 Dashboard 视图`**，暂时不要做复杂多 Agent 协作。这一版跑通以后，你现在“必须守在 Codex 前面盯流程”的问题基本就解决了。