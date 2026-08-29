import { AgentLoopEngine, type AgentLoop, type AgentLoopEvent, type AgentLoopMode, type GateContext } from "./agent-loop.js";
import { TaskProgressGate } from "./termination-gates.js";
import type { ModelGateway, PipelineStore, PlanRevisionV2, Run } from "./index.js";
import type { ToolRuntime } from "./tool-runtime.js";

const REPORT_START = "<pipeline-factory-execution-report>";
const REPORT_END = "</pipeline-factory-execution-report>";

export type ExecutorReport = {
  completedTaskIds: string[];
  pathsWithinScope: boolean;
  report: string;
};

export type ExecutorAgentOptions = {
  maxSteps?: number;
  maxDurationMs?: number;
  maxRepeatedToolCalls?: number;
  maxNoProgressSteps?: number;
  mode?: AgentLoopMode;
};

export class ExecutorAgent {
  private readonly engine: AgentLoopEngine;
  private readonly options: ExecutorAgentOptions;

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, toolRuntime?: ToolRuntime, options: ExecutorAgentOptions = {}) {
    this.options = options;
    this.engine = new AgentLoopEngine(store, model, toolRuntime, {
      defaultMaxSteps: options.maxSteps ?? 40,
      defaultMaxDurationMs: options.maxDurationMs ?? 1_800_000,
      defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls ?? 2,
      defaultMaxNoProgressSteps: options.maxNoProgressSteps ?? 3,
    });
  }

  async start(run: Run, revision: PlanRevisionV2): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const mode = this.options.mode ?? this.model.configFor("executor").loopMode ?? "provider-controlled";
    this.assertCapabilities(mode);
    const openToolCalls = new Set<string>();
    const gate = new TaskProgressGate();
    const evaluate = (context: GateContext) => gate.evaluate({
      ...context,
      ...this.progressContext(run.id, revision, context.content ?? "", openToolCalls),
    });
    const loop = await this.engine.start({
      ownerType: "run",
      ownerId: run.id,
      role: "executor",
      mode,
      maxSteps: this.options.maxSteps ?? 40,
      ...(this.options.maxDurationMs === undefined ? {} : { maxDurationMs: this.options.maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      workspacePath: run.workspacePath!,
      modelRequest: {
        conversationId: run.id,
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

  async run(run: Run, revision: PlanRevisionV2): Promise<AgentLoop> {
    this.assertRunnable(run, revision);
    const mode = this.options.mode ?? this.model.configFor("executor").loopMode ?? "provider-controlled";
    this.assertCapabilities(mode);
    const openToolCalls = new Set<string>();
    const gate = new TaskProgressGate();
    const loop = await this.engine.run({
      ownerType: "run",
      ownerId: run.id,
      role: "executor",
      mode,
      maxSteps: this.options.maxSteps ?? 40,
      ...(this.options.maxDurationMs === undefined ? {} : { maxDurationMs: this.options.maxDurationMs }),
      ...(this.options.maxRepeatedToolCalls === undefined ? {} : { maxRepeatedToolCalls: this.options.maxRepeatedToolCalls }),
      ...(this.options.maxNoProgressSteps === undefined ? {} : { maxNoProgressSteps: this.options.maxNoProgressSteps }),
      workspacePath: run.workspacePath!,
      modelRequest: {
        conversationId: run.id,
        ...(run.workspacePath ? { cwd: run.workspacePath } : {}),
        messages: [
          { role: "system", content: this.systemInstructions(revision) },
          { role: "user", content: `Execute the approved plan: ${revision.planId}@${revision.revision}.` },
        ],
      },
      gate: { evaluate: (context) => gate.evaluate({ ...context, ...this.progressContext(run.id, revision, context.content ?? "", openToolCalls) }) },
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

  private progressContext(runId: string, revision: PlanRevisionV2, content: string, openToolCalls: Set<string>): Pick<GateContext, "allTasksComplete" | "pathsWithinScope" | "reportReady" | "hasOpenToolCalls" | "hasPendingChangeProposal"> {
    const report = parseExecutorReport(content);
    const taskIds = new Set(revision.contract.tasks.map((task) => task.id));
    const completed = report?.completedTaskIds ?? [];
    return {
      allTasksComplete: Boolean(report && completed.length === taskIds.size && completed.every((taskId) => taskIds.has(taskId))),
      pathsWithinScope: report?.pathsWithinScope === true,
      reportReady: Boolean(report?.report.trim()),
      hasOpenToolCalls: openToolCalls.size > 0,
      hasPendingChangeProposal: this.store.listChangeProposals(runId).some((proposal) => proposal.status === "OPEN"),
    };
  }

  private systemInstructions(revision: PlanRevisionV2): string {
    return [
      "You are the Pipeline Factory Executor.",
      `Work only inside the approved include scope: ${revision.contract.include.join(", ")}.`,
      `Never modify excluded or protected paths: ${revision.contract.exclude.join(", ")}.`,
      "Do not claim completion in prose. End with <pipeline-factory-execution-report> JSON </pipeline-factory-execution-report>.",
      "The JSON must contain completedTaskIds, pathsWithinScope, and a non-empty report.",
    ].join(" ");
  }

  private handleEvent(run: Run, event: AgentLoopEvent, openToolCalls: Set<string>): void {
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (!thread) return;
    const payload = event.payload;
    if (event.type === "agent.step.started" || event.type === "agent.model.completed" || event.type === "agent.context.compacted") this.append(thread, "TASK_PROGRESS", { event: event.type, ...payload });
    if (event.type === "agent.model.text.delta") this.append(thread, "MODEL_OUTPUT", { text: payload.text });
    if (event.type === "agent.tool.requested" && typeof payload.callId === "string" && payload.delegatedToProvider !== true) {
      openToolCalls.add(payload.callId);
      this.append(thread, "TOOL_CALL", { action: "requested", ...payload });
    }
    if ((event.type === "agent.tool.completed" || event.type === "agent.tool.denied") && typeof payload.callId === "string") {
      openToolCalls.delete(payload.callId);
      this.append(thread, "TOOL_CALL", { action: event.type.endsWith("denied") ? "denied" : "completed", ...payload });
    }
    if (event.type === "agent.gate.checked") this.append(thread, "TASK_PROGRESS", payload);
    if (event.type === "agent.loop.completed") {
      this.append(thread, "TASK_PROGRESS", { state: "READY_FOR_VERIFY", ...payload });
      this.setRunStatus(run, "READY_FOR_VERIFY");
    }
    if (event.type === "agent.loop.failed") {
      this.append(thread, "TASK_PROGRESS", { state: "BLOCKED", ...payload });
      this.setRunStatus(run, "BLOCKED");
    }
    if (event.type === "agent.loop.cancelled") {
      this.append(thread, "TASK_PROGRESS", { state: "CANCELLED", ...payload });
      this.setRunStatus(run, "CANCELLED");
    }
  }

  private syncRunTerminalState(run: Run, loop: AgentLoop): void {
    if (loop.state === "COMPLETED") this.setRunStatus(run, "READY_FOR_VERIFY");
    if (loop.state === "BLOCKED" || loop.state === "NEEDS_RECONCILIATION") this.setRunStatus(run, "BLOCKED");
    if (loop.state === "CANCELLED") this.setRunStatus(run, "CANCELLED");
  }

  private setRunStatus(run: Run, status: "READY_FOR_VERIFY" | "BLOCKED" | "CANCELLED"): void {
    const current = this.store.getRun(run.id);
    if (current) this.store.saveRun({ ...current, status });
  }

  private append(thread: { journal: Array<{ sequence: number; type: import("./index.js").JournalEntryType; occurredAt: string; payload: Record<string, unknown> }>; id: string; runId: string; state: import("./index.js").ExecutionThreadState }, type: import("./index.js").JournalEntryType, payload: Record<string, unknown>): void {
    thread.journal.push({ sequence: thread.journal.length + 1, type, occurredAt: this.store.now(), payload });
    this.store.saveExecutionThread(thread);
    this.store.appendEvent({ type: "run.executor.event", aggregateId: thread.runId, payload: { executionThreadId: thread.id, type, ...payload } });
  }
}

export function parseExecutorReport(content: string): ExecutorReport | null {
  const start = content.lastIndexOf(REPORT_START);
  if (start < 0) return null;
  const jsonStart = start + REPORT_START.length;
  const end = content.indexOf(REPORT_END, jsonStart);
  if (end < 0) return null;
  try {
    const value = JSON.parse(content.slice(jsonStart, end).trim()) as Partial<ExecutorReport>;
    if (!Array.isArray(value.completedTaskIds) || !value.completedTaskIds.every((taskId) => typeof taskId === "string") || typeof value.pathsWithinScope !== "boolean" || typeof value.report !== "string") return null;
    return { completedTaskIds: value.completedTaskIds, pathsWithinScope: value.pathsWithinScope, report: value.report };
  } catch {
    return null;
  }
}
