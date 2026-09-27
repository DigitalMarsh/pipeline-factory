/**
 * 模块职责：MergeRequest 的 4 条路由 —— 两条挂在 run 下（创建 / 查询）、两条按 mergeRequestId
 *   操作（查询 / 人工确认已合并）。
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
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MergeService, PipelineStore, PlanDispatchCoordinator } from "@pipeline-factory/domain";
import { sourceCommitBody, targetCommitBody } from "../schemas/merge-requests.js";

export type MergeRequestRouteDeps = {
  store: PipelineStore;
  merger: MergeService;
  /** 可缺省：测试与只读实例不装协调器。缺省时写路径不唤醒，但库已更新。 */
  dispatchCoordinator?: PlanDispatchCoordinator | undefined;
};

export function registerMergeRequestRoutes(app: FastifyInstance, deps: MergeRequestRouteDeps): void {
  const { store, merger, dispatchCoordinator } = deps;

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
    try { return { mergeRequest: merger.createRequest(run, verification, body.data.sourceCommit) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be created" }); }
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
      // MergeService owns the durable Plan transition; wake the coordinator before
      // responding so the UI never observes a stale NEEDS_REVIEW dispatch projection.
      if (dispatchCoordinator) await dispatchCoordinator.wake();
      return { mergeRequest };
    }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be confirmed" }); }
  });
}
