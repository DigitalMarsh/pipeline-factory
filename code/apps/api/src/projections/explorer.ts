/**
 * 模块职责：ExplorerThread 的两个投影辅助 —— 按 Project 作用域解析线程
 *   `findProjectThread`，与需求状态事件的转发前脱敏 `sanitizeExplorerRequirementStatusEvent`。
 *
 * 维护提示：
 *   1) `findProjectThread` 是**跨项目访问的防线**，不是"少传一个参数的便利函数"：
 *      threadId 缺省时取 `parentThreadId === null` 的主线程；传了 threadId 也必须在**同一个
 *      projectId** 内命中。去掉 projectId 校验会让别的项目能用相同 Thread ID 读到本项目的线程。
 *   2) `sanitizeExplorerRequirementStatusEvent` 是 SSE 转发的**白名单**：事件类型、四个字段的
 *      类型、status 枚举、以及"ExplorerPlan 必须属于该 Thread 且属于该 Project"四条同时成立
 *      才返回转发载荷，否则返回 null。放宽任意一条都会把不属于当前订阅者的事件漏出去。
 *   3) 它是 `packages/domain` 之外的少量"业务判定留在 api 侧"的例子：判定要吃 `store.getExplorerPlan`
 *      的实时行，放到 domain 会逼出一个只为它存在的 Store 方法。**这不是遗漏**。
 */
import type { DomainEvent, ExplorerThread, PipelineStore } from "@pipeline-factory/domain";

/**
 * 这条**探索线程**实际用的 agent：`{ model, backend }`；两样都没有就是 null（界面留空，不要编）。
 *
 * 两个字段的来源**刻意不一样**：
 *   - `model` 是**记录下来的事实**——最近一次探索回合的 loop 启动事件（`agent.loop.started` 的
 *     payload 带着 `{role, mode, model}`）。之后再改配置也不会改写它，所以历史线程显示的是当时
 *     真跑的那个模型。
 *   - `backend` 只能取项目当前的探索配置：探索侧没有逐线程记 backend 的地方，而它本来就是**项目级**
 *     的。（执行侧不同——执行线程的 telemetry 把 model 与 backend 都记了，见 `planExecutionThread`。）
 *
 * 性能：`listAgentLoops()` 是全表读。这条只在"列出线程"与"打开线程"两处调用，线程数是十位数量级，
 * 所以没建索引；**不要**把它塞进逐需求的循环里。
 */
export function explorerThreadAgent(
  store: Pick<PipelineStore, "listTurns" | "listAgentLoops" | "listEvents" | "getProject">,
  explorer: Pick<ExplorerThread, "id" | "projectId">,
): { model: string | null; backend: string | null } | null {
  const turnIds = new Set(store.listTurns(explorer.id).map((turn) => turn.id));
  const loop = store
    .listAgentLoops()
    .filter((item) => item.ownerType === "explorer-turn" && turnIds.has(item.ownerId))
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))[0];
  const started = loop ? store.listEvents({ aggregateId: loop.id, types: ["agent.loop.started"] })[0] : undefined;
  const model = typeof started?.payload?.model === "string" ? started.payload.model : null;
  const backend = store.getProject(explorer.projectId)?.settings.models.explorer.backend ?? null;
  return model || backend ? { model, backend } : null;
}

export function sanitizeExplorerRequirementStatusEvent(
  store: Pick<PipelineStore, "getExplorerPlan">,
  thread: Pick<ExplorerThread, "id" | "projectId">,
  event: DomainEvent,
): { sequence: number; payload: { explorerPlanId: string; turnId: string | null; status: string; occurredAt: string } } | null {
  if (event.type !== "explorer.requirement.status.changed") return null;
  const explorerPlanId = event.payload.explorerPlanId;
  const turnId = event.payload.turnId;
  const status = event.payload.status;
  const occurredAt = event.payload.occurredAt;
  const allowedStatuses = new Set(["QUEUED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"]);
  if (
    typeof explorerPlanId !== "string" ||
    (typeof turnId !== "string" && turnId !== null) ||
    typeof status !== "string" ||
    !allowedStatuses.has(status) ||
    typeof occurredAt !== "string"
  )
    return null;
  const plan = store.getExplorerPlan(explorerPlanId);
  if (!plan || plan.explorerThreadId !== thread.id || plan.projectId !== thread.projectId) return null;
  return { sequence: event.sequence, payload: { explorerPlanId, turnId, status, occurredAt } };
}

/** 在指定 Project 内解析 Thread；不允许用相同 Thread ID 跨 Project 访问数据。 */
export function findProjectThread(store: PipelineStore, projectId: string, threadId?: string) {
  return store
    .listThreads()
    .find((thread) => thread.projectId === projectId && (threadId ? thread.id === threadId : thread.parentThreadId === null));
}
