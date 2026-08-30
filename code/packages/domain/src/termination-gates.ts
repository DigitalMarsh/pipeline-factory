/**
 * 模块职责：实现 Plan 完整性和 Task 进度等终止门禁。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { assessPlanCompletion } from "./index.js";
import type { GateContext, GateDecision, TerminationGate } from "./agent-loop.js";

/** 只有解析出完整的 machine-readable Plan contract 才允许 Explorer Loop 完成。 */
export class PlanCompletenessGate implements TerminationGate {
  evaluate(context: GateContext): GateDecision {
    const assessment = assessPlanCompletion(context.content ?? "");
    return assessment.status === "READY"
      ? { action: "complete", reason: "PLAN_READY" }
      : { action: "continue", reason: `PLAN_INCOMPLETE:完整方案缺少${assessment.missing.join(",")}` };
  }
}

/** Executor 的完成门禁：任务、工具调用、范围、变更提案和执行报告必须同时满足。 */
export class TaskProgressGate implements TerminationGate {
  evaluate(context: GateContext): GateDecision {
    if (context.reportError) return { action: "continue", reason: context.reportError };
    if (!context.allTasksComplete) return { action: "continue", reason: "TASKS_INCOMPLETE" };
    if (context.hasOpenToolCalls) return { action: "continue", reason: "OPEN_TOOL_CALLS" };
    if (context.hasPendingChangeProposal) return { action: "continue", reason: "PENDING_CHANGE_PROPOSAL" };
    if (context.scopeError) return { action: "blocked", reason: context.scopeError };
    if (!context.pathsWithinScope) return { action: "blocked", reason: "PATH_OUTSIDE_SCOPE" };
    if (!context.reportReady) return { action: "continue", reason: "EXECUTION_REPORT_MISSING" };
    return { action: "complete", reason: "READY_FOR_VERIFY" };
  }
}
