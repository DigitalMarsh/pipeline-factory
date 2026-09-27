/**
 * 模块职责：组装 Fastify 应用、Project/Thread/Plan/Run 路由和 SSE 控制面。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { basename, dirname, resolve as resolvePath } from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  PlanService,
  MergeService,
  localGitMergeInspector,
  SqlitePipelineStore,
  Scheduler,
  ExplorerService,
  ExplorerDeleteBlockedError,
  ExplorerThreadService,
  ProjectExecutionThreadService,
  ModelExplorerTitleGenerator,
  LifecycleHookRunner,
  LocalGitWorktreeAdapter,
  ModelRunBranchNameGenerator,
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
  type PipelineStore,
  type DomainEvent,
  type ExplorerThread,
  type HookDefinition,
  type PlanStatus,
  type VerificationCommandExecutor,
  type VerificationRun,
  type ModelGateway,
  type ModelRole,
  type AgentLoop,
  type AgentLoopRunner,
  type PlanContract,
  type ProjectSettingsInput,
  type ProjectExecutionSnapshot,
} from "@pipeline-factory/domain";
import { projectExplorerActivity } from "@pipeline-factory/domain";
import { assertGitBranch, detectDefaultBranch, inspectGitRepository } from "./runtime/git.js";
import { z } from "zod";
import type { FactoryConfig } from "./config.js";
import { RepositoryContextCache } from "./repository-context-cache.js";
import { registerWebHosting } from "./web-hosting.js";
import { openSseChannel } from "./http/sse.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerChangeProposalRoutes } from "./routes/change-proposals.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerWorkbenchRoutes } from "./routes/workbench.js";
import { registerHookRoutes } from "./routes/hooks.js";
import { registerAgentLoopRoutes } from "./routes/agent-loops.js";
import { registerExecutionThreadRoutes } from "./routes/execution-threads.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerMergeRequestRoutes } from "./routes/merge-requests.js";
import { actorBody, loopReasonBody, projectThreadParams } from "./schemas/common.js";
import { projectCreateBody, projectSelectExplorerBody, projectUpdateBody, projectValidateBody } from "./schemas/projects.js";
import { planIdParams, planRevisionParams, revisionDraftBody, revisionDraftParams, threadPlanQuery } from "./schemas/plans.js";
import { explorerActivityQuery, explorerCandidateQuery, explorerCreateBody, explorerRenameBody, projectExplorerParams, projectExplorerPlanParams, v4AnswerBody, v4InputQuery, v4ThreadQuery, v4ThreadStatusQuery, v4TurnBody } from "./schemas/explorers.js";
import { agentLoopParams, loopEventsQuery } from "./schemas/agent-loops.js";
import { workbenchQuery } from "./schemas/workbench.js";
import { hookBody } from "./schemas/hooks.js";
import { projectExecutionEventsQuery, projectExecutionPreferencesBody, projectExecutionTurnBody } from "./schemas/execution-threads.js";
import { changeProposalBody } from "./schemas/change-proposals.js";
import { sourceCommitBody, targetCommitBody } from "./schemas/merge-requests.js";
import { guidanceBody } from "./schemas/runs.js";
import { workbenchSnapshot, createProjectEventScope } from "./projections/workbench.js";
import { planProjection, decoratePlanRows } from "./projections/plan-lifecycle.js";
import { projectRunThreadTelemetry } from "./projections/run-telemetry.js";
import { loopDiagnostics, projectAgentLoopResponse } from "./projections/agent-loop.js";
import { findProjectThread, sanitizeExplorerRequirementStatusEvent } from "./projections/explorer.js";

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
  const repositoryContextCache = new RepositoryContextCache();
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
    repositoryContextForProject: (projectId) => { const project = store.getProject(projectId); return project ? repositoryContextCache.get(project) : undefined; },
    titleGenerator: new ModelExplorerTitleGenerator(model),
  });
  void explorer.backfillTitles();
  void explorer.recoverQueuedTurns();
  const projectExecution = new ProjectExecutionThreadService(store, model, {
    ...(options.config ? {
    maxSteps: options.config.model.loop.maxSteps,
    maxDurationMs: options.config.model.loop.maxDurationMs,
    maxRepeatedToolCalls: options.config.model.loop.maxRepeatedToolCalls,
    maxNoProgressSteps: options.config.model.loop.maxNoProgressSteps,
    providerCommandTimeoutMs: options.config.runtime.defaultTimeoutMs,
    toolRuntimeForProject: (project) => {
      const commands = new RegisteredCommandExecutor(project.settings.commands);
      const commandIds = new Set(project.settings.commands.map((command) => command.commandId));
      return new DurableToolRuntime(store, new ToolGateway({
        role: "executor",
        workspaceRoot: project.repoRoot,
        registeredCommandIds: commandIds,
        mcpAllowedTools: new Set(project.settings.toolPolicy.allowedMcpTools),
        pluginAllowedTools: new Set(project.settings.toolPolicy.allowedPluginTools),
        computerUseAllowed: project.settings.toolPolicy.computerUseEnabled && Boolean(options.computerUse),
        builtin: {
          registeredCommandExecutor: (invocation) => commands.execute({
            ...invocation,
            context: { ...invocation.context, projectId: project.id, runId: invocation.context.runId || "project-execution", workspacePath: project.repoRoot, exitReason: "project_execution_thread" },
          }),
          ...(mcpRegistry ? { mcpToolExecutor: (name: string, input: Record<string, unknown>) => mcpRegistry.call(name, input) } : {}),
          ...(pluginRegistry ? { pluginToolExecutor: (name: string, input: Record<string, unknown>) => pluginRegistry.bridge.call(name, input) } : {}),
          ...(options.computerUse ? { computerUseExecutor: (input: Record<string, unknown>) => options.computerUse!.call({ action: input.action as import("@pipeline-factory/domain").ComputerUseAction, ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}), ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}) }) } : {}),
        },
      }));
    } } : {}),
  });
  projectExecution.recoverQueuedTurns();
  const scheduler = options.scheduler ?? (options.config ? createDefaultScheduler(store, options.config, model, mcpRegistry, pluginRegistry, options.computerUse) : undefined);
  const dispatchCoordinator = scheduler ? new PlanDispatchCoordinator({
    store,
    plans,
    scheduler,
    ...(verificationExecutor ? { verify: (run, revision) => verifier.verify(run, revision, verificationExecutor) } : {}),
  }) : undefined;
  if (dispatchCoordinator) void dispatchCoordinator.wake();
  const schedulerLoopController = scheduler?.agentLoopController();
  const loopController: Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> = options.agentLoopController ?? {
    pause: async (loopId, reason) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.pauseLoop(loopId, reason);
      if (loop.ownerType === "project-execution-turn") return projectExecution.pauseLoop(loopId, reason);
      if (schedulerLoopController) return schedulerLoopController.pause(loopId, reason);
      return persistLoopControl(store, loop, "PAUSED", reason);
    },
    resume: async (loopId) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.resumeLoop(loopId);
      if (loop.ownerType === "project-execution-turn") return projectExecution.resumeLoop(loopId);
      if (schedulerLoopController) return schedulerLoopController.resume(loopId);
      return persistLoopControl(store, loop, "RUNNING", "user_resumed");
    },
    cancel: async (loopId, reason) => {
      const loop = store.getAgentLoop(loopId);
      if (!loop) throw new Error(`AgentLoop ${loopId} not found`);
      if (loop.ownerType === "explorer-turn") return explorer.cancelLoop(loopId, reason);
      if (loop.ownerType === "project-execution-turn") return projectExecution.cancelLoop(loopId, reason);
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
    // 历史 Project 可能仍保存着 DeepSeek 默认模型 slug；这里统一迁移到当前 Codex 模型。
    projects.migrateLegacyModels({
      explorer: options.config.model.roles.explorer.model,
      executor: options.config.model.roles.executor.model,
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
  const confirmPlanFlow = async (planId: string, revision: number, actorId: string) => {
    if (dispatchCoordinator) {
      const result = await dispatchCoordinator.confirmAndDispatch(planId, revision, actorId);
      return { plan: result.plan, run: result.run, dispatch: result.state, confirmation: { stage: result.state.phase ?? result.state.status, attempt: result.state.attempt, retryable: !result.run && result.state.status !== "COMPLETED" } };
    }
    const plan = plans.confirm(planId, actorId, revision);
    return { plan, run: null, dispatch: null, confirmation: { stage: "FROZEN", attempt: 1, retryable: true } };
  };
  app.addHook("onClose", async () => {
    dispatchCoordinator?.dispose();
    if (ownsStore && "close" in store && typeof store.close === "function") store.close();
    if (ownsModel && "close" in model && typeof model.close === "function") await model.close();
    if (!options.mcpRegistry) await mcpRegistry?.close();
  });

  // ── 已抽出到 routes/ 的域 ──────────────────────────────────────────────────
  // 注册顺序不影响匹配：97 条路由里没有通配符，Fastify 基数树对静态段与参数段按优先级匹配。
  // 投影函数（workbenchSnapshot / createProjectEventScope / projectRunThreadTelemetry /
  // projectAgentLoopResponse / loopDiagnostics / findProjectThread）已在 `projections/`，
  // 这里只传它们需要的 store / service；此前那些 `x: (a) => f(store, a)` 回调壳已随 P5 删除。
  // 平台级（health / 额度 / MCP 与插件工具目录 / plan 需求清单）与 Project 无关。
  registerPlatformRoutes(app, { model, mcpRegistry, pluginRegistry, config: options.config });
  registerWorkbenchRoutes(app, { store, projects });
  registerHookRoutes(app, { store, projects });
  registerAgentLoopRoutes(app, { store, loopController });
  registerExecutionThreadRoutes(app, { store, projectExecution });
  registerRunRoutes(app, { store, plans, merger, scheduler, verifier, verificationExecutor, loopController });
  registerMergeRequestRoutes(app, { store, merger, dispatchCoordinator });
  registerChangeProposalRoutes(app, { store, changeProposals });
  registerProjectRoutes(app, { store, projects, plans });
  // ── 仍在组合根的域（P4b 后续步继续搬）──

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
      return reply.code(201).send({ explorerPlan, explorer: store.getThread(explorer.id) });
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
    const turns = store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === explorerPlan.id);
    const turnIds = new Set(turns.map((turn) => turn.id));
    const loops = store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId));
    const loopIds = new Set(loops.map((loop) => loop.id));
    const steps = loops.flatMap((loop) => store.listAgentLoopSteps(loop.id)).filter((step) => loopIds.has(step.loopId));
    const activity = projectExplorerActivity({ turns, loops, steps });
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
      return { explorerPlan, explorer: store.getThread(explorer.id) };
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
    const turns = store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === explorerPlan.id);
    const turnIds = new Set(turns.map((turn) => turn.id));
    const loops = store.listAgentLoops().filter((loop) => loop.ownerType === "explorer-turn" && turnIds.has(loop.ownerId));
    const loopIds = new Set(loops.map((loop) => loop.id));
    const steps = loops.flatMap((loop) => store.listAgentLoopSteps(loop.id)).filter((step) => loopIds.has(step.loopId));
    const items = projectExplorerActivity({ turns, loops, steps }).filter((item) => item.explorerPlanId === explorerPlan.id).filter((item) => !query.data.afterSequence || item.sequence > query.data.afterSequence);
    return { items, lastEventSequence: store.getLastEventSequence(explorer.id) };
  });

  app.post("/api/v4/projects/:projectId/merge-reconciliation", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    try {
      return merger.reconcileProject(params.data.projectId);
    } catch (error) {
      return reply.code(409).send({ code: "MERGE_RECONCILIATION_FAILED", error: error instanceof Error ? error.message : "Merge reconciliation failed" });
    }
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

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/confirmed-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const confirmedPlans = plans.listThreadPlans(explorer.id).filter((plan) => plan.status === "READY");
    return { items: decoratePlanRows(store, confirmedPlans) };
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/all-plans", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    return { items: plans.listExplorerThreadPlans(explorer.id).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.get("/api/v4/projects/:projectId/candidate-plans", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { items: plans.listProjectPlanCandidates(params.data.projectId).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.get("/api/v4/projects/:projectId/tasks", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!store.getProject(params.data.projectId)) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: `Project ${params.data.projectId} not found` });
    return { items: plans.listProjectTasks(params.data.projectId).map((plan) => ({ ...plan, ...planProjection(store, plan), dispatch: store.getDispatchState(plan.id) ?? null })) };
  });

  app.post("/api/v4/projects/:projectId/explorers/:explorerId/explorer-plans/:explorerPlanId/selected-plan", async (request, reply) => {
    const params = projectExplorerPlanParams.safeParse(request.params);
    const body = z.object({ planId: z.string().min(1).nullable() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid selected Plan" });
    const explorer = store.getThread(params.data.explorerId);
    const requirement = store.getExplorerPlan(params.data.explorerPlanId);
    if (!explorer || explorer.projectId !== params.data.projectId || !requirement || requirement.explorerThreadId !== explorer.id || requirement.projectId !== explorer.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    try { return { explorerPlan: plans.selectCandidate(requirement.id, body.data.planId) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be selected" }); }
  });

  app.get("/api/v4/projects/:projectId/explorers/:explorerId/candidate", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    const query = explorerCandidateQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Explorer candidate query" });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    const explorerPlanId = query.data.explorerPlanId ?? explorer.activeExplorerPlanId;
    if (explorerPlanId) {
      const explorerPlan = store.getExplorerPlan(explorerPlanId);
      if (!explorerPlan || explorerPlan.explorerThreadId !== explorer.id) return reply.code(404).send({ error: "ExplorerPlan not found" });
    }
    const requirement = explorerPlanId ? store.getExplorerPlan(explorerPlanId) : explorer.activeExplorerPlanId ? store.getExplorerPlan(explorer.activeExplorerPlanId) : undefined;
    const selected = requirement?.candidatePlanId ? store.getPlan(requirement.candidatePlanId) : undefined;
    const legacyCandidate = requirement && !requirement.newPlanRequested && !requirement.candidatePlanId
      ? store.listPlans().filter((plan) => plan.projectId === explorer.projectId && plan.sourceExplorerThreadId === explorer.id && plan.explorerPlanId === requirement.id && plan.status === "DRAFT").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;
    const candidate = selected?.status === "DRAFT" && selected.sourceExplorerThreadId === explorer.id ? selected : legacyCandidate;
    if (!candidate) return reply.code(404).send({ error: "Candidate plan not found" });
    return { plan: { ...candidate, ...planProjection(store, candidate) } };
  });

  /** RevisionDraft is deliberately separate from a candidate Plan: it is mutable until confirmation. */
  app.get("/api/v4/projects/:projectId/explorers/:explorerId/revision-draft", async (request, reply) => {
    const params = projectExplorerParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const explorer = store.getThread(params.data.explorerId);
    if (!explorer || explorer.projectId !== params.data.projectId) return reply.code(404).send({ error: "Explorer not found" });
    if (!explorer.activeRevisionDraftId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "No active revision draft" });
    const draft = store.getRevisionDraft(explorer.activeRevisionDraftId);
    if (!draft || draft.projectId !== explorer.projectId || !["EDITING", "READY_TO_CONFIRM", "BASE_CHANGED"].includes(draft.status)) {
      return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "No active revision draft" });
    }
    return { draft };
  });

  app.post("/api/v4/projects/:projectId/explorer-thread/turns", async (request, reply) => {
    const params = projectThreadParams.safeParse(request.params);
    const body = v4TurnBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid v4 ExplorerThread turn" });
    const thread = findProjectThread(store, params.data.projectId, body.data.threadId);
    if (!thread) return reply.code(404).send({ error: "ExplorerThread not found" });
    try {
      const accepted = await explorer.startTurn({ threadId: body.data.threadId, explorerPlanId: body.data.explorerPlanId, content: body.data.content, clientTurnId: body.data.clientTurnId });
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
    const explorerPlan = store.getExplorerPlan(query.data.explorerPlanId);
    if (!explorerPlan || explorerPlan.explorerThreadId !== thread.id || explorerPlan.projectId !== thread.projectId) return reply.code(404).send({ error: "ExplorerPlan not found" });
    const headerSequence = Number(request.headers["last-event-id"] ?? 0) || 0;
    let cursor = Math.max(query.data.afterSequence ?? 0, headerSequence);
    const afterSequence = cursor;
    // 订阅式通道：不传 poll，帧由 subscribeEvents 的回调推。unsubscribe 要等 subscribeEvents
    // 返回才拿得到，所以走 onClose 登记（见 http/sse.ts 维护提示 4）。
    const sse = openSseChannel(request, reply);
    const send = (event: { sequence: number; type: string; payload: Record<string, unknown> }) => { cursor = event.sequence; const type = event.type.startsWith("explorer.") ? event.type.slice("explorer.".length) : event.type; sse.send(event.sequence, type, event.payload); };
    const unsubscribe = explorer.subscribeEvents(thread.id, (event) => {
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
    const unsubscribe = explorer.subscribeEvents(thread.id, send, afterSequence);
    sse.onClose(unsubscribe);
    cursor = Math.max(cursor, store.getLastEventSequence(thread.id));
    sse.ready(cursor, { afterSequence: cursor });
  });

  app.get("/api/v4/plans/:planId/revisions", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      return { plan: { ...plan, ...planProjection(store, plan) }, items: plans.listRevisions(plan.id), drafts: store.listRevisionDrafts(plan.id), lifecycle: store.listRevisionLifecycleProjections(plan.projectId, plan.id) };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/candidate-versions", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const items = store.listCandidateVersions(plan.id).map((version) => ({ ...version, isLatest: version.revision === plan.revision, readOnly: version.revision !== plan.revision || plan.status !== "DRAFT" }));
      return { planId: plan.id, latestRevision: plan.revision, items };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/candidate-versions/:revision", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const version = store.listCandidateVersions(plan.id).find((item) => item.revision === params.data.revision);
      if (!version) return reply.code(404).send({ code: "CANDIDATE_VERSION_NOT_FOUND", error: "Candidate version not found" });
      return { planId: plan.id, latestRevision: plan.revision, version, readOnly: version.revision !== plan.revision || plan.status !== "DRAFT" };
    } catch { return reply.code(404).send({ code: "PLAN_NOT_FOUND", error: "Plan not found" }); }
  });

  app.get("/api/v4/plans/:planId/revisions/:revision", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const revision = plans.getRevision(plan.id, params.data.revision);
      return { plan: { ...plan, ...planProjection(store, plan) }, planId: plan.id, revision, runs: store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === revision.revision) };
    } catch { return reply.code(404).send({ code: "REVISION_NOT_FOUND", error: "Plan revision not found" }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/drafts", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    const body = revisionDraftBody.safeParse(request.body ?? {});
    if (!params.success || !body.success || body.data.fromRevision !== params.data.revision) return reply.code(400).send({ error: "Invalid revision draft request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      const thread = store.getThread(body.data.explorerThreadId);
      if (!thread || thread.projectId !== plan.projectId) return reply.code(404).send({ code: "EXPLORER_THREAD_PROJECT_MISMATCH", error: "ExplorerThread does not belong to Plan Project" });
      const unmerged = store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === params.data.revision && !store.findMergeRequestByRun(run.id)?.mergedAt && (run.workspacePath !== null || !["CANCELLED", "STALE"].includes(run.status)));
      if (unmerged.length && !body.data.discardUnmergedRun) return reply.code(409).send({ code: "UNMERGED_RUN_CONFIRMATION_REQUIRED", error: "Revision has an unmerged Run/worktree; explicit discardUnmergedRun is required", runs: unmerged.map((run) => run.id) });
      if (unmerged.length) {
        if (!scheduler) return reply.code(503).send({ code: "CLEANUP_UNAVAILABLE", error: "Scheduler is required to clean an unmerged Run" });
        for (const run of unmerged) {
          for (const loop of store.listAgentLoops(run.executionThreadId)) if (loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED") await loopController.cancel(loop.id, "revision_superseded");
          await scheduler.finish(run.id, "cancelled", {}, "revision_superseded");
          if (store.listHookExecutions(run.id).some((hook) => hook.hookType === "cleanup" && hook.status === "failed")) return reply.code(409).send({ code: "CLEANUP_FAILED", error: "Cleanup hook failed; RevisionDraft was not created", runId: run.id });
        }
      }
      const draft = plans.createRevisionDraft({ ...body.data, planId: plan.id, explorerThreadId: thread.id });
      return reply.code(201).send({ draft, explorerThread: store.getThread(thread.id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message === "UNMERGED_RUN_CONFIRMATION_REQUIRED" ? 409 : 422).send({ code: message, error: message });
    }
  });

  app.get("/api/v4/plans/:planId/revision-drafts/:draftId", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply) === null) return;
    return { draft };
  });

  app.post("/api/v4/plans/:planId/revision-drafts/:draftId/confirm", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid revision confirmation" });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply, true) === null) return;
    try {
      const plan = plans.confirmRevisionDraft(draft.draftId, body.data.actorId);
      return await confirmPlanFlow(plan.id, plan.revision, body.data.actorId);
    }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: message, error: message }); }
  });

  app.post("/api/v4/plans/:planId/revision-drafts/:draftId/discard", async (request, reply) => {
    const params = revisionDraftParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid revision discard" });
    const draft = store.getRevisionDraft(params.data.draftId);
    if (!draft || draft.planId !== params.data.planId) return reply.code(404).send({ code: "REVISION_DRAFT_NOT_FOUND", error: "RevisionDraft not found" });
    if (ensurePlanProject(draft.projectId, reply, true) === null) return;
    try { return { draft: plans.discardRevisionDraft(draft.draftId, body.data.actorId) }; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: message, error: message }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/enqueue", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest revision can be enqueued" });
      return { plan: plans.enqueue(plan.id), dispatch: null };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" }); }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/run", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest revision can be dispatched" });
      if (dispatchCoordinator) {
        const dispatched = await dispatchCoordinator.dispatch(plan.id);
        return { plan: dispatched.plan, run: dispatched.state.runId ? store.getRun(dispatched.state.runId) ?? null : null, dispatch: dispatched.state };
      }
      const project = store.getProject(plan.projectId);
      const dispatchedPlan = plans.dispatch(plan.id);
      return { plan: dispatchedPlan, run: await scheduler.start(plan.id, project?.settings.hooks ?? {}), dispatch: null };
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return reply.code(409).send({ code: "RUN_START_FAILED", error: message }); }
  });

  app.get("/api/v4/plans/:planId", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply) === null) return;
      const revision = store.getRevision(plan.id, plan.revision);
      return { plan: { ...plan, ...planProjection(store, plan) }, revision: revision ?? null, projectSnapshot: revision?.projectConfigSnapshot ?? null, dispatch: dispatchCoordinator?.state(plan.id) ?? store.getDispatchState(plan.id) ?? null, mergeRequest: plan.runId ? merger.findByRun(plan.runId) ?? null : null };
    } catch {
      return reply.code(404).send({ error: "Plan not found" });
    }
  });

  app.post("/api/v4/plans/:planId/revisions/:revision/confirm", async (request, reply) => {
    const params = planRevisionParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid versioned confirmation request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision !== params.data.revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest candidate version can be confirmed" });
      return await confirmPlanFlow(plan.id, params.data.revision, body.data.actorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be confirmed";
      return reply.code(message === "REVISION_NOT_LATEST" ? 409 : 409).send({ code: message, error: message, stage: message.includes("not found") ? "VALIDATING" : "VALIDATION_FAILED" });
    }
  });

  app.post("/api/v4/plans/:planId/confirm", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = z.object({ actorId: z.string().min(1).default("local-user"), revision: z.number().int().positive().optional() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid confirmation request" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      const revision = body.data.revision ?? plan.revision;
      if (plan.revision !== revision) return reply.code(409).send({ code: "REVISION_NOT_LATEST", error: "Only the latest candidate version can be confirmed" });
      return await confirmPlanFlow(plan.id, revision, body.data.actorId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan cannot be confirmed";
      return reply.code(409).send({ code: message, error: message, stage: "VALIDATION_FAILED" });
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
      if (plan.revision > 1) return reply.code(409).send({ code: "REVISION_REQUIRED", error: "Use the revision-specific enqueue endpoint" });
      return { plan: plans.enqueue(params.data.planId), dispatch: null };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Plan cannot be enqueued" });
    }
  });

  app.post("/api/v4/plans/:planId/revise-configuration", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    const body = actorBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid configuration revision request" });
    if (!dispatchCoordinator) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      return { plan: dispatchCoordinator.reviseConfiguration(plan.id, body.data.actorId) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plan configuration cannot be revised";
      return reply.code(409).send({ code: "PLAN_CONFIGURATION_REVISION_FAILED", error: message });
    }
  });

  app.post("/api/v4/plans/:planId/run", async (request, reply) => {
    const params = planIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    if (!scheduler) return reply.code(503).send({ error: "Scheduler is not configured for this API instance" });
    try {
      const plan = plans.get(params.data.planId);
      if (ensurePlanProject(plan.projectId, reply, true) === null) return;
      if (plan.revision > 1) return reply.code(409).send({ code: "REVISION_REQUIRED", error: "Use the revision-specific run endpoint" });
      if (dispatchCoordinator) {
        const dispatched = await dispatchCoordinator.dispatch(plan.id);
        return { plan: dispatched.plan, run: dispatched.state.runId ? store.getRun(dispatched.state.runId) ?? null : null, dispatch: dispatched.state };
      }
      const project = store.getProject(plan.projectId);
      const dispatchedPlan = plans.dispatch(plan.id);
      return { plan: dispatchedPlan, run: await scheduler.start(plan.id, project?.settings.hooks ?? {}), dispatch: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Run cannot be started";
      return reply.code(409).send({ code: /RUN_PREREQUISITES_UNSATISFIED/.test(message) ? "RUN_PREREQUISITES_UNSATISFIED" : "RUN_START_FAILED", error: message });
    }
  });

  // 静态托管必须最后注册：setNotFoundHandler 是全局兜底，且必须在 app 启动前设置
  // （启动后再调用会抛 AVV_ERR_ROOT_PLG_BOOTED）。它只接管"没有匹配到任何路由"的请求，
  // 因此顺序上放在全部 API 路由之后才语义正确。
  if (options.config?.server.serveWeb) registerWebHosting(app, options.config);

  return app;
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
    branchNameGenerator: new ModelRunBranchNameGenerator(model),
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

function readCommandDefinitions(config: FactoryConfig): Array<{ commandId: string; category: "verification"; enabled: true; argv: readonly [string, ...string[]]; environment?: Readonly<Record<string, string>> | undefined }> {
  return config.project.commands.flatMap((command) => command.argv.length > 0 ? [{ commandId: command.commandId, category: "verification" as const, enabled: true as const, argv: [command.argv[0]!, ...command.argv.slice(1)] as readonly [string, ...string[]], environment: command.environment }] : []);
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
