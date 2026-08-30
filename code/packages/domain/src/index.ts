import type { AgentLoop, AgentLoopEvent, AgentLoopRunner, AgentLoopStep, AgentLoopStepInput } from "./agent-loop.js";
import type { MappedCodexRateLimits } from "./codex-rate-limits.js";
import { BuiltinToolExecutor, type BuiltinToolContext, type BuiltinToolExecutorOptions } from "./builtin-tool-executor.js";
import { AgentLoopEngine } from "./agent-loop.js";
import { PlanCompletenessGate } from "./termination-gates.js";
import { composeExplorerTitle, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle, type ExplorerTitleGenerator, type ExplorerTitleSource, type ExplorerTitleStatus } from "./explorer-title.js";
import { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project.js";
import type { Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings } from "./project.js";
export { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project.js";
export type { CreateProjectInput, Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings, ProjectSettingsInput, ProjectStatus, ProjectSummary, UpdateProjectInput } from "./project.js";
export { projectExplorerActivity } from "./explorer-activity.js";
export type { ExplorerActivityInput, ExplorerActivityItem, ExplorerActivityKind } from "./explorer-activity.js";
export { composeExplorerTitle, explorerTimestamp, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle } from "./explorer-title.js";
export type { ExplorerTitleGenerator, ExplorerTitleSource, ExplorerTitleStatus } from "./explorer-title.js";

export type { AgentLoop, AgentLoopInput, AgentLoopMode, AgentLoopResult, AgentLoopState, AgentLoopStep, AgentLoopStepInput, AgentLoopStepStatus, AgentLoopRunner, AgentStepType, GateContext, GateDecision, TerminationGate } from "./agent-loop.js";
export { AgentLoopEngine } from "./agent-loop.js";
export { PlanCompletenessGate, TaskProgressGate } from "./termination-gates.js";
export { ExecutorAgent, parseExecutorReport } from "./executor-agent.js";
export type { ExecutorAgentOptions, ExecutorReport } from "./executor-agent.js";
export { RecoveryCoordinator } from "./recovery-coordinator.js";
export { mapCodexRateLimits } from "./codex-rate-limits.js";
export type { CodexRateLimitBucket, CodexRateLimitWindow, CodexRateLimitsResponse, MappedCodexRateLimits, MappedRateLimit } from "./codex-rate-limits.js";
export { BuiltinToolExecutor } from "./builtin-tool-executor.js";
export type { BuiltinToolContext, BuiltinToolExecutorOptions } from "./builtin-tool-executor.js";
export { DurableToolRuntime } from "./tool-runtime.js";
export type { ToolExecutionContext, ToolRuntime } from "./tool-runtime.js";
export { McpClient, McpToolRegistry } from "./mcp.js";
export type { McpClientOptions, McpRpcTransport, McpServerConfig, McpToolCallResult, McpToolDefinition, McpToolRegistryOptions, QualifiedMcpTool } from "./mcp.js";
export { PluginRegistry, PluginToolBridge } from "./plugin.js";
export type { PluginManifest, PluginRegistryOptions, PluginStatus, PluginTool, PluginToolDefinition, PluginToolHandler } from "./plugin.js";
export { ComputerUseBridge } from "./computer-use.js";
export type { ComputerUseAction, ComputerUseBridgeOptions, ComputerUseEvent, ComputerUseHostAdapter, ComputerUseScreenshot } from "./computer-use.js";

export type PlanStatus =
  | "DRAFT"
  | "DISCARDED"
  | "DESIGNED"
  | "PLANNED"
  | "READY"
  | "QUEUED"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "MERGE_READY"
  | "MERGED"
  | "BLOCKED"
  | "NEEDS_PLAN_CHANGE";

export type ExplorerThreadState = "ACTIVE" | "WAITING_FOR_INPUT" | "COMPRESSED" | "ARCHIVED";

export type PlanExplorationStatus = "INCOMPLETE" | "READY";

export type PlanExploration = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  candidatePlanId: string | null;
  lastAssessedTurnId: string | null;
};

export const REQUIRED_PLAN_AREAS = [
  "目标与用户范围",
  "功能范围与排除项",
  "技术方案与关键约束",
  "数据、安全与异常处理",
  "验收标准与验证命令",
  "实施任务、依赖与冲突",
  "合并策略与人工确认",
] as const;

export const EXPLORER_PLAN_INSTRUCTIONS = `
你是 Pipeline Factory 的 Plan Explorer。你的职责是围绕用户需求持续探索，直到形成可执行的完整设计方案；一次普通 turn 结束不代表探索完成。
先分析目标、用户范围、功能边界、技术方案、数据与安全、异常处理、验收标准、实施任务、依赖、冲突、验证和合并策略。把当前所有互不依赖且需要用户决策的问题合并到一次原生 item/tool/requestUserInput 请求中；不要在普通文本中把问题伪装成选择题。收到答案后重新检查仍未决的关键项，仍有缺口就继续提问或继续探索。
只有所有关键项都已确认，才能输出完整方案。完整方案必须在普通说明之后追加以下机器可校验协议块，JSON 必须是严格 JSON，不要使用 Markdown 代码围栏：
<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>
<pipeline-factory-plan>{"title":"...","goal":"...","acceptanceCriteria":["..."],"include":["..."],"exclude":["..."],"baseBranch":"...","baseCommit":"...","tasks":[{"id":"task-1","title":"...","dependencies":[],"status":"READY"}],"conflictKeys":[],"executorModelRole":"executor","toolPolicy":"executor-scoped-write","verificationCommandIds":["project.test"],"maxRepairAttempts":2,"mergeStrategy":"manual","requireHumanMerge":true}</pipeline-factory-plan>
不要在缺少关键决策时输出 READY；不要把“已记录某个选择”当作完整方案。`;

export type ExplorerThread = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  titleSource: ExplorerTitleSource;
  titleStatus: ExplorerTitleStatus;
  contextMode: "FRESH" | "EXPLICIT_CONTINUATION" | "LEGACY";
  originThreadId: string | null;
  parentThreadId: string | null;
  providerThreadId: string | null;
  state: ExplorerThreadState;
  messageCount: number;
  summaryRef: string | null;
  lastActivityAt: string;
  exploration: PlanExploration;
};

export type ExplorerTurn = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status?: "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "COMPLETED" | "FAILED" | "CANCELLED";
  error?: string;
  createdAt: string;
  sequence: number;
};

export type PlanTask = {
  id: string;
  title: string;
  dependencies: string[];
  status: "PENDING" | "READY" | "DONE";
};

export type PlanContract = {
  goal: string;
  acceptanceCriteria: string[];
  include: string[];
  exclude: string[];
  baseBranch: string;
  baseCommit: string;
  tasks: PlanTask[];
  conflictKeys: string[];
  executorModelRole: string;
  toolPolicy: string;
  verificationCommandIds: string[];
  maxRepairAttempts: number;
  mergeStrategy: "manual" | "fast-forward" | "squash";
  requireHumanMerge: boolean;
};

export type CandidatePlan = {
  id: string;
  projectId: string;
  sourceExplorerThreadId: string;
  sourceTurnId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  title: string;
  revision: number;
  status: PlanStatus;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  queuedAt: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  contract: PlanContract;
};

export type ChangeProposalStatus = "OPEN" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export type ChangeProposal = Readonly<{
  id: string;
  runId: string;
  planId: string;
  reason: string;
  requestedChanges: string[];
  contract: PlanContract;
  status: ChangeProposalStatus;
  createdAt: string;
  createdBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  revision: number | null;
}>;

export type ApprovedChangeProposal = {
  proposal: ChangeProposal;
  plan: CandidatePlan;
  revision: PlanRevisionV2;
  run: Run | null;
};

export type PlanRevisionV2 = Readonly<{
  planId: string;
  revision: number;
  contract: Readonly<PlanContract>;
  artifactHash: string;
  confirmedBy: string;
  confirmedAt: string;
  sourceExplorerThreadId: string;
  projectConfigVersion?: number;
  projectConfigHash?: string;
  projectConfigSnapshot?: ProjectExecutionSnapshot;
}>;

export type PlanIndexRow = {
  planId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  sourceTurnId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  createdAt: string;
  queuedAt: string;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
};

export type DomainEvent = {
  id: string;
  sequence: number;
  type:
    | "project.created"
    | "project.config.updated"
    | "project.archived"
    | "project.activated"
    | "project.explorer.selected"
    | "explorer.thread.created"
    | "explorer.created"
    | "explorer.title.updated"
    | "explorer.archived"
    | "explorer.activated"
    | "explorer.continued"
    | "explorer.turn.accepted"
    | "explorer.turn.text.delta"
    | "explorer.turn.input_required"
    | "explorer.turn.input.resolved"
    | "explorer.turn.completed"
    | "explorer.turn.failed"
    | "explorer.turn.cancelled"
    | "explorer.thread.state.changed"
    | "explorer.plan.incomplete"
    | "explorer.plan.ready"
    | "plan.candidate.created"
    | "plan.discarded"
    | "plan.confirmed"
    | "plan.enqueued"
    | "change.proposal.created"
    | "change.proposal.approved"
    | "change.proposal.rejected"
    | "hook.started"
    | "hook.completed"
    | "hook.failed"
    | "hook.skipped"
    | "run.paused"
    | "run.resumed"
    | "run.guidance.added"
    | "run.recovery_required"
    | "run.executor.event"
    | "verification.completed"
    | "merge.request.created"
    | "merge.confirmed"
    | "agent.loop.started"
    | "agent.loop.resumed"
    | "agent.loop.paused"
    | "agent.loop.cancelled"
    | "agent.loop.completed"
    | "agent.loop.failed"
    | "agent.loop.recovery_required"
    | "agent.step.model_started"
    | "agent.step.model_text_delta"
    | "agent.step.model_completed"
    | "agent.step.tool_requested"
    | "agent.step.tool_denied"
    | "agent.step.tool_completed"
    | "agent.step.tool_failed"
    | "agent.step.tool_needs_reconciliation"
    | "agent.step.input_required"
    | "agent.step.input_resolved"
    | "agent.step.context_compacted"
    | "agent.step.gate_checked"
    | "agent.step.loop_suspended"
    | "agent.step.loop_resumed"
    | "agent.step.loop_completed"
    | "agent.step.loop_failed"
    | "agent.provider.thread.started"
    | "agent.model.text.delta"
    | "agent.model.completed"
    | "agent.input.required"
    | "agent.input.resolved"
    | "agent.tool.requested"
    | "agent.tool.running"
    | "agent.tool.denied"
    | "agent.tool.completed"
    | "agent.tool.failed"
    | "agent.tool.needs_reconciliation"
    | "agent.gate.checked"
    | "agent.context.compacted";
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type CreateCandidatePlanInput = {
  projectId: string;
  sourceExplorerThreadId: string;
  title: string;
  contract?: PlanContract | undefined;
  sourceTurnId?: string | null | undefined;
  providerThreadId?: string | null | undefined;
  providerTurnId?: string | null | undefined;
  providerItemId?: string | null | undefined;
};

export type RegisterThreadInput = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  providerThreadId?: string | undefined;
  title?: string | undefined;
  contextMode?: "FRESH" | "EXPLICIT_CONTINUATION" | "LEGACY" | undefined;
  originThreadId?: string | null | undefined;
  createdAt?: string | undefined;
};

export type CreateExplorerInput = {
  projectId: string;
  title?: string | undefined;
  originThreadId?: string | undefined;
  createdAt?: string | undefined;
};

export type HookDefinition = {
  commandId: string;
  enabled?: boolean | undefined;
  timeoutMs?: number | undefined;
};

export type HookContext = {
  projectId: string;
  runId: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  exitReason: string;
};

export type CommandInvocation = {
  commandId: string;
  cwd: string;
  timeoutMs: number;
  context: HookContext;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CommandExecutor = (command: CommandInvocation) => Promise<CommandResult>;

export type ModelInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type ModelInputRequest = {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ModelInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
};

export type ModelInputAnswers = Record<string, { answers: string[] }>;

export type ExplorerInputRequestStatus = "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "AUTO_RESOLVED" | "RECOVERY_REQUIRED";

export type ExplorerInputRequest = {
  id: string;
  threadId: string;
  localTurnId: string;
  providerRequestId: string | number;
  providerThreadId: string;
  providerTurnId: string;
  itemId: string;
  questions: ModelInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
  status: ExplorerInputRequestStatus;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
};

export type HookRunResult = {
  hook: "start" | "cleanup";
  status: "completed" | "failed" | "skipped";
  blocked: boolean;
  needsAttention: boolean;
  result: CommandResult | null;
};

export type PipelineStore = {
  now(): string;
  nextId(prefix: string): string;
  saveThread(input: RegisterThreadInput): ExplorerThread;
  getThread(id: string): ExplorerThread | undefined;
  listThreads(): ExplorerThread[];
  updateThread(thread: ExplorerThread): ExplorerThread;
  saveProject(project: Project): Project;
  getProject(projectId: string): Project | undefined;
  listProjects(): Project[];
  updateProject(project: Project): Project;
  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision;
  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[];
  saveTurn(turn: ExplorerTurn): ExplorerTurn;
  updateTurn(turn: ExplorerTurn): ExplorerTurn;
  listTurns(threadId: string): ExplorerTurn[];
  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest;
  getInputRequest(id: string): ExplorerInputRequest | undefined;
  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[];
  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest;
  savePlan(plan: CandidatePlan): CandidatePlan;
  getPlan(id: string): CandidatePlan | undefined;
  listPlans(): CandidatePlan[];
  updatePlan(plan: CandidatePlan): CandidatePlan;
  saveRevision(revision: PlanRevisionV2): PlanRevisionV2;
  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined;
  saveChangeProposal(proposal: ChangeProposal): ChangeProposal;
  getChangeProposal(id: string): ChangeProposal | undefined;
  listChangeProposals(runId?: string): ChangeProposal[];
  updateChangeProposal(proposal: ChangeProposal): ChangeProposal;
  saveRun(run: Run): Run;
  getRun(runId: string): Run | undefined;
  listRuns(): Run[];
  saveExecutionThread(thread: ExecutionThread): ExecutionThread;
  getExecutionThread(threadId: string): ExecutionThread | undefined;
  saveVerificationRun(verification: VerificationRun): VerificationRun;
  getVerificationRun(runId: string): VerificationRun | undefined;
  listVerificationRuns(runId?: string): VerificationRun[];
  saveMergeRequest(request: MergeRequest): MergeRequest;
  getMergeRequest(requestId: string): MergeRequest | undefined;
  findMergeRequestByRun(runId: string): MergeRequest | undefined;
  listMergeRequests(): MergeRequest[];
  updateMergeRequest(request: MergeRequest): MergeRequest;
  saveAgentLoop(loop: AgentLoop): AgentLoop;
  getAgentLoop(loopId: string): AgentLoop | undefined;
  listAgentLoops(ownerId?: string): AgentLoop[];
  updateAgentLoop(loop: AgentLoop): AgentLoop;
  appendAgentLoopStep(step: AgentLoopStepInput): AgentLoopStep;
  listAgentLoopSteps(loopId: string): AgentLoopStep[];
  recoverAgentLoops(): AgentLoop[];
  saveToolCall(call: PersistedToolCall): PersistedToolCall;
  getToolCall(callId: string): PersistedToolCall | undefined;
  listToolCalls(loopId?: string): PersistedToolCall[];
  updateToolCall(call: PersistedToolCall): PersistedToolCall;
  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent;
  listEvents(options?: { afterSequence?: number; aggregateId?: string }): DomainEvent[];
  getLastEventSequence(aggregateId?: string): number;
  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined;
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void;
};

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

function defaultPlanExploration(): PlanExploration {
  return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], candidatePlanId: null, lastAssessedTurnId: null };
}

export type PlanArtifact = { title: string; contract: PlanContract };
export type PlanCompletionAssessment = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  artifact: PlanArtifact | null;
};

export function assessPlanCompletion(content: string): PlanCompletionAssessment {
  const status = content.match(/<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/i)?.[1]?.toUpperCase();
  const artifactText = content.match(/<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/i)?.[1];
  if (status !== "READY" || !artifactText) return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], artifact: null };

  let parsed: unknown;
  try { parsed = JSON.parse(artifactText); } catch { return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], artifact: null }; }
  if (!isRecord(parsed)) return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], artifact: null };
  const missing: string[] = [];
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) missing.push("方案标题");
  const contract = parsed as Partial<PlanContract>;
  if (typeof contract.goal !== "string" || !contract.goal.trim()) missing.push("目标与用户范围");
  if (!isNonEmptyStringArray(contract.acceptanceCriteria)) missing.push("验收标准与验证命令");
  if (!isStringArray(contract.include) || !isStringArray(contract.exclude)) missing.push("功能范围与排除项");
  if (typeof contract.baseBranch !== "string" || !contract.baseBranch.trim() || typeof contract.baseCommit !== "string" || !contract.baseCommit.trim()) missing.push("基线 Branch 与 Commit");
  if (!Array.isArray(contract.tasks) || contract.tasks.length === 0 || contract.tasks.some((task) => !isRecord(task) || typeof task.id !== "string" || !task.id.trim() || typeof task.title !== "string" || !task.title.trim() || !isStringArray(task.dependencies))) missing.push("实施任务、依赖与冲突");
  if (!isStringArray(contract.conflictKeys)) missing.push("实施任务、依赖与冲突");
  if (typeof contract.executorModelRole !== "string" || !contract.executorModelRole.trim() || typeof contract.toolPolicy !== "string" || !contract.toolPolicy.trim()) missing.push("Executor 模型与 ToolPolicy");
  if (!isNonEmptyStringArray(contract.verificationCommandIds)) missing.push("验收标准与验证命令");
  if (typeof contract.maxRepairAttempts !== "number" || contract.maxRepairAttempts < 0 || !Number.isInteger(contract.maxRepairAttempts)) missing.push("修复次数上限");
  if (contract.mergeStrategy !== "manual" && contract.mergeStrategy !== "fast-forward" && contract.mergeStrategy !== "squash") missing.push("合并策略与人工确认");
  if (contract.requireHumanMerge !== true) missing.push("合并策略与人工确认");
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) return { status: "INCOMPLETE", missing: uniqueMissing, completed: REQUIRED_PLAN_AREAS.filter((area) => !uniqueMissing.includes(area)), artifact: null };
  return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], artifact: { title, contract: contract as PlanContract } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((item) => item.trim().length > 0);
}

function parseStringArray(value: unknown, fallback: string[]): string[] {
  if (typeof value !== "string") return [...fallback];
  try { const parsed: unknown = JSON.parse(value); return isStringArray(parsed) ? parsed : [...fallback]; } catch { return [...fallback]; }
}

const LEGACY_AUTO_TITLES = new Set(["New Explorer", "Previous exploration", "ExplorerThread"]);

function threadTitleMetadata(title: string | undefined, createdAt: string): { title: string; titleSource: ExplorerTitleSource; titleStatus: ExplorerTitleStatus } {
  const normalized = title?.trim();
  if (!normalized || LEGACY_AUTO_TITLES.has(normalized)) return { title: placeholderExplorerTitle(createdAt), titleSource: "AUTO", titleStatus: "PLACEHOLDER" };
  return { title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED" };
}

function buildContinuationPrompt(missing: string[]): string {
  const areas = missing.length > 0 ? missing.join("、") : "所有仍未明确的关键决策";
  return `继续完善当前需求的完整设计方案。当前仍缺少：${areas}。请先检查这些缺口；如果需要用户决策，请使用原生 item/tool/requestUserInput 一次询问当前可同时确认的问题。只有全部缺口解决后，才输出完整的 pipeline-factory-plan READY 协议块。`;
}

function stripPlanProtocol(content: string): string {
  return content
    .replace(/<pipeline-factory-plan-status>[\s\S]*?<\/pipeline-factory-plan-status>/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*?<\/pipeline-factory-plan>/gi, "")
    .trim();
}

export class InMemoryPipelineStore implements PipelineStore {
  private readonly projects = new Map<string, Project>();
  private readonly projectConfigRevisions = new Map<string, ProjectConfigRevision[]>();
  private readonly plans = new Map<string, CandidatePlan>();
  private readonly revisions = new Map<string, PlanRevisionV2>();
  private readonly changeProposals = new Map<string, ChangeProposal>();
  private readonly runs = new Map<string, Run>();
  private readonly executionThreads = new Map<string, ExecutionThread>();
  private readonly verificationRuns = new Map<string, VerificationRun>();
  private readonly mergeRequests = new Map<string, MergeRequest>();
  private readonly agentLoops = new Map<string, AgentLoop>();
  private readonly agentLoopSteps = new Map<string, AgentLoopStep[]>();
  private readonly toolCalls = new Map<string, PersistedToolCall>();
  private readonly turns = new Map<string, ExplorerTurn[]>();
  private readonly threads = new Map<string, ExplorerThread>();
  private readonly events: DomainEvent[] = [];
  private readonly inputRequests = new Map<string, ExplorerInputRequest>();
  private readonly idempotency = new Map<string, Record<string, unknown>>();
  private sequence = 0;
  private eventSequence = 0;

  now(): string {
    this.sequence += 1;
    return new Date(Date.now() + this.sequence).toISOString();
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString(36)}`;
  }

  saveThread(input: RegisterThreadInput): ExplorerThread {
    const createdAt = input.createdAt ?? this.now();
    const title = threadTitleMetadata(input.title, createdAt);
    const thread: ExplorerThread = {
      id: input.id,
      projectId: input.projectId,
      ...title,
      createdAt,
      contextMode: input.contextMode ?? "FRESH",
      originThreadId: input.originThreadId ?? null,
      parentThreadId: input.parentThreadId,
      providerThreadId: input.providerThreadId ?? null,
      state: "ACTIVE",
      messageCount: 0,
      summaryRef: null,
      lastActivityAt: this.now(),
      exploration: defaultPlanExploration(),
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  getThread(id: string): ExplorerThread | undefined {
    return this.threads.get(id);
  }

  listThreads(): ExplorerThread[] {
    return [...this.threads.values()];
  }

  updateThread(thread: ExplorerThread): ExplorerThread { this.threads.set(thread.id, thread); return thread; }
  saveProject(project: Project): Project { this.projects.set(project.id, project); return project; }
  getProject(projectId: string): Project | undefined { return this.projects.get(projectId); }
  listProjects(): Project[] { return [...this.projects.values()]; }
  updateProject(project: Project): Project {
    if (!this.projects.has(project.id)) throw new Error(`Project ${project.id} does not exist`);
    this.projects.set(project.id, project);
    return project;
  }
  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision {
    const revisions = this.projectConfigRevisions.get(revision.projectId) ?? [];
    if (!revisions.some((item) => item.version === revision.version)) revisions.push(revision);
    this.projectConfigRevisions.set(revision.projectId, revisions);
    return revisions.find((item) => item.version === revision.version)!;
  }
  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[] { return [...(this.projectConfigRevisions.get(projectId) ?? [])]; }
  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    const current = this.turns.get(turn.threadId) ?? [];
    current.push(turn);
    this.turns.set(turn.threadId, current);
    return turn;
  }
  updateTurn(turn: ExplorerTurn): ExplorerTurn {
    const current = this.turns.get(turn.threadId) ?? [];
    const index = current.findIndex((item) => item.id === turn.id);
    if (index < 0) throw new Error(`Turn ${turn.id} does not exist`);
    current[index] = turn;
    return turn;
  }
  listTurns(threadId: string): ExplorerTurn[] { return [...(this.turns.get(threadId) ?? [])]; }

  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    const existing = [...this.inputRequests.values()].find((item) => item.providerThreadId === request.providerThreadId && item.providerTurnId === request.providerTurnId && item.providerRequestId === request.providerRequestId);
    if (existing) return existing;
    if (request.isBlocking && [...this.inputRequests.values()].some((item) => item.threadId === request.threadId && item.isBlocking && item.status === "OPEN")) throw new Error(`ExplorerThread ${request.threadId} already has an open blocking input request`);
    this.inputRequests.set(request.id, request);
    return request;
  }
  getInputRequest(id: string): ExplorerInputRequest | undefined { return this.inputRequests.get(id); }
  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[] {
    return [...this.inputRequests.values()].filter((request) => request.threadId === threadId && (!status || request.status === status));
  }
  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    if (!this.inputRequests.has(request.id)) throw new Error(`Input request ${request.id} does not exist`);
    this.inputRequests.set(request.id, request);
    return request;
  }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.plans.set(plan.id, plan);
    return plan;
  }

  getPlan(id: string): CandidatePlan | undefined {
    return this.plans.get(id);
  }

  listPlans(): CandidatePlan[] {
    return [...this.plans.values()];
  }

  updatePlan(plan: CandidatePlan): CandidatePlan {
    if (!this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} does not exist`);
    }
    this.plans.set(plan.id, plan);
    return plan;
  }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.revisions.set(`${revision.planId}:${revision.revision}`, revision);
    return revision;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    return this.revisions.get(`${planId}:${revision}`);
  }

  saveChangeProposal(proposal: ChangeProposal): ChangeProposal {
    if (this.changeProposals.has(proposal.id)) return this.changeProposals.get(proposal.id)!;
    this.changeProposals.set(proposal.id, proposal);
    return proposal;
  }
  getChangeProposal(id: string): ChangeProposal | undefined { return this.changeProposals.get(id); }
  listChangeProposals(runId?: string): ChangeProposal[] { return [...this.changeProposals.values()].filter((proposal) => !runId || proposal.runId === runId); }
  updateChangeProposal(proposal: ChangeProposal): ChangeProposal {
    if (!this.changeProposals.has(proposal.id)) throw new Error(`ChangeProposal ${proposal.id} does not exist`);
    this.changeProposals.set(proposal.id, proposal);
    return proposal;
  }

  saveRun(run: Run): Run { this.runs.set(run.id, run); return run; }
  getRun(runId: string): Run | undefined { return this.runs.get(runId); }
  listRuns(): Run[] { return [...this.runs.values()]; }
  saveExecutionThread(thread: ExecutionThread): ExecutionThread { this.executionThreads.set(thread.id, thread); return thread; }
  getExecutionThread(threadId: string): ExecutionThread | undefined { return this.executionThreads.get(threadId); }
  saveVerificationRun(verification: VerificationRun): VerificationRun {
    if (!this.verificationRuns.has(verification.id)) this.verificationRuns.set(verification.id, verification);
    return this.verificationRuns.get(verification.id)!;
  }
  getVerificationRun(runId: string): VerificationRun | undefined { return this.listVerificationRuns(runId).at(-1); }
  listVerificationRuns(runId?: string): VerificationRun[] { return [...this.verificationRuns.values()].filter((verification) => !runId || verification.runId === runId).sort((a, b) => a.completedAt.localeCompare(b.completedAt)); }
  saveMergeRequest(request: MergeRequest): MergeRequest { if (!this.mergeRequests.has(request.id)) this.mergeRequests.set(request.id, request); return this.mergeRequests.get(request.id)!; }
  getMergeRequest(requestId: string): MergeRequest | undefined { return this.mergeRequests.get(requestId); }
  findMergeRequestByRun(runId: string): MergeRequest | undefined { return this.listMergeRequests().find((request) => request.runId === runId); }
  listMergeRequests(): MergeRequest[] { return [...this.mergeRequests.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  updateMergeRequest(request: MergeRequest): MergeRequest { if (!this.mergeRequests.has(request.id)) throw new Error(`MergeRequest ${request.id} does not exist`); this.mergeRequests.set(request.id, request); return request; }

  saveAgentLoop(loop: AgentLoop): AgentLoop { this.agentLoops.set(loop.id, loop); return loop; }
  getAgentLoop(loopId: string): AgentLoop | undefined { return this.agentLoops.get(loopId); }
  listAgentLoops(ownerId?: string): AgentLoop[] { return [...this.agentLoops.values()].filter((loop) => !ownerId || loop.ownerId === ownerId); }
  updateAgentLoop(loop: AgentLoop): AgentLoop {
    if (!this.agentLoops.has(loop.id)) throw new Error(`AgentLoop ${loop.id} does not exist`);
    this.agentLoops.set(loop.id, loop);
    return loop;
  }
  appendAgentLoopStep(input: AgentLoopStepInput): AgentLoopStep {
    const current = this.agentLoopSteps.get(input.loopId) ?? [];
    const step: AgentLoopStep = { ...input, callId: input.callId ?? null, providerThreadId: input.providerThreadId ?? null, providerTurnId: input.providerTurnId ?? null, sequence: current.length + 1, occurredAt: input.occurredAt ?? this.now() };
    current.push(step);
    this.agentLoopSteps.set(input.loopId, current);
    return step;
  }
  listAgentLoopSteps(loopId: string): AgentLoopStep[] { return [...(this.agentLoopSteps.get(loopId) ?? [])]; }
  recoverAgentLoops(): AgentLoop[] { return this.listAgentLoops().filter((loop) => loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED"); }
  saveToolCall(call: PersistedToolCall): PersistedToolCall { if (!this.toolCalls.has(call.callId)) this.toolCalls.set(call.callId, call); return this.toolCalls.get(call.callId)!; }
  getToolCall(callId: string): PersistedToolCall | undefined { return this.toolCalls.get(callId); }
  listToolCalls(loopId?: string): PersistedToolCall[] { return [...this.toolCalls.values()].filter((call) => !loopId || call.loopId === loopId); }
  updateToolCall(call: PersistedToolCall): PersistedToolCall { if (!this.toolCalls.has(call.callId)) throw new Error(`Tool call ${call.callId} does not exist`); this.toolCalls.set(call.callId, call); return call; }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent {
    const saved: DomainEvent = { ...event, id: this.nextId("event"), sequence: ++this.eventSequence, occurredAt: this.now() };
    this.events.push(saved);
    return saved;
  }

  listEvents(options: { afterSequence?: number; aggregateId?: string } = {}): DomainEvent[] {
    return this.events.filter((event) => event.sequence > (options.afterSequence ?? 0) && (!options.aggregateId || event.aggregateId === options.aggregateId));
  }

  getLastEventSequence(aggregateId?: string): number {
    return this.events.filter((event) => !aggregateId || event.aggregateId === aggregateId).at(-1)?.sequence ?? 0;
  }

  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined { return this.idempotency.get(`${scope}:${key}`); }
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void { this.idempotency.set(`${scope}:${key}`, result); }
}

type SqliteRow = Record<string, unknown>;

function parseRequestId(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

export class SqlitePipelineStore implements PipelineStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS factory_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_root TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        status TEXT NOT NULL,
        current_explorer_thread_id TEXT,
        config_version INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE TABLE IF NOT EXISTS project_config_revisions (
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, version)
      );
      CREATE TABLE IF NOT EXISTS explorer_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New Explorer',
        created_at TEXT,
        title_source TEXT NOT NULL DEFAULT 'AUTO',
        title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER',
        context_mode TEXT NOT NULL DEFAULT 'FRESH',
        origin_thread_id TEXT,
        parent_thread_id TEXT,
        provider_thread_id TEXT,
        state TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary_ref TEXT,
        last_activity_at TEXT NOT NULL,
        exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE',
        exploration_missing_json TEXT NOT NULL DEFAULT '[]',
        exploration_completed_json TEXT NOT NULL DEFAULT '[]',
        candidate_plan_id TEXT,
        last_assessed_turn_id TEXT
      );
      CREATE TABLE IF NOT EXISTS explorer_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        error TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        source_turn_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        queued_at TEXT,
        run_id TEXT,
        last_event_at TEXT NOT NULL,
        attention_reason TEXT,
        contract_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        project_config_version INTEGER,
        project_config_hash TEXT,
        project_config_snapshot_json TEXT,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS change_proposals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_changes_json TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        revision INTEGER
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        branch TEXT NOT NULL,
        workspace_path TEXT,
        base_commit TEXT NOT NULL,
        execution_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_threads (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        journal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        repair_attempts INTEGER NOT NULL,
        command_results_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS merge_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        status TEXT NOT NULL,
        human_confirmation_required INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        merged_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_loops (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        role TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        max_steps INTEGER NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        checkpoint_json TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_loop_steps (
        loop_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        status TEXT NOT NULL,
        call_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY(loop_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        call_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        role TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explorer_input_requests (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        local_turn_id TEXT NOT NULL,
        provider_request_id TEXT NOT NULL,
        provider_thread_id TEXT NOT NULL,
        provider_turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        is_blocking INTEGER NOT NULL,
        auto_resolution_ms INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        answered_by TEXT,
        redacted_answer_summary_json TEXT,
        UNIQUE(provider_thread_id, provider_turn_id, provider_request_id)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      );
    `);
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title TEXT NOT NULL DEFAULT 'New Explorer'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN created_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'AUTO'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER'"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET created_at = COALESCE(created_at, (SELECT MIN(created_at) FROM explorer_turns WHERE explorer_turns.thread_id = explorer_threads.id), last_activity_at) WHERE created_at IS NULL").run();
    this.database.prepare("UPDATE explorer_threads SET title_source = 'MANUAL', title_status = 'GENERATED' WHERE title NOT IN ('New Explorer', 'Previous exploration', 'ExplorerThread') AND title_source = 'AUTO' AND title_status = 'PLACEHOLDER'").run();
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'FRESH'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN origin_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET context_mode = 'LEGACY' WHERE title = 'New Explorer' AND id NOT LIKE 'explorer-%' AND (message_count > 0 OR provider_thread_id IS NOT NULL)").run();
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_missing_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_completed_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN candidate_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN last_assessed_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET exploration_missing_json = ? WHERE exploration_status = 'INCOMPLETE' AND last_assessed_turn_id IS NULL AND exploration_missing_json IN ('[]', '')").run(JSON.stringify(REQUIRED_PLAN_AREAS));
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETED'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN error TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE explorer_turns SET status = 'FAILED', error = COALESCE(error, '历史记录未包含模型文本') WHERE role = 'assistant' AND trim(content) = '' AND status = 'COMPLETED'");
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN contract_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN source_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_item_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE domain_events ADD COLUMN sequence INTEGER"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE domain_events SET sequence = rowid WHERE sequence IS NULL");
    try { this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS domain_events_sequence_uq ON domain_events(sequence)"); } catch { /* Existing databases already have the index. */ }
    try { this.database.exec("ALTER TABLE change_proposals ADD COLUMN revision INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_version INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_hash TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_snapshot_json TEXT"); } catch { /* Existing databases already have the column. */ }
  }

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string { return `${prefix}-${randomUUID().slice(0, 12)}`; }

  saveProject(project: Project): Project {
    this.database.prepare(`
      INSERT INTO factory_projects (id, name, repo_root, default_branch, worktree_root, status, current_explorer_thread_id, config_version, config_hash, settings_json, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, repo_root=excluded.repo_root, default_branch=excluded.default_branch, worktree_root=excluded.worktree_root, status=excluded.status, current_explorer_thread_id=excluded.current_explorer_thread_id, config_version=excluded.config_version, config_hash=excluded.config_hash, settings_json=excluded.settings_json, created_at=excluded.created_at, updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `).run(project.id, project.name, project.repoRoot, project.defaultBranch, project.worktreeRoot, project.status, project.currentExplorerThreadId, project.configVersion, project.configHash, JSON.stringify(project.settings), project.createdAt, project.updatedAt, project.archivedAt);
    return this.getProject(project.id) as Project;
  }

  getProject(projectId: string): Project | undefined {
    const row = this.database.prepare("SELECT * FROM factory_projects WHERE id = ?").get(projectId) as SqliteRow | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  listProjects(): Project[] {
    const rows = this.database.prepare("SELECT * FROM factory_projects ORDER BY name ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  updateProject(project: Project): Project {
    if (!this.getProject(project.id)) throw new Error(`Project ${project.id} does not exist`);
    return this.saveProject(project);
  }

  saveProjectConfigRevision(revision: ProjectConfigRevision): ProjectConfigRevision {
    this.database.prepare("INSERT OR IGNORE INTO project_config_revisions (project_id, version, hash, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)").run(revision.projectId, revision.version, revision.hash, JSON.stringify(revision.snapshot), revision.createdAt);
    return this.listProjectConfigRevisions(revision.projectId).find((item) => item.version === revision.version) as ProjectConfigRevision;
  }

  listProjectConfigRevisions(projectId: string): ProjectConfigRevision[] {
    const rows = this.database.prepare("SELECT * FROM project_config_revisions WHERE project_id = ? ORDER BY version ASC").all(projectId) as unknown as SqliteRow[];
    return rows.map((row) => ({ projectId: String(row.project_id), version: Number(row.version), hash: String(row.hash), snapshot: JSON.parse(String(row.snapshot_json)) as ProjectExecutionSnapshot, createdAt: String(row.created_at) }));
  }

  saveThread(input: RegisterThreadInput): ExplorerThread {
    const createdAt = input.createdAt ?? this.now();
    const title = threadTitleMetadata(input.title, createdAt);
    const thread: ExplorerThread = {
      id: input.id,
      projectId: input.projectId,
      ...title,
      createdAt,
      contextMode: input.contextMode ?? "FRESH",
      originThreadId: input.originThreadId ?? null,
      parentThreadId: input.parentThreadId,
      providerThreadId: input.providerThreadId ?? null,
      state: "ACTIVE",
      messageCount: 0,
      summaryRef: null,
      lastActivityAt: this.now(),
      exploration: defaultPlanExploration(),
    };
    this.database.prepare(`
      INSERT INTO explorer_threads (id, project_id, title, created_at, title_source, title_status, context_mode, origin_thread_id, parent_thread_id, provider_thread_id, state, message_count, summary_ref, last_activity_at, exploration_status, exploration_missing_json, exploration_completed_json, candidate_plan_id, last_assessed_turn_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, created_at=excluded.created_at, title_source=excluded.title_source, title_status=excluded.title_status, context_mode=excluded.context_mode, origin_thread_id=excluded.origin_thread_id, parent_thread_id=excluded.parent_thread_id
    `).run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.parentThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId);
    return this.getThread(thread.id) as ExplorerThread;
  }

  getThread(id: string): ExplorerThread | undefined {
    const row = this.database.prepare("SELECT * FROM explorer_threads WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.threadFromRow(row) : undefined;
  }

  listThreads(): ExplorerThread[] {
    const rows = this.database.prepare("SELECT * FROM explorer_threads ORDER BY last_activity_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  updateThread(thread: ExplorerThread): ExplorerThread {
    this.database.prepare("UPDATE explorer_threads SET title = ?, created_at = ?, title_source = ?, title_status = ?, context_mode = ?, origin_thread_id = ?, provider_thread_id = ?, state = ?, message_count = ?, summary_ref = ?, last_activity_at = ?, exploration_status = ?, exploration_missing_json = ?, exploration_completed_json = ?, candidate_plan_id = ?, last_assessed_turn_id = ? WHERE id = ?").run(thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId, thread.id);
    return this.getThread(thread.id) as ExplorerThread;
  }

  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    this.database.prepare("INSERT INTO explorer_turns (id, thread_id, role, content, status, error, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(turn.id, turn.threadId, turn.role, turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.createdAt, turn.sequence);
    return turn;
  }

  updateTurn(turn: ExplorerTurn): ExplorerTurn {
    this.database.prepare("UPDATE explorer_turns SET content = ?, status = ?, error = ? WHERE id = ?").run(turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.id);
    return this.listTurns(turn.threadId).find((item) => item.id === turn.id) as ExplorerTurn;
  }

  listTurns(threadId: string): ExplorerTurn[] {
    const rows = this.database.prepare("SELECT * FROM explorer_turns WHERE thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    return rows.map((row) => ({ id: String(row.id), threadId: String(row.thread_id), role: String(row.role) as ExplorerTurn["role"], content: String(row.content), status: String(row.status ?? "COMPLETED") as NonNullable<ExplorerTurn["status"]>, ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), sequence: Number(row.sequence) }));
  }

  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    const existing = this.database.prepare("SELECT * FROM explorer_input_requests WHERE provider_thread_id = ? AND provider_turn_id = ? AND provider_request_id = ?").get(request.providerThreadId, request.providerTurnId, String(request.providerRequestId)) as SqliteRow | undefined;
    if (existing) return this.inputRequestFromRow(existing);
    if (request.isBlocking && this.database.prepare("SELECT 1 FROM explorer_input_requests WHERE thread_id = ? AND is_blocking = 1 AND status = 'OPEN' LIMIT 1").get(request.threadId)) throw new Error(`ExplorerThread ${request.threadId} already has an open blocking input request`);
    this.database.prepare("INSERT INTO explorer_input_requests (id, thread_id, local_turn_id, provider_request_id, provider_thread_id, provider_turn_id, item_id, questions_json, is_blocking, auto_resolution_ms, status, created_at, answered_at, answered_by, redacted_answer_summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.threadId, request.localTurnId, String(request.providerRequestId), request.providerThreadId, request.providerTurnId, request.itemId, JSON.stringify(request.questions), request.isBlocking ? 1 : 0, request.autoResolutionMs, request.status, request.createdAt, request.answeredAt, request.answeredBy, request.redactedAnswerSummary ? JSON.stringify(request.redactedAnswerSummary) : null);
    return this.getInputRequest(request.id) as ExplorerInputRequest;
  }

  getInputRequest(id: string): ExplorerInputRequest | undefined {
    const row = this.database.prepare("SELECT * FROM explorer_input_requests WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.inputRequestFromRow(row) : undefined;
  }

  listInputRequests(threadId: string, status?: ExplorerInputRequestStatus): ExplorerInputRequest[] {
    const rows = this.database.prepare(`SELECT * FROM explorer_input_requests WHERE thread_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at ASC`).all(...(status ? [threadId, status] : [threadId])) as unknown as SqliteRow[];
    return rows.map((row) => this.inputRequestFromRow(row));
  }

  updateInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    this.database.prepare("UPDATE explorer_input_requests SET status = ?, answered_at = ?, answered_by = ?, redacted_answer_summary_json = ? WHERE id = ?").run(request.status, request.answeredAt, request.answeredBy, request.redactedAnswerSummary ? JSON.stringify(request.redactedAnswerSummary) : null, request.id);
    return this.getInputRequest(request.id) as ExplorerInputRequest;
  }

  savePlan(plan: CandidatePlan): CandidatePlan {
    this.database.prepare(`
      INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, title, revision, status, created_at, confirmed_by, confirmed_at, queued_at, run_id, last_event_at, attention_reason, contract_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, source_turn_id=excluded.source_turn_id, provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id, provider_item_id=excluded.provider_item_id, title=excluded.title, revision=excluded.revision, status=excluded.status, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, queued_at=excluded.queued_at, run_id=excluded.run_id, last_event_at=excluded.last_event_at, attention_reason=excluded.attention_reason, contract_json=excluded.contract_json
    `).run(plan.id, plan.projectId, plan.sourceExplorerThreadId, plan.sourceTurnId, plan.providerThreadId, plan.providerTurnId, plan.providerItemId, plan.title, plan.revision, plan.status, plan.createdAt, plan.confirmedBy, plan.confirmedAt, plan.queuedAt, plan.runId, plan.lastEventAt, plan.attentionReason, JSON.stringify(plan.contract));
    return this.getPlan(plan.id) as CandidatePlan;
  }

  getPlan(id: string): CandidatePlan | undefined {
    const row = this.database.prepare("SELECT * FROM candidate_plans WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.planFromRow(row) : undefined;
  }

  listPlans(): CandidatePlan[] {
    const rows = this.database.prepare("SELECT * FROM candidate_plans ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.planFromRow(row));
  }

  updatePlan(plan: CandidatePlan): CandidatePlan { return this.savePlan(plan); }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.database.prepare("INSERT OR IGNORE INTO plan_revisions (plan_id, revision, contract_json, artifact_hash, confirmed_by, confirmed_at, source_explorer_thread_id, project_config_version, project_config_hash, project_config_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revision.planId, revision.revision, JSON.stringify(revision.contract), revision.artifactHash, revision.confirmedBy, revision.confirmedAt, revision.sourceExplorerThreadId, revision.projectConfigVersion ?? null, revision.projectConfigHash ?? null, revision.projectConfigSnapshot ? JSON.stringify(revision.projectConfigSnapshot) : null);
    return this.getRevision(revision.planId, revision.revision) as PlanRevisionV2;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    const row = this.database.prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?").get(planId, revision) as SqliteRow | undefined;
    if (!row) return undefined;
    return freezeRevision({ planId: String(row.plan_id), revision: Number(row.revision), contract: JSON.parse(String(row.contract_json)) as PlanContract, artifactHash: String(row.artifact_hash), confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at), sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.project_config_version === null || row.project_config_version === undefined ? {} : { projectConfigVersion: Number(row.project_config_version) }), ...(row.project_config_hash === null || row.project_config_hash === undefined ? {} : { projectConfigHash: String(row.project_config_hash) }), ...(row.project_config_snapshot_json === null || row.project_config_snapshot_json === undefined ? {} : { projectConfigSnapshot: JSON.parse(String(row.project_config_snapshot_json)) as ProjectExecutionSnapshot }) });
  }

  saveChangeProposal(proposal: ChangeProposal): ChangeProposal {
    this.database.prepare("INSERT OR IGNORE INTO change_proposals (id, run_id, plan_id, reason, requested_changes_json, contract_json, status, created_at, created_by, decided_at, decided_by, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(proposal.id, proposal.runId, proposal.planId, proposal.reason, JSON.stringify(proposal.requestedChanges), JSON.stringify(proposal.contract), proposal.status, proposal.createdAt, proposal.createdBy, proposal.decidedAt, proposal.decidedBy, proposal.revision);
    return this.getChangeProposal(proposal.id) as ChangeProposal;
  }

  getChangeProposal(id: string): ChangeProposal | undefined {
    const row = this.database.prepare("SELECT * FROM change_proposals WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.changeProposalFromRow(row) : undefined;
  }

  listChangeProposals(runId?: string): ChangeProposal[] {
    const rows = this.database.prepare(`SELECT * FROM change_proposals ${runId ? "WHERE run_id = ?" : ""} ORDER BY created_at ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.changeProposalFromRow(row));
  }

  updateChangeProposal(proposal: ChangeProposal): ChangeProposal {
    this.database.prepare("UPDATE change_proposals SET status = ?, decided_at = ?, decided_by = ?, revision = ? WHERE id = ?").run(proposal.status, proposal.decidedAt, proposal.decidedBy, proposal.revision, proposal.id);
    return this.getChangeProposal(proposal.id) as ChangeProposal;
  }

  saveRun(run: Run): Run {
    this.database.prepare("INSERT INTO runs (id, project_id, plan_id, plan_revision, status, branch, workspace_path, base_commit, execution_thread_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, workspace_path=excluded.workspace_path, started_at=excluded.started_at").run(run.id, run.projectId, run.planId, run.planRevision, run.status, run.branch, run.workspacePath, run.baseCommit, run.executionThreadId, run.createdAt, run.startedAt);
    return this.getRun(run.id) as Run;
  }

  getRun(runId: string): Run | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as SqliteRow | undefined;
    return row ? this.runFromRow(row) : undefined;
  }

  listRuns(): Run[] {
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.runFromRow(row));
  }

  saveExecutionThread(thread: ExecutionThread): ExecutionThread {
    this.database.prepare("INSERT INTO execution_threads (id, run_id, state, journal_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, journal_json=excluded.journal_json").run(thread.id, thread.runId, thread.state, JSON.stringify(thread.journal));
    return this.getExecutionThread(thread.id) as ExecutionThread;
  }

  saveVerificationRun(verification: VerificationRun): VerificationRun {
    this.database.prepare("INSERT OR IGNORE INTO verification_runs (id, run_id, status, repair_attempts, command_results_json, completed_at) VALUES (?, ?, ?, ?, ?, ?)").run(verification.id, verification.runId, verification.status, verification.repairAttempts, JSON.stringify(verification.commandResults), verification.completedAt);
    return this.getVerificationById(verification.id) as VerificationRun;
  }

  getVerificationRun(runId: string): VerificationRun | undefined {
    const row = this.database.prepare("SELECT * FROM verification_runs WHERE run_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(runId) as SqliteRow | undefined;
    return row ? this.verificationFromRow(row) : undefined;
  }

  listVerificationRuns(runId?: string): VerificationRun[] {
    const rows = this.database.prepare(`SELECT * FROM verification_runs ${runId ? "WHERE run_id = ?" : ""} ORDER BY completed_at ASC, rowid ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.verificationFromRow(row));
  }

  saveMergeRequest(request: MergeRequest): MergeRequest {
    this.database.prepare("INSERT OR IGNORE INTO merge_requests (id, run_id, plan_id, source_commit, target_branch, status, human_confirmation_required, created_at, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.runId, request.planId, request.sourceCommit, request.targetBranch, request.status, request.humanConfirmationRequired ? 1 : 0, request.createdAt, request.mergedAt);
    return this.getMergeRequest(request.id) as MergeRequest;
  }

  getMergeRequest(requestId: string): MergeRequest | undefined {
    const row = this.database.prepare("SELECT * FROM merge_requests WHERE id = ?").get(requestId) as SqliteRow | undefined;
    return row ? this.mergeRequestFromRow(row) : undefined;
  }

  findMergeRequestByRun(runId: string): MergeRequest | undefined {
    const row = this.database.prepare("SELECT * FROM merge_requests WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as SqliteRow | undefined;
    return row ? this.mergeRequestFromRow(row) : undefined;
  }

  listMergeRequests(): MergeRequest[] {
    const rows = this.database.prepare("SELECT * FROM merge_requests ORDER BY created_at ASC, rowid ASC").all() as unknown as SqliteRow[];
    return rows.map((row) => this.mergeRequestFromRow(row));
  }

  updateMergeRequest(request: MergeRequest): MergeRequest {
    this.database.prepare("UPDATE merge_requests SET status = ?, merged_at = ? WHERE id = ?").run(request.status, request.mergedAt, request.id);
    return this.getMergeRequest(request.id) as MergeRequest;
  }

  saveAgentLoop(loop: AgentLoop): AgentLoop {
    this.database.prepare(`
      INSERT INTO agent_loops (id, owner_type, owner_id, role, mode, state, step_count, max_steps, started_at, completed_at, provider_thread_id, provider_turn_id, checkpoint_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_type=excluded.owner_type, owner_id=excluded.owner_id, role=excluded.role, mode=excluded.mode, state=excluded.state, step_count=excluded.step_count, max_steps=excluded.max_steps, started_at=excluded.started_at, completed_at=excluded.completed_at, provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id, checkpoint_json=excluded.checkpoint_json
    `).run(loop.id, loop.ownerType, loop.ownerId, loop.role, loop.mode, loop.state, loop.stepCount, loop.maxSteps, loop.startedAt, loop.completedAt, loop.providerThreadId, loop.providerTurnId, loop.checkpointJson);
    return this.getAgentLoop(loop.id) as AgentLoop;
  }

  getAgentLoop(loopId: string): AgentLoop | undefined {
    const row = this.database.prepare("SELECT * FROM agent_loops WHERE id = ?").get(loopId) as SqliteRow | undefined;
    return row ? this.agentLoopFromRow(row) : undefined;
  }

  listAgentLoops(ownerId?: string): AgentLoop[] {
    const rows = this.database.prepare(`SELECT * FROM agent_loops ${ownerId ? "WHERE owner_id = ?" : ""} ORDER BY rowid ASC`).all(...(ownerId ? [ownerId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.agentLoopFromRow(row));
  }

  updateAgentLoop(loop: AgentLoop): AgentLoop {
    if (!this.getAgentLoop(loop.id)) throw new Error(`AgentLoop ${loop.id} does not exist`);
    return this.saveAgentLoop(loop);
  }

  appendAgentLoopStep(input: AgentLoopStepInput): AgentLoopStep {
    const nextSequence = Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_loop_steps WHERE loop_id = ?").get(input.loopId) as SqliteRow).next_sequence);
    const step: AgentLoopStep = { ...input, callId: input.callId ?? null, providerThreadId: input.providerThreadId ?? null, providerTurnId: input.providerTurnId ?? null, sequence: nextSequence, occurredAt: input.occurredAt ?? this.now() };
    this.database.prepare("INSERT INTO agent_loop_steps (loop_id, sequence, step_type, status, call_id, provider_thread_id, provider_turn_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(step.loopId, step.sequence, step.stepType, step.status, step.callId, step.providerThreadId, step.providerTurnId, JSON.stringify(step.payload), step.occurredAt);
    return step;
  }

  listAgentLoopSteps(loopId: string): AgentLoopStep[] {
    const rows = this.database.prepare("SELECT * FROM agent_loop_steps WHERE loop_id = ? ORDER BY sequence ASC").all(loopId) as unknown as SqliteRow[];
    return rows.map((row) => this.agentLoopStepFromRow(row));
  }

  recoverAgentLoops(): AgentLoop[] { return this.listAgentLoops().filter((loop) => loop.state === "RUNNING" || loop.state === "WAITING_FOR_INPUT" || loop.state === "PAUSED"); }

  saveToolCall(call: PersistedToolCall): PersistedToolCall {
    this.database.prepare("INSERT OR IGNORE INTO tool_calls (call_id, loop_id, role, tool, status, input_hash, result_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(call.callId, call.loopId, call.role, call.tool, call.status, call.inputHash, call.result ? JSON.stringify(call.result) : null, call.startedAt, call.completedAt);
    return this.getToolCall(call.callId) as PersistedToolCall;
  }

  getToolCall(callId: string): PersistedToolCall | undefined {
    const row = this.database.prepare("SELECT * FROM tool_calls WHERE call_id = ?").get(callId) as SqliteRow | undefined;
    return row ? this.toolCallFromRow(row) : undefined;
  }

  listToolCalls(loopId?: string): PersistedToolCall[] {
    const rows = this.database.prepare(`SELECT * FROM tool_calls ${loopId ? "WHERE loop_id = ?" : ""} ORDER BY started_at ASC`).all(...(loopId ? [loopId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.toolCallFromRow(row));
  }

  updateToolCall(call: PersistedToolCall): PersistedToolCall {
    if (!this.getToolCall(call.callId)) throw new Error(`Tool call ${call.callId} does not exist`);
    this.database.prepare("UPDATE tool_calls SET status = ?, result_json = ?, completed_at = ? WHERE call_id = ?").run(call.status, call.result ? JSON.stringify(call.result) : null, call.completedAt, call.callId);
    return this.getToolCall(call.callId) as PersistedToolCall;
  }

  getExecutionThread(threadId: string): ExecutionThread | undefined {
    const row = this.database.prepare("SELECT * FROM execution_threads WHERE id = ?").get(threadId) as SqliteRow | undefined;
    return row ? { id: String(row.id), runId: String(row.run_id), state: String(row.state) as ExecutionThreadState, journal: JSON.parse(String(row.journal_json)) as ExecutionJournalEntry[] } : undefined;
  }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent {
    const saved: DomainEvent = { ...event, id: this.nextId("event"), sequence: Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM domain_events").get() as SqliteRow).next_sequence), occurredAt: this.now() };
    this.database.prepare("INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(saved.id, saved.sequence, saved.type, saved.aggregateId, saved.occurredAt, JSON.stringify(saved.payload));
    return saved;
  }

  listEvents(options: { afterSequence?: number; aggregateId?: string } = {}): DomainEvent[] {
    const rows = this.database.prepare(`SELECT * FROM domain_events WHERE sequence > ? ${options.aggregateId ? "AND aggregate_id = ?" : ""} ORDER BY sequence ASC`).all(...(options.aggregateId ? [options.afterSequence ?? 0, options.aggregateId] : [options.afterSequence ?? 0])) as unknown as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      type: String(row.type) as DomainEvent["type"],
      aggregateId: String(row.aggregate_id),
      occurredAt: String(row.occurred_at),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    }));
  }

  getLastEventSequence(aggregateId?: string): number {
    const row = this.database.prepare(`SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM domain_events ${aggregateId ? "WHERE aggregate_id = ?" : ""}`).get(...(aggregateId ? [aggregateId] : [])) as SqliteRow;
    return Number(row.last_sequence ?? 0);
  }

  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined {
    const row = this.database.prepare("SELECT result_json FROM idempotency_keys WHERE scope = ? AND key = ?").get(scope, key) as SqliteRow | undefined;
    return row ? JSON.parse(String(row.result_json)) as Record<string, unknown> : undefined;
  }

  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void {
    this.database.prepare("INSERT OR IGNORE INTO idempotency_keys (scope, key, result_json, created_at) VALUES (?, ?, ?, ?)").run(scope, key, JSON.stringify(result), this.now());
  }

  close(): void { this.database.close(); }

  private projectFromRow(row: SqliteRow): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      repoRoot: String(row.repo_root),
      defaultBranch: String(row.default_branch),
      worktreeRoot: String(row.worktree_root),
      status: String(row.status) as Project["status"],
      currentExplorerThreadId: row.current_explorer_thread_id === null || row.current_explorer_thread_id === undefined ? null : String(row.current_explorer_thread_id),
      configVersion: Number(row.config_version),
      configHash: String(row.config_hash),
      settings: JSON.parse(String(row.settings_json)) as ProjectSettings,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at === null || row.archived_at === undefined ? null : String(row.archived_at),
    };
  }

  private threadFromRow(row: SqliteRow): ExplorerThread {
    return { id: String(row.id), projectId: String(row.project_id), title: String(row.title ?? "New Explorer"), createdAt: String(row.created_at ?? row.last_activity_at), titleSource: String(row.title_source ?? "AUTO") as ExplorerTitleSource, titleStatus: String(row.title_status ?? "PLACEHOLDER") as ExplorerTitleStatus, contextMode: String(row.context_mode ?? "FRESH") as ExplorerThread["contextMode"], originThreadId: row.origin_thread_id === null || row.origin_thread_id === undefined ? null : String(row.origin_thread_id), parentThreadId: row.parent_thread_id === null ? null : String(row.parent_thread_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), state: String(row.state) as ExplorerThreadState, messageCount: Number(row.message_count), summaryRef: row.summary_ref === null ? null : String(row.summary_ref), lastActivityAt: String(row.last_activity_at), exploration: { status: String(row.exploration_status ?? "INCOMPLETE") as PlanExplorationStatus, missing: parseStringArray(row.exploration_missing_json, [...REQUIRED_PLAN_AREAS]), completed: parseStringArray(row.exploration_completed_json, []), candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id) } };
  }

  private inputRequestFromRow(row: SqliteRow): ExplorerInputRequest {
    return {
      id: String(row.id), threadId: String(row.thread_id), localTurnId: String(row.local_turn_id),
      providerRequestId: parseRequestId(String(row.provider_request_id)), providerThreadId: String(row.provider_thread_id), providerTurnId: String(row.provider_turn_id), itemId: String(row.item_id),
      questions: JSON.parse(String(row.questions_json)) as ModelInputQuestion[], isBlocking: Number(row.is_blocking) === 1, autoResolutionMs: row.auto_resolution_ms === null ? null : Number(row.auto_resolution_ms), status: String(row.status) as ExplorerInputRequestStatus,
      createdAt: String(row.created_at), answeredAt: row.answered_at === null ? null : String(row.answered_at), answeredBy: row.answered_by === null ? null : String(row.answered_by), redactedAnswerSummary: row.redacted_answer_summary_json === null ? null : JSON.parse(String(row.redacted_answer_summary_json)) as Record<string, unknown>,
    };
  }

  private getVerificationById(id: string): VerificationRun | undefined {
    const row = this.database.prepare("SELECT * FROM verification_runs WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.verificationFromRow(row) : undefined;
  }

  private verificationFromRow(row: SqliteRow): VerificationRun {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      status: String(row.status) as VerificationStatus,
      repairAttempts: Number(row.repair_attempts),
      commandResults: JSON.parse(String(row.command_results_json)) as VerificationRun["commandResults"],
      completedAt: String(row.completed_at),
    };
  }

  private mergeRequestFromRow(row: SqliteRow): MergeRequest {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      planId: String(row.plan_id),
      sourceCommit: String(row.source_commit),
      targetBranch: String(row.target_branch),
      status: String(row.status) as MergeRequest["status"],
      humanConfirmationRequired: true,
      createdAt: String(row.created_at),
      mergedAt: row.merged_at === null ? null : String(row.merged_at),
    };
  }

  private planFromRow(row: SqliteRow): CandidatePlan {
    return { id: String(row.id), projectId: String(row.project_id), sourceExplorerThreadId: String(row.source_explorer_thread_id), sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null || row.provider_turn_id === undefined ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null || row.provider_item_id === undefined ? null : String(row.provider_item_id), title: String(row.title), revision: Number(row.revision), status: String(row.status) as PlanStatus, createdAt: String(row.created_at), confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at), queuedAt: row.queued_at === null ? null : String(row.queued_at), runId: row.run_id === null ? null : String(row.run_id), lastEventAt: String(row.last_event_at), attentionReason: row.attention_reason === null ? null : String(row.attention_reason), contract: JSON.parse(String(row.contract_json ?? "{}")) as PlanContract };
  }

  private changeProposalFromRow(row: SqliteRow): ChangeProposal {
    return {
      id: String(row.id), runId: String(row.run_id), planId: String(row.plan_id), reason: String(row.reason),
      requestedChanges: JSON.parse(String(row.requested_changes_json)) as string[], contract: JSON.parse(String(row.contract_json)) as PlanContract,
      status: String(row.status) as ChangeProposalStatus, createdAt: String(row.created_at), createdBy: String(row.created_by),
      decidedAt: row.decided_at === null ? null : String(row.decided_at), decidedBy: row.decided_by === null ? null : String(row.decided_by), revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
    };
  }

  private runFromRow(row: SqliteRow): Run {
    return { id: String(row.id), projectId: String(row.project_id), planId: String(row.plan_id), planRevision: Number(row.plan_revision), status: String(row.status) as RunStatus, branch: String(row.branch), workspacePath: row.workspace_path === null ? null : String(row.workspace_path), baseCommit: String(row.base_commit), executionThreadId: String(row.execution_thread_id), createdAt: String(row.created_at), startedAt: row.started_at === null ? null : String(row.started_at) };
  }

  private agentLoopFromRow(row: SqliteRow): AgentLoop {
    return {
      id: String(row.id), ownerType: String(row.owner_type) as AgentLoop["ownerType"], ownerId: String(row.owner_id), role: String(row.role) as AgentLoop["role"], mode: String(row.mode) as AgentLoop["mode"], state: String(row.state) as AgentLoop["state"], stepCount: Number(row.step_count), maxSteps: Number(row.max_steps), startedAt: row.started_at === null ? null : String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), checkpointJson: row.checkpoint_json === null ? null : String(row.checkpoint_json),
    };
  }

  private agentLoopStepFromRow(row: SqliteRow): AgentLoopStep {
    return {
      loopId: String(row.loop_id), sequence: Number(row.sequence), stepType: String(row.step_type) as AgentLoopStep["stepType"], status: String(row.status) as AgentLoopStep["status"], callId: row.call_id === null ? null : String(row.call_id), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>, occurredAt: String(row.occurred_at),
    };
  }

  private toolCallFromRow(row: SqliteRow): PersistedToolCall {
    return { callId: String(row.call_id), loopId: String(row.loop_id), role: String(row.role) as ToolRole, tool: String(row.tool) as ToolName, status: String(row.status) as DurableToolCallStatus, inputHash: String(row.input_hash), result: row.result_json === null ? null : JSON.parse(String(row.result_json)) as ToolCallResult, startedAt: String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at) };
  }
}

function defaultPlanContract(title: string): PlanContract {
  return {
    goal: title,
    acceptanceCriteria: ["All approved tasks are executed within the declared scope", "Registered verification commands pass", "A human confirms the target commit before merge"],
    include: ["apps/*", "packages/*"],
    exclude: [".env*", ".git/*", "dist/*"],
    baseBranch: "main",
    baseCommit: "HEAD",
    tasks: [{ id: "task-1", title, dependencies: [], status: "READY" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test", "project.typecheck"],
    maxRepairAttempts: 2,
    mergeStrategy: "manual",
    requireHumanMerge: true,
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function freezeRevision(revision: PlanRevisionV2): PlanRevisionV2 {
  return freezeDeep(revision);
}

export class PlanService {
  private readonly projects: ProjectService;

  constructor(private readonly store: PipelineStore, projects?: ProjectService) {
    this.projects = projects ?? new ProjectService(store);
  }

  registerThread(input: RegisterThreadInput): ExplorerThread {
    const thread = this.store.saveThread(input);
    this.store.appendEvent({
      type: "explorer.thread.created",
      aggregateId: thread.id,
      payload: { projectId: thread.projectId, parentThreadId: thread.parentThreadId },
    });
    return thread;
  }

  createCandidatePlan(input: CreateCandidatePlanInput): CandidatePlan {
    if (!this.store.getThread(input.sourceExplorerThreadId)) {
      this.registerThread({ id: input.sourceExplorerThreadId, projectId: input.projectId, parentThreadId: null });
    }
    const createdAt = this.store.now();
    const plan: CandidatePlan = {
      id: this.store.nextId("plan"),
      projectId: input.projectId,
      sourceExplorerThreadId: input.sourceExplorerThreadId,
      sourceTurnId: input.sourceTurnId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      providerTurnId: input.providerTurnId ?? null,
      providerItemId: input.providerItemId ?? null,
      title: input.title,
      revision: 1,
      status: "DRAFT",
      createdAt,
      confirmedBy: null,
      confirmedAt: null,
      queuedAt: null,
      runId: null,
      lastEventAt: createdAt,
      attentionReason: null,
      contract: input.contract ?? defaultPlanContract(input.title),
    };
    this.store.savePlan(plan);
    this.store.appendEvent({ type: "plan.candidate.created", aggregateId: plan.id, payload: { title: plan.title, sourceTurnId: plan.sourceTurnId, providerThreadId: plan.providerThreadId, providerTurnId: plan.providerTurnId, providerItemId: plan.providerItemId } });
    return plan;
  }

  get(planId: string): CandidatePlan {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    return plan;
  }

  discard(planId: string, actorId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error(`Plan ${planId} cannot be discarded from ${plan.status}`);
    const discardedAt = this.store.now();
    const updated = this.store.updatePlan({ ...plan, status: "DISCARDED", lastEventAt: discardedAt });
    this.store.appendEvent({ type: "plan.discarded", aggregateId: planId, payload: { actorId } });
    return updated;
  }

  confirm(planId: string, confirmedBy: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status === "READY" || plan.status === "QUEUED") return plan;
    if (plan.status !== "DRAFT" && plan.status !== "DESIGNED" && plan.status !== "PLANNED") {
      throw new Error(`Plan ${planId} cannot be confirmed from ${plan.status}`);
    }
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? this.projects.snapshot(project.id) : undefined;
    const revision = freezeRevision({
      planId: plan.id,
      revision: plan.revision,
      contract: plan.contract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: plan.contract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const updated = this.store.updatePlan({ ...plan, status: "READY", confirmedBy, confirmedAt, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.confirmed", aggregateId: planId, payload: { confirmedBy } });
    return updated;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 {
    const value = this.store.getRevision(planId, revision);
    if (!value) throw new Error(`Plan revision ${planId}@${revision} not found`);
    return value;
  }

  enqueue(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status === "QUEUED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") {
      return plan;
    }
    if (plan.status !== "READY") throw new Error(`Plan ${planId} must be confirmed before enqueue`);
    const queuedAt = this.store.now();
    const updated = this.store.updatePlan({ ...plan, status: "QUEUED", queuedAt, lastEventAt: queuedAt });
    this.store.appendEvent({ type: "plan.enqueued", aggregateId: planId, payload: { queuedAt } });
    return updated;
  }

  listThreadPlans(threadId: string): PlanIndexRow[] {
    const current = this.store.getThread(threadId);
    if (!current) return [];
    const lineage = new Set<string>([threadId]);
    let parentId = current.parentThreadId;
    while (parentId) {
      lineage.add(parentId);
      parentId = this.store.getThread(parentId)?.parentThreadId ?? null;
    }
    const descendants = this.store.listThreads().filter((thread) => thread.projectId === current.projectId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const thread of descendants) {
        if (thread.parentThreadId && lineage.has(thread.parentThreadId) && !lineage.has(thread.id)) {
          lineage.add(thread.id);
          changed = true;
        }
      }
    }
    return this.store
      .listPlans()
      .filter((plan) => lineage.has(plan.sourceExplorerThreadId) && (plan.queuedAt !== null || plan.status === "READY"))
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
        queuedAt: plan.queuedAt as string,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
      }))
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  }

  listProjectPlans(projectId: string): PlanIndexRow[] {
    return this.store
      .listPlans()
      .filter((plan) => plan.projectId === projectId && plan.queuedAt !== null)
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
        queuedAt: plan.queuedAt as string,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
      }))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  }
}

export class ExplorerService {
  constructor(private readonly store: PipelineStore) {}

  create(input: CreateExplorerInput): ExplorerThread {
    const origin = input.originThreadId ? this.store.getThread(input.originThreadId) : undefined;
    if (input.originThreadId && (!origin || origin.projectId !== input.projectId)) throw new Error("Origin Explorer does not belong to this project");
    const thread = this.store.saveThread({
      id: this.store.nextId("explorer"),
      projectId: input.projectId,
      parentThreadId: null,
      title: input.title?.trim() || "New Explorer",
      contextMode: origin ? "EXPLICIT_CONTINUATION" : "FRESH",
      originThreadId: origin?.id ?? null,
      createdAt: input.createdAt,
    });
    this.store.appendEvent({ type: "explorer.created", aggregateId: thread.id, payload: { projectId: thread.projectId, contextMode: thread.contextMode, originThreadId: thread.originThreadId } });
    if (origin) this.store.appendEvent({ type: "explorer.continued", aggregateId: thread.id, payload: { originThreadId: origin.id } });
    return thread;
  }

  get(explorerId: string): ExplorerThread {
    const explorer = this.store.getThread(explorerId);
    if (!explorer) throw new Error(`Explorer ${explorerId} not found`);
    return explorer;
  }

  list(projectId: string): ExplorerThread[] {
    return this.store.listThreads().filter((thread) => thread.projectId === projectId).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  archive(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ARCHIVED") return explorer;
    const archived = this.store.updateThread({ ...explorer, state: "ARCHIVED", lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.archived", aggregateId: explorerId, payload: { explorerId } });
    return archived;
  }

  activate(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ACTIVE") return explorer;
    const active = this.store.updateThread({ ...explorer, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.activated", aggregateId: explorerId, payload: { explorerId } });
    return active;
  }

  rename(explorerId: string, title: string): ExplorerThread {
    const explorer = this.get(explorerId);
    const normalized = title.trim();
    if (!normalized) throw new Error("Explorer title cannot be empty");
    return this.store.updateThread({ ...explorer, title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED", lastActivityAt: this.store.now() });
  }
}

export type CreateChangeProposalInput = {
  runId: string;
  reason: string;
  requestedChanges: string[];
  contract: PlanContract;
  createdBy?: string;
};

/**
 * A ChangeProposal is the only supported bridge from an execution discovery
 * back to planning. It never edits the old Run or its Revision; approval
 * creates a new immutable Revision and queues the owning Plan for a new Run.
 */
export class ChangeProposalService {
  constructor(private readonly store: PipelineStore) {}

  create(input: CreateChangeProposalInput): ChangeProposal {
    const run = this.store.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} not found`);
    const plan = this.store.getPlan(run.planId);
    if (!plan) throw new Error(`Plan ${run.planId} not found`);
    const existing = this.store.listChangeProposals(run.id).find((proposal) => proposal.status === "OPEN");
    if (existing) return existing;
    const proposal: ChangeProposal = {
      id: this.store.nextId("change-proposal"),
      runId: run.id,
      planId: plan.id,
      reason: input.reason,
      requestedChanges: [...input.requestedChanges],
      contract: input.contract,
      status: "OPEN",
      createdAt: this.store.now(),
      createdBy: input.createdBy ?? "executor",
      decidedAt: null,
      decidedBy: null,
      revision: null,
    };
    this.store.saveChangeProposal(proposal);
    this.store.saveRun({ ...run, status: "NEEDS_PLAN_CHANGE" });
    this.store.updatePlan({ ...plan, status: "NEEDS_PLAN_CHANGE", attentionReason: input.reason, lastEventAt: proposal.createdAt });
    this.store.appendEvent({ type: "change.proposal.created", aggregateId: proposal.id, payload: { runId: run.id, planId: plan.id, reason: input.reason, requestedChanges: input.requestedChanges } });
    return proposal;
  }

  async approve(proposalId: string, actorId: string, startRun?: (planId: string) => Promise<Run>): Promise<ApprovedChangeProposal> {
    const proposal = this.store.getChangeProposal(proposalId);
    if (!proposal) throw new Error(`ChangeProposal ${proposalId} not found`);
    const plan = this.store.getPlan(proposal.planId);
    if (!plan) throw new Error(`Plan ${proposal.planId} not found`);
    if (proposal.status === "APPROVED") {
      if (!proposal.revision) throw new Error(`Approved ChangeProposal ${proposal.id} is missing its revision`);
      const revision = this.store.getRevision(plan.id, proposal.revision);
      if (!revision) throw new Error(`ChangeProposal ${proposal.id} revision is missing`);
      const run = plan.runId ? this.store.getRun(plan.runId) ?? null : this.store.listRuns().find((item) => item.planId === plan.id && item.planRevision === revision.revision && item.id !== proposal.runId) ?? null;
      return { proposal, plan, revision, run };
    }
    if (proposal.status !== "OPEN") throw new Error(`ChangeProposal ${proposal.id} cannot be approved from ${proposal.status}`);
    const revisionNumber = plan.revision + 1;
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? new ProjectService(this.store).snapshot(project.id) : undefined;
    const revision = freezeRevision({
      planId: plan.id,
      revision: revisionNumber,
      contract: proposal.contract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: proposal.contract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy: actorId,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const approvedProposal = this.store.updateChangeProposal({ ...proposal, status: "APPROVED", decidedAt: confirmedAt, decidedBy: actorId, revision: revisionNumber });
    const queuedPlan = this.store.updatePlan({ ...plan, revision: revisionNumber, contract: proposal.contract, status: "QUEUED", confirmedBy: actorId, confirmedAt, queuedAt: confirmedAt, runId: null, attentionReason: null, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "change.proposal.approved", aggregateId: proposal.id, payload: { actorId, revision: revisionNumber, planId: plan.id } });
    let run: Run | null = null;
    if (startRun) run = await startRun(queuedPlan.id);
    const finalPlan = this.store.getPlan(queuedPlan.id) ?? queuedPlan;
    return { proposal: approvedProposal, plan: finalPlan, revision, run };
  }
}

export class LifecycleHookRunner {
  private readonly cleanupCwd: string;

  constructor(private readonly executor: CommandExecutor, options: { cleanupCwd?: string } = {}) {
    this.cleanupCwd = options.cleanupCwd ?? process.cwd();
  }

  async runStart(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    return this.run("start", hook, context, true);
  }

  async runCleanup(hook: HookDefinition | undefined, context: HookContext): Promise<HookRunResult> {
    return this.run("cleanup", hook, context, false);
  }

  private async run(
    hook: "start" | "cleanup",
    definition: HookDefinition | undefined,
    context: HookContext,
    blocksRun: boolean,
  ): Promise<HookRunResult> {
    if (!definition || definition.enabled === false) {
      return { hook, status: "skipped", blocked: false, needsAttention: false, result: null };
    }
    const result = await this.executor({
      commandId: definition.commandId,
      cwd: hook === "start" ? context.workspacePath : this.cleanupCwd,
      timeoutMs: definition.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      context,
    });
    const failed = result.exitCode !== 0;
    return {
      hook,
      status: failed ? "failed" : "completed",
      blocked: failed && blocksRun,
      needsAttention: failed && !blocksRun,
      result,
    };
  }
}

export type RegisteredCommandDefinition = { commandId: string; argv: readonly [string, ...string[]]; environment?: Readonly<Record<string, string>> | undefined };
export type ProcessRunner = (argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>) => Promise<CommandResult>;

export class RegisteredCommandExecutor {
  private readonly commands = new Map<string, RegisteredCommandDefinition>();
  private readonly runProcess: ProcessRunner;

  constructor(commands: RegisteredCommandDefinition[], runProcess: ProcessRunner = defaultProcessRunner) {
    for (const command of commands) this.commands.set(command.commandId, command);
    this.runProcess = runProcess;
  }

  execute(command: CommandInvocation): Promise<CommandResult> {
    const definition = this.commands.get(command.commandId);
    if (!definition) return Promise.resolve({ exitCode: 127, stdout: "", stderr: `Command ${command.commandId} is not registered` });
    const env: Record<string, string> = { ...(definition.environment ?? {}) };
    Object.assign(env, {
      PIPELINE_PROJECT_ID: command.context.projectId,
      PIPELINE_RUN_ID: command.context.runId,
      PIPELINE_WORKSPACE_PATH: command.context.workspacePath,
      PIPELINE_BRANCH: command.context.branch,
      PIPELINE_BASE_COMMIT: command.context.baseCommit,
      PIPELINE_EXIT_REASON: command.context.exitReason,
    });
    return this.runProcess([...definition.argv], command.cwd, command.timeoutMs, env);
  }

  invoke(command: CommandInvocation): Promise<CommandResult> { return this.execute(command); }
}

function defaultProcessRunner(argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(result); } };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => settle({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => settle({ exitCode: code, stdout, stderr }));
    const timer = setTimeout(() => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        setTimeout(() => { if (!settled) { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } } }, 1000);
      }
      settle({ exitCode: 124, stdout, stderr: `${stderr}Command timed out` });
    }, timeoutMs);
  });
}

export type ToolRole = "explorer" | "executor";
export type ToolName = "read_file" | "list_files" | "git_status" | "git_diff" | "git_log" | "search_text" | "write_file" | "apply_patch" | "run_command" | "run_registered_command" | "run_verification" | "git_commit" | string;

export type ToolCall = {
  callId: string;
  tool: ToolName;
  input: Record<string, unknown>;
};

export type ToolCallResult = {
  callId: string;
  allowed: boolean;
  status?: "SUCCEEDED" | "DENIED" | "FAILED" | "NEEDS_RECONCILIATION" | undefined;
  reason: string | null;
  result: unknown | null;
  audited: true;
};

export type DurableToolCallStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "NEEDS_RECONCILIATION";
export type PersistedToolCall = {
  callId: string;
  loopId: string;
  role: ToolRole;
  tool: ToolName;
  status: DurableToolCallStatus;
  inputHash: string;
  result: ToolCallResult | null;
  startedAt: string;
  completedAt: string | null;
};

export type ToolGatewayOptions = {
  role: ToolRole;
  workspaceRoot: string;
  registeredCommandIds?: ReadonlySet<string>;
  mcpAllowedTools?: ReadonlySet<string>;
  pluginAllowedTools?: ReadonlySet<string>;
  computerUseAllowed?: boolean;
  builtin?: Omit<BuiltinToolExecutorOptions, "workspaceRoot">;
  handler?: (call: ToolCall, context?: BuiltinToolContext) => Promise<unknown>;
};

const READ_ONLY_TOOLS = new Set<ToolName>(["read_file", "list_files", "git_status", "git_diff", "git_log", "search_text"]);
const EXECUTOR_TOOLS = new Set<ToolName>([...READ_ONLY_TOOLS, "write_file", "apply_patch", "run_registered_command", "run_verification", "git_commit"]);
const PROTECTED_PATHS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "tsconfig.json"]);

export class ToolGateway {
  private readonly calls = new Map<string, ToolCallResult>();
  private readonly workspaceRoot: string;
  private readonly registeredCommandIds: ReadonlySet<string>;
  private readonly mcpAllowedTools: ReadonlySet<string>;
  private readonly pluginAllowedTools: ReadonlySet<string>;
  private readonly builtin: BuiltinToolExecutor;

  constructor(private readonly options: ToolGatewayOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.registeredCommandIds = options.registeredCommandIds ?? new Set();
    this.mcpAllowedTools = options.mcpAllowedTools ?? new Set();
    this.pluginAllowedTools = options.pluginAllowedTools ?? new Set();
    this.builtin = new BuiltinToolExecutor({ workspaceRoot: this.workspaceRoot, ...(options.builtin ?? {}) });
  }

  async call(call: ToolCall, context?: BuiltinToolContext): Promise<ToolCallResult> {
    const previous = this.calls.get(call.callId);
    if (previous) return previous;
    const denied = this.validate(call);
    if (denied) {
      const result = this.save({ callId: call.callId, allowed: false, status: "DENIED", reason: denied, result: null, audited: true });
      return result;
    }
    try {
      const value = this.options.handler ? await this.options.handler(call, context) : await this.builtin.execute(call, { workspacePath: context?.workspacePath ?? this.workspaceRoot, ...(context ?? {}) });
      return this.save({ callId: call.callId, allowed: true, reason: null, result: value, audited: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isToolExecutionFailure(reason)) return this.save({ callId: call.callId, allowed: true, reason: null, result: { error: reason }, audited: true });
      if (/outside the configured workspace boundary|Protected secrets|repository internals/i.test(reason)) return this.save({ callId: call.callId, allowed: false, status: "DENIED", reason, result: null, audited: true });
      throw error;
    }
  }

  private validate(call: ToolCall): string | null {
    if (call.tool.startsWith("mcp:")) {
      if (!this.mcpAllowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer MCP tool is not explicitly allowed" : "MCP tool is not allowed by Executor policy";
      if (!this.options.builtin?.mcpToolExecutor && !this.options.handler) return "MCP tool executor is not configured";
      return null;
    }
    if (call.tool.startsWith("plugin:")) {
      if (!this.pluginAllowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer plugin tool is not explicitly allowed" : "Plugin tool is not allowed by Executor policy";
      if (!this.options.builtin?.pluginToolExecutor && !this.options.handler) return "Plugin tool executor is not configured";
      return null;
    }
    if (call.tool === "computer_use") {
      if (this.options.computerUseAllowed !== true) return "Computer Use is denied by host policy";
      if (!this.options.builtin?.computerUseExecutor && !this.options.handler) return "Computer Use host adapter is not configured";
      return null;
    }
    const allowedTools = this.options.role === "explorer" ? READ_ONLY_TOOLS : EXECUTOR_TOOLS;
    if (!allowedTools.has(call.tool)) return this.options.role === "explorer" ? "Explorer is read-only; this tool is disabled" : "Tool is not allowed by Executor policy";
    if (["read_file", "write_file", "apply_patch"].includes(call.tool)) {
      const path = call.input.path;
      if (call.tool !== "apply_patch" && (typeof path !== "string" || !this.isInsideWorkspace(path))) return "Path is outside the workspace boundary";
      if (typeof path === "string" && this.isProtectedPath(path)) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (["list_files", "search_text", "git_diff"].includes(call.tool)) {
      const path = call.input.path;
      if (path !== undefined && (typeof path !== "string" || !this.isInsideWorkspace(path))) return "Path is outside the workspace boundary";
      if (typeof path === "string" && this.isProtectedPath(path)) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (call.tool === "git_commit" && call.input.paths !== undefined) {
      const paths = call.input.paths;
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !this.isInsideWorkspace(path))) return "Commit paths must stay inside the workspace boundary";
      if (paths.some((path) => this.isProtectedPath(path as string))) return "Protected secrets, project configuration and Git internals are not accessible";
    }
    if (["run_registered_command", "run_verification"].includes(call.tool)) {
      const commandId = call.input.commandId;
      if (typeof commandId !== "string" || !this.registeredCommandIds.has(commandId)) return "Command is not registered for this project";
    }
    return null;
  }

  private isInsideWorkspace(path: string): boolean {
    const target = resolve(this.workspaceRoot, path);
    return target === this.workspaceRoot || target.startsWith(`${this.workspaceRoot}${sep}`) && (!isAbsolute(path) || target.startsWith(`${this.workspaceRoot}${sep}`));
  }

  private isProtectedPath(path: string): boolean {
    const normalized = relative(this.workspaceRoot, resolve(this.workspaceRoot, path)).split(sep).join("/");
    const basename = normalized.split("/").at(-1) ?? normalized;
    return normalized === ".git" || normalized.startsWith(".git/") || normalized.startsWith(".env") || PROTECTED_PATHS.has(normalized) || PROTECTED_PATHS.has(basename);
  }

  private save(result: ToolCallResult): ToolCallResult { this.calls.set(result.callId, result); return result; }
}

function isToolExecutionFailure(reason: string): boolean {
  return /does not exist|not a file|not a directory|No registered command executor|spawn/i.test(reason);
}

export type ModelRole = "explorer" | "executor";
export type ModelRoleConfig = {
  model: string;
  mode?: "plan" | "default" | undefined;
  loopMode?: "provider-controlled" | "factory-controlled" | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
};
export type ModelCapabilities = {
  supportsStructuredUserInput: boolean;
  supportsToolCalls: boolean;
  supportedLoopModes: import("./agent-loop.js").AgentLoopMode[];
};
export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string };
export type ModelRequest = {
  role: ModelRole;
  modelConfig?: ModelRoleConfig | undefined;
  purpose?: "exploration" | "title" | undefined;
  messages: ModelMessage[];
  conversationId?: string | undefined;
  providerThreadId?: string | undefined;
  cwd?: string | undefined;
  continuationPrompt?: string | undefined;
  tools?: ModelToolDefinition[] | undefined;
  signal?: AbortSignal | undefined;
};
export type ModelEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "text.delta"; text: string; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "provider.activity"; phase: "started" | "completed"; itemId: string; itemType: string; title: string | null; summary: string | null; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "tool.call"; call: ToolCall }
  | { type: "turn.input_required"; request: ModelInputRequest }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" };

export interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void>;
  cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void>;
  configFor(role: ModelRole): ModelRoleConfig;
  capabilities?(role: ModelRole): ModelCapabilities;
  readRateLimits?(): Promise<MappedCodexRateLimits>;
}

export class StubModelGateway implements ModelGateway {
  constructor(private readonly configs: Record<ModelRole, ModelRoleConfig>) {}

  configFor(role: ModelRole): ModelRoleConfig { return this.configs[role]; }

  capabilities(_role: ModelRole): ModelCapabilities {
    return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield { type: "turn.cancelled" };
      return;
    }
    yield { type: "text.delta", text: request.role === "explorer" ? "Stub Explorer response" : "Stub Executor response" };
    yield { type: "turn.completed" };
  }

  async answerUserInput(): Promise<void> { return undefined; }
  async cancel(): Promise<void> { return undefined; }
  async readRateLimits(): Promise<MappedCodexRateLimits> { return { available: false, fiveHour: null, sevenDay: null, reason: "Codex rate-limit telemetry is unavailable" }; }
}

export type ModelResult = { text: string; requestId: string | null; model: string };
export type ModelFetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type ModelFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal | undefined }) => Promise<ModelFetchResponse>;
export type OpenAIModelGatewayOptions = { apiKey: string; roles: Record<ModelRole, ModelRoleConfig>; baseUrl?: string | undefined; fetchFn?: ModelFetch | undefined };

export class OpenAIModelGateway implements ModelGateway {
  private readonly fetchFn: ModelFetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIModelGatewayOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";
    this.fetchFn = options.fetchFn ?? (async (url, init) => {
      const requestInit: RequestInit = { method: init.method, headers: init.headers, body: init.body };
      if (init.signal) requestInit.signal = init.signal;
      const response = await fetch(url, requestInit);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });
  }

  configFor(role: ModelRole): ModelRoleConfig { return this.options.roles[role]; }

  capabilities(_role: ModelRole): ModelCapabilities {
    return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const config = { ...this.configFor(request.role), ...(request.modelConfig ?? {}) };
    const input = request.continuationPrompt ? [...request.messages, { role: "user" as const, content: request.continuationPrompt }] : request.messages;
    const body: Record<string, unknown> = { model: config.model, input, stream: false };
    if (request.tools?.length) body.tools = request.tools;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxOutputTokens !== undefined) body.max_output_tokens = config.maxOutputTokens;
    const response = await this.fetchFn(this.baseUrl, { method: "POST", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: request.signal });
    if (!response.ok) throw new Error(`OpenAI Responses API failed with status ${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    return { text: typeof payload.output_text === "string" ? payload.output_text : extractResponseText(payload), requestId: typeof payload.id === "string" ? payload.id : null, model: config.model };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) { yield { type: "turn.cancelled" }; return; }
    try {
      const result = await this.complete(request);
      yield { type: "text.delta", text: result.text };
      yield { type: "turn.completed" };
    } catch (error) {
      if (request.signal?.aborted) yield { type: "turn.cancelled" };
      else yield { type: "turn.failed", error: error instanceof Error ? error.message : "Model request failed" };
    }
  }

  async answerUserInput(): Promise<void> {
    throw new Error("OpenAI Responses backend does not support Codex structured user input");
  }

  async cancel(): Promise<void> { return undefined; }
}

function extractResponseText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
  }).join("");
}

export class ExplorerThreadService {
  private readonly jobs = new Map<string, { userId: string; assistantId: string; loopId?: string | undefined; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean; continuationCount: number }>();
  private readonly agentLoops: AgentLoopEngine;
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();
  private readonly plans: PlanService;
  private readonly maxAutoContinuationTurns: number;
  private readonly loopMaxSteps: number;
  private readonly titleGenerator: ExplorerTitleGenerator | undefined;
  private readonly cwdForProject: ((projectId: string) => string | undefined) | undefined;
  private readonly modelConfigForProject: ((projectId: string) => ModelRoleConfig | undefined) | undefined;

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, options: { maxAutoContinuationTurns?: number | undefined; maxSteps?: number | undefined; maxDurationMs?: number | undefined; maxRepeatedToolCalls?: number | undefined; maxNoProgressSteps?: number | undefined; titleGenerator?: ExplorerTitleGenerator | undefined; cwdForProject?: ((projectId: string) => string | undefined) | undefined; modelConfigForProject?: ((projectId: string) => ModelRoleConfig | undefined) | undefined } = {}) {
    this.titleGenerator = options.titleGenerator;
    this.cwdForProject = options.cwdForProject;
    this.modelConfigForProject = options.modelConfigForProject;
    this.plans = new PlanService(store);
    this.loopMaxSteps = options.maxSteps ?? (options.maxAutoContinuationTurns ?? 4) + 1;
    this.agentLoops = new AgentLoopEngine(store, model, undefined, {
      defaultMaxSteps: options.maxSteps ?? (options.maxAutoContinuationTurns ?? 4) + 1,
      ...(options.maxDurationMs === undefined ? {} : { defaultMaxDurationMs: options.maxDurationMs }),
      ...(options.maxRepeatedToolCalls === undefined ? {} : { defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls }),
      ...(options.maxNoProgressSteps === undefined ? {} : { defaultMaxNoProgressSteps: options.maxNoProgressSteps }),
    });
    this.maxAutoContinuationTurns = options.maxAutoContinuationTurns ?? 4;
    for (const thread of store.listThreads()) {
      if (thread.titleSource === "AUTO" && thread.titleStatus === "GENERATING") store.updateThread({ ...thread, titleStatus: "FAILED" });
    }
    for (const thread of store.listThreads()) {
      const recoveredTurnIds = new Set<string>();
      for (const request of store.listInputRequests(thread.id)) {
        if (request.status === "OPEN" || request.status === "SUBMITTING" || request.status === "RECOVERY_REQUIRED") {
          if (request.status === "OPEN" || request.status === "SUBMITTING") store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
          const turn = store.listTurns(thread.id).find((item) => item.id === request.localTurnId);
          if (turn && (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT")) {
            store.updateTurn({ ...turn, status: "FAILED", error: "STRUCTURED_INPUT_RECOVERY_REQUIRED", content: turn.content || "模型回合中断，需要恢复结构化输入" });
            recoveredTurnIds.add(turn.id);
          }
          if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
        }
      }
      for (const turn of store.listTurns(thread.id)) {
        if (recoveredTurnIds.has(turn.id) || (turn.status !== "RUNNING" && turn.status !== "WAITING_FOR_INPUT")) continue;
        store.updateTurn({ ...turn, status: "FAILED", error: "EXPLORER_TURN_RECOVERY_REQUIRED", content: turn.content || "模型回合中断，需要重新开始探索" });
        if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
      }
    }
  }

  async startTurn(input: { threadId: string; content: string; clientTurnId: string }): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string }> {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`ExplorerThread ${input.threadId} not found`);
    const prior = this.store.getIdempotency("explorer-turn", input.clientTurnId);
    if (prior) return prior as unknown as { user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string };
    if ([...this.jobs.keys()].includes(input.threadId) || this.store.listTurns(input.threadId).some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT")) {
      throw new Error(`ExplorerThread ${input.threadId} already has an active turn`);
    }
    const turns = this.store.listTurns(input.threadId);
    const user: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "user", content: input.content, status: "COMPLETED", createdAt: this.store.now(), sequence: turns.length + 1 };
    const assistant: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "assistant", content: "", status: "RUNNING", createdAt: this.store.now(), sequence: turns.length + 2 };
    this.store.saveTurn(user);
    this.store.saveTurn(assistant);
    this.store.updateThread({ ...thread, messageCount: thread.messageCount + 2, lastActivityAt: assistant.createdAt });
    this.scheduleTitleGeneration(thread.id, input.content);
    const accepted = { user, assistant, eventsUrl: `/api/v4/projects/${thread.projectId}/explorer-thread/events?threadId=${encodeURIComponent(thread.id)}` };
    this.publish(this.store.appendEvent({ type: "explorer.turn.accepted", aggregateId: input.threadId, payload: { turnId: assistant.id, userTurnId: user.id } }));
    const job: { userId: string; assistantId: string; loopId?: string; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean; continuationCount: number } = { userId: user.id, assistantId: assistant.id, providerThreadId: thread.providerThreadId, providerTurnId: null, cancelled: false, continuationCount: 0 };
    this.jobs.set(input.threadId, job);
    const loop = await this.agentLoops.start({
      ownerType: "explorer-turn",
      ownerId: assistant.id,
      role: "explorer",
      mode: this.modelConfigForProject?.(thread.projectId)?.loopMode ?? "provider-controlled",
      maxSteps: this.loopMaxSteps,
      modelRequest: { messages: this.store.listTurns(thread.id).filter((turn) => turn.id !== assistant.id).map((turn) => ({ role: turn.role, content: turn.content })), conversationId: thread.id, ...(thread.providerThreadId ? { providerThreadId: thread.providerThreadId } : {}), ...(this.cwdForProject?.(thread.projectId) ? { cwd: this.cwdForProject(thread.projectId) } : {}), ...(this.modelConfigForProject?.(thread.projectId) ? { modelConfig: this.modelConfigForProject(thread.projectId) } : {}) },
      gate: new PlanCompletenessGate(),
      onEvent: (event) => this.handleExplorerLoopEvent(thread.id, assistant.id, event),
    });
    job.loopId = loop.id;
    const acceptedWithLoop = { ...accepted, loopId: loop.id };
    this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithLoop as unknown as Record<string, unknown>);
    return acceptedWithLoop;
  }

  async backfillTitles(): Promise<void> {
    if (!this.titleGenerator) return;
    await Promise.all(this.store.listThreads().map(async (thread) => {
      if (thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
      const firstUser = this.store.listTurns(thread.id).find((turn) => turn.role === "user" && turn.content.trim());
      if (!firstUser) {
        const placeholder = placeholderExplorerTitle(thread.createdAt);
        if (thread.title !== placeholder) this.store.updateThread({ ...thread, title: placeholder });
        return;
      }
      this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
      await this.generateTitle(thread.id, firstUser.content);
    }));
  }

  private scheduleTitleGeneration(threadId: string, content: string): void {
    if (!this.titleGenerator || !content.trim()) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
    if (this.store.listTurns(threadId).filter((turn) => turn.role === "user" && turn.content.trim()).length !== 1) return;
    this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
    void this.generateTitle(threadId, content);
  }

  private async generateTitle(threadId: string, content: string): Promise<void> {
    const generator = this.titleGenerator;
    if (!generator) return;
    try {
      const generated = normalizeExplorerTitle(await generator.generate({ threadId, content }));
      if (!generated) throw new Error("Explorer title generator returned an invalid title");
      const thread = this.store.getThread(threadId);
      if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "GENERATING") return;
      const updated = this.store.updateThread({ ...thread, title: composeExplorerTitle(thread.createdAt, generated), titleStatus: "GENERATED" });
      this.publish(this.store.appendEvent({ type: "explorer.title.updated", aggregateId: threadId, payload: { explorerId: threadId, title: updated.title, titleStatus: updated.titleStatus } }));
    } catch {
      const thread = this.store.getThread(threadId);
      if (thread?.titleSource === "AUTO" && thread.titleStatus === "GENERATING") this.store.updateThread({ ...thread, title: placeholderExplorerTitle(thread.createdAt), titleStatus: "FAILED" });
    }
  }

  async answerInput(input: { threadId: string; requestId: string; answers: ModelInputAnswers; clientRequestId: string; actorId: string }): Promise<{ request: ExplorerInputRequest; turn: ExplorerTurn }> {
    const existingResult = this.store.getIdempotency("input-answer", input.clientRequestId);
    if (existingResult) return existingResult as unknown as { request: ExplorerInputRequest; turn: ExplorerTurn };
    const request = this.store.getInputRequest(input.requestId);
    if (!request) throw new Error("Input request not found");
    if (request.threadId !== input.threadId) throw new Error("Input request does not belong to this ExplorerThread");
    if (request.status === "ANSWERED") {
      const result = { request, turn: this.currentAssistant(input.threadId) };
      this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
      return result;
    }
    if (request.status !== "OPEN") throw new Error(`Input request cannot be answered from ${request.status}`);
    validateInputAnswers(request.questions, input.answers);
    const job = this.jobs.get(input.threadId);
    if (!job?.loopId || job.providerThreadId !== request.providerThreadId || job.providerTurnId !== request.providerTurnId) throw new Error("Input request requires recovery before it can be answered");
    this.store.updateInputRequest({ ...request, status: "SUBMITTING" });
    try {
      await this.agentLoops.answerInput(job.loopId, request.providerRequestId, input.answers);
    } catch (error) {
      const recovery = { ...request, status: "RECOVERY_REQUIRED" as const };
      this.store.updateInputRequest(recovery);
      this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: input.threadId, payload: { inputRequestId: request.id, recoveryRequired: true, error: error instanceof Error ? error.message : String(error) } }));
      throw new Error(`Structured input response is uncertain; recovery is required: ${error instanceof Error ? error.message : String(error)}`);
    }
    const answered: ExplorerInputRequest = {
      ...request,
      status: "ANSWERED",
      answeredAt: this.store.now(),
      answeredBy: input.actorId,
      redactedAnswerSummary: Object.fromEntries(request.questions.map((question) => {
        const answers = (input.answers[question.id]?.answers ?? []).map((answer) => answer.trim()).filter(Boolean);
        return [question.id, { answerCount: answers.length, secret: question.isSecret, ...(question.isSecret ? {} : { answers }) }];
      })),
    };
    this.store.updateInputRequest(answered);
    const assistant = this.currentAssistant(input.threadId);
    this.store.updateTurn({ ...assistant, status: "RUNNING" });
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: "explorer.turn.input.resolved", aggregateId: input.threadId, payload: { inputRequestId: request.id, actorId: input.actorId, answerCounts: answered.redactedAnswerSummary } }));
    const result = { request: answered, turn: this.currentAssistant(input.threadId) };
    this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
    return result;
  }

  async cancelTurn(input: { threadId: string; turnId: string; reason: string }): Promise<ExplorerTurn> {
    const job = this.jobs.get(input.threadId);
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === input.turnId && turn.role === "assistant");
    if (!job || !assistant) throw new Error("Active Explorer turn not found");
    job.cancelled = true;
    if (job.loopId) await this.agentLoops.cancel(job.loopId, input.reason);
    else if (job.providerThreadId) await this.model.cancel({ conversationId: input.threadId, providerThreadId: job.providerThreadId, ...(job.providerTurnId ? { providerTurnId: job.providerTurnId } : {}) });
    for (const request of this.store.listInputRequests(input.threadId, "OPEN")) this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
    job.resolveInput?.();
    const cancelled: ExplorerTurn = { ...assistant, status: "CANCELLED", content: "本轮已取消", error: input.reason };
    this.store.updateTurn(cancelled);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: input.threadId, payload: { turnId: input.turnId, reason: input.reason } }));
    return cancelled;
  }

  agentLoopController(): Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> {
    return {
      pause: (loopId, reason) => this.pauseLoop(loopId, reason),
      resume: (loopId) => this.resumeLoop(loopId),
      cancel: (loopId, reason) => this.cancelLoop(loopId, reason),
    };
  }

  private loopTurn(loopId: string): { loop: AgentLoop; threadId: string; turnId: string } {
    const loop = this.store.getAgentLoop(loopId);
    if (!loop || loop.ownerType !== "explorer-turn") throw new Error(`Explorer AgentLoop ${loopId} not found`);
    const turn = this.store.listThreads().flatMap((thread) => this.store.listTurns(thread.id)).find((candidate) => candidate.id === loop.ownerId);
    if (!turn) throw new Error(`Explorer turn for AgentLoop ${loopId} not found`);
    return { loop, threadId: turn.threadId, turnId: turn.id };
  }

  async pauseLoop(loopId: string, reason: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    const paused = await this.agentLoops.pause(loopId, reason);
    const turn = this.store.listTurns(threadId).find((item) => item.id === turnId);
    if (turn && turn.status === "RUNNING") this.store.updateTurn({ ...turn, status: "QUEUED" });
    this.publish(this.store.appendEvent({ type: "explorer.thread.state.changed", aggregateId: threadId, payload: { state: "PAUSED", loopId, turnId, reason } }));
    return paused;
  }

  async resumeLoop(loopId: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    const resumed = await this.agentLoops.resume(loopId);
    const turn = this.store.listTurns(threadId).find((item) => item.id === turnId);
    if (turn && turn.status === "QUEUED") this.store.updateTurn({ ...turn, status: "RUNNING" });
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    return resumed;
  }

  async cancelLoop(loopId: string, reason: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    await this.cancelTurn({ threadId, turnId, reason });
    return this.agentLoops.get(loopId);
  }

  subscribeEvents(threadId: string, listener: (event: DomainEvent) => void, afterSequence = 0): () => void {
    for (const event of this.store.listEvents({ aggregateId: threadId, afterSequence })) listener(event);
    const listeners = this.listeners.get(threadId) ?? new Set<(event: DomainEvent) => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.listeners.delete(threadId); };
  }

  async send(threadId: string, content: string, signal?: AbortSignal): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`ExplorerThread ${threadId} not found`);
    const user: ExplorerTurn = { id: this.store.nextId("turn"), threadId, role: "user", content, createdAt: this.store.now(), sequence: this.store.listTurns(threadId).length + 1 };
    this.store.saveTurn(user);
    this.store.updateThread({ ...thread, messageCount: thread.messageCount + 1, lastActivityAt: user.createdAt });
    this.scheduleTitleGeneration(threadId, content);
    const messages = this.store.listTurns(threadId).map((turn) => ({ role: turn.role, content: turn.content }));
    let assistantContent = "";
    let cancelled = false;
    let failure: string | null = null;
    const modelRequest: ModelRequest = {
      role: "explorer",
      ...(this.modelConfigForProject?.(thread.projectId) ? { modelConfig: this.modelConfigForProject(thread.projectId) } : {}),
      messages,
      conversationId: thread.id,
      ...(thread.providerThreadId ? { providerThreadId: thread.providerThreadId } : {}),
      ...(signal ? { signal } : {}),
    };
    for await (const event of this.model.stream(modelRequest)) {
      if (event.type === "thread.started") {
        const current = this.store.getThread(threadId) ?? thread;
        this.store.updateThread({ ...current, providerThreadId: event.threadId });
      }
      if (event.type === "text.delta") assistantContent += event.text;
      if (event.type === "turn.input_required") {
        await this.model.cancel({ conversationId: threadId, providerThreadId: event.request.threadId, providerTurnId: event.request.turnId }).catch(() => undefined);
        throw new Error("STRUCTURED_INPUT_REQUIRES_V4");
      }
      if (event.type === "turn.cancelled") cancelled = true;
      if (event.type === "turn.failed") failure = event.error;
    }
    if (!cancelled && !failure && !assistantContent.trim()) failure = "模型未返回内容";
    const status = cancelled ? "CANCELLED" : failure ? "FAILED" : "COMPLETED";
    const assistant: ExplorerTurn = {
      id: this.store.nextId("turn"),
      threadId,
      role: "assistant",
      content: cancelled ? "Turn cancelled" : failure ? `模型调用失败：${failure}` : assistantContent,
      status,
      ...(failure ? { error: failure } : {}),
      createdAt: this.store.now(),
      sequence: user.sequence + 1,
    };
    this.store.saveTurn(assistant);
    const current = this.store.getThread(threadId) ?? thread;
    this.store.updateThread({ ...current, messageCount: current.messageCount + 1, lastActivityAt: assistant.createdAt });
    this.store.appendEvent({ type: failure ? "explorer.turn.failed" : "explorer.turn.completed", aggregateId: threadId, payload: { userTurnId: user.id, assistantTurnId: assistant.id, cancelled, ...(failure ? { error: failure } : {}) } });
    return { user, assistant };
  }

  private handleExplorerLoopEvent(threadId: string, assistantId: string, event: AgentLoopEvent): void {
    const job = this.jobs.get(threadId);
    if (!job) return;
    if (event.type === "agent.provider.thread.started") {
      const providerThreadId = String(event.payload.threadId ?? "");
      if (providerThreadId) {
        job.providerThreadId = providerThreadId;
        const thread = this.store.getThread(threadId);
        if (thread) this.store.updateThread({ ...thread, providerThreadId, lastActivityAt: this.store.now() });
      }
      return;
    }
    if (event.type === "agent.model.text.delta") {
      const text = typeof event.payload.text === "string" ? event.payload.text : "";
      if (!text) return;
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (!current) return;
      this.store.updateTurn({ ...current, content: current.content + text, status: "RUNNING" });
      this.publish(this.store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: threadId, payload: { turnId: assistantId, text } }));
      return;
    }
    if (event.type === "agent.input.required") {
      const request = event.payload.request as ModelInputRequest | undefined;
      if (!request) return;
      job.providerThreadId = request.threadId;
      job.providerTurnId = request.turnId;
      const inputRequest: ExplorerInputRequest = { id: this.store.nextId("input"), threadId, localTurnId: assistantId, providerRequestId: request.requestId, providerThreadId: request.threadId, providerTurnId: request.turnId, itemId: request.itemId, questions: request.questions, isBlocking: request.isBlocking, autoResolutionMs: request.autoResolutionMs, status: "OPEN", createdAt: this.store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null };
      const saved = this.store.saveInputRequest(inputRequest);
      const currentThread = this.store.getThread(threadId);
      if (currentThread) this.store.updateThread({ ...currentThread, state: "WAITING_FOR_INPUT", lastActivityAt: this.store.now() });
      const currentTurn = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (currentTurn) this.store.updateTurn({ ...currentTurn, status: "WAITING_FOR_INPUT" });
      this.publish(this.store.appendEvent({ type: "explorer.turn.input_required", aggregateId: threadId, payload: { requestId: saved.id, threadId, localTurnId: assistantId, providerRequestId: saved.providerRequestId, providerThreadId: saved.providerThreadId, providerTurnId: saved.providerTurnId, itemId: saved.itemId, questions: saved.questions, isBlocking: saved.isBlocking, autoResolutionMs: saved.autoResolutionMs } }));
      return;
    }
    if (event.type === "agent.loop.completed") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    if (event.type === "agent.loop.cancelled") {
      for (const request of this.store.listInputRequests(threadId)) if (request.status === "OPEN" || request.status === "SUBMITTING") this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (current && current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "CANCELLED", content: current.content || "本轮已取消" });
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: threadId, payload: { turnId: assistantId, reason: event.payload.reason } }));
      this.finishExplorerJob(threadId);
      return;
    }
    if (event.type === "agent.loop.failed") this.handleExplorerLoopFailure(threadId, assistantId, String(event.payload.error ?? event.payload.reason ?? "AgentLoop failed"));
  }

  private finalizeExplorerLoop(threadId: string, assistantId: string): void {
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const thread = this.store.getThread(threadId);
    if (!current || !thread) return;
    const assessment = assessPlanCompletion(current.content);
    this.store.updateThread({ ...thread, exploration: { ...thread.exploration, status: assessment.status, missing: assessment.missing, completed: assessment.completed, lastAssessedTurnId: assistantId }, lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: assessment.status === "READY" ? "explorer.plan.ready" : "explorer.plan.incomplete", aggregateId: threadId, payload: { turnId: assistantId, missing: assessment.missing, completed: assessment.completed } }));
    if (assessment.status === "READY" && assessment.artifact) {
      const existing = this.store.listPlans().find((plan) => plan.sourceExplorerThreadId === threadId && plan.status === "DRAFT");
      const source = this.planSource(assistantId);
      const plan = existing ? this.store.updatePlan({ ...existing, ...source }) : this.plans.createCandidatePlan({ projectId: thread.projectId, sourceExplorerThreadId: threadId, title: assessment.artifact.title, contract: assessment.artifact.contract, ...source });
      this.store.updateThread({ ...this.store.getThread(threadId)!, exploration: { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], candidatePlanId: plan.id, lastAssessedTurnId: assistantId }, lastActivityAt: this.store.now() });
    }
    this.store.updateTurn({ ...current, status: "COMPLETED", content: stripPlanProtocol(current.content) });
    this.publish(this.store.appendEvent({ type: "explorer.turn.completed", aggregateId: threadId, payload: { assistantTurnId: assistantId, planReady: assessment.status === "READY" } }));
    this.finishExplorerJob(threadId);
  }

  private handleExplorerLoopFailure(threadId: string, assistantId: string, error: string): void {
    if (error === "MAX_STEPS_EXCEEDED" || error === "NO_PROGRESS") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    for (const request of this.store.listInputRequests(threadId)) if (request.status === "OPEN" || request.status === "SUBMITTING") this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    if (current && current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "FAILED", error, content: current.content || `模型调用失败：${error}` });
    this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: threadId, payload: { assistantTurnId: assistantId, error } }));
    this.finishExplorerJob(threadId);
  }

  private finishExplorerJob(threadId: string): void {
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.jobs.delete(threadId);
  }

  private planSource(assistantId: string): { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null } {
    const loop = this.store.listAgentLoops(assistantId).at(-1);
    const steps = loop ? this.store.listAgentLoopSteps(loop.id) : [];
    const latestProviderStep = [...steps].reverse().find((step) => typeof step.payload.providerItemId === "string" || typeof step.payload.itemId === "string");
    const providerThreadId = loop?.providerThreadId ?? [...steps].reverse().find((step) => step.providerThreadId)?.providerThreadId ?? null;
    const providerTurnId = loop?.providerTurnId ?? [...steps].reverse().find((step) => step.providerTurnId)?.providerTurnId ?? null;
    const providerItemId = typeof latestProviderStep?.payload.providerItemId === "string"
      ? latestProviderStep.payload.providerItemId
      : typeof latestProviderStep?.payload.itemId === "string" ? latestProviderStep.payload.itemId : null;
    return { sourceTurnId: assistantId, providerThreadId, providerTurnId, providerItemId };
  }

  private async runAsyncTurn(threadId: string, user: ExplorerTurn, assistant: ExplorerTurn, job: { userId: string; assistantId: string; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean; continuationCount: number }): Promise<void> {
    let failure: string | null = null;
    let continuationPrompt: string | undefined;
    let turnCompleted = false;
    try {
      while (!job.cancelled && !failure) {
        turnCompleted = false;
        const historical = this.store.listTurns(threadId).filter((turn) => turn.id !== assistant.id).map((turn) => ({ role: turn.role, content: turn.content }));
        for await (const event of this.model.stream({ role: "explorer", messages: historical, conversationId: threadId, ...(job.providerThreadId ? { providerThreadId: job.providerThreadId } : {}), ...(continuationPrompt ? { continuationPrompt } : {}) })) {
          if (event.type === "thread.started") {
            job.providerThreadId = event.threadId;
            const thread = this.store.getThread(threadId);
            if (thread) this.store.updateThread({ ...thread, providerThreadId: event.threadId, lastActivityAt: this.store.now() });
          } else if (event.type === "text.delta") {
            const current = this.currentAssistant(threadId);
            this.store.updateTurn({ ...current, content: current.content + event.text, status: "RUNNING" });
            this.publish(this.store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: threadId, payload: { turnId: assistant.id, text: event.text } }));
          } else if (event.type === "turn.input_required") {
            job.providerThreadId = event.request.threadId;
            job.providerTurnId = event.request.turnId;
            const inputRequest: ExplorerInputRequest = { id: this.store.nextId("input"), threadId, localTurnId: assistant.id, providerRequestId: event.request.requestId, providerThreadId: event.request.threadId, providerTurnId: event.request.turnId, itemId: event.request.itemId, questions: event.request.questions, isBlocking: event.request.isBlocking, autoResolutionMs: event.request.autoResolutionMs, status: "OPEN", createdAt: this.store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null };
            const saved = this.store.saveInputRequest(inputRequest);
            const current = this.store.getThread(threadId);
            if (current) this.store.updateThread({ ...current, state: "WAITING_FOR_INPUT", lastActivityAt: this.store.now() });
            this.store.updateTurn({ ...this.currentAssistant(threadId), status: "WAITING_FOR_INPUT" });
            this.publish(this.store.appendEvent({ type: "explorer.turn.input_required", aggregateId: threadId, payload: { requestId: saved.id, threadId, localTurnId: assistant.id, providerRequestId: saved.providerRequestId, providerThreadId: saved.providerThreadId, providerTurnId: saved.providerTurnId, itemId: saved.itemId, questions: saved.questions, isBlocking: saved.isBlocking, autoResolutionMs: saved.autoResolutionMs } }));
            await new Promise<void>((resolve) => { job.resolveInput = resolve; });
            if (job.cancelled) break;
          } else if (event.type === "turn.cancelled") {
            job.cancelled = true;
          } else if (event.type === "turn.failed") {
            failure = event.error;
          } else if (event.type === "turn.completed") {
            turnCompleted = true;
          }
        }
        if (job.cancelled || failure) break;
        if (!turnCompleted) {
          failure = "模型回合未正常完成";
          break;
        }
        const current = this.currentAssistant(threadId);
        const assessment = assessPlanCompletion(current.content);
        const currentThread = this.store.getThread(threadId);
        if (currentThread) {
          this.store.updateThread({ ...currentThread, exploration: { ...currentThread.exploration, status: assessment.status, missing: assessment.missing, completed: assessment.completed, lastAssessedTurnId: assistant.id }, lastActivityAt: this.store.now() });
          this.publish(this.store.appendEvent({ type: assessment.status === "READY" ? "explorer.plan.ready" : "explorer.plan.incomplete", aggregateId: threadId, payload: { turnId: assistant.id, missing: assessment.missing, completed: assessment.completed } }));
        }
        if (assessment.status === "READY" && assessment.artifact) {
          const existing = this.store.listPlans().find((plan) => plan.sourceExplorerThreadId === threadId && plan.status === "DRAFT");
          const source = this.planSource(assistant.id);
          const plan = existing ? this.store.updatePlan({ ...existing, ...source }) : this.plans.createCandidatePlan({ projectId: currentThread?.projectId ?? "", sourceExplorerThreadId: threadId, title: assessment.artifact.title, contract: assessment.artifact.contract, ...source });
          const latest = this.store.getThread(threadId);
          if (latest) this.store.updateThread({ ...latest, exploration: { ...latest.exploration, status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], candidatePlanId: plan.id, lastAssessedTurnId: assistant.id }, lastActivityAt: this.store.now() });
          this.store.updateTurn({ ...current, content: stripPlanProtocol(current.content), status: "COMPLETED" });
          break;
        }
        if (job.continuationCount >= this.maxAutoContinuationTurns) break;
        job.continuationCount += 1;
        continuationPrompt = buildContinuationPrompt(assessment.missing);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      for (const request of this.store.listInputRequests(threadId, "OPEN")) this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    }
    if (job.cancelled) {
      const current = this.currentAssistant(threadId);
      if (current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "CANCELLED", content: current.content || "本轮已取消" });
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: threadId, payload: { turnId: assistant.id } }));
    } else {
      const current = this.currentAssistant(threadId);
      if (!failure && !current.content.trim()) failure = "模型未返回内容";
      this.store.updateTurn({ ...current, status: failure ? "FAILED" : "COMPLETED", content: failure ? `模型调用失败：${failure}` : stripPlanProtocol(current.content), ...(failure ? { error: failure } : {}) });
      this.publish(this.store.appendEvent({ type: failure ? "explorer.turn.failed" : "explorer.turn.completed", aggregateId: threadId, payload: { userTurnId: user.id, assistantTurnId: assistant.id, ...(failure ? { error: failure } : {}) } }));
    }
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.jobs.delete(threadId);
  }

  private currentAssistant(threadId: string): ExplorerTurn {
    const turn = [...this.store.listTurns(threadId)].reverse().find((item) => item.role === "assistant");
    if (!turn) throw new Error(`Assistant turn for ${threadId} not found`);
    return turn;
  }

  private publish(event: DomainEvent): void {
    for (const listener of this.listeners.get(event.aggregateId) ?? []) listener(event);
  }
}

function validateInputAnswers(questions: ModelInputQuestion[], answers: ModelInputAnswers): void {
  const questionIds = new Set(questions.map((question) => question.id));
  for (const questionId of Object.keys(answers)) if (!questionIds.has(questionId)) throw new Error(`Unknown question id: ${questionId}`);
  for (const question of questions) {
    const values = answers[question.id]?.answers;
    if (!values || values.length === 0) throw new Error(`Answer is required for question ${question.id}`);
    if (question.options) {
      const allowed = new Set(question.options.map((option) => option.label));
      const customValues = values.filter((value) => !allowed.has(value));
      if (customValues.length > 0 && (!question.isOther || values.length !== 1)) throw new Error(`Invalid option for question ${question.id}`);
    }
    if (question.isOther && (!question.options || values.some((value) => !question.options!.some((option) => option.label === value))) && values.length !== 1) throw new Error(`Other answer must contain exactly one value for question ${question.id}`);
  }
}

export { CodexAppServerClient, CodexAppServerGateway } from "./codex-app-server.js";
export type { CodexAppServerClientOptions, CodexAppServerEvent, CodexAppServerGatewayOptions, CodexAppServerSession, CodexAppServerSessionFactory, CodexSpawnProcess, CodexThreadStartParams, CodexTurnStartParams } from "./codex-app-server.js";

export type RunStatus = "QUEUED" | "STARTING" | "IN_PROGRESS" | "READY_FOR_VERIFY" | "VERIFYING" | "MERGE_READY" | "BLOCKED" | "NEEDS_PLAN_CHANGE" | "STALE" | "RECOVERING" | "CANCELLED";
export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";
export type JournalEntryType = "RUN_CREATED" | "HOOK_COMPLETED" | "HOOK_FAILED" | "HOOK_SKIPPED" | "MODEL_OUTPUT" | "TOOL_CALL" | "TASK_PROGRESS" | "USER_GUIDANCE" | "REPAIR" | "VERIFICATION" | "COMMIT" | "RECOVERY";

export type ExecutionJournalEntry = {
  sequence: number;
  type: JournalEntryType;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type ExecutionThread = {
  id: string;
  runId: string;
  state: ExecutionThreadState;
  journal: ExecutionJournalEntry[];
};

export type Run = {
  id: string;
  projectId: string;
  planId: string;
  planRevision: number;
  status: RunStatus;
  branch: string;
  workspacePath: string | null;
  baseCommit: string;
  executionThreadId: string;
  createdAt: string;
  startedAt: string | null;
};

export type Workspace = { path: string; branch: string; baseCommit: string };
export type WorkspaceAdapter = {
  create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace>;
  remove(workspace: Workspace): Promise<void>;
};

export type GitCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
export type LocalGitWorktreeOptions = { projectRoot: string; worktreeRoot: string; runGit?: GitCommandRunner | undefined };

export class LocalGitWorktreeAdapter implements WorkspaceAdapter {
  private readonly runGit: GitCommandRunner;

  constructor(private readonly options: LocalGitWorktreeOptions) {
    this.runGit = options.runGit ?? defaultGitCommand;
  }

  async create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace> {
    const path = resolve(this.options.worktreeRoot, input.runId);
    const verified = await this.runGit(["rev-parse", "--verify", input.baseCommit], this.options.projectRoot);
    if (verified.exitCode !== 0) throw new Error(`Base commit ${input.baseCommit} could not be verified`);
    const created = await this.runGit(["worktree", "add", "-b", input.branch, path, input.baseCommit], this.options.projectRoot);
    if (created.exitCode !== 0) throw new Error(`Git worktree could not be created: ${created.stderr}`);
    return { path, branch: input.branch, baseCommit: input.baseCommit };
  }

  async remove(workspace: Workspace): Promise<void> {
    const removed = await this.runGit(["worktree", "remove", "--force", workspace.path], this.options.projectRoot);
    if (removed.exitCode !== 0) throw new Error(`Git worktree could not be removed: ${removed.stderr}`);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

export type SchedulerOptions = {
  store: PipelineStore;
  workspace: WorkspaceAdapter;
  hooks: LifecycleHookRunner;
  globalConcurrency?: number;
  workspaceFactory?: (snapshot: ProjectExecutionSnapshot) => WorkspaceAdapter;
  hookRunnerFactory?: (snapshot: ProjectExecutionSnapshot) => LifecycleHookRunner;
  executor?: {
    start(run: Run, revision: PlanRevisionV2): Promise<AgentLoop>;
    pause?: AgentLoopRunner["pause"];
    resume?: AgentLoopRunner["resume"];
    cancel?: AgentLoopRunner["cancel"];
  };
};

export class Scheduler {
  private readonly planService: PlanService;
  private readonly runs = new Map<string, Run>();
  private readonly threads = new Map<string, ExecutionThread>();

  constructor(private readonly options: SchedulerOptions) {
    this.planService = new PlanService(options.store);
  }

  agentLoopController(): Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> | undefined {
    const executor = this.options.executor;
    if (!executor?.pause || !executor.resume || !executor.cancel) return undefined;
    return { pause: executor.pause.bind(executor), resume: executor.resume.bind(executor), cancel: executor.cancel.bind(executor) };
  }

  async start(planId: string, hooks: { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined } = {}): Promise<Run> {
    const existing = this.options.store.listRuns().find((run) => run.planId === planId && run.status !== "CANCELLED" && run.status !== "NEEDS_PLAN_CHANGE");
    if (existing) {
      this.runs.set(existing.id, existing);
      const savedThread = this.options.store.getExecutionThread(existing.executionThreadId);
      if (savedThread) this.threads.set(savedThread.id, savedThread);
      return existing;
    }
    const plan = this.planService.get(planId);
    if (plan.status !== "QUEUED") throw new Error(`Plan ${planId} must be queued before a run starts`);
    const revision = this.options.store.getRevision(plan.id, plan.revision);
    if (!revision) throw new Error(`Plan revision ${plan.id}@${plan.revision} is missing`);
    this.assertConcurrency(plan.projectId, revision);
    const createdAt = this.options.store.now();
    const runId = this.options.store.nextId("run");
    const thread: ExecutionThread = { id: this.options.store.nextId("execution-thread"), runId, state: "ACTIVE", journal: [] };
    const run: Run = { id: runId, projectId: plan.projectId, planId: plan.id, planRevision: revision.revision, status: "STARTING", branch: `factory/${runId}`, workspacePath: null, baseCommit: revision.contract.baseCommit, executionThreadId: thread.id, createdAt, startedAt: null };
    this.runs.set(run.id, run);
    this.threads.set(thread.id, thread);
    this.options.store.saveRun(run);
    this.options.store.saveExecutionThread(thread);
    this.append(thread, "RUN_CREATED", { planId: plan.id, revision: revision.revision });
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    const executionHooks = revision.projectConfigSnapshot?.settings.hooks ?? hooks;
    const workspace = await workspaceAdapter.create({ projectId: plan.projectId, runId, branch: run.branch, baseCommit: run.baseCommit });
    run.workspacePath = workspace.path;
    const startResult = await hookRunner.runStart(executionHooks.start, { projectId: plan.projectId, runId, workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, exitReason: "running" });
    if (startResult.status === "failed") {
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.append(thread, "HOOK_FAILED", { hook: "start", stderr: startResult.result?.stderr ?? "" });
      this.options.store.updatePlan({ ...plan, runId, status: "BLOCKED", attentionReason: "start hook failed", lastEventAt: this.options.store.now() });
      this.options.store.saveRun(run);
      return run;
    }
    run.status = "IN_PROGRESS";
    run.startedAt = this.options.store.now();
    this.append(thread, startResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "start" });
    if (!revision.projectConfigSnapshot) this.append(thread, "TASK_PROGRESS", { action: "legacy_plan_revision", reason: "Project configuration snapshot unavailable; using legacy/global runtime settings" });
    this.options.store.updatePlan({ ...plan, runId, status: "IN_PROGRESS", lastEventAt: run.startedAt });
    this.options.store.saveRun(run);
    if (this.options.executor) {
      try {
        const loop = await this.options.executor.start(run, revision);
        this.append(thread, "TASK_PROGRESS", { action: "executor_loop_created", loopId: loop.id });
        this.options.store.appendEvent({ type: "run.executor.event", aggregateId: run.id, payload: { executionThreadId: thread.id, action: "executor_loop_created", loopId: loop.id } });
      } catch (error) {
        run.status = "BLOCKED";
        thread.state = "BLOCKED";
        const reason = error instanceof Error ? error.message : String(error);
        this.append(thread, "RECOVERY", { action: "executor_loop_start_failed", reason });
        this.options.store.updatePlan({ ...plan, runId, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() });
        this.options.store.saveRun(run);
      }
    }
    return run;
  }

  async finish(runId: string, exitReason: string, hooks: { cleanup?: HookDefinition | undefined } = {}, cancellationReason = exitReason): Promise<Run> {
    const run = this.run(runId);
    if (run.status === "CANCELLED") {
      if (exitReason === "cancelled") {
        const plan = this.options.store.getPlan(run.planId);
        if (plan && plan.status !== "BLOCKED" && plan.status !== "MERGED") {
          this.options.store.updatePlan({ ...plan, status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() });
        }
      }
      return run;
    }
    const thread = this.thread(run.executionThreadId);
    const revision = this.options.store.getRevision(run.planId, run.planRevision);
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    const executionHooks = revision?.projectConfigSnapshot?.settings.hooks ?? hooks;
    if (run.workspacePath) {
      await workspaceAdapter.remove({ path: run.workspacePath, branch: run.branch, baseCommit: run.baseCommit });
    }
    const cleanupResult = await hookRunner.runCleanup(executionHooks.cleanup, { projectId: run.projectId, runId: run.id, workspacePath: run.workspacePath ?? "", branch: run.branch, baseCommit: run.baseCommit, exitReason });
    this.append(thread, cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "cleanup", exitReason });
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, attentionReason: "cleanup hook failed", lastEventAt: this.options.store.now() });
    }
    if (exitReason === "cancelled") run.status = "CANCELLED";
    thread.state = exitReason === "cancelled" ? "CANCELLED" : "COMPLETED";
    this.options.store.saveRun(run);
    this.options.store.saveExecutionThread(thread);
    if (exitReason === "cancelled") {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() });
    }
    return run;
  }

  private workspaceAdapterFor(revision: PlanRevisionV2 | undefined): WorkspaceAdapter {
    const snapshot = revision?.projectConfigSnapshot;
    return snapshot && this.options.workspaceFactory ? this.options.workspaceFactory(snapshot) : this.options.workspace;
  }

  private hookRunnerFor(revision: PlanRevisionV2 | undefined): LifecycleHookRunner {
    const snapshot = revision?.projectConfigSnapshot;
    return snapshot && this.options.hookRunnerFactory ? this.options.hookRunnerFactory(snapshot) : this.options.hooks;
  }

  private assertConcurrency(projectId: string, revision: PlanRevisionV2): void {
    const activeRuns = this.options.store.listRuns().filter((run) => EXECUTION_SLOT_RUN_STATUSES.has(run.status));
    const projectLimit = revision.projectConfigSnapshot?.settings.concurrency.maxParallelRuns;
    if (projectLimit !== undefined && activeRuns.filter((run) => run.projectId === projectId).length >= projectLimit) throw new Error(`Project ${projectId} concurrency limit reached (${projectLimit})`);
    if (this.options.globalConcurrency !== undefined && activeRuns.length >= this.options.globalConcurrency) throw new Error(`Global concurrency limit reached (${this.options.globalConcurrency})`);
  }

  pause(runId: string): Run {
    const run = this.run(runId);
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${runId} cannot be paused from ${run.status}`);
    const thread = this.thread(run.executionThreadId);
    if (thread.state !== "ACTIVE") throw new Error(`ExecutionThread ${thread.id} cannot be paused from ${thread.state}`);
    thread.state = "PAUSED";
    this.append(thread, "TASK_PROGRESS", { action: "paused", runId });
    this.options.store.appendEvent({ type: "run.paused", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  resume(runId: string): Run {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (run.status !== "IN_PROGRESS" || thread.state !== "PAUSED") throw new Error(`Run ${runId} cannot be resumed from ${run.status}/${thread.state}`);
    thread.state = "ACTIVE";
    this.append(thread, "TASK_PROGRESS", { action: "resumed", runId });
    this.options.store.appendEvent({ type: "run.resumed", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  addGuidance(runId: string, content: string): ExecutionThread {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (thread.state === "CANCELLED" || thread.state === "COMPLETED") throw new Error(`Run ${runId} is no longer accepting guidance`);
    this.append(thread, "USER_GUIDANCE", { content, runId });
    this.options.store.appendEvent({ type: "run.guidance.added", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return thread;
  }

  thread(threadId: string): ExecutionThread {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) throw new Error(`ExecutionThread ${threadId} not found`);
    this.threads.set(threadId, thread);
    return thread;
  }

  run(runId: string): Run {
    const run = this.options.store.getRun(runId) ?? this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this.runs.set(runId, run);
    return run;
  }

  private append(thread: ExecutionThread, type: JournalEntryType, payload: Record<string, unknown>): void {
    thread.journal.push({ sequence: thread.journal.length + 1, type, occurredAt: this.options.store.now(), payload });
    this.options.store.saveExecutionThread(thread);
  }
}

export type VerificationStatus = "PASSED" | "FAILED" | "BLOCKED";
export type VerificationRun = {
  id: string;
  runId: string;
  status: VerificationStatus;
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: CommandResult }>;
  completedAt: string;
};
export type VerificationCommandExecutor = (commandId: string, run: Run) => Promise<CommandResult>;
export type RepairExecutor = (run: Run, attempt: number) => Promise<boolean>;

export class VerificationService {
  constructor(private readonly store?: PipelineStore) {}

  async verify(run: Run, revision: PlanRevisionV2, execute: VerificationCommandExecutor, repair?: RepairExecutor): Promise<VerificationRun> {
    if (run.status !== "IN_PROGRESS" && run.status !== "READY_FOR_VERIFY") throw new Error(`Run ${run.id} cannot be verified from ${run.status}`);
    run.status = "VERIFYING";
    this.store?.saveRun(run);
    const commandResults: Array<{ commandId: string; result: CommandResult }> = [];
    let repairAttempts = 0;
    for (;;) {
      commandResults.length = 0;
      let failed = false;
      for (const commandId of revision.contract.verificationCommandIds) {
        const result = await execute(commandId, run);
        commandResults.push({ commandId, result });
        if (result.exitCode !== 0) { failed = true; break; }
      }
      if (!failed) {
        run.status = "MERGE_READY";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: "PASSED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
      if (!repair || repairAttempts >= revision.contract.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: repairAttempts >= revision.contract.maxRepairAttempts ? "BLOCKED" as const : "FAILED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
      repairAttempts += 1;
      const repaired = await repair(run, repairAttempts);
      if (!repaired && repairAttempts >= revision.contract.maxRepairAttempts) {
        run.status = "BLOCKED";
        const verification = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: "BLOCKED" as const, repairAttempts, commandResults: [...commandResults], completedAt: this.store?.now() ?? new Date().toISOString() };
        this.record(run, verification);
        return verification;
      }
    }
  }

  private record(run: Run, verification: VerificationRun): void {
    if (!this.store) return;
    this.store.saveVerificationRun(verification);
    this.store.saveRun(run);
    const plan = this.store.getPlan(run.planId);
    if (plan && plan.runId === run.id) {
      this.store.updatePlan({
        ...plan,
        status: verification.status === "PASSED" ? "MERGE_READY" : "BLOCKED",
        attentionReason: verification.status === "PASSED" ? null : "Verification failed",
        lastEventAt: verification.completedAt,
      });
    }
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (thread) {
      thread.journal.push({ sequence: thread.journal.length + 1, type: "VERIFICATION", occurredAt: verification.completedAt, payload: verification });
      this.store.saveExecutionThread(thread);
    }
    this.store.appendEvent({ type: "verification.completed", aggregateId: run.id, payload: verification });
  }
}

export type MergeRequest = {
  id: string;
  runId: string;
  planId: string;
  sourceCommit: string;
  targetBranch: string;
  status: "OPEN" | "MERGED";
  humanConfirmationRequired: true;
  createdAt: string;
  mergedAt: string | null;
};

export class MergeService {
  constructor(private readonly store: PipelineStore) {}

  createRequest(run: Run, verification: VerificationRun, sourceCommit: string): MergeRequest {
    if (run.status !== "MERGE_READY" || verification.status !== "PASSED") throw new Error("MergeRequest requires a passed verification");
    if (verification.runId !== run.id) throw new Error("Verification evidence must belong to the same run");
    const existing = this.store.findMergeRequestByRun(run.id);
    if (existing) return existing;
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const request: MergeRequest = { id: `merge-${randomUUID().slice(0, 12)}`, runId: run.id, planId: run.planId, sourceCommit, targetBranch: revision?.contract.baseBranch ?? "main", status: "OPEN", humanConfirmationRequired: true, createdAt: new Date().toISOString(), mergedAt: null };
    this.store.saveMergeRequest(request);
    this.store.appendEvent({ type: "merge.request.created", aggregateId: request.id, payload: request });
    return request;
  }

  findByRun(runId: string): MergeRequest | undefined { return this.store.findMergeRequestByRun(runId); }
  get(requestId: string): MergeRequest | undefined { return this.store.getMergeRequest(requestId); }
  list(): MergeRequest[] { return this.store.listMergeRequests(); }

  confirmMerged(requestId: string, targetCommit: string): MergeRequest {
    const request = this.store.getMergeRequest(requestId);
    if (!request) throw new Error(`MergeRequest ${requestId} not found`);
    if (request.status === "MERGED") return request;
    if (targetCommit !== request.sourceCommit) throw new Error("Target commit does not match the reviewed source commit");
    const merged = { ...request, status: "MERGED" as const, mergedAt: new Date().toISOString() };
    this.store.updateMergeRequest(merged);
    const plan = this.store.getPlan(request.planId);
    if (plan) this.store.updatePlan({ ...plan, status: "MERGED", lastEventAt: merged.mergedAt ?? plan.lastEventAt });
    this.store.appendEvent({ type: "merge.confirmed", aggregateId: requestId, payload: { targetCommit, planId: request.planId } });
    return merged;
  }
}

export type ToolCallLedgerStatus = "PENDING" | "COMPLETED" | "DENIED" | "UNCERTAIN" | "NEEDS_RECONCILIATION";
export type ToolCallLedgerEntry = { callId: string; tool: ToolName; status: ToolCallLedgerStatus; result: ToolCallResult; replay: boolean };

export class ToolCallLedger {
  private readonly entries = new Map<string, ToolCallLedgerEntry>();

  record(call: ToolCall, result: ToolCallResult, status: ToolCallLedgerStatus): ToolCallLedgerEntry {
    const entry: ToolCallLedgerEntry = { callId: call.callId, tool: call.tool, status, result, replay: false };
    this.entries.set(call.callId, entry);
    return entry;
  }

  recover(): Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> {
    const recovered: Array<{ callId: string; status: "NEEDS_RECONCILIATION"; replay: false }> = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "UNCERTAIN") {
        entry.status = "NEEDS_RECONCILIATION";
        entry.replay = false;
        recovered.push({ callId: entry.callId, status: "NEEDS_RECONCILIATION", replay: false });
      }
    }
    return recovered;
  }

  list(): ToolCallLedgerEntry[] { return [...this.entries.values()]; }
}
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";
