/**
 * 模块职责：Merge 域的 5 条路由 —— MergeRequest 的创建 / 查询 / 人工确认已合并，
 *   以及项目级的 `merge-reconciliation`（对账：把 git 里的实际合并状态追回到库中）。
 *
 * 为什么这一组单独成文件：它们的写路径要**唤醒调度协调器**，读路径不用。放一起能让这条分界
 *   一眼可见：只有 `confirm-merged` 会 `await dispatchCoordinator.wake()`。
 *
 * 维护提示：
 *   1) **`confirm-merged` 必须在响应之前 `await dispatchCoordinator.wake()`**（代码里已带原注释）。
 *      只写库不唤醒的话，界面会停留在一个已经过期的 NEEDS_REVIEW 调度投影上——这是"写库成功
 *      但界面不更新"这类最难查的 bug 的典型形态。新增任何改变 MergeRequest/Plan 派发状态的写
 *      路由时，照抄这一句。
 *   2) 创建路由的两处**幂等短路**：已有 MergeRequest 直接返回（不报错），没有 VerificationRun
 *      则 409。顺序不能颠倒——先查已有再要求验证，否则重复调用第二次会因为"没有新的验证"而
 *      400，破坏幂等。
 *   3) `verifier` 不在这里：验证是 Run 域的职责（见 routes/runs.ts 的 /verify）。本文件只消费
 *      store 里已存在的 VerificationRun。
 *   4) `POST /projects/:projectId/merge-reconciliation` 的路径前缀是 project 而不是 merge-request,
 *      但仍归本文件：它调的是 `merger.reconcileProject`，语义上就是 MergeService 的对账动作,
 *      与其余四条共用同一个 `merger` 依赖。**按域切,不按路径前缀切**（同 routes/projects.ts 与
 *      routes/explorers.ts 的那条判据）。它不唤醒协调器：对账本身会按需推进 Plan 状态。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MergeRequest, MergeService, PipelineStore, PlanDispatchCoordinator, Scheduler } from "@pipeline-factory/domain";
import { sourceCommitBody, targetCommitBody } from "../schemas/merge-requests.js";
import { projectThreadParams } from "../schemas/common.js";

export type MergeRequestRouteDeps = {
  store: PipelineStore;
  merger: MergeService;
  /** 可缺省：测试与只读实例不装协调器。缺省时写路径不唤醒，但库已更新。 */
  dispatchCoordinator?: PlanDispatchCoordinator | undefined;
  /** 可缺省：缺省时合并后不回收 Worktree（只读实例与测试）。 */
  scheduler?: Scheduler | undefined;
};

/**
 * 合并后回收 Worktree。**只在这里做**：合并是"代码已进主干"的确定信号，而 Run 正常走完
 * MERGE_READY 时 `Scheduler.finish()` 并不会被调用，Worktree 因此会一直留在磁盘上。
 * 任何异常都被降级成返回值里的一条 error，不影响 MERGED 这个事实。
 */
async function releaseMergedWorkspace(
  scheduler: Scheduler,
  store: PipelineStore,
  mergeRequest: MergeRequest,
): Promise<{ worktreeRemoved: boolean; cleanupNeedsAttention: boolean; error?: string } | null> {
  const run = store.getRun(mergeRequest.runId);
  if (!run) return null;
  try {
    // hook 的优先级与 Scheduler.finish 一致：冻结快照优先，这里给的是当前 Project 的 cleanup 设置。
    const result = await scheduler.releaseWorkspace(run.id, store.getProject(run.projectId)?.settings.hooks ?? {});
    return {
      worktreeRemoved: result.worktreeRemoved,
      cleanupNeedsAttention: result.cleanupNeedsAttention,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return { worktreeRemoved: false, cleanupNeedsAttention: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerMergeRequestRoutes(app: FastifyInstance, deps: MergeRequestRouteDeps): void {
  const { store, merger, dispatchCoordinator, scheduler } = deps;

  app.post("/api/v4/runs/:runId/merge-request", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = sourceCommitBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid merge request" });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const existing = merger.findByRun(run.id);
    if (existing) return { mergeRequest: existing };
    const verification = store.getVerificationRun(run.id);
    if (!verification) return reply.code(409).send({ error: "A passed VerificationRun is required" });
    try {
      return { mergeRequest: merger.createRequest(run, verification, body.data.sourceCommit) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be created" });
    }
  });

  app.get("/api/v4/runs/:runId/merge-request", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const mergeRequest = merger.findByRun(run.id);
    if (!mergeRequest) return reply.code(404).send({ error: "MergeRequest not found" });
    return { mergeRequest };
  });

  app.get("/api/v4/merge-requests/:mergeRequestId", async (request, reply) => {
    const params = z.object({ mergeRequestId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const mergeRequest = merger.get(params.data.mergeRequestId);
    if (!mergeRequest) return reply.code(404).send({ error: "MergeRequest not found" });
    return { mergeRequest };
  });

  app.post("/api/v4/merge-requests/:mergeRequestId/confirm-merged", async (request, reply) => {
    const params = z.object({ mergeRequestId: z.string().min(1) }).safeParse(request.params);
    const body = targetCommitBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid merge confirmation" });
    try {
      const mergeRequest = merger.confirmMerged(params.data.mergeRequestId, body.data.targetCommit);
      // 合并是"这个 Run 的代码已进主干"的确定信号：此时回收 Worktree（分支保留）。
      // 失败只作为提醒返回，不回滚 MERGED 事实——与 cleanup hook 的既有语义一致。
      const workspace = scheduler ? await releaseMergedWorkspace(scheduler, store, mergeRequest) : null;
      // MergeService owns the durable Plan transition; wake the coordinator before
      // responding so the UI never observes a stale NEEDS_REVIEW dispatch projection.
      if (dispatchCoordinator) await dispatchCoordinator.wake();
      return { mergeRequest, ...(workspace ? { workspace } : {}) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be confirmed" });
    }
  });

  app.post("/api/v4/projects/:projectId/merge-reconciliation", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId))
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return merger.reconcileProject(params.data.projectId);
    } catch (error) {
      return reply
        .code(409)
        .send({ code: "MERGE_RECONCILIATION_FAILED", error: error instanceof Error ? error.message : "Merge reconciliation failed" });
    }
  });
}
