/**
 * 模块职责：ChangeProposal 的业务边界——执行阶段发现的范围变化如何**安全地**送回 Plan。
 *
 * 为什么从 index.ts 抽出来：它是一个完整的业务边界（创建提案 → 挂起 Run → 批准后产出新的
 *   不可变 Revision → 把 Plan 放回 ENQUEUED），却埋在 5,000 行的 index.ts 里，与它无关的
 *   十几个类挤在一起。搬出来之后它只依赖 plan/status-transition.ts、platform/freeze.ts 与
 *   project/project.ts 三个既有模块。
 *
 * 维护提示：
 *   1) **create 是幂等的**：同一个 Run 上已存在 OPEN 提案时直接返回它，不新建。执行器重试
 *      （超时、重启）时这是唯一防止重复提案的机制，去掉它会让一个 Run 攒出多个互相冲突的
 *      提案，而每个提案都能各自批准出一条新 Revision。
 *   2) create 会**同时**改 Run 与 Plan 两个聚合（Run → NEEDS_PLAN_CHANGE、Plan →
 *      NEEDS_PLAN_CHANGE）。两处都要走事件/状态记录，不要只改一处——否则 UI 上 Run 显示
 *      需要改 Plan、Plan 却还在执行中。
 *   3) approve 在已 APPROVED 的分支里要**重新读出 Revision 与 Run** 再返回，而不是复用
 *      proposal 上的字段：这是"重复批准"的幂等路径，调用方依赖它拿到与首次批准完全一致的
 *      结果。
 *   4) 批准产生的新 Revision 号是 `plan.revision + 1`，并且必须走 freezeRevision ——
 *      Revision 一旦落库就不再可变，这是领域约束而不只是防御性代码。
 *   5) ProjectService 是在 approve 内部**临时构造**的（只为拿一次 snapshot）。不要把它提升为
 *      构造参数：ChangeProposalService 目前是无状态的，加一个可变的 projects 依赖会让它在
 *      不同 store 实例之间无法安全复用。
 */
import { createHash } from "node:crypto";
import { updatePlanStatus } from "../plan/status-transition.js";
import { freezeRevision } from "../platform/freeze.js";
import { ProjectService } from "../project/project.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { ApprovedChangeProposal, ChangeProposal, CreateChangeProposalInput } from "../index.js";

/** 将执行阶段发现的范围变化安全地送回 Plan；批准会创建新的不可变 Revision。 */
export class ChangeProposalService {
  constructor(private readonly store: PipelineStore) {}

  /** 为 Run 创建唯一 OPEN 提案；重复调用返回已有开放提案。 */
  create(input: CreateChangeProposalInput): ChangeProposal {
    const run = this.store.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} not found`);
    const plan = this.store.getPlan(run.planId);
    if (!plan) throw new Error(`Plan ${run.planId} not found`);
    const existing = this.store.listChangeProposals(run.id).find((proposal) => proposal.status === "OPEN");
    if (existing) return existing;
    const proposal: ChangeProposal = {
      id: this.store.nextId("change-proposal"),
      runId: run.id,
      planId: plan.id,
      reason: input.reason,
      requestedChanges: [...input.requestedChanges],
      resolvedContract: input.resolvedContract,
      status: "OPEN",
      createdAt: this.store.now(),
      createdBy: input.createdBy ?? "executor",
      decidedAt: null,
      decidedBy: null,
      revision: null,
    };
    this.store.saveChangeProposal(proposal);
    this.store.saveRun({ ...run, status: "NEEDS_PLAN_CHANGE" });
    updatePlanStatus(this.store, plan, { status: "NEEDS_PLAN_CHANGE", attentionReason: input.reason, lastEventAt: proposal.createdAt }, input.reason);
    this.store.appendEvent({ type: "change.proposal.created", aggregateId: proposal.id, payload: { runId: run.id, planId: plan.id, revision: plan.revision, reason: input.reason, requestedChanges: input.requestedChanges } });
    return proposal;
  }

  async approve(proposalId: string, actorId: string): Promise<ApprovedChangeProposal> {
    const proposal = this.store.getChangeProposal(proposalId);
    if (!proposal) throw new Error(`ChangeProposal ${proposalId} not found`);
    const plan = this.store.getPlan(proposal.planId);
    if (!plan) throw new Error(`Plan ${proposal.planId} not found`);
    if (proposal.status === "APPROVED") {
      if (!proposal.revision) throw new Error(`Approved ChangeProposal ${proposal.id} is missing its revision`);
      const revision = this.store.getRevision(plan.id, proposal.revision);
      if (!revision) throw new Error(`ChangeProposal ${proposal.id} revision is missing`);
      const run = plan.runId ? this.store.getRun(plan.runId) ?? null : this.store.listRuns().find((item) => item.planId === plan.id && item.planRevision === revision.revision && item.id !== proposal.runId) ?? null;
      return { proposal, plan, revision, run };
    }
    if (proposal.status !== "OPEN") throw new Error(`ChangeProposal ${proposal.id} cannot be approved from ${proposal.status}`);
    const revisionNumber = plan.revision + 1;
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? new ProjectService(this.store).snapshot(project.id) : undefined;
    const revision = freezeRevision({
      planId: plan.id,
      revision: revisionNumber,
      resolvedContract: proposal.resolvedContract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ resolvedContract: proposal.resolvedContract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy: actorId,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const approvedProposal = this.store.updateChangeProposal({ ...proposal, status: "APPROVED", decidedAt: confirmedAt, decidedBy: actorId, revision: revisionNumber });
    const enqueuedPlan = updatePlanStatus(this.store, plan, { revision: revisionNumber, resolvedContract: proposal.resolvedContract, status: "ENQUEUED", confirmedBy: actorId, confirmedAt, queuedAt: confirmedAt, dispatchedAt: null, runId: null, attentionReason: null, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "change.proposal.approved", aggregateId: proposal.id, payload: { actorId, revision: revisionNumber, planId: plan.id } });
    return { proposal: approvedProposal, plan: enqueuedPlan, revision, run: null };
  }
}
