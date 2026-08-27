import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  PlanService,
  MergeService,
  SqlitePipelineStore,
  Scheduler,
  ExplorerThreadService,
  LifecycleHookRunner,
  LocalGitWorktreeAdapter,
  OpenAIModelGateway,
  CodexAppServerGateway,
  RegisteredCommandExecutor,
  StubModelGateway,
  VerificationService,
  type PipelineStore,
  type HookDefinition,
  type PlanStatus,
  type VerificationCommandExecutor,
  type VerificationRun,
  type ModelGateway,
  type ModelRole,
} from "@pipeline-factory/domain";
import { z } from "zod";
import type { FactoryConfig } from "./config.js";

const planIdParams = z.object({ planId: z.string().min(1) });
const projectThreadParams = z.object({ projectId: z.string().min(1) });
const threadPlanQuery = z.object({
  status: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["queued_at", "last_event_at"]).default("queued_at"),
});
const actorBody = z.object({ actorId: z.string().min(1).default("local-user") });
const turnBody = z.object({ threadId: z.string().min(1).optional(), content: z.string().trim().min(1).max(20_000) });
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

type ProjectHookConfig = { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined };

export type PipelineAppOptions = {
  store?: PipelineStore;
  config?: FactoryConfig;
  model?: ModelGateway;
  databasePath?: string;
  scheduler?: Scheduler | undefined;
  verificationExecutor?: VerificationCommandExecutor | undefined;
  mergeService?: MergeService | undefined;
  seed?: boolean;
};

export function createApp(options: PipelineAppOptions = {}): FastifyInstance {
  const ownsStore = !options.store;
  const store = options.store ?? new SqlitePipelineStore(options.databasePath ?? options.config?.storage.databasePath ?? "pipeline-factory.sqlite");
  const plans = new PlanService(store);
  const scheduler = options.scheduler ?? (options.config ? createDefaultScheduler(store, options.config) : undefined);
  const verifier = new VerificationService(store);
  const merger = options.mergeService ?? new MergeService(store);
  const verificationExecutor = options.verificationExecutor ?? (options.config ? createDefaultVerificationExecutor(options.config) : undefined);
  const verificationRuns = new Map<string, VerificationRun>();
  const ownsModel = !options.model;
  const model = options.model ?? (options.config ? createModelGateway(options.config) : new StubModelGateway({ explorer: { model: "stub-explorer", temperature: 0.1 }, executor: { model: "stub-executor", temperature: 0 } }));
  const explorer = new ExplorerThreadService(store, model);
  const hookConfigs = new Map<string, ProjectHookConfig>();

  if (options.seed !== false && !store.getThread("thread-demo")) {
    plans.registerThread({ id: "thread-demo", projectId: "project-demo", parentThreadId: null });
    plans.createCandidatePlan({ projectId: "project-demo", sourceExplorerThreadId: "thread-demo", title: "Build ExplorerThread workspace" });
  }

  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });
  app.addHook("onClose", async () => {
    if (ownsStore && "close" in store && typeof store.close === "function") store.close();
    if (ownsModel && "close" in model && typeof model.close === "function") await model.close();
  });

  app.get("/health", async () => ({ status: "ok", service: "pipeline-factory-api", version: "v3", modelBackend: options.config?.model.backend ?? "stub" }));

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
    return { turn: await explorer.send(thread.id, body.data.content) };
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
    const existing = verificationRuns.get(run.id);
    if (existing) return { verification: existing };
    try {
      const plan = plans.get(run.planId);
      const revision = plans.getRevision(plan.id, run.planRevision);
      const verification = await verifier.verify(run, revision, verificationExecutor);
      verificationRuns.set(run.id, verification);
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
    const verification = verificationRuns.get(run.id);
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
    const verification = verificationRuns.get(run.id);
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
    return { run, executionThread: store.getExecutionThread(run.executionThreadId) ?? null, verification: verificationRuns.get(run.id) ?? null, mergeRequest: merger.findByRun(run.id) ?? null };
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

function createDefaultScheduler(store: PipelineStore, config: FactoryConfig): Scheduler {
  const definitions = readCommandDefinitions(config);
  const commands = new RegisteredCommandExecutor(definitions);
  return new Scheduler({
    store,
    workspace: new LocalGitWorktreeAdapter({ projectRoot: config.project.root, worktreeRoot: config.storage.worktreeRoot }),
    hooks: new LifecycleHookRunner(commands.execute.bind(commands), { cleanupCwd: config.project.root }),
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
  const roles = config.model.roles as Record<ModelRole, { model: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string }>;
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
