/**
 * 模块职责：**项目级**执行线程的 5 条路由 —— 读快照、改偏好、发消息、取消消息、事件流。
 *
 * 与 `routes/runs.ts` 里那几条的区别（这个区分容易混，写清楚）：本文件操作的是**项目常驻的
 *   一条对话线程**（`ProjectExecutionThread`，每个项目一条，随项目存活）；runs.ts 操作的是
 *   **一次 Run 的执行线程**（`ExecutionThread`，随 Run 生死）。两者都叫"线程"但生命周期完全不同。
 *
 * 维护提示：
 *   1) **每条路由都要自己把领域错误码映射成 HTTP 状态**，且映射表各不相同：
 *      `preferences` 是 `PROJECT_NOT_FOUND`→404 其余→422；`turns` 是 404 / `PROJECT_ARCHIVED`
 *      →409 / 其余→400；`cancel` 是 404 或 409。**不要"统一"这些映射**——它们反映的是各操作
 *      真实的语义差别（改配置不合法是 422，往归档项目发消息是 409 状态冲突）。注意这些路由
 *      都返回 `{ code: message, error: message }`，code 直接透传领域错误码字符串。
 *   2) **事件流先取 threadId 再开通道**：`projectExecution.get()` 抛错时要在 `openSseChannel`
 *      之前返回 404——hijack 之后 reply 就不能用了（见 http/sse.ts 维护提示 1）。
 *   3) 事件流的分帧事件名固定为 `project.execution`（不是事件自身的 type），type 放在 payload 里。
 *      前端监听的是 `project.execution`，改这个字面量会静默让前端收不到更新。
 *   4) 游标取 `max(query.afterSequence, Last-Event-ID)`：断线重连靠头部对齐，显式传参优先。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PipelineStore, ProjectExecutionThreadService } from "@pipeline-factory/domain";
import { projectExecutionEventsQuery, projectExecutionPreferencesBody, projectExecutionTurnBody } from "../schemas/execution-threads.js";
import { projectThreadParams } from "../schemas/common.js";
import { openSseChannel } from "../http/sse.js";

export type ExecutionThreadRouteDeps = {
  store: PipelineStore;
  projectExecution: ProjectExecutionThreadService;
};

export function registerExecutionThreadRoutes(app: FastifyInstance, deps: ExecutionThreadRouteDeps): void {
  const { store, projectExecution } = deps;

  app.get("/api/v4/projects/:projectId/execution-thread", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const snapshot = projectExecution.get(params.data.projectId);
      return { ...snapshot, events: store.listEvents({ aggregateId: snapshot.thread.id }) };
    } catch (error) {
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: error instanceof Error ? error.message : "Project not found" });
    }
  });

  app.patch("/api/v4/projects/:projectId/execution-thread/preferences", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectExecutionPreferencesBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid project execution preferences" });
    try {
      return { thread: projectExecution.updatePreferences(params.data.projectId, body.data) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid project execution preferences";
      const status = message === "PROJECT_NOT_FOUND" ? 404 : 422;
      return reply.code(status).send({ code: message, error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/execution-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectExecutionTurnBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid project execution turn" });
    try {
      return projectExecution.submit(params.data.projectId, body.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project execution turn cannot be submitted";
      const status = message === "PROJECT_NOT_FOUND" ? 404 : message === "PROJECT_ARCHIVED" ? 409 : 400;
      return reply.code(status).send({ code: message, error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/execution-thread/turns/:messageId/cancel", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1), messageId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid project execution cancel request" });
    try {
      const message = await projectExecution.cancel(params.data.projectId, params.data.messageId);
      return { message };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project execution turn cannot be cancelled";
      return reply.code(message === "PROJECT_NOT_FOUND" ? 404 : 409).send({ code: message, error: message });
    }
  });

  app.get("/api/v4/projects/:projectId/execution-thread/events", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = projectExecutionEventsQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid project execution event query" });
    let threadId: string;
    try {
      threadId = projectExecution.get(params.data.projectId).thread.id;
    } catch (error) {
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: error instanceof Error ? error.message : "Project not found" });
    }
    const headerSequence = Number(request.headers["last-event-id"] ?? "0") || 0;
    let cursor = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const sse = openSseChannel(request, reply, { poll: () => send() });
    const send = () => {
      const events = store.listEvents({ aggregateId: threadId, afterSequence: cursor });
      for (const event of events) {
        cursor = event.sequence;
        sse.send(event.sequence, "project.execution", { sequence: event.sequence, type: event.type, payload: event.payload });
      }
    };
    send();
    sse.ready(cursor, { afterSequence: cursor });
  });
}
