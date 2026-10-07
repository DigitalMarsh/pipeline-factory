/**
 * 模块职责：集中声明 Web 使用的领域响应、事件和交互状态类型。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type PlanStatus = "DRAFT" | "DISCARDED" | "READY" | "ENQUEUED" | "DISPATCHED" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "MERGED" | "BLOCKED" | "NEEDS_PLAN_CHANGE";
export type PlanLifecycleStatus = PlanStatus | "NEEDS_CONFIGURATION";
export type PlanLifecycleEntry = {
  status: PlanLifecycleStatus;
  occurredAt: string | null;
  revision: number;
  current: boolean;
  reason?: string | null;
  runId?: string | null;
  executionThreadId?: string | null;
};
export type ExecutionThreadSummary = { id: string; runId: string; state: string } | null;
export type PlanDispatchStatus = "QUEUED" | "WAITING" | "DISPATCHING" | "RUNNING" | "VERIFYING" | "NEEDS_REVIEW" | "BLOCKED" | "COMPLETED";
export type PlanDispatchWaitReason = "WAITING_DEPENDENCY" | "WAITING_CONFLICT" | "WAITING_PROJECT_CAPACITY" | "WAITING_GLOBAL_CAPACITY" | "NEEDS_CONFIGURATION";
export type PlanDispatchState = Readonly<{
  planId: string;
  revision?: number;
  projectId: string;
  status: PlanDispatchStatus;
  waitReason: PlanDispatchWaitReason | null;
  queuedAt: string;
  runId: string | null;
  attempt: number;
  updatedAt: string;
  lastError: string | null;
  phase?: "VALIDATING" | "VALIDATION_FAILED" | "FROZEN" | "ENQUEUING" | "ENQUEUE_FAILED" | "ENQUEUED" | "DISPATCHING" | "DISPATCH_FAILED" | "DISPATCHED" | "STARTING_RUN" | "RUN_STARTED" | "WAITING" | "RUN_START_FAILED" | "NEEDS_REVIEW" | "ATTENTION" | "COMPLETED";
  automatic?: boolean;
  confirmedBy?: string | null;
}>;

export type AgentLoopDiagnostics = {
  providerActivityCount: number;
  lastGate: { action: string; reason: string } | null;
  terminal: { code: string; message: string } | null;
};

export type ProjectSettings = {
  concurrency: {
    maxParallelRuns: number;
    /** 冲突判定范围：`declared` 只看模型声明的冲突键；`overlap` 另外比较 scope 是否重叠。旧数据没有它。 */
    conflictScope?: "declared" | "overlap";
    defaultTimeoutMs: number;
    executionTimeoutMs: number;
    /** @deprecated Legacy persisted setting; the UI no longer edits or submits it. */
    maxAutoContinuationTurns: number;
    maxRepairAttempts: number;
  };
  /** 命令定义。`tags` 只对 verification 命令有意义：Plan 的 `verification.suites` 用它选验证子集。 */
  commands: Array<{ commandId: string; category?: "verification" | "lifecycle" | "executor-tool" | "unclassified"; description?: string; enabled?: boolean; argv: string[]; environment?: Record<string, string>; timeoutMs?: number; tags?: string[] }>;
  defaultVerificationCommandIds?: string[];
  hooks: {
    /** `blocking: false` = 这条命令失败了也放 Run 往下走（建索引、预热这类锦上添花的初始化）。缺省阻塞。 */
    start?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number; blocking?: boolean };
    cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number };
  };
  models: {
    explorer: { model: string; backend?: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
    executor: { model: string; backend?: string; mode?: string; loopMode?: string; temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; developerInstructions?: string };
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
  activeExplorerPlanId?: string | null;
  contextSummary?: ExplorerThreadContextSummary | null;
  exploration: {
    status: "INCOMPLETE" | "READY";
    missing: string[];
    completed: string[];
    diagnostics: Array<{ path: string; code: "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE"; area: string; message: string }>;
    candidatePlanId: string | null;
    lastAssessedTurnId: string | null;
  };
};

export type ExplorerThreadContextSummary = {
  version: 1;
  updatedAt: string;
  completedPlans: Array<{
    explorerPlanId: string;
    title: string;
    status: "INCOMPLETE" | "READY";
    goal: string | null;
    keyConstraints: string[];
    latestUserMessageSummary: string | null;
  }>;
  openPlanIds: string[];
};

export type ExplorerPlan = {
  id: string;
  explorerThreadId: string;
  projectId: string;
  ordinal: number;
  title: string;
  titleSource: "AUTO" | "MANUAL";
  titleStatus: "PLACEHOLDER" | "GENERATING" | "GENERATED" | "FAILED";
  messageCount: number;
  latestUserMessageSummary: string | null;
  exploration: {
    status: "INCOMPLETE" | "READY";
    missing: string[];
    completed: string[];
    diagnostics: Array<{ path: string; code: "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE"; area: string; message: string }>;
    candidatePlanId: string | null;
    lastAssessedTurnId: string | null;
  };
  candidatePlanId: string | null;
  lastAssessedTurnId: string | null;
  createdAt: string;
  lastActivityAt: string;
  runtimeStatus?: "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
};

/**
 * 与领域侧 `ModelMessagePhase` 同集合：这一段正文是"过程叙述"还是"最终回答"。
 * **只有 Codex 给**（`agentMessage.phase`）；拿不到时按"未知"处理，不猜。
 */
export type ModelMessagePhase = "commentary" | "final_answer";

/**
 * 与领域侧 `ExplorerActivityKind` 同集合；两边的名字也是执行线程那套词表（见 utils/conversationTypes.ts）。
 *
 * 顺序按**五类**排，与领域侧逐字一致（见 `docs/Provider消息格式与消息大类调研.md`）：
 * ① 你说的 → ② 模型说的 → ③ 模型做的 → ④ Provider 说的 → ⑤ Factory 说的。
 * ④ 那一组不进会话正文，归宿是头部状态卡的「Provider 运行事实」。
 */
export type ExplorerActivityKind =
  // ①
  | "USER_MESSAGE"
  // ②
  | "ASSISTANT_MESSAGE"
  | "REASONING"
  // ③
  | "COMMAND"
  | "FILE_CHANGE"
  | "TOOL_CALL"
  | "MCP_CALL"
  | "SUBAGENT"
  | "WEB_SEARCH"
  | "IMAGE_GENERATION"
  // ④
  | "PROVIDER_COMPACTION"
  | "PERMISSION_DENIED"
  | "RATE_LIMIT"
  | "PROVIDER_RETRY"
  | "BACKGROUND_TASK"
  | "HOOK"
  | "PROVIDER_WARNING"
  | "UNCLASSIFIED"
  | "PROVIDER_MESSAGE"
  | "SESSION"
  // ⑤
  | "CONTEXT"
  | "GATE"
  | "TURN_STATUS";

export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING" | "UNKNOWN";
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
  explorerPlanId?: string | undefined;
};

export type ExplorerTurn = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status?: "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
  error?: string;
  createdAt: string;
  sequence: number;
  explorerPlanId?: string | undefined;
};

export type ProjectExecutionTurnStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED";

export type ProjectExecutionThread = {
  id: string;
  projectId: string;
  providerThreadId: string | null;
  modelOverride: string | null;
  reasoningEffortOverride: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectExecutionMessage = {
  id: string;
  threadId: string;
  turnId: string;
  clientTurnId: string | null;
  role: "user" | "assistant";
  content: string;
  status: ProjectExecutionTurnStatus;
  error: string | null;
  createdAt: string;
  sequence: number;
  loopId: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export type ProjectExecutionEvent = {
  id: string;
  sequence: number;
  type: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type ProjectExecutionThreadSnapshot = {
  thread: ProjectExecutionThread;
  messages: ProjectExecutionMessage[];
  events: ProjectExecutionEvent[];
  lastEventSequence: number;
  defaultModel: string;
  defaultReasoningEffort: string | null;
  modelOptions: string[];
  reasoningEffortOptions: Array<{ value: string | null; label: string }>;
  /** 这个会话由哪个 agent（后端 id）驱动；Project 级决定，会话面板只展示不可改。 */
  backend: string;
};

/** 一个可用后端：控制台的"选 agent / 选模型 / 选推理强度"三件事都读它。 */
export type ModelBackendDescriptor = {
  id: string;
  kind: "codex-app-server" | "claude-agent-sdk" | "openai-responses" | "stub";
  source: "registry" | "implicit";
  models: string[];
  reasoningEfforts: string[];
  endpoint: string | null;
  endpointSource: "config" | "provider-settings";
};

export type ModelBackendsResponse = {
  backends: ModelBackendDescriptor[];
  roles: { explorer: string; executor: string };
  defaultBackend: string;
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
  status: "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "RECOVERY_REQUIRED";
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
  explorerPlanId?: string | undefined;
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
export type PlanTaskChange = { path: string; action: "create" | "modify" | "delete"; detail: string };

export type PlanTask = {
  id?: string;
  title: string;
  status: string;
  dependencies: string[];
  changes?: PlanTaskChange[];
};

export type GeneratedPlanSpec = {
  schemaVersion: 2;
  title: string;
  artifact: { mode: "CONVERSATION" | "REPOSITORY_FILE"; path?: string };
  objective: { goal: string; context?: string[]; audience: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
  design: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[]; risks?: string[] };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: Array<{ id: string; title: string; dependencies: string[]; status?: "PENDING" | "READY" | "DONE"; changes?: PlanTaskChange[] }>;
  dependencies: string[];
  conflicts: string[];
  /** 只含 Factory 允许模型决定的项；执行角色与工具策略由 Factory 固定（见 domain 的 plan-spec.ts）。 */
  execution: { maxRepairAttempts?: number };
  /** `suites` 是模型请求的验证 tag 词表（可选）；Factory 解析成 resolvedContract 里的 commandIds。 */
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; suites?: string[] };
  merge: { strategy: "manual" | "fast-forward" | "squash"; requireHumanMerge: true };
};

export type ExecutionTaskStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "UNKNOWN";
export type ExecutionTask = PlanTask & {
  id: string;
  status: ExecutionTaskStatus;
  evidenceSequence: number | null;
  blockedReason: string | null;
  /**
   * 这一步**自己报的**开始与完成时刻（`task-lifecycle` 的 `IN_PROGRESS` 与 `DONE` 两条）。
   *
   * 为什么不用消息时间戳推：OpenClaw 在这一点上是明确的——拿不到时长就写 `Worked` 而不是
   * 从消息时间戳估一个数。我们的消息时间戳包含模型思考、排队、以及属于别步的时间，
   * 用它算出来的"用时"是编的；而任务自己的生命周期事实是**它说的**。
   */
  startedAt: string | null;
  completedAt: string | null;
};

export type Plan = {
  planId?: string;
  id?: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string | undefined;
  sourceTurnId?: string | null;
  providerThreadId?: string | null;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  createdAt?: string;
  confirmedAt?: string | null;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  lifecycle?: PlanLifecycleEntry[];
  executionThread?: ExecutionThreadSummary;
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
  resolvedContract?: ResolvedPlanContract;
  generatedSpec?: GeneratedPlanSpec;
  dispatch?: PlanDispatchState | null;
  mergeRequest?: MergeRequest | null;
};

export type PlanDetail = { plan: Plan; revision: { artifactHash: string; resolvedContract?: ResolvedPlanContract } | null; projectSnapshot: { repoRoot: string; configVersion: number; configHash: string } | null; dispatch: PlanDispatchState | null; mergeRequest: MergeRequest | null };
export type PlanRevisionDraft = { draftId: string; planId: string; projectId: string; basedOnRevision: number; targetRevision: number; status: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED"; title: string; resolvedContract?: ResolvedPlanContract; sourceExplorerThreadId: string; sourceTurnId: string | null; explorerPlanId?: string | undefined; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null; baseBranch: string; baseCommit: string; createdAt: string; updatedAt: string; confirmedAt: string | null };
export type ResolvedPlanContract = { schemaVersion: 2; artifact?: { mode: "CONVERSATION" | "REPOSITORY_FILE"; path?: string }; objective: { goal: string; context?: string[]; audience?: string[]; acceptanceCriteria: string[]; outOfScope: string[] }; design?: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[]; risks?: string[] }; conflicts?: string[]; repository: { projectId: string; name: string; repoRoot: string; baseBranch: string; baseCommit: string; configVersion: number; configHash: string }; scope: { includePaths: string[]; excludePaths: string[] }; tasks: PlanTask[]; dependencies: string[]; dependsOnPlanIds: string[]; execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number }; verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] }; merge: { strategy: string; requireHumanMerge: true } };

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
  detectedTargetCommit?: string | null;
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type ExecutionTelemetry = {
  model: string | null;
  reasoningEffort: string | null;
  /** 执行这次 Run 的 agent（后端 id）；旧数据没有这个字段，读路径要容忍 undefined。 */
  backend?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage | null;
  usageSource: "provider" | "not-recorded";
  usageScope: "turn" | "total" | null;
};

/** Run 的可审计 journal 容器，也是执行对话的事实来源。 */
export type ExecutionJournalPayload = Record<string, unknown> & {
  taskId?: string;
  modelStep?: number;
  loopId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  callId?: string;
};

export type ExecutionThread = {
  id: string;
  runId: string;
  state: string;
  journal: Array<{ sequence: number; type: string; occurredAt: string; payload: ExecutionJournalPayload }>;
  telemetry?: ExecutionTelemetry | null;
};

/** Run SSE 单条事件；sequence 用于去重和 Last-Event-ID 回放。 */
export type RunJournalEvent = {
  runId: string;
  runStatus: string | null;
  threadState: string | null;
  threadTelemetry?: ExecutionTelemetry | null;
  sequence: number;
  type: string;
  occurredAt: string;
  payload: ExecutionJournalPayload;
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
  resolvedContract: ResolvedPlanContract;
};

/** 项目「今日活动」一条事实；`reason` 只在失败/阻塞那组出现。 */
export type DailyActivityEntry = {
  planId: string;
  planTitle: string;
  runId: string | null;
  at: string;
  reason?: string | null;
};

/** 执行完成与人工合并是两个时点，界面必须分开显示，不能只说"今日已合并"。 */
export type DailyActivity = {
  projectId: string;
  date: string;
  timeZone: string;
  /** 事件保留窗口；日报受它限制，界面据此说明"更早的记录已被回收"。 */
  retentionDays: number;
  executedToday: DailyActivityEntry[];
  mergedToday: DailyActivityEntry[];
  failedToday: DailyActivityEntry[];
  runningAcrossDays: DailyActivityEntry[];
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
