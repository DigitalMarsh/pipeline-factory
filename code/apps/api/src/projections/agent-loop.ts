/**
 * 模块职责：AgentLoop 的两个读投影 —— 带诊断的 Loop 响应 `projectAgentLoopResponse`，
 *   以及诊断本身 `loopDiagnostics`。
 *
 * 维护提示：
 *   1) `projectAgentLoopResponse` 把 `checkpointJson` 置为 null 是**对外形状的一部分**：
 *      检查点是执行器的内部状态，不构成 API 契约，前端也不该看到它。
 *      不要因为"字段怎么变空了"把它补回去。
 *   2) `loopDiagnostics` 只读取少量步骤类型（`AGENT_LOOP_DIAGNOSTIC_STEP_TYPES`）。显式限定后
 *      Store 会跳过占绝大多数的文本增量步骤，把该投影从"读取整个 Loop 历史"降为"读取少量
 *      相关步骤"。**扩大诊断范围时必须同步扩展那个集合**，否则新看的步骤类型恒为空。
 *   3) 循环依赖的破除点：这两个函数原先在组合根（server.ts），靠回调注入给 `routes/agent-loops.ts`
 *      以避免 route ↔ 组合根的类型环。搬进本目录后 route 直接 import，回调 deps 已删除。
 *      新增投影时优先落到本目录，不要退回"传函数进去"的写法。
 */
import { AGENT_LOOP_DIAGNOSTIC_STEP_TYPES, projectAgentLoopDiagnostics } from "@pipeline-factory/domain";
import type { AgentLoop, AgentLoopDiagnostics, PipelineStore } from "@pipeline-factory/domain";

export function projectAgentLoopResponse(store: PipelineStore, loop: AgentLoop): AgentLoop & { diagnostics: AgentLoopDiagnostics } {
  return { ...loop, checkpointJson: null, diagnostics: loopDiagnostics(store, loop) };
}

/**
 * 诊断只依赖少量步骤类型。显式限定后 Store 会跳过占绝大多数的文本增量步骤，
 * 使该投影从“读取整个 Loop 历史”降为“读取少量相关步骤”。
 */

export function loopDiagnostics(store: PipelineStore, loop: import("@pipeline-factory/domain").AgentLoop) {
  return projectAgentLoopDiagnostics(loop, store.listAgentLoopSteps(loop.id, { stepTypes: AGENT_LOOP_DIAGNOSTIC_STEP_TYPES }));
}
