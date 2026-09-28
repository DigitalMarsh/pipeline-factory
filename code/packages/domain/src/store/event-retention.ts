/**
 * 模块职责：事件回收（A2）的**唯一**定义——哪些事件算"可回收"，以及按什么规则挑出该删的。
 *
 * 为什么单独一个叶子模块：`pruneEvents` 有两个实现（内存 / SQLite），而"可回收"的定义必须
 *   是同一份，否则两个实现在同一份数据上会删出不同的结果——这正是 C2 契约套件要防的那类漂移。
 *   SQLite 侧做不到用本模块的函数去筛（要删的行不可能全读进内存），它把白名单翻译成 SQL，
 *   因此**这里定义的规则同时是那条 SQL 的规格**，改这里必须同步改 sqlite-store.ts。
 *
 * 为什么没放进 pipeline-store.ts：那个模块的价值在于"只由类型构成"——它对 index.ts 只留
 *   import type，tsc 整条擦除，不产生运行时边（见它的模块头）。往里面加值会破坏那条性质。
 *
 * 判定标准只有一条：**这一条事件是不是某段事实的中间态，而那段事实的最终态另有持久化副本？**
 *   - `explorer.turn.text.delta`：最终正文在 `explorer_turns.content`
 *     （thread-service 的 `updateTurn({ content: current.content + text })` 就是它的拼接）。
 *   - `agent.step.model_text_delta`：它是 `agent_loop_steps` 那一行的**事件镜像**，
 *     同样的 text 早已作为步骤落库；回收事件不影响步骤表。
 *   - `agent.model.text.delta`：与上一条逐字重复（A1a 已停止写入，这里只清理历史行）。
 *   - `project.execution.turn.text.delta`：最终正文在 `project_execution_messages.content`，
 *     载荷里也自带 `content` 全量。
 *   - `run.executor.event` 中 `payload.type === "MODEL_OUTPUT"`：它是 `execution_journal`
 *     那一行的镜像；且 `run/dispatch-coordinator.ts` 的 `isStreamingEvent` 自己就写着
 *     这类事件"只影响展示进度，不需要逐条做全量 reconcile"。
 *
 * 反过来，**任何参与业务判定的事件都不能进白名单**——例如 `plan.*`、`run.paused`、
 *   `verification.completed`：`PlanDispatchCoordinator` 靠它们推进状态，
 *   `plan-lifecycle.ts` 靠它们建 Plan 时间线。删掉不是"少了几条历史"，是状态机少了输入。
 */
import type { DomainEvent } from "./types.js";

/** 可回收的事件类型。**只有这些**（外加 MODEL_OUTPUT 的 run.executor.event）会被删除。 */
export const PRUNABLE_EVENT_TYPES = [
  "explorer.turn.text.delta",
  "agent.step.model_text_delta",
  "agent.model.text.delta",
  "project.execution.turn.text.delta",
] as const;

/**
 * 回收输入。`cutoff` 之后的事件永不删除——**由调用方算好时间点再传进来**，
 * 而不是让存储层自己取 now()：这样"删哪些"完全由入参决定，两种实现才好对齐，
 * 测试也不必去伪造历史时间戳（appendEvent 的 occurredAt 由存储层生成，调用方给不了过去的时间）。
 */
export type EventPruneInput = {
  /** ISO 时间戳；occurredAt 早于它的事件才可能被删。 */
  cutoff: string;
  /** 每个聚合的保底条数：即使早于 cutoff，也至少留下最近的这么多条可回收事件。 */
  minPerAggregate: number;
};

/** 单条事件是否属于可回收集合。 */
export function isPrunableEvent(event: { type: string; payload: Record<string, unknown> }): boolean {
  if ((PRUNABLE_EVENT_TYPES as readonly string[]).includes(event.type)) return true;
  if (event.type !== "run.executor.event") return false;
  return event.payload.type === "MODEL_OUTPUT";
}

/**
 * 挑出该删的事件 id。规则分两步，顺序不能反：
 *   1. 每个聚合按**可回收事件**为单位，最近的 minPerAggregate 条无条件留下（保底）；
 *   2. 剩下的里，occurredAt 早于 cutoff 的才进入待删集合。
 *
 * 保底**只统计可回收事件**，不是聚合的全部事件：否则一个既有大量 plan.* 事件又有少量增量的
 *   聚合会因为配额被非可回收事件占满而把增量全删掉。反过来，用"全部事件"做配额虽然更保守，
 *   但会让配额在大聚合上永远用不完，回收等于失效。
 *
 * `minPerAggregate <= 0` 时按"不保底"处理。注意不能写成 `list.slice(-minPerAggregate)`：
 *   `slice(-0)` 等于 `slice(0)`，会把整个数组都当成要保留的，于是永远删不掉东西。
 */
export function prunableEventIds(events: readonly DomainEvent[], input: EventPruneInput): Set<string> {
  const keep = new Set<string>();
  if (input.minPerAggregate > 0) {
    const byAggregate = new Map<string, DomainEvent[]>();
    for (const event of events) {
      if (!isPrunableEvent(event)) continue;
      const bucket = byAggregate.get(event.aggregateId);
      if (bucket) bucket.push(event);
      else byAggregate.set(event.aggregateId, [event]);
    }
    for (const bucket of byAggregate.values()) {
      for (const event of bucket.slice(-input.minPerAggregate)) keep.add(event.id);
    }
  }
  const doomed = new Set<string>();
  for (const event of events) {
    if (keep.has(event.id) || !isPrunableEvent(event)) continue;
    if (event.occurredAt < input.cutoff) doomed.add(event.id);
  }
  return doomed;
}
