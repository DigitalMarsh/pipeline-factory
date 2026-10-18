/**
 * 测试职责：验证 m5-recovery 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ToolCallLedger, ToolGateway } from "./index.js";

describe("M5 tool-call recovery", () => {
  it("does not replay an uncertain side effect after restart", async () => {
    const gateway = new ToolGateway({ role: "executor", workspaceRoot: "/tmp/project", handler: async () => ({ written: true }) });
    const ledger = new ToolCallLedger();
    const callId = randomUUID();
    const call = { callId, tool: "write_file" as const, input: { path: "src/index.ts", content: "export {}" } };
    const result = await gateway.call(call);
    ledger.record(call, result, "UNCERTAIN");
    const restored = ledger.recover();
    expect(restored).toEqual([{ callId, status: "NEEDS_RECONCILIATION", replay: false }]);
    expect(ledger.record(call, result, "COMPLETED")).toMatchObject({ status: "COMPLETED" });
  });
});
