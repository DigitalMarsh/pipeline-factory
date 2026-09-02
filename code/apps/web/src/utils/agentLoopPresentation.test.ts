import { describe, expect, it } from "vitest";
import { formatAgentLoopCompletion, formatAgentLoopGate, formatAgentLoopTerminal } from "./agentLoopPresentation";

describe("agent loop presentation", () => {
  it("labels an incomplete plan with the missing areas", () => {
    expect(formatAgentLoopGate({ lastGate: { action: "continue", reason: "PLAN_INCOMPLETE:完整方案缺少验收标准与验证命令" } })).toBe("Plan incomplete · 验收标准与验证命令");
    expect(formatAgentLoopGate({ lastGate: { action: "complete", reason: "PLAN_READY" } })).toBe("Plan ready");
  });

  it("maps terminal database errors to the user-facing message", () => {
    expect(formatAgentLoopTerminal({ terminal: { code: "DATABASE_BUSY", message: "数据库写入暂时繁忙" } })).toBe("DATABASE_BUSY · 数据库写入暂时繁忙");
    expect(formatAgentLoopTerminal({ terminal: null })).toBeNull();
  });

  it("makes a one-turn completion explicit instead of treating 1/40 as a warning", () => {
    expect(formatAgentLoopCompletion({ state: "COMPLETED", stepCount: 1 })).toBe("Completed in 1 provider turn");
    expect(formatAgentLoopCompletion({ state: "COMPLETED", stepCount: 4 })).toBe("Completed in 4 provider turns");
    expect(formatAgentLoopCompletion({ state: "RUNNING", stepCount: 1 })).toBeNull();
  });
});
