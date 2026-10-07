// @vitest-environment node
/**
 * 测试职责：Loop 面板那几格**只留"有结论"的步骤**——判据是"这条步骤回答了为什么停吗"，
 * 不是"它新不新"。
 *
 * 为什么值得单独测：这条判据以前是 `slice(-4)`，而 `PROVIDER_ACTIVITY` **成对出现**
 * （started / completed 各一条），一次活动就吃掉两格，真正的死因常常挤不进去。
 * 实测那条 `LOOP_SUSPENDED · PROCESS_RESTARTED` 就是这么被挤掉的。
 */
import { describe, expect, it } from "vitest";
import { loopStepFindings } from "./agentLoopSteps";
import type { AgentLoopStep } from "../types";

function step(sequence: number, stepType: string, payload: Record<string, unknown> = {}, status = "COMPLETED"): AgentLoopStep {
  return {
    loopId: "agent-loop-1",
    sequence,
    stepType,
    status,
    callId: null,
    providerThreadId: null,
    providerTurnId: null,
    payload,
    occurredAt: "2026-10-07T12:00:00.000Z",
  };
}

/** 一次 Provider 活动 = 两条步骤，这正是旧判据被吃掉两格的原因。 */
function providerActivity(sequence: number) {
  return [step(sequence, "PROVIDER_ACTIVITY", { phase: "started" }), step(sequence + 1, "PROVIDER_ACTIVITY", { phase: "completed" })];
}

describe("Loop 步骤摘要", () => {
  it("**正常跑着的 Loop 一条都不给**：活动、用量、轮次开始、门禁放行都不是结论", () => {
    const findings = loopStepFindings([
      step(1, "LOOP_RESUMED"),
      step(2, "MODEL_STARTED"),
      ...providerActivity(3),
      step(5, "MODEL_USAGE", { inputTokens: 80320 }),
      step(6, "MODEL_TEXT_DELTA", { text: "..." }),
      step(7, "GATE_CHECKED", { action: "continue", reason: "TASKS_INCOMPLETE" }),
    ]);

    expect(findings).toEqual([]);
  });

  it("**活动再多也挤不掉结论**：结论那一条一定在，且带着载荷里的原因码", () => {
    const findings = loopStepFindings([
      ...providerActivity(1),
      step(3, "MODEL_USAGE"),
      step(4, "LOOP_SUSPENDED", { reason: "PROCESS_RESTARTED" }),
      ...providerActivity(5),
      step(7, "MODEL_STARTED"),
      step(8, "MODEL_TEXT_DELTA"),
    ]);

    expect(findings).toEqual([
      { key: "agent-loop-1-4", sequence: 4, label: "循环挂起", stepType: "LOOP_SUSPENDED", reason: "PROCESS_RESTARTED", tone: "attention" },
    ]);
  });

  it("失败的语调与其它不同——三档要在视觉上分得开", () => {
    const findings = loopStepFindings([
      step(1, "TOOL_FAILED", { reason: "command not found" }),
      step(2, "TOOL_DENIED", { reason: "policy" }),
      step(3, "GATE_CHECKED", { action: "blocked", reason: "PATH_OUTSIDE_SCOPE" }),
      step(4, "LOOP_FAILED", { reason: "PROVIDER_COMMAND_TIMEOUT" }),
    ]);

    expect(findings.map((finding) => [finding.label, finding.tone])).toEqual([
      ["工具失败", "danger"],
      ["工具被拒", "attention"],
      ["门禁拦截", "attention"],
      ["循环失败", "danger"],
    ]);
    expect(findings.at(-1)?.reason).toBe("PROVIDER_COMMAND_TIMEOUT");
  });

  it("**取消不是正常结束**：同一个 LOOP_COMPLETED，标签与语调跟着 status 走", () => {
    expect(loopStepFindings([step(1, "LOOP_COMPLETED", { reason: "user_requested" }, "CANCELLED")])).toEqual([
      { key: "agent-loop-1-1", sequence: 1, label: "循环已取消", stepType: "LOOP_COMPLETED", reason: "user_requested", tone: "attention" },
    ]);
    expect(loopStepFindings([step(1, "LOOP_COMPLETED")])[0]).toMatchObject({ label: "循环结束", tone: "neutral", reason: null });
  });

  it("超过上限只留最后几条，顺序仍按发生先后", () => {
    const findings = loopStepFindings(
      [1, 2, 3, 4, 5, 6].map((sequence) => step(sequence, "TOOL_FAILED", { reason: `r${sequence}` })),
      4,
    );

    expect(findings.map((finding) => finding.sequence)).toEqual([3, 4, 5, 6]);
  });
});
