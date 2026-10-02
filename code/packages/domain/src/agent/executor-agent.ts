/**
 * 模块职责：构造 Executor Agent 的系统约束、执行报告协议和 Agent Loop。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentLoopEngine, type AgentLoop, type AgentLoopEvent, type AgentLoopMode, type GateContext } from "./agent-loop.js";
import { resolveExecutorWorkingDirectory } from "../tools/executor-working-directory.js";
import { TaskProgressGate } from "./termination-gates.js";
import { mergeModelUsage, normalizeModelUsage } from "../model/usage.js";
import { isProviderActivityKind, isProviderActivityOutcome } from "../model/provider-activity.js";
import { updatePlanStatus } from "../plan/status-transition.js";
// 用 import type 而不是"具名绑定带 type 前缀"：这样"本模块对 index.js 只剩类型依赖"是显式的，
// check-cycles.mjs 也据此判定这条回流边已被切断。
import type { ExecutionTelemetry, ModelGateway, ModelRoleConfig, PipelineStore, PlanRevision, Run } from "../index.js";
import type { ToolRuntime } from "../tools/tool-runtime.js";

const REPORT_START = "<pipeline-factory-execution-report>";
const REPORT_END = "</pipeline-factory-execution-report>";
const execFileAsync = promisify(execFile);

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, maxLength);
}

function safeProviderName(value: unknown): string | undefined {
  const name = boundedText(value, 120);
  return name && /^[\p{L}\p{N}._:/-]+$/u.test(name) ? name : undefined;
}

function normalizeProviderStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase();
  return ["failed", "error", "denied", "success", "succeeded", "completed", "complete", "cancelled", "canceled", "running", "in_progress"].includes(status) ? status : undefined;
}

/** Executor 必须返回的结构化完成报告；Gate 会据此判断任务、范围和报告是否完整。 */
export type ExecutorReport = {
  completedTaskIds: string[];
  changedPaths: string[];
  report: string;
  /** 可选的结构化任务事实，用于执行页展示，不参与验证安全结论。 */
  activeTaskId?: string;
  blockedTaskId?: string;
  blockedReason?: string;
};

export type WorkspaceScopeInspection = {
  changedPaths: string[];
  outsidePaths: string[];
  pathsWithinScope: boolean;
};

export type WorkspaceScopeInspector = (input: { workspacePath: string; baseCommit: string; include: string[]; exclude?: string[] }) => Promise<WorkspaceScopeInspection>;

/** Executor Agent 的运行限制；ProjectExecutionSnapshot 优先于全局默认策略。 */
export type ExecutorAgentOptions = {
  maxSteps?: number;
  maxDurationMs?: number;
  maxRepeatedToolCalls?: number;
  maxNoProgressSteps?: number;
  mode?: AgentLoopMode;
  toolRuntimeFactory?: (run: Run, revision: PlanRevision) => ToolRuntime;
  workspaceScopeInspector?: WorkspaceScopeInspector;
};

/**
 * 在 Run 的 Worktree 中启动 Executor Agent，并把模型输出转换为 ExecutionThread 事实。
 * Executor 始终校验 Run、PlanRevision 和 workspace 的对应关系，避免跨项目或跨版本写入。
 */
export class ExecutorAgent {
  private readonly engine: AgentLoopEngine;
  private readonly options: ExecutorAgentOptions;
  private readonly defaultToolRuntime: ToolRuntime | undefined;
  private readonly modelContexts = new Map<string, { modelStep?: number; loopId?: string; providerThreadId?: string; providerTurnId?: string }>();
  private readonly providerCallsByStep = new Map<string, Map<number, Map<string, string>>>();
  private readonly taskProgressBuffers = new Map<string, { modelStep: number; text: string; scanOffset: number }>();
  private readonly activeTaskByRun = new Map<string, string>();
  private readonly currentTaskByRun = new Map<string, string>();

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, toolRuntime?: ToolRuntime, options: ExecutorAgentOptions = {}) {
    this.options = options;
    this.defaultToolRuntime = toolRuntime;
    this.engine = new AgentLoopEngine(store, model, toolRuntime, {
      defaultMaxSteps: options.maxSteps ?? 40,
      defaultMaxDurationMs: options.maxDurationMs ?? 1_800_000,
      defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls ?? 2,
      defaultMaxNoProgressSteps: options.maxNoProgressSteps ?? 3,
    });
  }

  /** 异步启动 Executor Loop；RunDetail 可通过 AgentLoop/SSE 观察实时进度。 */
  async start(run: Run, revision: PlanRevision): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const workspaceRoot = run.workspacePath!;
    const commandWorkingDirectory = await resolveExecutorWorkingDirectory(workspaceRoot, revision.resolvedContract.scope.includePaths, revision.resolvedContract.artifact.path);
    const projectConfig = this.executorModelConfig(revision);
    const mode = projectConfig.loopMode ?? this.options.mode ?? "provider-controlled";
    const maxDurationMs = revision.projectConfigSnapshot?.settings.concurrency.executionTimeoutMs ?? this.options.maxDurationMs;
    this.assertCapabilities(mode, projectConfig);
    const openToolCalls = new Set<string>();
    const gate = new TaskProgressGate();
    const toolRuntime = this.options.toolRuntimeFactory?.(run, revision) ?? this.defaultToolRuntime;
    const evaluate = async (context: GateContext) => gate.evaluate({
      ...context,
      ...(await this.progressContext(run, revision, context.content ?? "", openToolCalls)),
    });
    const loop = await this.engine.start({
      ownerType: "run",
      ownerId: run.id,
      role: "executor",
      mode,
      maxSteps: this.options.maxSteps ?? 40,
      // Run 会话没有回答入口：执行会话里没有回答结构化提问的 UI。让 Loop 在模型提问时
      // 直接以 STRUCTURED_INPUT_UNSUPPORTED 阻塞，而不是挂进等不到答案的 WAITING_FOR_INPUT。
      allowStructuredInput: false,
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      providerCommandTimeoutMs: revision.projectConfigSnapshot?.settings.concurrency.defaultTimeoutMs ?? 120_000,
      workspacePath: run.workspacePath!,
      ...(toolRuntime ? { toolRuntime } : {}),
      modelRequest: {
        conversationId: run.id,
        modelConfig: projectConfig,
        cwd: commandWorkingDirectory,
        messages: [
          { role: "system", content: this.systemInstructions(revision, workspaceRoot, commandWorkingDirectory) },
          { role: "user", content: `Execute the approved plan: ${revision.planId}@${revision.revision}.` },
        ],
      },
      gate: { evaluate },
      onEvent: (event) => this.handleEvent(run, event, openToolCalls, revision),
    });
    return loop;
  }

  /** 同步运行 Executor Loop，完成后同步 Run 的终态映射。 */
  async run(run: Run, revision: PlanRevision): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const workspaceRoot = run.workspacePath!;
    const commandWorkingDirectory = await resolveExecutorWorkingDirectory(workspaceRoot, revision.resolvedContract.scope.includePaths, revision.resolvedContract.artifact.path);
    const projectConfig = this.executorModelConfig(revision);
    const mode = projectConfig.loopMode ?? this.options.mode ?? "provider-controlled";
    const maxDurationMs = revision.projectConfigSnapshot?.settings.concurrency.executionTimeoutMs ?? this.options.maxDurationMs;
    this.assertCapabilities(mode, projectConfig);
    const openToolCalls = new Set<string>();
    const gate = new TaskProgressGate();
    const toolRuntime = this.options.toolRuntimeFactory?.(run, revision) ?? this.defaultToolRuntime;
    const loop = await this.engine.run({
      ownerType: "run",
      ownerId: run.id,
      role: "executor",
      mode,
      maxSteps: this.options.maxSteps ?? 40,
      // 同上：Run 会话没有回答入口。
      allowStructuredInput: false,
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      providerCommandTimeoutMs: revision.projectConfigSnapshot?.settings.concurrency.defaultTimeoutMs ?? 120_000,
      workspacePath: run.workspacePath!,
      ...(toolRuntime ? { toolRuntime } : {}),
      modelRequest: {
        conversationId: run.id,
        modelConfig: projectConfig,
        cwd: commandWorkingDirectory,
        messages: [
          { role: "system", content: this.systemInstructions(revision, workspaceRoot, commandWorkingDirectory) },
          { role: "user", content: `Execute the approved plan: ${revision.planId}@${revision.revision}.` },
        ],
      },
      gate: { evaluate: async (context) => gate.evaluate({ ...context, ...(await this.progressContext(run, revision, context.content ?? "", openToolCalls)) }) },
      onEvent: (event) => this.handleEvent(run, event, openToolCalls, revision),
    });
    this.syncRunTerminalState(run, loop);
    return loop;
  }

  wait(loopId: string): Promise<AgentLoop> { return this.engine.wait(loopId); }
  pause(loopId: string, reason: string): Promise<AgentLoop> { return this.engine.pause(loopId, reason); }
  resume(loopId: string): Promise<AgentLoop> { return this.engine.resume(loopId); }
  cancel(loopId: string, reason: string): Promise<AgentLoop> { return this.engine.cancel(loopId, reason); }
  get(loopId: string): AgentLoop { return this.engine.get(loopId); }

  private assertRunnable(run: Run, revision: PlanRevision): void {
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${run.id} must be IN_PROGRESS before Executor starts`);
    if (run.planId !== revision.planId || run.planRevision !== revision.revision) throw new Error("Executor Run and PlanRevision do not match");
    if (!run.workspacePath) throw new Error(`Run ${run.id} has no workspace`);
  }

  /**
   * 能力判定必须针对**这一次真正会执行的后端**：Project 可以覆盖 executor 的 backend，
   * 而各后端支持的 Loop 模式不同（例如只有 Claude 侧是 provider-controlled 单一模式）。
   * 按角色默认后端判定会把"覆盖之后不支持"的情况判成通过，失败被推迟到第一次模型调用。
   */
  private assertCapabilities(mode: AgentLoopMode, config: ModelRoleConfig): void {
    const capabilities = this.model.capabilities?.("executor", config);
    if (mode === "factory-controlled" && (!capabilities?.supportsToolCalls || !capabilities.supportedLoopModes.includes(mode))) throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
    if (mode === "provider-controlled" && capabilities && !capabilities.supportedLoopModes.includes(mode)) throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
  }

  /** 在 Loop 创建前复制快照配置；后续 Project 配置变化不会影响本次 Run。 */
  private executorModelConfig(revision: PlanRevision): ModelRoleConfig {
    return { ...this.model.configFor("executor"), ...(revision.projectConfigSnapshot?.settings.models.executor ?? {}) };
  }

  private async progressContext(run: Run, revision: PlanRevision, content: string, openToolCalls: Set<string>): Promise<Pick<GateContext, "allTasksComplete" | "changedPaths" | "pathsWithinScope" | "reportReady" | "hasOpenToolCalls" | "hasPendingChangeProposal" | "reportError" | "scopeError">> {
    const parsedReport = parseExecutorReportDetailed(content);
    const report = parsedReport.report;
    const taskIds = new Set(revision.resolvedContract.tasks.map((task) => task.id));
    const completed = report?.completedTaskIds ?? [];
    let scope: WorkspaceScopeInspection & { error?: string } = { changedPaths: [], outsidePaths: [], pathsWithinScope: false };
    if (report) {
      if (!this.options.workspaceScopeInspector) scope = { changedPaths: report.changedPaths, outsidePaths: [], pathsWithinScope: true };
      else {
        try {
          scope = await this.options.workspaceScopeInspector({ workspacePath: run.workspacePath!, baseCommit: run.baseCommit, include: revision.resolvedContract.scope.includePaths, exclude: revision.resolvedContract.scope.excludePaths });
        } catch (error) {
          scope.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
    const uniqueCompleted = new Set(completed);
    return {
      allTasksComplete: Boolean(report && uniqueCompleted.size === taskIds.size && completed.length === taskIds.size && completed.every((taskId) => taskIds.has(taskId))),
      changedPaths: scope.changedPaths,
      pathsWithinScope: scope.pathsWithinScope,
      ...(scope.error ? { scopeError: scope.error } : {}),
      reportReady: Boolean(report?.report.trim()),
      hasOpenToolCalls: openToolCalls.size > 0,
      hasPendingChangeProposal: this.store.listChangeProposals(run.id).some((proposal) => proposal.status === "OPEN"),
      ...(report ? {} : { reportError: parsedReport.error ?? "EXECUTION_REPORT_INVALID_OR_MISSING" }),
    };
  }

  /** 将冻结的 Plan 合同和 Project 配置注入模型，确保执行阶段不读取当前 Project。 */
  private systemInstructions(revision: PlanRevision, workspaceRoot: string, commandWorkingDirectory: string): string {
    const executionContract = {
      planId: revision.planId,
      revision: revision.revision,
      executionContext: { worktreeRoot: workspaceRoot, commandWorkingDirectory },
      contract: executorPlanView(revision),
      projectConfig: revision.projectConfigSnapshot
        ? { version: revision.projectConfigVersion, hash: revision.projectConfigHash, snapshot: revision.projectConfigSnapshot }
        : { legacy: true, note: "This revision predates Project configuration snapshots; use the embedded contract and the runtime settings supplied by the Factory." },
    };
    return [
      "You are the Pipeline Factory Executor.",
      "The approved Plan contract is the source of truth. The Plan is stored by the Factory, not as a file in the worktree; use the embedded contract below and do not search the worktree for a plan document.",
      `Work only inside the approved include scope: ${revision.resolvedContract.scope.includePaths.join(", ")}.`,
      `Never modify excluded or protected paths: ${revision.resolvedContract.scope.excludePaths.join(", ")}.`,
      `The Run worktree root is ${workspaceRoot}; Provider shell commands start in ${commandWorkingDirectory}. Do not assume the shell is at the worktree root.`,
      "Before package-manager or build commands, verify pwd and the expected project manifest in the selected directory. Never run an install command in an ancestor directory that does not contain the project's manifest; if the expected project directory or manifest is missing, stop and report the exact blocker.",
      "Treat include/exclude paths and execution-report changedPaths as relative to the worktree root. Resolve shell command paths from the command working directory without duplicating the worktree-relative prefix.",
      "For each Plan task, first emit a machine-readable status marker on its own line: <pipeline-factory-task-progress>{\"taskId\":\"exact Plan task ID\",\"state\":\"started|completed|blocked\"}</pipeline-factory-task-progress>. Include reason only for blocked. Then give the user one concise status sentence naming the task ID/title and the observable action or outcome. These markers are the only live source of per-task state; the Factory validates every ID against the approved Plan. Do not infer task state from prose and do not reveal private reasoning. Never claim the whole Run is complete in prose. End with <pipeline-factory-execution-report> JSON </pipeline-factory-execution-report>.",
      "The JSON must contain completedTaskIds, changedPaths (or legacy pathsWithinScope array), and a non-empty report. Optional fields must be omitted entirely when they do not apply - never send null. When a task is currently being worked on or blocked, also include activeTaskId or blockedTaskId with blockedReason.",
      `Approved Plan contract:\n${JSON.stringify(executionContract, null, 2)}`,
    ].join(" ");
  }

  /** 把 Loop 事件投影为用户可读的 ExecutionThread journal，同时维护未完成工具集合。 */
  private handleEvent(run: Run, event: AgentLoopEvent, openToolCalls: Set<string>, revision: PlanRevision): void {
    if (!this.store.getExecutionThread(run.executionThreadId)) return;
    const payload = event.payload;
    const eventStep = typeof payload.step === "number" ? payload.step : undefined;
    if (event.type === "agent.step.started" && eventStep !== undefined) {
      const activeTaskId = this.activeTaskByRun.get(run.id);
      if (activeTaskId) this.currentTaskByRun.set(run.id, activeTaskId);
      else this.currentTaskByRun.delete(run.id);
      this.taskProgressBuffers.set(run.id, { modelStep: eventStep, text: "", scanOffset: 0 });
    }
    const previousContext = this.modelContexts.get(run.id) ?? {};
    const providerThreadId = typeof payload.providerThreadId === "string" ? payload.providerThreadId : event.type === "agent.provider.thread.started" && typeof payload.threadId === "string" ? payload.threadId : previousContext.providerThreadId;
    const providerTurnId = typeof payload.providerTurnId === "string" ? payload.providerTurnId : previousContext.providerTurnId;
    const context = {
      ...previousContext,
      loopId: event.loopId,
      ...(event.type === "agent.step.started" && eventStep !== undefined ? { modelStep: eventStep } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerTurnId ? { providerTurnId } : {}),
    };
    this.modelContexts.set(run.id, context);
    const modelStep = event.type === "agent.step.started" ? eventStep : context.modelStep;
    const association = {
      loopId: event.loopId,
      ...(modelStep === undefined ? {} : { modelStep }),
      ...(this.currentTaskByRun.get(run.id) ? { taskId: this.currentTaskByRun.get(run.id) } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(providerTurnId ? { providerTurnId } : {}),
    };
    if (event.type === "agent.loop.started") {
      // provider 是端点指纹（model/types.ts 的 ProviderEndpoint）；backend 从中取，
      // 因为它回答"这次 Run 由哪个 agent 执行"，而 model 只回答"用了哪个模型名"。
      const provider = payload.provider;
      const backend = provider && typeof provider === "object" && typeof (provider as { backend?: unknown }).backend === "string" ? (provider as { backend: string }).backend : null;
      this.updateTelemetry(run.executionThreadId, {
        model: typeof payload.model === "string" ? payload.model : null,
        reasoningEffort: typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : null,
        backend,
        startedAt: typeof payload.startedAt === "string" ? payload.startedAt : this.store.now(),
      });
    }
    if (event.type === "agent.model.usage") {
      const usage = normalizeModelUsage(payload);
      if (usage) {
        const thread = this.store.getExecutionThread(run.executionThreadId);
        const current = thread?.telemetry;
        const scope = payload.scope === "total" ? "total" : "turn";
        this.updateTelemetry(run.executionThreadId, {
          usage: mergeModelUsage(current?.usage ?? null, usage, scope),
          usageSource: "provider",
          usageScope: current?.usageScope === "total" || scope === "total" ? "total" : "turn",
        });
      }
    }
    if (event.type === "agent.loop.completed" || event.type === "agent.loop.failed" || event.type === "agent.loop.cancelled" || event.type === "agent.loop.recovery_required") {
      const thread = this.store.getExecutionThread(run.executionThreadId);
      const startedAt = thread?.telemetry?.startedAt ?? null;
      const completedAt = typeof payload.completedAt === "string" ? payload.completedAt : this.store.now();
      const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null;
      this.updateTelemetry(run.executionThreadId, { completedAt, durationMs });
    }
    if (event.type === "agent.step.started" || event.type === "agent.model.completed" || event.type === "agent.context.compacted") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { event: event.type, ...association, ...(eventStep === undefined ? {} : { step: eventStep }) });
      if (event.type === "agent.model.completed") {
        const thread = this.store.getExecutionThread(run.executionThreadId);
        const turnOutput = thread?.journal.filter((entry) => entry.type === "MODEL_OUTPUT" && entry.payload.modelStep === modelStep).map((entry) => String(entry.payload.text ?? "")).join("") ?? "";
        const latestOutput = modelStep === undefined && thread ? thread.journal.filter((entry) => entry.type === "MODEL_OUTPUT").map((entry) => String(entry.payload.text ?? "")).join("") : turnOutput;
        const report = parseExecutorReport(latestOutput);
        if (report) {
          const validTaskIds = new Set(revision.resolvedContract.tasks.map((task) => task.id));
          const activeTaskId = report.activeTaskId && validTaskIds.has(report.activeTaskId) ? report.activeTaskId : undefined;
          const blockedTaskId = report.blockedTaskId && validTaskIds.has(report.blockedTaskId) ? report.blockedTaskId : undefined;
          if (activeTaskId) {
            this.activeTaskByRun.set(run.id, activeTaskId);
            this.currentTaskByRun.set(run.id, activeTaskId);
          } else {
            this.activeTaskByRun.delete(run.id);
            if (blockedTaskId) this.currentTaskByRun.set(run.id, blockedTaskId);
          }
        }
        if (modelStep !== undefined) {
          const pendingCalls = this.providerCallsByStep.get(run.id)?.get(modelStep);
          for (const [callId, tool] of pendingCalls ?? []) {
            this.append(run.executionThreadId, "TOOL_CALL", { action: "status-unknown", callId, tool, source: "provider", reason: "Provider 未返回此调用的结束状态。", ...association });
          }
          this.providerCallsByStep.get(run.id)?.delete(modelStep);
        }
        if (report) {
          this.append(run.executionThreadId, "TASK_PROGRESS", {
            action: "task-status",
            completedTaskIds: report.completedTaskIds,
            ...(report.activeTaskId ? { activeTaskId: report.activeTaskId } : {}),
            ...(report.blockedTaskId ? { blockedTaskId: report.blockedTaskId } : {}),
            ...(report.blockedReason ? { blockedReason: report.blockedReason } : {}),
            ...association,
          });
        }
      }
    }
    if (event.type === "agent.model.text.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text && modelStep !== undefined) this.recordTaskProgressMarkers(run, event, revision, modelStep, text, association);
      const outputTaskId = this.currentTaskByRun.get(run.id);
      this.append(run.executionThreadId, "MODEL_OUTPUT", { text, ...association, ...(outputTaskId ? { taskId: outputTaskId } : {}), ...(typeof payload.providerItemId === "string" ? { providerItemId: payload.providerItemId } : {}) });
    }
    if (event.type === "agent.provider.activity") {
      const itemType = typeof payload.itemType === "string" ? payload.itemType : "provider activity";
      // 中立词表由 gateway 翻译好传上来（见 model/provider-activity.ts）。这里**不重新推断**：
      // 拿不到就显式记 other / unknown，而不是照着 Provider 原生词猜一个像样的答案。
      const activityKind = isProviderActivityKind(payload.activityKind) ? payload.activityKind : "other";
      const outcome = isProviderActivityOutcome(payload.outcome) ? payload.outcome : "unknown";
      const toolLike = activityKind === "tool" || activityKind === "mcp";
      const toolName = toolLike ? safeProviderName(payload.toolName) ?? safeProviderName(payload.title) : undefined;
      const serverName = safeProviderName(payload.serverName);
      const providerStatus = normalizeProviderStatus(payload.status);
      const summary = boundedText(payload.summary, 600);
      const reason = boundedText(payload.error, 600);
      const providerItemId = typeof payload.itemId === "string" ? payload.itemId : typeof payload.providerItemId === "string" ? payload.providerItemId : undefined;
      this.append(run.executionThreadId, "PROVIDER_ACTIVITY", {
        phase: payload.phase === "completed" ? "completed" : "started",
        ...(providerItemId ? { itemId: providerItemId } : {}),
        itemType,
        activityKind,
        outcome,
        // **记下"这一条活动到底是什么"**：命令行的原文、被改动的文件路径都由 Provider 放在 summary 里。
        // 不记它，执行会话就只能显示「命令 · 已完成 · Provider reported success」——说了等于没说，
        // 用户看不懂"它在干什么、为什么"。这是执行线程可读性的关键一条。
        ...(summary ? { summary } : {}),
        ...(toolName ? { toolName } : {}),
        ...(serverName ? { serverName } : {}),
        ...(providerStatus ? { providerStatus } : {}),
        ...(reason ? { reason } : {}),
        ...(providerItemId ? { providerItemId } : {}),
        ...(toolLike && providerItemId ? { callId: providerItemId } : {}),
        ...association,
      });
      const matchingCalls = modelStep === undefined ? undefined : this.providerCallsByStep.get(run.id)?.get(modelStep);
      const matchingTool = providerItemId ? matchingCalls?.get(providerItemId) : undefined;
      if (providerItemId && matchingCalls && matchingTool !== undefined) {
        // 账本的成败判定与 UI 共用同一个 outcome，不再各自维护一份词表（它们的成功词曾经不一致）。
        const action = outcome === "failed" ? "failed" : outcome === "succeeded" ? "completed" : "status-unknown";
        this.append(run.executionThreadId, "TOOL_CALL", { action, callId: providerItemId, tool: matchingTool || toolName || "", source: "provider", ...(reason ? { reason } : action === "status-unknown" ? { reason: "Provider 未提供此调用的结果状态。" } : {}), ...association });
        matchingCalls.delete(providerItemId);
      }
    }
    if (event.type === "agent.tool.requested") {
      const callId = typeof payload.callId === "string" ? payload.callId : undefined;
      const tool = typeof payload.tool === "string" ? payload.tool : undefined;
      const delegatedToProvider = payload.delegatedToProvider === true;
      if (callId && !delegatedToProvider) openToolCalls.add(callId);
      if (callId && delegatedToProvider && modelStep !== undefined) {
        const byStep = this.providerCallsByStep.get(run.id) ?? new Map<number, Map<string, string>>();
        const calls = byStep.get(modelStep) ?? new Map<string, string>();
        calls.set(callId, tool ?? "");
        byStep.set(modelStep, calls);
        this.providerCallsByStep.set(run.id, byStep);
      }
      this.append(run.executionThreadId, "TOOL_CALL", { action: "requested", ...(callId ? { callId } : {}), ...(tool ? { tool } : {}), source: delegatedToProvider ? "provider" : "factory", ...association });
    }
    if (event.type === "agent.tool.completed" || event.type === "agent.tool.denied" || event.type === "agent.tool.failed" || event.type === "agent.tool.needs_reconciliation") {
      const callId = typeof payload.callId === "string" ? payload.callId : undefined;
      if (callId) {
        openToolCalls.delete(callId);
        for (const calls of this.providerCallsByStep.get(run.id)?.values() ?? []) calls.delete(callId);
      }
      const action = event.type.endsWith("denied") ? "denied" : event.type.endsWith("failed") ? "failed" : event.type.endsWith("reconciliation") ? "needs-reconciliation" : "completed";
      const tool = typeof payload.tool === "string" ? payload.tool : undefined;
      const reason = boundedText(payload.reason, 600);
      this.append(run.executionThreadId, "TOOL_CALL", { action, ...(callId ? { callId } : {}), ...(tool ? { tool } : {}), source: "factory", ...(reason ? { reason } : {}), ...association });
    }
    if (event.type === "agent.gate.checked") this.append(run.executionThreadId, "TASK_PROGRESS", { action: payload.action, reason: boundedText(payload.reason, 600), ...association });
    if (event.type === "agent.loop.completed") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "READY_FOR_VERIFY", ...association });
      this.setRunStatus(run, "READY_FOR_VERIFY");
    }
    if (event.type === "agent.loop.failed") {
      const reason = boundedText(payload.reason ?? payload.error, 600) ?? "Executor loop blocked";
      const activeTaskId = this.activeTaskByRun.get(run.id);
      if (activeTaskId) this.append(run.executionThreadId, "TASK_PROGRESS", { action: "task-lifecycle", taskId: activeTaskId, state: "BLOCKED", reason, ...association });
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "BLOCKED", reason, ...association });
      this.activeTaskByRun.delete(run.id);
      this.setRunStatus(run, "BLOCKED", reason);
    }
    if (event.type === "agent.loop.recovery_required") {
      const reason = boundedText(payload.reason ?? payload.error, 600) ?? "Executor recovery required";
      const activeTaskId = this.activeTaskByRun.get(run.id);
      if (activeTaskId) this.append(run.executionThreadId, "TASK_PROGRESS", { action: "task-lifecycle", taskId: activeTaskId, state: "BLOCKED", reason, ...association });
      this.append(run.executionThreadId, "RECOVERY", { reason, ...association });
      this.activeTaskByRun.delete(run.id);
      this.setRunStatus(run, "BLOCKED", reason);
    }
    if (event.type === "agent.loop.cancelled") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "CANCELLED", ...association });
      this.setRunStatus(run, "CANCELLED");
    }
  }

  private recordTaskProgressMarkers(run: Run, event: AgentLoopEvent, revision: PlanRevision, modelStep: number, delta: string, association: Record<string, unknown>): void {
    const buffer = this.taskProgressBuffers.get(run.id);
    if (!buffer || buffer.modelStep !== modelStep) this.taskProgressBuffers.set(run.id, { modelStep, text: delta, scanOffset: 0 });
    else buffer.text += delta;
    const currentBuffer = this.taskProgressBuffers.get(run.id);
    if (!currentBuffer) return;
    const taskIds = new Set(revision.resolvedContract.tasks.map((task) => task.id));
    const markerStart = "<pipeline-factory-task-progress>";
    const markerEnd = "</pipeline-factory-task-progress>";
    const markerPattern = /<pipeline-factory-task-progress>([\s\S]*?)<\/pipeline-factory-task-progress>/g;
    markerPattern.lastIndex = currentBuffer.scanOffset;
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(currentBuffer.text)) !== null) {
      currentBuffer.scanOffset = markerPattern.lastIndex;
      let progress: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(match[1]?.trim() ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) progress = parsed as Record<string, unknown>;
      } catch {
        // Incomplete or malformed progress markers do not change task status.
      }
      if (!progress) continue;
      const taskId = typeof progress.taskId === "string" ? progress.taskId : "";
      const state = progress.state;
      if (!taskIds.has(taskId) || !["started", "completed", "blocked"].includes(String(state))) continue;
      const reason = state === "blocked" ? boundedText(progress.reason, 600) : undefined;
      this.currentTaskByRun.set(run.id, taskId);
      if (state === "started") this.activeTaskByRun.set(run.id, taskId);
      else if (this.activeTaskByRun.get(run.id) === taskId) this.activeTaskByRun.delete(run.id);
      this.append(run.executionThreadId, "TASK_PROGRESS", {
        action: "task-lifecycle",
        state: state === "started" ? "IN_PROGRESS" : state === "completed" ? "DONE" : "BLOCKED",
        ...(reason ? { reason } : state === "blocked" ? { reason: "阻塞原因未记录。" } : {}),
        ...association,
        taskId,
        loopId: event.loopId,
        modelStep,
      });
    }
    const lastStart = currentBuffer.text.lastIndexOf(markerStart);
    const lastEnd = currentBuffer.text.lastIndexOf(markerEnd);
    currentBuffer.scanOffset = lastStart > lastEnd ? lastStart : Math.max(currentBuffer.scanOffset, currentBuffer.text.length - markerStart.length + 1);
  }

  private syncRunTerminalState(run: Run, loop: AgentLoop): void {
    if (loop.state === "COMPLETED") this.setRunStatus(run, "READY_FOR_VERIFY");
    if (loop.state === "BLOCKED" || loop.state === "NEEDS_RECONCILIATION") this.setRunStatus(run, "BLOCKED");
    if (loop.state === "CANCELLED") this.setRunStatus(run, "CANCELLED");
  }

  private setRunStatus(run: Run, status: "READY_FOR_VERIFY" | "BLOCKED" | "CANCELLED", reason?: string): void {
    run.status = status;
    const current = this.store.getRun(run.id);
    if (current) this.store.saveRun({ ...current, status });
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (thread) this.store.saveExecutionThread({ ...thread, state: status === "READY_FOR_VERIFY" ? "COMPLETED" : status === "BLOCKED" ? "BLOCKED" : "CANCELLED" });
    const plan = this.store.getPlan(run.planId);
    if (plan?.runId === run.id) {
      if (status === "BLOCKED") updatePlanStatus(this.store, plan, { status: "BLOCKED", attentionReason: reason ?? "Executor loop blocked", lastEventAt: this.store.now() }, reason ?? "Executor loop blocked");
      else this.store.updatePlan({ ...plan, lastEventAt: this.store.now() });
    }
  }

  private append(threadId: string, type: import("../index.js").JournalEntryType, payload: Record<string, unknown>): void {
    const thread = this.store.getExecutionThread(threadId);
    if (!thread) return;
    const entry = this.store.appendExecutionJournal({ executionThreadId: thread.id, runId: thread.runId, type, payload });
    this.store.appendEvent({ type: "run.executor.event", aggregateId: thread.runId, payload: { executionThreadId: thread.id, type, sequence: entry.sequence, occurredAt: entry.occurredAt, ...entry.payload } });
  }

  private updateTelemetry(threadId: string, update: Partial<ExecutionTelemetry>): void {
    const thread = this.store.getExecutionThread(threadId);
    if (!thread) return;
    const current: ExecutionTelemetry = thread.telemetry ?? { model: null, reasoningEffort: null, backend: null, startedAt: null, completedAt: null, durationMs: null, usage: null, usageSource: "not-recorded", usageScope: null };
    this.store.saveExecutionThread({ ...thread, telemetry: { ...current, ...update } });
  }
}

/**
 * 交给执行者的计划视图。
 *
 * 是**精选视图**，不是整份 `resolvedContract`：`repository`（路径、哈希）与 `execution`
 * （Factory 固定的角色与工具策略）对执行者没用，塞进提示词只是费 token。
 *
 * 为什么必须带上 `design`：技术约束、数据安全、失败处理，以及被 `resolvePlanContract` 并进
 * `technicalConstraints` 的 `dependencies`，都只能从这里到达执行者。代价是具体的：库里反复出现
 * `package.json remains missing in expected project directory`，而那些 Plan 的 dependencies 里
 * 明明写着"需要在 code/ 目录使用仓库现有 package.json 和锁文件安装依赖"——执行者没见过这句话。
 * 曾经拦住这句话的正是那份 V1 投影（`plan/service.ts` 的 `executionContractFromResolved`，
 * 它丢掉了 `design` 整节），那个投影已经删掉，只剩下这一条读法。
 */
function executorPlanView(revision: PlanRevision): unknown {
  const resolved = revision.resolvedContract;
  return {
    objective: resolved.objective,
    design: resolved.design,
    scope: resolved.scope,
    tasks: resolved.tasks,
    dependencies: resolved.dependencies,
    conflicts: resolved.conflicts,
    artifact: resolved.artifact,
    verification: { commandIds: resolved.verification.commandIds },
    merge: resolved.merge,
  };
}

/** 从模型输出提取结构化完成报告；缺失协议块时返回 null 触发完成门禁继续。 */
export function parseExecutorReport(content: string): ExecutorReport | null {
  return parseExecutorReportDetailed(content).report;
}

/**
 * 读取可选字符串字段：缺失、null 与空串一律视为未提供，其他类型仍判非法。
 * 模型经常把用不到的可选字段写成 null，若不归一化会让完成门禁永远无法通过。
 */
function optionalReportField(value: unknown, field: string): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `EXECUTION_REPORT_FIELD_INVALID: ${field}` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

function parseExecutorReportDetailed(content: string): { report: ExecutorReport | null; error?: string } {
  const start = content.lastIndexOf(REPORT_START);
  if (start < 0) return { report: null, error: "EXECUTION_REPORT_MISSING" };
  const jsonStart = start + REPORT_START.length;
  const end = content.indexOf(REPORT_END, jsonStart);
  if (end < 0) return { report: null, error: "EXECUTION_REPORT_INCOMPLETE" };
  try {
    const value = JSON.parse(content.slice(jsonStart, end).trim()) as { completedTaskIds?: unknown; changedPaths?: unknown; pathsWithinScope?: unknown; report?: unknown; activeTaskId?: unknown; blockedTaskId?: unknown; blockedReason?: unknown };
    if (!Array.isArray(value.completedTaskIds) || !value.completedTaskIds.every((taskId) => typeof taskId === "string")) return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: completedTaskIds" };
    const changedPaths = Array.isArray(value.changedPaths) ? value.changedPaths : value.pathsWithinScope;
    if (!Array.isArray(changedPaths) || !changedPaths.every((path) => typeof path === "string")) return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: changedPaths" };
    if (typeof value.report !== "string") return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: report" };
    const activeTaskId = optionalReportField(value.activeTaskId, "activeTaskId");
    if (!activeTaskId.ok) return { report: null, error: activeTaskId.error };
    const blockedTaskId = optionalReportField(value.blockedTaskId, "blockedTaskId");
    if (!blockedTaskId.ok) return { report: null, error: blockedTaskId.error };
    const blockedReason = optionalReportField(value.blockedReason, "blockedReason");
    if (!blockedReason.ok) return { report: null, error: blockedReason.error };
    return { report: { completedTaskIds: value.completedTaskIds, changedPaths, report: value.report, ...(activeTaskId.value === undefined ? {} : { activeTaskId: activeTaskId.value }), ...(blockedTaskId.value === undefined ? {} : { blockedTaskId: blockedTaskId.value }), ...(blockedReason.value === undefined ? {} : { blockedReason: blockedReason.value }) } };
  } catch {
    return { report: null, error: "EXECUTION_REPORT_INVALID_JSON" };
  }
}

/** 通过 Git 实际 diff 校验 Executor 的变更范围；模型报告只提供候选路径，不提供安全结论。 */
export async function inspectWorkspaceScope(input: { workspacePath: string; baseCommit: string; include: string[]; exclude?: string[] }): Promise<WorkspaceScopeInspection> {
  try {
    const [diff, untracked] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", input.baseCommit, "--"], { cwd: input.workspacePath }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: input.workspacePath }),
    ]);
    const changedPaths = [...new Set(`${diff.stdout}\n${untracked.stdout}`.split(/\r?\n/).map((path) => path.trim()).filter(Boolean))];
    const outsidePaths = changedPaths.filter((path) => !matchesAnyPath(path, input.include) || matchesAnyPath(path, input.exclude ?? []));
    return { changedPaths, outsidePaths, pathsWithinScope: outsidePaths.length === 0 };
  } catch (error) {
    throw new Error(`WORKSPACE_SCOPE_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function matchesAnyPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const parts = pattern.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const expression = parts.map((part) => part === "**" ? ".*" : part === "*" ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
    return new RegExp(`^${expression}(?:/.*)?$`).test(path.replaceAll("\\", "/"));
  });
}
