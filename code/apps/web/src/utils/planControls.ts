/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import type { PlanStatus } from "../types";

/** 只有 DRAFT 可以显示丢弃入口，最终状态校验仍由 Domain/API 负责。 */
export function canDiscardPlan(status: PlanStatus | null | undefined): boolean {
  return status === "DRAFT";
}
