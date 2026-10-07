/**
 * 模块职责：ToolCallLedger —— 进程内记录每次工具调用的确定性结果，并在恢复时把状态不明的
 *   调用从 UNCERTAIN 收敛为 NEEDS_RECONCILIATION（即"必须先去核对，不许重放"）。
 *   **注意：这是一份**尚未接进主链路**的实现，见维护提示 4。**
 *
 * 为什么从 index.ts 抽出来（批 D）：它表达的是"结果不确定时绝不重放"这条安全约束，
 *   却一直夹在 Merge 类型与 Codex 适配器之间。搬进 tools/ 之后它与同目录的
 *   tool-runtime.ts 相邻 —— 后者才是这条约束**当前实际**的执行点（读 store 里的
 *   PersistedToolCall，遇到 NEEDS_RECONCILIATION / UNKNOWN 直接拒绝重放），两者可以并排
 *   对照，**设计与落地之间的落差**一目了然。
 *
 * 维护提示：
 *   1) **recover() 只降级、不重放**：UNCERTAIN → NEEDS_RECONCILIATION，并且硬写
 *      `replay: false`；返回值的类型字面量就是 `status: "NEEDS_RECONCILIATION"; replay: false`
 *      —— 这两项在类型层面不可为其他值，别把它放宽成 `ToolCallLedgerStatus`。
 *      "工具可能已经产生副作用"的情况下自动重试是重复执行，不是恢复。
 *   2) record() 以 callId 为键**覆盖**写入（Map.set），而 callId 由模型/Provider 提供。
 *      因此同一 callId 的第二次记录会顶掉第一次，而不是追加 —— 幂等性建立在"callId 唯一"
 *      这个上游保证上；上游若不保证，这里不会替它去重。
 *   3) entries 是**进程内 Map，不落库**。进程重启后 recover() 返回空数组，不代表"没有待核对
 *      的调用"。
 *   4) ⚠️ **本类当前没有任何生产调用方**：全仓唯一的使用者是 m5-recovery.test.ts（它直接
 *      new 一个再断言 recover 的语义）。真正的恢复路径走 PipelineStore 的
 *      PersistedToolCall（saveToolCall / listToolCalls / updateToolCall），由 tool-runtime
 *      经 store 写。也就是说这里记录的是**设计意图**而不是线上行为 —— 读它的逻辑前先确认
 *      它是否已被接上。要么把它接进 tool-runtime 的恢复路径，要么删掉并由 PersistedToolCall
 *      承担；**不要在"它已经在工作"的假设下改它**。
 *   5) ToolCall / ToolCallResult / ToolName 类型在**批 E 已改指 ./types.js**（type-only 边；
 *      批 D 当时从 ../index.js 取）。工具层的类型契约现在只有一个出处：tools/types.ts。
 */
import type { ToolCall, ToolCallResult, ToolName } from "./types.js";

export type ToolCallLedgerStatus = "PENDING" | "COMPLETED" | "DENIED" | "UNCERTAIN" | "NEEDS_RECONCILIATION";
export type ToolCallLedgerEntry = { callId: string; tool: ToolName; status: ToolCallLedgerStatus; result: ToolCallResult; replay: boolean };

/** 记录工具调用的确定性结果；UNCERTAIN 恢复为 NEEDS_RECONCILIATION，禁止静默重放。 */
export class ToolCallLedger {
  private readonly entries = new Map<string, ToolCallLedgerEntry>();

  record(call: ToolCall, result: ToolCallResult, status: ToolCallLedgerStatus): ToolCallLedgerEntry {
    const entry: ToolCallLedgerEntry = { callId: call.callId, tool: call.tool, status, result, replay: false };
    this.entries.set(call.callId, entry);
    return entry;
  }

  recover(): Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> {
    const recovered: Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "UNCERTAIN") {
        entry.status = "NEEDS_RECONCILIATION";
        entry.replay = false;
        recovered.push({ callId: entry.callId, status: "NEEDS_RECONCILIATION", replay: false });
      }
    }
    return recovered;
  }

  list(): ToolCallLedgerEntry[] {
    return [...this.entries.values()];
  }
}
