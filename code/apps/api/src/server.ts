/**
 * 模块职责：**组合根** —— 读配置、造 Store 与各 Domain Service、把它们接到一个 Fastify 实例上、
 *   注册路由、接管静态托管。本文件不再包含任何路由体：97 条路由全部在 `routes/`（见
 *   `routes/index.ts` 的入口），投影函数在 `projections/`，git 子进程 IO 在 `runtime/git.ts`。
 *
 * 本文件保留的四件事（都是从"必须只有一份"推出来的）：
 *   1) `preHandler` 项目存在性 / 归档守卫 —— 全局横切，必须在这里且在任何路由注册之前。
 *   2) `onClose` 资源释放 —— 释放顺序（协调器 → store → model → mcp）是组合根的职责。
 *   3) 默认组件的构造（`createDefaultScheduler` / `createDefaultVerificationExecutor` /
 *      `createModelGateway` / `readCommandDefinitions` / `persistLoopControl`）—— 只在没有
 *      注入真实实现时用，属于"接线"而不是"业务"。
 *   4) 依赖的注入（`registerApiRoutes` 的那一个对象字面量）。
 *
 * 维护提示：
 *   1) **死 import 只能靠 grep 发现**：本仓未开 `noUnusedLocals`，tsc 看不见。每把一段代码搬出去，
 *      都要对"它用过的名字"逐个 `grep -c '\b名字\b' server.ts`，计数为 1（只剩 import 行）即为死。
 *      97 条路由搬完后一次性清掉了 24 个 zod schema、6 个 domain 类型、2 个 git 函数、
 *      `openSseChannel`、`z`、`dirname` / `resolvePath`、`FastifyReply` —— 全是 tsc 抓不到的。
 *   2) 本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { basename } from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import {
  PlanService,
  MergeService,
  localGitMergeInspector,
  SqlitePipelineStore,
  Scheduler,
  ExplorerService,
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
  type VerificationCommandExecutor,
  type ModelGateway,
  type ModelRole,
  type AgentLoop,
  type AgentLoopRunner,
  type ProjectExecutionSnapshot,
} from "@pipeline-factory/domain";
import { detectDefaultBranch } from "./runtime/git.js";
import type { FactoryConfig } from "./config.js";
import { RepositoryContextCache } from "./repository-context-cache.js";
import { registerWebHosting } from "./web-hosting.js";
import { registerApiRoutes } from "./routes/index.js";
// 全部 97 条路由已分域搬进 `routes/`，组合根不再直接持有任何 zod schema、任何投影函数、
// 任何 SSE 传输件——它们的 import 随各自的 route 文件走了。**本文件剩余的 import 只服务于
// 组装**（构造 Service / 起 store / 接管静态托管）。
// 检查死 import 的唯一手段是 grep（本仓未开 `noUnusedLocals`，tsc 看不见）；
// 每搬走一个域都要对"该域用过的名字"逐个 grep 一遍。

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
  app.addHook("onClose", async () => {
    dispatchCoordinator?.dispose();
    if (ownsStore && "close" in store && typeof store.close === "function") store.close();
    if (ownsModel && "close" in model && typeof model.close === "function") await model.close();
    if (!options.mcpRegistry) await mcpRegistry?.close();
  });

  // ── 全部 97 条路由经一个入口按域注册（11 个 routes/*.ts + routes/index.ts）────────────
  // 每个域自己的 deps 类型在它自己的文件里（**显式 deps**：想知道 runs 依赖到 loopController 的
  // 哪一步，看 `RunRouteDeps` 就行）。这里只负责凑齐并集，不做任何变换。
  // 唯一的注入期改名是 `explorerThread: explorer`：组合根里 ExplorerThreadService 的变量名叫
  // `explorer`，与 ExplorerService 的 `explorers` 只差一个 s；route 文件里必须分得清
  // "生命周期"与"回合执行"，所以在注入处改名，而不去动组合根里的变量名（那会牵动别处调用点）。
  // `ensurePlanProject` / `confirmPlanFlow` 这两个闭包辅助原在这里，已随 Plan 域搬进
  // `routes/plans.ts`——全仓只有 Plan 路由用它们。想在组合根加**横切**守卫，用上面的 `preHandler`，
  // 那才是正确的层。
  registerApiRoutes(app, {
    config: options.config,
    store, projects, plans, explorers,
    explorerThread: explorer,
    merger, changeProposals, verifier, scheduler, dispatchCoordinator,
    verificationExecutor, loopController, projectExecution,
    model, mcpRegistry, pluginRegistry,
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
