/**
 * 模块职责：Explorer 域的 20 条路由 —— ExplorerThread 的目录 / 创建 / 详情 / 归档 / 激活 /
 *   重命名 / 删除 / 活动时间线，ExplorerPlan 的列表 / 创建 / 工作区快照 / 重命名 / 激活，
 *   以及 `/explorer-thread/*` 的回合、输入请求、事件流（两条 SSE）。
 *
 * 两个 service 的区分（名字只差一个字母，用途完全不同）：
 *   - `explorers: ExplorerService` 管 **ExplorerThread / ExplorerPlan 的生命周期**（建、删、归档、改名）。
 *   - `explorerThread: ExplorerThreadService` 管**一次对话回合的执行**（startTurn、answerInput、
 *     cancelTurn、subscribeEvents）。
 *   组合根里后者原本叫 `explorer`，与前者只差一个 s；本文件把它重命名为 `explorerThread`——
 *   读代码时"这个方法是生命周期还是回合执行"必须一眼可辨。**改名只发生在这里的 deps 上**，
 *   组合根里的变量名保持不变以免牵动其它调用点。
 *
 * 与 `routes/plans.ts` 的边界：`/explorers/:explorerId/candidate`、`/confirmed-plans`、
 *   `/all-plans`、`/plans`、`/revision-draft` 与 `selected-plan` 虽然路径挂在本文件的前缀下，
 *   资源却是 **CandidatePlan / PlanRevision / RevisionDraft**，全部归 `routes/plans.ts`。
 *   同样：按资源归属切，不按路径前缀切。
 *
 * 维护提示：
 *   1) 两条 SSE 都是**订阅式**通道（`openSseChannel` 不传 poll），帧由
 *      `explorerThread.subscribeEvents` 的回调推。`onClose(unsubscribe)` 是必需的清理：
 *      `unsubscribe` 句柄要等 subscribeEvents 返回才拿得到，所以不能当构造参数传。
 *   2) `sse.ready(cursor, ...)` 之前那行 `cursor = Math.max(cursor, store.getLastEventSequence(...))`
 *      是**先同步重放再握手**的实现：不这么做，握手时给的游标会落后于库里已有事件，
 *      重连的客户端会以为中间丢了数据。`server-sse.test.ts` 有一条用例专门锁这个顺序。
 *   3) 需求状态流（`requirement-status/events`）推送前必须过
 *      `sanitizeExplorerRequirementStatusEvent`：它只转发"属于这个 Thread 且属于这个 Project"
 *      的需求状态事件，且把 payload 收敛成四个字段。**这是内容不外泄的防线，不是可省的过滤**。
 *   4) 删除路由捕获 `ExplorerDeleteBlockedError` 并回 409 带 `activeRunIds` / `activeLoopIds`：
 *      前端靠这两个数组显示"还有哪些运行挡着"。改成统一的 409 会让界面说不清原因。
 *   5) `/explorer-thread/turns` 与 `/input-requests/:requestId/answer` 里 503 与 409 的分界是
 *      `message.includes("recovery is required")`——同 `routes/projects.ts` 那样按文案分状态码，
 *      改领域侧措辞要连这里一起改。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ExplorerDeleteBlockedError, projectExplorerActivity, type AgentLoop, type DomainEvent, type ExplorerActivityItem, type ExplorerPlan, type ExplorerService, type ExplorerThread, type ExplorerThreadService, type ExplorerTurn, type PipelineStore } from "@pipeline-factory/domain";
import { projectExplorerParams, projectExplorerPlanParams, explorerActivityQuery, explorerCreateBody, explorerRenameBody, v4AnswerBody, v4InputQuery, v4ThreadQuery, v4ThreadStatusQuery, v4TurnBody } from "../schemas/explorers.js";
import { projectThreadParams } from "../schemas/common.js";
import { openSseChannel } from "../http/sse.js";
import { planProjection } from "../projections/plan-lifecycle.js";
import { projectAgentLoopResponse } from "../projections/agent-loop.js";
import { findProjectThread, sanitizeExplorerRequirementStatusEvent } from "../projections/explorer.js";

export type ExplorerRouteDeps = {
  store: PipelineStore;
  /** ExplorerThread / ExplorerPlan 的生命周期。 */
  explorers: ExplorerService;
  /** 一次对话回合的执行（startTurn / answerInput / cancelTurn / subscribeEvents）。 */
  explorerThread: ExplorerThreadService;
};

/**
 * 取一个 ExplorerPlan 的对话活动投影。workbench 快照与 activity 时间线两条路由共用这一套取数，
 * 合并排序的规则由 domain 的 projectExplorerActivity 定义。
 *
 * 维护提示（下次想"优化掉"这里的步骤读取时先读这段）：
 *   这里的读法看起来是"每个回合的每一步都读出来，只为拼一段正文"，很像是可以用
 *   `turn.content` 顶掉的浪费。**它不是。**产出确实依赖逐条 MODEL_TEXT_DELTA，两处：
 *     1) **气泡数量**：相邻的文本增量合并进同一条 ASSISTANT_MESSAGE，但中间只要夹了任何
 *        其它步骤（工具、门禁、Provider 活动）就会另起一条。所以"一个回合有几个助手气泡"
 *        取决于增量步与非增量步的先后——拿拼好的 content 分不出来。
 *     2) **气泡的时间与排序序号**取的是**第一条**增量的 occurredAt/sequence，而挂在气泡上的
 *        providerItemId 取的是**最后一条非空**增量给的。这两个值 content 里都没有。
 *   因此"只取每个 loop 的最后一条增量"与"改读 turn.content"都会改变可见产出（气泡数量、
 *   与其它活动的相对顺序），不是等价优化。真要收敛，得让**写侧**按"文本段"落一条事实
 *   （见 agent-loop.ts 的 flushTextDelta），而不是在读侧猜。没有等价性测试不要改这里。
 */
function planActivityInput(store: PipelineStore, explorer: ExplorerThread, explorerPlan: ExplorerPlan): { turns: ExplorerTurn[]; loops: AgentLoop[]; activity: ExplorerActivityItem[] } {
  const turns = store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === explorerPlan.id);
  const turnIds = new Set(turns.map((turn) => turn.id));
  const loops = store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId));
  const loopIds = new Set(loops.map((loop) => loop.id));
  const steps = loops.flatMap((loop) => store.listAgentLoopSteps(loop.id)).filter((step) => loopIds.has(step.loopId));
  return { turns, loops, activity: projectExplorerActivity({ turns, loops, steps }) };
}

export function registerExplorerRoutes(app: FastifyInstance, deps: ExplorerRouteDeps): void {
  const { store, explorers, explorerThread } = deps;

  app.post("/api/v4/projects/:projectId/explorers", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = explorerCreateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Explorer creation request" });
    try {
      const explorer = explorers.create({ projectId: params.data.projectId, ...(body.data.title ? { title: body.data.title } : {}), ...(body.data.originThreadId ? { originThreadId: body.data.originThreadId } : {}) });
      return reply.code(201).send({ explorer });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Explorer cannot be created" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { items: explorers.list(params.data.projectId) };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { explorer };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { items: explorers.listPlans(explorer.id) };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    try {
      const explorerPlan = explorers.createPlan(explorer.id);
      return reply.code(201).send({ explorerPlan, explorer: explorers.get(explorer.id) });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "ExplorerPlan cannot be created" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId/workspace", async (request, reply) => {
    const params = projectExplorerPlanParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    const explorerPlan = store.getExplorerPlan(params.data.explorerPlanId);
    if (!explorer || explorer.projectId !== params.data.projectId || !explorerPlan || explorerPlan.explorerThreadId !== explorer.id || explorerPlan.projectId !== explorer.projectId) {
      return reply.code(404).send({ error: "ExplorerPlan not found" });
    }
    const { turns, loops, activity } = planActivityInput(store, explorer, explorerPlan);
    const selectedCandidate = explorerPlan.candidatePlanId ? store.getPlan(explorerPlan.candidatePlanId) : undefined;
    const legacyCandidate = !explorerPlan.newPlanRequested && !explorerPlan.candidatePlanId
      ? store.listPlans().filter((plan) => plan.projectId === explorer.projectId && plan.sourceExplorerThreadId === explorer.id && plan.explorerPlanId === explorerPlan.id && plan.status === "DRAFT").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
    const candidate = selectedCandidate?.status === "DRAFT" ? selectedCandidate : legacyCandidate ?? null;
    const draft = explorer.activeRevisionDraftId ? store.getRevisionDraft(explorer.activeRevisionDraftId) : undefined;
    const revisionDraft = draft && draft.explorerPlanId === explorerPlan.id && ["EDITING", "READY_TO_CONFIRM", "BASE_CHANGED"].includes(draft.status) ? draft : null;
    return { explorerPlan, turns, activity, inputRequests: store.listInputRequests(explorer.id).filter((item) => item.explorerPlanId === explorerPlan.id), candidate: candidate ? { ...candidate, ...planProjection(store, candidate) } : null, revisionDraft, loops: loops.map((loop) => projectAgentLoopResponse(store, loop)), lastEventSequence: store.getLastEventSequence(explorer.id) };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId/rename", async (request, reply) => {
    const params = projectExplorerPlanParams.safeParse(request.params);
    const body = explorerRenameBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "ExplorerPlan title is required" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    try {
      return { explorerPlan: explorers.renamePlan(explorer.id, params.data.explorerPlanId, body.data.title) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "ExplorerPlan cannot be renamed" });
    }
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId/activate", async (request, reply) => {
    const params = projectExplorerPlanParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    try {
      const explorerPlan = explorers.activatePlan(explorer.id, params.data.explorerPlanId);
      return { explorerPlan, explorer: explorers.get(explorer.id) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "ExplorerPlan not found" });
    }
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/archive", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    try {
      return { explorer: explorers.archive(explorer.id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(409).send({ code: "EXPLORER_ARCHIVE_NOT_ALLOWED", error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/activate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { explorer: explorers.activate(explorer.id) };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/rename", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const body = explorerRenameBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Explorer title is required" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { explorer: explorers.rename(explorer.id, body.data.title) };
  });

  app.delete("/api/v4/projects/:projectId/explorers/:explorerId", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    try {
      const result = explorers.delete(explorer.id);
      return { deletedExplorerId: explorer.id, replacementExplorer: result.replacementExplorer, project: result.project, deleted: result.deleted };
    } catch (error) {
      if (error instanceof ExplorerDeleteBlockedError) {
        return reply.code(409).send({ code: error.code, error: error.message, message: error.message, activeRunIds: error.activeRunIds, activeLoopIds: error.activeLoopIds });
      }
      return reply.code(409).send({ code: "EXPLORER_DELETE_FAILED", error: error instanceof Error ? error.message : "Explorer cannot be deleted" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/activity", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = explorerActivityQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer activity query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== explorer.id || explorerPlan.projectId !== explorer.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    const { activity } = planActivityInput(store, explorer, explorerPlan);
    const items = activity.filter((item) => item.explorerPlanId === explorerPlan.id).filter((item) => !query.data.afterSequence || item.sequence > query.data.afterSequence);
    return { items, lastEventSequence: store.getLastEventSequence(explorer.id) };
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = v4TurnBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid v4 ExplorerThread turn" });
    const thread = findProjectThread(store, params.data.projectId, body.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try {
      const accepted = await explorerThread.startTurn({ threadId: body.data.threadId, explorerPlanId: body.data.explorerPlanId, content: body.data.content, clientTurnId: body.data.clientTurnId });
      return reply.code(202).send({ turn: { user: accepted.user, assistant: accepted.assistant }, eventsUrl: accepted.eventsUrl, loopId: accepted.loopId, state: accepted.assistant.status });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "ExplorerThread turn cannot be started" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid v4 turn query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== thread.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    return { items: store.listTurns(thread.id).filter((turn) => turn.explorerPlanId === explorerPlan.id), lastEventSequence: store.getLastEventSequence(thread.id) };
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/input-requests", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4InputQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid v4 input request query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== thread.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    return { items: store.listInputRequests(thread.id, query.data.status).filter((item) => item.explorerPlanId === explorerPlan.id) };
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/input-requests/:requestId/answer", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1), requestId: z.string().min(1) }).safeParse(request.params);
    const body = v4AnswerBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "clientRequestId and answers are required" });
    const inputRequest = store.getInputRequest(params.data.requestId);
    const thread = inputRequest ? findProjectThread(store, params.data.projectId, inputRequest.threadId) : undefined;
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try { const result = await explorerThread.answerInput({ threadId: thread.id, requestId: params.data.requestId, answers: body.data.answers, clientRequestId: body.data.clientRequestId, actorId: body.data.actorId }); return result; }
    catch (error) {
      const message = error instanceof Error ? error.message : "Input answer failed";
      return reply.code(message.includes("recovery is required") ? 503 : 409).send({ error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/turns/:turnId/cancel", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1), turnId: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ threadId: z.string().min(1), reason: z.string().trim().min(1).max(500).default("user_cancelled") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid v4 cancel request" });
    const thread = findProjectThread(store, params.data.projectId, body.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try { return { turn: await explorerThread.cancelTurn({ threadId: thread.id, turnId: params.data.turnId, reason: body.data.reason }) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Turn cannot be cancelled" }); }
  });

  // Explorer SSE 使用 Last-Event-ID 与数据库事件序列回放，断线重连不会丢失已持久化消息。
  app.get("/api/v4/projects/:projectId/explorer-thread/events", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid v4 event query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== thread.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    const headerSequence = Number(request.headers["last-event-id"] ?? 0) || 0;
    let cursor = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const afterSequence = cursor;
    // 订阅式通道：不传 poll，帧由 subscribeEvents 的回调推。unsubscribe 要等 subscribeEvents
    // 返回才拿得到，所以走 onClose 登记（见 http/sse.ts 维护提示 4）。
    const sse = openSseChannel(request, reply);
    const send = (event: { sequence: number; type: string; payload: Record<string, unknown> }) => { cursor = event.sequence; const type = event.type.startsWith("explorer.") ? event.type.slice("explorer.".length) : event.type; sse.send(event.sequence, type, event.payload); };
    const unsubscribe = explorerThread.subscribeEvents(thread.id, (event) => {
      if (event.payload.explorerPlanId === explorerPlan.id) send(event);
    }, afterSequence);
    sse.onClose(unsubscribe);
    cursor = Math.max(cursor, store.getLastEventSequence(thread.id));
    sse.ready(cursor, { afterSequence: cursor, explorerPlanId: explorerPlan.id });
  });

  // Thread-level status stream contains only requirement/turn state metadata, never conversation content.
  app.get("/api/v4/projects/:projectId/explorer-thread/requirement-status/events", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadStatusQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid requirement status event query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const headerSequence = Number(request.headers["last-event-id"] ?? 0) || 0;
    let cursor = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const afterSequence = cursor;
    const sse = openSseChannel(request, reply);
    const send = (event: { sequence: number; type: string; payload: Record<string, unknown> }) => {
      const projected = sanitizeExplorerRequirementStatusEvent(store, thread, event as DomainEvent);
      if (!projected) return;
      cursor = projected.sequence;
      sse.send(projected.sequence, "requirement.status", projected.payload);
    };
    const unsubscribe = explorerThread.subscribeEvents(thread.id, send, afterSequence);
    sse.onClose(unsubscribe);
    cursor = Math.max(cursor, store.getLastEventSequence(thread.id));
    sse.ready(cursor, { afterSequence: cursor });
  });
}
