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
    if (assessment.status === "READY") return { action: "complete", reason: "PLAN_READY" };
    const missing = assessment.missing.length > 0 ? assessment.missing.join("、") : "所有仍未明确的关键决策";
    const diagnostics = assessment.diagnostics.map((item) => `- ${item.path}：${item.message}`).join("\n");
    return {
      action: "continue",
      reason: `PLAN_INCOMPLETE:完整方案缺少${assessment.missing.join(",")}`,
      diagnostics: assessment.diagnostics,
      continuationPrompt: `继续完善当前需求的完整设计方案。当前仍缺少：${missing}。\n字段级校验结果：\n${diagnostics || "- 尚未输出 READY 协议块。"}\n请逐项修复，不要原样重复未通过的 READY 协议块；如果需要用户决策，请使用原生 item/tool/requestUserInput 一次询问当前可同时确认的问题。只有全部缺口解决后，才输出完整的 pipeline-factory-plan READY 协议块。`,
    };
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
