/**
 * 模块职责：CandidatePlan 状态变更的唯一统一写入口——先写事实（store.updatePlan），
 *   状态确实变化时再追加一条 plan.status.changed 领域事件。
 *
 * 为什么从 index.ts 抽出来：executor-agent 与 recovery-coordinator 都要改 Plan 状态，于是两者
 *   各自 `import { updatePlanStatus } from "./index.js"`，与 index.ts 对它们的值级导入构成回流边。
 *   本模块只依赖 PipelineStore / CandidatePlan 两个**类型**（import type 被 tsc 整条擦除，
 *   不产生运行时边），因此函数搬到这里、两个调用方改指向本模块之后，两条回流边同时被切断。
 *
 * 维护提示：
 *   1) 本函数只负责 plan.status.changed 这一条通用状态事件；plan.confirmed / plan.enqueued /
 *      plan.dispatched 等领域语义事件仍由各业务服务自己追加，不要合并到这里——
 *      合并会让"哪些状态转换产生了哪些语义事件"这一契约在本文件里丢失。
 *   2) 事件只在 `updated.status !== plan.status` 时追加。改成"每次调用都追加"会让 Plan 时间线里
 *      塞满 fromStatus === toStatus 的噪声事件，且会改变前端的去重与锚点行为。
 *   3) updates 是 Partial<CandidatePlan> 的浅合并，调用方必须显式把要重置的字段写成 null
 *      （如 queuedAt: null、runId: null），否则旧值会被保留下来。
 */
import type { CandidatePlan, PipelineStore } from "../index.js";

/** 统一记录 Plan 状态变更；领域语义事件仍由各业务服务分别保留。 */
export function updatePlanStatus(
  store: PipelineStore,
  plan: CandidatePlan,
  updates: Partial<CandidatePlan>,
  reason?: string | null,
): CandidatePlan {
  const updated = store.updatePlan({ ...plan, ...updates });
  if (updated.status !== plan.status) {
    store.appendEvent({
      type: "plan.status.changed",
      aggregateId: plan.id,
      payload: {
        planId: plan.id,
        fromStatus: plan.status,
        toStatus: updated.status,
        revision: updated.revision,
        runId: updated.runId,
        reason: reason ?? updated.attentionReason ?? null,
      },
    });
  }
  return updated;
}
