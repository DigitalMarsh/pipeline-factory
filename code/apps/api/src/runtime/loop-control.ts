/**
 * 模块职责：**降级路径的** AgentLoop 控制 —— 在没有真实 Loop Controller 的测试 / 降级场景里，
 *   把 pause / resume / cancel 三个动作落成持久化的状态变更与事件。
 *
 * 维护提示：
 *   1) 这是降级路径，不是主路径。组合根只在 `loop.ownerType` 既不是 `explorer-turn` 也不是
 *      `project-execution-turn`、且没有 scheduler 的 loop controller 时才调它。**它必须接受与真实
 *      controller 完全相同的一套状态转换检查**——放宽了，降级路径就会写进真实路径会拒绝的状态。
 *   2) `terminal` 里的五个终态不可再迁移，其中 `NEEDS_RECONCILIATION` 表示"结果未知、等待人工核对"：
 *      把它当成可恢复状态，会让不确定的副作用被重放（这与 `tools/tool-runtime.ts` 拒绝重放
 *      `NEEDS_RECONCILIATION` 的工具调用是同一条约束）。
 *   3) 允许的迁移只有两条：`RUNNING ← PAUSED`（resume）与 `PAUSED ← RUNNING`（pause）。
 *      resume 放宽到任意状态会把"暂停后重跑"变成"重跑两次"。
 *   4) 写库三处：loop 本体（含 checkpointJson 的快照）、step、事件。**事件类型由目标状态推出**，
 *      不是调用方传进来的——新增一个可迁移的目标状态，必须同时在这里加事件类型映射，
 *      否则该状态没有对应事件，投影读不到（`AgentLoop` 的状态集合真有变化时，这是最容易漏的一处）。
 */
import type { AgentLoop, PipelineStore } from "@pipeline-factory/domain";

/** 在没有真实 Loop Controller 的测试/降级场景中持久化控制事实，并复用相同状态转换检查。 */
export function persistLoopControl(store: PipelineStore, loop: AgentLoop, state: AgentLoop["state"], reason: string): AgentLoop {
  const terminal = new Set<AgentLoop["state"]>(["BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "NEEDS_RECONCILIATION"]);
  if (terminal.has(loop.state)) throw new Error(`AgentLoop ${loop.id} is already ${loop.state}`);
  if (state === "RUNNING" && loop.state !== "PAUSED") throw new Error(`AgentLoop ${loop.id} cannot be resumed from ${loop.state}`);
  if (state === "PAUSED" && loop.state !== "RUNNING") throw new Error(`AgentLoop ${loop.id} cannot be paused from ${loop.state}`);
  const updated = {
    ...loop,
    state,
    ...(state === "CANCELLED" ? { completedAt: store.now() } : {}),
    checkpointJson: JSON.stringify({ reason, stepCount: loop.stepCount }),
  };
  store.updateAgentLoop(updated);
  store.appendAgentLoopStep({
    loopId: loop.id,
    stepType: state === "CANCELLED" ? "LOOP_COMPLETED" : state === "PAUSED" ? "LOOP_SUSPENDED" : "LOOP_RESUMED",
    status: state === "CANCELLED" ? "CANCELLED" : "RUNNING",
    payload: { reason },
  });
  store.appendEvent({
    type: state === "CANCELLED" ? "agent.loop.cancelled" : state === "PAUSED" ? "agent.loop.paused" : "agent.loop.resumed",
    aggregateId: loop.id,
    payload: { reason },
  });
  return updated;
}
