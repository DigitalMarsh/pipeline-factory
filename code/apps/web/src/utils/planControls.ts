/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { Plan, PlanStatus } from "../types";
import { planIdentity } from "./planTimeline";

/** 只有 DRAFT 可以显示丢弃入口，最终状态校验仍由 Domain/API 负责。 */
export function canDiscardPlan(status: PlanStatus | null | undefined): boolean {
  return status === "DRAFT";
}

/**
 * 这张卡片是不是"当前候选"。
 *
 * 用 Plan **身份**比较而不是对象引用或 `id`：列表刷新后传给模板的是一批新对象，引用必然不等；
 * 而同一个 Plan 在候选态与派发态下 `id` / `planId` 的填充也不一致（见 `planIdentity`）。
 * 候选为 `null` 时一律为 false —— 没有候选时不该有任何卡片被当成候选。
 */
export function isCandidatePlan(plan: Plan | null, candidate: Plan | null): boolean {
  return Boolean(plan && candidate && planIdentity(plan) === planIdentity(candidate));
}
