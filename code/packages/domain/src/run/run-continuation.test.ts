/**
 * 测试职责：补充要求把"执行线程的人工输入"从一行只进不出的 journal 变成真能驱动 Agent 的路径。
 *
 * 为什么值得单独一个文件：这一段修的是**报障**——Run 执行完了但没合并（`MERGE_READY`），想再让
 *   Agent 补做一轮，而输入框点不动。查下来是三层都断：线程在 Loop 收尾时被判 `COMPLETED`、
 *   `USER_GUIDANCE` 没有任何地方送进模型、以及 `RECOVERING` 的 Run 同样只能取消。所以这里钉的是
 *   **投递之后真的发生了什么**，而不只是"状态字段变成了什么"。
 *
 * 维护提示：任务/步骤状态**不重置**是本功能的语义核心（见 continueRun 的说明）。改动续跑路径时，
 *   必须保证"不动 journal"这条不变式仍然成立——这里有一条用例专门钉它。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, ProjectService, Scheduler, type AgentLoop, type ExecutorContinuation, type PlanRevision, type Run, type RunStatus } from "../index.js";
import { planContractFixture } from "../plan/plan-fixture.js";
import { parseExecutorReport } from "../agent/executor-agent.js";

type Seeded = {
  store: InMemoryPipelineStore;
  scheduler: Scheduler;
  run: Run;
  revision: PlanRevision;
  /** 每次 `executor.start` 收到的第三个参数——续跑的"问模型什么"全在这里。 */
  starts: Array<{ runId: string; continuation: ExecutorContinuation | undefined }>;
};

async function seedRun(options: { runStatus?: RunStatus; threadState?: "ACTIVE" | "COMPLETED" | "PAUSED" } = {}): Promise<Seeded> {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  // `planContractFixture` 的合同里声明了这两条验证命令，派发前会核对它们**已登记且启用**
  // （RUN_PREREQUISITES_UNSATISFIED），所以 fixture 必须把它们登记上。
  projects.create({ id: "project-continuation", name: "Continuation", repoRoot: "/repo/continuation", defaultBranch: "main", worktreeRoot: "/tmp/continuation-worktrees", settings: { commands: [{ commandId: "project.test", category: "verification", enabled: true, argv: ["true"] }, { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] }] } });
  const plans = new PlanService(store, projects);
  const plan = plans.createCandidatePlan({ projectId: "project-continuation", sourceExplorerThreadId: "thread-1", title: "Continuation", resolvedContract: planContractFixture({ store, projectId: "project-continuation", title: "Continuation" }) });
  plans.confirm(plan.id, "user-1");
  plans.enqueue(plan.id);
  plans.dispatch(plan.id);

  const starts: Seeded["starts"] = [];
  const scheduler = new Scheduler({
    store,
    workspace: { create: async (input) => ({ path: `/tmp/continuation/${input.runId}`, branch: input.branch, baseCommit: input.baseCommit }), remove: async () => undefined },
    hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executor: {
      start: async (run, _revision, continuation) => {
        starts.push({ runId: run.id, continuation });
        const loop: AgentLoop = {
          id: `agent-loop-${starts.length}`,
          ownerType: "run",
          ownerId: run.id,
          role: "executor",
          mode: "provider-controlled",
          state: "RUNNING",
          stepCount: 0,
          maxSteps: 40,
          startedAt: store.now(),
          completedAt: null,
          providerThreadId: null,
          providerTurnId: null,
          checkpointJson: null,
        };
        return store.saveAgentLoop(loop);
      },
    },
  });

  const run = await scheduler.start(plan.id);
  const revision = store.getRevision(run.planId, run.planRevision)!;
  // 上一条用例之外的一切都从这里开始：把 fixture 直接摆到目标状态，不去走验证/合并那条长路。
  if (options.runStatus) store.saveRun({ ...store.getRun(run.id)!, status: options.runStatus });
  if (options.threadState) {
    const thread = store.getExecutionThread(run.executionThreadId)!;
    store.saveExecutionThread({ ...thread, state: options.threadState });
  }
  // 上一轮的 Loop 已经跑完（留下 providerThreadId，续跑要接上它）；run-1 是刚才 start 建的那条。
  for (const loop of store.listAgentLoops(run.id)) store.updateAgentLoop({ ...loop, state: "COMPLETED", completedAt: store.now(), providerThreadId: "provider-thread-1" });
  return { store, scheduler, run, revision, starts };
}

function setPlanStatus(store: InMemoryPipelineStore, planId: string, status: string): void {
  const plan = store.getPlan(planId)!;
  store.updatePlan({ ...plan, status: status as typeof plan.status });
}

describe("补充要求：投递之后真的驱动 Agent", () => {
  it("**MERGE_READY 上投递，Run 按业务流程重新走一遍**，并带着补充要求起新的一轮", async () => {
    const { store, scheduler, run } = await seedRun({ runStatus: "MERGE_READY", threadState: "COMPLETED" });
    setPlanStatus(store, run.planId, "MERGE_READY");

    const result = await scheduler.addGuidance(run.id, "把空指针也一并修了");

    expect(result.continued).toBe(true);
    // 状态回退三处：Run / Plan / Thread。Plan 那条是状态表里声明过的合法边，不是新开的路。
    expect(store.getRun(run.id)?.status).toBe("IN_PROGRESS");
    expect(store.getPlan(run.planId)?.status).toBe("IN_PROGRESS");
    expect(store.getExecutionThread(run.executionThreadId)?.state).toBe("ACTIVE");
    // 投递出去了：这条要求已经从"待处理"变成"已交给模型"。
    expect(result.guidance.status).toBe("CONSUMED");
  });

  it("**起新的一轮时把补充要求与「已完成的步骤」一起交给模型**，并接上上一轮的 Provider 会话", async () => {
    const { scheduler, starts, run, store } = await seedRun({ runStatus: "MERGE_READY", threadState: "COMPLETED" });
    setPlanStatus(store, run.planId, "MERGE_READY");
    // 上一轮报过 task-1 完成（结构化事实 + 老格式报告各一条，两种来源都要认）。
    const taskIds = store.getRevision(run.planId, run.planRevision)!.resolvedContract.tasks.map((task) => task.id);
    store.appendExecutionJournal({ executionThreadId: run.executionThreadId, runId: run.id, type: "TASK_PROGRESS", payload: { action: "task-status", completedTaskIds: [taskIds[0]] } });
    store.appendExecutionJournal({ executionThreadId: run.executionThreadId, runId: run.id, type: "MODEL_OUTPUT", payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: taskIds.slice(1), changedPaths: [], report: "done" })}</pipeline-factory-execution-report>` } });

    await scheduler.addGuidance(run.id, "再补一个边界用例");

    const continuation = starts.at(-1)?.continuation;
    expect(continuation?.guidance).toBe("再补一个边界用例");
    expect(continuation?.previousProviderThreadId).toBe("provider-thread-1");
    // 两种来源的完成任务都被认了出来，而且**是给模型看的清单**，不是状态回退。
    expect([...continuation!.completedTaskIds].sort()).toEqual([...taskIds].sort());
  });

  it("**任务/步骤状态一个字都不动** —— 续跑不改 journal，界面因此保持原样", async () => {
    const { store, scheduler, run } = await seedRun({ runStatus: "MERGE_READY", threadState: "COMPLETED" });
    setPlanStatus(store, run.planId, "MERGE_READY");
    store.appendExecutionJournal({ executionThreadId: run.executionThreadId, runId: run.id, type: "TASK_PROGRESS", payload: { action: "task-lifecycle", taskId: "task-1", state: "DONE" } });
    store.appendExecutionJournal({ executionThreadId: run.executionThreadId, runId: run.id, type: "TASK_PROGRESS", payload: { action: "task-lifecycle", taskId: "task-2", state: "IN_PROGRESS" } });
    const taskLifecycleFacts = () => store.getExecutionThread(run.executionThreadId)!.journal
      .filter((entry) => entry.type === "TASK_PROGRESS" && entry.payload.action === "task-lifecycle")
      .map((entry) => JSON.stringify(entry.payload));
    const before = taskLifecycleFacts();

    await scheduler.addGuidance(run.id, "只剩 task-2 了，把它做完");

    // 任务级事实与续跑前逐字一致：没有任何一条被改写、被补写、被重置。
    expect(taskLifecycleFacts()).toEqual(before);
  });

  it("**RECOVERING 的 Run 同样能续跑** —— 那是第二个同样的死胡同（进程重启后 Loop 被判死）", async () => {
    const { store, scheduler, run, starts } = await seedRun({ runStatus: "RECOVERING", threadState: "ACTIVE" });

    const result = await scheduler.addGuidance(run.id, "进程重启了，接着刚才的做");

    expect(result.continued).toBe(true);
    expect(store.getRun(run.id)?.status).toBe("IN_PROGRESS");
    expect(starts.at(-1)?.continuation?.guidance).toBe("进程重启了，接着刚才的做");
  });

  it("**BLOCKED 与已取消的 Run 拒绝补充要求，且不产生任何状态写入**", async () => {
    for (const status of ["BLOCKED", "NEEDS_PLAN_CHANGE", "CANCELLED", "STALE"] as const) {
      const { store, scheduler, run } = await seedRun({ runStatus: status, threadState: "COMPLETED" });
      const before = { run: store.getRun(run.id)!.status, thread: store.getExecutionThread(run.executionThreadId)!.state, journal: store.getExecutionThread(run.executionThreadId)!.journal.length };

      await expect(scheduler.addGuidance(run.id, "试试")).rejects.toThrow(new RegExp(status));

      expect(store.getRun(run.id)?.status).toBe(before.run);
      expect(store.getExecutionThread(run.executionThreadId)?.state).toBe(before.thread);
      expect(store.getExecutionThread(run.executionThreadId)?.journal).toHaveLength(before.journal);
      expect(store.listRunGuidance(run.id)).toHaveLength(0);
    }
  });

  it("**暂停中的 Run 只收下不发动** —— 随手把它翻回 ACTIVE 等于把用户的暂停作废", async () => {
    const { store, scheduler, run, starts } = await seedRun({ runStatus: "IN_PROGRESS", threadState: "PAUSED" });
    const startsBefore = starts.length;

    const result = await scheduler.addGuidance(run.id, "等你恢复之后再按这个做");

    expect(result.continued).toBe(false);
    expect(starts).toHaveLength(startsBefore);
    expect(store.getExecutionThread(run.executionThreadId)?.state).toBe("PAUSED");
    // 收下了，但没投递出去——界面必须显示成「待处理」。
    expect(store.listRunGuidance(run.id, { status: "PENDING" })).toHaveLength(1);
  });

  it("正在跑的 Loop 收到投递时只排队，不另起一轮", async () => {
    const { store, scheduler, run, starts } = await seedRun({ runStatus: "IN_PROGRESS", threadState: "ACTIVE" });
    // 把最近那条 Loop 摆回 RUNNING，模拟"还跑着"。
    for (const loop of store.listAgentLoops(run.id)) store.updateAgentLoop({ ...loop, state: "RUNNING", completedAt: null });
    const startsBefore = starts.length;

    const result = await scheduler.addGuidance(run.id, "中途补充");

    expect(result.continued).toBe(false);
    expect(result.guidance.mode).toBe("QUEUE");
    expect(starts).toHaveLength(startsBefore);
    expect(store.listRunGuidance(run.id, { status: "PENDING" })).toHaveLength(1);
  });

  it("`mode: \"steer\"` 时记成 STEER 交给正在跑的 Loop，而不是排队起新的一轮", async () => {
    const { store, scheduler, run } = await seedRun({ runStatus: "IN_PROGRESS", threadState: "ACTIVE" });
    for (const loop of store.listAgentLoops(run.id)) store.updateAgentLoop({ ...loop, state: "RUNNING", completedAt: null });

    const result = await scheduler.addGuidance(run.id, "立刻插一句", { mode: "STEER" });

    expect(result.guidance.mode).toBe("STEER");
    expect(result.continued).toBe(false);
    expect(store.listRunGuidance(run.id, { mode: "STEER", status: "PENDING" })).toHaveLength(1);
  });

  it("**排队的要求在 Run 停下时被取走** —— 那正是「排队」两个字的兑现", async () => {
    const { store, scheduler, run, starts } = await seedRun({ runStatus: "MERGE_READY", threadState: "COMPLETED" });
    setPlanStatus(store, run.planId, "MERGE_READY");
    store.saveRunGuidance({ id: "guidance-queued", runId: run.id, content: "排队的补充", mode: "QUEUE", status: "PENDING", authorId: "local-user", createdAt: store.now(), consumedAt: null });
    const startsBefore = starts.length;

    const continued = await scheduler.consumeQueuedGuidance(run.id);

    expect(continued).toBe(true);
    expect(starts).toHaveLength(startsBefore + 1);
    expect(starts.at(-1)?.continuation?.guidance).toBe("排队的补充");
    expect(store.listRunGuidance(run.id, { status: "CONSUMED" })).toHaveLength(1);
  });

  it("**开新的一轮之前把旧的合并请求作废** —— 不做就会把没重新验证过的改动一起合进去", async () => {
    const { store, scheduler, run } = await seedRun({ runStatus: "MERGE_READY", threadState: "COMPLETED" });
    setPlanStatus(store, run.planId, "MERGE_READY");
    store.saveMergeRequest({ id: "merge-1", runId: run.id, planId: run.planId, sourceCommit: "commit-before-continuation", targetBranch: "main", status: "OPEN", humanConfirmationRequired: true, createdAt: store.now(), mergedAt: null });

    await scheduler.addGuidance(run.id, "再来一轮");

    expect(store.getMergeRequest("merge-1")?.status).toBe("SUPERSEDED");
    // 作废之后 findByRun 不再返回它——`createRequest` 的幂等因此不会命中一个过期的请求。
    expect(store.findMergeRequestByRun(run.id)).toBeUndefined();
  });
});

describe("补充要求的解析工具", () => {
  it("老格式（只有 MODEL_OUTPUT 报告）里的完成任务同样被认出来", () => {
    // 这条不是"顺手加的"：兼容路径是 continueRun 给模型的那份清单的一部分，
    // 认不出来就会让模型把已经做完的步骤再做一遍。
    const report = parseExecutorReport(`some prose\n<pipeline-factory-execution-report>{"completedTaskIds":["task-1"],"changedPaths":[],"report":"ok"}</pipeline-factory-execution-report>`);
    expect(report?.completedTaskIds).toEqual(["task-1"]);
  });
});
