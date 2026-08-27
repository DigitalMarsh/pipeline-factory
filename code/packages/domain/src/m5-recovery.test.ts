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
