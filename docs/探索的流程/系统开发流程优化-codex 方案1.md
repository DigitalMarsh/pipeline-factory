你的思路是对的，而且我建议再往前走一步：**不要把“10 个固定 Codex 执行线程”作为核心抽象，而应该把“Plan Task”作为核心抽象。** 执行线程、worktree、branch 都只是某个 Plan Task 的临时运行资源。

官方当前能力已经足够支撑这个架构：Codex SDK 可以程序化创建、继续和恢复本地 Codex thread，并且创建线程时可以指定模型；Codex CLI 也能通过 `-m` 选择模型。GPT-5.6 Sol 官方定位适合复杂、开放式、高判断力任务，而 GPT-5.6 Luna 适合明确、可重复、高吞吐任务，因此你的 Planner=Sol、Executor=Luna 分工非常合理。

## 一、我最推荐的最终形态

把整个系统拆成下面这几个角色：

```text
┌─────────────────────────────────────────────────────────────┐
│                Exploration / Planner Thread                  │
│                  GPT-5.6 Sol / Plan Mode                     │
│                                                             │
│  功能A → PLAN-001                                           │
│  功能B → PLAN-002                                           │
│  功能C → PLAN-003                                           │
│                                                             │
│  你只做：需求讨论 → Review Plan → Approve                   │
└────────────────────────────┬────────────────────────────────┘
                             │
                     approve PLAN-xxx
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    Plan Manager / MCP                        │
│                                                             │
│              SQLite = 唯一状态事实来源                       │
│                                                             │
│  Plan Registry │ Run Registry │ Worktree │ Events │ Locks   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                       Dispatcher                            │
│                                                             │
│ QUEUED → dependency check → conflict check → allocate       │
└───────────────┬────────────────┬────────────────┬────────────┘
                │                │                │
                ▼                ▼                ▼
       PLAN-001 Run      PLAN-002 Run      PLAN-003 Run
       Luna Thread       Luna Thread       Luna Thread
       Worktree A        Worktree B        Worktree C
       branch A          branch B          branch C
                │                │                │
                └────────────────┼────────────────┘
                                 ▼
                      test / lint / build
                                 │
                    ┌────────────┴─────────┐
                    ▼                      ▼
               MERGE_READY              FAILED
                    │                      │
                    │               resume same thread
                    │
                    ▼
               你人工 Review
                    │
                    ▼
                git merge
                    │
                    ▼
                  MERGED
```

最终你每天真正做的事情就变成你希望的两件：

**左手：**

```text
Sol Exploration Thread
    ↓
讨论功能
    ↓
产生 Plan
    ↓
Review
    ↓
Approve
    ↓
继续讨论下一个功能
```

**右手：**

```text
MERGE_READY 队列
    ↓
看 diff
    ↓
跑功能
    ↓
Review
    ↓
merge
```

中间所有调度过程都自动化。

---

# 二、最关键的改变：不要复用 plan-executer1～10

你现在是：

```text
plan-executer1
plan-executer2
...
plan-executer10
```

我建议以后把它改成：

```text
PLAN-20260814-001
    thread: 019...
    model: gpt-5.6-luna
    worktree: .worktrees/PLAN-20260814-001
    branch: agent/PLAN-20260814-001

PLAN-20260814-002
    thread: 01a...
    model: gpt-5.6-luna
    worktree: .worktrees/PLAN-20260814-002
    branch: agent/PLAN-20260814-002
```

也就是：

> **一个 Plan = 一个 Thread = 一个 Worktree = 一个 Branch**

任务结束，这个执行线程的生命周期也基本结束。

这比“executor7 今天先干功能 A、然后再干功能 B、再干功能 C”干净得多，因为不同功能不会不断污染同一个执行线程的上下文。Codex 官方最佳实践也建议让一个 chat 对应一个相对连贯的工作单元，并特别指出并行 agent 可以减少主线程中的上下文污染。

你的 `plan-executer1~10` 可以保留，但把它们降级成：

```text
execution-slot-01
execution-slot-02
...
execution-slot-10
```

它们只是“并发槽位”，而不是 Codex thread。

比如：

```text
slot-01 → PLAN-031 → thread abc → running
slot-02 → PLAN-032 → thread def → testing
slot-03 → idle
slot-04 → PLAN-034 → thread ghi → running
```

---

# 三、你要的两个管理视角，可以天然实现

最核心不是 Codex Thread 本身，而是一张中央任务表。

### Executor 视角

| Slot | Plan | Thread | Model | Worktree | 状态 | 当前动作 |
|---|---|---|---|---|---|---|
| 01 | PLAN-021 | th-a91 | Luna | wt-021 | RUNNING | 修改订单状态机 |
| 02 | PLAN-022 | th-b72 | Luna | wt-022 | TESTING | mvn test |
| 03 | — | — | — | — | IDLE | — |
| 04 | PLAN-024 | th-c18 | Luna | wt-024 | BLOCKED | 缺少接口定义 |

点击 PLAN-021，还可以看到：

```text
开始时间
执行时长
计划内容
Thread ID
Worktree
Branch
最近一次 Codex 输出
变更文件
当前 Git diff
测试结果
Commit SHA
```

而“今天这些 Executor 干了什么”，本质就是：

```sql
SELECT *
FROM runs
WHERE finished_at >= today
ORDER BY finished_at DESC;
```

例如：

```text
今日完成：

PLAN-013 用户导入功能
PLAN-014 登录日志优化
PLAN-016 库存锁定修复
PLAN-018 导出 Excel
PLAN-019 订单详情接口
```

---

# 四、探索线程视角更简单

你在 Sol 探索线程里应该可以直接问：

> 当前计划任务情况。

Plan Manager 返回：

| Plan | 功能 | 状态 | Executor | Worktree |
|---|---|---|---|---|
| PLAN-021 | 订单状态机 | RUNNING | slot-01 | wt-021 |
| PLAN-022 | 权限缓存 | TESTING | slot-02 | wt-022 |
| PLAN-023 | 用户导入 | QUEUED | — | — |
| PLAN-024 | 库存优化 | BLOCKED | slot-04 | wt-024 |
| PLAN-020 | Excel 导出 | MERGE_READY | — | wt-020 |
| PLAN-019 | API 修改 | MERGED | — | — |

这样探索线程就能知道：

```text
一共生成：24
等待审批：2
等待执行：3
正在执行：4
等待合并：5
已经合并：9
失败/阻塞：1
```

甚至你可以问：

> PLAN-021 怎么样了？

Sol 调 MCP：

```text
get_plan_status("PLAN-021")
```

返回：

```text
status       RUNNING
thread       019a...
model        gpt-5.6-luna
worktree     /xxx/.worktrees/PLAN-021
branch       agent/PLAN-021
current_step 3/7
activity     修改 OrderServiceImpl
started_at   09:14
```

因此**探索线程完全不用进入那些执行线程。**

---

# 五、这里强烈建议做一个很小的 MCP Server

这是整个架构里我认为最值钱的一层。

Codex 本身支持配置自定义 MCP server，官方也建议只接入真正能消除重复人工流程的工具。

做一个：

```text
codex-plan-manager-mcp
```

只提供几个工具即可，例如：

```text
create_plan
approve_plan
cancel_plan

get_plan
list_plans
get_plan_board

list_runs
get_run
get_executor_board
get_today_completed
```

以后你的 Sol 探索线程就变成：

```text
你：
这个方案可以，批准执行。

Sol：
调用
approve_plan(PLAN-037)

Plan Manager：
PLAN-037 → QUEUED

Dispatcher：
自动创建 worktree
自动创建 Luna thread
自动执行
```

然后 Sol 可以马上继续：

```text
你：
接下来讨论库存预占的问题……
```

**这就是你想要的“不盯执行线程”。**

---

# 六、Plan 本身也必须标准化

这是这套系统能不能稳定运行的核心。

不要让 Sol 输出纯自然语言计划然后直接交给 Luna。

我建议每个 Plan 固定成这样的结构：

```yaml
id: PLAN-20260814-037

title: 增加订单取消原因

goal:
  支持用户取消订单时记录取消原因

base_branch: main
base_commit: 71ae912

repositories:
  - backend
  - frontend

dependencies: []

conflict_keys:
  - order
  - order-api
  - order-ui

scope:
  - 增加 cancelReason 字段
  - 修改取消订单接口
  - 修改订单详情接口
  - 前端增加取消原因输入框

non_goals:
  - 不修改订单状态机
  - 不修改退款逻辑

implementation:
  - step: 1
    action: 修改数据库结构
  - step: 2
    action: 修改 DO/DTO/VO
  - step: 3
    action: 修改 service
  - step: 4
    action: 修改 controller
  - step: 5
    action: 修改 frontend

acceptance:
  - 用户取消订单必须填写原因
  - 订单详情能够查询取消原因
  - 老数据兼容

verification:
  backend:
    - mvn test
    - mvn package -DskipTests
  frontend:
    - npm run type-check
    - npm run build

execution_instruction:
  严格按照本计划实现。
  不扩展计划外功能。
  完成后执行 verification。
  输出修改文件、测试结果和未解决问题。
```

这里有一个特别重要的字段：

```text
non_goals
```

Sol 很擅长想得多。

Luna 最大的风险反而往往不是做不到，而是：

> “顺便帮你重构一下”。

所以一定要告诉 Executor：

```text
做什么
不做什么
怎样算完成
怎么验证
```

这会非常适合 Luna 官方定位的“clear, repeatable work”。

---

# 七、Dispatcher 状态机建议直接这么设计

不要只做：

```text
todo
doing
done
```

至少做：

```text
DRAFT
 ↓
REVIEWED
 ↓
APPROVED
 ↓
QUEUED
 ↓
ALLOCATING
 ↓
RUNNING
 ↓
VERIFYING
 ↓
MERGE_READY
 ↓
MERGED
```

旁路状态：

```text
RUNNING ───→ BLOCKED
   │
   └───────→ FAILED

VERIFYING ─→ FIXING
               │
               └→ VERIFYING

ANY ────────→ CANCELLED
```

这个模型以后非常重要。

因为你会发现：

> Codex “执行结束” ≠ 任务完成。

真正的完成条件应该是：

```text
Codex implementation finished
+
git diff exists
+
build success
+
tests success
+
acceptance checks success
```

才进入：

```text
MERGE_READY
```

---

# 八、动态创建 Luna 执行线程，现在可以直接实现

Python SDK 官方目前已经可以：

```python
thread = codex.thread_start(
    model="gpt-5.6-terra",
    sandbox=Sandbox.workspace_write,
)
```

也支持异步启动线程。把 model 改为：

```python
model="gpt-5.6-luna"
```

即可。

你的 Dispatcher 大致就是：

```python
async def execute(plan):

    worktree = create_git_worktree(plan)

    codex = AsyncCodex(
        CodexConfig(
            cwd=worktree.path
        )
    )

    thread = await codex.thread_start(
        model="gpt-5.6-luna"
    )

    save_mapping(
        plan_id=plan.id,
        thread_id=thread.id,
        worktree=worktree.path
    )

    result = await thread.run(
        build_executor_prompt(plan)
    )

    run_verification(plan)

    update_status(plan)
```

这里有一个需要特别说明的现实边界。

Codex Desktop 本身原生支持“New chat → Worktree”，并自动管理 Git worktree。

但是对于你这种**外部程序动态编排**，目前 SDK 更适合自己管理：

```text
git worktree
+
cwd
+
Codex SDK thread
```

而不是依赖 Desktop 内部的 Worktree 管理模型。OpenAI Codex 官方仓库里目前也有相关 worktree-aware SDK API 的需求讨论：SDK 有 `cwd`/working directory，但没有把 Desktop 的 Local/Worktree 生命周期完整暴露成一等 API。

所以我的建议非常明确：

> **Git worktree 归你自己的 Orchestrator 管。**
>
> **Codex 负责 worktree 里面的代码工作。**

这样最稳定。

---

# 九、Worktree 也不要让 Codex 自己随意创建

让 Dispatcher 做：

```bash
git worktree add \
  .worktrees/PLAN-037 \
  -b agent/PLAN-037 \
  <BASE_COMMIT>
```

然后：

```text
cwd =
project/.worktrees/PLAN-037
```

再创建 Luna thread。

执行结束后：

```text
agent/PLAN-037
        ↓
     commits
        ↓
  MERGE_READY
```

你 Review 后：

```bash
git merge agent/PLAN-037
```

成功：

```text
PLAN-037 → MERGED
```

最后：

```bash
git worktree remove .worktrees/PLAN-037
git branch -d agent/PLAN-037
```

这样 Git 是真正的隔离边界，而不是“Codex thread 是隔离边界”。

---

# 十、还需要解决一个非常实际的问题：并发冲突

假设 Sol 连续生成：

```text
PLAN-31 修改 OrderService
PLAN-32 修改 OrderController
PLAN-33 重构订单 DTO
PLAN-34 修改库存
PLAN-35 修改登录
```

不能单纯因为有 10 个 slot 就全部执行。

因为：

```text
31
32
33
```

高度可能冲突。

所以 Plan 增加：

```yaml
conflict_keys:
  - order
```

另外：

```yaml
PLAN-34:
conflict_keys:
  - inventory

PLAN-35:
conflict_keys:
  - auth
```

Dispatcher 就可以自动：

```text
PLAN-31 RUNNING

PLAN-32 WAITING_CONFLICT
PLAN-33 WAITING_CONFLICT

PLAN-34 RUNNING
PLAN-35 RUNNING
```

以后甚至可以让 Sol 在制定 Plan 时自动判断：

```text
affected_modules
affected_tables
affected_apis
affected_paths
conflict_keys
```

这会比简单的“最多 10 并发”稳定非常多。

---

# 十一、失败也不要找你

比如：

```text
Luna 完成代码
      ↓
mvn test
      ↓
FAIL
```

Dispatcher 自动：

```text
resume thread PLAN-037
```

把测试日志发进去：

```text
实现已经完成，但验证失败。

失败测试：
...

请定位并修复。
不要改变原 Plan scope。
修复后重新运行指定测试。
```

Codex SDK 本身支持继续同一 thread 和通过 thread ID 恢复已有 thread。

于是：

```text
RUNNING
 ↓
VERIFYING
 ↓ failed
FIXING
 ↓
VERIFYING
 ↓ success
MERGE_READY
```

建议自动修复最多：

```text
2~3 次
```

再失败：

```text
BLOCKED
```

这时才找你。

---

# 十二、Subagent 不建议作为主要 Executor

现在 Codex 已原生支持 subagent，可以 spawn 多个 agent、等待结果并汇总。

但是你的场景我不建议设计成：

```text
Sol Planner
   ├── Luna subagent
   ├── Luna subagent
   ├── Luna subagent
   └── Luna subagent
```

来承担主要功能开发。

官方文档也明确提醒：subagent 很适合 exploration、tests、triage 等 read-heavy 工作，但多个 agent 同时进行 write-heavy 代码修改会增加冲突和协调成本。

所以建议：

```text
Subagent
    ↓
需求探索
代码调查
测试分析
Review
```

而正式开发：

```text
Top-level Plan
      ↓
独立 Codex Thread
      ↓
独立 Git Worktree
```

两套机制分开。

---

# 十三、数据库其实只需要三张核心表

推荐 SQLite，**不要一开始用一堆 JSON 文件作为状态中心**。

```text
PLAN
────────────────────
id
title
status
priority
plan_content
dependencies
conflict_keys
base_commit
created_at
approved_at


RUN
────────────────────
id
plan_id
thread_id
model
worktree
branch
status
started_at
finished_at
commit_sha
summary


EVENT
────────────────────
id
plan_id
run_id
type
message
created_at
```

Event 记录：

```text
09:32 PLAN_APPROVED
09:32 QUEUED
09:33 WORKTREE_CREATED
09:33 THREAD_CREATED
09:34 CODEX_STARTED
09:47 CODEX_COMPLETED
09:48 VERIFY_STARTED
09:51 TEST_FAILED
09:51 FIX_STARTED
10:02 TEST_PASSED
10:02 MERGE_READY
```

这样所有你想看的东西都能算出来。

---

# 十四、你原来想要的“现场状态”以后其实会更强

Dashboard 首页可以直接这样：

```text
Development Control Center

Active             4
Queued              7
Merge Ready         5
Blocked             1
Merged Today        8


ACTIVE EXECUTIONS

PLAN-041  用户导入
██████████████░░  RUNNING
Luna · 23 min · backend
修改 UserImportService

PLAN-042  菜单权限
████████████████  VERIFYING
Luna · 16 min · backend
mvn test

PLAN-043  订单页面
████████░░░░░░░░  RUNNING
Luna · 8 min · frontend
修改 order/index.vue
```

另一个页面：

```text
PLAN BOARD

DRAFT
PLAN-049
PLAN-050

QUEUED
PLAN-044
PLAN-045

RUNNING
PLAN-041
PLAN-043

VERIFYING
PLAN-042

MERGE READY
PLAN-038
PLAN-039
PLAN-040

MERGED TODAY
PLAN-030
PLAN-031
...
```

这样你实际上已经做出了一个：

> **AI 开发流水线控制台。**

---

# 十五、我建议你不要一上来做“大型 Agent 平台”

可以分三阶段。

| 阶段 | 保留内容 | 新增内容 | 效果 |
|---|---|---|---|
| V1 | 现有 10 个执行线程 | SQLite Plan Manager + 状态面板 | 先解决“看不清任务状态” |
| V2 | 删除固定执行线程 | Codex SDK + 动态 Luna Thread + Git worktree | 解决“需要人工派任务” |
| V3 | 动态执行体系 | 自动 test/fix、conflict lock、MCP | 基本实现无人值守执行 |

但是如果现在让我替你做技术选型，我会直接把目标架构定成：

```text
                    Codex Desktop
                         │
          ┌──────────────┴──────────────┐
          │                             │
     Sol Planner                  Human Review
          │                             │
          ▼                             ▼
     Plan Manager                  Merge Queue
        MCP/API
          │
          ▼
       SQLite
          │
          ▼
      Dispatcher
          │
    ┌─────┼─────┐
    ▼     ▼     ▼
 Luna   Luna   Luna
Thread Thread Thread
    │     │     │
   WT1   WT2   WT3
```

技术栈我会选：

```text
Orchestrator：
Python

Codex：
openai-codex Python SDK

状态：
SQLite

接口：
FastAPI

Planner 接口：
自定义 MCP Server

Worktree：
原生 git worktree

Dashboard：
Vue

执行模型：
gpt-5.6-luna

规划模型：
gpt-5.6-sol
```

**Agents SDK 暂时不要引入。**

虽然官方也支持把 Codex CLI 作为 MCP server 交给 Agents SDK 编排，而且 Agents SDK 能负责 agent handoff 和 traces， 但你的调度逻辑本质上是确定性的：

```text
Plan → Queue → Worktree → Codex → Verify → Merge
```

这种场景自己写 500～1500 行左右的 Orchestrator，通常会比再放一个 AI Supervisor 在中间更透明、更稳定、更容易恢复。

---

## 最终我认为你应该形成这样的工作习惯

你打开 Codex 后，长期只需要关心两个区域。

**一个长期存在的 Sol Exploration Thread：**

```text
探索需求
→ 制定方案
→ Review Plan
→ “批准 PLAN-xxx”
→ 马上探索下一项
```

**一个 Merge Ready 页面：**

```text
PLAN-037  Ready
PLAN-038  Ready
PLAN-041  Ready

点进去：
diff
build
tests
Codex summary

Review
→ merge
```

而下面这些事情：

```text
创建执行线程
指定 Luna
创建 worktree
选择 branch
发送 Plan
等待 Codex
观察 Codex
失败重试
执行测试
记录状态
统计今天干了什么
维护 1~10 executor
```

**全部从你的日常工作里消失。**

这才是我认为最适合你现在工作方式的演进方向。

如果继续往下落地，我建议下一步不是继续讨论概念，而是直接设计 **`codex-orchestrator` V1 的目录结构、SQLite 表结构、Plan YAML Schema、MCP tools、Dispatcher 状态机，以及 Python Codex SDK 的完整执行流程**。这部分一旦定下来，基本就可以直接让 Codex 开始实现。