import { describe, expect, it } from "vitest";
import { formatAgentLoopCompletion, formatAgentLoopGate, formatAgentLoopState, formatAgentLoopTerminal } from "./agentLoopPresentation";

describe("agent loop presentation", () => {
  it("shares state labels while allowing each surface to choose its empty fallback", () => {
    expect(formatAgentLoopState("WAITING_FOR_INPUT")).toBe("等待输入");
    expect(formatAgentLoopState(undefined)).toBe("无活动 Loop");
    expect(formatAgentLoopState(undefined, "无活动 Loop")).toBe("无活动 Loop");
  });

  it("labels an incomplete plan with the missing areas", () => {
    expect(formatAgentLoopGate({ lastGate: { action: "continue", reason: "PLAN_INCOMPLETE:完整方案缺少验收标准与验证命令" } })).toBe(
      "方案未完成 · 验收标准与验证命令",
    );
    expect(formatAgentLoopGate({ lastGate: { action: "complete", reason: "PLAN_READY" } })).toBe("方案已就绪");
  });

  it("maps terminal database errors to the user-facing message", () => {
    expect(formatAgentLoopTerminal({ terminal: { code: "DATABASE_BUSY", message: "数据库写入暂时繁忙" } })).toBe(
      "DATABASE_BUSY · 数据库写入暂时繁忙",
    );
    expect(formatAgentLoopTerminal({ terminal: null })).toBeNull();
  });

  it("makes a one-turn completion explicit instead of treating 1/40 as a warning", () => {
    expect(formatAgentLoopCompletion({ state: "COMPLETED", stepCount: 1 })).toBe("已完成 1 个 Provider 回合");
    expect(formatAgentLoopCompletion({ state: "COMPLETED", stepCount: 4 })).toBe("已完成 4 个 Provider 回合");
    expect(formatAgentLoopCompletion({ state: "RUNNING", stepCount: 1 })).toBeNull();
  });
});
