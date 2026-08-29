import { createHash } from "node:crypto";
import {
  ToolGateway,
  type PipelineStore,
  type ToolCall,
  type ToolCallResult,
  type ToolRole,
} from "./index.js";

export type ToolExecutionContext = {
  loopId: string;
  role: ToolRole;
  workspacePath: string;
};

export interface ToolRuntime {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolCallResult>;
  reconcile(callId: string, result: ToolCallResult): Promise<void>;
}

export class DurableToolRuntime implements ToolRuntime {
  constructor(private readonly store: PipelineStore, private readonly gateway: ToolGateway) {}

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolCallResult> {
    const inputHash = createHash("sha256").update(JSON.stringify(call.input)).digest("hex");
    const existing = this.store.getToolCall(call.callId);
    if (existing) {
      if (existing.inputHash !== inputHash || existing.loopId !== context.loopId) return this.rejected(call, "Tool call id was reused with different input");
      if (existing.status === "NEEDS_RECONCILIATION" || existing.status === "UNKNOWN") return this.rejected(call, "Tool call requires reconciliation before replay");
      if (existing.result) return existing.result;
    } else {
      this.store.saveToolCall({ callId: call.callId, loopId: context.loopId, role: context.role, tool: call.tool, status: "PENDING", inputHash, result: null, startedAt: this.store.now(), completedAt: null });
    }

    const pending = this.store.getToolCall(call.callId)!;
    this.store.updateToolCall({ ...pending, status: "RUNNING" });
    try {
      const result = await this.gateway.call(call);
      const status = result.allowed ? "SUCCEEDED" as const : "DENIED" as const;
      this.store.updateToolCall({ ...this.store.getToolCall(call.callId)!, status, result, completedAt: this.store.now() });
      return result;
    } catch (error) {
      const result: ToolCallResult = { callId: call.callId, allowed: false, reason: error instanceof Error ? error.message : String(error), result: null, audited: true };
      this.store.updateToolCall({ ...this.store.getToolCall(call.callId)!, status: "UNKNOWN", result, completedAt: null });
      return result;
    }
  }

  async reconcile(callId: string, result: ToolCallResult): Promise<void> {
    const call = this.store.getToolCall(callId);
    if (!call) throw new Error(`Tool call ${callId} not found`);
    this.store.updateToolCall({ ...call, status: result.allowed ? "SUCCEEDED" : "FAILED", result, completedAt: this.store.now() });
  }

  private rejected(call: ToolCall, reason: string): ToolCallResult {
    return { callId: call.callId, allowed: false, reason, result: null, audited: true };
  }
}
