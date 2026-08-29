import { assessPlanCompletion } from "./index.js";
import type { GateContext, GateDecision, TerminationGate } from "./agent-loop.js";

export class PlanCompletenessGate implements TerminationGate {
  evaluate(context: GateContext): GateDecision {
    const assessment = assessPlanCompletion(context.content ?? "");
    return assessment.status === "READY"
      ? { action: "complete", reason: "PLAN_READY" }
      : { action: "continue", reason: `PLAN_INCOMPLETE:完整方案缺少${assessment.missing.join(",")}` };
  }
}

export class TaskProgressGate implements TerminationGate {
  evaluate(context: GateContext): GateDecision {
    if (!context.allTasksComplete) return { action: "continue", reason: "TASKS_INCOMPLETE" };
    if (context.hasOpenToolCalls) return { action: "continue", reason: "OPEN_TOOL_CALLS" };
    if (context.hasPendingChangeProposal) return { action: "continue", reason: "PENDING_CHANGE_PROPOSAL" };
    if (!context.pathsWithinScope) return { action: "blocked", reason: "PATH_OUTSIDE_SCOPE" };
    if (!context.reportReady) return { action: "continue", reason: "EXECUTION_REPORT_MISSING" };
    return { action: "complete", reason: "READY_FOR_VERIFY" };
  }
}
