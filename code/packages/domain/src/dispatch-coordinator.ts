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

export type PlanDispatchState = Readonly<{
  planId: string;
  projectId: string;
  status: PlanDispatchStatus;
  waitReason: PlanDispatchWaitReason | null;
  queuedAt: string;
  runId: string | null;
  attempt: number;
  updatedAt: string;
  lastError: string | null;
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

export class PlanDispatchCoordinator {
  private readonly unsubscribe: (() => void) | undefined;
  private wakePromise: Promise<PlanDispatchState[]> | null = null;
  private readonly verifyingRuns = new Set<string>();

  constructor(private readonly options: PlanDispatchCoordinatorOptions) {
    this.unsubscribe = options.store.subscribeEvents?.((event) => {
      if (event.type === "plan.dispatch.state.changed") return;
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
      this.saveState(this.newQueuedState(plan));
    }
    await this.wake();
    const settled = this.state(plan.id);
    if (this.options.store.getPlan(plan.id)?.status === "DISPATCHED" && !settled?.runId) await this.wake();
    return { plan: this.options.store.getPlan(plan.id) ?? plan, state: this.state(plan.id) as PlanDispatchState };
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
    this.unsubscribe?.();
  }

  private async performWake(): Promise<PlanDispatchState[]> {
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
      this.saveState(this.stateForPlan(this.state(plan.id) ?? this.newQueuedState(plan), "BLOCKED", null, `Plan revision ${plan.id}@${plan.revision} is missing`));
      return;
    }
    const wait = this.evaluateWait(plan, revision);
    if (wait) {
      this.saveState(this.stateForPlan(this.state(plan.id) ?? this.newQueuedState(plan), "WAITING", wait.reason, wait.message));
      return;
    }

    const current = this.state(plan.id) ?? this.newQueuedState(plan);
    this.saveState({ ...current, status: "DISPATCHING", waitReason: null, updatedAt: this.options.store.now(), lastError: null });
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
        this.saveState(this.stateForPlan(current, "WAITING", waitAfterFailure.reason, waitAfterFailure.message));
      } else {
        this.saveState(this.stateForPlan(current, "BLOCKED", null, message));
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

    const projectLimit = snapshot?.settings.concurrency.maxParallelRuns;
    if (projectLimit !== undefined && activeRuns.filter((run) => run.projectId === plan.projectId).length >= projectLimit) {
      return { reason: "WAITING_PROJECT_CAPACITY", message: `Project ${plan.projectId} capacity is full (${projectLimit})` };
    }
    if (this.options.globalConcurrency !== undefined && activeRuns.length >= this.options.globalConcurrency) {
      return { reason: "WAITING_GLOBAL_CAPACITY", message: `Global capacity is full (${this.options.globalConcurrency})` };
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
        this.saveState(this.stateForRun(current, run, "RUNNING", null));
        return;
      case "RECOVERING":
        this.saveState(this.stateForRun(current, run, "BLOCKED", null, plan?.attentionReason ?? `Run ${run.id} requires recovery`));
        return;
      case "VERIFYING":
        this.saveState(this.stateForRun(current, run, "VERIFYING", null));
        return;
      case "READY_FOR_VERIFY": {
        if (!this.options.verify) {
          this.saveState(this.stateForRun(current, run, "NEEDS_REVIEW", null, "Verification executor is not configured"));
          return;
        }
        if (this.verifyingRuns.has(run.id)) return;
        this.verifyingRuns.add(run.id);
        this.saveState(this.stateForRun(current, run, "VERIFYING", null));
        try {
          const revision = this.options.store.getRevision(run.planId, run.planRevision);
          if (!revision) throw new Error(`Plan revision ${run.planId}@${run.planRevision} is missing`);
          await this.options.verify(run, revision);
          const latest = this.options.store.getRun(run.id) ?? run;
          await this.syncRun(latest);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.saveState(this.stateForRun(current, run, "BLOCKED", null, message));
        } finally {
          this.verifyingRuns.delete(run.id);
        }
        return;
      }
      case "MERGE_READY":
        this.saveState(this.stateForRun(current, run, plan?.status === "MERGED" ? "COMPLETED" : "NEEDS_REVIEW", null));
        return;
      case "BLOCKED":
      case "NEEDS_PLAN_CHANGE":
      case "STALE":
      case "CANCELLED":
        this.saveState(this.stateForRun(current, run, "BLOCKED", null, plan?.attentionReason ?? `Run ${run.id} is ${run.status}`));
        return;
      default:
        if (plan?.status === "MERGED") this.saveState(this.stateForRun(current, run, "COMPLETED", null));
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
    return { planId: plan.id, projectId: plan.projectId, status: "QUEUED", waitReason: null, queuedAt, runId: plan.runId, attempt: 0, updatedAt: this.options.store.now(), lastError: null };
  }

  private stateForPlan(state: PlanDispatchState, status: PlanDispatchStatus, waitReason: PlanDispatchWaitReason | null, lastError: string | null): PlanDispatchState {
    return { ...state, status, waitReason, updatedAt: this.options.store.now(), lastError };
  }

  private stateForRun(state: PlanDispatchState, run: Run, status: PlanDispatchStatus, waitReason: PlanDispatchWaitReason | null, lastError: string | null = null): PlanDispatchState {
    return { ...state, status, waitReason, runId: run.id, attempt: Math.max(state.attempt, 1), updatedAt: this.options.store.now(), lastError };
  }

  private saveState(state: PlanDispatchState): void {
    const saved = this.options.store.saveDispatchState(state);
    this.options.store.appendEvent({ type: "plan.dispatch.state.changed", aggregateId: state.planId, payload: saved });
  }
}
