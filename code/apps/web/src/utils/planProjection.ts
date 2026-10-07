/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { ExplorerThread, Plan, PlanRevisionDraft } from "../types";
import { planIdentity } from "./planTimeline";

export type PlanProjection = {
  thread: ExplorerThread;
  candidate: Plan | null;
  dispatched: Plan[];
};

/** 规范化候选和生命周期 Plan，保证只有 DRAFT 能作为 Candidate 显示。 */
export function normalizePlanProjection(thread: ExplorerThread, candidate: Plan | null, dispatched: Plan[]): PlanProjection {
  const draftCandidate = candidate?.status === "DRAFT" ? candidate : null;
  const candidateId = draftCandidate ? planIdentity(draftCandidate) : null;
  return {
    thread,
    candidate: draftCandidate,
    dispatched: dispatched.filter((plan) => planIdentity(plan) !== candidateId),
  };
}

/**
 * 把"修订草稿"投影成一张 Plan 卡片，好在计划中心里与正式 Revision 并排显示。
 *
 * `fallbackExplorerPlanId` 是**回退归属**：草稿自己没带 `explorerPlanId` 时挂到当前激活的需求上
 * （新建需求的第一份草稿就是这种情况）。调用方传组件里的 `activeExplorerPlanId`；
 * 传 `null` 表示当前没有激活需求，这时草稿不归属任何需求。
 *
 * 注意 `attentionReason` 只对 `BASE_CHANGED` 给提示：基底分支变了，草稿必须先 rebase 才能确认。
 */
export function planFromRevisionDraft(item: PlanRevisionDraft, fallbackExplorerPlanId: string | null): Plan {
  return {
    id: item.planId,
    planId: item.planId,
    title: item.title,
    revision: item.targetRevision,
    status: "DRAFT",
    projectId: item.projectId,
    sourceExplorerThreadId: item.sourceExplorerThreadId,
    ...(item.explorerPlanId
      ? { explorerPlanId: item.explorerPlanId }
      : fallbackExplorerPlanId
        ? { explorerPlanId: fallbackExplorerPlanId }
        : {}),
    sourceTurnId: item.sourceTurnId,
    providerThreadId: item.providerThreadId,
    providerTurnId: item.providerTurnId,
    providerItemId: item.providerItemId,
    ...(item.resolvedContract ? { resolvedContract: item.resolvedContract } : {}),
    queuedAt: null,
    dispatchedAt: null,
    runId: null,
    lastEventAt: item.updatedAt,
    attentionReason: item.status === "BASE_CHANGED" ? "The default branch changed; rebase this draft before confirming." : null,
  };
}
