/**
 * 模块职责：DomainEvent —— 所有聚合共享的审计事件格式（id / sequence / type /
 *   aggregateId / occurredAt / payload）。
 *
 * 为什么放在 store/（批 E）：事件的生命周期由 Store 掌管 —— appendEvent 的入参是
 *   `Omit<DomainEvent, "id" | "occurredAt" | "sequence">`，那三个字段**由 Store 赋值**，
 *   脱敏也在 appendEvent 内完成（store/in-memory-store.ts 的
 *   `redactAuditPayload(event.payload)`）。把它与 PipelineStore 端口放在一起，
 *   "谁负责给它编号、脱敏"就不再需要跨文件推断。
 *
 * 维护提示：
 *   1) **type 联合是唯一的事件类型清单，且没有任何编译期机制强制它完整**。
 *      payload 是 Record<string, unknown>，新增一种事件时编译器不会提醒你补进这个联合；
 *      漏掉之后该处 appendEvent 的入参退化成宽松类型，直到有人从严取
 *      `DomainEvent["type"]` 才会发现（agent/agent-loop.ts 就是这么取用的）。
 *      **新增事件类型时先改这里。**
 *   2) **payload 只放结构化业务事实，不放渲染结果**。api 侧的投影
 *      （planEventAggregateIds / PLAN_LIFECYCLE_EVENT_TYPES）依赖 payload 里的业务字段
 *      归组与排序；塞进展示文本会让投影与事件双双失去稳定性。同时 payload 落库前会脱敏
 *      （platform/redaction.ts），写入密钥原文等于把它留在审计表里。
 *   3) **aggregateId 是订阅与游标的归属键**：listEvents 的 aggregateId / aggregateIds
 *      过滤、SSE 的 afterSequence 游标、subscribeEvents 的分组都以它为单位。
 *      改它的语义会让断线重连安静地漏事件。
 *   4) 事件是**只追加**的：Store 端口上没有 updateEvent / deleteEvent。任何"修正历史"
 *      的需求都要表达成一条新事件 —— 这也是回放能成立的前提。
 *   5) sequence 由 Store 单调分配：**内存实现每次进程启动从 0 重新开始**，
 *      sqlite 实现则从已有行的最大序号续上。因此序号只保证"同一进程内单增"，
 *      **不要跨重启比较绝对大小**，游标语义只用"大于"。id 才是全局唯一标识。
 */

/** 所有聚合共享的审计事件格式；payload 只保存结构化业务事实。 */
export type DomainEvent = {
  id: string;
  sequence: number;
  type:
    | "project.created"
    | "project.config.updated"
    | "project.archived"
    | "project.activated"
    | "project.explorer.selected"
    | "project.execution.thread.created"
    | "project.execution.preferences.updated"
    | "project.execution.turn.accepted"
    | "project.execution.turn.started"
    | "project.execution.turn.text.delta"
    | "project.execution.turn.activity"
    | "project.execution.turn.completed"
    | "project.execution.turn.failed"
    | "project.execution.turn.cancelled"
    | "explorer.thread.created"
    | "explorer.created"
    | "explorer.deleted"
    | "explorer.title.updated"
    | "explorer.archived"
    | "explorer.activated"
    | "explorer.continued"
    | "explorer.plan.created"
    | "explorer.plan.renamed"
    | "explorer.plan.selected"
    | "explorer.turn.accepted"
    | "explorer.turn.started"
    | "explorer.turn.text.delta"
    | "explorer.turn.input_required"
    | "explorer.turn.input.resolved"
    | "explorer.turn.completed"
    | "explorer.turn.failed"
    | "explorer.turn.cancelled"
    | "explorer.thread.state.changed"
    | "explorer.requirement.status.changed"
    | "explorer.plan.incomplete"
    | "explorer.plan.ready"
    | "plan.candidate.created"
    | "plan.candidate.revised"
    | "plan.status.changed"
    | "plan.discarded"
    | "plan.confirmed"
    | "plan.enqueued"
    | "plan.dispatched"
    | "plan.configuration.revised"
    | "plan.revision.draft.created"
    | "plan.revision.draft.ready"
    | "plan.revision.draft.discarded"
    | "plan.revision.confirmed"
    | "plan.dispatch.state.changed"
    | "change.proposal.created"
    | "change.proposal.approved"
    | "change.proposal.rejected"
    | "hook.started"
    | "hook.completed"
    | "hook.failed"
    | "hook.skipped"
    | "run.paused"
    | "run.resumed"
    | "run.guidance.added"
    | "run.recovery_required"
    | "run.executor.event"
    | "verification.completed"
    | "merge.request.created"
    | "merge.detected"
    | "merge.confirmed"
    | "agent.loop.started"
    | "agent.loop.resumed"
    | "agent.loop.paused"
    | "agent.loop.cancelled"
    | "agent.loop.completed"
    | "agent.loop.failed"
    | "agent.loop.recovery_required"
    | "agent.step.model_started"
    | "agent.step.model_text_delta"
    | "agent.step.model_completed"
    | "agent.step.tool_requested"
    | "agent.step.tool_denied"
    | "agent.step.tool_completed"
    | "agent.step.tool_failed"
    | "agent.step.tool_needs_reconciliation"
    | "agent.step.input_required"
    | "agent.step.input_resolved"
    | "agent.step.context_compacted"
    | "agent.step.gate_checked"
    | "agent.step.loop_suspended"
    | "agent.step.loop_resumed"
    | "agent.step.loop_completed"
    | "agent.step.loop_failed"
    | "agent.provider.thread.started"
    | "agent.model.text.delta"
    | "agent.model.completed"
    | "agent.input.required"
    | "agent.input.resolved"
    | "agent.tool.requested"
    | "agent.tool.running"
    | "agent.tool.denied"
    | "agent.tool.completed"
    | "agent.tool.failed"
    | "agent.tool.needs_reconciliation"
    | "agent.gate.checked"
    | "agent.context.compacted";
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};
