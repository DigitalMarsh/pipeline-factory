/**
 * 模块职责：用全局 config 组装**默认** Scheduler —— 分支名生成器、worktree 适配器、hook runner、
 *   executor 四套件，以及给每个 Run 用的 project 级工厂。
 *
 * 为什么是"默认"：组合根只在调用方没有注入 `options.scheduler` 时才用它。测试与只读实例注入自己的，
 *   所以本文件里的任何依赖都不该被当作"唯一实现"。
 *
 * 维护提示：
 *   1) **每个 Run 启动后再由 Revision 快照解析项目级适配器**：`workspaceFactory` / `hookRunnerFactory`
 *      / `toolRuntimeFactory` 三个工厂都以 `revision.projectConfigSnapshot` 为准，`snapshot` 为空时才
 *      退回全局 config。这条回退是**旧 Revision（没有 projectConfigSnapshot）还能重跑的前提**——
 *      删掉它，历史 Run 会在派发时直接失败。
 *   2) `toolRuntimeFactory` 里 `run.workspacePath!` 的非空断言：能走到这里说明 workspace 已建好。
 *   3) `computerUseAllowed` 是"快照设置 **且** 真的传了 computerUse 实现"——两个条件缺一不可，
 *      只按设置判断会让一次误配置变成运行期的空指针。
 *   4) `inspectWorkspaceScope` 来自 domain：executor 用它校验工具调用的作用域，不要换成 api 侧实现。
 *   5) 命令定义从 `runtime/commands.ts` 取，本文件与 `runtime/verification.ts` 共用同一个适配器。
 */
import { DurableToolRuntime, ExecutorAgent, LifecycleHookRunner, LocalGitWorktreeAdapter, ModelRunBranchNameGenerator, RegisteredCommandExecutor, Scheduler, ToolGateway, inspectWorkspaceScope } from "@pipeline-factory/domain";
import type { ComputerUseBridge, McpToolRegistry, ModelGateway, PipelineStore, PluginRegistry, ProjectExecutionSnapshot } from "@pipeline-factory/domain";
import type { FactoryConfig } from "../config.js";
import { readCommandDefinitions } from "./commands.js";
import { planStorageFor } from "./plan-directory.js";

/** 用全局配置组装默认 Scheduler；每个 Run 启动后再由 Revision 快照解析项目级适配器。 */
export function createDefaultScheduler(store: PipelineStore, config: FactoryConfig, model: ModelGateway, mcpRegistry?: McpToolRegistry, pluginRegistry?: PluginRegistry, computerUse?: ComputerUseBridge): Scheduler {
  const definitions = readCommandDefinitions(config);
  // **延迟绑定**：Scheduler 与 ExecutorAgent 互相需要——后者要在 Run 停下时通知前者去消费"排队中的
  // 补充要求"。回调只可能在 Run 真的停下时被调用，而那时两边都已构造完，所以一个空槽就够，
  // 不必为此把其中一边改成 setter 或者把 ExecutorAgent 的构造拆成两段。
  const schedulerRef: { current?: Scheduler } = {};
  const commands = new RegisteredCommandExecutor(definitions);
  const registeredCommandIds = new Set(definitions.map((definition) => definition.commandId));
  const mcpAllowedTools = new Set(config.mcp.servers.flatMap((server) => server.allowedTools.map((tool) => "mcp:" + server.name + ":" + tool)));
  const projectCommands = (snapshot: ProjectExecutionSnapshot) => new RegisteredCommandExecutor(snapshot.settings.commands);
  const projectDefinitions = (snapshot: ProjectExecutionSnapshot) => [...snapshot.settings.commands];
  const scheduler = new Scheduler({
    store,
    branchNameGenerator: new ModelRunBranchNameGenerator(model),
    workspace: new LocalGitWorktreeAdapter({ projectRoot: config.project.root, worktreeRoot: config.storage.worktreeRoot, ignoreDirtyPaths: planStorageFor(config, config.project.root).ignoreDirtyPaths }),
    hooks: new LifecycleHookRunner(commands.execute.bind(commands), { cleanupCwd: config.project.root }),
    workspaceFactory: (snapshot) => new LocalGitWorktreeAdapter({ projectRoot: snapshot.repoRoot, worktreeRoot: snapshot.worktreeRoot, ignoreDirtyPaths: planStorageFor(config, snapshot.repoRoot).ignoreDirtyPaths }),
    hookRunnerFactory: (snapshot) => {
      const snapshotCommands = projectCommands(snapshot);
      return new LifecycleHookRunner(snapshotCommands.execute.bind(snapshotCommands), { cleanupCwd: snapshot.repoRoot });
    },
    executor: new ExecutorAgent(store, model, undefined, {
      // Run 的执行停下时，去把排队中的补充要求取出来起一轮（它属于 Scheduler：Run/Plan/Thread
      // 怎么回退是那边的规则）。没有排队的就是一次空转。
      onRunStopped: (runId) => { void schedulerRef.current?.consumeQueuedGuidance(runId); },
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
  schedulerRef.current = scheduler;
  return scheduler;
}
