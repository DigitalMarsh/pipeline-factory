/**
 * 模块职责：Scheduler —— Plan 队列的调度中枢：把 ENQUEUED 的 CandidatePlan 变成 Run，
 *   串起 Worktree、Hook、Executor、Verification 与 Run 状态推进。
 *
 * 为什么从 index.ts 抽出来：这是领域层里最长的单个类（约 280 行），且是"Plan 如何变成
 *   执行"这一核心流程的唯一实现。搬出来之后它可以和 run/ 目录下的 dispatch-coordinator、
 *   recovery-coordinator、verification、merge 并排阅读，整条 Run 生命周期第一次出现在同一
 *   个目录里。
 *
 * 维护提示：
 *   1) **调度只读 Revision 里冻结的 Project 快照**（类头注释即写此约束），不重新读取当前
 *      Project 配置。这是"同一份 Plan 在配置变更后仍按确认时的语义执行"的唯一保证；
 *      顺手把 snapshot 换成 live project 会让历史 Plan 悄悄改用新配置。
 *   2) PlanService 是在构造函数里 **new** 出来的（不是注入）。它的 store 来自 options.store。
 *      改 PlanService 的构造签名要同时改这里与 ExplorerThreadService。
 *   3) **Scheduler 本身不做并发判定**：容量、依赖与冲突都在 PlanDispatchCoordinator 的
 *      evaluateWait 里于派发**之前**决定，Scheduler.start 只负责"已经被允许的这一次派发"。
 *      在这里再加一道上限会让同一个规则有两处实现（历史上就是那样，结果两处都不生效）。
 *   4) status → 状态的推进一律走 updatePlanStatus（先写事实再追加事件）。这里出现的几处
 *      BLOCKED 是 Hook 失败、取消、前置条件不满足三条路径，各自带不同的 attentionReason——
 *      文案是排障线索，不要统一。
 *   5) 分支名生成走 run/run-branch.js（runBranchName / allocateRunBranchLeaf / composeRunBranchLeaf /
 *      normalizeRunBranchSlug），它是"同一 Plan 的多次 Run 不撞分支名"的保证，不要在本地
 *      拼字符串。
 *   6) 前置条件校验（RUN_PREREQUISITES_UNSATISFIED）在派发**之前**抛出，是唯一阻止
 *      "用到未注册的验证命令"的关口。
 */
import { existsSync } from "node:fs";
import { updatePlanStatus } from "../plan/status-transition.js";
import { missingVerificationCommands } from "../plan/contract.js";
import { PlanService } from "../plan/service.js";
// 直接从模块 import 而不是走 barrel：`import type ... from "../index.js"` 那一片是本模块对 barrel
// 的**类型级**依赖，加一条值级 import 会立刻变成 check-cycles 会报的运行时环。
import { parseExecutorReport } from "../agent/executor-agent.js";
import { allocateRunBranchLeaf, composeRunBranchLeaf, normalizeRunBranchSlug, runBranchName } from "./run-branch.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { RunBranchNameGenerator } from "./run-branch.js";
import type { ProjectExecutionSnapshot } from "../project/project.js";
import type {
  AgentLoop,
  AgentLoopRunner,
  CandidatePlan,
  ExecutionJournalEntry,
  ExecutionThread,
  ExecutionThreadState,
  ExecutorContinuation,
  HookDefinition,
  HookRunResult,
  JournalEntryType,
  LifecycleHookRunner,
  PlanRevision,
  Run,
  RunGuidance,
  RunGuidanceMode,
  RunStatus,
  Workspace,
  WorkspaceAdapter,
} from "../index.js";

export type SchedulerOptions = {
  store: PipelineStore;
  workspace: WorkspaceAdapter;
  hooks: LifecycleHookRunner;
  workspaceFactory?: (snapshot: ProjectExecutionSnapshot) => WorkspaceAdapter;
  hookRunnerFactory?: (snapshot: ProjectExecutionSnapshot) => LifecycleHookRunner;
  branchNameGenerator?: RunBranchNameGenerator;
  executor?: {
    /** 第三个参数非空表示这是**补充要求驱动的续跑**（问模型什么、接不接上一轮会话都由它决定）。 */
    start(run: Run, revision: PlanRevision, continuation?: ExecutorContinuation | undefined): Promise<AgentLoop>;
    pause?: AgentLoopRunner["pause"];
    resume?: AgentLoopRunner["resume"];
    cancel?: AgentLoopRunner["cancel"];
  };
};

/**
 * 接受补充要求的 Run 状态。
 *
 * `BLOCKED` 与 `NEEDS_PLAN_CHANGE` 刻意不在里面：它们常常意味着"计划本身有问题"，用一句话把它们
 * 顶开会把真问题盖住——那两种该走「创建更新版本」。`QUEUED` / `STARTING` 也不在：Run 还没跑起来，
 * 此时该补的是 Plan 而不是执行。
 */
const ACCEPTS_GUIDANCE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "IN_PROGRESS",
  "READY_FOR_VERIFY",
  "VERIFYING",
  "MERGE_READY",
  "RECOVERING",
]);

/**
 * Loop **活着**（进程里还有执行协程）的状态。`RECOVERING` 与所有终态都算没有——前者是进程重启后
 * 被判死的 Loop，把它当成"正在跑"会让一个需要恢复的 Run 永远起不来新的一轮。
 */
const LIVE_RUN_LOOP_STATES: ReadonlySet<AgentLoop["state"]> = new Set<AgentLoop["state"]>([
  "CREATED",
  "RUNNING",
  "WAITING_FOR_INPUT",
  "PAUSED",
]);

/**
 * 协调 Plan 队列、Worktree、Hook、Executor、Verification 和 Run 状态。
 * 调度使用 Revision 中冻结的 Project 快照，不重新读取当前 Project 配置。
 */
export class Scheduler {
  private readonly planService: PlanService;
  private readonly runs = new Map<string, Run>();
  private readonly threads = new Map<string, ExecutionThread>();

  constructor(private readonly options: SchedulerOptions) {
    this.planService = new PlanService(options.store);
  }

  /** 暴露 Executor Loop 的控制端口，供 API 的暂停、恢复和终止按钮调用。 */
  agentLoopController(): Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> | undefined {
    const executor = this.options.executor;
    if (!executor?.pause || !executor.resume || !executor.cancel) return undefined;
    return { pause: executor.pause.bind(executor), resume: executor.resume.bind(executor), cancel: executor.cancel.bind(executor) };
  }

  /** 每个不可变 Plan Revision 最多创建一个 Run；失败重试复用原 Run 和 ExecutionThread。 */
  async start(planId: string, hooks: { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined } = {}): Promise<Run> {
    const plan = this.planService.get(planId);
    const existing = this.options.store.listRuns().find((run) => run.planId === planId && run.planRevision === plan.revision);
    if (existing) {
      this.runs.set(existing.id, existing);
      const savedThread = this.options.store.getExecutionThread(existing.executionThreadId);
      if (savedThread) this.threads.set(savedThread.id, savedThread);
      return existing;
    }
    if (plan.status !== "DISPATCHED") throw new Error(`Plan ${planId} must be dispatched before a run starts`);
    const revision = this.options.store.getRevision(plan.id, plan.revision);
    if (!revision) throw new Error(`Plan revision ${plan.id}@${plan.revision} is missing`);
    this.assertVerificationCommands(revision);
    const createdAt = this.options.store.now();
    const baseBranchLeaf = await this.runBranchLeaf(plan, revision, createdAt);
    const createOrReuse = (): { run: Run; thread: ExecutionThread; created: boolean } => {
      const raced = this.options.store.listRuns().find((run) => run.planId === planId && run.planRevision === revision.revision);
      if (raced)
        return {
          run: raced,
          thread: this.options.store.getExecutionThread(raced.executionThreadId) ?? {
            id: raced.executionThreadId,
            runId: raced.id,
            state: "ACTIVE",
            journal: [],
          },
          created: false,
        };
      const branchLeaf = allocateRunBranchLeaf(
        baseBranchLeaf,
        this.options.store.listRuns().map((run) => run.branch),
      );
      const runId = this.options.store.nextId("run");
      const thread: ExecutionThread = { id: this.options.store.nextId("execution-thread"), runId, state: "ACTIVE", journal: [] };
      const run: Run = {
        id: runId,
        projectId: plan.projectId,
        planId: plan.id,
        planRevision: revision.revision,
        status: "STARTING",
        branch: runBranchName(branchLeaf),
        workspacePath: null,
        baseCommit: revision.resolvedContract.repository.baseCommit,
        executionThreadId: thread.id,
        createdAt,
        startedAt: null,
      };
      this.options.store.saveRun(run);
      this.options.store.saveExecutionThread(thread);
      this.append(thread.id, "RUN_CREATED", { planId: plan.id, revision: revision.revision });
      return { run, thread, created: true };
    };
    const record = this.options.store.runInTransaction ? this.options.store.runInTransaction(createOrReuse) : createOrReuse();
    const { run, thread } = record;
    this.runs.set(run.id, run);
    this.threads.set(thread.id, thread);
    if (!record.created) return run;
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    const executionHooks = revision.projectConfigSnapshot?.settings.hooks ?? hooks;
    // Worktree、Start Hook 和 Executor 按顺序执行：任何前置阶段失败都阻止模型写入，
    // 同时把 BLOCKED 事实写回 Plan 和 ExecutionThread，便于 UI 显示可诊断原因。
    let workspace: Workspace;
    try {
      workspace = await workspaceAdapter.create({
        projectId: plan.projectId,
        runId: run.id,
        branch: run.branch,
        baseCommit: run.baseCommit,
      });
    } catch (error) {
      // 工作区不干净（PROJECT_WORKING_TREE_DIRTY）、baseCommit 不存在、git 不可用都走这里。
      // **不能让它变成未捕获异常**：那样 Run 会停在"已创建但没有 worktree"的半状态，
      // 用户只看到派发没成功，却看不到原因，还得去翻日志。
      const reason = error instanceof Error ? error.message : String(error);
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.setThreadState(thread.id, "BLOCKED");
      this.append(thread.id, "TASK_PROGRESS", { state: "BLOCKED", reason });
      updatePlanStatus(
        this.options.store,
        plan,
        { runId: run.id, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() },
        reason,
      );
      this.options.store.saveRun(run);
      return run;
    }
    run.workspacePath = workspace.path;
    run.baseCommit = workspace.baseCommit;
    this.options.store.saveRun(run);
    const startResult = await hookRunner.runStart(executionHooks.start, {
      projectId: plan.projectId,
      runId: run.id,
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      exitReason: "running",
    });
    this.recordHookExecutions(run.id, startResult);
    // 判 BLOCKED 要用 `blocked` 而不是 `status === "failed"`：配了 blocking: false 的启动钩子
    // 失败后 Run 还要继续往下走（见 run/hooks.ts 维护提示 1）。载荷里的 `blocking` 是给
    // 非阻塞失败留的现场——那种情况下 Run 不会停在 BLOCKED，这条 journal 是唯一的记录。
    if (startResult.status === "failed") {
      this.append(thread.id, "HOOK_FAILED", { hook: "start", stderr: startResult.result?.stderr ?? "", blocking: startResult.blocked });
    }
    if (startResult.blocked) {
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.setThreadState(thread.id, "BLOCKED");
      updatePlanStatus(
        this.options.store,
        plan,
        { runId: run.id, status: "BLOCKED", attentionReason: "start hook failed", lastEventAt: this.options.store.now() },
        "start hook failed",
      );
      this.options.store.saveRun(run);
      return run;
    }
    run.status = "IN_PROGRESS";
    run.startedAt = this.options.store.now();
    // 失败且非阻塞时上面已经写过 HOOK_FAILED，这里不能再写一条 HOOK_COMPLETED。
    if (startResult.status !== "failed")
      this.append(thread.id, startResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "start" });
    if (!revision.projectConfigSnapshot)
      this.append(thread.id, "TASK_PROGRESS", {
        action: "legacy_plan_revision",
        reason: "Project configuration snapshot unavailable; using legacy/global runtime settings",
      });
    updatePlanStatus(this.options.store, plan, { runId: run.id, status: "IN_PROGRESS", lastEventAt: run.startedAt });
    this.options.store.saveRun(run);
    if (this.options.executor) {
      try {
        const loop = await this.options.executor.start(run, revision);
        this.append(thread.id, "TASK_PROGRESS", { action: "executor_loop_created", loopId: loop.id });
        this.options.store.appendEvent({
          type: "run.executor.event",
          aggregateId: run.id,
          payload: { executionThreadId: thread.id, action: "executor_loop_created", loopId: loop.id },
        });
      } catch (error) {
        run.status = "BLOCKED";
        this.setThreadState(thread.id, "BLOCKED");
        const reason = error instanceof Error ? error.message : String(error);
        this.append(thread.id, "RECOVERY", { action: "executor_loop_start_failed", reason });
        updatePlanStatus(
          this.options.store,
          plan,
          { runId: run.id, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() },
          reason,
        );
        this.options.store.saveRun(run);
      }
    }
    return run;
  }

  private async runBranchLeaf(plan: CandidatePlan, revision: PlanRevision, createdAt: string): Promise<string> {
    let summary = normalizeRunBranchSlug(plan.title) ?? "change";
    if (this.options.branchNameGenerator) {
      try {
        summary = await this.options.branchNameGenerator.generate({
          createdAt,
          planTitle: plan.title,
          goal: revision.resolvedContract.objective.goal,
        });
      } catch {
        summary = "change";
      }
    }
    return composeRunBranchLeaf(createdAt, summary);
  }

  /** 完成或取消 Run，按同一 Revision 执行 Worktree 清理和 Cleanup Hook。 */
  async finish(
    runId: string,
    exitReason: string,
    hooks: { cleanup?: HookDefinition | undefined } = {},
    cancellationReason = exitReason,
  ): Promise<Run> {
    const run = this.run(runId);
    if (run.status === "CANCELLED") {
      if (exitReason === "cancelled") {
        const plan = this.options.store.getPlan(run.planId);
        if (plan && plan.status !== "BLOCKED" && plan.status !== "MERGED") {
          updatePlanStatus(
            this.options.store,
            plan,
            { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() },
            `Run cancelled: ${cancellationReason}`,
          );
        }
      }
      return run;
    }
    const thread = this.thread(run.executionThreadId);
    const revision = this.options.store.getRevision(run.planId, run.planRevision);
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    const executionHooks = revision?.projectConfigSnapshot?.settings.hooks ?? hooks;
    if (run.workspacePath) {
      await workspaceAdapter.remove({ path: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit });
    }
    const cleanupResult = await hookRunner.runCleanup(executionHooks.cleanup, {
      projectId: run.projectId,
      runId: run.id,
      workspacePath: run.workspacePath ?? "",
      branch: run.branch,
      baseCommit: run.baseCommit,
      exitReason,
    });
    this.recordHookExecutions(run.id, cleanupResult);
    this.append(
      thread.id,
      cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED",
      { hook: "cleanup", exitReason },
    );
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, attentionReason: "cleanup hook failed", lastEventAt: this.options.store.now() });
    }
    if (exitReason === "cancelled") run.status = "CANCELLED";
    this.setThreadState(thread.id, exitReason === "cancelled" ? "CANCELLED" : "COMPLETED");
    this.options.store.saveRun(run);
    if (exitReason === "cancelled") {
      const plan = this.options.store.getPlan(run.planId);
      if (plan)
        updatePlanStatus(
          this.options.store,
          plan,
          { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() },
          `Run cancelled: ${cancellationReason}`,
        );
    }
    return run;
  }

  /**
   * 释放某个 Run 的 Worktree 并执行一次 cleanup hook，**不改任何状态**。
   *
   * 为什么需要它：`finish()` 只在取消/显式退出时被调用，而"人工合并完成"这条路以前只翻 Plan
   * 状态（`MergeService.confirmMerged`）——于是合并后的 Worktree 永远留在磁盘上，
   * `storage.worktreeRoot` 只增不减。合并是"这个 Run 的代码已经进主干"的确定信号，此刻回收目录
   * 是安全的；**分支保留**（审计与回滚要看它）。
   *
   * 三条语义：
   *   1) **幂等**：成功后把 `run.workspacePath` 清空，重复调用（或之后的 finish）不会再删一次；
   *      目录本来就不存在时直接算作已回收，不报错（`finish()` 可能先删过）。
   *   2) **失败不回滚任何状态**，只记 `attentionReason` 与 journal —— 与 cleanup hook 既有的
   *      "失败=提醒，不=阻塞"一致（见 run/hooks.ts 维护提示 1）。
   *   3) cleanup hook **只在这里或 finish() 里跑一次**：两条路径都以 `workspacePath` 是否还在为准。
   */
  async releaseWorkspace(
    runId: string,
    hooks: { cleanup?: HookDefinition | undefined } = {},
  ): Promise<{ released: boolean; worktreeRemoved: boolean; cleanupNeedsAttention: boolean; error?: string }> {
    const run = this.run(runId);
    if (!run.workspacePath) return { released: false, worktreeRemoved: false, cleanupNeedsAttention: false };
    const revision = this.options.store.getRevision(run.planId, run.planRevision);
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    // 与 finish() 同一条优先级：冻结快照里的 hook 优先，其次才是调用方传进来的当前 Project 设置。
    const executionHooks = revision?.projectConfigSnapshot?.settings.hooks ?? hooks;
    const thread = this.options.store.getExecutionThread(run.executionThreadId);

    let worktreeRemoved = false;
    let error: string | undefined;
    if (!existsSync(run.workspacePath)) {
      worktreeRemoved = true;
    } else {
      try {
        await workspaceAdapter.remove({ path: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit });
        worktreeRemoved = true;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    if (worktreeRemoved) this.options.store.saveRun({ ...run, workspacePath: null });
    if (thread)
      this.append(thread.id, worktreeRemoved ? "HOOK_COMPLETED" : "HOOK_FAILED", {
        hook: "worktree-release",
        exitReason: "merged",
        worktreeRemoved,
        ...(error ? { error } : {}),
      });

    const cleanupResult = await hookRunner.runCleanup(executionHooks.cleanup, {
      projectId: run.projectId,
      runId: run.id,
      workspacePath: run.workspacePath,
      branch: run.branch,
      baseCommit: run.baseCommit,
      exitReason: "merged",
    });
    this.recordHookExecutions(run.id, cleanupResult);
    if (thread)
      this.append(
        thread.id,
        cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED",
        { hook: "cleanup", exitReason: "merged" },
      );
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan)
        this.options.store.updatePlan({
          ...plan,
          attentionReason: "cleanup hook failed after merge",
          lastEventAt: this.options.store.now(),
        });
    }
    return { released: true, worktreeRemoved, cleanupNeedsAttention: Boolean(cleanupResult.needsAttention), ...(error ? { error } : {}) };
  }

  private workspaceAdapterFor(revision: PlanRevision | undefined): WorkspaceAdapter {
    const snapshot = revision?.projectConfigSnapshot;
    return snapshot && this.options.workspaceFactory ? this.options.workspaceFactory(snapshot) : this.options.workspace;
  }

  private hookRunnerFor(revision: PlanRevision | undefined): LifecycleHookRunner {
    const snapshot = revision?.projectConfigSnapshot;
    return snapshot && this.options.hookRunnerFactory ? this.options.hookRunnerFactory(snapshot) : this.options.hooks;
  }

  /** 暂停活动 Run；暂停事实写入 ExecutionThread，便于恢复和审计。 */
  pause(runId: string): Run {
    const run = this.run(runId);
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${runId} cannot be paused from ${run.status}`);
    const thread = this.thread(run.executionThreadId);
    if (thread.state !== "ACTIVE") throw new Error(`ExecutionThread ${thread.id} cannot be paused from ${thread.state}`);
    this.setThreadState(thread.id, "PAUSED");
    this.append(thread.id, "TASK_PROGRESS", { action: "paused", runId });
    this.options.store.appendEvent({ type: "run.paused", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  /** 恢复已暂停 Run；仅允许 ACTIVE/PAUSED 的合法状态转换。 */
  resume(runId: string): Run {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (run.status !== "IN_PROGRESS" || thread.state !== "PAUSED")
      throw new Error(`Run ${runId} cannot be resumed from ${run.status}/${thread.state}`);
    this.setThreadState(thread.id, "ACTIVE");
    this.append(thread.id, "TASK_PROGRESS", { action: "resumed", runId });
    this.options.store.appendEvent({ type: "run.resumed", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  /**
   * 向执行消息流投递一条**补充要求**。
   *
   * 这是执行线程唯一的人工输入口，语义有三层，缺任何一层都会退化成"写了但没人看"（这正是它
   * 此前的状态：只往 journal 里写一行，执行侧 Loop 从不读它，而且 Loop 一收尾线程就被判
   * `COMPLETED`、连写都写不进来）：
   *   1) **落库**（`RunGuidance`）—— 排队要活到这一轮结束、引导要活到下一个步骤边界，都可能跨进程重启；
   *   2) **落 journal**（`USER_GUIDANCE`）—— 时间线上看得见，且带上投递方式与是否已生效；
   *   3) **真的推动 Agent** —— 没有在跑的 Loop 就立刻起新的一轮；在跑的按 `mode` 交给它。
   *
   * `mode` 省略或 `"auto"` 时：没有在跑的 Loop 就起新的一轮，有就**排队**（不打断、也不偷偷插话）。
   * 想让它插进正在跑的那一轮，必须显式选 `"steer"`。
   */
  async addGuidance(
    runId: string,
    content: string,
    options: { mode?: RunGuidanceMode | "auto" | undefined; actorId?: string | undefined } = {},
  ): Promise<{ thread: ExecutionThread; guidance: RunGuidance; continued: boolean }> {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    this.assertAcceptsGuidance(run);
    const runningLoop = this.runningRunLoop(run.id);
    const requested = options.mode === undefined || options.mode === "auto" ? undefined : options.mode;
    // 没有在跑的 Loop 时两种模式等价（都得起新的一轮），行上就记 QUEUE —— 那正是接下来实际走的那条路。
    const mode: RunGuidanceMode = runningLoop ? (requested ?? "QUEUE") : "QUEUE";
    const guidance = this.options.store.saveRunGuidance({
      id: this.options.store.nextId("guidance"),
      runId: run.id,
      content,
      mode,
      status: "PENDING",
      authorId: options.actorId ?? "local-user",
      createdAt: this.options.store.now(),
      consumedAt: null,
    });
    const taskId = this.recordedActiveTaskId(thread.journal);
    this.append(thread.id, "USER_GUIDANCE", {
      content,
      runId,
      guidanceId: guidance.id,
      delivery: mode,
      status: "PENDING",
      ...(taskId ? { taskId } : {}),
    });
    this.options.store.appendEvent({
      type: "run.guidance.added",
      aggregateId: run.id,
      payload: { executionThreadId: thread.id, guidanceId: guidance.id, mode },
    });
    // STEER 不动它：正在跑的那个 Loop 会在下一个步骤边界自己取走（见 AgentLoopEngine.takePendingGuidance）。
    if (runningLoop) return { thread: this.thread(thread.id), guidance, continued: false };
    // **暂停中的 Run 也不现在起一轮**：线程 PAUSED 是用户按下的暂停，它要么等着被 resume、要么等 Loop
    // 自己收尾，随手把它翻回 ACTIVE 等于把用户的暂停作废（而且紧接着的 resume 会因线程已不是 PAUSED 而失败）。
    if (thread.state === "PAUSED") return { thread: this.thread(thread.id), guidance, continued: false };
    const continued = await this.continueRun(run.id, [guidance]);
    // 重新读一次再返回：`continueRun` 刚把这条标成已消费，返回构造时那一份会让调用方以为它还挂着，
    // 而接口就靠 `guidance.status` 告诉界面"这条是待处理还是已经交给模型了"。
    const settled = this.options.store.listRunGuidance(run.id).find((item) => item.id === guidance.id) ?? guidance;
    return { thread: this.thread(thread.id), guidance: settled, continued };
  }

  /**
   * 用补充要求为**同一个 Run** 起一轮新的 Executor Loop。
   *
   * 语义（用户定下的）：Run 按业务流程重新走一遍——回到 `IN_PROGRESS`，跑完照旧
   * `READY_FOR_VERIFY → VERIFYING → MERGE_READY`；但**任务/步骤状态一个字都不动**。
   * 后者不是"顺便"做到的：任务完成度从来不是持久状态（`allTasksComplete` 由本轮报告的
   * `completedTaskIds` 现算），界面上那些任务行是 UI 从 journal 的 `TASK_PROGRESS` 推导的。
   * 所以**不动 journal 就自然保持原样**，而"某个未完成的步骤被这次补完了"靠新那一轮的报告翻过来。
   */
  async continueRun(runId: string, guidance: readonly RunGuidance[]): Promise<boolean> {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    const revision = this.options.store.getRevision(run.planId, run.planRevision);
    if (!revision) throw new Error(`Plan revision ${run.planId}@${run.planRevision} is missing`);
    this.assertAcceptsGuidance(run);
    if (this.runningRunLoop(run.id)) throw new Error(`Run ${runId} already has a running Executor loop`);
    if (!run.workspacePath) throw new Error(`Run ${runId} has no workspace to continue in`);
    // **没有 executor 就一步都不动**：先做状态回退、再把这条标成已消费，然后才发现没人能跑，
    // 会留下"Run 回到 IN_PROGRESS 却什么都没在跑"的半状态，而且那条要求已经被记成投递过了。
    if (!this.options.executor) return false;
    this.supersedeOpenMergeRequest(run.id);
    // 状态回退：Run / Plan / Thread 三处。Plan 那条 `MERGE_READY → IN_PROGRESS` 是状态表里
    // **声明过的合法边**（今天由恢复对账在用），不是新开的一条路；`RECOVERING` 的 Run 其 Plan
    // 本来就是 IN_PROGRESS，不用动。
    const plan = this.options.store.getPlan(run.planId);
    if (plan && plan.status === "MERGE_READY")
      updatePlanStatus(this.options.store, plan, { status: "IN_PROGRESS", attentionReason: null, lastEventAt: this.options.store.now() });
    this.options.store.saveRun({ ...run, status: "IN_PROGRESS" });
    this.setThreadState(thread.id, "ACTIVE");
    const consumedAt = this.options.store.now();
    for (const item of guidance) this.options.store.updateRunGuidance({ ...item, status: "CONSUMED", consumedAt });
    const completedTaskIds = this.completedTaskIdsFromJournal(
      thread.journal,
      new Set(revision.resolvedContract.tasks.map((task) => task.id)),
    );
    this.append(thread.id, "TASK_PROGRESS", {
      action: "continuation",
      guidanceIds: guidance.map((item) => item.id),
      consumedAt,
      completedTaskIds,
      tasksUnchanged: true,
    });
    const previousProviderThreadId = this.latestRunLoop(run.id)?.providerThreadId ?? undefined;
    try {
      const loop = await this.options.executor.start(this.run(runId), revision, {
        guidance: guidance.map((item) => item.content).join("\n\n"),
        completedTaskIds,
        planTaskIds: revision.resolvedContract.tasks.map((task) => task.id),
        ...(previousProviderThreadId ? { previousProviderThreadId } : {}),
      });
      this.append(thread.id, "TASK_PROGRESS", { action: "executor_loop_created", loopId: loop.id, continuation: true });
      this.options.store.appendEvent({
        type: "run.executor.event",
        aggregateId: run.id,
        payload: { executionThreadId: thread.id, action: "executor_loop_created", loopId: loop.id, continuation: true },
      });
      return true;
    } catch (error) {
      // 与 start() 同一条映射：起不来就 BLOCKED 并写明原因，别让 Run 停在"已回到 IN_PROGRESS 却没人跑"
      // 的半状态——那种状态在界面上看起来像"正在执行"，而实际上什么都没发生。
      const reason = error instanceof Error ? error.message : String(error);
      this.options.store.saveRun({ ...this.run(runId), status: "BLOCKED" });
      this.setThreadState(thread.id, "BLOCKED");
      this.append(thread.id, "RECOVERY", { action: "continuation_start_failed", reason });
      const latestPlan = this.options.store.getPlan(run.planId);
      if (latestPlan)
        updatePlanStatus(
          this.options.store,
          latestPlan,
          { runId: run.id, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() },
          reason,
        );
      return false;
    }
  }

  /**
   * 把某个 Run 排队中的补充要求取出来起一轮 —— Loop 停下时由 ExecutorAgent 那一侧触发。
   * 返回是否真的起了一轮；没有待办、或这个 Run 已经不该接受补充要求时返回 `false`。
   */
  async consumeQueuedGuidance(runId: string): Promise<boolean> {
    const run = this.options.store.getRun(runId);
    if (!run || !ACCEPTS_GUIDANCE_RUN_STATUSES.has(run.status)) return false;
    if (this.runningRunLoop(runId)) return false;
    // 暂停中就不动它：线程 PAUSED 是用户的暂停，排队的要求等它 resume 之后再说。
    if (this.options.store.getExecutionThread(run.executionThreadId)?.state === "PAUSED") return false;
    const pending = this.options.store.listRunGuidance(runId, { mode: "QUEUE", status: "PENDING" });
    if (pending.length === 0) return false;
    return this.continueRun(runId, pending);
  }

  /** 一个 Run 允许接受补充要求的那些状态；其余一律拒绝并说明该走哪条路。 */
  private assertAcceptsGuidance(run: Run): void {
    if (ACCEPTS_GUIDANCE_RUN_STATUSES.has(run.status)) return;
    const hint =
      run.status === "BLOCKED" || run.status === "NEEDS_PLAN_CHANGE" ? " revise the plan (创建更新版本) instead of steering this Run" : "";
    throw new Error(`Run ${run.id} is ${run.status} and no longer accepts guidance;${hint}`);
  }

  /**
   * 还有没有**活着**的执行协程。`RECOVERING` 算没有 —— 那是进程重启后由恢复协调器判死的 Loop，
   * 它的协程早就不在了；把它当成"正在跑"会让一个需要恢复的 Run 永远起不来新的一轮。
   */
  private runningRunLoop(runId: string): AgentLoop | undefined {
    return this.options.store.listAgentLoops(runId).find((loop) => loop.ownerType === "run" && LIVE_RUN_LOOP_STATES.has(loop.state));
  }

  private latestRunLoop(runId: string): AgentLoop | undefined {
    return this.options.store
      .listAgentLoops(runId)
      .filter((loop) => loop.ownerType === "run")
      .reduce<AgentLoop | undefined>(
        (latest, loop) => (!latest || (loop.startedAt ?? "") >= (latest.startedAt ?? "") ? loop : latest),
        undefined,
      );
  }

  /**
   * 开工前把上一个 OPEN 的合并请求作废。不做的后果很具体：`MergeService.createRequest` 按 run 幂等，
   * 会把这个指向**旧** commit 的请求原样返回，而 `confirmMerged` 只校验"旧 sourceCommit 是新
   * targetCommit 的祖先"——于是这一轮新做的、还没重新验证过的改动会跟着一起被合进去。
   */
  private supersedeOpenMergeRequest(runId: string): void {
    const open = this.options.store.findMergeRequestByRun(runId);
    if (open && open.status === "OPEN") this.options.store.updateMergeRequest({ ...open, status: "SUPERSEDED" });
  }

  /**
   * 这个 Run **已经完成**的步骤（续跑那一轮的"别再做一遍"清单）。
   *
   * 判据与界面上的 `apps/web/src/utils/executionTasks.ts` 同源——两边必须给同一个答案，否则会出现
   * "界面上显示已完成、提示词里却没说"的偏差：结构化事实（`task-status` 的 `completedTaskIds`、
   * `task-lifecycle` 的 `DONE`）优先；更早的 Run 只有 `MODEL_OUTPUT` 里的报告，走兼容路径解析。
   */
  private completedTaskIdsFromJournal(journal: readonly ExecutionJournalEntry[], validTaskIds: ReadonlySet<string>): string[] {
    const done = new Set<string>();
    let reportText = "";
    const flushReportText = (): void => {
      if (!reportText) return;
      const text = reportText;
      reportText = "";
      const report = parseExecutorReport(text);
      for (const taskId of report?.completedTaskIds ?? []) if (validTaskIds.has(taskId)) done.add(taskId);
    };
    for (const entry of journal) {
      if (entry.type === "MODEL_OUTPUT") {
        reportText += typeof entry.payload.text === "string" ? entry.payload.text : "";
        continue;
      }
      flushReportText();
      if (entry.type !== "TASK_PROGRESS") continue;
      if (entry.payload.action === "task-status") {
        const completed = Array.isArray(entry.payload.completedTaskIds) ? entry.payload.completedTaskIds : [];
        for (const taskId of completed) if (typeof taskId === "string" && validTaskIds.has(taskId)) done.add(taskId);
        continue;
      }
      if (
        entry.payload.action === "task-lifecycle" &&
        entry.payload.state === "DONE" &&
        typeof entry.payload.taskId === "string" &&
        validTaskIds.has(entry.payload.taskId)
      )
        done.add(entry.payload.taskId);
    }
    flushReportText();
    return [...done];
  }

  /** 读取 Run 的 ExecutionThread。 */
  thread(threadId: string): ExecutionThread {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) throw new Error(`ExecutionThread ${threadId} not found`);
    this.threads.set(threadId, thread);
    return thread;
  }

  /** 读取 Run 并同步到 Scheduler 的短期缓存。 */
  run(runId: string): Run {
    const run = this.options.store.getRun(runId) ?? this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this.runs.set(runId, run);
    return run;
  }

  private append(threadId: string, type: JournalEntryType, payload: Record<string, unknown>): void {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) return;
    this.options.store.appendExecutionJournal({ executionThreadId: thread.id, runId: thread.runId, type, payload });
  }

  private recordedActiveTaskId(journal: ExecutionJournalEntry[]): string | undefined {
    let activeTaskId: string | undefined;
    for (const entry of journal) {
      if (entry.type !== "TASK_PROGRESS") continue;
      if (entry.payload.action === "task-lifecycle") {
        const taskId = typeof entry.payload.taskId === "string" ? entry.payload.taskId : undefined;
        if (entry.payload.state === "IN_PROGRESS") activeTaskId = taskId;
        else if (taskId && activeTaskId === taskId) activeTaskId = undefined;
      }
      if (entry.payload.action === "task-status")
        activeTaskId = typeof entry.payload.activeTaskId === "string" ? entry.payload.activeTaskId : undefined;
    }
    return activeTaskId;
  }

  private recordHookExecutions(runId: string, result: HookRunResult): void {
    for (const attempt of result.attempts) {
      const commandResult = attempt.result;
      this.options.store.saveHookExecution({
        id: `hook-execution-${runId}-${result.hook}-${attempt.attempt}`,
        runId,
        hookType: result.hook,
        attempt: attempt.attempt,
        commandId: attempt.commandId,
        cwd: attempt.cwd,
        timeoutMs: attempt.timeoutMs,
        status: attempt.status,
        exitCode: commandResult?.exitCode ?? null,
        stdout: commandResult?.stdout ?? "",
        stderr: commandResult?.stderr ?? "",
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
      });
    }
  }

  private setThreadState(threadId: string, state: ExecutionThreadState): void {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (thread) this.options.store.saveExecutionThread({ ...thread, state });
  }

  private assertVerificationCommands(revision: PlanRevision): void {
    const snapshot = revision.projectConfigSnapshot;
    if (!snapshot) return;
    // 判定规则统一在 plan/contract.ts 的 missingVerificationCommands —— 这里曾自己实现一套，
    // 与 PlanDispatchCoordinator.evaluateWait 的那套不一致，导致派发前放行、启动时却抛
    // RUN_PREREQUISITES_UNSATISFIED（见该函数的模块说明）。
    const missing = missingVerificationCommands({ resolvedContract: revision.resolvedContract, commands: snapshot.settings.commands });
    if (missing.length > 0) throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missing.join(", ")}`);
  }
}
