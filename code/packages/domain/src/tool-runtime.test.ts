import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DurableToolRuntime } from "./tool-runtime.js";
import { InMemoryPipelineStore, ToolGateway, type ToolCall } from "./index.js";

describe("DurableToolRuntime", () => {
  it("persists a tool result and returns it for a repeated call id", async () => {
    const store = new InMemoryPipelineStore();
    let executions = 0;
    const runtime = new DurableToolRuntime(store, new ToolGateway({
      role: "executor",
      workspaceRoot: "/tmp/project",
      handler: async () => { executions += 1; return { ok: true }; },
    }));
    const call: ToolCall = { callId: "call-1", tool: "write_file", input: { path: "src/index.ts", content: "export {}" } };

    const first = await runtime.execute(call, { loopId: "loop-1", role: "executor", workspacePath: "/tmp/project" });
    const second = await runtime.execute(call, { loopId: "loop-1", role: "executor", workspacePath: "/tmp/project" });

    expect(first).toMatchObject({ allowed: true, result: { ok: true } });
    expect(second).toEqual(first);
    expect(executions).toBe(1);
    expect(store.listToolCalls()).toHaveLength(1);
    expect(store.listToolCalls()[0]).toMatchObject({ callId: "call-1", status: "SUCCEEDED" });
  });

  it("denies Explorer side effects and records the denial", async () => {
    const store = new InMemoryPipelineStore();
    const runtime = new DurableToolRuntime(store, new ToolGateway({ role: "explorer", workspaceRoot: "/tmp/project" }));

    const result = await runtime.execute({ callId: "call-2", tool: "write_file", input: { path: "src/index.ts", content: "export {}" } }, { loopId: "loop-2", role: "explorer", workspacePath: "/tmp/project" });

    expect(result).toMatchObject({ allowed: false });
    expect(store.listToolCalls()[0]).toMatchObject({ callId: "call-2", status: "DENIED" });
  });

  it("does not replay an unknown side effect", async () => {
    const store = new InMemoryPipelineStore();
    const input = { path: "src/index.ts", content: "export {}" };
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    store.saveToolCall({ callId: "call-3", loopId: "loop-3", role: "executor", tool: "write_file", status: "NEEDS_RECONCILIATION", inputHash, result: { callId: "call-3", allowed: true, reason: null, result: null, audited: true }, startedAt: store.now(), completedAt: null });
    const runtime = new DurableToolRuntime(store, new ToolGateway({ role: "executor", workspaceRoot: "/tmp/project", handler: async () => ({ replayed: true }) }));

    const result = await runtime.execute({ callId: "call-3", tool: "write_file", input }, { loopId: "loop-3", role: "executor", workspacePath: "/tmp/project" });

    expect(result.reason).toContain("reconciliation");
    expect(result.result).toBeNull();
  });
});
