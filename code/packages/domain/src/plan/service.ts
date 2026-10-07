/**
 * 模块职责：Plan 的业务边界——ExplorerThread → CandidatePlan → Confirm → Enqueue →
 *   Revision 的完整生命周期，以及 Plan Center 的查询投影。
 *
 * 为什么从 index.ts 抽出来：这是领域层最大的一个类（636 行），它对其他服务的依赖只有
 *   ProjectService 一个，其余协作对象都是 PipelineStore 与叶子模块。与它同处一个文件的却是
 *   ExplorerService、Scheduler、VerificationService 等七八个毫不相干的类。
 *
 * 维护提示：
 *   1) **状态变化一律"先写事实，再追加领域事件"**（类头注释即写此约束）。反过来做会让 UI
 *      投影领先于持久化状态，进程崩在中间就出现"事件说已确认、库里还是草稿"。所有走
 *      updatePlanStatus 的路径都遵守这一点，新增路径也要。
 *   2) `revision` 是**单调递增的版本号**，确认/修订时取 `plan.revision + 1` 而不是从
 *      revision 表里 max+1。Revision 一旦落库就 freezeRevision（不可变），历史版本永不改写。
 *   3) **契约只有一份**：`resolvedContract`（确认时冻结）就是事实来源——Executor、Verification、
 *      Merge 与界面都读它。曾经与它并存的 V1 扁平镜像（`contract` 字段、`executionContractFromResolved`
 *      投影与 `defaultPlanContract` 兜底）已经整体删掉，见 docs 的 §6 B 类。
 *      本文件里唯一的 IO 是 `verifiedProjectBaseline`（会执行 git 子进程），它在批 D 已搬去
 *      **git/baseline.ts**，这里只 import。
 *   4) 查询侧（query / listThreadPlans / listProjectPlans）用的是 plan/query.ts 的投影与游标，
 *      投影字段的增删要同步两个 Store 实现，见该文件的维护提示。
 */
import { createHash } from "node:crypto";
import { parseGeneratedPlanSpec, resolvePlanContract } from "./plan-spec.js";
import { missingVerificationCommands } from "./contract.js";
import { writePlanDocument } from "./plan-archive.js";
import { emptyPlanPreflight } from "./preflight.js";
import type { PlanPreflightInspector } from "./preflight.js";
import { canDiscardPlanStatus, updatePlanStatus } from "./status-transition.js";
import { freezeRevision } from "../platform/freeze.js";
import { verifiedProjectBaseline } from "../git/baseline.js";
import { ProjectService } from "../project/project.js";
import { selectCurrentExplorer } from "../explorer/thread-selection.js";
import { decodePlanCursor, encodePlanCursor } from "./query.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { GeneratedPlanSpec, ResolvedPlanContract } from "./plan-spec.js";
import type { PlanArtifact } from "./completion.js";
import type {
  CandidatePlan,
  CreateCandidatePlanInput,
  CreateRevisionDraftInput,
  ExplorerPlan,
  ExplorerThread,
  PlanIndexRow,
  PlanQuery,
  PlanQueryResult,
  PlanQuerySort,
  PlanRevisionDraft,
  PlanRevision,
  RegisterThreadInput,
} from "../index.js";

/**
 * 负责 ExplorerThread、CandidatePlan、Confirm、Enqueue 和 Revision 的业务边界。
 * CandidatePlan 的状态变化始终先写事实，再追加领域事件，避免 UI 投影领先于持久化状态。
 */
export class PlanService {
  private readonly projects: ProjectService;

  constructor(
    private readonly store: PipelineStore,
    projects?: ProjectService,
    private readonly preflight: PlanPreflightInspector = emptyPlanPreflight,
    /** 解析某个受管工程的计划落盘目录（绝对路径）；由组合根按配置注入，**缺省不落盘**。 */
    private readonly planDirectory?: ((projectRoot: string) => string) | undefined,
  ) {
    this.projects = projects ?? new ProjectService(store);
  }

  /**
   * 把 Revision 落盘到受管工程的计划目录：**只在确认时写，每版一个文件**。
   * 未注入目录解析器时跳过——测试与不写盘的部署不该被这个副作用影响。
   *
   * 写盘先于冻结（调用点保证顺序）：写失败就阻断确认、可重试且无副作用；反过来先冻结再写，
   * 会留下"确认成功了但文件没写成"的中间态。
   */
  private archiveRevision(input: {
    projectId: string;
    planId: string;
    revision: number;
    title: string;
    resolvedContract: ResolvedPlanContract;
    artifactHash: string;
    confirmedBy: string;
    confirmedAt: string;
  }): string | undefined {
    if (!this.planDirectory) return undefined;
    const directory = this.planDirectory(this.projects.snapshot(input.projectId).repoRoot);
    return writePlanDocument({ ...input, directory });
  }

  /**
   * 派发前预检的确认闸门（见 plan/preflight.ts）。
   * **放在 service 而不是 route**：`routes/plans.ts` 有 `confirmAndDispatch` 与 `plans.confirm`
   * 两条路径，service 是唯一必经点——放在 route 上，另一条路就绕过去了。
   *
   * 只阻断 `blocking` 级问题（计划要处理的文件在基线里不存在）。工作区不干净属于**警告**：
   * 它由建 worktree 时的那道硬闸门负责，确认计划与工作区干净是两件事，绑在一起会让只想看方案的人也被卡住。
   */
  private assertPreflightPasses(projectId: string, resolved: ResolvedPlanContract): void {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const result = this.preflight({
      repoRoot: this.projects.snapshot(projectId).repoRoot,
      baseCommit: resolved.repository.baseCommit,
      includePaths: resolved.scope.includePaths,
      ...(resolved.artifact.path ? { artifactPath: resolved.artifact.path } : {}),
    });
    if (result.blocking.length > 0) throw new Error(`PLAN_PREFLIGHT_FAILED: ${result.blocking.map((issue) => issue.message).join(" ")}`);
  }

  /** 注册与 Project 绑定的本地线程，并追加创建事件。 */
  registerThread(input: RegisterThreadInput): ExplorerThread {
    const thread = this.store.saveThread(input);
    selectCurrentExplorer(this.store, thread);
    this.store.appendEvent({
      type: "explorer.thread.created",
      aggregateId: thread.id,
      payload: {
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId,
        explorerPlanId: thread.activeExplorerPlanId,
        turnId: null,
        loopId: null,
      },
    });
    return thread;
  }

  /** 创建 Draft CandidatePlan；只在源线程产生新的候选投影，不创建 Revision 或 Run。 */
  createCandidatePlan(input: CreateCandidatePlanInput): CandidatePlan {
    if (!this.store.getThread(input.sourceExplorerThreadId)) {
      this.registerThread({ id: input.sourceExplorerThreadId, projectId: input.projectId, parentThreadId: null });
    }
    const createdAt = this.store.now();
    const project = this.store.getProject(input.projectId);
    let generatedSpec: GeneratedPlanSpec | undefined;
    if (input.generatedSpec) {
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      generatedSpec = parseGeneratedPlanSpec(input.generatedSpec);
    }
    // 契约是 CandidatePlan 的**必填事实**：Explorer 走 `generatedSpec` 解析，程序化调用方
    // （测试夹具）直接给一份已解析契约。两者都没有就没有方案——这条路上不再有"兜底合同"
    // （V1 的 defaultPlanContract 已随镜像一起删掉）。
    const resolvedContract =
      generatedSpec && project
        ? resolvePlanContract(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project))
        : input.resolvedContract;
    if (!resolvedContract) throw new Error("A candidate plan requires a generatedSpec or a resolvedContract");
    const plan: CandidatePlan = {
      id: this.store.nextId("plan"),
      projectId: input.projectId,
      sourceExplorerThreadId: input.sourceExplorerThreadId,
      ...(input.explorerPlanId ? { explorerPlanId: input.explorerPlanId } : {}),
      sourceTurnId: input.sourceTurnId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      providerTurnId: input.providerTurnId ?? null,
      providerItemId: input.providerItemId ?? null,
      title: input.title,
      revision: 1,
      status: "DRAFT",
      createdAt,
      confirmedBy: null,
      confirmedAt: null,
      queuedAt: null,
      dispatchedAt: null,
      runId: null,
      lastEventAt: createdAt,
      attentionReason: null,
      resolvedContract,
      ...(generatedSpec ? { generatedSpec } : {}),
    };
    this.store.savePlan(plan);
    this.store.saveCandidateVersion(plan);
    this.store.appendEvent({
      type: "plan.candidate.created",
      aggregateId: plan.id,
      payload: {
        title: plan.title,
        revision: plan.revision,
        explorerPlanId: plan.explorerPlanId ?? null,
        sourceTurnId: plan.sourceTurnId,
        providerThreadId: plan.providerThreadId,
        providerTurnId: plan.providerTurnId,
        providerItemId: plan.providerItemId,
      },
    });
    return plan;
  }

  /** 每次重新生成 READY 产物都保存不可变的候选版本，确认只能使用最新版。 */
  reviseCandidate(
    planId: string,
    artifact: PlanArtifact,
    source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null },
  ): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error("Only an unconfirmed Plan can be edited");
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpec(artifact.generatedSpec) : undefined;
    // 没有新 spec 就用调用方给的契约；两者都没有则**沿用这一版已有的契约**——只改标题、
    // 不改方案的修订是合法的，不该因为没带契约就把 Plan 变成没有契约。
    const resolvedContract = generatedSpec
      ? resolvePlanContract(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project))
      : (artifact.resolvedContract ?? plan.resolvedContract);
    const revision = Math.max(plan.revision, ...this.store.listCandidateVersions(plan.id).map((item) => item.revision)) + 1;
    const planWithoutGeneratedSpec = { ...plan, resolvedContract };
    delete planWithoutGeneratedSpec.generatedSpec;
    const updated = this.store.updatePlan({
      ...planWithoutGeneratedSpec,
      title: artifact.title,
      revision,
      ...(generatedSpec ? { generatedSpec } : {}),
      ...source,
      lastEventAt: this.store.now(),
    });
    this.store.saveCandidateVersion(updated);
    this.store.appendEvent({
      type: "plan.candidate.revised",
      aggregateId: plan.id,
      payload: { revision, sourceTurnId: source.sourceTurnId },
    });
    return updated;
  }

  /** 读取 Plan；未知 id 直接失败，调用方不得回退到默认 Project。 */
  get(planId: string): CandidatePlan {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    return plan;
  }

  /** 在一个需求对话内切换待编辑的独立 Plan；null 表示下一次 READY 新建 Plan。 */
  selectCandidate(explorerPlanId: string, planId: string | null): ExplorerPlan {
    const requirement = this.store.getExplorerPlan(explorerPlanId);
    if (!requirement) throw new Error("Requirement not found");
    if (planId) {
      const plan = this.get(planId);
      if (
        plan.projectId !== requirement.projectId ||
        plan.explorerPlanId !== requirement.id ||
        plan.sourceExplorerThreadId !== requirement.explorerThreadId ||
        plan.status !== "DRAFT"
      )
        throw new Error("Plan is not an editable candidate for this requirement");
    }
    const updated = this.store.updateExplorerPlan({
      ...requirement,
      candidatePlanId: planId,
      newPlanRequested: planId === null,
      exploration: { ...requirement.exploration, candidatePlanId: planId },
      lastActivityAt: this.store.now(),
    });
    this.store.appendEvent({
      type: "explorer.plan.selected",
      aggregateId: requirement.explorerThreadId,
      payload: { explorerPlanId, planId },
    });
    return updated;
  }

  /**
   * 创建或复用同一 Plan 的下一版草稿。此入口只建立可编辑 Draft，绝不创建不可变 Revision。
   * Run/worktree 的实际终止和清理由 API 协调器先完成；这里拒绝任何未确认清理的历史执行。
   */
  createRevisionDraft(input: CreateRevisionDraftInput): PlanRevisionDraft {
    const cached = this.store.getIdempotency("revision-draft", input.clientRequestId);
    if (cached) return cached as unknown as PlanRevisionDraft;
    const plan = this.get(input.planId);
    const thread = this.store.getThread(input.explorerThreadId);
    if (!thread || thread.projectId !== plan.projectId) throw new Error("EXPLORER_THREAD_PROJECT_MISMATCH");
    if (input.fromRevision > plan.revision || input.fromRevision < 1 || !this.store.getRevision(plan.id, input.fromRevision))
      throw new Error("REVISION_NOT_FOUND");
    const active = this.store
      .listRevisionDrafts(plan.id)
      .find((draft) => draft.status === "EDITING" || draft.status === "READY_TO_CONFIRM" || draft.status === "BASE_CHANGED");
    if (active) {
      this.store.saveIdempotency("revision-draft", input.clientRequestId, active as unknown as Record<string, unknown>);
      return active;
    }
    const unmergedRuns = this.store
      .listRuns()
      .filter(
        (run) =>
          run.planId === plan.id &&
          run.planRevision === input.fromRevision &&
          !this.store.findMergeRequestByRun(run.id)?.mergedAt &&
          (run.workspacePath !== null || !["CANCELLED", "STALE"].includes(run.status)),
      );
    if (unmergedRuns.length && !input.discardUnmergedRun) throw new Error("UNMERGED_RUN_CONFIRMATION_REQUIRED");
    const source = this.store.getRevision(plan.id, input.fromRevision)!;
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const now = this.store.now();
    const draft: PlanRevisionDraft = Object.freeze({
      draftId: this.store.nextId("revision-draft"),
      planId: plan.id,
      projectId: plan.projectId,
      basedOnRevision: input.fromRevision,
      targetRevision: plan.revision + 1,
      status: "EDITING",
      // A revision draft is rebased on the current verified default branch.  Carrying a
      // historical contract's base commit here can otherwise create an unstartable Run.
      title: plan.title,
      resolvedContract: {
        ...source.resolvedContract,
        repository: { ...source.resolvedContract.repository, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit },
      },
      sourceExplorerThreadId: thread.id,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      sourceTurnId: source.sourceTurnId ?? null,
      providerThreadId: source.providerThreadId ?? null,
      providerTurnId: source.providerTurnId ?? null,
      providerItemId: source.providerItemId ?? null,
      baseBranch: baseline.baseBranch,
      baseCommit: baseline.baseCommit,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
    });
    const saved = this.store.saveRevisionDraft(draft);
    if (thread.state === "ARCHIVED")
      this.store.updateThread({ ...thread, state: "ACTIVE", activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    else this.store.updateThread({ ...thread, activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    this.store.appendEvent({
      type: "plan.revision.draft.created",
      aggregateId: plan.id,
      payload: {
        draftId: saved.draftId,
        fromRevision: input.fromRevision,
        targetRevision: saved.targetRevision,
        explorerThreadId: thread.id,
        discardUnmergedRun: input.discardUnmergedRun,
      },
    });
    this.store.saveIdempotency("revision-draft", input.clientRequestId, saved as unknown as Record<string, unknown>);
    return saved;
  }

  /** READY 只更新同一个 Draft；不会为同一业务计划创建新的 planId。 */
  updateRevisionDraftFromExplorer(
    draftId: string,
    artifact: PlanArtifact,
    source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null },
  ): PlanRevisionDraft {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error(`RevisionDraft ${draftId} not found`);
    if (draft.status !== "EDITING" && draft.status !== "READY_TO_CONFIRM" && draft.status !== "BASE_CHANGED")
      throw new Error(`RevisionDraft ${draftId} is not editable`);
    const project = this.store.getProject(draft.projectId);
    if (!project) throw new Error(`Project ${draft.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpec(artifact.generatedSpec) : undefined;
    const resolvedContract = generatedSpec
      ? resolvePlanContract(generatedSpec, this.projects.snapshot(project.id), baseline)
      : (artifact.resolvedContract ?? draft.resolvedContract);
    const updated: PlanRevisionDraft = Object.freeze({
      ...draft,
      title: artifact.title,
      resolvedContract,
      ...(generatedSpec ? { generatedSpec } : {}),
      sourceExplorerThreadId: draft.sourceExplorerThreadId,
      ...source,
      baseBranch: baseline.baseBranch,
      baseCommit: baseline.baseCommit,
      status: "READY_TO_CONFIRM",
      updatedAt: this.store.now(),
    });
    const saved = this.store.updateRevisionDraft(updated);
    this.store.appendEvent({
      type: "plan.revision.draft.ready",
      aggregateId: saved.planId,
      payload: { draftId: saved.draftId, targetRevision: saved.targetRevision, sourceTurnId: source.sourceTurnId },
    });
    return saved;
  }

  confirmRevisionDraft(draftId: string, confirmedBy: string): CandidatePlan {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error("REVISION_DRAFT_NOT_FOUND");
    if (draft.status === "CONFIRMED") return this.get(draft.planId);
    if (draft.status !== "READY_TO_CONFIRM") throw new Error(`RevisionDraft ${draftId} cannot be confirmed from ${draft.status}`);
    const plan = this.get(draft.planId);
    if (plan.revision + 1 !== draft.targetRevision) throw new Error("REVISION_NOT_LATEST");
    const project = this.store.getProject(draft.projectId);
    if (!project) throw new Error(`Project ${draft.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    if (baseline.baseCommit !== draft.baseCommit || baseline.baseBranch !== draft.baseBranch) {
      this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "BASE_CHANGED", updatedAt: this.store.now() }));
      throw new Error("BASE_CHANGED");
    }
    // 与 confirm 同一道闸门：修订版冻结前也要过预检——否则"改一版再确认"就是绕过它的后门。
    this.assertPreflightPasses(draft.projectId, draft.resolvedContract);
    const snapshot = this.projects.snapshot(project.id);
    const confirmedAt = this.store.now();
    const artifactHash = `sha256:${createHash("sha256")
      .update(JSON.stringify({ resolvedContract: draft.resolvedContract, projectConfigSnapshot: snapshot }))
      .digest("hex")}`;
    const planDocumentPath = this.archiveRevision({
      projectId: plan.projectId,
      planId: plan.id,
      revision: draft.targetRevision,
      title: draft.title,
      resolvedContract: draft.resolvedContract,
      artifactHash,
      confirmedBy,
      confirmedAt,
    });
    const revision = freezeRevision({
      planId: plan.id,
      revision: draft.targetRevision,
      resolvedContract: draft.resolvedContract,
      artifactHash,
      ...(planDocumentPath ? { planDocumentPath } : {}),
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: draft.sourceExplorerThreadId,
      ...(draft.explorerPlanId ? { explorerPlanId: draft.explorerPlanId } : {}),
      sourceTurnId: draft.sourceTurnId,
      providerThreadId: draft.providerThreadId,
      providerTurnId: draft.providerTurnId,
      providerItemId: draft.providerItemId,
      projectConfigVersion: snapshot.configVersion,
      projectConfigHash: snapshot.configHash,
      projectConfigSnapshot: snapshot,
    });
    this.store.saveRevision(revision);
    const updatedPlan = updatePlanStatus(this.store, plan, {
      title: draft.title,
      revision: draft.targetRevision,
      status: "READY",
      resolvedContract: draft.resolvedContract,
      ...(draft.generatedSpec ? { generatedSpec: draft.generatedSpec } : {}),
      sourceExplorerThreadId: draft.sourceExplorerThreadId,
      sourceTurnId: draft.sourceTurnId,
      providerThreadId: draft.providerThreadId,
      providerTurnId: draft.providerTurnId,
      providerItemId: draft.providerItemId,
      confirmedBy,
      confirmedAt,
      queuedAt: null,
      dispatchedAt: null,
      runId: null,
      attentionReason: null,
      lastEventAt: confirmedAt,
    });
    this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "CONFIRMED", confirmedAt, updatedAt: confirmedAt }));
    const thread = this.store.getThread(draft.sourceExplorerThreadId);
    if (thread?.activeRevisionDraftId === draftId)
      this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: confirmedAt });
    this.store.appendEvent({
      type: "plan.revision.confirmed",
      aggregateId: plan.id,
      payload: { draftId, revision: draft.targetRevision, confirmedBy },
    });
    return updatedPlan;
  }

  discardRevisionDraft(draftId: string, actorId: string): PlanRevisionDraft {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error("REVISION_DRAFT_NOT_FOUND");
    if (draft.status === "DISCARDED") return draft;
    if (draft.status === "CONFIRMED") throw new Error("REVISION_DRAFT_CONFIRMED");
    const now = this.store.now();
    const saved = this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "DISCARDED", updatedAt: now }));
    const thread = this.store.getThread(saved.sourceExplorerThreadId);
    if (thread?.activeRevisionDraftId === saved.draftId)
      this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: now });
    this.store.appendEvent({ type: "plan.revision.draft.discarded", aggregateId: saved.planId, payload: { draftId, actorId } });
    return saved;
  }

  listRevisions(planId: string): PlanRevision[] {
    this.get(planId);
    return this.store.listRevisions(planId);
  }

  /**
   * 设置这个 Plan 的前置 Plan。**Factory-owned 字段，模型不能填写。**
   *
   * 为什么只能由人设置：模型不知道 CandidatePlan 的 id（它只见过自然语言先决条件，那些写进
   * `contract.dependencies`），而 `dependsOnPlanIds` 是调度用的**真实 id 引用** —— dispatch 拿它做
   * `WAITING_DEPENDENCY` 判定（要求前置 Plan 达到 MERGED）。解析时它恒为 `[]`，所以这里是
   * "依赖"从一个不可达状态变成可达状态的唯一入口。
   *
   * 只在 Confirm 之前可改：确认后依赖随 Revision 一起冻结，改它等于改执行语义。
   * 合法性（未知 id、自环、环）由 `validatePlanDependencies` 判定，与 Confirm 时同一套规则。
   */
  setDependencies(planId: string, dependsOnPlanIds: string[], actorId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error(`Plan ${planId} dependencies cannot change from ${plan.status}`);
    const normalized = [...new Set(dependsOnPlanIds.map((id) => id.trim()).filter(Boolean))];
    const updated: CandidatePlan = { ...plan, resolvedContract: { ...plan.resolvedContract, dependsOnPlanIds: normalized } };
    this.validatePlanDependencies(updated);
    const saved = this.store.updatePlan(updated);
    this.store.appendEvent({ type: "plan.dependencies.updated", aggregateId: planId, payload: { actorId, dependsOnPlanIds: normalized } });
    return saved;
  }

  /**
   * 设置这个 Plan 按 tag 选出的验证子集（`verification.suites`）。
   *
   * 为什么需要它：suites 目前只能由 Explorer 产出，想调整就得让模型重新出一版方案。这里给一个人工
   * 入口——**仍然只让模型/人选 tag，命令 ID 由 Factory 解析**，与生成路径共用同一套规则
   * （`resolvePlanContract` → `selectVerificationCommands`）。
   *
   * 传空数组表示"不按 tag 选子集、回到项目默认全集"（不是"什么都不跑"）。
   * 会**重新解析** resolvedContract（用当前 Project 配置与原有 Git 基线），这样：
   *   1) 命令 ID 跟着 tag 变；2) 候选方案与当前配置版本对齐，Confirm 时的过期校验才不会误报。
   */
  setVerificationSuites(planId: string, suites: string[], actorId: string): CandidatePlan {
    let plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error(`Plan ${planId} verification suites cannot change from ${plan.status}`);
    if (!plan.generatedSpec || !plan.resolvedContract)
      throw new Error(`Plan ${planId} has no resolved contract to re-resolve; regenerate it from Explorer`);
    const normalized = [...new Set(suites.map((suite) => suite.trim()).filter(Boolean))];
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const snapshot = this.projects.snapshot(project.id);
    const baseline = { baseBranch: plan.resolvedContract.repository.baseBranch, baseCommit: plan.resolvedContract.repository.baseCommit };
    // 声明了 suites 就等于要求"跑项目验证"，所以把 mode 明确成 PROJECT_DEFAULT；项目没有默认命令时
    // 解析结果会是 NONE，那种情况下这个请求没有意义，明确拒绝而不是当成功。
    const generatedSpec: GeneratedPlanSpec = {
      ...plan.generatedSpec,
      verification: { mode: "PROJECT_DEFAULT", ...(normalized.length ? { suites: normalized } : {}) },
    };
    const resolvedContract = resolvePlanContract(generatedSpec, snapshot, baseline);
    if (resolvedContract.verification.mode === "NONE")
      throw new Error("Project has no default verification commands; verification suites cannot be selected");
    plan = this.store.updatePlan({ ...plan, generatedSpec, resolvedContract });
    this.store.appendEvent({
      type: "plan.verification.suites.updated",
      aggregateId: planId,
      payload: { actorId, suites: normalized, commandIds: resolvedContract.verification.commandIds },
    });
    return plan;
  }

  /** 丢弃仍处于 DRAFT 的候选计划；记录审计事件且不生成后续执行事实。 */
  /**
   * 丢弃一个方案。**判据与状态表同源**（`canDiscardPlanStatus`）：这里只是把它翻译成一句人能读的错，
   * 以及顺手清掉调度投影。
   *
   * 两类东西要一起处理，否则会留下"指向一个已丢弃方案"的孤儿：
   *   1) **调度投影**（`plan_dispatch_states`）——卡住的方案往往正躺在 Plan 中心里显示成"待处理"。
   *      删它而不是把它标成别的状态：这份投影说的是"这个方案还排不排队"，而它已经不拍了
   *      （`reviseConfiguration` 对同一件事用的是同一个动作）。
   *   2) **未合并的 Run 与 worktree** 不在这里处理：它们的回收有自己的一条路（`finish` /
   *      `releaseWorkspace`），丢弃只负责让方案不再往前走。
   */
  discard(planId: string, actorId: string): CandidatePlan {
    const plan = this.get(planId);
    if (!canDiscardPlanStatus(plan.status)) throw new Error(`Plan ${planId} cannot be discarded from ${plan.status}`);
    const discardedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "DISCARDED", lastEventAt: discardedAt });
    this.store.appendEvent({ type: "plan.discarded", aggregateId: planId, payload: { actorId } });
    this.store.deleteDispatchState(planId);
    return updated;
  }

  /** 确认 Plan 并冻结当前 Project 配置，生成后续 Run 唯一使用的 Revision。 */
  confirm(planId: string, confirmedBy: string, expectedRevision?: number): CandidatePlan {
    let plan = this.get(planId);
    if (expectedRevision !== undefined && plan.revision !== expectedRevision) throw new Error("REVISION_NOT_LATEST");
    if (plan.status === "READY" || plan.status === "ENQUEUED" || plan.status === "DISPATCHED") return plan;
    if (plan.status !== "DRAFT") {
      throw new Error(`Plan ${planId} cannot be confirmed from ${plan.status}`);
    }
    // 绑定校验：契约里的 Project / 配置版本必须与当前事实一致，否则确认下去的就是一份过期方案。
    // **Project 不在库里时跳过**（与 assertPreflightPasses 同一条容忍）：生产路径上 savePlan 的
    // 外键守卫保证 Project 存在，这条分支只服务"没注册 Project 的夹具"。
    const boundProject = this.store.getProject(plan.projectId);
    if (boundProject) {
      if (boundProject.id !== plan.resolvedContract.repository.projectId) throw new Error(`Plan ${planId} is bound to an invalid Project`);
      if (
        boundProject.configVersion !== plan.resolvedContract.repository.configVersion ||
        boundProject.configHash !== plan.resolvedContract.repository.configHash
      )
        throw new Error(`Plan ${planId} is stale because Project configuration changed; regenerate it`);
    }
    if (plan.generatedSpec) {
      const prerequisites = [...new Set([...plan.generatedSpec.dependencies, ...plan.resolvedContract.dependencies])];
      const currentTechnicalConstraints = plan.resolvedContract.design.technicalConstraints;
      const technicalConstraints = [...new Set([...currentTechnicalConstraints, ...prerequisites])];
      const constraintsChanged =
        technicalConstraints.length !== currentTechnicalConstraints.length ||
        technicalConstraints.some((constraint, index) => constraint !== currentTechnicalConstraints[index]);
      if (constraintsChanged) {
        plan = this.store.updatePlan({
          ...plan,
          resolvedContract: { ...plan.resolvedContract, design: { ...plan.resolvedContract.design, technicalConstraints } },
        });
      }
    }
    // 预检排在冻结之前：先把"计划假设的文件根本不存在"挡在门外，再写不可变的 Revision。
    this.assertPreflightPasses(plan.projectId, plan.resolvedContract);
    this.validatePlanDependencies(plan);
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? this.projects.snapshot(project.id) : undefined;
    const artifactHash = `sha256:${createHash("sha256")
      .update(JSON.stringify({ resolvedContract: plan.resolvedContract, projectConfigSnapshot }))
      .digest("hex")}`;
    const planDocumentPath = this.archiveRevision({
      projectId: plan.projectId,
      planId: plan.id,
      revision: plan.revision,
      title: plan.title,
      resolvedContract: plan.resolvedContract,
      artifactHash,
      confirmedBy,
      confirmedAt,
    });
    const revision = freezeRevision({
      planId: plan.id,
      revision: plan.revision,
      resolvedContract: plan.resolvedContract,
      ...(planDocumentPath ? { planDocumentPath } : {}),
      artifactHash,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      ...(projectConfigSnapshot
        ? {
            projectConfigVersion: projectConfigSnapshot.configVersion,
            projectConfigHash: projectConfigSnapshot.configHash,
            projectConfigSnapshot,
          }
        : {}),
    });
    this.store.saveRevision(revision);
    const updated = updatePlanStatus(this.store, plan, { status: "READY", confirmedBy, confirmedAt, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.confirmed", aggregateId: planId, payload: { confirmedBy, revision: plan.revision } });
    return updated;
  }

  private validatePlanDependencies(plan: CandidatePlan): void {
    const dependencies = plan.resolvedContract.dependsOnPlanIds ?? [];
    const plans = new Map(
      this.store
        .listPlans()
        .filter((item) => item.projectId === plan.projectId)
        .map((item) => [item.id, item]),
    );
    for (const dependencyId of dependencies) {
      if (dependencyId === plan.id) throw new Error(`Plan ${plan.id} cannot depend on itself`);
      if (!plans.has(dependencyId)) throw new Error(`Plan ${plan.id} depends on unknown plan ${dependencyId}`);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (planId: string): void => {
      if (visiting.has(planId)) throw new Error(`Plan dependency cycle detected at ${planId}`);
      if (visited.has(planId)) return;
      visiting.add(planId);
      const current = plans.get(planId);
      for (const dependencyId of current?.resolvedContract.dependsOnPlanIds ?? []) {
        if (!plans.has(dependencyId)) {
          if (planId === plan.id) throw new Error(`Plan ${plan.id} depends on unknown plan ${dependencyId}`);
          continue;
        }
        visit(dependencyId);
      }
      visiting.delete(planId);
      visited.add(planId);
    };
    visit(plan.id);
  }

  /** 执行 Plan Center 查询：只读已 Enqueued 的计划，并以 projection 提供稳定排序和游标。 */
  query(query: PlanQuery): PlanQueryResult {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
      throw new Error("Plan query limit must be between 1 and 100");
    const sourceIds = query.explorerThreadId ? this.explorerLineage(query.explorerThreadId, query.includeLineage !== false) : null;
    const keyword = query.q?.trim().toLowerCase();
    const statuses = query.status && query.status.length > 0 ? new Set(query.status) : null;
    const rows = this.store
      .listPlanQueryProjection(query.projectId)
      .filter((row) => row.queuedAt !== null)
      .filter((row) => !sourceIds || sourceIds.has(row.sourceExplorerThreadId))
      .filter((row) => !statuses || statuses.has(row.status))
      .filter((row) => !keyword || `${row.planId} ${row.title} ${row.goal}`.toLowerCase().includes(keyword))
      .filter((row) => !query.from || Date.parse(row.queuedAt!) >= Date.parse(query.from))
      .filter((row) => !query.to || Date.parse(row.queuedAt!) <= Date.parse(query.to))
      .flatMap((row) => {
        const plan = this.store.getPlan(row.planId);
        // 投影行可能没有源 Plan（历史脏数据、手工改库、或将来某个漏删路径）。
        // **跳过而不是抛错**：一行坏数据不该让整个 Plan Center 变成 500。
        // 正常流程不会产生这种行——savePlan 的外键驱动守卫 + deleteExplorerCascade 的级联删除
        // 已经覆盖了写入与清理两侧，所以这条分支只在数据已损坏时生效，不应指望测试覆盖它。
        if (!plan) return [];
        return [
          {
            planId: row.planId,
            title: row.title,
            revision: row.revision,
            status: row.status,
            projectId: row.projectId,
            sourceExplorerThreadId: row.sourceExplorerThreadId,
            // **归属需求必须从库里那份 plan 取**：查询投影表（`plan_query_projection`）没有这一列，
            // 缺了它，前端 `belongsToExplorerPlan` 会把"已派发"的方案判成不属于当前需求，
            // 于是聊天流里连方案卡都不渲染（届时只有 DRAFT / READY 的方案还看得见卡）。
            ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
            sourceTurnId: row.sourceTurnId,
            providerThreadId: plan.providerThreadId,
            providerTurnId: plan.providerTurnId,
            providerItemId: plan.providerItemId,
            createdAt: row.createdAt,
            queuedAt: row.queuedAt as string,
            dispatchedAt: row.dispatchedAt ?? null,
            runId: row.runId,
            lastEventAt: row.lastEventAt,
            attentionReason: row.attentionReason,
            priority: row.priority,
          } satisfies PlanIndexRow,
        ];
      })
      .sort((a, b) => this.comparePlanRows(a, b, query.sort));

    let start = 0;
    if (query.cursor) {
      const cursor = decodePlanCursor(query.cursor);
      if (cursor.sort !== query.sort) throw new Error("Plan query cursor sort does not match request");
      const cursorIndex = rows.findIndex((row) => row.planId === cursor.planId);
      if (cursorIndex < 0) throw new Error("Plan query cursor is no longer valid");
      start = cursorIndex + 1;
    }
    const items = rows.slice(start, start + query.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last && start + items.length < rows.length ? encodePlanCursor({ sort: query.sort, planId: last.planId }) : null,
    };
  }

  private explorerLineage(threadId: string, includeLineage: boolean): Set<string> {
    const thread = this.store.getThread(threadId);
    if (!thread) return new Set();
    if (!includeLineage) return new Set([threadId]);
    const lineage = new Set<string>([threadId]);
    let parentId = thread.parentThreadId;
    while (parentId) {
      lineage.add(parentId);
      parentId = this.store.getThread(parentId)?.parentThreadId ?? null;
    }
    let changed = true;
    const projectThreads = this.store.listThreads().filter((candidate) => candidate.projectId === thread.projectId);
    while (changed) {
      changed = false;
      for (const candidate of projectThreads) {
        if (candidate.parentThreadId && lineage.has(candidate.parentThreadId) && !lineage.has(candidate.id)) {
          lineage.add(candidate.id);
          changed = true;
        }
      }
    }
    return lineage;
  }

  private comparePlanRows(a: PlanIndexRow, b: PlanIndexRow, sort: PlanQuerySort): number {
    if (sort === "priority") {
      const priority = b.priority - a.priority;
      if (priority !== 0) return priority;
      const queued = (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "");
      if (queued !== 0) return queued;
    } else if (sort === "status") {
      const status = a.status.localeCompare(b.status);
      if (status !== 0) return status;
    } else {
      const field = sort === "queued_at" ? "queuedAt" : "lastEventAt";
      const time = (b[field] ?? "").localeCompare(a[field] ?? "");
      if (time !== 0) return time;
    }
    return a.planId.localeCompare(b.planId);
  }

  /** 读取指定不可变 Revision；缺失快照的旧数据仍按 LEGACY 兼容读取。 */
  getRevision(planId: string, revision: number): PlanRevision {
    const value = this.store.getRevision(planId, revision);
    if (!value) throw new Error(`Plan revision ${planId}@${revision} not found`);
    return value;
  }

  /** 将已确认 Plan 放入人工 Enqueued 阶段；只有显式派发才会唤醒 Scheduler。 */
  enqueue(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.resolvedContract.artifact.mode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (
      plan.status === "ENQUEUED" ||
      plan.status === "DISPATCHED" ||
      plan.status === "IN_PROGRESS" ||
      plan.status === "VERIFYING" ||
      plan.status === "MERGE_READY" ||
      plan.status === "MERGED"
    ) {
      return plan;
    }
    if (plan.status !== "READY") throw new Error(`Plan ${planId} must be confirmed before enqueue`);
    const queuedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "ENQUEUED", queuedAt, dispatchedAt: null, lastEventAt: queuedAt });
    this.store.appendEvent({ type: "plan.enqueued", aggregateId: planId, payload: { queuedAt, revision: plan.revision } });
    return updated;
  }

  /** 将人工入队的 Plan 交给调度器；派发时间保留用于 Dispatched 历史投影。 */
  dispatch(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.resolvedContract.artifact.mode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (
      plan.status === "DISPATCHED" ||
      plan.status === "IN_PROGRESS" ||
      plan.status === "VERIFYING" ||
      plan.status === "MERGE_READY" ||
      plan.status === "MERGED"
    )
      return plan;
    if (plan.status !== "ENQUEUED") throw new Error(`Plan ${planId} must be enqueued before dispatch`);
    const dispatchedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "DISPATCHED", dispatchedAt, lastEventAt: dispatchedAt });
    this.store.appendEvent({ type: "plan.dispatched", aggregateId: planId, payload: { dispatchedAt, revision: plan.revision } });
    return updated;
  }

  /**
   * 使用当前 Project 配置冻结一份新 Revision，修复尚未创建 Run 的配置阻塞派发。
   * 原 Revision 与原调度事件保持不变；新的 Revision 必须再次经过 Enqueue 与 Dispatch。
   */
  reviseConfiguration(planId: string, confirmedBy: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DISPATCHED" || plan.runId !== null) {
      throw new Error(`Plan ${planId} is not eligible for a configuration revision`);
    }
    this.validatePlanDependencies(plan);
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const projectConfigSnapshot = this.projects.snapshot(project.id);
    // 与 Scheduler / 调度协调器共用同一条判定规则，见 plan/contract.ts 的 missingVerificationCommands。
    const missingCommands = missingVerificationCommands({
      resolvedContract: plan.resolvedContract,
      commands: projectConfigSnapshot.settings.commands,
    });
    if (missingCommands.length) {
      throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missingCommands.join(", ")}`);
    }

    const confirmedAt = this.store.now();
    const revisionNumber = plan.revision + 1;
    // 这是**新的一版 Revision**（plan.revision + 1），所以同样落一份盘：每版一个文件，不覆盖旧版。
    const artifactHash = `sha256:${createHash("sha256")
      .update(JSON.stringify({ resolvedContract: plan.resolvedContract, projectConfigSnapshot }))
      .digest("hex")}`;
    const planDocumentPath = this.archiveRevision({
      projectId: plan.projectId,
      planId: plan.id,
      revision: revisionNumber,
      title: plan.title,
      resolvedContract: plan.resolvedContract,
      artifactHash,
      confirmedBy,
      confirmedAt,
    });
    const revision = freezeRevision({
      planId: plan.id,
      revision: revisionNumber,
      resolvedContract: plan.resolvedContract,
      artifactHash,
      ...(planDocumentPath ? { planDocumentPath } : {}),
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      projectConfigVersion: projectConfigSnapshot.configVersion,
      projectConfigHash: projectConfigSnapshot.configHash,
      projectConfigSnapshot,
    });
    this.store.saveRevision(revision);
    const updated = updatePlanStatus(this.store, plan, {
      revision: revisionNumber,
      status: "READY",
      confirmedBy,
      confirmedAt,
      queuedAt: null,
      dispatchedAt: null,
      runId: null,
      attentionReason: null,
      lastEventAt: confirmedAt,
    });
    this.store.appendEvent({
      type: "plan.configuration.revised",
      aggregateId: planId,
      payload: {
        confirmedBy,
        fromRevision: plan.revision,
        revision: revisionNumber,
        projectConfigVersion: projectConfigSnapshot.configVersion,
        projectConfigHash: projectConfigSnapshot.configHash,
      },
    });
    return updated;
  }

  /** 返回线程谱系下已确认或已排队的 Plan，供 Explorer 的 Plans 导航使用。 */
  listThreadPlans(threadId: string): PlanIndexRow[] {
    const current = this.store.getThread(threadId);
    if (!current) return [];
    const lineage = new Set<string>([threadId]);
    let parentId = current.parentThreadId;
    while (parentId) {
      lineage.add(parentId);
      parentId = this.store.getThread(parentId)?.parentThreadId ?? null;
    }
    const descendants = this.store.listThreads().filter((thread) => thread.projectId === current.projectId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of descendants) {
        if (thread.parentThreadId && lineage.has(thread.parentThreadId) && !lineage.has(thread.id)) {
          lineage.add(thread.id);
          changed = true;
        }
      }
    }
    return this.store
      .listPlans()
      .filter((plan) => lineage.has(plan.sourceExplorerThreadId) && (plan.queuedAt !== null || plan.status === "READY"))
      .map((plan) => ({
        planId: plan.id,
        title: plan.title,
        revision: plan.revision,
        status: plan.status,
        projectId: plan.projectId,
        sourceExplorerThreadId: plan.sourceExplorerThreadId,
        ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
        sourceTurnId: plan.sourceTurnId,
        providerThreadId: plan.providerThreadId,
        providerTurnId: plan.providerTurnId,
        providerItemId: plan.providerItemId,
        createdAt: plan.createdAt,
        queuedAt: plan.queuedAt,
        dispatchedAt: plan.dispatchedAt ?? null,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
        priority: 0,
      }))
      .sort(
        (a, b) =>
          (b.queuedAt ?? "").localeCompare(a.queuedAt ?? "") ||
          b.lastEventAt.localeCompare(a.lastEventAt) ||
          b.planId.localeCompare(a.planId),
      );
  }

  /** 按 Project 隔离返回 Plan，避免多个仓库之间出现跨项目数据串联。 */
  listProjectPlans(projectId: string): PlanIndexRow[] {
    return this.store
      .listPlans()
      .filter((plan) => plan.projectId === projectId && plan.queuedAt !== null)
      .map((plan) => ({
        planId: plan.id,
        title: plan.title,
        revision: plan.revision,
        status: plan.status,
        projectId: plan.projectId,
        sourceExplorerThreadId: plan.sourceExplorerThreadId,
        ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
        sourceTurnId: plan.sourceTurnId,
        providerThreadId: plan.providerThreadId,
        providerTurnId: plan.providerTurnId,
        providerItemId: plan.providerItemId,
        createdAt: plan.createdAt,
        queuedAt: plan.queuedAt as string,
        dispatchedAt: plan.dispatchedAt ?? null,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
        priority: 0,
      }))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  }

  /** 当前探索线程中跨所有需求分区的完整 Plan 集合。 */
  listExplorerThreadPlans(threadId: string): CandidatePlan[] {
    return this.store
      .listPlans()
      .filter((plan) => plan.sourceExplorerThreadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** 项目 Plan 中心只列尚未确认的 Candidate。 */
  listProjectPlanCandidates(projectId: string): CandidatePlan[] {
    return this.store
      .listPlans()
      .filter((plan) => plan.projectId === projectId && plan.status === "DRAFT" && plan.confirmedAt === null)
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }

  /** 项目任务中心只列已确认 Plan；合并状态仍由人工确认接口推进。 */
  listProjectTasks(projectId: string): CandidatePlan[] {
    return this.store
      .listPlans()
      .filter((plan) => plan.projectId === projectId && !["DRAFT", "DISCARDED"].includes(plan.status))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }
}
