/**
 * 模块职责：把一个 Agent Loop 的步骤记录收敛成**能回答"为什么停了"的那几条**。
 *
 * 为什么不是"最后 N 条"：本机实测那几格里最常见的是 `PROVIDER_ACTIVITY`（Provider 报的一次活动，
 * 而且**成对出现**——started / completed 各一条），一次活动就吃掉两格，真正的结论
 * （`LOOP_SUSPENDED` / `LOOP_FAILED`）常常挤不进去。而结论才是这个面板存在的理由，
 * 所以判据不是"新不新"，而是**这条步骤有没有结论**。
 *
 * 与 `packages/domain/src/explorer/explorer-activity.ts` 那条同源：**没问题的时候不占行**
 * （门禁每轮都判一次，但只在拦截时成行），这里也一样——正常跑着的 Loop 一条都不给，
 * 面板上只留那行进度。
 *
 * 维护提示：新增步骤类型时先回答"它有没有结论"。有结论（失败、挂起、被拒、拦截）才进
 * `CONSEQUENTIAL_STEPS`；过程性的（活动、用量、正文增量、轮次开始）不要加——
 * 加进去就等于把"最后 4 条"那个毛病又请回来。
 */
import type { AgentLoopStep } from "../types";

export type LoopStepFinding = {
  key: string;
  sequence: number;
  /** 中文标签。 */
  label: string;
  /** 原始枚举名，留给 `title`——排障时要按它去 grep 代码与日志。 */
  stepType: string;
  /** 载荷里的原因码（`PROCESS_RESTARTED` / `PROVIDER_COMMAND_TIMEOUT` …）；没有就是 null。 */
  reason: string | null;
  tone: "danger" | "attention" | "neutral";
};

/** 有结论的步骤类型 → 标签与语调。**没列进来的不是"不重要"，是"没有结论"**。 */
const CONSEQUENTIAL_STEPS: Record<string, { label: string; tone: LoopStepFinding["tone"] }> = {
  LOOP_FAILED: { label: "循环失败", tone: "danger" },
  LOOP_SUSPENDED: { label: "循环挂起", tone: "attention" },
  LOOP_COMPLETED: { label: "循环结束", tone: "neutral" },
  TOOL_FAILED: { label: "工具失败", tone: "danger" },
  TOOL_DENIED: { label: "工具被拒", tone: "attention" },
  TOOL_NEEDS_RECONCILIATION: { label: "工具结果需人工核对", tone: "attention" },
  GATE_CHECKED: { label: "门禁拦截", tone: "attention" },
};

/** 取最后 `limit` 条**有结论**的步骤；顺序仍按发生先后，读起来是一条时间线。 */
export function loopStepFindings(steps: readonly AgentLoopStep[], limit = 4): LoopStepFinding[] {
  const findings: LoopStepFinding[] = [];
  for (const step of steps) {
    const finding = describeLoopStep(step);
    if (finding) findings.push(finding);
  }
  return findings.slice(-limit);
}

function describeLoopStep(step: AgentLoopStep): LoopStepFinding | null {
  /** 老库里读出来的 `stepType` 是字符串（类型里已经没有已删除的旧成员），比较放宽到 string。 */
  const stepType: string = step.stepType;
  // 门禁每轮都判一次，**只在拦截时成行**——与领域侧 explorer-activity 的判据逐字相同。
  if (stepType === "GATE_CHECKED" && step.payload.action !== "blocked") return null;
  const known = CONSEQUENTIAL_STEPS[stepType];
  if (!known) return null;
  // 取消写的是 `LOOP_COMPLETED` + status CANCELLED：标签得跟着状态走，否则读成"正常结束"。
  const cancelled = stepType === "LOOP_COMPLETED" && step.status === "CANCELLED";
  const reason = step.payload.reason;
  return {
    key: `${step.loopId}-${step.sequence}`,
    sequence: step.sequence,
    label: cancelled ? "循环已取消" : known.label,
    stepType,
    reason: typeof reason === "string" && reason ? reason : null,
    tone: cancelled ? "attention" : known.tone,
  };
}
