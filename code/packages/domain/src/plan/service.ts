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
 *   3) 本文件里的两个模块级辅助有各自的历史包袱，别当成随手可改的工具：
 *      - defaultPlanContract 是 V1 契约的兜底（老 Plan 没有可执行的 V2 契约时用它），
 *        它的 acceptanceCriteria 文案会被前端原样展示；
 *      - executionContractFromResolvedV2 把 V2 解析结果"投影回" V1 形状，是 V1/V2 并存的
 *        过渡层，删除它会立刻打断所有读 contract 的老路径；
 *      - verifiedProjectBaseline 在批 D 已搬去 **git/baseline.ts**（它会执行 git 子进程，原先
 *        是本文件里唯一的 IO）。本文件现在只 import 它，不再自己碰 Git。
 *   4) 查询侧（query / listThreadPlans / listProjectPlans）用的是 plan/query.ts 的投影与游标，
 *      投影字段的增删要同步两个 Store 实现，见该文件的维护提示。
 */
import { createHash } from "node:crypto";
import { parseGeneratedPlanSpecV2, resolvePlanContractV2 } from "./plan-v2.js";
import { validatePlanContract } from "./contract.js";
import { updatePlanStatus } from "./status-transition.js";
import { freezeRevision } from "../platform/freeze.js";
import { verifiedProjectBaseline } from "../git/baseline.js";
import { ProjectService } from "../project/project.js";
import { selectCurrentExplorer } from "../explorer/thread-selection.js";
import { decodePlanCursor, encodePlanCursor, planQueryProjectionFor } from "./query.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { GeneratedPlanSpecV2, ResolvedPlanContractV2 } from "./plan-v2.js";
import type { PlanArtifact } from "./completion.js";
import type { Project } from "../project/project.js";
import type {
  ApprovedChangeProposal,
  CandidatePlan,
  ChangeProposal,
  CreateCandidatePlanInput,
  CreateRevisionDraftInput,
  ExplorerPlan,
  ExplorerThread,
  ExecutionThreadSummary,
  PlanContract,
  PlanIndexRow,
  PlanLifecycleEntry,
  PlanQuery,
  PlanQueryProjection,
  PlanQueryResult,
  PlanQuerySort,
  PlanRevisionDraft,
  PlanRevisionV2,
  PlanStatus,
  PlanTask,
  RegisterThreadInput,
  RevisionLifecycleProjection,
} from "../index.js";

function defaultPlanContract(title: string): PlanContract {
  return {
    goal: title,
    acceptanceCriteria: ["Legacy record: no executable V2 contract is available"],
    include: ["."],
    exclude: [],
    baseBranch: "unverified",
    baseCommit: "unverified",
    tasks: [{ id: "legacy", title: "Historical plan", dependencies: [], status: "PENDING" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test", "project.typecheck"],
    maxRepairAttempts: 2,
    mergeStrategy: "manual",
    requireHumanMerge: true,
    dependsOnPlanIds: [],
    priority: 0,
  };
}

/** Internal adapter for pre-existing executor ports; API and revisions expose resolvedContract instead. */
function executionContractFromResolvedV2(contract: ResolvedPlanContractV2): PlanContract {
  return {
    goal: contract.objective.goal,
    acceptanceCriteria: contract.objective.acceptanceCriteria,
    include: contract.scope.includePaths,
    exclude: contract.scope.excludePaths,
    baseBranch: contract.repository.baseBranch,
    baseCommit: contract.repository.baseCommit,
    tasks: contract.tasks,
    conflictKeys: contract.conflicts,
    executorModelRole: contract.execution.executorModelRole,
    toolPolicy: contract.execution.toolPolicy,
    verificationCommandIds: contract.verification.commandIds,
    maxRepairAttempts: contract.execution.maxRepairAttempts,
    mergeStrategy: contract.merge.strategy,
    requireHumanMerge: true,
    artifactMode: contract.artifact.mode,
    ...(contract.artifact.path ? { artifactPath: contract.artifact.path } : {}),
    dependsOnPlanIds: [],
    priority: 0,
  };
}

/**
 * 负责 ExplorerThread、CandidatePlan、Confirm、Enqueue 和 Revision 的业务边界。
 * CandidatePlan 的状态变化始终先写事实，再追加领域事件，避免 UI 投影领先于持久化状态。
 */
export class PlanService {
  private readonly projects: ProjectService;

  constructor(private readonly store: PipelineStore, projects?: ProjectService) {
    this.projects = projects ?? new ProjectService(store);
  }

  /** 注册与 Project 绑定的本地线程，并追加创建事件。 */
  registerThread(input: RegisterThreadInput): ExplorerThread {
    const thread = this.store.saveThread(input);
    selectCurrentExplorer(this.store, thread);
    this.store.appendEvent({
      type: "explorer.thread.created",
      aggregateId: thread.id,
      payload: { projectId: thread.projectId, parentThreadId: thread.parentThreadId, explorerPlanId: thread.activeExplorerPlanId, turnId: null, loopId: null },
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
    let generatedSpec: GeneratedPlanSpecV2 | undefined;
    let resolvedContract: ResolvedPlanContractV2 | undefined;
    if (input.generatedSpec) {
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      generatedSpec = parseGeneratedPlanSpecV2(input.generatedSpec);
      resolvedContract = resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project));
    }
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
      contract: resolvedContract ? executionContractFromResolvedV2(resolvedContract) : input.contract ?? defaultPlanContract(input.title),
      ...(generatedSpec ? { generatedSpec } : {}),
      ...(resolvedContract ? { resolvedContract } : {}),
    };
    this.store.savePlan(plan);
    this.store.saveCandidateVersion(plan);
    this.store.appendEvent({ type: "plan.candidate.created", aggregateId: plan.id, payload: { title: plan.title, revision: plan.revision, explorerPlanId: plan.explorerPlanId ?? null, sourceTurnId: plan.sourceTurnId, providerThreadId: plan.providerThreadId, providerTurnId: plan.providerTurnId, providerItemId: plan.providerItemId } });
    return plan;
  }

  /** 每次重新生成 READY 产物都保存不可变的候选版本，确认只能使用最新版。 */
  reviseCandidate(planId: string, artifact: PlanArtifact, source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null }): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error("Only an unconfirmed Plan can be edited");
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpecV2(artifact.generatedSpec) : undefined;
    const resolvedContract = generatedSpec ? resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project)) : undefined;
    const revision = Math.max(plan.revision, ...this.store.listCandidateVersions(plan.id).map((item) => item.revision)) + 1;
    const planWithoutGeneratedSpec = { ...plan };
    delete planWithoutGeneratedSpec.generatedSpec;
    delete planWithoutGeneratedSpec.resolvedContract;
    const updated = this.store.updatePlan({
      ...planWithoutGeneratedSpec, title: artifact.title, revision,
      contract: resolvedContract ? executionContractFromResolvedV2(resolvedContract) : artifact.contract ?? plan.contract,
      ...(generatedSpec ? { generatedSpec } : {}),
      ...(resolvedContract ? { resolvedContract } : {}),
      ...source, lastEventAt: this.store.now(),
    });
    this.store.saveCandidateVersion(updated);
    this.store.appendEvent({ type: "plan.candidate.revised", aggregateId: plan.id, payload: { revision, sourceTurnId: source.sourceTurnId } });
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
      if (plan.projectId !== requirement.projectId || plan.explorerPlanId !== requirement.id || plan.sourceExplorerThreadId !== requirement.explorerThreadId || plan.status !== "DRAFT") throw new Error("Plan is not an editable candidate for this requirement");
    }
    const updated = this.store.updateExplorerPlan({ ...requirement, candidatePlanId: planId, newPlanRequested: planId === null, exploration: { ...requirement.exploration, candidatePlanId: planId }, lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.plan.selected", aggregateId: requirement.explorerThreadId, payload: { explorerPlanId, planId } });
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
    if (input.fromRevision > plan.revision || input.fromRevision < 1 || !this.store.getRevision(plan.id, input.fromRevision)) throw new Error("REVISION_NOT_FOUND");
    const active = this.store.listRevisionDrafts(plan.id).find((draft) => draft.status === "EDITING" || draft.status === "READY_TO_CONFIRM" || draft.status === "BASE_CHANGED");
    if (active) {
      this.store.saveIdempotency("revision-draft", input.clientRequestId, active as unknown as Record<string, unknown>);
      return active;
    }
    const unmergedRuns = this.store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === input.fromRevision && !this.store.findMergeRequestByRun(run.id)?.mergedAt && (run.workspacePath !== null || !["CANCELLED", "STALE"].includes(run.status)));
    if (unmergedRuns.length && !input.discardUnmergedRun) throw new Error("UNMERGED_RUN_CONFIRMATION_REQUIRED");
    const source = this.store.getRevision(plan.id, input.fromRevision)!;
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const now = this.store.now();
    const draft: PlanRevisionDraft = Object.freeze({
      draftId: this.store.nextId("revision-draft"), planId: plan.id, projectId: plan.projectId,
      basedOnRevision: input.fromRevision, targetRevision: plan.revision + 1, status: "EDITING",
      // A revision draft is rebased on the current verified default branch.  Carrying a
      // historical contract's base commit here can otherwise create an unstartable Run.
      title: plan.title, contract: { ...source.contract, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit }, ...(source.resolvedContract ? { resolvedContract: source.resolvedContract } : {}),
      sourceExplorerThreadId: thread.id, ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}), sourceTurnId: source.sourceTurnId ?? null, providerThreadId: source.providerThreadId ?? null, providerTurnId: source.providerTurnId ?? null, providerItemId: source.providerItemId ?? null,
      baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, createdAt: now, updatedAt: now, confirmedAt: null,
    });
    const saved = this.store.saveRevisionDraft(draft);
    if (thread.state === "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    else this.store.updateThread({ ...thread, activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    this.store.saveRevisionLifecycleProjection({ planId: plan.id, revision: saved.targetRevision, projectId: plan.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: thread.id, runId: null, lastEventAt: now });
    this.store.appendEvent({ type: "plan.revision.draft.created", aggregateId: plan.id, payload: { draftId: saved.draftId, fromRevision: input.fromRevision, targetRevision: saved.targetRevision, explorerThreadId: thread.id, discardUnmergedRun: input.discardUnmergedRun } });
    this.store.saveIdempotency("revision-draft", input.clientRequestId, saved as unknown as Record<string, unknown>);
    return saved;
  }

  /** READY 只更新同一个 Draft；不会为同一业务计划创建新的 planId。 */
  updateRevisionDraftFromExplorer(draftId: string, artifact: PlanArtifact, source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null }): PlanRevisionDraft {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error(`RevisionDraft ${draftId} not found`);
    if (draft.status !== "EDITING" && draft.status !== "READY_TO_CONFIRM" && draft.status !== "BASE_CHANGED") throw new Error(`RevisionDraft ${draftId} is not editable`);
    const project = this.store.getProject(draft.projectId);
    if (!project) throw new Error(`Project ${draft.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpecV2(artifact.generatedSpec) : undefined;
    const resolvedContract = generatedSpec ? resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), baseline) : undefined;
    const contract = resolvedContract ? executionContractFromResolvedV2(resolvedContract) : artifact.contract ?? draft.contract;
    const updated: PlanRevisionDraft = Object.freeze({ ...draft, title: artifact.title, contract, ...(generatedSpec ? { generatedSpec } : {}), ...(resolvedContract ? { resolvedContract } : {}), sourceExplorerThreadId: draft.sourceExplorerThreadId, ...source, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, status: "READY_TO_CONFIRM", updatedAt: this.store.now() });
    const saved = this.store.updateRevisionDraft(updated);
    this.store.saveRevisionLifecycleProjection({ planId: saved.planId, revision: saved.targetRevision, projectId: saved.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: saved.sourceExplorerThreadId, runId: null, lastEventAt: saved.updatedAt });
    this.store.appendEvent({ type: "plan.revision.draft.ready", aggregateId: saved.planId, payload: { draftId: saved.draftId, targetRevision: saved.targetRevision, sourceTurnId: source.sourceTurnId } });
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
      const changed = this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "BASE_CHANGED", updatedAt: this.store.now() }));
      this.store.saveRevisionLifecycleProjection({ planId: changed.planId, revision: changed.targetRevision, projectId: changed.projectId, title: changed.title, status: changed.status, sourceExplorerThreadId: changed.sourceExplorerThreadId, runId: null, lastEventAt: changed.updatedAt });
      throw new Error("BASE_CHANGED");
    }
    validatePlanContract(draft.contract);
    const snapshot = this.projects.snapshot(project.id);
    const confirmedAt = this.store.now();
    const revision = freezeRevision({ planId: plan.id, revision: draft.targetRevision, contract: draft.contract, ...(draft.resolvedContract ? { resolvedContract: draft.resolvedContract } : {}), artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: draft.contract, projectConfigSnapshot: snapshot })).digest("hex")}`, confirmedBy, confirmedAt, sourceExplorerThreadId: draft.sourceExplorerThreadId, ...(draft.explorerPlanId ? { explorerPlanId: draft.explorerPlanId } : {}), sourceTurnId: draft.sourceTurnId, providerThreadId: draft.providerThreadId, providerTurnId: draft.providerTurnId, providerItemId: draft.providerItemId, provenance: "CURRENT", projectConfigVersion: snapshot.configVersion, projectConfigHash: snapshot.configHash, projectConfigSnapshot: snapshot });
    this.store.saveRevision(revision);
    const updatedPlan = updatePlanStatus(this.store, plan, { title: draft.title, revision: draft.targetRevision, status: "READY", contract: draft.contract, ...(draft.generatedSpec ? { generatedSpec: draft.generatedSpec } : {}), ...(draft.resolvedContract ? { resolvedContract: draft.resolvedContract } : {}), sourceExplorerThreadId: draft.sourceExplorerThreadId, sourceTurnId: draft.sourceTurnId, providerThreadId: draft.providerThreadId, providerTurnId: draft.providerTurnId, providerItemId: draft.providerItemId, confirmedBy, confirmedAt, queuedAt: null, dispatchedAt: null, runId: null, attentionReason: null, lastEventAt: confirmedAt });
    this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "CONFIRMED", confirmedAt, updatedAt: confirmedAt }));
    const thread = this.store.getThread(draft.sourceExplorerThreadId);
    if (thread?.activeRevisionDraftId === draftId) this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: confirmedAt });
    this.store.saveRevisionLifecycleProjection({ planId: plan.id, revision: draft.targetRevision, projectId: plan.projectId, title: draft.title, status: "READY", sourceExplorerThreadId: draft.sourceExplorerThreadId, runId: null, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.revision.confirmed", aggregateId: plan.id, payload: { draftId, revision: draft.targetRevision, confirmedBy } });
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
    if (thread?.activeRevisionDraftId === saved.draftId) this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: now });
    this.store.saveRevisionLifecycleProjection({ planId: saved.planId, revision: saved.targetRevision, projectId: saved.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: saved.sourceExplorerThreadId, runId: null, lastEventAt: now });
    this.store.appendEvent({ type: "plan.revision.draft.discarded", aggregateId: saved.planId, payload: { draftId, actorId } });
    return saved;
  }

  listRevisions(planId: string): PlanRevisionV2[] { this.get(planId); return this.store.listRevisions(planId); }

  /** 丢弃仍处于 DRAFT 的候选计划；记录审计事件且不生成后续执行事实。 */
  discard(planId: string, actorId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error(`Plan ${planId} cannot be discarded from ${plan.status}`);
    const discardedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "DISCARDED", lastEventAt: discardedAt });
    this.store.appendEvent({ type: "plan.discarded", aggregateId: planId, payload: { actorId } });
    return updated;
  }

  /** 确认 Plan 并冻结当前 Project 配置，生成后续 Run 唯一使用的 Revision。 */
  confirm(planId: string, confirmedBy: string, expectedRevision?: number): CandidatePlan {
    let plan = this.get(planId);
    if (expectedRevision !== undefined && plan.revision !== expectedRevision) throw new Error("REVISION_NOT_LATEST");
    if (plan.status === "READY" || plan.status === "ENQUEUED" || plan.status === "DISPATCHED") return plan;
    if (plan.status !== "DRAFT" && plan.status !== "DESIGNED" && plan.status !== "PLANNED") {
      throw new Error(`Plan ${planId} cannot be confirmed from ${plan.status}`);
    }
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be executed by V2 scheduling`);
    if (plan.resolvedContract) {
      const project = this.store.getProject(plan.projectId);
      if (!project || project.id !== plan.resolvedContract.repository.projectId) throw new Error(`Plan ${planId} is bound to an invalid Project`);
      if (project.configVersion !== plan.resolvedContract.repository.configVersion || project.configHash !== plan.resolvedContract.repository.configHash) throw new Error(`Plan ${planId} is stale because Project configuration changed; regenerate it`);
    }
    if (plan.generatedSpec && plan.resolvedContract) {
      const prerequisites = [...new Set([...plan.generatedSpec.dependencies, ...plan.resolvedContract.dependencies])];
      const prerequisiteSet = new Set(prerequisites);
      const currentPlanDependencies = plan.contract.dependsOnPlanIds ?? [];
      const dependsOnPlanIds = currentPlanDependencies.filter((dependencyId) => !prerequisiteSet.has(dependencyId));
      const currentTechnicalConstraints = plan.resolvedContract.design.technicalConstraints;
      const technicalConstraints = [...new Set([...currentTechnicalConstraints, ...prerequisites])];
      const dependenciesChanged = dependsOnPlanIds.length !== currentPlanDependencies.length;
      const constraintsChanged = technicalConstraints.length !== currentTechnicalConstraints.length || technicalConstraints.some((constraint, index) => constraint !== currentTechnicalConstraints[index]);
      if (dependenciesChanged || constraintsChanged) {
        plan = this.store.updatePlan({
          ...plan,
          contract: { ...plan.contract, dependsOnPlanIds },
          resolvedContract: { ...plan.resolvedContract, design: { ...plan.resolvedContract.design, technicalConstraints } },
        });
      }
    }
    validatePlanContract(plan.contract);
    this.validatePlanDependencies(plan);
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? this.projects.snapshot(project.id) : undefined;
    const revision = freezeRevision({
      planId: plan.id,
      revision: plan.revision,
      contract: plan.contract,
      ...(plan.resolvedContract ? { resolvedContract: plan.resolvedContract } : {}),
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: plan.contract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const updated = updatePlanStatus(this.store, plan, { status: "READY", confirmedBy, confirmedAt, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.confirmed", aggregateId: planId, payload: { confirmedBy, revision: plan.revision } });
    return updated;
  }

  private validatePlanDependencies(plan: CandidatePlan): void {
    const dependencies = plan.contract.dependsOnPlanIds ?? [];
    const plans = new Map(this.store.listPlans().filter((item) => item.projectId === plan.projectId).map((item) => [item.id, item]));
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
      for (const dependencyId of current?.contract.dependsOnPlanIds ?? []) {
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
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Plan query limit must be between 1 and 100");
    const sourceIds = query.explorerThreadId ? this.explorerLineage(query.explorerThreadId, query.includeLineage !== false) : null;
    const keyword = query.q?.trim().toLowerCase();
    const statuses = query.status && query.status.length > 0 ? new Set(query.status) : null;
    const rows = this.store.listPlanQueryProjection(query.projectId)
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
        return [{
          planId: row.planId,
          title: row.title,
          revision: row.revision,
          status: row.status,
          projectId: row.projectId,
          sourceExplorerThreadId: row.sourceExplorerThreadId,
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
        } satisfies PlanIndexRow];
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
    return { items, nextCursor: last && start + items.length < rows.length ? encodePlanCursor({ sort: query.sort, planId: last.planId }) : null };
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
  getRevision(planId: string, revision: number): PlanRevisionV2 {
    const value = this.store.getRevision(planId, revision);
    if (!value) throw new Error(`Plan revision ${planId}@${revision} not found`);
    return value;
  }

  /** 将已确认 Plan 放入人工 Enqueued 阶段；只有显式派发才会唤醒 Scheduler。 */
  enqueue(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be enqueued`);
    if (plan.contract.artifactMode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (plan.status === "ENQUEUED" || plan.status === "DISPATCHED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") {
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
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be dispatched`);
    if (plan.contract.artifactMode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (plan.status === "DISPATCHED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") return plan;
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
    validatePlanContract(plan.contract);
    this.validatePlanDependencies(plan);
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const projectConfigSnapshot = this.projects.snapshot(project.id);
    const registeredCommands = new Set(projectConfigSnapshot.settings.commands.map((command) => command.commandId));
    const missingCommands = plan.contract.verificationCommandIds.filter((commandId) => !registeredCommands.has(commandId));
    if (missingCommands.length) {
      throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missingCommands.join(", ")}`);
    }

    const confirmedAt = this.store.now();
    const revisionNumber = plan.revision + 1;
    const revision = freezeRevision({
      planId: plan.id,
      revision: revisionNumber,
      contract: plan.contract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: plan.contract, projectConfigSnapshot })).digest("hex")}`,
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
    this.store.appendEvent({ type: "plan.configuration.revised", aggregateId: planId, payload: { confirmedBy, fromRevision: plan.revision, revision: revisionNumber, projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash } });
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
        priority: plan.contract.priority ?? 0,
      }))
      .sort((a, b) => (b.queuedAt ?? "").localeCompare(a.queuedAt ?? "") || b.lastEventAt.localeCompare(a.lastEventAt) || b.planId.localeCompare(a.planId));
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
        priority: plan.contract.priority ?? 0,
      }))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  }

  /** 当前探索线程中跨所有需求分区的完整 Plan 集合。 */
  listExplorerThreadPlans(threadId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.sourceExplorerThreadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** 项目 Plan 中心只列尚未确认的 Candidate。 */
  listProjectPlanCandidates(projectId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.projectId === projectId && plan.status === "DRAFT" && plan.confirmedAt === null)
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }

  /** 项目任务中心只列已确认 Plan；合并状态仍由人工确认接口推进。 */
  listProjectTasks(projectId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.projectId === projectId && !["DRAFT", "DISCARDED"].includes(plan.status))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }
}
