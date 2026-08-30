/**
 * 模块职责：提供持久化工具调用、重试和执行结果记录的运行时边界.
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { createHash } from "node:crypto";
import {
  ToolGateway,
  type PipelineStore,
  type ToolCall,
  type ToolCallResult,
  type ToolRole,
} from "./index.js";

/** 持久化工具运行上下文；loopId 用于幂等和恢复关联。 */
export type ToolExecutionContext = {
  loopId: string;
  role: ToolRole;
  workspacePath: string;
  projectId?: string;
  runId?: string;
  branch?: string;
  baseCommit?: string;
  exitReason?: string;
};

/** 工具运行时端口；实现必须持久化调用事实并显式表达未知副作用。 */
export interface ToolRuntime {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolCallResult>;
  reconcile(callId: string, result: ToolCallResult): Promise<void>;
}

/** 将 ToolGateway 调用包装为可审计、可恢复但不自动重放的工具执行记录。 */
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
      const result = await this.gateway.call(call, context);
      const status = result.allowed ? "SUCCEEDED" as const : result.status === "NEEDS_RECONCILIATION" ? "NEEDS_RECONCILIATION" as const : result.status === "FAILED" ? "FAILED" as const : "DENIED" as const;
      this.store.updateToolCall({ ...this.store.getToolCall(call.callId)!, status, result, completedAt: this.store.now() });
      return result;
    } catch (error) {
      const result: ToolCallResult = { callId: call.callId, allowed: false, status: "NEEDS_RECONCILIATION", reason: error instanceof Error ? error.message : String(error), result: null, audited: true };
      this.store.updateToolCall({ ...this.store.getToolCall(call.callId)!, status: "UNKNOWN", result, completedAt: null });
      return result;
    }
  }

  async reconcile(callId: string, result: ToolCallResult): Promise<void> {
    const call = this.store.getToolCall(callId);
    if (!call) throw new Error(`Tool call ${callId} not found`);
    this.store.updateToolCall({ ...call, status: result.allowed ? "SUCCEEDED" : "FAILED", result: { ...result, status: result.allowed ? "SUCCEEDED" : "FAILED" }, completedAt: this.store.now() });
  }

  private rejected(call: ToolCall, reason: string): ToolCallResult {
    return { callId: call.callId, allowed: false, status: "DENIED", reason, result: null, audited: true };
  }
}
