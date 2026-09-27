/**
 * 模块职责：Run 域的 11 条路由 —— 事件流、Run 列表与详情、Run 的执行线程详情、完成 / 取消 /
 *   暂停 / 恢复 / 追加指导 / 触发验证 / 读验证结果。
 *
 * 与 `routes/execution-threads.ts` 的区别（两个"线程"字数相同、语义不同）：本文件里的
 *   `ExecutionThread` **随一次 Run 生死**；那边的 `ProjectExecutionThread` 是项目常驻的。
 *
 * 维护提示：
 *   1) **Run 事件流只回放 `thread.journal`，不是 store 的 DomainEvent。** Run 的对外契约就是
 *      journal 序列；做遥测（telemetry）时是**读 store 重新投影**而不是读 journal 字段——
 *      journal 里没有 telemetry，它由 `projectRunThreadTelemetry` 这个投影函数从 revision/loop 现算。
 *   2) **`telemetry.updated` 帧的 id 必须传 null**（`sse.send(null, ...)`，代码里带原注释）：
 *      它不属于事件序列，给它一个 id 会把 Last-Event-ID 推到不存在的序号上，重连按它回放会丢事件。
 *      同时注意它只在 `newEntries.length === 0 && lastTelemetryKey !== null` 时发——即"没有新事件
 *      但遥测变了"才补一帧，首帧由 `stream.ready` 携带，不重复发。
 *   3) **验证是幂等的**：已有 VerificationRun 直接返回，不重跑（`/verify` 里那条 existing 短路）。
 *      重跑会覆盖已有的验证结论，这是不可逆的。
 *   4) `scheduler` / `verificationExecutor` 都可缺省，缺省时对应路由返回 **503**（不是 500）：
 *      这是"本实例没配这个能力"，属于服务不可用语义。
 *   5) 遥测投影 `projectRunThreadTelemetry` 已搬进 `projections/` 并改为普通 import；
 *      它此前是回调 dep（理由同 `routes/agent-loops.ts` 的第 4 条），现在不需要了。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentLoopRunner, MergeService, PipelineStore, PlanService, Scheduler, VerificationCommandExecutor, VerificationService } from "@pipeline-factory/domain";
import { guidanceBody } from "../schemas/runs.js";
import { loopEventsQuery } from "../schemas/agent-loops.js";
import { loopReasonBody, projectThreadParams } from "../schemas/common.js";
import { openSseChannel } from "../http/sse.js";
import { projectRunThreadTelemetry } from "../projections/run-telemetry.js";

export type RunRouteDeps = {
  store: PipelineStore;
  plans: PlanService;
  merger: MergeService;
  /** 可缺省：测试与只读实例不装调度器；缺省时控制类路由返回 503。 */
  scheduler?: Scheduler | undefined;
  /**
   * Run 的取消要**连带取消它名下仍在跑的 AgentLoop**（见 `/cancel` 里那段），所以这里需要控制器。
   * 类型只取 `cancel` 一个方法，是刻意的：本文件不暂停、不恢复 Loop —— **显式 deps 的价值就在于
   * 让"runs 依赖 loopController 到哪一步"在类型上就看得见**，而不是传整个 `Pick<..., "pause"|"resume"|"cancel">`。
   */
  loopController: Pick<AgentLoopRunner, "cancel">;
  verifier: VerificationService;
  /** 可缺省：缺省时 `/verify` 返回 503。 */
  verificationExecutor?: VerificationCommandExecutor | undefined;
};

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  const { store, plans, merger, scheduler, verifier, verificationExecutor, loopController } = deps;

  // Run SSE 只回放 ExecutionThread journal，并同时带上当前 Run/Thread 状态供 UI 更新按钮显隐。
  app.get("/api/v4/runs/:runId/events", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const query = loopEventsQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Run event query" });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const thread = store.getExecutionThread(run.executionThreadId);
    if (!thread) return reply.code(404).send({ error: "ExecutionThread not found" });
    const headerSequence = Number(request.headers["last-event-id"] ?? "0") || 0;
    const afterSequence = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const acceptsSse = query.data.format === "sse" || (request.headers.accept ?? "").includes("text/event-stream");
    if (!acceptsSse) return { items: thread.journal.filter((entry) => entry.sequence > afterSequence) };
    let cursor = afterSequence;
    let lastTelemetryKey: string | null = null;
    const sse = openSseChannel(request, reply, { poll: () => send() });
    const send = () => {
      const currentRun = store.getRun(run.id);
      const currentThread = currentRun ? store.getExecutionThread(currentRun.executionThreadId) : undefined;
      const projectedThread = currentRun && currentThread ? projectRunThreadTelemetry(store, currentRun, currentThread) : currentThread;
      const newEntries = projectedThread?.journal.filter((item) => item.sequence > cursor) ?? [];
      for (const entry of newEntries) {
        cursor = entry.sequence;
        sse.send(entry.sequence, "journal.entry", { runId: run.id, runStatus: currentRun?.status ?? null, threadState: projectedThread?.state ?? null, threadTelemetry: projectedThread?.telemetry ?? null, ...entry });
      }
      const telemetry = projectedThread?.telemetry ?? null;
      const telemetryKey = JSON.stringify(telemetry);
      // telemetry.updated 不属于事件序列，所以 id 传 null（不写 id 行）：否则 Last-Event-ID 会被
      // 推到一个并不存在的事件序号上，重连时按它回放会丢事件。
      if (telemetryKey !== lastTelemetryKey && newEntries.length === 0 && lastTelemetryKey !== null) sse.send(null, "telemetry.updated", { runId: run.id, threadTelemetry: telemetry });
      lastTelemetryKey = telemetryKey;
      return telemetry;
    };
    const initialTelemetry = send();
    sse.ready(cursor, { afterSequence: cursor, threadTelemetry: initialTelemetry });
  });

  app.post("/api/v4/runs/:runId/finish", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ exitReason: z.string().min(1).default("completed") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid run completion request" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.run(params.data.runId);
      return { run: await scheduler.finish(params.data.runId, body.data.exitReason, store.getProject(run.projectId)?.settings.hooks ?? {}) };
    }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be finished" }); }
  });

  app.post("/api/v4/runs/:runId/cancel", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = loopReasonBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid run cancellation request" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.run(params.data.runId);
      const cancellableStatuses = new Set(["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING", "BLOCKED"]);
      if (!cancellableStatuses.has(run.status)) throw new Error(`Run ${run.id} cannot be cancelled from ${run.status}`);
      const cancellableLoopStates = new Set(["CREATED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "RECOVERING"]);
      for (const loop of store.listAgentLoops(run.id).filter((item) => cancellableLoopStates.has(item.state))) await loopController.cancel(loop.id, body.data.reason);
      return { run: await scheduler.finish(run.id, "cancelled", store.getProject(run.projectId)?.settings.hooks ?? {}, body.data.reason) };
    } catch (error) { return reply.code(409).send({ code: "RUN_CANCEL_FAILED", error: error instanceof Error ? error.message : "Run cannot be cancelled" }); }
  });

  app.post("/api/v4/runs/:runId/pause", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.pause(params.data.runId);
      const thread = scheduler.thread(run.executionThreadId);
      return { run, thread: projectRunThreadTelemetry(store, run, thread) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be paused" });
    }
  });

  app.post("/api/v4/runs/:runId/resume", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.resume(params.data.runId);
      const thread = scheduler.thread(run.executionThreadId);
      return { run, thread: projectRunThreadTelemetry(store, run, thread) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be resumed" });
    }
  });

  app.post("/api/v4/runs/:runId/guidance", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = guidanceBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid user guidance" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const thread = scheduler.addGuidance(params.data.runId, body.data.content);
      const run = store.getRun(params.data.runId);
      return { thread: run ? projectRunThreadTelemetry(store, run, thread) : thread };
    }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Guidance cannot be added" }); }
  });

  app.post("/api/v4/runs/:runId/verify", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!verificationExecutor) return reply.code(503).send({ error: "Verification command executor is not configured" });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const existing = store.getVerificationRun(run.id);
    if (existing) return { verification: existing };
    try {
      const plan = plans.get(run.planId);
      const revision = plans.getRevision(plan.id, run.planRevision);
      const verification = await verifier.verify(run, revision, verificationExecutor);
      return { verification };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be verified" });
    }
  });

  app.get("/api/v4/runs/:runId/verification", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const verification = store.getVerificationRun(run.id);
    if (!verification) return reply.code(404).send({ error: "VerificationRun not found" });
    return { verification };
  });

  app.get("/api/v4/projects/:projectId/runs", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { items: store.listRuns().filter((run) => run.projectId === params.data.projectId) };
  });

  app.get("/api/v4/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const executionThread = store.getExecutionThread(run.executionThreadId);
    return { run: { ...run, agentLoops: store.listAgentLoops(run.id) }, executionThread: executionThread ? projectRunThreadTelemetry(store, run, executionThread) : null, verification: store.getVerificationRun(run.id) ?? null, mergeRequest: merger.findByRun(run.id) ?? null };
  });

  app.get("/api/v4/execution-threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.getExecutionThread(params.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExecutionThread not found" });
    const run = store.getRun(thread.runId);
    return { thread: run ? projectRunThreadTelemetry(store, run, thread) : thread };
  });
}
