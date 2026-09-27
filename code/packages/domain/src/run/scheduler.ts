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
 *   3) 并发上限走 globalConcurrency，默认值在构造函数里；Capacity 相关的判定决定了
 *      Plan 是留在 ENQUEUED 还是被派发。调整上限时注意它同时影响"同一 Project 的并发"与
 *      "全局并发"两层。
 *   4) status → 状态的推进一律走 updatePlanStatus（先写事实再追加事件）。这里出现的几处
 *      BLOCKED 是 Hook 失败、取消、前置条件不满足三条路径，各自带不同的 attentionReason——
 *      文案是排障线索，不要统一。
 *   5) 分支名生成走 run/run-branch.js（runBranchName / allocateRunBranchLeaf / composeRunBranchLeaf /
 *      normalizeRunBranchSlug），它是"同一 Plan 的多次 Run 不撞分支名"的保证，不要在本地
 *      拼字符串。
 *   6) 前置条件校验（RUN_PREREQUISITES_UNSATISFIED）在派发**之前**抛出，是唯一阻止
 *      "用到未注册的验证命令"的关口。
 */
import { updatePlanStatus } from "../plan/status-transition.js";
import { PlanService } from "../plan/service.js";
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
  HookDefinition,
  HookRunResult,
  JournalEntryType,
  LifecycleHookRunner,
  PlanRevisionV2,
  Project,
  Run,
  WorkspaceAdapter,
} from "../index.js";

export type SchedulerOptions = {
  store: PipelineStore;
  workspace: WorkspaceAdapter;
  hooks: LifecycleHookRunner;
  globalConcurrency?: number;
  workspaceFactory?: (snapshot: ProjectExecutionSnapshot) => WorkspaceAdapter;
  hookRunnerFactory?: (snapshot: ProjectExecutionSnapshot) => LifecycleHookRunner;
  branchNameGenerator?: RunBranchNameGenerator;
  executor?: {
    start(run: Run, revision: PlanRevisionV2): Promise<AgentLoop>;
    pause?: AgentLoopRunner["pause"];
    resume?: AgentLoopRunner["resume"];
    cancel?: AgentLoopRunner["cancel"];
  };
};

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

  /** @deprecated Capacity limits are ignored; this remains for old configuration readers. */
  globalConcurrency(): number | undefined {
    return undefined;
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
      if (raced) return { run: raced, thread: this.options.store.getExecutionThread(raced.executionThreadId) ?? { id: raced.executionThreadId, runId: raced.id, state: "ACTIVE", journal: [] }, created: false };
      const branchLeaf = allocateRunBranchLeaf(baseBranchLeaf, this.options.store.listRuns().map((run) => run.branch));
      const runId = this.options.store.nextId("run");
      const thread: ExecutionThread = { id: this.options.store.nextId("execution-thread"), runId, state: "ACTIVE", journal: [] };
      const run: Run = { id: runId, projectId: plan.projectId, planId: plan.id, planRevision: revision.revision, status: "STARTING", branch: runBranchName(branchLeaf), workspacePath: null, baseCommit: revision.contract.baseCommit, executionThreadId: thread.id, createdAt, startedAt: null };
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
    const workspace = await workspaceAdapter.create({ projectId: plan.projectId, runId: run.id, branch: run.branch, baseCommit: run.baseCommit });
    run.workspacePath = workspace.path;
    run.baseCommit = workspace.baseCommit;
    this.options.store.saveRun(run);
    const startResult = await hookRunner.runStart(executionHooks.start, { projectId: plan.projectId, runId: run.id, workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, exitReason: "running" });
    this.recordHookExecutions(run.id, startResult);
    if (startResult.status === "failed") {
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.setThreadState(thread.id, "BLOCKED");
      this.append(thread.id, "HOOK_FAILED", { hook: "start", stderr: startResult.result?.stderr ?? "" });
      updatePlanStatus(this.options.store, plan, { runId: run.id, status: "BLOCKED", attentionReason: "start hook failed", lastEventAt: this.options.store.now() }, "start hook failed");
      this.options.store.saveRun(run);
      return run;
    }
    run.status = "IN_PROGRESS";
    run.startedAt = this.options.store.now();
    this.append(thread.id, startResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "start" });
    if (!revision.projectConfigSnapshot) this.append(thread.id, "TASK_PROGRESS", { action: "legacy_plan_revision", reason: "Project configuration snapshot unavailable; using legacy/global runtime settings" });
    updatePlanStatus(this.options.store, plan, { runId: run.id, status: "IN_PROGRESS", lastEventAt: run.startedAt });
    this.options.store.saveRun(run);
    if (this.options.executor) {
      try {
        const loop = await this.options.executor.start(run, revision);
        this.append(thread.id, "TASK_PROGRESS", { action: "executor_loop_created", loopId: loop.id });
        this.options.store.appendEvent({ type: "run.executor.event", aggregateId: run.id, payload: { executionThreadId: thread.id, action: "executor_loop_created", loopId: loop.id } });
      } catch (error) {
        run.status = "BLOCKED";
        this.setThreadState(thread.id, "BLOCKED");
        const reason = error instanceof Error ? error.message : String(error);
        this.append(thread.id, "RECOVERY", { action: "executor_loop_start_failed", reason });
        updatePlanStatus(this.options.store, plan, { runId: run.id, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() }, reason);
        this.options.store.saveRun(run);
      }
    }
    return run;
  }

  private async runBranchLeaf(plan: CandidatePlan, revision: PlanRevisionV2, createdAt: string): Promise<string> {
    let summary = normalizeRunBranchSlug(plan.title) ?? "change";
    if (this.options.branchNameGenerator) {
      try {
        summary = await this.options.branchNameGenerator.generate({ createdAt, planTitle: plan.title, goal: revision.contract.goal });
      } catch {
        summary = "change";
      }
    }
    return composeRunBranchLeaf(createdAt, summary);
  }

  /** 完成或取消 Run，按同一 Revision 执行 Worktree 清理和 Cleanup Hook。 */
  async finish(runId: string, exitReason: string, hooks: { cleanup?: HookDefinition | undefined } = {}, cancellationReason = exitReason): Promise<Run> {
    const run = this.run(runId);
    if (run.status === "CANCELLED") {
      if (exitReason === "cancelled") {
        const plan = this.options.store.getPlan(run.planId);
        if (plan && plan.status !== "BLOCKED" && plan.status !== "MERGED") {
          updatePlanStatus(this.options.store, plan, { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() }, `Run cancelled: ${cancellationReason}`);
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
    const cleanupResult = await hookRunner.runCleanup(executionHooks.cleanup, { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath ?? "", branch: run.branch, baseCommit: run.baseCommit, exitReason });
    this.recordHookExecutions(run.id, cleanupResult);
    this.append(thread.id, cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "cleanup", exitReason });
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, attentionReason: "cleanup hook failed", lastEventAt: this.options.store.now() });
    }
    if (exitReason === "cancelled") run.status = "CANCELLED";
    this.setThreadState(thread.id, exitReason === "cancelled" ? "CANCELLED" : "COMPLETED");
    this.options.store.saveRun(run);
    if (exitReason === "cancelled") {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) updatePlanStatus(this.options.store, plan, { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() }, `Run cancelled: ${cancellationReason}`);
    }
    return run;
  }

  private workspaceAdapterFor(revision: PlanRevisionV2 | undefined): WorkspaceAdapter {
    const snapshot = revision?.projectConfigSnapshot;
    return snapshot && this.options.workspaceFactory ? this.options.workspaceFactory(snapshot) : this.options.workspace;
  }

  private hookRunnerFor(revision: PlanRevisionV2 | undefined): LifecycleHookRunner {
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
    if (run.status !== "IN_PROGRESS" || thread.state !== "PAUSED") throw new Error(`Run ${runId} cannot be resumed from ${run.status}/${thread.state}`);
    this.setThreadState(thread.id, "ACTIVE");
    this.append(thread.id, "TASK_PROGRESS", { action: "resumed", runId });
    this.options.store.appendEvent({ type: "run.resumed", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  /** 向执行消息流追加人工指导，不改写已确认的 PlanRevision。 */
  addGuidance(runId: string, content: string): ExecutionThread {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (thread.state === "CANCELLED" || thread.state === "COMPLETED") throw new Error(`Run ${runId} is no longer accepting guidance`);
    const taskId = this.recordedActiveTaskId(thread.journal);
    this.append(thread.id, "USER_GUIDANCE", { content, runId, ...(taskId ? { taskId } : {}) });
    this.options.store.appendEvent({ type: "run.guidance.added", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.thread(thread.id);
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
      if (entry.payload.action === "task-status") activeTaskId = typeof entry.payload.activeTaskId === "string" ? entry.payload.activeTaskId : undefined;
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

  private assertVerificationCommands(revision: PlanRevisionV2): void {
    const snapshot = revision.projectConfigSnapshot;
    if (!snapshot) return;
    const registered = new Set(snapshot.settings.commands.map((command) => command.commandId));
    const missing = revision.contract.verificationCommandIds.filter((commandId) => !registered.has(commandId));
    if (missing.length > 0) throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missing.join(", ")}`);
  }
}
