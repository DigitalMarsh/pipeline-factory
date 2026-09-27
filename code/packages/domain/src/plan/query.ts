/**
 * 模块职责：Plan Center 的查询投影与游标分页契约。
 *
 * 为什么从 index.ts 抽出来：planQueryProjectionFor 与两个游标编解码函数同时被
 *   InMemoryPipelineStore、SqlitePipelineStore 和 PlanService 使用。三个调用方分属
 *   "要被搬走的 store" 与 "留在 index.ts 的 service" 两侧，因此它必须是零 index 值依赖的
 *   叶子模块，否则批 B 搬 store 时会引出一条新的值级回流边。
 *   搬到这里也正好落实目标目录树里 `plan/query.ts` 这一项。
 *
 * 维护提示：
 *   1) PlanQueryProjection **只是可检索、可排序字段的只读副本**，不是 CandidatePlan 的替代品。
 *      往这里加字段前先问"Plan Center 真的需要按它排序/过滤吗"——加进来意味着两个 Store
 *      实现都要同步写入，而投影与事实不一致时的表现是查询结果慢慢与实际状态漂移。
 *   2) 游标不透明（base64url），其内容 { sort, planId } 是**稳定分页边界**：排序键相同时
 *      靠 planId 打破平局。去掉 planId 会让同一 priority 的多个 Plan 在翻页时被重复或漏掉。
 *   3) decodePlanCursor 对 sort 做白名单校验并抛错，不要放宽成"直接信任解析结果"：
 *      游标来自客户端 query string，未校验时 SQL 的 ORDER BY 会变成可控输入。
 *   4) 排序白名单在两处出现（PlanQuerySort 类型与 decodePlanCursor 的数组），改一处必须改另一处。
 */
import type { CandidatePlan, PlanStatus } from "../index.js";

/** Plan Center 和 Explorer Plans 导航使用的轻量索引行。 */
export type PlanIndexRow = {
  planId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string;
  sourceTurnId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  createdAt: string;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  priority: number;
};

/** Plan Center 使用的持久化查询投影；只包含可检索、可排序的只读字段。 */
export type PlanQueryProjection = {
  planId: string;
  projectId: string;
  sourceExplorerThreadId: string;
  sourceTurnId: string | null;
  title: string;
  goal: string;
  revision: number;
  status: PlanStatus;
  priority: number;
  createdAt: string;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  lastEventAt: string;
  runId: string | null;
  attentionReason: string | null;
};

export type PlanQuerySort = "queued_at" | "last_event_at" | "priority" | "status";

/** Plan Center 的完整查询契约；cursor 与 sort 一起形成稳定分页边界。 */
export type PlanQuery = {
  projectId: string;
  explorerThreadId?: string;
  includeLineage?: boolean;
  status?: PlanStatus[];
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
  sort: PlanQuerySort;
};

export type PlanQueryResult = { items: PlanIndexRow[]; nextCursor: string | null };

/** 从 CandidatePlan 投影出可检索字段；priority 缺失时按 0 参与排序。 */
export function planQueryProjectionFor(plan: CandidatePlan): PlanQueryProjection {
  return {
    planId: plan.id,
    projectId: plan.projectId,
    sourceExplorerThreadId: plan.sourceExplorerThreadId,
    sourceTurnId: plan.sourceTurnId,
    title: plan.title,
    goal: plan.contract.goal,
    revision: plan.revision,
    status: plan.status,
    priority: plan.contract.priority ?? 0,
    createdAt: plan.createdAt,
    queuedAt: plan.queuedAt,
    dispatchedAt: plan.dispatchedAt ?? null,
    lastEventAt: plan.lastEventAt,
    runId: plan.runId,
    attentionReason: plan.attentionReason,
  };
}

type PlanCursor = { sort: PlanQuerySort; planId: string };

/** 把分页边界编码成不透明游标。 */
export function encodePlanCursor(cursor: PlanCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** 解码并校验分页游标；sort 必须在白名单内，否则抛错而不是回落默认值。 */
export function decodePlanCursor(value: string): PlanCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PlanCursor>;
    if (typeof parsed.planId !== "string" || !parsed.planId || !["queued_at", "last_event_at", "priority", "status"].includes(parsed.sort ?? "")) throw new Error("invalid");
    return { planId: parsed.planId, sort: parsed.sort as PlanQuerySort };
  } catch {
    throw new Error("Invalid Plan query cursor");
  }
}
