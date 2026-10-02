/**
 * 模块职责：ChangeProposal 的 3 条路由 —— 创建（挂在 run 下）、按 run 列出、批准。
 *
 * 为什么这一组单独成文件：它们是"**Executor 在 Run 中提出契约变更**"这条流程的全部 HTTP 面。
 *   批准之后 Plan 会被改写（`approve` 返回新的 plan），所以它与 runs / plans 两个域都相邻，
 *   但既不归 runs（不是 Run 的状态变更）也不归 plans（不是 Plan 的版本操作）。
 *
 * 维护提示（三条都在代码里看不出，但改错会静默出问题）：
 *   1) **批准路由返回的 `run: null` 是刻意的**，不是占位符。ChangeProposal 批准后原先的 Run
 *      已经作废，前端靠这个 null 判断"不要再挂着这个 Run"。改成返回旧 Run 会让界面继续显示
 *      一个已经不该存在的运行。
 *   2) `plan` 字段走 `store.getPlan(approved.plan.id) ?? approved.plan` 的**回退**：approve
 *      返回的是内存态 Plan，store 里的那份才是带最新版本号的。取不到时退回内存态而不是报错
 *      ——这一步在 approve 的同一事务语义之外，失败降级比 500 更符合调用方预期。
 *   3) `resolvedContract` 在 schema 里是 `z.record(z.unknown())`，这里用
 *      `as unknown as ResolvedPlanContract` 标出边界。**不要在这里补形状校验**：契约形状的
 *      唯一出处是领域侧的 `ResolvedPlanContract`，两处规则必然漂移。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChangeProposalService, PipelineStore, ResolvedPlanContract } from "@pipeline-factory/domain";
import { changeProposalBody } from "../schemas/change-proposals.js";
import { actorBody } from "../schemas/common.js";

export type ChangeProposalRouteDeps = {
  store: PipelineStore;
  changeProposals: ChangeProposalService;
};

export function registerChangeProposalRoutes(app: FastifyInstance, deps: ChangeProposalRouteDeps): void {
  const { store, changeProposals } = deps;

  app.post("/api/v4/runs/:runId/change-proposals", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = changeProposalBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid ChangeProposal" });
    try {
      const proposal = changeProposals.create({ runId: params.data.runId, reason: body.data.reason, requestedChanges: body.data.requestedChanges, resolvedContract: body.data.resolvedContract as unknown as ResolvedPlanContract, createdBy: body.data.createdBy });
      return reply.code(201).send({ proposal });
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "ChangeProposal cannot be created" }); }
  });

  app.get("/api/v4/runs/:runId/change-proposals", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id" });
    if (!store.getRun(params.data.runId)) return reply.code(404).send({ error: "Run not found" });
    return { items: store.listChangeProposals(params.data.runId) };
  });

  app.post("/api/v4/change-proposals/:proposalId/approve", async (request, reply) => {
    const params = z.object({ proposalId: z.string().min(1) }).safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid ChangeProposal approval" });
    const proposal = store.getChangeProposal(params.data.proposalId);
    if (!proposal) return reply.code(404).send({ error: "ChangeProposal not found" });
    try {
      const approved = await changeProposals.approve(params.data.proposalId, body.data.actorId);
      return { ...approved, plan: store.getPlan(approved.plan.id) ?? approved.plan, run: null };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "ChangeProposal cannot be approved" }); }
  });
}
