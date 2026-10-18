/**
 * 模块职责：ExplorerService —— ExplorerThread 的创建、继承、归档、激活、标题修改，
 *   以及级联删除（连同它的阻塞错误与"什么算活跃执行"的判定）。
 *
 * 为什么从 index.ts 抽出来：这是"一个 Explorer 线程能做什么"的完整答案，包含删除这条
 *   **不可逆**路径。搬出来后它对 index.ts 只剩 `import type`，值依赖只有
 *   explorer/thread-selection.ts 一个模块。
 *
 * 维护提示：
 *   1) **deleteExplorerCascade 是事务边界**（末尾的 runInTransaction 三元）。整段删除必须
 *      在同一个事务里完成；拆开会留下指向已删除 Explorer 的孤儿 Plan/Run。store 不提供
 *      runInTransaction 时（内存实现）直接执行——这是有意的降级，不是遗漏。
 *   2) EXPLORER_DELETE_ACTIVE_RUN_STATUSES 与 ExplorerDeleteBlockedError 是**配套的一对**：
 *      前者决定"什么算还在跑"，后者把判定结果带给调用方（api 层靠 error.code ===
 *      "EXPLORER_DELETE_BLOCKED" 映射成 409）。新增 Run 状态时必须同时想清楚它算不算活跃，
 *      否则会出现"能删掉一个正在跑的线程"。**deletePlan 用的是同一把尺**（走同一个
 *      assertNoActiveExecution），两个入口不许各自维护一份。
 *   3) 删除后的**回退线程**由 replacementExplorer 承担：删掉当前线程时项目指针要落到一个还存在的
 *      线程上。返回的 replacementExplorer 是从 store 重新读出来的（不是内存里的对象引用），
 *      这样调用方拿到的状态与库一致。
 *   4) 标题相关路径都要走 projectPlaceholderExplorerTitle / threadTitleMetadata，不要在本地
 *      拼字符串——占位标题的形态（含项目简称）是前端展示契约的一部分。
 *   5) selectCurrentExplorer 写的是 project 上的指针；本类里它出现在 create 与 delete 两处，
 *      对应"新线程成为当前"和"删除后指针回退"。
 *   6) **deletePlan 与 delete 的差别只有"选哪些 Plan、哪些回合"这一步**：从这里往下（Run、
 *      Loop、活跃判定）走的是同一段代码 collectExecutionClosure / assertNoActiveExecution。
 *      抄第二遍的代价不是多几行，而是两处会各自漂移——而它们决定的是"删干净了没有"。
 *   7) deletePlan 要多做一件 delete 不需要做的事：**把线程行上的指针收回来**。线程级的
 *      candidatePlanId / lastAssessedTurnId / exploration 从来就是"最后评估过的那条需求"的投影
 *      （thread-service 每轮都这么写），所以删掉一条之后要**镜像剩下的最后一条需求**，
 *      而不是置空——置空会让界面显示成"这条线程还没评估过"，而它明明有。
 */
import { projectPlaceholderExplorerTitle, selectCurrentExplorer } from "./thread-selection.js";
import { defaultExplorerPlan, defaultThreadContextSummary } from "../store/records.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { Project } from "../project/project.js";
import type {
  AgentLoop,
  CandidatePlan,
  CreateExplorerInput,
  ExplorerDeletionInput,
  ExplorerDeletionSummary,
  ExplorerPlan,
  ExplorerPlanDeletionInput,
  ExplorerThread,
  ExplorerTurn,
  Run,
} from "../index.js";

export class ExplorerDeleteBlockedError extends Error {
  readonly code = "EXPLORER_DELETE_BLOCKED" as const;

  constructor(
    readonly activeRunIds: string[],
    readonly activeLoopIds: string[],
  ) {
    super("ExplorerThread has active execution work; pause or cancel it before deleting the thread");
    this.name = "ExplorerDeleteBlockedError";
  }
}

const EXPLORER_DELETE_ACTIVE_RUN_STATUSES = new Set(["QUEUED", "STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"]);

/** 与上面那把尺配套：这些 Loop 状态算"还在跑"。 */
const EXPLORER_DELETE_ACTIVE_LOOP_STATES = new Set(["CREATED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "RECOVERING"]);

/**
 * "这条需求删不动"（不是"还有在跑"那种可以等一等的）。
 *
 * 与 ExplorerDeleteBlockedError **刻意分成两个类**：前者是"先停掉再来"（可重试，前端该劝用户去停），
 * 后者是"规则上就不许"（重试也没用，前端该说清为什么）。合成一个类的话，api 层只能笼统回一句
 * 409，前端也就只能笼统报一句失败——两种完全不同的处置被压成同一条提示。
 */
export class ExplorerPlanDeleteForbiddenError extends Error {
  readonly code = "EXPLORER_PLAN_DELETE_FORBIDDEN" as const;

  constructor(readonly reason: "LAST_REQUIREMENT") {
    super("The last ExplorerPlan of a thread cannot be deleted");
    this.name = "ExplorerPlanDeleteForbiddenError";
  }
}

/** 管理 ExplorerThread 的创建、继承、归档、激活和标题修改。 */
export class ExplorerService {
  constructor(private readonly store: PipelineStore) {}

  /** 创建 Project 内的新 ExplorerThread，可显式继承来源线程。 */
  create(input: CreateExplorerInput): ExplorerThread {
    const origin = input.originThreadId ? this.store.getThread(input.originThreadId) : undefined;
    if (input.originThreadId && (!origin || origin.projectId !== input.projectId))
      throw new Error("Origin Explorer does not belong to this project");
    let thread = this.store.saveThread({
      id: this.store.nextId("explorer"),
      projectId: input.projectId,
      parentThreadId: null,
      title: input.title?.trim() || "New Explorer",
      contextMode: origin ? "EXPLICIT_CONTINUATION" : "FRESH",
      originThreadId: origin?.id ?? null,
      createdAt: input.createdAt,
    });
    if (thread.titleSource === "AUTO" && thread.titleStatus === "PLACEHOLDER") {
      thread = this.store.updateThread({ ...thread, title: projectPlaceholderExplorerTitle(this.store, thread), titleStatus: "GENERATED" });
    }
    this.store.appendEvent({
      type: "explorer.created",
      aggregateId: thread.id,
      payload: {
        projectId: thread.projectId,
        contextMode: thread.contextMode,
        originThreadId: thread.originThreadId,
        explorerPlanId: thread.activeExplorerPlanId,
        turnId: null,
        loopId: null,
      },
    });
    if (origin)
      this.store.appendEvent({
        type: "explorer.continued",
        aggregateId: thread.id,
        payload: { originThreadId: origin.id, explorerPlanId: thread.activeExplorerPlanId, turnId: null, loopId: null },
      });
    selectCurrentExplorer(this.store, thread);
    return thread;
  }

  /** 按 id 读取 ExplorerThread。 */
  get(explorerId: string): ExplorerThread {
    const explorer = this.store.getThread(explorerId);
    if (!explorer) throw new Error(`Explorer ${explorerId} not found`);
    return explorer;
  }

  /** 返回线程下按创建顺序排列的 Plan 分区，并保证旧线程已有默认 Plan。 */
  listPlans(explorerId: string): ExplorerPlan[] {
    const explorer = this.get(explorerId);
    let plans = this.store.listExplorerPlans(explorer.id);
    if (!plans.length) {
      const created = this.createPlan(explorer.id);
      plans = [created];
    }
    return plans;
  }

  /** 创建空 Plan 分区；不启动 Provider，也不复制旧消息。 */
  createPlan(explorerId: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    if (explorer.state === "ARCHIVED") throw new Error(`ExplorerThread ${explorerId} is archived`);
    const plans = this.store.listExplorerPlans(explorer.id);
    const createdAt = this.store.now();
    const plan = defaultExplorerPlan(explorer, this.store.nextId("explorer-plan"), (plans.at(-1)?.ordinal ?? 0) + 1, createdAt);
    this.store.saveExplorerPlan(plan);
    const contextSummary = explorer.contextSummary ?? defaultThreadContextSummary(createdAt);
    const updatedThread = this.store.updateThread({
      ...explorer,
      activeExplorerPlanId: plan.id,
      contextSummary: { ...contextSummary, updatedAt: createdAt, openPlanIds: [...new Set([...contextSummary.openPlanIds, plan.id])] },
      lastActivityAt: createdAt,
    });
    this.store.appendEvent({
      type: "explorer.plan.created",
      aggregateId: explorer.id,
      payload: { explorerId: explorer.id, explorerPlanId: plan.id, turnId: null, loopId: null, ordinal: plan.ordinal },
    });
    void updatedThread;
    return plan;
  }

  /** 切换当前 Plan；只更新线程的活动投影，不修改 Provider 会话。 */
  activatePlan(explorerId: string, explorerPlanId: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== explorer.id || plan.projectId !== explorer.projectId)
      throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    this.store.updateThread({ ...explorer, activeExplorerPlanId: plan.id, lastActivityAt: this.store.now() });
    return plan;
  }

  renamePlan(explorerId: string, explorerPlanId: string, title: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== explorer.id) throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    const normalized = title.trim();
    if (!normalized) throw new Error("ExplorerPlan title cannot be empty");
    const updated = this.store.updateExplorerPlan({
      ...plan,
      title: normalized,
      titleSource: "MANUAL",
      titleStatus: "GENERATED",
      lastActivityAt: this.store.now(),
    });
    this.store.appendEvent({
      type: "explorer.plan.renamed",
      aggregateId: explorer.id,
      payload: { explorerId: explorer.id, explorerPlanId: plan.id, turnId: null, loopId: null, title: normalized },
    });
    return updated;
  }

  /** 只列出指定 Project 的线程，按最近活动倒序。 */
  list(projectId: string): ExplorerThread[] {
    return this.store
      .listThreads()
      .filter((thread) => thread.projectId === projectId)
      .sort((a, b) => Number(b.state === "ACTIVE") - Number(a.state === "ACTIVE") || b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  /** 归档线程并保留其 Turn、Plan 和事件历史。 */
  archive(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ARCHIVED") return explorer;
    const project = this.store.getProject(explorer.projectId);
    if (project?.currentExplorerThreadId === explorerId) throw new Error("Current Explorer cannot be archived");
    const archived = this.store.updateThread({ ...explorer, state: "ARCHIVED", lastActivityAt: this.store.now() });
    this.store.appendEvent({
      type: "explorer.archived",
      aggregateId: explorerId,
      payload: { explorerId, explorerPlanId: explorer.activeExplorerPlanId, turnId: null, loopId: null },
    });
    return archived;
  }

  /** 恢复归档线程的可写状态。 */
  activate(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ACTIVE") return explorer;
    const active = this.store.updateThread({ ...explorer, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.store.appendEvent({
      type: "explorer.activated",
      aggregateId: explorerId,
      payload: { explorerId, explorerPlanId: active.activeExplorerPlanId, turnId: null, loopId: null },
    });
    selectCurrentExplorer(this.store, active);
    return active;
  }

  /** 更新手工标题；空标题被拒绝且不会覆盖已有标题。 */
  rename(explorerId: string, title: string): ExplorerThread {
    const explorer = this.get(explorerId);
    const normalized = title.trim();
    if (!normalized) throw new Error("Explorer title cannot be empty");
    return this.store.updateThread({
      ...explorer,
      title: normalized,
      titleSource: "MANUAL",
      titleStatus: "GENERATED",
      lastActivityAt: this.store.now(),
    });
  }

  /**
   * 由一组 Plan（候选方案）与它们的回合推出牵连的执行侧业务行：Run 与挂在这些 Run / 回合上的 Loop。
   *
   * 抽出来给 `delete()` 与 `deletePlan()` 共用（见文件头维护提示 6）：两者只在"选哪些 Plan、
   * 哪些回合"上不同——线程级取全部，需求级只取那一条。**从这里往下必须一模一样**，
   * 否则两条删除路径会各自漂移，而它们决定的是"删干净了没有"。
   */
  private collectExecutionClosure(plans: CandidatePlan[], turns: ExplorerTurn[]): { runs: Run[]; loops: AgentLoop[] } {
    const planIdSet = new Set(plans.map((plan) => plan.id));
    const runs = this.store.listRuns().filter((run) => planIdSet.has(run.planId));
    const runIdSet = new Set(runs.map((run) => run.id));
    const turnIdSet = new Set(turns.map((turn) => turn.id));
    const loops = this.store
      .listAgentLoops()
      .filter(
        (loop) =>
          (loop.ownerType === "explorer-turn" && turnIdSet.has(loop.ownerId)) || (loop.ownerType === "run" && runIdSet.has(loop.ownerId)),
      );
    return { runs, loops };
  }

  /** 两个删除入口共用的一把尺：有在跑的 Run 或 Loop 就不给删（维护提示 2）。 */
  private assertNoActiveExecution(runs: Run[], loops: AgentLoop[]): void {
    const activeRunIds = runs.filter((run) => EXPLORER_DELETE_ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id);
    const activeLoopIds = loops.filter((loop) => EXPLORER_DELETE_ACTIVE_LOOP_STATES.has(loop.state)).map((loop) => loop.id);
    if (activeRunIds.length || activeLoopIds.length) throw new ExplorerDeleteBlockedError(activeRunIds, activeLoopIds);
  }

  /** 删除线程及其全部业务投影；审计事件保留，已结束 Run 的 worktree 不做文件系统清理。 */
  delete(explorerId: string): { replacementExplorer: ExplorerThread; project: Project; deleted: ExplorerDeletionSummary } {
    const explorer = this.get(explorerId);
    const project = this.store.getProject(explorer.projectId);
    if (!project) throw new Error(`Project ${explorer.projectId} not found`);
    const explorerPlans = this.store.listExplorerPlans(explorer.id);
    const explorerPlanIds = explorerPlans.map((plan) => plan.id);
    const explorerPlanIdSet = new Set(explorerPlanIds);
    const turns = this.store.listTurns(explorer.id);
    const turnIds = turns.map((turn) => turn.id);
    const plans = this.store
      .listPlans()
      .filter(
        (plan) => plan.sourceExplorerThreadId === explorer.id || (plan.explorerPlanId ? explorerPlanIdSet.has(plan.explorerPlanId) : false),
      );
    const planIds = plans.map((plan) => plan.id);
    const { runs, loops } = this.collectExecutionClosure(plans, turns);
    const runIds = runs.map((run) => run.id);
    this.assertNoActiveExecution(runs, loops);

    const replacementCandidate = this.store
      .listThreads()
      .filter((thread) => thread.projectId === explorer.projectId && thread.id !== explorer.id && thread.state !== "ARCHIVED")
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    const input: Omit<ExplorerDeletionInput, "replacementExplorerId"> = {
      projectId: explorer.projectId,
      explorerId: explorer.id,
      explorerPlanIds,
      turnIds,
      planIds,
      runIds,
      executionThreadIds: runs.map((run) => run.executionThreadId),
      agentLoopIds: loops.map((loop) => loop.id),
      inputRequestIds: this.store.listInputRequests(explorer.id).map((request) => request.id),
    };

    const remove = () => {
      const replacementExplorer = replacementCandidate ?? this.create({ projectId: explorer.projectId });
      const deleted = this.store.deleteExplorerCascade({ ...input, replacementExplorerId: replacementExplorer.id });
      this.store.appendEvent({
        type: "explorer.deleted",
        aggregateId: explorer.id,
        payload: {
          projectId: explorer.projectId,
          explorerId: explorer.id,
          replacementExplorerId: replacementExplorer.id,
          taskCount: deleted.taskCount,
          planCount: deleted.planCount,
          runCount: deleted.runCount,
        },
      });
      const savedProject = this.store.getProject(explorer.projectId);
      if (!savedProject) throw new Error(`Project ${explorer.projectId} not found after Explorer deletion`);
      return { replacementExplorer: this.store.getThread(replacementExplorer.id) as ExplorerThread, project: savedProject, deleted };
    };
    return this.store.runInTransaction ? this.store.runInTransaction(remove) : remove();
  }

  /**
   * 删除线程里的**一条需求**，连同它派生的方案、Run、执行日志与结构化提问。
   *
   * 与 `delete()`（整条线程）的分工是：这里**不碰线程行本身**，其余该走的一样走——同一把活跃判据
   * （有在跑的 Run / Loop 就拒），同一个事务边界，同样保留 `domain_events`（审计）与磁盘上的 worktree。
   *
   * 为此要多做一件 `delete()` 不需要做的事：**把线程行上的指针收回来**（维护提示 7）。这里退回的是
   * "这条需求从没存在过"的样子——镜像剩下的最后一条需求，而不是置空。
   *
   * **最后一条需求不给删**：线程必须至少有一条（`listPlans()` 在没有需求时会当场补一条空的），
   * 放行的话用户看到的是"删了但清单没变"。抛错比静默重建诚实。
   */
  deletePlan(
    explorerId: string,
    explorerPlanId: string,
  ): { explorer: ExplorerThread; explorerPlans: ExplorerPlan[]; deleted: ExplorerDeletionSummary } {
    const explorer = this.get(explorerId);
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== explorer.id || plan.projectId !== explorer.projectId)
      throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    const allPlans = this.store.listExplorerPlans(explorer.id);
    const surviving = allPlans.filter((item) => item.id !== plan.id);
    if (!surviving.length) throw new ExplorerPlanDeleteForbiddenError("LAST_REQUIREMENT");
    const successor = surviving[surviving.length - 1] as ExplorerPlan;

    const turns = this.store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === plan.id);
    const plans = this.store.listPlans().filter((item) => item.explorerPlanId === plan.id);
    const { runs, loops } = this.collectExecutionClosure(plans, turns);
    this.assertNoActiveExecution(runs, loops);

    const input: ExplorerPlanDeletionInput = {
      projectId: explorer.projectId,
      explorerId: explorer.id,
      explorerPlanIds: [plan.id],
      turnIds: turns.map((turn) => turn.id),
      planIds: plans.map((item) => item.id),
      runIds: runs.map((run) => run.id),
      executionThreadIds: runs.map((run) => run.executionThreadId),
      agentLoopIds: loops.map((loop) => loop.id),
      inputRequestIds: this.store
        .listInputRequests(explorer.id)
        .filter((request) => request.explorerPlanId === plan.id)
        .map((request) => request.id),
    };

    const remove = () => {
      const deleted = this.store.deleteExplorerPlanCascade(input);
      const now = this.store.now();
      const contextSummary = explorer.contextSummary ?? defaultThreadContextSummary(now);
      const activeDraft = explorer.activeRevisionDraftId ? this.store.getRevisionDraft(explorer.activeRevisionDraftId) : undefined;
      const draftSurvives = Boolean(activeDraft) && activeDraft?.explorerPlanId !== plan.id;
      const updatedThread = this.store.updateThread({
        ...explorer,
        // 指向被删的那条时就落到剩下的最后一条；否则不动。
        activeExplorerPlanId: explorer.activeExplorerPlanId === plan.id ? successor.id : explorer.activeExplorerPlanId,
        activeRevisionDraftId: draftSurvives ? explorer.activeRevisionDraftId : null,
        messageCount: Math.max(0, explorer.messageCount - turns.length),
        exploration: {
          ...successor.exploration,
          candidatePlanId: successor.candidatePlanId,
          lastAssessedTurnId: successor.lastAssessedTurnId,
        },
        contextSummary: {
          ...contextSummary,
          updatedAt: now,
          openPlanIds: contextSummary.openPlanIds.filter((id) => id !== plan.id),
          completedPlans: contextSummary.completedPlans.filter((item) => item.explorerPlanId !== plan.id),
        },
        lastActivityAt: now,
      });
      this.store.appendEvent({
        type: "explorer.plan.deleted",
        aggregateId: explorer.id,
        payload: {
          explorerId: explorer.id,
          explorerPlanId: plan.id,
          turnId: null,
          loopId: null,
          title: plan.title,
          taskCount: deleted.taskCount,
          planCount: deleted.planCount,
          runCount: deleted.runCount,
        },
      });
      return { explorer: updatedThread, explorerPlans: this.store.listExplorerPlans(explorer.id), deleted };
    };
    return this.store.runInTransaction ? this.store.runInTransaction(remove) : remove();
  }
}
