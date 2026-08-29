import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  PlanService,
  MergeService,
  SqlitePipelineStore,
  Scheduler,
  ExplorerService,
  ExplorerThreadService,
  LifecycleHookRunner,
  LocalGitWorktreeAdapter,
  OpenAIModelGateway,
  CodexAppServerGateway,
  RegisteredCommandExecutor,
  ToolGateway,
  DurableToolRuntime,
  McpToolRegistry,
  PluginRegistry,
  ComputerUseBridge,
  StubModelGateway,
  RecoveryCoordinator,
  ExecutorAgent,
  ChangeProposalService,
  VerificationService,
  mapCodexRateLimits,
  type PipelineStore,
  type HookDefinition,
  type PlanStatus,
  type VerificationCommandExecutor,
  type VerificationRun,
  type ModelGateway,
  type ModelRole,
  type AgentLoop,
  type AgentLoopRunner,
  type PlanContract,
} from "@pipeline-factory/domain";
import { projectExplorerActivity } from "@pipeline-factory/domain";
import { z } from "zod";
import type { FactoryConfig } from "./config.js";

const planIdParams = z.object({ planId: z.string().min(1) });
const projectThreadParams = z.object({ projectId: z.string().min(1) });
const projectExplorerParams = z.object({ projectId: z.string().min(1), explorerId: z.string().min(1) });
const explorerCreateBody = z.object({ title: z.string().trim().min(1).max(200).optional(), originThreadId: z.string().min(1).optional() });
const explorerRenameBody = z.object({ title: z.string().trim().min(1).max(200) });
const explorerActivityQuery = z.object({ afterSequence: z.coerce.number().int().nonnegative().optional() });
const threadPlanQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["queued_at", "last_event_at"]).default("queued_at"),
});
const actorBody = z.object({ actorId: z.string().min(1).default("local-user") });
const turnBody = z.object({ threadId: z.string().min(1).optional(), content: z.string().trim().min(1).max(20_000) });
const v4TurnBody = z.object({ threadId: z.string().min(1), content: z.string().trim().min(1).max(20_000), clientTurnId: z.string().min(1).max(200) });
const v4AnswerBody = z.object({ clientRequestId: z.string().min(1).max(200), answers: z.record(z.object({ answers: z.array(z.string().max(20_000)).min(1) })), actorId: z.string().min(1).default("local-user") });
const v4ThreadQuery = z.object({ threadId: z.string().min(1).optional(), afterSequence: z.coerce.number().int().nonnegative().optional() });
const loopEventsQuery = z.object({ format: z.enum(["json", "sse"]).optional(), afterSequence: z.coerce.number().int().nonnegative().optional() });
const v4InputQuery = z.object({ threadId: z.string().min(1).optional(), status: z.enum(["OPEN", "SUBMITTING", "ANSWERED", "CANCELLED", "AUTO_RESOLVED", "RECOVERY_REQUIRED"]).optional() });
const candidateBody = z.object({ threadId: z.string().min(1).optional(), title: z.string().trim().min(1).max(200) });
const hookBody = z.object({
  start: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() })
    .optional(),
  cleanup: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() })
    .optional(),
});
const guidanceBody = z.object({ content: z.string().trim().min(1).max(20_000) });
const sourceCommitBody = z.object({ sourceCommit: z.string().trim().min(1).max(200) });
const targetCommitBody = z.object({ targetCommit: z.string().trim().min(1).max(200) });
const changeProposalBody = z.object({ reason: z.string().trim().min(1).max(4_000), requestedChanges: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50), contract: z.record(z.unknown()), createdBy: z.string().min(1).default("executor") });
const agentLoopParams = z.object({ loopId: z.string().min(1) });
const loopReasonBody = z.object({ reason: z.string().trim().min(1).max(500).default("user_requested") });

type ProjectHookConfig = { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined };

export type PipelineAppOptions = {
  store?: PipelineStore;
  config?: FactoryConfig;
  model?: ModelGateway;
  databasePath?: string;
  scheduler?: Scheduler | undefined;
  verificationExecutor?: VerificationCommandExecutor | undefined;
  mergeService?: MergeService | undefined;
  agentLoopController?: Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> | undefined;
  seed?: boolean;
  mcpRegistry?: McpToolRegistry;
  pluginRegistry?: PluginRegistry;
  computerUse?: ComputerUseBridge;
};

export function createApp(options: PipelineAppOptions = {}): FastifyInstance {
  const ownsStore = !options.store;
  const store = options.store ?? new SqlitePipelineStore(options.databasePath ?? options.config?.storage.databasePath ?? "pipeline-factory.sqlite");
  new RecoveryCoordinator(store).recover();
  const plans = new PlanService(store);
  const explorers = new ExplorerService(store);
  const changeProposals = new ChangeProposalService(store);
  const verifier = new VerificationService(store);
  const merger = options.mergeService ?? new MergeService(store);
  const verificationExecutor = options.verificationExecutor ?? (options.config ? createDefaultVerificationExecutor(options.config) : undefined);
  const ownsModel = !options.model;
  const model = options.model ?? (options.config ? createModelGateway(options.config) : new StubModelGateway({ explorer: { model: "stub-explorer", temperature: 0.1 }, executor: { model: "stub-executor", temperature: 0 } }));
  const mcpRegistry = options.mcpRegistry ?? (options.config ? new McpToolRegistry(options.config.mcp.servers) : undefined);
  const pluginRegistry = options.pluginRegistry ?? (options.config ? new PluginRegistry({ supportedApiMajor: options.config.plugins.supportedApiMajor }) : undefined);
  const explorer = new ExplorerThreadService(store, model, {
    maxAutoContinuationTurns: options.config?.runtime.maxAutoContinuationTurns,
    maxSteps: options.config?.model.loop.maxSteps,
    maxDurationMs: options.config?.model.loop.maxDurationMs,
    maxRepeatedToolCalls: options.config?.model.loop.maxRepeatedToolCalls,
    maxNoProgressSteps: options.config?.model.loop.maxNoProgressSteps,
  });
  const scheduler = options.scheduler ?? (options.config ? createDefaultScheduler(store, options.config, model, mcpRegistry, pluginRegistry, options.computerUse) : undefined);
  const schedulerLoopController = scheduler?.agentLoopController();
  const loopController: Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> = options.agentLoopController ?? {
    pause: async (loopId, reason) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.pauseLoop(loopId, reason);
      if (schedulerLoopController) return schedulerLoopController.pause(loopId, reason);
      return persistLoopControl(store, loop, "PAUSED", reason);
    },
    resume: async (loopId) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.resumeLoop(loopId);
      if (schedulerLoopController) return schedulerLoopController.resume(loopId);
      return persistLoopControl(store, loop, "RUNNING", "user_resumed");
    },
    cancel: async (loopId, reason) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.cancelLoop(loopId, reason);
      if (schedulerLoopController) return schedulerLoopController.cancel(loopId, reason);
      return persistLoopControl(store, loop, "CANCELLED", reason);
    },
  };
  const hookConfigs = new Map<string, ProjectHookConfig>();

  if (options.seed !== false && !store.getThread("thread-demo")) {
    plans.registerThread({ id: "thread-demo", projectId: "project-demo", parentThreadId: null });
  }

  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });
  app.addHook("onClose", async () => {
    if (ownsStore && "close" in store && typeof store.close === "function") store.close();
    if (ownsModel && "close" in model && typeof model.close === "function") await model.close();
    if (!options.mcpRegistry) await mcpRegistry?.close();
  });

  app.get("/health", async () => ({ status: "ok", service: "pipeline-factory-api", version: "v4", modelBackend: options.config?.model.backend ?? "stub", model: model.configFor("explorer").model }));

  app.get("/api/v4/codex/rate-limits", async () => {
    const rateLimits = model.readRateLimits ? await model.readRateLimits().catch(() => mapCodexRateLimits(null)) : mapCodexRateLimits(null);
    return { rateLimits };
  });

  app.get("/api/v4/mcp/tools", async (request, reply) => {
    if (!mcpRegistry) return { tools: [] };
    try {
      return { tools: await mcpRegistry.discover() };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "MCP discovery failed" });
    }
  });

  app.get("/api/v4/plugins/tools", async (request, reply) => {
    if (!pluginRegistry) return { tools: [] };
    try {
      if (options.config?.plugins.directories.length) await pluginRegistry.discover(options.config.plugins.directories);
      return { tools: pluginRegistry.listTools() };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Plugin discovery failed" });
    }
  });

  app.get("/api/v4/agent-loops/:loopId", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    return { loop };
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
    const afterSequence = query.data.afterSequence ?? headerSequence;
    const acceptsSse = query.data.format === "sse" || (request.headers.accept ?? "").includes("text/event-stream");
    if (!acceptsSse) return { items: store.listEvents({ aggregateId: params.data.loopId, afterSequence }) };
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let cursor = afterSequence;
    const send = () => {
      const events = store.listEvents({ aggregateId: params.data.loopId, afterSequence: cursor });
      for (const event of events) {
        cursor = event.sequence;
        raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ loopId: params.data.loopId, sequence: event.sequence, ...event.payload })}\n\n`);
      }
    };
    send();
    raw.write(`id: ${cursor}\nevent: stream.ready\ndata: ${JSON.stringify({ afterSequence: cursor })}\n\n`);
    const poll = setInterval(send, 250);
    const heartbeat = setInterval(() => raw.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    const cleanup = () => { clearInterval(poll); clearInterval(heartbeat); };
    request.raw.once("close", cleanup);
  });

  app.post("/api/v4/agent-loops/:loopId/pause", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    const body = loopReasonBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid pause request" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const paused = await loopController.pause(loop.id, body.data.reason);
      return { loop: paused };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be paused" }); }
  });

  app.post("/api/v4/agent-loops/:loopId/resume", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const resumed = await loopController.resume(loop.id);
      return { loop: resumed };
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
      return { loop: cancelled };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be cancelled" }); }
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/agent-loops", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Agent Loop query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const turnIds = new Set(store.listTurns(thread.id).map((turn) => turn.id));
    return { items: store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId)) };
  });

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

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/archive", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { explorer: explorers.archive(explorer.id) };
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

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/activity", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = explorerActivityQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer activity query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const turns = store.listTurns(explorer.id);
    const turnIds = new Set(turns.map((turn) => turn.id));
    const loops = store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId));
    const loopIds = new Set(loops.map((loop) => loop.id));
    const steps = loops.flatMap((loop) => store.listAgentLoopSteps(loop.id)).filter((step) => loopIds.has(step.loopId));
    const items = projectExplorerActivity({ turns, loops, steps }).filter((item) => !query.data.afterSequence || item.sequence > query.data.afterSequence);
    return { items, lastEventSequence: store.getLastEventSequence(explorer.id) };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer plan query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    const rows = plans
      .listThreadPlans(explorer.id)
      .filter((row) => !statuses?.length || statuses.includes(row.status))
      .filter((row) => !query.data.q || `${row.planId} ${row.title}`.toLowerCase().includes(query.data.q.toLowerCase()))
      .sort((a, b) => query.data.sort === "last_event_at" ? b.lastEventAt.localeCompare(a.lastEventAt) : b.queuedAt.localeCompare(a.queuedAt))
      .slice(0, query.data.limit);
    return { items: rows, nextCursor: null };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/candidate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const candidate = store.listPlans().filter((plan) => plan.sourceExplorerThreadId === explorer.id && plan.queuedAt === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!candidate) return reply.code(404).send({ error: "Candidate plan not found" });
    return { plan: candidate };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/candidate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const body = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Candidate plan title is required" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return reply.code(201).send({ plan: plans.createCandidatePlan({ projectId: explorer.projectId, sourceExplorerThreadId: explorer.id, title: body.data.title }) });
  });

  app.get("/api/v3/projects/:projectId/explorer-thread", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && item.parentThreadId === null);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    return { thread };
  });

  app.get("/api/v3/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && item.parentThreadId === null);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    return { items: store.listTurns(thread.id) };
  });

  app.post("/api/v3/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = turnBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid ExplorerThread turn" });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && (body.data.threadId ? item.id === body.data.threadId : item.parentThreadId === null));
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try { return { turn: await explorer.send(thread.id, body.data.content) }; }
    catch (error) { if (error instanceof Error && error.message === "STRUCTURED_INPUT_REQUIRES_V4") return reply.code(409).send({ error: error.message }); throw error; }
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = v4TurnBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid v4 ExplorerThread turn" });
    const thread = findProjectThread(store, params.data.projectId, body.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try {
      const accepted = await explorer.startTurn(body.data);
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
    return { items: store.listTurns(thread.id), lastEventSequence: store.getLastEventSequence(thread.id) };
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/input-requests", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4InputQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid v4 input request query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    return { items: store.listInputRequests(thread.id, query.data.status) };
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/input-requests/:requestId/answer", async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1), requestId: z.string().min(1) }).safeParse(request.params);
    const body = v4AnswerBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "clientRequestId and answers are required" });
    const inputRequest = store.getInputRequest(params.data.requestId);
    const thread = inputRequest ? findProjectThread(store, params.data.projectId, inputRequest.threadId) : undefined;
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try { const result = await explorer.answerInput({ threadId: thread.id, requestId: params.data.requestId, answers: body.data.answers, clientRequestId: body.data.clientRequestId, actorId: body.data.actorId }); return result; }
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
    try { return { turn: await explorer.cancelTurn({ threadId: thread.id, turnId: params.data.turnId, reason: body.data.reason }) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Turn cannot be cancelled" }); }
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/events", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid v4 event query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    const headerSequence = Number(request.headers["last-event-id"] ?? 0) || 0;
    let cursor = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const afterSequence = cursor;
    const send = (event: { sequence: number; type: string; payload: Record<string, unknown> }) => { cursor = event.sequence; const type = event.type.startsWith("explorer.") ? event.type.slice("explorer.".length) : event.type; raw.write(`id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event.payload)}\n\n`); };
    const unsubscribe = explorer.subscribeEvents(thread.id, send, afterSequence);
    raw.write(`id: ${cursor}\nevent: stream.ready\ndata: ${JSON.stringify({ afterSequence: cursor })}\n\n`);
    const heartbeat = setInterval(() => raw.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    request.raw.once("close", cleanup);
  });

  app.post("/api/v3/projects/:projectId/explorer-thread/candidate", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = candidateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid candidate plan" });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && (body.data.threadId ? item.id === body.data.threadId : item.parentThreadId === null));
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    return { plan: plans.createCandidatePlan({ projectId: params.data.projectId, sourceExplorerThreadId: thread.id, title: body.data.title }) };
  });

  app.get("/api/v3/projects/:projectId/explorer-thread/plans", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid plan query" });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && item.parentThreadId === null);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    const rows = plans
      .listThreadPlans(thread.id)
      .filter((row) => !statuses?.length || statuses.includes(row.status))
      .filter((row) => !query.data.q || `${row.planId} ${row.title}`.toLowerCase().includes(query.data.q.toLowerCase()))
      .sort((a, b) => query.data.sort === "last_event_at" ? b.lastEventAt.localeCompare(a.lastEventAt) : b.queuedAt.localeCompare(a.queuedAt))
      .slice(0, query.data.limit);
    return { items: rows, nextCursor: null };
  });

  app.get("/api/v3/projects/:projectId/explorer-thread/candidate", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.listThreads().find((item) => item.projectId === params.data.projectId && item.parentThreadId === null);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const candidate = store
      .listPlans()
      .filter((plan) => plan.sourceExplorerThreadId === thread.id && plan.queuedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!candidate) return reply.code(404).send({ error: "Candidate plan not found" });
    return { plan: candidate };
  });

  app.get("/api/v3/plans/:planId", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      const revision = store.getRevision(plan.id, plan.revision);
      return { plan, revision: revision ?? null };
    } catch {
      return reply.code(404).send({ error: "Plan not found" });
    }
  });

  app.post("/api/v3/plans/:planId/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid confirmation request" });
    try {
      return { plan: plans.confirm(params.data.planId, body.data.actorId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be confirmed" });
    }
  });

  app.post("/api/v3/plans/:planId/enqueue", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return { plan: plans.enqueue(params.data.planId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" });
    }
  });

  app.post("/api/v3/plans/:planId/run", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      return { run: await scheduler.start(plan.id, hookConfigs.get(plan.projectId) ?? {}) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be started" });
    }
  });

  app.post("/api/v4/runs/:runId/change-proposals", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = changeProposalBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid ChangeProposal" });
    try {
      const proposal = changeProposals.create({ runId: params.data.runId, reason: body.data.reason, requestedChanges: body.data.requestedChanges, contract: body.data.contract as unknown as PlanContract, createdBy: body.data.createdBy });
      return reply.code(201).send({ proposal });
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "ChangeProposal cannot be created" }); }
  });

  app.get("/api/v4/runs/:runId/change-proposals", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid run id" });
    if (!store.getRun(params.data.runId)) return reply.code(404).send({ error: "Run not found" });
    return { items: store.listChangeProposals(params.data.runId) };
  });

  app.post("/api/v4/change-proposals/:proposalId/approve", async (request, reply) => {
    const params = z.object({ proposalId: z.string().min(1) }).safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid ChangeProposal approval" });
    const proposal = store.getChangeProposal(params.data.proposalId);
    if (!proposal) return reply.code(404).send({ error: "ChangeProposal not found" });
    try {
      const plan = store.getPlan(proposal.planId);
      const approved = await changeProposals.approve(params.data.proposalId, body.data.actorId, scheduler ? (planId) => scheduler.start(planId, plan ? hookConfigs.get(plan.projectId) ?? {} : {}) : undefined);
      return { ...approved, plan: store.getPlan(approved.plan.id) ?? approved.plan };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "ChangeProposal cannot be approved" }); }
  });

  app.post("/api/v3/runs/:runId/finish", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ exitReason: z.string().min(1).default("completed") }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid run completion request" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try { return { run: await scheduler.finish(params.data.runId, body.data.exitReason, hookConfigs.get(scheduler.run(params.data.runId).projectId) ?? {}) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be finished" }); }
  });

  app.post("/api/v3/runs/:runId/pause", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.pause(params.data.runId);
      return { run, thread: scheduler.thread(run.executionThreadId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be paused" });
    }
  });

  app.post("/api/v3/runs/:runId/resume", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const run = scheduler.resume(params.data.runId);
      return { run, thread: scheduler.thread(run.executionThreadId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be resumed" });
    }
  });

  app.post("/api/v3/runs/:runId/guidance", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = guidanceBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid user guidance" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try { return { thread: scheduler.addGuidance(params.data.runId, body.data.content) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Guidance cannot be added" }); }
  });

  app.post("/api/v3/runs/:runId/verify", async (request, reply) => {
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

  app.get("/api/v3/runs/:runId/verification", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const verification = store.getVerificationRun(run.id);
    if (!verification) return reply.code(404).send({ error: "VerificationRun not found" });
    return { verification };
  });

  app.post("/api/v3/runs/:runId/merge-request", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = sourceCommitBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid merge request" });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const existing = merger.findByRun(run.id);
    if (existing) return { mergeRequest: existing };
    const verification = store.getVerificationRun(run.id);
    if (!verification) return reply.code(409).send({ error: "A passed VerificationRun is required" });
    try { return { mergeRequest: merger.createRequest(run, verification, body.data.sourceCommit) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be created" }); }
  });

  app.get("/api/v3/runs/:runId/merge-request", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const mergeRequest = merger.findByRun(run.id);
    if (!mergeRequest) return reply.code(404).send({ error: "MergeRequest not found" });
    return { mergeRequest };
  });

  app.post("/api/v3/merge-requests/:mergeRequestId/confirm-merged", async (request, reply) => {
    const params = z.object({ mergeRequestId: z.string().min(1) }).safeParse(request.params);
    const body = targetCommitBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid merge confirmation" });
    try { return { mergeRequest: merger.confirmMerged(params.data.mergeRequestId, body.data.targetCommit) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be confirmed" }); }
  });

  app.get("/api/v3/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { projectId: params.data.projectId, lifecycle: hookConfigs.get(params.data.projectId) ?? {} };
  });

  app.put("/api/v3/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = hookBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid hook configuration" });
    hookConfigs.set(params.data.projectId, body.data);
    return { projectId: params.data.projectId, lifecycle: body.data };
  });

  app.get("/api/v3/projects/:projectId/runs", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { items: store.listRuns().filter((run) => run.projectId === params.data.projectId) };
  });

  app.get("/api/v3/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return { run: { ...run, agentLoops: store.listAgentLoops(run.id) }, executionThread: store.getExecutionThread(run.executionThreadId) ?? null, verification: store.getVerificationRun(run.id) ?? null, mergeRequest: merger.findByRun(run.id) ?? null };
  });

  app.get("/api/v3/execution-threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.getExecutionThread(params.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExecutionThread not found" });
    return { thread };
  });

  return app;
}

function findProjectThread(store: PipelineStore, projectId: string, threadId?: string) {
  return store.listThreads().find((thread) => thread.projectId === projectId && (threadId ? thread.id === threadId : thread.parentThreadId === null));
}

function persistLoopControl(store: PipelineStore, loop: AgentLoop, state: AgentLoop["state"], reason: string): AgentLoop {
  const terminal = new Set<AgentLoop["state"]>(["BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "NEEDS_RECONCILIATION"]);
  if (terminal.has(loop.state)) throw new Error(`AgentLoop ${loop.id} is already ${loop.state}`);
  if (state === "RUNNING" && loop.state !== "PAUSED" && loop.state !== "RECOVERING") throw new Error(`AgentLoop ${loop.id} cannot be resumed from ${loop.state}`);
  if (state === "PAUSED" && loop.state !== "RUNNING" && loop.state !== "WAITING_FOR_INPUT") throw new Error(`AgentLoop ${loop.id} cannot be paused from ${loop.state}`);
  const updated = { ...loop, state, ...(state === "CANCELLED" ? { completedAt: store.now() } : {}), checkpointJson: JSON.stringify({ reason, stepCount: loop.stepCount }) };
  store.updateAgentLoop(updated);
  store.appendAgentLoopStep({ loopId: loop.id, stepType: state === "CANCELLED" ? "LOOP_COMPLETED" : state === "PAUSED" ? "LOOP_SUSPENDED" : "LOOP_RESUMED", status: state === "CANCELLED" ? "CANCELLED" : "RUNNING", payload: { reason } });
  store.appendEvent({ type: state === "CANCELLED" ? "agent.loop.cancelled" : state === "PAUSED" ? "agent.loop.paused" : "agent.loop.resumed", aggregateId: loop.id, payload: { reason } });
  return updated;
}

function createDefaultScheduler(store: PipelineStore, config: FactoryConfig, model: ModelGateway, mcpRegistry?: McpToolRegistry, pluginRegistry?: PluginRegistry, computerUse?: ComputerUseBridge): Scheduler {
  const definitions = readCommandDefinitions(config);
  const commands = new RegisteredCommandExecutor(definitions);
  const registeredCommandIds = new Set(definitions.map((definition) => definition.commandId));
  const mcpAllowedTools = new Set(config.mcp.servers.flatMap((server) => server.allowedTools.map((tool) => "mcp:" + server.name + ":" + tool)));
  return new Scheduler({
    store,
    workspace: new LocalGitWorktreeAdapter({ projectRoot: config.project.root, worktreeRoot: config.storage.worktreeRoot }),
    hooks: new LifecycleHookRunner(commands.execute.bind(commands), { cleanupCwd: config.project.root }),
    executor: new ExecutorAgent(store, model, undefined, {
      maxSteps: config.model.loop.maxSteps,
      maxDurationMs: config.model.loop.maxDurationMs,
      maxRepeatedToolCalls: config.model.loop.maxRepeatedToolCalls,
      maxNoProgressSteps: config.model.loop.maxNoProgressSteps,
      toolRuntimeFactory: (run) => new DurableToolRuntime(store, new ToolGateway({
        role: "executor",
        workspaceRoot: run.workspacePath!,
        registeredCommandIds,
        mcpAllowedTools,
        pluginAllowedTools: new Set(config.plugins.allowedTools),
        computerUseAllowed: config.computerUse.enabled && Boolean(computerUse),
        builtin: {
          registeredCommandExecutor: (invocation) => commands.execute({
            ...invocation,
            context: {
              ...invocation.context,
              projectId: run.projectId,
              runId: run.id,
              workspacePath: run.workspacePath!,
              branch: run.branch,
              baseCommit: run.baseCommit,
            },
          }),
          ...(mcpRegistry ? { mcpToolExecutor: (name: string, input: Record<string, unknown>) => mcpRegistry.call(name, input) } : {}),
          ...(pluginRegistry ? { pluginToolExecutor: (name: string, input: Record<string, unknown>) => pluginRegistry.bridge.call(name, input) } : {}),
          ...(computerUse ? {
            computerUseExecutor: (input: Record<string, unknown>) => computerUse.call({
              action: input.action as import("@pipeline-factory/domain").ComputerUseAction,
              ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
              ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
            }),
          } : {}),
        },
      })),
    }),
  });
}

function createDefaultVerificationExecutor(config: FactoryConfig): VerificationCommandExecutor {
  const commands = new RegisteredCommandExecutor(readCommandDefinitions(config));
  return (commandId, run) => {
    if (!run.workspacePath) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Run workspace is not available" });
    return commands.execute({ commandId, cwd: run.workspacePath, timeoutMs: 120_000, context: { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit, exitReason: "verification" } });
  };
}

function readCommandDefinitions(config: FactoryConfig): Array<{ commandId: string; argv: readonly [string, ...string[]]; environment?: Readonly<Record<string, string>> | undefined }> {
  return config.project.commands.flatMap((command) => command.argv.length > 0 ? [{ commandId: command.commandId, argv: [command.argv[0]!, ...command.argv.slice(1)] as readonly [string, ...string[]], environment: command.environment }] : []);
}

function createModelGateway(config: FactoryConfig): ModelGateway {
  const roles = config.model.roles as Record<ModelRole, { model: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string; loopMode?: "provider-controlled" | "factory-controlled" }>;
  if (config.model.backend === "stub") return new StubModelGateway(roles);
  if (config.model.backend === "openai-responses") {
    const openai = config.model.openai;
    if (!openai?.apiKey) throw new Error("Factory configuration requires model.openai.apiKey for openai-responses backend");
    return new OpenAIModelGateway({ apiKey: openai.apiKey, roles, ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}) });
  }
  const appServer = config.model.codexAppServer;
  if (!appServer) throw new Error("Factory configuration requires model.codexAppServer for codex-app-server backend");
  return new CodexAppServerGateway({ roles, command: appServer.command, args: appServer.args, cwd: appServer.cwd, startupTimeoutMs: appServer.startupTimeoutMs, requestTimeoutMs: appServer.requestTimeoutMs, maxRestarts: appServer.maxRestarts, clientName: appServer.clientName, clientVersion: appServer.clientVersion });
}
