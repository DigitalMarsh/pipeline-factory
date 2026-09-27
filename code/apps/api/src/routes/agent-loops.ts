/**
 * 模块职责：Agent Loop 的 8 条路由 —— 读 Loop / 步骤 / 工具调用 / 事件流，暂停 / 恢复 / 取消，
 *   以及按 ExplorerThread 列出其下的 Loop。
 *
 * 维护提示：
 *   1) **三条控制路由（pause / resume / cancel）走的是 `loopController`，不是直接改 store。**
 *      控制器负责"通知正在跑的 Loop 停下来"这个跨进程动作，直接写库会让 Loop 继续跑下去却
 *      在库里显示已暂停。
 *   2) **事件流的 diagnostics 只在有新事件时才计算**（`if (events.length === 0) return;` 在原注释里）。
 *      Loop 静默期每 250ms 轮询一次，若每次都算诊断就是纯浪费——这条早返回是有意的，不是漏写。
 *   3) 非 SSE 请求返回 JSON（含 `diagnostics`），SSE 帧把 `diagnostics` 拼进**每个**事件的 payload
 *      而不是单独发一帧：前端在同一个 handler 里同时更新事件与诊断面板。改动这个形状要同步改前端。
 *   4) `loopResponse` / `diagnostics` / `findThread` 三个 deps 是函数：它们目前是组合根的顶层
 *      函数（`projectAgentLoopResponse` / `loopDiagnostics` / `findProjectThread`），方案 P5 才
 *      搬进 `projections/`。用回调注入是为了避免 route ↔ 组合根的类型环。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentLoop, AgentLoopDiagnostics, AgentLoopRunner, ExplorerThread, PipelineStore } from "@pipeline-factory/domain";
import { agentLoopParams, loopEventsQuery } from "../schemas/agent-loops.js";
import { loopReasonBody, projectThreadParams } from "../schemas/common.js";
import { v4ThreadQuery } from "../schemas/explorers.js";
import { openSseChannel } from "../http/sse.js";

export type AgentLoopRouteDeps = {
  store: PipelineStore;
  loopController: Pick<AgentLoopRunner, "pause" | "resume" | "cancel">;
  /** 读接口的 Loop 投影（含 diagnostics）。当前在组合根，P5 搬到 `projections/`。 */
  loopResponse: (loop: AgentLoop) => AgentLoop & { diagnostics: AgentLoopDiagnostics };
  /** 事件流的诊断投影。当前在组合根，P5 搬到 `projections/`。 */
  diagnostics: (loop: AgentLoop) => AgentLoopDiagnostics;
  /** 按项目 + 可选 threadId 定位 ExplorerThread。当前在组合根，P5 搬到 `projections/`。 */
  findThread: (projectId: string, threadId?: string) => ExplorerThread | undefined;
};

export function registerAgentLoopRoutes(app: FastifyInstance, deps: AgentLoopRouteDeps): void {
  const { store, loopController, loopResponse, diagnostics, findThread } = deps;

  app.get("/api/v4/agent-loops/:loopId", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    return { loop: loopResponse(loop) };
  });

  app.get("/api/v4/agent-loops/:loopId/steps", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    if (!store.getAgentLoop(params.data.loopId)) return reply.code(404).send({ error: "AgentLoop not found" });
    return { items: store.listAgentLoopSteps(params.data.loopId) };
  });

  app.get("/api/v4/agent-loops/:loopId/tools", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    if (!store.getAgentLoop(params.data.loopId)) return reply.code(404).send({ error: "AgentLoop not found" });
    return { items: store.listToolCalls(params.data.loopId) };
  });

  app.get("/api/v4/agent-loops/:loopId/events", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    const query = loopEventsQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Agent Loop event query" });
    if (!store.getAgentLoop(params.data.loopId)) return reply.code(404).send({ error: "AgentLoop not found" });
    const headerSequence = Number(request.headers["last-event-id"] ?? "0") || 0;
    const afterSequence = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const acceptsSse = query.data.format === "sse" || (request.headers.accept ?? "").includes("text/event-stream");
    if (!acceptsSse) {
      const current = store.getAgentLoop(params.data.loopId)!;
      return { items: store.listEvents({ aggregateId: params.data.loopId, afterSequence }), diagnostics: diagnostics(current) };
    }
    let cursor = afterSequence;
    const sse = openSseChannel(request, reply, { poll: () => send() });
    const send = () => {
      const events = store.listEvents({ aggregateId: params.data.loopId, afterSequence: cursor });
      // 无新事件时不计算诊断：轮询在 Loop 静默期不应产生任何读取。
      if (events.length === 0) return;
      const current = store.getAgentLoop(params.data.loopId);
      const loopDiagnostics = current ? diagnostics(current) : null;
      for (const event of events) {
        cursor = event.sequence;
        sse.send(event.sequence, event.type, { loopId: params.data.loopId, sequence: event.sequence, ...event.payload, diagnostics: loopDiagnostics });
      }
    };
    send();
    const readyLoop = store.getAgentLoop(params.data.loopId);
    sse.ready(cursor, { afterSequence: cursor, diagnostics: readyLoop ? diagnostics(readyLoop) : null });
  });

  app.post("/api/v4/agent-loops/:loopId/pause", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    const body = loopReasonBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid pause request" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const paused = await loopController.pause(loop.id, body.data.reason);
      return { loop: loopResponse(paused) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be paused" }); }
  });

  app.post("/api/v4/agent-loops/:loopId/resume", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const resumed = await loopController.resume(loop.id);
      return { loop: loopResponse(resumed) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be resumed" }); }
  });

  app.post("/api/v4/agent-loops/:loopId/cancel", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    const body = loopReasonBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid cancel request" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const cancelled = await loopController.cancel(loop.id, body.data.reason);
      return { loop: loopResponse(cancelled) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be cancelled" }); }
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/agent-loops", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Agent Loop query" });
    const thread = findThread(params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== thread.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    const turnIds = new Set(store.listTurns(thread.id).filter((turn) => turn.explorerPlanId === explorerPlan.id).map((turn) => turn.id));
    return { items: store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId)).map((loop) => loopResponse(loop)) };
  });
}
