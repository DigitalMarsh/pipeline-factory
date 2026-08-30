export type PlanStatus = "DRAFT" | "DISCARDED" | "READY" | "QUEUED" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "MERGED" | "BLOCKED" | "NEEDS_PLAN_CHANGE";

export type ProjectSettings = {
  concurrency: {
    maxParallelRuns: number;
    defaultTimeoutMs: number;
    maxAutoContinuationTurns: number;
    maxRepairAttempts: number;
  };
  commands: Array<{ commandId: string; argv: string[]; environment?: Record<string, string> }>;
  hooks: {
    start?: { commandId: string; enabled?: boolean; timeoutMs?: number };
    cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number };
  };
  models: {
    explorer: { model: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
    executor: { model: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
  };
  toolPolicy: { allowedMcpTools: string[]; allowedPluginTools: string[]; computerUseEnabled: boolean };
};

export type Project = {
  id: string;
  name: string;
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
  tasks?: Array<{ id?: string; title: string; status: string; dependencies: string[] }>;
  verificationCommands?: string[];
  toolPolicy?: string;
  contract?: {
    goal: string;
    acceptanceCriteria: string[];
    include: string[];
    exclude: string[];
    baseBranch: string;
    baseCommit: string;
    tasks: Array<{ id: string; title: string; dependencies: string[]; status: string }>;
    conflictKeys: string[];
    executorModelRole: string;
    toolPolicy: string;
    verificationCommandIds: string[];
    maxRepairAttempts: number;
    mergeStrategy: string;
    requireHumanMerge: boolean;
  };
};

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
  status: "PASSED" | "FAILED" | "BLOCKED";
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: { exitCode: number | null; stdout: string; stderr: string } }>;
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

export type ExecutionThread = {
  id: string;
  runId: string;
  state: string;
  journal: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};

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
