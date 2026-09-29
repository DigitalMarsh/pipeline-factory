/**
 * 模块职责：Plan 域的 27 条路由，按资源分三组 ——
 *   A) 计划目录（9 条，路径前缀是 project / explorer）：`/projects/:projectId/plans`、
 *      `.../explorers/:explorerId/{plans,confirmed-plans,all-plans,candidate,revision-draft}`、
 *      `/projects/:projectId/{candidate-plans,tasks}`、`.../selected-plan`。
 *   B) 版本与草稿（8 条）：PlanRevision 列表 / 详情、CandidateVersion 列表 / 详情、
 *      RevisionDraft 的创建 / 详情 / confirm / discard。
 *   C) Plan 生命周期动作（10 条）：`confirm` / `revisions/:revision/confirm` / `enqueue` /
 *      `revisions/:revision/enqueue` / `run` / `revisions/:revision/run` / `discard` /
 *      `revise-configuration` / `dependencies`（前置 Plan，Factory-owned，模型不能填），
 *      以及 `GET /plans/:planId` 详情。
 *
 * 与 `routes/explorers.ts` 的边界（互补的一半）：`/explorers/:explorerId/*` 下凡是资源为
 *   **CandidatePlan / PlanRevision / RevisionDraft** 的路径都归本文件，凡是资源为
 *   **ExplorerThread / ExplorerPlan** 的都归 `routes/explorers.ts`。
 *   同样：按资源归属切，不按路径前缀切。
 *
 * 维护提示：
 *   1) `ensurePlanProject` / `confirmPlanFlow` 两个闭包**从组合根搬进了本文件**（原先在 `createApp`
 *      里）。判据是全仓只有本文件的路由调用它们（grep 结果：17 / 3 处调用，全部落在 Plan 路由内），
 *      符合"若最终只被一个域用，再随该域搬走"。组合根里已无这两个名字——想加回全局守卫请用
 *      `preHandler`，那才是横切层。`ensurePlanProject` 的 `write` 参数为 true 时会额外拦截归档
 *      Project（409），只读路由传 false：**只读路由不该因项目归档而 404**，这个区分是有意的。
 *   2) `GET /plans/:planId` 的 `dispatch` 是**三级回退**：`dispatchCoordinator?.state(...) ??
 *      store.getDispatchState(...) ?? null`。有协调器时以协调器的内存投影为准（它比库里落盘的
 *      更新），没有才读库，最后才是 null。顺序颠倒会让界面回退到已经过期的调度状态。
 *   3) `POST /plans/:planId/run` 与 `/revisions/:revision/run` 是同一动作的两个入口（非版本化 /
 *      版本化），都先校验 `plan.revision` 与请求是否一致，且都在没有协调器时落回
 *      `plans.dispatch` + `scheduler.start`。两条的错误文案不同（一条按 `RUN_PREREQUISITES_UNSATISFIED`
 *      正则分错误码，另一条固定 `RUN_START_FAILED`）——改一处要连另一处一起看。
 *   4) `POST /revisions/:revision/drafts` 在创建草稿前会**按序**清理 unmerged Run：
 *      先按 `ownerType` 取消 RUNNING / WAITING_FOR_INPUT / PAUSED 的 AgentLoop，再
 *      `scheduler.finish(run.id, "cancelled")`，最后检查 cleanup hook 是否 failed（失败则 409 且
 *      **不创建 RevisionDraft**）。这个顺序不能省中间一步：只取消 loop 不 finish，worktree 留在盘上；
 *      不查 cleanup hook，会落库一个"草稿已建但工作区没清干净"的中间态。
 *   5) 状态过滤是**逗号分隔字符串**（`status: "DRAFT,READY"`），`as PlanStatus[]` 是无校验断言，
 *      非法状态会一路传到 `plans.query`。加成员时两处（web 与 domain）都要看。
 *   6) `POST /revisions/:revision/confirm` 的错误分支写成 `message === "REVISION_NOT_LATEST" ? 409 : 409`
 *      ——两个分支同码，行为上等价于常量 409，差异只在 `stage` 字段
 *      （`message.includes("not found") ? "VALIDATING" : "VALIDATION_FAILED"`）。
 *      **没有顺手简化成 409**：本步的判据是零行为变化，这类等价简化留给后续可选收尾。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AgentLoopRunner, MergeService, PipelineStore, PlanDispatchCoordinator, PlanService, PlanStatus, Scheduler } from "@pipeline-factory/domain";
import { actorBody, projectThreadParams } from "../schemas/common.js";
import { planIdParams, planRevisionParams, revisionDraftBody, revisionDraftParams, threadPlanQuery } from "../schemas/plans.js";
import { explorerCandidateQuery, projectExplorerParams, projectExplorerPlanParams } from "../schemas/explorers.js";
import { planProjection, decoratePlanRows } from "../projections/plan-lifecycle.js";

export type PlanRouteDeps = {
  store: PipelineStore;
  /** CandidatePlan / PlanRevision / RevisionDraft 的生命周期与查询。 */
  plans: PlanService;
  /** 只有一个调用点：`GET /plans/:planId` 回填 `mergeRequest`。 */
  merger: MergeService;
  /** 可缺省：缺省时两条 `run` 路由与 unmerged 清理回 503，只读路径不受影响。 */
  scheduler?: Scheduler | undefined;
  /** 可缺省：有它时 confirm 走 `confirmAndDispatch`，没有则落回 `plans.confirm`。 */
  dispatchCoordinator?: PlanDispatchCoordinator | undefined;
  /** unmerged Run 清理时按 ownerType 取消对应的 AgentLoop。 */
  loopController: Pick<AgentLoopRunner, "pause" | "resume" | "cancel">;
};

export function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  const { store, plans, merger, scheduler, dispatchCoordinator, loopController } = deps;

  // ── 两个闭包辅助（原在组合根，随 Plan 域一起搬来；见模块头维护提示 1）──────────────
  /** 计划路由的项目守卫：`write: true` 时额外拦截归档 Project。只读路由传 false。 */
  const ensurePlanProject = (projectId: string, reply: FastifyReply, write = false) => {
    const project = store.getProject(projectId);
    if (!project) {
      reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${projectId} not found` });
      return null;
    }
    if (write && project?.status === "ARCHIVED") {
      reply.code(409).send({ code: "PROJECT_ARCHIVED", error: `Project ${projectId} is archived` });
      return null;
    }
    return project;
  };
  /** 确认并（有协调器时）立即派发：走 `confirmAndDispatch` 才能在同一事务里推进调度状态。 */
  const confirmPlanFlow = async (planId: string, revision: number, actorId: string) => {
    if (dispatchCoordinator) {
      const result = await dispatchCoordinator.confirmAndDispatch(planId, revision, actorId);
      return { plan: result.plan, run: result.run, dispatch: result.state, confirmation: { stage: result.state.phase ?? result.state.status, attempt: result.state.attempt, retryable: !result.run && result.state.status !== "COMPLETED" } };
    }
    const plan = plans.confirm(planId, actorId, revision);
    return { plan, run: null, dispatch: null, confirmation: { stage: "FROZEN", attempt: 1, retryable: true } };
  };

  app.get("/api/v4/projects/:projectId/plans", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid project plan query" });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    try {
      const result = plans.query({
        projectId: params.data.projectId,
        includeLineage: query.data.includeLineage,
        limit: query.data.limit,
        sort: query.data.sort,
        ...(query.data.explorerThreadId ? { explorerThreadId: query.data.explorerThreadId } : {}),
        ...(statuses?.length ? { status: statuses } : {}),
        ...(query.data.q !== undefined ? { q: query.data.q } : {}),
        ...(query.data.from !== undefined ? { from: query.data.from } : {}),
        ...(query.data.to !== undefined ? { to: query.data.to } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      });
      return { items: decoratePlanRows(store, result.items), nextCursor: result.nextCursor };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid project plan query" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer plan query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    try {
      const result = plans.query({
        projectId: params.data.projectId,
        explorerThreadId: explorer.id,
        includeLineage: query.data.includeLineage,
        limit: query.data.limit,
        sort: query.data.sort,
        ...(statuses?.length ? { status: statuses } : {}),
        ...(query.data.q !== undefined ? { q: query.data.q } : {}),
        ...(query.data.from !== undefined ? { from: query.data.from } : {}),
        ...(query.data.to !== undefined ? { to: query.data.to } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      });
      return { items: decoratePlanRows(store, result.items), nextCursor: result.nextCursor };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid Explorer plan query" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/confirmed-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const confirmedPlans = plans.listThreadPlans(explorer.id).filter((plan) => plan.status === "READY");
    return { items: decoratePlanRows(store, confirmedPlans) };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/all-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { items: plans.listExplorerThreadPlans(explorer.id).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.get("/api/v4/projects/:projectId/candidate-plans", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { items: plans.listProjectPlanCandidates(params.data.projectId).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.get("/api/v4/projects/:projectId/tasks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { items: plans.listProjectTasks(params.data.projectId).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId/selected-plan", async (request, reply) => {
    const params = projectExplorerPlanParams.safeParse(request.params);
    const body = z.object({ planId: z.string().min(1).nullable() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid selected Plan" });
    const explorer = store.getThread(params.data.explorerId);
    const requirement = store.getExplorerPlan(params.data.explorerPlanId);
    if (!explorer || explorer.projectId !== params.data.projectId || !requirement || requirement.explorerThreadId !== explorer.id || requirement.projectId !== explorer.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    try { return { explorerPlan: plans.selectCandidate(requirement.id, body.data.planId) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be selected" }); }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/candidate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = explorerCandidateQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer candidate query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const explorerPlanId = query.data.explorerPlanId ?? explorer.activeExplorerPlanId;
    if (explorerPlanId) {
      const explorerPlan = store.getExplorerPlan(explorerPlanId);
      if (!explorerPlan || explorerPlan.explorerThreadId !== explorer.id) return reply.code(404).send({ error: "ExplorerPlan not found" });
    }
    const requirement = explorerPlanId ? store.getExplorerPlan(explorerPlanId) : explorer.activeExplorerPlanId ? store.getExplorerPlan(explorer.activeExplorerPlanId) : undefined;
    const selected = requirement?.candidatePlanId ? store.getPlan(requirement.candidatePlanId) : undefined;
    const legacyCandidate = requirement && !requirement.newPlanRequested && !requirement.candidatePlanId
      ? store.listPlans().filter((plan) => plan.projectId === explorer.projectId && plan.sourceExplorerThreadId === explorer.id && plan.explorerPlanId === requirement.id && plan.status === "DRAFT").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
    const candidate = selected?.status === "DRAFT" && selected.sourceExplorerThreadId === explorer.id ? selected : legacyCandidate;
    if (!candidate) return reply.code(404).send({ error: "Candidate plan not found" });
    return { plan: { ...candidate, ...planProjection(store, candidate) } };
  });

  /** RevisionDraft is deliberately separate from a candidate Plan: it is mutable until confirmation. */
  app.get("/api/v4/projects/:projectId/explorers/:explorerId/revision-draft", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    if (!explorer.activeRevisionDraftId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "No active revision draft" });
    const draft = store.getRevisionDraft(explorer.activeRevisionDraftId);
    if (!draft || draft.projectId !== explorer.projectId || !["EDITING", "READY_TO_CONFIRM", "BASE_CHANGED"].includes(draft.status)) {
      return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "No active revision draft" });
    }
    return { draft };
  });

  app.get("/api/v4/plans/:planId/revisions", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      return { plan: { ...plan, ...planProjection(store, plan) }, items: plans.listRevisions(plan.id), drafts: store.listRevisionDrafts(plan.id), lifecycle: store.listRevisionLifecycleProjections(plan.projectId, plan.id) };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/candidate-versions", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const items = store.listCandidateVersions(plan.id).map((version) => ({ ...version, isLatest: version.revision === plan.revision, readOnly: version.revision !== plan.revision || plan.status !== "DRAFT" }));
      return { planId: plan.id, latestRevision: plan.revision, items };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/candidate-versions/:revision", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const version = store.listCandidateVersions(plan.id).find((item) => item.revision === params.data.revision);
      if (!version) return reply.code(404).send({ code: "CANDIDATE_VERSION_NOT_FOUND", error: "Candidate version not found" });
      return { planId: plan.id, latestRevision: plan.revision, version, readOnly: version.revision !== plan.revision || plan.status !== "DRAFT" };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/revisions/:revision", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const revision = plans.getRevision(plan.id, params.data.revision);
      return { plan: { ...plan, ...planProjection(store, plan) }, planId: plan.id, revision, runs: store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === revision.revision) };
    } catch { return reply.code(404).send({ code: "REVISION_NOT_FOUND", error: "Plan revision not found" }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/drafts", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    const body = revisionDraftBody.safeParse(request.body ?? {});
    if (!params.success || !body.success || body.data.fromRevision !== params.data.revision) return reply.code(400).send({ error: "Invalid revision draft request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      const thread = store.getThread(body.data.explorerThreadId);
      if (!thread || thread.projectId !== plan.projectId) return reply.code(404).send({ code: "EXPLORER_THREAD_PROJECT_MISMATCH", error: "ExplorerThread does not belong to Plan Project" });
      const unmerged = store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === params.data.revision && !merger.findByRun(run.id)?.mergedAt && (run.workspacePath !== null || !["CANCELLED", "STALE"].includes(run.status)));
      if (unmerged.length && !body.data.discardUnmergedRun) return reply.code(409).send({ code: "UNMERGED_RUN_CONFIRMATION_REQUIRED", error: "Revision has an unmerged Run/worktree; explicit discardUnmergedRun is required", runs: unmerged.map((run) => run.id) });
      if (unmerged.length) {
        if (!scheduler) return reply.code(503).send({ code: "CLEANUP_UNAVAILABLE", error: "Scheduler is required to clean an unmerged Run" });
        for (const run of unmerged) {
          for (const loop of store.listAgentLoops(run.executionThreadId)) if (loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED") await loopController.cancel(loop.id, "revision_superseded");
          await scheduler.finish(run.id, "cancelled", {}, "revision_superseded");
          if (store.listHookExecutions(run.id).some((hook) => hook.hookType === "cleanup" && hook.status === "failed")) return reply.code(409).send({ code: "CLEANUP_FAILED", error: "Cleanup hook failed; RevisionDraft was not created", runId: run.id });
        }
      }
      const draft = plans.createRevisionDraft({ ...body.data, planId: plan.id, explorerThreadId: thread.id });
      return reply.code(201).send({ draft, explorerThread: store.getThread(thread.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message === "UNMERGED_RUN_CONFIRMATION_REQUIRED" ? 409 : 422).send({ code: message, error: message });
    }
  });

  app.get("/api/v4/plans/:planId/revision-drafts/:draftId", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply) === null) return;
    return { draft };
  });

  app.post("/api/v4/plans/:planId/revision-drafts/:draftId/confirm", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid revision confirmation" });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply, true) === null) return;
    try {
      const plan = plans.confirmRevisionDraft(draft.draftId, body.data.actorId);
      return await confirmPlanFlow(plan.id, plan.revision, body.data.actorId);
    }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: message, error: message }); }
  });

  app.post("/api/v4/plans/:planId/revision-drafts/:draftId/discard", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid revision discard" });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply, true) === null) return;
    try { return { draft: plans.discardRevisionDraft(draft.draftId, body.data.actorId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: message, error: message }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/enqueue", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest revision can be enqueued" });
      return { plan: plans.enqueue(plan.id), dispatch: null };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/run", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest revision can be dispatched" });
      if (dispatchCoordinator) {
        const dispatched = await dispatchCoordinator.dispatch(plan.id);
        return { plan: dispatched.plan, run: dispatched.state.runId ? store.getRun(dispatched.state.runId) ?? null : null, dispatch: dispatched.state };
      }
      const project = store.getProject(plan.projectId);
      const dispatchedPlan = plans.dispatch(plan.id);
      return { plan: dispatchedPlan, run: await scheduler.start(plan.id, project?.settings.hooks ?? {}), dispatch: null };
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: "RUN_START_FAILED", error: message }); }
  });

  app.get("/api/v4/plans/:planId", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const revision = store.getRevision(plan.id, plan.revision);
      return { plan: { ...plan, ...planProjection(store, plan) }, revision: revision ?? null, projectSnapshot: revision?.projectConfigSnapshot ?? null, dispatch: dispatchCoordinator?.state(plan.id) ?? store.getDispatchState(plan.id) ?? null, mergeRequest: plan.runId ? merger.findByRun(plan.runId) ?? null : null };
    } catch {
      return reply.code(404).send({ error: "Plan not found" });
    }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/confirm", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid versioned confirmation request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest candidate version can be confirmed" });
      return await confirmPlanFlow(plan.id, params.data.revision, body.data.actorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be confirmed";
      return reply.code(message === "REVISION_NOT_LATEST" ? 409 : 409).send({ code: message, error: message, stage: message.includes("not found") ? "VALIDATING" : "VALIDATION_FAILED" });
    }
  });

  app.post("/api/v4/plans/:planId/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = z.object({ actorId: z.string().min(1).default("local-user"), revision: z.number().int().positive().optional() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid confirmation request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      const revision = body.data.revision ?? plan.revision;
      if (plan.revision !== revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest candidate version can be confirmed" });
      return await confirmPlanFlow(plan.id, revision, body.data.actorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be confirmed";
      return reply.code(409).send({ code: message, error: message, stage: "VALIDATION_FAILED" });
    }
  });

  /**
   * 设置前置 Plan。**这是 Factory-owned 字段**：模型不能填（它不知道 plan id），
   * 由人在 Plan 详情里从同项目的 Plan 中挑选。合法性（未知 id / 自环 / 环）由 domain 判定。
   */
  app.put("/api/v4/plans/:planId/dependencies", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = z.object({ dependsOnPlanIds: z.array(z.string().min(1)), actorId: z.string().min(1).default("local-user") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid plan dependency request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: plans.setDependencies(params.data.planId, body.data.dependsOnPlanIds, body.data.actorId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan dependencies cannot be updated";
      if (/not found/i.test(message)) return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" });
      return reply.code(409).send({ code: "PLAN_DEPENDENCIES_INVALID", error: message });
    }
  });

  app.post("/api/v4/plans/:planId/discard", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid discard request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: plans.discard(params.data.planId, body.data.actorId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be discarded";
      if (/not found/i.test(message)) return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" });
      return reply.code(409).send({ code: "PLAN_CANNOT_BE_DISCARDED", error: message });
    }
  });

  app.post("/api/v4/plans/:planId/enqueue", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision > 1) return reply.code(409).send({ code: "REVISION_REQUIRED", error: "Use the revision-specific enqueue endpoint" });
      return { plan: plans.enqueue(params.data.planId), dispatch: null };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" });
    }
  });

  app.post("/api/v4/plans/:planId/revise-configuration", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid configuration revision request" });
    if (!dispatchCoordinator) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: dispatchCoordinator.reviseConfiguration(plan.id, body.data.actorId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan configuration cannot be revised";
      return reply.code(409).send({ code: "PLAN_CONFIGURATION_REVISION_FAILED", error: message });
    }
  });

  app.post("/api/v4/plans/:planId/run", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision > 1) return reply.code(409).send({ code: "REVISION_REQUIRED", error: "Use the revision-specific run endpoint" });
      if (dispatchCoordinator) {
        const dispatched = await dispatchCoordinator.dispatch(plan.id);
        return { plan: dispatched.plan, run: dispatched.state.runId ? store.getRun(dispatched.state.runId) ?? null : null, dispatch: dispatched.state };
      }
      const project = store.getProject(plan.projectId);
      const dispatchedPlan = plans.dispatch(plan.id);
      return { plan: dispatchedPlan, run: await scheduler.start(plan.id, project?.settings.hooks ?? {}), dispatch: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run cannot be started";
      return reply.code(409).send({ code: /RUN_PREREQUISITES_UNSATISFIED/.test(message) ? "RUN_PREREQUISITES_UNSATISFIED" : "RUN_START_FAILED", error: message });
    }
  });
}
