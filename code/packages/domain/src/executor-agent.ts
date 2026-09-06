/**
 * 模块职责：构造 Executor Agent 的系统约束、执行报告协议和 Agent Loop。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentLoopEngine, type AgentLoop, type AgentLoopEvent, type AgentLoopMode, type GateContext } from "./agent-loop.js";
import { TaskProgressGate } from "./termination-gates.js";
import { mergeModelUsage, normalizeModelUsage, type ExecutionTelemetry, type ModelGateway, type ModelRoleConfig, type PipelineStore, type PlanRevisionV2, type Run } from "./index.js";
import type { ToolRuntime } from "./tool-runtime.js";

const REPORT_START = "<pipeline-factory-execution-report>";
const REPORT_END = "</pipeline-factory-execution-report>";
const execFileAsync = promisify(execFile);

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
  toolRuntimeFactory?: (run: Run, revision: PlanRevisionV2) => ToolRuntime;
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
  async start(run: Run, revision: PlanRevisionV2): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const projectConfig = this.executorModelConfig(revision);
    const mode = projectConfig.loopMode ?? this.options.mode ?? "provider-controlled";
    const maxDurationMs = revision.projectConfigSnapshot?.settings.concurrency.executionTimeoutMs ?? this.options.maxDurationMs;
    this.assertCapabilities(mode);
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
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      workspacePath: run.workspacePath!,
      ...(toolRuntime ? { toolRuntime } : {}),
      modelRequest: {
        conversationId: run.id,
        modelConfig: projectConfig,
        ...(run.workspacePath ? { cwd: run.workspacePath } : {}),
        messages: [
          { role: "system", content: this.systemInstructions(revision) },
          { role: "user", content: `Execute the approved plan: ${revision.planId}@${revision.revision}.` },
        ],
      },
      gate: { evaluate },
      onEvent: (event) => this.handleEvent(run, event, openToolCalls),
    });
    return loop;
  }

  /** 同步运行 Executor Loop，完成后同步 Run 的终态映射。 */
  async run(run: Run, revision: PlanRevisionV2): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const projectConfig = this.executorModelConfig(revision);
    const mode = projectConfig.loopMode ?? this.options.mode ?? "provider-controlled";
    const maxDurationMs = revision.projectConfigSnapshot?.settings.concurrency.executionTimeoutMs ?? this.options.maxDurationMs;
    this.assertCapabilities(mode);
    const openToolCalls = new Set<string>();
    const gate = new TaskProgressGate();
    const toolRuntime = this.options.toolRuntimeFactory?.(run, revision) ?? this.defaultToolRuntime;
    const loop = await this.engine.run({
      ownerType: "run",
      ownerId: run.id,
      role: "executor",
      mode,
      maxSteps: this.options.maxSteps ?? 40,
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      workspacePath: run.workspacePath!,
      ...(toolRuntime ? { toolRuntime } : {}),
      modelRequest: {
        conversationId: run.id,
        modelConfig: projectConfig,
        ...(run.workspacePath ? { cwd: run.workspacePath } : {}),
        messages: [
          { role: "system", content: this.systemInstructions(revision) },
          { role: "user", content: `Execute the approved plan: ${revision.planId}@${revision.revision}.` },
        ],
      },
      gate: { evaluate: async (context) => gate.evaluate({ ...context, ...(await this.progressContext(run, revision, context.content ?? "", openToolCalls)) }) },
      onEvent: (event) => this.handleEvent(run, event, openToolCalls),
    });
    this.syncRunTerminalState(run, loop);
    return loop;
  }

  wait(loopId: string): Promise<AgentLoop> { return this.engine.wait(loopId); }
  pause(loopId: string, reason: string): Promise<AgentLoop> { return this.engine.pause(loopId, reason); }
  resume(loopId: string): Promise<AgentLoop> { return this.engine.resume(loopId); }
  cancel(loopId: string, reason: string): Promise<AgentLoop> { return this.engine.cancel(loopId, reason); }
  get(loopId: string): AgentLoop { return this.engine.get(loopId); }

  private assertRunnable(run: Run, revision: PlanRevisionV2): void {
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${run.id} must be IN_PROGRESS before Executor starts`);
    if (run.planId !== revision.planId || run.planRevision !== revision.revision) throw new Error("Executor Run and PlanRevision do not match");
    if (!run.workspacePath) throw new Error(`Run ${run.id} has no workspace`);
  }

  private assertCapabilities(mode: AgentLoopMode): void {
    const capabilities = this.model.capabilities?.("executor");
    if (mode === "factory-controlled" && (!capabilities?.supportsToolCalls || !capabilities.supportedLoopModes.includes(mode))) throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
    if (mode === "provider-controlled" && capabilities && !capabilities.supportedLoopModes.includes(mode)) throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
  }

  /** 在 Loop 创建前复制快照配置；后续 Project 配置变化不会影响本次 Run。 */
  private executorModelConfig(revision: PlanRevisionV2): ModelRoleConfig {
    return { ...this.model.configFor("executor"), ...(revision.projectConfigSnapshot?.settings.models.executor ?? {}) };
  }

  private async progressContext(run: Run, revision: PlanRevisionV2, content: string, openToolCalls: Set<string>): Promise<Pick<GateContext, "allTasksComplete" | "changedPaths" | "pathsWithinScope" | "reportReady" | "hasOpenToolCalls" | "hasPendingChangeProposal" | "reportError" | "scopeError">> {
    const parsedReport = parseExecutorReportDetailed(content);
    const report = parsedReport.report;
    const taskIds = new Set(revision.contract.tasks.map((task) => task.id));
    const completed = report?.completedTaskIds ?? [];
    let scope: WorkspaceScopeInspection & { error?: string } = { changedPaths: [], outsidePaths: [], pathsWithinScope: false };
    if (report) {
      if (!this.options.workspaceScopeInspector) scope = { changedPaths: report.changedPaths, outsidePaths: [], pathsWithinScope: true };
      else {
        try {
          scope = await this.options.workspaceScopeInspector({ workspacePath: run.workspacePath!, baseCommit: run.baseCommit, include: revision.contract.include, exclude: revision.contract.exclude });
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
  private systemInstructions(revision: PlanRevisionV2): string {
    const executionContract = {
      planId: revision.planId,
      revision: revision.revision,
      contract: revision.contract,
      projectConfig: revision.projectConfigSnapshot
        ? { version: revision.projectConfigVersion, hash: revision.projectConfigHash, snapshot: revision.projectConfigSnapshot }
        : { legacy: true, note: "This revision predates Project configuration snapshots; use the embedded contract and the runtime settings supplied by the Factory." },
    };
    return [
      "You are the Pipeline Factory Executor.",
      "The approved Plan contract is the source of truth. The Plan is stored by the Factory, not as a file in the worktree; use the embedded contract below and do not search the worktree for a plan document.",
      `Work only inside the approved include scope: ${revision.contract.include.join(", ")}.`,
      `Never modify excluded or protected paths: ${revision.contract.exclude.join(", ")}.`,
      "Do not claim completion in prose. End with <pipeline-factory-execution-report> JSON </pipeline-factory-execution-report>.",
      "The JSON must contain completedTaskIds, changedPaths (or legacy pathsWithinScope array), and a non-empty report. When a task is currently being worked on or blocked, also include activeTaskId or blockedTaskId with blockedReason.",
      `Approved Plan contract:\n${JSON.stringify(executionContract, null, 2)}`,
    ].join(" ");
  }

  /** 把 Loop 事件投影为用户可读的 ExecutionThread journal，同时维护未完成工具集合。 */
  private handleEvent(run: Run, event: AgentLoopEvent, openToolCalls: Set<string>): void {
    if (!this.store.getExecutionThread(run.executionThreadId)) return;
    const payload = event.payload;
    if (event.type === "agent.loop.started") {
      this.updateTelemetry(run.executionThreadId, {
        model: typeof payload.model === "string" ? payload.model : null,
        reasoningEffort: typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : null,
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
      this.append(run.executionThreadId, "TASK_PROGRESS", { event: event.type, ...payload });
      if (event.type === "agent.model.completed") {
        const thread = this.store.getExecutionThread(run.executionThreadId);
        const latestOutput = thread ? thread.journal.filter((entry) => entry.type === "MODEL_OUTPUT").map((entry) => String(entry.payload.text ?? "")).join("") : "";
        const report = parseExecutorReport(latestOutput);
        if (report) {
          this.append(run.executionThreadId, "TASK_PROGRESS", {
            action: "task-status",
            completedTaskIds: report.completedTaskIds,
            ...(report.activeTaskId ? { activeTaskId: report.activeTaskId } : {}),
            ...(report.blockedTaskId ? { blockedTaskId: report.blockedTaskId } : {}),
            ...(report.blockedReason ? { blockedReason: report.blockedReason } : {}),
          });
        }
      }
    }
    if (event.type === "agent.model.text.delta") this.append(run.executionThreadId, "MODEL_OUTPUT", { text: payload.text });
    if (event.type === "agent.tool.requested" && typeof payload.callId === "string" && payload.delegatedToProvider !== true) {
      openToolCalls.add(payload.callId);
      this.append(run.executionThreadId, "TOOL_CALL", { action: "requested", ...payload });
    }
    if ((event.type === "agent.tool.completed" || event.type === "agent.tool.denied" || event.type === "agent.tool.failed" || event.type === "agent.tool.needs_reconciliation") && typeof payload.callId === "string") {
      openToolCalls.delete(payload.callId);
      const action = event.type.endsWith("denied") ? "denied" : event.type.endsWith("failed") ? "failed" : event.type.endsWith("reconciliation") ? "needs-reconciliation" : "completed";
      this.append(run.executionThreadId, "TOOL_CALL", { action, ...payload });
    }
    if (event.type === "agent.gate.checked") this.append(run.executionThreadId, "TASK_PROGRESS", payload);
    if (event.type === "agent.loop.completed") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "READY_FOR_VERIFY", ...payload });
      this.setRunStatus(run, "READY_FOR_VERIFY");
    }
    if (event.type === "agent.loop.failed") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "BLOCKED", ...payload });
      this.setRunStatus(run, "BLOCKED", String(payload.reason ?? payload.error ?? "Executor loop blocked"));
    }
    if (event.type === "agent.loop.recovery_required") {
      this.append(run.executionThreadId, "RECOVERY", payload);
      this.setRunStatus(run, "BLOCKED", String(payload.reason ?? payload.error ?? "Executor recovery required"));
    }
    if (event.type === "agent.loop.cancelled") {
      this.append(run.executionThreadId, "TASK_PROGRESS", { state: "CANCELLED", ...payload });
      this.setRunStatus(run, "CANCELLED");
    }
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
      this.store.updatePlan({ ...plan, ...(status === "BLOCKED" ? { status: "BLOCKED", attentionReason: reason ?? "Executor loop blocked" } : {}), lastEventAt: this.store.now() });
    }
  }

  private append(threadId: string, type: import("./index.js").JournalEntryType, payload: Record<string, unknown>): void {
    const thread = this.store.getExecutionThread(threadId);
    if (!thread) return;
    const entry = { sequence: thread.journal.length + 1, type, occurredAt: this.store.now(), payload };
    this.store.saveExecutionThread({ ...thread, journal: [...thread.journal, entry] });
    this.store.appendEvent({ type: "run.executor.event", aggregateId: thread.runId, payload: { executionThreadId: thread.id, type, ...payload } });
  }

  private updateTelemetry(threadId: string, update: Partial<ExecutionTelemetry>): void {
    const thread = this.store.getExecutionThread(threadId);
    if (!thread) return;
    const current: ExecutionTelemetry = thread.telemetry ?? { model: null, reasoningEffort: null, startedAt: null, completedAt: null, durationMs: null, usage: null, usageSource: "not-recorded", usageScope: null };
    this.store.saveExecutionThread({ ...thread, telemetry: { ...current, ...update } });
  }
}

/** 从模型输出提取结构化完成报告；缺失协议块时返回 null 触发完成门禁继续。 */
export function parseExecutorReport(content: string): ExecutorReport | null {
  return parseExecutorReportDetailed(content).report;
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
    if (value.activeTaskId !== undefined && typeof value.activeTaskId !== "string") return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: activeTaskId" };
    if (value.blockedTaskId !== undefined && typeof value.blockedTaskId !== "string") return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: blockedTaskId" };
    if (value.blockedReason !== undefined && typeof value.blockedReason !== "string") return { report: null, error: "EXECUTION_REPORT_FIELD_INVALID: blockedReason" };
    return { report: { completedTaskIds: value.completedTaskIds, changedPaths, report: value.report, ...(value.activeTaskId === undefined ? {} : { activeTaskId: value.activeTaskId }), ...(value.blockedTaskId === undefined ? {} : { blockedTaskId: value.blockedTaskId }), ...(value.blockedReason === undefined ? {} : { blockedReason: value.blockedReason }) } };
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
