你的思路是对的，而且结合 Codex 现在的能力，我建议你**不要继续沿着“预先创建 10 个 plan-executer”这个方向深化**，而是把它升级成：

> **1 个长期 Exploration Thread + 1 个 Plan Registry + 1 个 Dispatcher + N 个按需创建的 Executor Thread/Worktree + 1 个 Review/Merge 队列。**

你本人最后只保留两个动作：

1. 在 Sol + Plan 模式里持续探索需求、Review 计划，然后“发布计划”。
2. 查看已经完成的 worktree，做代码/功能 Review，然后 Merge。

其余的**创建执行线程、指定 Luna、创建 worktree、派发计划、跟踪状态、失败重试、生成今日完成清单**，全部交给一个本地 Orchestrator。

先纠正一个小地方：当前官方 GPT-5.6 三档是 **Sol / Terra / Luna**，所以你说的 `5.6 lua`，如果指最低成本执行模型，实际模型应是 **GPT-5.6 Luna**。官方把 Sol 定位为复杂编码/研究，Terra 平衡能力和成本，Luna 是最快、最低成本档。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

------

# 一、我最推荐你的最终架构

把现在：

```
你
 ↓
Plan(Sol)
 ↓
人工创建 Executor
 ↓
指定 Luna
 ↓
人工盯任务
 ↓
完成
 ↓
Merge
```

改成：

```
                  ┌────────────────────┐
                  │ Exploration Thread │
                  │ GPT-5.6 Sol        │
                  │ Plan Mode          │
                  └─────────┬──────────┘
                            │
                         发布 Plan
                            │
                            ▼
                 ┌───────────────────────┐
                 │     Plan Registry     │
                 │       SQLite          │
                 │ P-001 P-002 P-003... │
                 └──────────┬────────────┘
                            │
                            ▼
                  ┌──────────────────┐
                  │    Dispatcher    │
                  │ Codex Orchestrator│
                  └───────┬──────────┘
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
       Executor-001  Executor-002  Executor-003
       GPT-5.6 Luna  GPT-5.6 Luna  GPT-5.6 Luna
             │            │            │
         Worktree      Worktree      Worktree
        plan/P001     plan/P002     plan/P003
             │            │            │
             ▼            ▼            ▼
          tests          tests        tests
             │            │            │
             └────────────┼────────────┘
                          ▼
                  ┌─────────────────┐
                  │ Review / Merge  │
                  │     Queue       │
                  └────────┬────────┘
                           ▼
                          你
```

关键变化是：

> **Executor 是临时计算资源，不再是固定人员。**

这点非常重要。

你现在想到的：

```
plan-executer1
plan-executer2
...
plan-executer10
```

其实是把 AI Agent 当成了“10 个程序员”。

更合适的模型应该是：

```
Plan → Scheduler → 临时 Executor
```

就像 CI Runner：

```
P001
  ↓
系统发现有空闲容量
  ↓
创建 worktree
  ↓
创建 Codex thread
  ↓
model = gpt-5.6-luna
  ↓
执行
  ↓
完成
  ↓
释放 Executor
```

所以甚至不需要长期存在：

```
plan-executer1 ~ 10
```

而可以动态出现：

```
exec-P001
exec-P002
exec-P003
```

我更推荐这种命名。

------

# 二、好消息：Codex 现在的底层能力已经基本够了

这是跟几个月前最大的区别。

Codex app 在 **2026 年 5 月 29 日**加入了：

> local projects / worktrees 的 thread coordination，并且可以在明确要求时创建独立后台线程。[OpenAI Developers](https://developers.openai.com/codex/changelog)

而 Codex app-server 已经提供：

```
thread/start
thread/resume
thread/fork
thread/read
thread/list
thread/turns/list
thread/name/set
thread/status/changed
thread/loaded/list
thread/archive
...
```

这就意味着你要的 Executor Manager 已经可以建立在官方接口上。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

特别重要的是：

```
thread/list
```

返回的 thread 已经包含：

```
status
```

状态包括：

```
notLoaded
idle
active
systemError
```

运行中还会发：

```
thread/status/changed
```

例如：

```
{
  "threadId": "thr_123",
  "status": {
    "type": "active",
    "activeFlags": ["waitingOnApproval"]
  }
}
```

这正好对应你提出的：

> “我要知道这 10 个线程现在谁在工作、谁空闲、谁卡住了。” [OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

------

# 三、动态创建 Luna Executor，现在也可以直接实现

Python SDK 现在官方已经提供稳定版：

```
pip install openai-codex
```

而且可以明确指定模型：

```
from openai_codex import Codex, Sandbox

with Codex() as codex:
    thread = codex.thread_start(
        model="gpt-5.6-luna",
        sandbox=Sandbox.workspace_write,
    )

    result = thread.run(plan_prompt)
```

官方示例本身就是通过：

```
thread_start(model="...")
```

创建线程。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

更关键的是 app-server 的 `thread/start` 支持：

```
model
cwd
sandbox
approvalPolicy
...
```

例如官方协议：

```
{
  "method": "thread/start",
  "params": {
    "model": "gpt-5.6-terra",
    "cwd": "/Users/me/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite"
  }
}
```

所以你的 Dispatcher 可以：

```
Plan P-102
      │
      ├── git worktree add ...
      │
      └── thread/start
             model = gpt-5.6-luna
             cwd   = /xxx/worktrees/P-102
```

这样**一个计划天然对应一个 worktree + 一个 Codex thread**。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

------

# 四、这是我建议的数据模型

不要把 Codex Thread 当数据库。

这一点非常关键。

## Plan Registry 才是系统的 Source of Truth

建议 SQLite 就够。

例如：

```
plans
────────────────────────────────────

id
P-001

title
用户权限模块重构

status
READY

priority
50

exploration_thread_id
thr-explore-001

executor_thread_id
NULL

worktree
NULL

branch
NULL

model
gpt-5.6-luna

created_at

started_at

completed_at

merged_at
```

状态机建议设计成：

```
DRAFT
  ↓
REVIEWING
  ↓
READY
  ↓
QUEUED
  ↓
DISPATCHING
  ↓
RUNNING
  ↓
VERIFYING
  ↓
READY_FOR_REVIEW
  ↓
MERGED
  ↓
DONE
```

异常状态：

```
BLOCKED
FAILED
CANCELLED
CONFLICT
```

这样：

> Plan 状态 ≠ Codex Thread 状态。

例如：

```
Plan:
P-037 RUNNING

Thread:
thr_xxx active

Worktree:
~/worktrees/P-037

Branch:
plan/P-037
```

三个是独立对象。

------

# 五、你要求的两个视角就非常容易实现

## 视角 A：Executor 现场

Dashboard：

| Executor  | Plan          | 状态      | Worktree | 开始  |
| --------- | ------------- | --------- | -------- | ----- |
| exec-P021 | P021 权限缓存 | RUNNING   | wt/P021  | 14:32 |
| exec-P022 | P022 用户导出 | VERIFYING | wt/P022  | 15:01 |
| exec-P023 | P023 API重构  | BLOCKED   | wt/P023  | 15:17 |

而不是：

```
executor1
executor2
executor3
...
```

因为 Executor ID 本身没有业务意义。

真正有意义的是：

```
Plan ID
```

所以 Thread Name 推荐：

```
[P021] 用户权限缓存优化

[P022] 用户批量导出

[P023] API异常体系重构
```

Codex app-server 已经支持：

```
thread/name/set
```

所以 Dispatcher 可以创建 Thread 后自动命名。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

------

同时：

## 今日 Executor 活动

```
Today

✓ P011 登录日志优化
   exec-P011
   09:12 → 09:37

✓ P012 Redis缓存调整
   exec-P012
   09:22 → 10:05

✓ P014 菜单权限修复
   exec-P014
   10:03 → 10:42

● P018 Excel导出优化
   exec-P018
   RUNNING

○ P019 用户同步
   QUEUED
```

这就是你要的：

> 10 个线程今天干了什么。

但实际上已经不用关心“10 个线程”。

------

# 六、第二个视角：Exploration / Plan 视角

这个更重要。

你的主界面应该是：

```
Exploration
────────────────────────────

Total Plans       38

Draft              4
Ready              5
Running            6
Review              3
Completed          20
```

下面：

| Plan | 功能      | 状态    | Executor  | 结果    |
| ---- | --------- | ------- | --------- | ------- |
| P031 | 用户缓存  | DONE    | exec-P031 | merged  |
| P032 | 菜单权限  | RUNNING | exec-P032 | —       |
| P033 | 登录优化  | READY   | —         | —       |
| P034 | Excel导出 | REVIEW  | exec-P034 | waiting |
| P035 | 消息中心  | DRAFT   | —         | —       |

这样你一眼就知道：

```
探索线程产出了多少计划？

哪些没有执行？

哪些正在执行？

在哪个 Thread？

哪些完成？

哪些等待我 Review？
```

这已经完全解决你描述的第二类问题。

------

# 七、Plan 如何从 Exploration 自动进入 Dispatcher

这是整个系统里最关键的一步。

我**不建议**让 Orchestrator 去分析聊天文本，然后猜：

> “用户是不是已经 Review 完 Plan 了？”

太不稳定。

应该增加一个非常明确的动作：

```
发布计划
```

也就是你的工作习惯变成：

```
你：
我们讨论用户权限缓存问题。

Sol：
分析……

你：
这里改成 Redis……

Sol：
更新计划……

你：
OK，发布计划。
```

然后 Plan Tool 执行：

```
publish_plan(...)
```

生成：

```
id: P-043

title: 用户权限缓存优化

base_branch: main

model: gpt-5.6-luna

objective:
  优化用户权限缓存机制

scope:
  - backend/system
  - backend/framework

requirements:
  - 保持 API 兼容
  - Redis TTL 30min
  - 用户角色变化立即失效

acceptance:
  - unit tests pass
  - integration tests pass
  - no regression

status: READY
```

然后就结束了。

你继续聊：

```
下一个问题，我们研究 Excel 导出。
```

Dispatcher 在后台看到：

```
P043 READY
```

自动：

```
READY
 ↓
QUEUED
 ↓
create worktree
 ↓
create thread
 ↓
execute
```

------

# 八、Dispatcher 的核心逻辑其实非常简单

伪代码基本就是：

```
while True:

    plans = db.find(status="READY")

    running = db.count(status="RUNNING")

    capacity = MAX_EXECUTORS - running

    for plan in plans[:capacity]:

        worktree = create_worktree(plan)

        thread = codex.thread_start(
            model="gpt-5.6-luna",
            cwd=worktree,
            sandbox=Sandbox.workspace_write
        )

        set_thread_name(
            thread.id,
            f"[{plan.id}] {plan.title}"
        )

        db.assign(
            plan=plan.id,
            thread=thread.id,
            worktree=worktree
        )

        asyncio.create_task(
            execute(plan, thread)
        )
```

你的：

```
10 个执行线程
```

最后其实就变成：

```
MAX_EXECUTORS = 10
```

这比创建十个固定 Thread 干净很多。

------

# 九、这里有一个非常重要的架构决定

### 不要：

```
Executor-1
Executor-2
Executor-3
Executor-4
```

然后：

```
P001 → Executor-1
P002 → Executor-2
...
```

### 而是：

```
P001 → 创建 exec-P001 → 删除/归档
P002 → 创建 exec-P002 → 删除/归档
```

也就是说：

> **Plan 是长期对象；Executor 是短期对象。**

这是整个系统最关键的设计。

------

# 十、Worktree 生命周期

我推荐：

```
main
 │
 ├── P001
 │    └── ~/.codex-orchestrator/worktrees/P001
 │
 ├── P002
 │    └── ~/.codex-orchestrator/worktrees/P002
 │
 └── P003
      └── ~/.codex-orchestrator/worktrees/P003
```

branch：

```
plan/P001-user-cache

plan/P002-excel-export

plan/P003-role-permission
```

Plan 完成以后：

```
RUNNING

    ↓

Codex完成

    ↓

自动执行：
git status
tests
lint
build

    ↓

READY_FOR_REVIEW
```

然后系统**不要自动 Merge**。

停下来。

这是最适合你的 Human Gate。

------

# 十一、所以你每天看到的实际上只应该是两个 Inbox

这能大幅降低认知负担。

## Inbox 1

```
Plans waiting for approval

P041
P042
P043
```

也就是 Sol 和你正在研究的东西。

## Inbox 2

```
Changes waiting for merge

P035
P036
P039
```

这才需要你看。

中间：

```
READY
QUEUED
DISPATCHING
RUNNING
TESTING
```

你原则上都不需要管。

------

# 十二、失败也应该自动处理

例如：

```
P042

RUNNING
   ↓
tests fail
   ↓
executor receives:
"Tests failed. Diagnose and fix."
   ↓
tests
```

建议：

```
max_retries = 2
```

如果还失败：

```
BLOCKED
```

进入：

```
Human Attention
```

你才需要处理。

也就是说你的 Dashboard 甚至可以简化成三个栏目：

```
Needs Plan Review
       3

Needs Attention
       1

Needs Merge Review
       4
```

其他 20 个 RUNNING/QUEUED 的东西都不用看。

------

# 十三、不要让 Codex Desktop UI 成为状态数据库

这是另一个很重要的地方。

虽然现在 app-server 已经支持：

```
thread/list
thread/read
thread/status/changed
```

而且可以根据：

```
cwd
sourceKinds
parentThreadId
ancestorThreadId
```

过滤线程，[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

但你的 Orchestrator **仍然应该自己保存 Plan↔Thread↔Worktree 映射**。

例如：

```
P043

executor_thread:
thr_0af320...

worktree:
/Users/wang/worktrees/P043

branch:
plan/P043

status:
RUNNING
```

Codex Thread 只是执行后端。

SQLite 才是控制面的 Source of Truth。

这样即使：

```
Codex Desktop 重启
Thread UI发生变化
线程归档
Codex版本升级
```

你的任务状态都不会丢。

------

# 十四、Codex app-server 非常适合用来做 Dashboard

这点现在比之前成熟很多。

你可以监听：

```
thread/started

turn/started

item/started

item/completed

thread/status/changed

turn/completed

thread/archived
```

官方协议明确支持持续 streaming 这些事件。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

所以 Orchestrator 可以实时得到：

```
exec-P031

active
  ↓
running command
  ↓
editing
  ↓
testing
  ↓
idle
```

这意味着你的 Dashboard 不需要不断：

```
poll
poll
poll
```

而是：

```
Codex Event
     ↓
Event Handler
     ↓
SQLite
     ↓
WebSocket
     ↓
Dashboard
```

------

# 十五、甚至可以利用 Goal Mode

Codex 现在已经把 Goal Mode 做成正式能力，而且 app-server 提供：

```
thread/goal/set
```

例如：

```
{
  "objective": "完成用户权限缓存重构并保持测试通过",
  "status": "active",
  "tokenBudget": 40000
}
```

Goal 还会记录：

```
tokensUsed
timeUsedSeconds
``` citeturn964689view3


所以将来可以进一步变成：

```text
Plan
 ↓
Executor
 ↓
Goal = Plan objective
 ↓
Codex 长时间自主执行
```

这与官方现在的长期任务方向其实非常一致；OpenAI 也明确把“parallel threads + Skills + Automations + Git worktrees”作为长期 Codex 工作流的一组核心能力。[OpenAI Developers](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

------

# 十六、我建议分三个阶段做，不要一次做太重

### V1 —— 先解决 80% 的问题

```
Exploration Thread
       ↓
发布 Plan
       ↓
SQLite
       ↓
Dispatcher
       ↓
git worktree
       ↓
Python Codex SDK
       ↓
Luna Executor
       ↓
tests
       ↓
READY_FOR_REVIEW
```

界面甚至暂时不用做。

直接：

```
codex-orch status
```

返回：

```
PLANS

P021 RUNNING    exec-P021
P022 RUNNING    exec-P022
P023 READY
P024 REVIEW

EXECUTORS

exec-P021 ACTIVE
exec-P022 TESTING

REVIEW

P015 READY_TO_MERGE
P018 READY_TO_MERGE
```

这版就已经能让你从“盯着 Agent”中解放出来。

------

### V2 —— Dashboard

做一个很简单的：

```
FastAPI
+
Vue
+
SQLite
```

页面：

```
Overview

Plans

Executors

Review Queue

History
```

------

### V3 —— 真正的 Agent Orchestrator

再加入：

```
Dependency DAG
资源调度
优先级
自动失败恢复
自动重新规划
Plan 拆分
Plan dependency
并发冲突检测
自动 rebase
Review Agent
Test Agent
```

最后会变成：

```
Explore Agent
      ↓
Plan Registry
      ↓
Scheduler
      ↓
Executor Pool
      ↓
Verifier
      ↓
Human Review
      ↓
Merge
```

------

# 十七、还有一个边界需要特别注意

目前 SDK / app-server 的 `thread/start` 明确提供的是：

```
model
cwd
sandbox
...
```

而不是一个稳定公开的：

```
project_id=
worktree_id=
codex_desktop_project=
```

官方 Worktree 文档仍然把 Codex Desktop 自己创建/管理的 Worktree 视为 Desktop 功能；SDK/app-server 的通用控制点是 `cwd`。[OpenAI Developers](https://developers.openai.com/codex/environments/git-worktrees)

所以我的建议是：

> **不要把“Executor Thread 必须漂亮地显示在 Desktop 某个 Project 的特定 Worktree 节点下面”作为 V1 的硬依赖。**

正确优先级应该是：

```
1. worktree正确
2. thread正确
3. model正确
4. Plan绑定正确
5. 状态可观测
6. Desktop UI归类漂亮
```

尤其过去 Codex Desktop 对 worktree thread 的 UI 归类有过一些已报告的问题，因此你的 Orchestrator 自己保存状态会稳得多。当前官方底层接口已经足够让你绕过这一层 UI 依赖。[OpenAI Developers](https://developers.openai.com/codex/llms-full.txt)

------

# 十八、最后，把你的日常工作压缩一下

我认为你的最终工作方式应该变成这样：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
上午
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Exploration / Sol / Plan Mode

需求 A
 ↓
讨论
 ↓
Review
 ↓
“发布计划”

继续：

需求 B
 ↓
讨论
 ↓
Review
 ↓
“发布计划”

继续：

需求 C
...

完全不用看 Executor。


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
下午
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

打开 Review Queue

P021 READY_FOR_REVIEW
P022 READY_FOR_REVIEW
P025 BLOCKED
P028 READY_FOR_REVIEW

查看：

diff
tests
summary

满意：
Merge

不满意：
Reject
 ↓
回到原 Executor
 ↓
继续修


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Orchestrator 自动完成
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Plan排队
创建worktree
创建Luna Thread
执行
测试
修复
记录状态
生成日报
等待Review
```

这基本就是你最开始描述的目标状态。

------

## 我对你这个方案的核心建议

**不要做“10 个固定 Executor Thread 管理系统”。**

直接做成：

> **Plan-driven Dynamic Codex Orchestrator**

核心对象关系就是：

```
Exploration Thread
        │
        │ produces
        ▼
       Plan
        │
        │ dispatch
        ▼
Execution Run
   ├── Thread
   ├── Worktree
   ├── Branch
   └── GPT-5.6 Luna
        │
        ▼
     Result
        │
        ▼
  Review / Merge
```

而并发度仅仅是一个配置：

```
scheduler:
  max_parallel_executors: 10

models:
  planning: gpt-5.6-sol
  execution: gpt-5.6-luna
```

以后觉得机器、额度或者 Token 能撑得住：

```
max_parallel_executors: 20
```

整个架构完全不用变。

**这样你真正从“管理 10 个 Codex”升级成了“管理计划和结果”。**

这正是我认为最适合你当前开发方式的抽象层级。