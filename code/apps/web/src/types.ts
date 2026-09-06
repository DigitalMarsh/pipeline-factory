/**
 * 模块职责：集中声明 Web 使用的领域响应、事件和交互状态类型。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type PlanStatus = "DRAFT" | "DISCARDED" | "READY" | "ENQUEUED" | "DISPATCHED" | "QUEUED" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "MERGED" | "BLOCKED" | "NEEDS_PLAN_CHANGE";
export type PlanDispatchStatus = "QUEUED" | "WAITING" | "DISPATCHING" | "RUNNING" | "VERIFYING" | "NEEDS_REVIEW" | "BLOCKED" | "COMPLETED";
export type PlanDispatchWaitReason = "WAITING_DEPENDENCY" | "WAITING_CONFLICT" | "WAITING_PROJECT_CAPACITY" | "WAITING_GLOBAL_CAPACITY" | "NEEDS_CONFIGURATION";
export type PlanDispatchState = {
  planId: string;
  projectId: string;
  status: PlanDispatchStatus;
  waitReason: PlanDispatchWaitReason | null;
  queuedAt: string;
  runId: string | null;
  attempt: number;
  updatedAt: string;
  lastError: string | null;
};

export type AgentLoopDiagnostics = {
  providerActivityCount: number;
  lastGate: { action: string; reason: string } | null;
  terminal: { code: string; message: string } | null;
};

export type ProjectSettings = {
  concurrency: {
    maxParallelRuns: number;
    defaultTimeoutMs: number;
    executionTimeoutMs: number;
    /** @deprecated Legacy persisted setting; the UI no longer edits or submits it. */
    maxAutoContinuationTurns: number;
    maxRepairAttempts: number;
  };
  commands: Array<{ commandId: string; category?: "verification" | "lifecycle" | "executor-tool" | "unclassified"; description?: string; enabled?: boolean; argv: string[]; environment?: Record<string, string>; timeoutMs?: number }>;
  defaultVerificationCommandIds?: string[];
  hooks: {
    start?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number };
    cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number };
  };
  models: {
    explorer: { model: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
    executor: { model: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
  };
  toolPolicy: { allowedMcpTools: string[]; allowedPluginTools: string[]; computerUseEnabled: boolean };
};

/** Project Catalog 和设置页使用的后端 Project 投影。 */
export type Project = {
  id: string;
  name: string;
  shortName: string;
  repoRoot: string;
  defaultBranch: string;
  worktreeRoot: string;
  status: "ACTIVE" | "ARCHIVED";
  currentExplorerThreadId: string | null;
  configVersion: number;
  configHash: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ProjectSummary = {
  project: Project;
  currentExplorerThread: string | null;
  threadCount: number;
  planCount: number;
  runCount: number;
  activeRunCount: number;
  needsAttentionCount: number;
  lastActivityAt: string | null;
};

export type ProjectCatalogSummary = Omit<ProjectSummary, "project" | "currentExplorerThread"> & { currentExplorerThread: string | null; currentExplorerTitle: string | null };
export type ProjectCatalogItem = Project & { summary: ProjectCatalogSummary };

/** Explorer 工作区的前端投影；providerThreadId 仅用于诊断，不作为本地主键。 */
export type ExplorerThread = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  titleSource: "AUTO" | "MANUAL";
  titleStatus: "PLACEHOLDER" | "GENERATING" | "GENERATED" | "FAILED";
  contextMode: "FRESH" | "EXPLICIT_CONTINUATION" | "LEGACY";
  originThreadId: string | null;
  parentThreadId: string | null;
  state: "ACTIVE" | "WAITING_FOR_INPUT" | "COMPRESSED" | "ARCHIVED";
  messageCount: number;
  summaryRef: string | null;
  lastActivityAt: string;
  activeRevisionDraftId?: string | null;
  exploration: {
    status: "INCOMPLETE" | "READY";
    missing: string[];
    completed: string[];
    candidatePlanId: string | null;
    lastAssessedTurnId: string | null;
  };
};

export type CodexRateLimitValue = {
  remainingPercent: number;
  resetAt: string;
};

export type CodexRateLimitsStatus = {
  available: boolean;
  fiveHour: CodexRateLimitValue | null;
  sevenDay: CodexRateLimitValue | null;
  reason: string | null;
};

export type ExplorerActivityKind = "USER_MESSAGE" | "ASSISTANT_MESSAGE" | "REASONING_SUMMARY" | "INPUT_REQUIRED" | "INPUT_RESOLVED" | "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_DENIED" | "MCP_ACTIVITY" | "CONTEXT_COMPACTED" | "GATE_CHECKED" | "TURN_STATUS";

export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING";
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
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

export type ModelInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

/** 结构化提问的安全投影；答案正文不从 API 响应回填，避免泄露敏感值。 */
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
  status: "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "AUTO_RESOLVED" | "RECOVERY_REQUIRED";
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
};

export type ExplorerRealtimeEvent = {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
};

export type AgentLoopState = "CREATED" | "RUNNING" | "WAITING_FOR_INPUT" | "PAUSED" | "RECOVERING" | "BLOCKED" | "COMPLETED" | "FAILED" | "CANCELLED" | "NEEDS_RECONCILIATION";

export type AgentLoop = {
  id: string;
  ownerType: "explorer-turn" | "run";
  ownerId: string;
  role: "explorer" | "executor";
  mode: "provider-controlled" | "factory-controlled";
  state: AgentLoopState;
  stepCount: number;
  maxSteps: number;
  startedAt: string | null;
  completedAt: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  checkpointJson: string | null;
  diagnostics?: AgentLoopDiagnostics;
};

export type AgentLoopStep = {
  loopId: string;
  sequence: number;
  stepType: string;
  status: string;
  callId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
};

/** Plan Center 和 PlanDetailDrawer 使用的候选/执行计划投影。 */
export type PlanTask = {
  id?: string;
  title: string;
  status: string;
  dependencies: string[];
};

export type Plan = {
  planId?: string;
  id?: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  sourceTurnId?: string | null;
  providerThreadId?: string | null;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  createdAt?: string;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  projectConfigVersion?: number | null;
  projectConfigHash?: string | null;
  projectConfigStatus?: "CURRENT" | "CHANGED" | "LEGACY";
  goal?: string;
  acceptanceCriteria?: string[];
  include?: string[];
  exclude?: string[];
  tasks?: PlanTask[];
  verificationCommands?: string[];
  toolPolicy?: string;
  contract?: {
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
    mergeStrategy: string;
    requireHumanMerge: boolean;
    dependsOnPlanIds?: string[];
  };
  resolvedContract?: ResolvedPlanContract;
  dispatch?: PlanDispatchState | null;
};

export type PlanDetail = { plan: Plan; revision: { artifactHash: string; resolvedContract?: ResolvedPlanContract } | null; projectSnapshot: { repoRoot: string; configVersion: number; configHash: string } | null; dispatch: PlanDispatchState | null };
export type PlanRevisionDraft = { draftId: string; planId: string; projectId: string; basedOnRevision: number; targetRevision: number; status: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED"; title: string; contract: Plan["contract"]; resolvedContract?: ResolvedPlanContract; sourceExplorerThreadId: string; sourceTurnId: string | null; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null; baseBranch: string; baseCommit: string; createdAt: string; updatedAt: string; confirmedAt: string | null };
export type ResolvedPlanContract = { schemaVersion: 2; objective: { goal: string; acceptanceCriteria: string[]; outOfScope: string[] }; repository: { projectId: string; name: string; repoRoot: string; baseBranch: string; baseCommit: string; configVersion: number; configHash: string }; scope: { includePaths: string[]; excludePaths: string[] }; tasks: PlanTask[]; dependencies: string[]; execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number }; verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] }; merge: { strategy: string; requireHumanMerge: true } };

/** Execution Run 的页面投影，关联冻结 Revision、Worktree 和 Executor Loop。 */
export type Run = {
  id: string;
  projectId: string;
  planId: string;
  planRevision: number;
  status: string;
  branch: string;
  workspacePath: string | null;
  baseCommit: string;
  executionThreadId: string;
  createdAt: string;
  startedAt: string | null;
  agentLoops?: AgentLoop[];
};

export type VerificationRun = {
  id: string;
  runId: string;
  status: "PASSED" | "SKIPPED" | "FAILED" | "BLOCKED";
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: { exitCode: number | null; stdout: string; stderr: string } }>;
  reason?: "NO_PROJECT_VERIFICATION_COMMANDS";
  completedAt: string;
};

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

/** Run 的可审计 journal 容器，也是执行对话的事实来源。 */
export type ExecutionThread = {
  id: string;
  runId: string;
  state: string;
  journal: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};

/** Run SSE 单条事件；sequence 用于去重和 Last-Event-ID 回放。 */
export type RunJournalEvent = {
  runId: string;
  runStatus: string | null;
  threadState: string | null;
  sequence: number;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type ToolCall = {
  callId: string;
  loopId: string;
  role: "explorer" | "executor";
  tool: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "NEEDS_RECONCILIATION";
  result: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
};

export type WorkbenchEvent = {
  id: string;
  sequence: number;
  type: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type WorkbenchPlan = Plan & {
  planId: string;
  createdAt: string;
  queuedAt: string | null;
  contract: NonNullable<Plan["contract"]>;
};

export type WorkbenchRun = Run & {
  planTitle: string;
  dispatch: PlanDispatchState | null;
};

export type WorkbenchSnapshot = {
  activeProjectId: string | null;
  projects: ProjectCatalogItem[];
  plans: WorkbenchPlan[];
  runs: WorkbenchRun[];
  dispatchStates: PlanDispatchState[];
  events: WorkbenchEvent[];
  cursor: number;
};
