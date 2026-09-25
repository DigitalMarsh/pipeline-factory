/**
 * 模块职责：把已确认并入队的 Plan 转换为可恢复的自动调度状态。
 *
 * 协调器只负责排队、依赖/容量/冲突判断和验证唤醒，不改变 PlanRevision，也不执行合并。
 */
import { EXECUTION_SLOT_RUN_STATUSES } from "./project.js";
import type {
  CandidatePlan,
  DomainEvent,
  PlanRevisionV2,
  PlanService,
  PipelineStore,
  Run,
  Scheduler,
  VerificationRun,
} from "./index.js";

export type PlanDispatchStatus =
  | "QUEUED"
  | "WAITING"
  | "DISPATCHING"
  | "RUNNING"
  | "VERIFYING"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "COMPLETED";

export type PlanDispatchWaitReason =
  | "WAITING_DEPENDENCY"
  | "WAITING_CONFLICT"
  | "WAITING_PROJECT_CAPACITY"
  | "WAITING_GLOBAL_CAPACITY"
  | "NEEDS_CONFIGURATION";

export type PlanDispatchPhase =
  | "VALIDATING"
  | "VALIDATION_FAILED"
  | "FROZEN"
  | "ENQUEUING"
  | "ENQUEUE_FAILED"
  | "ENQUEUED"
  | "DISPATCHING"
  | "DISPATCH_FAILED"
  | "DISPATCHED"
  | "STARTING_RUN"
  | "RUN_STARTED"
  | "WAITING"
  | "RUN_START_FAILED"
  | "NEEDS_REVIEW"
  | "ATTENTION"
  | "COMPLETED";

export type PlanDispatchState = Readonly<{
  planId: string;
  revision?: number;
  projectId: string;
  status: PlanDispatchStatus;
  waitReason: PlanDispatchWaitReason | null;
  queuedAt: string;
  runId: string | null;
  attempt: number;
  updatedAt: string;
  lastError: string | null;
  /** 持久化的自动确认/派发阶段；旧的人工入队记录可能没有此字段。 */
  phase?: PlanDispatchPhase;
  automatic?: boolean;
  confirmedBy?: string | null;
}>;

export type PlanDispatchCoordinatorOptions = {
  store: PipelineStore;
  plans: PlanService;
  scheduler: Scheduler;
  globalConcurrency?: number;
  verify?: (run: Run, revision: PlanRevisionV2) => Promise<VerificationRun>;
};

type WaitEvaluation = {
  reason: PlanDispatchWaitReason;
  message: string;
};

/** 高频流式事件的合并窗口：窗口内的所有 token 事件只触发一次全量扫描。 */
const WAKE_COALESCE_MS = 250;

/**
 * 流式事件只影响展示进度，不需要逐条做全量 reconcile。
 * agent.* 全部按流式处理，run.executor.event 只合并 MODEL_OUTPUT 这类逐 token 事件。
 */
function isStreamingEvent(event: DomainEvent): boolean {
  if (event.type.startsWith("agent.")) return true;
  if (event.type !== "run.executor.event") return false;
  const payload = event.payload as { type?: unknown } | null;
  return typeof payload === "object" && payload !== null && payload.type === "MODEL_OUTPUT";
}

export class PlanDispatchCoordinator {
  private readonly unsubscribe: (() => void) | undefined;
  private wakePromise: Promise<PlanDispatchState[]> | null = null;
  private readonly verifyingRuns = new Set<string>();
  private readonly confirmingPlans = new Set<string>();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PlanDispatchCoordinatorOptions) {
    this.unsubscribe = options.store.subscribeEvents?.((event) => {
      if (event.type === "plan.dispatch.state.changed") return;
      if (isStreamingEvent(event)) {
        this.scheduleWake();
        return;
      }
      void this.handleEvent(event);
    });
  }

  /** 保留 Enqueue API 的幂等入口，但不创建调度状态或唤醒 Scheduler。 */
  async enqueue(planId: string): Promise<{ plan: CandidatePlan; state: PlanDispatchState | null }> {
    return { plan: this.options.plans.enqueue(planId), state: null };
  }

  /** 将 Enqueued Plan 交给自动调度器，并立即尝试创建 Run。 */
  async dispatch(planId: string): Promise<{ plan: CandidatePlan; state: PlanDispatchState }> {
    const plan = this.options.plans.dispatch(planId);
    const existing = this.options.store.getDispatchState(plan.id);
    if (!existing || existing.status === "BLOCKED" || existing.status === "COMPLETED") {
      this.saveState({ ...(existing ?? this.newQueuedState(plan)), ...this.newQueuedState(plan), ...(existing?.automatic ? { automatic: true, confirmedBy: existing.confirmedBy } : {}), phase: "DISPATCHED" });
    }
    await this.wake();
    const settled = this.state(plan.id);
    if (this.options.store.getPlan(plan.id)?.status === "DISPATCHED" && !settled?.runId) await this.wake();
    return { plan: this.options.store.getPlan(plan.id) ?? plan, state: this.state(plan.id) as PlanDispatchState };
  }

  /** Confirm、冻结、入队、派发和 Run 启动共用一个持久化、可重试的服务端入口。 */
  async confirmAndDispatch(planId: string, revision: number, confirmedBy: string, wakeAfter = true): Promise<{ plan: CandidatePlan; run: Run | null; state: PlanDispatchState }> {
    const plan = this.options.plans.get(planId);
    if (plan.revision !== revision) throw new Error("REVISION_NOT_LATEST");
    if (this.confirmingPlans.has(planId)) {
      const current = this.options.store.getPlan(planId) ?? plan;
      const state = this.state(planId) ?? this.newQueuedState(current);
      return { plan: current, run: state.runId ? this.options.store.getRun(state.runId) ?? null : null, state };
    }
    const existingState = this.state(planId);
    const existingRun = this.options.store.listRuns().find((run) => run.planId === planId && run.planRevision === revision);
    const sameRevisionState = existingState?.revision === revision;
    if (existingRun && existingState?.phase !== "RUN_START_FAILED") {
      const recoveredState: PlanDispatchState = {
        ...(sameRevisionState ? existingState! : this.newQueuedState(plan)),
        revision,
        automatic: true,
        confirmedBy: existingState?.confirmedBy ?? confirmedBy,
        runId: existingRun.id,
      };
      this.saveState(recoveredState);
      await this.syncRun(existingRun);
      return { plan: this.options.store.getPlan(planId) ?? plan, run: existingRun, state: this.state(planId) ?? recoveredState };
    }

    this.confirmingPlans.add(planId);
    let state: PlanDispatchState = {
      ...(sameRevisionState ? existingState! : this.newQueuedState(plan)),
      revision,
      automatic: true,
      confirmedBy: sameRevisionState ? existingState?.confirmedBy ?? confirmedBy : confirmedBy,
      runId: sameRevisionState ? existingState?.runId ?? null : null,
      attempt: (existingState?.attempt ?? 0) + 1,
      phase: "VALIDATING",
      status: "QUEUED",
      waitReason: null,
      lastError: null,
      updatedAt: this.options.store.now(),
    };
    this.saveState(state);
    try {
      let current = this.options.plans.get(planId);
      if (["DRAFT", "DESIGNED", "PLANNED"].includes(current.status)) current = this.options.plans.confirm(planId, state.confirmedBy ?? confirmedBy, revision);
      state = { ...state, phase: "FROZEN", updatedAt: this.options.store.now(), lastError: null };
      this.saveState(state);

      if (current.status === "READY") {
        state = { ...state, phase: "ENQUEUING", updatedAt: this.options.store.now() };
        this.saveState(state);
        current = this.options.plans.enqueue(planId);
      }
      state = { ...state, phase: "ENQUEUED", updatedAt: this.options.store.now(), lastError: null };
      this.saveState(state);

      if (current.status === "ENQUEUED") {
        state = { ...state, phase: "DISPATCHING", updatedAt: this.options.store.now() };
        this.saveState(state);
        current = this.options.plans.dispatch(planId);
      }
      state = { ...state, phase: "DISPATCHED", updatedAt: this.options.store.now(), lastError: null };
      this.saveState(state);
      if (wakeAfter) await this.wake();
      const settledPlan = this.options.store.getPlan(planId) ?? current;
      const settledState = this.state(planId) ?? state;
      return { plan: settledPlan, run: settledState.runId ? this.options.store.getRun(settledState.runId) ?? null : null, state: settledState };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const phase: PlanDispatchPhase = state.phase === "VALIDATING" ? "VALIDATION_FAILED" : state.phase === "ENQUEUING" ? "ENQUEUE_FAILED" : state.phase === "DISPATCHING" ? "DISPATCH_FAILED" : "RUN_START_FAILED";
      state = { ...state, phase, status: "BLOCKED", lastError: message, updatedAt: this.options.store.now() };
      this.saveState(state);
      const latest = this.options.store.getPlan(planId) ?? plan;
      const run = this.options.store.listRuns().find((item) => item.planId === planId && item.planRevision === revision) ?? null;
      if (run) state = { ...state, runId: run.id };
      return { plan: latest, run, state };
    } finally {
      this.confirmingPlans.delete(planId);
    }
  }

  /**
   * 配置阻塞的派发只能基于当前 Project 配置创建新 Revision，不能改写旧的快照。
   * 清除的是可重建的调度投影，原状态变化事件保留作审计。
   */
  reviseConfiguration(planId: string, actorId: string): CandidatePlan {
    const plan = this.options.plans.get(planId);
    const state = this.options.store.getDispatchState(planId);
    if (plan.status !== "DISPATCHED" || plan.runId !== null || state?.status !== "WAITING" || state.waitReason !== "NEEDS_CONFIGURATION") {
      throw new Error(`Plan ${planId} is not waiting for configuration`);
    }
    const revised = this.options.plans.reviseConfiguration(planId, actorId);
    this.options.store.deleteDispatchState(planId);
    return revised;
  }

  /** 对所有 Project 的排队项执行一次稳定顺序的调度扫描。 */
  wake(): Promise<PlanDispatchState[]> {
    if (this.wakePromise) return this.wakePromise;
    this.wakePromise = this.performWake().finally(() => { this.wakePromise = null; });
    return this.wakePromise;
  }

  state(planId: string): PlanDispatchState | undefined {
    return this.options.store.getDispatchState(planId);
  }

  states(projectId?: string): PlanDispatchState[] {
    return this.options.store.listDispatchStates(projectId);
  }

  dispose(): void {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.unsubscribe?.();
  }

  /** 合并高频事件的唤醒：窗口内只保留一次待执行的全量扫描。 */
  private scheduleWake(): void {
    if (this.wakeTimer !== null) return;
    const timer = setTimeout(() => {
      this.wakeTimer = null;
      void this.wake();
    }, WAKE_COALESCE_MS);
    // 待处理的合并唤醒不应该阻止进程退出。
    (timer as unknown as { unref?: () => void }).unref?.();
    this.wakeTimer = timer;
  }

  private async performWake(): Promise<PlanDispatchState[]> {
    await this.resumeAutomaticIntents();
    this.reconcileStoredPlans();
    for (const run of this.options.store.listRuns()) await this.syncRun(run);

    const queuedPlans = this.options.store
      .listPlans()
      .filter((plan) => plan.status === "DISPATCHED")
      .sort((a, b) => (b.contract.priority ?? 0) - (a.contract.priority ?? 0) || (a.queuedAt ?? a.createdAt).localeCompare(b.queuedAt ?? b.createdAt) || a.id.localeCompare(b.id));

    for (const plan of queuedPlans) {
      const currentState = this.state(plan.id);
      if (currentState?.status === "BLOCKED" || currentState?.status === "COMPLETED") continue;
      await this.dispatchOne(plan);
    }
    return this.states();
  }

  /** 恢复进程中断在确认、入队或派发边界的自动流程。 */
  private async resumeAutomaticIntents(): Promise<void> {
    const recoverable = new Set<PlanDispatchPhase>(["VALIDATING", "FROZEN", "ENQUEUING", "ENQUEUED", "DISPATCHING", "DISPATCHED", "STARTING_RUN", "RUN_START_FAILED"]);
    for (const state of this.options.store.listDispatchStates()) {
      if (!state.automatic || !state.phase || !recoverable.has(state.phase) || this.confirmingPlans.has(state.planId)) continue;
      const plan = this.options.store.getPlan(state.planId);
      if (!plan) continue;
      if (state.revision !== undefined && state.revision !== plan.revision) continue;
      const run = this.options.store.listRuns().find((item) => item.planId === state.planId && item.planRevision === plan.revision);
      if (run && run.status !== "STARTING") continue;
      await this.confirmAndDispatch(state.planId, plan.revision, state.confirmedBy ?? "local-user", false);
    }
  }

  private reconcileStoredPlans(): void {
    for (const plan of this.options.store.listPlans()) {
      const state = this.state(plan.id);
      if (plan.status === "DISPATCHED" && !state) this.saveState(this.newQueuedState(plan));
      if (plan.status === "MERGED" && state?.status !== "COMPLETED") this.saveState(this.stateForPlan(state ?? this.newQueuedState(plan), "COMPLETED", null, null));
      if (plan.status === "BLOCKED" && state?.status !== "BLOCKED") this.saveState(this.stateForPlan(state ?? this.newQueuedState(plan), "BLOCKED", null, plan.attentionReason));
    }
  }

  private async dispatchOne(plan: CandidatePlan): Promise<void> {
    const revision = this.options.store.getRevision(plan.id, plan.revision);
    if (!revision) {
      this.saveState({ ...this.stateForPlan(this.state(plan.id) ?? this.newQueuedState(plan), "BLOCKED", null, `Plan revision ${plan.id}@${plan.revision} is missing`), phase: "ATTENTION" });
      return;
    }
    const wait = this.evaluateWait(plan, revision);
    if (wait) {
      this.saveState({ ...this.stateForPlan(this.state(plan.id) ?? this.newQueuedState(plan), "WAITING", wait.reason, wait.message), phase: "WAITING" });
      return;
    }

    const current = this.state(plan.id) ?? this.newQueuedState(plan);
    this.saveState({ ...current, status: "DISPATCHING", phase: "STARTING_RUN", waitReason: null, updatedAt: this.options.store.now(), lastError: null });
    try {
      const run = await this.options.scheduler.start(plan.id, this.options.store.getProject(plan.projectId)?.settings.hooks ?? {});
      await this.syncRun(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refreshed = this.options.store.getPlan(plan.id) ?? plan;
      const waitAfterFailure = /RUN_PREREQUISITES_UNSATISFIED|missing registered commands/i.test(message)
        ? { reason: "NEEDS_CONFIGURATION" as const, message }
        : /concurrency limit reached/i.test(message)
          ? this.evaluateWait(refreshed, revision)
          : undefined;
      if (waitAfterFailure) {
        this.saveState({ ...this.stateForPlan(current, "WAITING", waitAfterFailure.reason, waitAfterFailure.message), phase: "WAITING" });
      } else {
        const existingRun = this.options.store.listRuns().find((run) => run.planId === plan.id && run.planRevision === plan.revision);
        this.saveState({ ...this.stateForPlan(current, "BLOCKED", null, message), phase: existingRun ? "ATTENTION" : "RUN_START_FAILED", ...(existingRun ? { runId: existingRun.id } : {}) });
      }
    }
  }

  private evaluateWait(plan: CandidatePlan, revision: PlanRevisionV2): WaitEvaluation | undefined {
    const dependencies = revision.resolvedContract?.dependencies ?? revision.contract.dependsOnPlanIds ?? [];
    const incompleteDependency = dependencies
      .map((id) => this.options.store.getPlan(id))
      .find((dependency) => !dependency || dependency.projectId !== plan.projectId || dependency.status !== "MERGED");
    if (incompleteDependency) {
      const dependencyId = incompleteDependency?.id ?? dependencies.find((id) => !this.options.store.getPlan(id)) ?? "unknown";
      return { reason: "WAITING_DEPENDENCY", message: `Waiting for dependency ${dependencyId} to be merged` };
    }

    const snapshot = revision.projectConfigSnapshot;
    if (snapshot) {
      const registeredCommands = new Set((revision.resolvedContract ? snapshot.settings.commands.filter((command) => command.category === "verification" && command.enabled !== false) : snapshot.settings.commands).map((command) => command.commandId));
      const missingCommands = (revision.resolvedContract?.verification.commandIds ?? revision.contract.verificationCommandIds).filter((commandId) => !registeredCommands.has(commandId));
      if (missingCommands.length > 0) return { reason: "NEEDS_CONFIGURATION", message: `Missing registered commands: ${missingCommands.join(", ")}` };
    }

    const activeRuns = this.options.store.listRuns().filter((run) => EXECUTION_SLOT_RUN_STATUSES.has(run.status));
    const conflictKeys = new Set(revision.contract.conflictKeys);
    if (conflictKeys.size > 0) {
      const conflictingRun = activeRuns.find((run) => {
        if (run.planId === plan.id) return false;
        const runRevision = this.options.store.getRevision(run.planId, run.planRevision);
        return Boolean(runRevision?.contract.conflictKeys.some((key) => conflictKeys.has(key)));
      });
      if (conflictingRun) return { reason: "WAITING_CONFLICT", message: `Waiting for conflicting Run ${conflictingRun.id}` };
    }

    return undefined;
  }

  private async syncRun(run: Run): Promise<void> {
    const plan = this.options.store.getPlan(run.planId);
    if (plan && plan.revision !== run.planRevision && plan.runId !== run.id) return;
    const current = this.state(run.planId) ?? (plan ? this.newQueuedState(plan) : undefined);
    if (!current) return;
    switch (run.status) {
      case "STARTING":
      case "IN_PROGRESS":
        this.saveState({ ...this.stateForRun(current, run, "RUNNING", null), phase: "RUN_STARTED" });
        return;
      case "RECOVERING":
        this.saveState({ ...this.stateForRun(current, run, "BLOCKED", null, plan?.attentionReason ?? `Run ${run.id} requires recovery`), phase: "ATTENTION" });
        return;
      case "VERIFYING":
        this.saveState({ ...this.stateForRun(current, run, "VERIFYING", null), phase: "RUN_STARTED" });
        return;
      case "READY_FOR_VERIFY": {
        if (!this.options.verify) {
          this.saveState({ ...this.stateForRun(current, run, "NEEDS_REVIEW", null, "Verification executor is not configured"), phase: "NEEDS_REVIEW" });
          return;
        }
        if (this.verifyingRuns.has(run.id)) return;
        this.verifyingRuns.add(run.id);
        this.saveState({ ...this.stateForRun(current, run, "VERIFYING", null), phase: "RUN_STARTED" });
        try {
          const revision = this.options.store.getRevision(run.planId, run.planRevision);
          if (!revision) throw new Error(`Plan revision ${run.planId}@${run.planRevision} is missing`);
          await this.options.verify(run, revision);
          const latest = this.options.store.getRun(run.id) ?? run;
          await this.syncRun(latest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.saveState({ ...this.stateForRun(current, run, "BLOCKED", null, message), phase: "ATTENTION" });
        } finally {
          this.verifyingRuns.delete(run.id);
        }
        return;
      }
      case "MERGE_READY":
        this.saveState({ ...this.stateForRun(current, run, plan?.status === "MERGED" ? "COMPLETED" : "NEEDS_REVIEW", null), phase: plan?.status === "MERGED" ? "COMPLETED" : "NEEDS_REVIEW" });
        return;
      case "BLOCKED":
      case "NEEDS_PLAN_CHANGE":
      case "STALE":
      case "CANCELLED":
        this.saveState({ ...this.stateForRun(current, run, "BLOCKED", null, plan?.attentionReason ?? `Run ${run.id} is ${run.status}`), phase: "ATTENTION" });
        return;
      default:
        if (plan?.status === "MERGED") this.saveState({ ...this.stateForRun(current, run, "COMPLETED", null), phase: "COMPLETED" });
    }
  }

  private async handleEvent(event: DomainEvent): Promise<void> {
    const runId = this.runIdForEvent(event);
    if (runId) {
      const run = this.options.store.getRun(runId);
      if (run) await this.syncRun(run);
    }
    await this.wake();
  }

  private runIdForEvent(event: DomainEvent): string | undefined {
    if (event.type === "run.executor.event" || event.type === "verification.completed" || event.type === "run.paused" || event.type === "run.resumed" || event.type === "run.guidance.added") return event.aggregateId;
    if (event.type.startsWith("agent.")) {
      const loop = this.options.store.getAgentLoop(event.aggregateId);
      return loop?.ownerType === "run" ? loop.ownerId : undefined;
    }
    return undefined;
  }

  private newQueuedState(plan: CandidatePlan): PlanDispatchState {
    const queuedAt = plan.dispatchedAt ?? plan.queuedAt ?? plan.createdAt;
    return { planId: plan.id, revision: plan.revision, projectId: plan.projectId, status: "QUEUED", waitReason: null, queuedAt, runId: plan.runId, attempt: 0, updatedAt: this.options.store.now(), lastError: null };
  }

  private stateForPlan(state: PlanDispatchState, status: PlanDispatchStatus, waitReason: PlanDispatchWaitReason | null, lastError: string | null): PlanDispatchState {
    return { ...state, status, waitReason, updatedAt: this.options.store.now(), lastError };
  }

  private stateForRun(state: PlanDispatchState, run: Run, status: PlanDispatchStatus, waitReason: PlanDispatchWaitReason | null, lastError: string | null = null): PlanDispatchState {
    return { ...state, status, waitReason, runId: run.id, attempt: Math.max(state.attempt, 1), updatedAt: this.options.store.now(), lastError };
  }

  /** 只有状态真正变化才写库并广播，避免流式事件把同一状态反复写成事件风暴。 */
  private saveState(state: PlanDispatchState): void {
    const current = this.options.store.getDispatchState(state.planId);
    if (current && current.revision === state.revision && current.status === state.status && current.waitReason === state.waitReason && current.runId === state.runId && current.attempt === state.attempt && current.lastError === state.lastError && current.queuedAt === state.queuedAt && current.phase === state.phase && current.automatic === state.automatic && current.confirmedBy === state.confirmedBy) return;
    const saved = this.options.store.saveDispatchState(state);
    this.options.store.appendEvent({ type: "plan.dispatch.state.changed", aggregateId: state.planId, payload: saved });
  }
}
