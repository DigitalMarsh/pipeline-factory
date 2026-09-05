/**
 * 模块职责：组装 Fastify 应用、Project/Thread/Plan/Run 路由和 SSE 控制面。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { execFile, execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  PlanService,
  MergeService,
  localGitMergeInspector,
  SqlitePipelineStore,
  Scheduler,
  ExplorerService,
  ExplorerThreadService,
  ModelExplorerTitleGenerator,
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
  ProjectService,
  StubModelGateway,
  RecoveryCoordinator,
  ExecutorAgent,
  inspectWorkspaceScope,
  ChangeProposalService,
  VerificationService,
  PlanDispatchCoordinator,
  mapCodexRateLimits,
  type PipelineStore,
  type HookDefinition,
  type PlanStatus,
  type VerificationCommandExecutor,
  type VerificationRun,
  type ModelGateway,
  type ModelRole,
  type AgentLoop,
  type AgentLoopDiagnostics,
  type AgentLoopRunner,
  type PlanContract,
  type ProjectSettingsInput,
  type ProjectExecutionSnapshot,
} from "@pipeline-factory/domain";
import { projectAgentLoopDiagnostics, projectExplorerActivity } from "@pipeline-factory/domain";
import { z } from "zod";
import type { FactoryConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const planIdParams = z.object({ planId: z.string().min(1) });
const projectThreadParams = z.object({ projectId: z.string().min(1) });
const projectExplorerParams = z.object({ projectId: z.string().min(1), explorerId: z.string().min(1) });
const explorerCreateBody = z.object({ title: z.string().trim().min(1).max(200).optional(), originThreadId: z.string().min(1).optional() });
const explorerRenameBody = z.object({ title: z.string().trim().min(1).max(200) });
const explorerActivityQuery = z.object({ afterSequence: z.coerce.number().int().nonnegative().optional() });
const threadPlanQuery = z.object({
  explorerThreadId: z.string().min(1).optional(),
  includeLineage: z.preprocess((value) => value === "false" ? false : value === "true" ? true : value, z.boolean().default(true)),
  status: z.string().optional(),
  q: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["queued_at", "last_event_at", "priority", "status"]).default("queued_at"),
});
const workbenchQuery = z.object({
  projectId: z.string().min(1),
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  format: z.enum(["json", "sse"]).default("json"),
});
const actorBody = z.object({ actorId: z.string().min(1).default("local-user") });
const v4TurnBody = z.object({ threadId: z.string().min(1), content: z.string().trim().min(1).max(20_000), clientTurnId: z.string().min(1).max(200) });
const v4AnswerBody = z.object({ clientRequestId: z.string().min(1).max(200), answers: z.record(z.object({ answers: z.array(z.string().max(20_000)).min(1) })), actorId: z.string().min(1).default("local-user") });
const v4ThreadQuery = z.object({ threadId: z.string().min(1).optional(), afterSequence: z.coerce.number().int().nonnegative().optional() });
const loopEventsQuery = z.object({ format: z.enum(["json", "sse"]).optional(), afterSequence: z.coerce.number().int().nonnegative().optional() });
const v4InputQuery = z.object({ threadId: z.string().min(1).optional(), status: z.enum(["OPEN", "SUBMITTING", "ANSWERED", "CANCELLED", "AUTO_RESOLVED", "RECOVERY_REQUIRED"]).optional() });
const hookBody = z.object({
  start: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(), maxAttempts: z.number().int().min(1).max(5).optional() })
    .optional(),
  cleanup: z
    .object({ commandId: z.string().min(1), enabled: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(), maxAttempts: z.number().int().min(1).max(5).optional() })
    .optional(),
});
const guidanceBody = z.object({ content: z.string().trim().min(1).max(20_000) });
const sourceCommitBody = z.object({ sourceCommit: z.string().trim().min(1).max(200) });
const targetCommitBody = z.object({ targetCommit: z.string().trim().min(1).max(200) });
const changeProposalBody = z.object({ reason: z.string().trim().min(1).max(4_000), requestedChanges: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50), contract: z.record(z.unknown()), createdBy: z.string().min(1).default("executor") });
const agentLoopParams = z.object({ loopId: z.string().min(1) });
const loopReasonBody = z.object({ reason: z.string().trim().min(1).max(500).default("user_requested") });
const projectCreateBody = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200),
  shortName: z.string().trim().max(100).optional(),
  repoRoot: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
});
const projectUpdateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  shortName: z.string().trim().max(100).optional(),
  repoRoot: z.string().trim().min(1).optional(),
  defaultBranch: z.string().trim().min(1).optional(),
  worktreeRoot: z.string().trim().min(1).optional(),
  settings: z.record(z.unknown()).optional(),
  expectedConfigVersion: z.number().int().positive().optional(),
});
const projectValidateBody = z.object({ repoRoot: z.string().trim().min(1).optional() });
const projectSelectExplorerBody = z.object({ explorerId: z.string().trim().min(1) });

/** API 组装依赖；生产环境使用 SQLite/真实 Gateway，测试可注入内存 Store 和 Stub。 */
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

/**
 * 创建 Fastify API。所有 Project 相关路由通过同一组 Domain Service 访问数据，
 * 这样 HTTP 错误码与 Domain 状态约束保持一致，且不会在路由中隐式创建默认 Project。
 */
export function createApp(options: PipelineAppOptions = {}): FastifyInstance {
  const ownsStore = !options.store;
  const store = options.store ?? new SqlitePipelineStore(options.databasePath ?? options.config?.storage.databasePath ?? "pipeline-factory.sqlite");
  new RecoveryCoordinator(store).recover();
  const projects = new ProjectService(store);
  const plans = new PlanService(store, projects);
  const explorers = new ExplorerService(store);
  const changeProposals = new ChangeProposalService(store);
  const verifier = new VerificationService(store);
  const merger = options.mergeService ?? new MergeService(store, { git: localGitMergeInspector });
  const verificationExecutor = options.verificationExecutor ?? (options.config ? createDefaultVerificationExecutor(store, options.config) : undefined);
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
    cwdForProject: (projectId) => store.getProject(projectId)?.repoRoot,
    modelConfigForProject: (projectId) => store.getProject(projectId)?.settings.models.explorer,
    titleGenerator: new ModelExplorerTitleGenerator(model),
  });
  void explorer.backfillTitles();
  const scheduler = options.scheduler ?? (options.config ? createDefaultScheduler(store, options.config, model, mcpRegistry, pluginRegistry, options.computerUse) : undefined);
  const globalConcurrency = options.config?.runtime.globalConcurrency ?? scheduler?.globalConcurrency();
  const dispatchCoordinator = scheduler ? new PlanDispatchCoordinator({
    store,
    plans,
    scheduler,
    ...(globalConcurrency === undefined ? {} : { globalConcurrency }),
    ...(verificationExecutor ? { verify: (run, revision) => verifier.verify(run, revision, verificationExecutor) } : {}),
  }) : undefined;
  if (dispatchCoordinator) void dispatchCoordinator.wake();
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

  if (options.seed !== false && !store.getThread("thread-demo")) {
    plans.registerThread({ id: "thread-demo", projectId: "project-demo", parentThreadId: null });
  }
  if (options.config) {
    const projectRoot = options.config.project.root;
    const projectName = basename(projectRoot);
    const defaultBranch = detectDefaultBranch(projectRoot);
    projects.bootstrapLegacy({
      id: "project-demo",
        name: projectName,
        repoRoot: projectRoot,
        defaultBranch,
        worktreeRoot: options.config.storage.worktreeRoot,
        settings: {
        commands: options.config.project.commands.map((command) => ({ ...command, argv: command.argv as [string, ...string[]] })),
        concurrency: {
          maxParallelRuns: options.config.runtime.projectConcurrency,
          defaultTimeoutMs: options.config.runtime.defaultTimeoutMs,
          executionTimeoutMs: options.config.runtime.executionTimeoutMs,
          maxAutoContinuationTurns: options.config.runtime.maxAutoContinuationTurns,
          maxRepairAttempts: 2,
        },
        models: options.config.model.roles,
        toolPolicy: {
          allowedMcpTools: options.config.mcp.servers.flatMap((server) => server.allowedTools.map((tool) => `mcp:${server.name}:${tool}`)),
          allowedPluginTools: options.config.plugins.allowedTools,
          computerUseEnabled: options.config.computerUse.enabled,
        },
      },
    });
  }

  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });
  // 先做 Project 存在性和归档状态校验，再进入具体 handler；前端禁用按钮不能替代这一层保护。
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const match = path.match(/^\/api\/v[34]\/projects\/([^/]+)/);
    if (!match) return;
    const projectId = decodeURIComponent(match[1] ?? "");
    const project = store.getProject(projectId);
    if (!project) {
      return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${projectId} not found` });
    }
    if (project.status === "ARCHIVED" && request.method !== "GET" && !path.endsWith("/activate") && !path.endsWith("/validate-repository")) {
      return reply.code(409).send({ code: "PROJECT_ARCHIVED", error: `Project ${projectId} is archived` });
    }
  });
  const ensurePlanProject = (projectId: string, reply: FastifyReply, write = false) => {
    const project = store.getProject(projectId);
    if (!project) {
      reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${projectId} not found` });
      return null;
    }
    if (write && project?.status === "ARCHIVED") {
      reply.code(409).send({ code: "PROJECT_ARCHIVED", error: `Project ${projectId} is archived` });
      return null;
    }
    return project;
  };
  app.addHook("onClose", async () => {
    dispatchCoordinator?.dispose();
    if (ownsStore && "close" in store && typeof store.close === "function") store.close();
    if (ownsModel && "close" in model && typeof model.close === "function") await model.close();
    if (!options.mcpRegistry) await mcpRegistry?.close();
  });

  // Health 端点不挂在 /api/v4/projects 下，便于启动脚本在没有 Project 上下文时确认服务就绪。
  app.get("/health", async () => ({ status: "ok", service: "pipeline-factory-api", version: "v4", modelBackend: options.config?.model.backend ?? "stub", model: model.configFor("explorer").model }));

  // Project Catalog 和设置路由只负责 HTTP 输入/输出，具体版本、路径和归档规则由 ProjectService 决定。
  app.get("/api/v4/projects", async (request) => {
    const query = z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() }).safeParse(request.query ?? {});
    const list = query.success ? projects.list(query.data.status) : projects.list();
    return { items: list.map((project) => {
      const summary = projects.summary(project.id);
      return {
        ...project,
        summary: {
          currentExplorerThread: summary.currentExplorerThread,
          currentExplorerTitle: summary.currentExplorerThread ? store.getThread(summary.currentExplorerThread)?.title ?? null : null,
          threadCount: summary.threadCount,
          planCount: summary.planCount,
          runCount: summary.runCount,
          activeRunCount: summary.activeRunCount,
          needsAttentionCount: summary.needsAttentionCount,
          lastActivityAt: summary.lastActivityAt,
        },
      };
    }) };
  });

  app.post("/api/v4/projects", async (request, reply) => {
    const body = projectCreateBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const repository = await inspectGitRepository(body.data.repoRoot);
      const defaultBranch = body.data.defaultBranch ?? repository.defaultBranch;
      await assertGitBranch(repository.repoRoot, defaultBranch);
      const worktreeRoot = body.data.worktreeRoot ?? resolvePath(dirname(repository.repoRoot), `.${basename(repository.repoRoot)}-pipeline-worktrees`);
      let project = projects.create({
        ...(body.data.id ? { id: body.data.id } : {}),
        name: body.data.name,
        ...(body.data.shortName !== undefined ? { shortName: body.data.shortName } : {}),
        repoRoot: repository.repoRoot,
        defaultBranch,
        worktreeRoot,
        ...(body.data.settings ? { settings: body.data.settings as ProjectSettingsInput } : {}),
      });
      const existingExplorer = store.listThreads().find((thread) => thread.projectId === project.id && thread.state !== "ARCHIVED");
      const explorerThread = existingExplorer ?? plans.registerThread({ id: store.nextId("explorer"), projectId: project.id, parentThreadId: null, title: "New Explorer" });
      project = projects.selectExplorer(project.id, explorerThread.id);
      return reply.code(201).send({ project, explorer: explorerThread });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /Git repository|does not exist|absolute path/i.test(message) ? 422 : 409;
      return reply.code(status).send({ code: status === 422 ? "INVALID_GIT_REPOSITORY" : "PROJECT_CONFLICT", error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/validate-repository", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectValidateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid repository validation request" });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      const repository = await inspectGitRepository(body.data.repoRoot ?? project.repoRoot);
      return { valid: true, repoRoot: repository.repoRoot, defaultBranch: repository.defaultBranch };
    } catch (error) {
      return reply.code(422).send({ code: "INVALID_GIT_REPOSITORY", error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v4/projects/:projectId", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { project, summary: projects.summary(project.id) };
  });

  app.get("/api/v4/projects/:projectId/summary", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { summary: projects.summary(params.data.projectId) };
  });

  app.get("/api/v4/workbench", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench query" });
    if (!store.getProject(query.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${query.data.projectId} not found` });
    return workbenchSnapshot(store, projects, query.data.projectId);
  });

  app.get("/api/v4/workbench/events", async (request, reply) => {
    const query = workbenchQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "Invalid Workbench event query" });
    if (!store.getProject(query.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `PROJECT_NOT_FOUND: ${query.data.projectId}` });
    const eventsForProject = (afterSequence: number) => store.listEvents({ afterSequence }).filter((event) => eventBelongsToProject(store, event, query.data.projectId));
    if (query.data.format !== "sse") return { items: eventsForProject(query.data.afterSequence), cursor: store.getLastEventSequence() };
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let cursor = query.data.afterSequence;
    const send = () => {
      for (const event of eventsForProject(cursor)) {
        cursor = event.sequence;
        raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    send();
    raw.write(`id: ${cursor}\nevent: stream.ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
    const poll = setInterval(send, 250);
    const heartbeat = setInterval(() => raw.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    request.raw.once("close", () => { clearInterval(poll); clearInterval(heartbeat); });
  });

  app.patch("/api/v4/projects/:projectId", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectUpdateBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Project update request" });
    try {
      const project = projects.get(params.data.projectId);
      const repository = body.data.repoRoot ? await inspectGitRepository(body.data.repoRoot) : undefined;
      const defaultBranch = body.data.defaultBranch ?? (repository ? repository.defaultBranch : undefined);
      if (defaultBranch) await assertGitBranch(repository?.repoRoot ?? project.repoRoot, defaultBranch);
      const updated = projects.update(params.data.projectId, {
        ...(body.data.name ? { name: body.data.name } : {}),
        ...(body.data.shortName !== undefined ? { shortName: body.data.shortName } : {}),
        ...(repository ? { repoRoot: repository.repoRoot, ...(body.data.defaultBranch ? {} : { defaultBranch: repository.defaultBranch }) } : body.data.repoRoot ? { repoRoot: body.data.repoRoot } : {}),
        ...(body.data.defaultBranch ? { defaultBranch: body.data.defaultBranch } : {}),
        ...(body.data.worktreeRoot ? { worktreeRoot: body.data.worktreeRoot } : {}),
        ...(body.data.expectedConfigVersion ? { expectedConfigVersion: body.data.expectedConfigVersion } : {}),
        ...(body.data.settings ? { settings: body.data.settings as ProjectSettingsInput } : {}),
      });
      return { project: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /not found/i.test(message) ? "PROJECT_NOT_FOUND" : /configuration version conflict/i.test(message) ? "CONFIG_VERSION_CONFLICT" : /active runs/i.test(message) ? "PROJECT_HAS_ACTIVE_RUNS" : /Git repository|branch|does not exist|absolute path/i.test(message) ? "INVALID_GIT_REPOSITORY" : "PROJECT_UPDATE_FAILED";
      return reply.code(code === "INVALID_GIT_REPOSITORY" ? 422 : code === "PROJECT_NOT_FOUND" ? 404 : 409).send({ code, error: message });
    }
  });

  app.post("/api/v4/projects/:projectId/archive", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try { return { project: projects.archive(params.data.projectId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(/not found/i.test(message) ? 404 : 409).send({ code: /not found/i.test(message) ? "PROJECT_NOT_FOUND" : "PROJECT_HAS_ACTIVE_RUNS", error: message }); }
  });

  app.post("/api/v4/projects/:projectId/activate", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try { return { project: projects.activate(params.data.projectId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(/not found/i.test(message) ? 404 : 409).send({ code: /not found/i.test(message) ? "PROJECT_NOT_FOUND" : "PROJECT_ACTIVATION_FAILED", error: message }); }
  });

  app.post("/api/v4/projects/:projectId/select-explorer", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = projectSelectExplorerBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid Explorer selection request" });
    try { return { project: projects.selectExplorer(params.data.projectId, body.data.explorerId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(/Project .* not found/i.test(message) ? 404 : 409).send({ code: /Project .* not found/i.test(message) ? "PROJECT_NOT_FOUND" : "EXPLORER_SELECTION_FAILED", error: message }); }
  });

  app.get("/api/v4/projects/:projectId/config-history", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try { return { items: projects.configHistory(params.data.projectId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: message }); }
  });

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
    return { loop: projectAgentLoopResponse(store, loop) };
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

  // Agent Loop SSE 面向诊断和控制页；非 SSE 请求仍返回 JSON，方便测试和故障排查。
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
      return { items: store.listEvents({ aggregateId: params.data.loopId, afterSequence }), diagnostics: projectAgentLoopDiagnostics(current, store.listAgentLoopSteps(current.id)) };
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let cursor = afterSequence;
    const send = () => {
      const events = store.listEvents({ aggregateId: params.data.loopId, afterSequence: cursor });
      const current = store.getAgentLoop(params.data.loopId);
      const diagnostics = current ? projectAgentLoopDiagnostics(current, store.listAgentLoopSteps(current.id)) : null;
      for (const event of events) {
        cursor = event.sequence;
        raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ loopId: params.data.loopId, sequence: event.sequence, ...event.payload, diagnostics })}\n\n`);
      }
    };
    send();
    const readyLoop = store.getAgentLoop(params.data.loopId);
    raw.write(`id: ${cursor}\nevent: stream.ready\ndata: ${JSON.stringify({ afterSequence: cursor, diagnostics: readyLoop ? projectAgentLoopDiagnostics(readyLoop, store.listAgentLoopSteps(readyLoop.id)) : null })}\n\n`);
    const poll = setInterval(send, 250);
    const heartbeat = setInterval(() => raw.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    const cleanup = () => { clearInterval(poll); clearInterval(heartbeat); };
    request.raw.once("close", cleanup);
  });

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
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let cursor = afterSequence;
    const send = () => {
      const currentRun = store.getRun(run.id);
      const currentThread = currentRun ? store.getExecutionThread(currentRun.executionThreadId) : undefined;
      for (const entry of currentThread?.journal.filter((item) => item.sequence > cursor) ?? []) {
        cursor = entry.sequence;
        raw.write(`id: ${entry.sequence}\nevent: journal.entry\ndata: ${JSON.stringify({ runId: run.id, runStatus: currentRun?.status ?? null, threadState: currentThread?.state ?? null, ...entry })}\n\n`);
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
      return { loop: projectAgentLoopResponse(store, paused) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be paused" }); }
  });

  app.post("/api/v4/agent-loops/:loopId/resume", async (request, reply) => {
    const params = agentLoopParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid Agent Loop id" });
    const loop = store.getAgentLoop(params.data.loopId);
    if (!loop) return reply.code(404).send({ error: "AgentLoop not found" });
    try {
      const resumed = await loopController.resume(loop.id);
      return { loop: projectAgentLoopResponse(store, resumed) };
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
      return { loop: projectAgentLoopResponse(store, cancelled) };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "AgentLoop cannot be cancelled" }); }
  });

  app.get("/api/v4/projects/:projectId/explorer-thread/agent-loops", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = v4ThreadQuery.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Agent Loop query" });
    const thread = findProjectThread(store, params.data.projectId, query.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    const turnIds = new Set(store.listTurns(thread.id).map((turn) => turn.id));
    return { items: store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId)).map((loop) => projectAgentLoopResponse(store, loop)) };
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

  app.get("/api/v4/projects/:projectId/plans", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid project plan query" });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    try {
      const result = plans.query({
        projectId: params.data.projectId,
        includeLineage: query.data.includeLineage,
        limit: query.data.limit,
        sort: query.data.sort,
        ...(query.data.explorerThreadId ? { explorerThreadId: query.data.explorerThreadId } : {}),
        ...(statuses?.length ? { status: statuses } : {}),
        ...(query.data.q !== undefined ? { q: query.data.q } : {}),
        ...(query.data.from !== undefined ? { from: query.data.from } : {}),
        ...(query.data.to !== undefined ? { to: query.data.to } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      });
      return { items: decoratePlanRows(store, result.items), nextCursor: result.nextCursor };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid project plan query" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = threadPlanQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer plan query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const statuses = query.data.status?.split(",").filter(Boolean) as PlanStatus[] | undefined;
    try {
      const result = plans.query({
        projectId: params.data.projectId,
        explorerThreadId: explorer.id,
        includeLineage: query.data.includeLineage,
        limit: query.data.limit,
        sort: query.data.sort,
        ...(statuses?.length ? { status: statuses } : {}),
        ...(query.data.q !== undefined ? { q: query.data.q } : {}),
        ...(query.data.from !== undefined ? { from: query.data.from } : {}),
        ...(query.data.to !== undefined ? { to: query.data.to } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      });
      return { items: decoratePlanRows(store, result.items), nextCursor: result.nextCursor };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid Explorer plan query" });
    }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/candidate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const candidate = store.listPlans().filter((plan) => plan.sourceExplorerThreadId === explorer.id && plan.status === "DRAFT" && plan.queuedAt === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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

  // Explorer SSE 使用 Last-Event-ID 与数据库事件序列回放，断线重连不会丢失已持久化消息。
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

  app.get("/api/v4/plans/:planId", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const revision = store.getRevision(plan.id, plan.revision);
      return { plan, revision: revision ?? null, dispatch: dispatchCoordinator?.state(plan.id) ?? store.getDispatchState(plan.id) ?? null };
    } catch {
      return reply.code(404).send({ error: "Plan not found" });
    }
  });

  app.post("/api/v4/plans/:planId/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid confirmation request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: plans.confirm(params.data.planId, body.data.actorId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be confirmed" });
    }
  });

  app.post("/api/v4/plans/:planId/discard", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid discard request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: plans.discard(params.data.planId, body.data.actorId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be discarded";
      if (/not found/i.test(message)) return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" });
      return reply.code(409).send({ code: "PLAN_CANNOT_BE_DISCARDED", error: message });
    }
  });

  app.post("/api/v4/plans/:planId/enqueue", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (dispatchCoordinator) return await dispatchCoordinator.enqueue(params.data.planId);
      return { plan: plans.enqueue(params.data.planId), dispatch: null };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" });
    }
  });

  app.post("/api/v4/plans/:planId/run", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (dispatchCoordinator) {
        const dispatched = await dispatchCoordinator.enqueue(plan.id);
        return { run: dispatched.state.runId ? store.getRun(dispatched.state.runId) ?? null : null, dispatch: dispatched.state };
      }
      const project = store.getProject(plan.projectId);
      return { run: await scheduler.start(plan.id, project?.settings.hooks ?? {}), dispatch: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run cannot be started";
      return reply.code(409).send({ code: /concurrency limit/i.test(message) ? "PROJECT_CONCURRENCY_LIMIT" : /RUN_PREREQUISITES_UNSATISFIED/.test(message) ? "RUN_PREREQUISITES_UNSATISFIED" : "RUN_START_FAILED", error: message });
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
      const approved = await changeProposals.approve(params.data.proposalId, body.data.actorId);
      const dispatch = dispatchCoordinator ? await dispatchCoordinator.enqueue(approved.plan.id) : undefined;
      const dispatchedRun = dispatch?.state.runId
        ? store.getRun(dispatch.state.runId) ?? null
        : store.listRuns().filter((item) => item.planId === approved.plan.id && item.planRevision === approved.revision.revision).at(-1) ?? null;
      const run = dispatchedRun ?? approved.run;
      return { ...approved, plan: store.getPlan(approved.plan.id) ?? approved.plan, run };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "ChangeProposal cannot be approved" }); }
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
      return { run, thread: scheduler.thread(run.executionThreadId) };
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
      return { run, thread: scheduler.thread(run.executionThreadId) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Run cannot be resumed" });
    }
  });

  app.post("/api/v4/runs/:runId/guidance", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    const body = guidanceBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid user guidance" });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try { return { thread: scheduler.addGuidance(params.data.runId, body.data.content) }; }
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

  app.post("/api/v4/runs/:runId/merge-request", async (request, reply) => {
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

  app.get("/api/v4/runs/:runId/merge-request", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const run = store.getRun(params.data.runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const mergeRequest = merger.findByRun(run.id);
    if (!mergeRequest) return reply.code(404).send({ error: "MergeRequest not found" });
    return { mergeRequest };
  });

  app.get("/api/v4/merge-requests/:mergeRequestId", async (request, reply) => {
    const params = z.object({ mergeRequestId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const mergeRequest = merger.get(params.data.mergeRequestId);
    if (!mergeRequest) return reply.code(404).send({ error: "MergeRequest not found" });
    return { mergeRequest };
  });

  app.post("/api/v4/merge-requests/:mergeRequestId/confirm-merged", async (request, reply) => {
    const params = z.object({ mergeRequestId: z.string().min(1) }).safeParse(request.params);
    const body = targetCommitBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid merge confirmation" });
    try { return { mergeRequest: merger.confirmMerged(params.data.mergeRequestId, body.data.targetCommit) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "MergeRequest cannot be confirmed" }); }
  });

  app.get("/api/v4/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    return { projectId: params.data.projectId, lifecycle: store.getProject(params.data.projectId)?.settings.hooks ?? {} };
  });

  app.put("/api/v4/projects/:projectId/settings/hooks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = hookBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid hook configuration" });
    const project = store.getProject(params.data.projectId);
    if (project) {
      const lifecycle = {
        ...(body.data.start ? { start: { commandId: body.data.start.commandId, ...(body.data.start.enabled === undefined ? {} : { enabled: body.data.start.enabled }), ...(body.data.start.timeoutMs === undefined ? {} : { timeoutMs: body.data.start.timeoutMs }), ...(body.data.start.maxAttempts === undefined ? {} : { maxAttempts: body.data.start.maxAttempts }) } } : {}),
        ...(body.data.cleanup ? { cleanup: { commandId: body.data.cleanup.commandId, ...(body.data.cleanup.enabled === undefined ? {} : { enabled: body.data.cleanup.enabled }), ...(body.data.cleanup.timeoutMs === undefined ? {} : { timeoutMs: body.data.cleanup.timeoutMs }), ...(body.data.cleanup.maxAttempts === undefined ? {} : { maxAttempts: body.data.cleanup.maxAttempts }) } } : {}),
      };
      try {
        projects.update(params.data.projectId, { settings: { hooks: lifecycle } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(/active runs/i.test(message) ? 409 : 422).send({ code: /active runs/i.test(message) ? "PROJECT_HAS_ACTIVE_RUNS" : "HOOK_SETTINGS_INVALID", error: message });
      }
    }
    return { projectId: params.data.projectId, lifecycle: body.data };
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
    return { run: { ...run, agentLoops: store.listAgentLoops(run.id) }, executionThread: store.getExecutionThread(run.executionThreadId) ?? null, verification: store.getVerificationRun(run.id) ?? null, mergeRequest: merger.findByRun(run.id) ?? null };
  });

  app.get("/api/v4/execution-threads/:threadId", async (request, reply) => {
    const params = z.object({ threadId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const thread = store.getExecutionThread(params.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExecutionThread not found" });
    return { thread };
  });

  return app;
}

/** 在指定 Project 内解析 Thread；不允许用相同 Thread ID 跨 Project 访问数据。 */
function findProjectThread(store: PipelineStore, projectId: string, threadId?: string) {
  return store.listThreads().find((thread) => thread.projectId === projectId && (threadId ? thread.id === threadId : thread.parentThreadId === null));
}

/** 将 PlanRevision 的快照版本与当前 Project 对比，供 Plan Center 显示 CURRENT/CHANGED/LEGACY。 */
function decoratePlanRows(store: PipelineStore, rows: Array<{ planId: string; revision: number; projectId: string }>) {
  return rows.map((row) => {
    const revision = store.getRevision(row.planId, row.revision);
    const snapshot = revision?.projectConfigSnapshot;
    const project = store.getProject(row.projectId);
    return {
      ...row,
      projectConfigVersion: revision?.projectConfigVersion ?? null,
      projectConfigHash: revision?.projectConfigHash ?? null,
      projectConfigStatus: !snapshot ? "LEGACY" : project && snapshot.configVersion === project.configVersion && snapshot.configHash === project.configHash ? "CURRENT" : "CHANGED",
      dispatch: store.getDispatchState(row.planId) ?? null,
    };
  });
}

function workbenchSnapshot(store: PipelineStore, projects: ProjectService, projectId: string) {
  const project = projects.get(projectId);
  const projectRows = [{ ...project, summary: projects.summary(project.id) }];
  const plans = store.listPlans()
    .filter((plan) => plan.projectId === projectId)
    .filter((plan) => plan.status !== "DRAFT" && plan.status !== "DISCARDED")
    .map((plan) => ({
      planId: plan.id,
      title: plan.title,
      revision: plan.revision,
      status: plan.status,
      projectId: plan.projectId,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      sourceTurnId: plan.sourceTurnId,
      providerThreadId: plan.providerThreadId,
      providerTurnId: plan.providerTurnId,
      providerItemId: plan.providerItemId,
      createdAt: plan.createdAt,
      queuedAt: plan.queuedAt,
      runId: plan.runId,
      lastEventAt: plan.lastEventAt,
      attentionReason: plan.attentionReason,
      contract: plan.contract,
      dispatch: store.getDispatchState(plan.id) ?? null,
    }));
  const runs = store.listRuns().filter((run) => run.projectId === projectId).map((run) => ({
    ...run,
    planTitle: store.getPlan(run.planId)?.title ?? run.planId,
    dispatch: store.getDispatchState(run.planId) ?? null,
  }));
  const events = store.listEvents({ afterSequence: 0 }).filter((event) => eventBelongsToProject(store, event, projectId));
  return {
    activeProjectId: projectId,
    projects: projectRows,
    plans,
    runs,
    dispatchStates: store.listDispatchStates(projectId),
    events,
    cursor: store.getLastEventSequence(),
  };
}

function eventBelongsToProject(store: PipelineStore, event: import("@pipeline-factory/domain").DomainEvent, projectId: string): boolean {
  const payloadProjectId = event.payload.projectId;
  if (payloadProjectId === projectId) return true;
  const plan = store.getPlan(event.aggregateId);
  if (plan?.projectId === projectId) return true;
  const run = store.getRun(event.aggregateId);
  if (run?.projectId === projectId) return true;
  const thread = store.getThread(event.aggregateId);
  if (thread?.projectId === projectId) return true;
  const mergeRequest = store.getMergeRequest(event.aggregateId);
  if (mergeRequest && store.getRun(mergeRequest.runId)?.projectId === projectId) return true;
  const loop = store.getAgentLoop(event.aggregateId);
  if (loop?.ownerType === "run" && store.getRun(loop.ownerId)?.projectId === projectId) return true;
  if (loop?.ownerType === "explorer-turn") {
    const turn = store.listThreads().find((candidate) => store.listTurns(candidate.id).some((item) => item.id === loop.ownerId));
    if (turn?.projectId === projectId) return true;
  }
  return false;
}

/** canonicalize 并校验 Git 根目录；子目录、非 Git 目录和不可读路径均拒绝导入。 */
async function inspectGitRepository(inputPath: string): Promise<{ repoRoot: string; defaultBranch: string }> {
  const candidate = await realpath(resolvePath(inputPath));
  let gitRoot: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: candidate });
    gitRoot = await realpath(String(result.stdout).trim());
  } catch (error) {
    throw new Error(`Path is not a Git repository: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gitRoot !== candidate) throw new Error(`Path must be the Git repository root: ${gitRoot}`);
  let defaultBranch = "main";
  try {
    const result = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: gitRoot });
    const branch = String(result.stdout).trim();
    if (branch) defaultBranch = branch;
  } catch {
    try {
      const result = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitRoot });
      const branch = String(result.stdout).trim();
      if (branch && branch !== "HEAD") defaultBranch = branch;
    } catch { /* Detached or unavailable branch metadata keeps the safe default. */ }
  }
  return { repoRoot: gitRoot, defaultBranch };
}

async function assertGitBranch(repoRoot: string, branch: string): Promise<void> {
  const normalized = branch.trim();
  if (!normalized || normalized.startsWith("-") || normalized.includes("..")) throw new Error(`Invalid default branch ${branch}`);
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${normalized}`], { cwd: repoRoot });
  } catch {
    throw new Error(`Default branch ${normalized} does not exist in ${repoRoot}`);
  }
}

function detectDefaultBranch(repoRoot: string): string {
  try {
    const value = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return value || "main";
  } catch { return "main"; }
}

/** 在没有真实 Loop Controller 的测试/降级场景中持久化控制事实，并复用相同状态转换检查。 */
function persistLoopControl(store: PipelineStore, loop: AgentLoop, state: AgentLoop["state"], reason: string): AgentLoop {
  const terminal = new Set<AgentLoop["state"]>(["BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "NEEDS_RECONCILIATION"]);
  if (terminal.has(loop.state)) throw new Error(`AgentLoop ${loop.id} is already ${loop.state}`);
  if (state === "RUNNING" && loop.state !== "PAUSED") throw new Error(`AgentLoop ${loop.id} cannot be resumed from ${loop.state}`);
  if (state === "PAUSED" && loop.state !== "RUNNING") throw new Error(`AgentLoop ${loop.id} cannot be paused from ${loop.state}`);
  const updated = { ...loop, state, ...(state === "CANCELLED" ? { completedAt: store.now() } : {}), checkpointJson: JSON.stringify({ reason, stepCount: loop.stepCount }) };
  store.updateAgentLoop(updated);
  store.appendAgentLoopStep({ loopId: loop.id, stepType: state === "CANCELLED" ? "LOOP_COMPLETED" : state === "PAUSED" ? "LOOP_SUSPENDED" : "LOOP_RESUMED", status: state === "CANCELLED" ? "CANCELLED" : "RUNNING", payload: { reason } });
  store.appendEvent({ type: state === "CANCELLED" ? "agent.loop.cancelled" : state === "PAUSED" ? "agent.loop.paused" : "agent.loop.resumed", aggregateId: loop.id, payload: { reason } });
  return updated;
}

function projectAgentLoopResponse(store: PipelineStore, loop: AgentLoop): AgentLoop & { diagnostics: AgentLoopDiagnostics } {
  return { ...loop, checkpointJson: null, diagnostics: projectAgentLoopDiagnostics(loop, store.listAgentLoopSteps(loop.id)) };
}

/** 用全局配置组装默认 Scheduler；每个 Run 启动后再由 Revision 快照解析项目级适配器。 */
function createDefaultScheduler(store: PipelineStore, config: FactoryConfig, model: ModelGateway, mcpRegistry?: McpToolRegistry, pluginRegistry?: PluginRegistry, computerUse?: ComputerUseBridge): Scheduler {
  const definitions = readCommandDefinitions(config);
  const commands = new RegisteredCommandExecutor(definitions);
  const registeredCommandIds = new Set(definitions.map((definition) => definition.commandId));
  const mcpAllowedTools = new Set(config.mcp.servers.flatMap((server) => server.allowedTools.map((tool) => "mcp:" + server.name + ":" + tool)));
  const projectCommands = (snapshot: ProjectExecutionSnapshot) => new RegisteredCommandExecutor(snapshot.settings.commands);
  const projectDefinitions = (snapshot: ProjectExecutionSnapshot) => [...snapshot.settings.commands];
  return new Scheduler({
    store,
    globalConcurrency: config.runtime.globalConcurrency,
    workspace: new LocalGitWorktreeAdapter({ projectRoot: config.project.root, worktreeRoot: config.storage.worktreeRoot }),
    hooks: new LifecycleHookRunner(commands.execute.bind(commands), { cleanupCwd: config.project.root }),
    workspaceFactory: (snapshot) => new LocalGitWorktreeAdapter({ projectRoot: snapshot.repoRoot, worktreeRoot: snapshot.worktreeRoot }),
    hookRunnerFactory: (snapshot) => {
      const snapshotCommands = projectCommands(snapshot);
      return new LifecycleHookRunner(snapshotCommands.execute.bind(snapshotCommands), { cleanupCwd: snapshot.repoRoot });
    },
    executor: new ExecutorAgent(store, model, undefined, {
      maxSteps: config.model.loop.maxSteps,
      maxDurationMs: config.model.loop.maxDurationMs,
      maxRepeatedToolCalls: config.model.loop.maxRepeatedToolCalls,
      maxNoProgressSteps: config.model.loop.maxNoProgressSteps,
      workspaceScopeInspector: inspectWorkspaceScope,
      toolRuntimeFactory: (run, revision) => {
        const snapshot = revision.projectConfigSnapshot;
        const snapshotDefinitions = snapshot ? projectDefinitions(snapshot) : definitions;
        const snapshotCommands = snapshot ? new RegisteredCommandExecutor(snapshotDefinitions) : commands;
        const snapshotCommandIds = new Set(snapshotDefinitions.map((definition) => definition.commandId));
        const snapshotMcpTools = snapshot ? new Set(snapshot.settings.toolPolicy.allowedMcpTools) : mcpAllowedTools;
        const snapshotPluginTools = snapshot ? new Set(snapshot.settings.toolPolicy.allowedPluginTools) : new Set(config.plugins.allowedTools);
        return new DurableToolRuntime(store, new ToolGateway({
        role: "executor",
        workspaceRoot: run.workspacePath!,
        registeredCommandIds: snapshot ? snapshotCommandIds : registeredCommandIds,
        mcpAllowedTools: snapshotMcpTools,
        pluginAllowedTools: snapshotPluginTools,
        computerUseAllowed: (snapshot?.settings.toolPolicy.computerUseEnabled ?? config.computerUse.enabled) && Boolean(computerUse),
        builtin: {
          registeredCommandExecutor: (invocation) => snapshotCommands.execute({
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
      }));
      },
    }),
  });
}

/** 构造验证命令执行器；存在快照时优先使用快照命令和超时，旧 Revision 才使用全局兼容配置。 */
function createDefaultVerificationExecutor(store: PipelineStore, config: FactoryConfig): VerificationCommandExecutor {
  const commands = new RegisteredCommandExecutor(readCommandDefinitions(config));
  return (commandId, run) => {
    if (!run.workspacePath) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Run workspace is not available" });
    const revision = store.getRevision(run.planId, run.planRevision);
    const snapshot = revision?.projectConfigSnapshot;
    const snapshotCommands = snapshot ? new RegisteredCommandExecutor(snapshot.settings.commands) : commands;
    return snapshotCommands.execute({ commandId, cwd: run.workspacePath, timeoutMs: snapshot?.settings.concurrency.defaultTimeoutMs ?? 120_000, context: { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit, exitReason: "verification" } });
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
