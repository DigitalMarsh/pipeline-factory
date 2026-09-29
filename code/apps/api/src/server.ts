/**
 * 模块职责：**组合根** —— 读配置、造 Store 与各 Domain Service、把它们接到一个 Fastify 实例上、
 *   注册路由、接管静态托管。
 *
 * 本文件之外的分工（`createApp` 读起来就是这份清单）：
 *   - `routes/index.ts` —— 97 条路由的唯一注册入口；每个域的 HTTP 处理器在 `routes/<域>.ts`。
 *   - `projections/` —— 无 IO 的投影函数（计划生命周期、workbench、运行遥测、agent loop、explorer）。
 *   - `runtime/` —— 默认组件的构造与需要 IO 的适配：`git.ts`（子进程）、`scheduler.ts`、
 *     `verification.ts`、`model-gateway.ts`、`commands.ts`、`loop-control.ts`。
 *   - `http/sse.ts` —— SSE 传输层；`web-hosting.ts` —— 静态托管与 SPA fallback。
 *
 * 本文件保留的四件事（都是从"必须只有一份"推出来的）：
 *   1) `preHandler` 项目存在性 / 归档守卫 —— 全局横切，必须在这里且在任何路由注册之前。
 *   2) `onClose` 资源释放 —— 释放顺序（协调器 → store → model → mcp）是组合根的职责。
 *   3) 各 Domain Service 的**构造与选择**（`options.X ?? 默认实现`）—— 这是组合根的定义。
 *   4) 依赖的注入（`registerApiRoutes` 的那一个对象字面量）。
 *
 * 维护提示：
 *   1) **死 import 只能靠 grep 发现**：本仓未开 `noUnusedLocals`，tsc 看不见。每把一段代码搬出去，
 *      都要对"它用过的名字"逐个 `grep -c '\b名字\b' server.ts`，计数为 1（只剩 import 行）即为死。
 *      97 条路由搬完后一次性清掉了 33 个 zod schema、6 个 domain 类型、2 个投影函数、2 个 git 函数、
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
  RegisteredCommandExecutor,
  ToolGateway,
  DurableToolRuntime,
  McpToolRegistry,
  PluginRegistry,
  ComputerUseBridge,
  ProjectService,
  StubModelGateway,
  RecoveryCoordinator,
  ChangeProposalService,
  VerificationService,
  PlanDispatchCoordinator,
  type PipelineStore,
  type VerificationCommandExecutor,
  type ModelGateway,
  type ModelFamily,
  type ModelRole,
  type Project,
  type AgentLoop,
  type AgentLoopRunner,
} from "@pipeline-factory/domain";
import { detectDefaultBranch } from "./runtime/git.js";
import { resolveModelBackends, roleBackendId, type FactoryConfig, type ModelBackendKind } from "./config.js";
import { RepositoryContextCache } from "./repository-context-cache.js";
import { registerWebHosting } from "./web-hosting.js";
import { registerApiRoutes } from "./routes/index.js";
import { persistLoopControl } from "./runtime/loop-control.js";
import { createDefaultScheduler } from "./runtime/scheduler.js";
import { createDefaultVerificationExecutor } from "./runtime/verification.js";
import { createModelGateway } from "./runtime/model-gateway.js";
import { createModelCatalog } from "./runtime/model-catalog.js";
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
  const store = options.store ?? new SqlitePipelineStore(options.databasePath ?? options.config?.storage.databasePath ?? "pipeline-factory.sqlite", {
    // 配置缺省是 0（不回收）；这里原样传下去，由存储层判断要不要在启动时清一次。
    retention: { retentionDays: options.config?.storage.eventRetentionDays ?? 0, minPerAggregate: options.config?.storage.eventRetentionMinPerAggregate ?? 200 },
  });
  new RecoveryCoordinator(store).recover();
  const modelCatalog = options.config ? createModelCatalog(options.config) : undefined;
  const projects = new ProjectService(store, modelCatalog);
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
    },
    // 项目级执行会话的模型与档位跟随该项目 executor 的后端：跨后端不通用，不能拿一份全局清单糊弄。
    modelCatalogForProject: (project) => {
      if (!modelCatalog) return undefined;
      const backendId = executorBackendId(project, options.config!);
      return { models: modelCatalog.modelsFor(backendId), reasoningEfforts: modelCatalog.effortLevelsFor(backendId) };
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
    const backends = resolveModelBackends(options.config.model);
    const kindForRole = (role: ModelRole): ModelBackendKind => backends.get(roleBackendId(options.config!.model, role))?.kind ?? options.config!.model.backend;
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
        // 只播种模型与策略，**不播种 backend**：把全局默认抄进 Project 会让这个 Project 从此
        // 脱离"跟随全局配置"，连下面的家族迁移都跳过它。缺省即跟随，正是我们要的语义。
        models: { explorer: withoutBackend(options.config.model.roles.explorer), executor: withoutBackend(options.config.model.roles.executor) },
        toolPolicy: {
          allowedMcpTools: options.config.mcp.servers.flatMap((server) => server.allowedTools.map((tool) => `mcp:${server.name}:${tool}`)),
          allowedPluginTools: options.config.plugins.allowedTools,
          computerUseEnabled: options.config.computerUse.enabled,
        },
      },
    });
    // 历史 Project 可能仍保存着 DeepSeek 默认模型 slug；这里统一迁移到当前配置的模型。
    projects.migrateLegacyModels({
      explorer: options.config.model.roles.explorer.model,
      executor: options.config.model.roles.executor.model,
    });
    // 再处理"换了一家 provider"的情况：Claude 后端下的 gpt-* 与 Codex/OpenAI 后端下的 claude-*
    // 都是上一个家族留下的 slug，不迁移的话第一个回合会在 Provider 侧直接失败。
    // **按角色各自的家族判定**：explorer 与 executor 可以指向不同后端（探索 Codex、执行 Claude），
    // 用单一家族判定会把其中一个角色正确的 slug 改坏。
    projects.migrateForeignFamilyModels({
      familyForRole: { explorer: modelFamilyForKind(kindForRole("explorer")), executor: modelFamilyForKind(kindForRole("executor")) },
      models: {
        explorer: options.config.model.roles.explorer.model,
        executor: options.config.model.roles.executor.model,
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

/** backend 到模型家族的映射；只有它需要知道 backend 的具体名字，Domain 侧只认家族。 */
function modelFamilyForKind(kind: ModelBackendKind): ModelFamily {
  return kind === "claude-agent-sdk" ? "claude" : "openai";
}

/** 某 Project 的 executor 生效后端：Project 覆盖 → 角色默认 → 全局默认。与路由网关的解析顺序一致。 */
function executorBackendId(project: Project, config: FactoryConfig): string {
  return project.settings.models.executor.backend ?? config.model.roles.executor.backend ?? config.model.backend;
}

/** 播种 Project 设置时去掉 backend：缺省即"跟随全局"，抄进来反而会让该项目脱离全局配置与家族迁移。 */
function withoutBackend(role: FactoryConfig["model"]["roles"]["explorer"]): FactoryConfig["model"]["roles"]["explorer"] {
  const { backend: _omitted, ...rest } = role;
  return rest;
}
