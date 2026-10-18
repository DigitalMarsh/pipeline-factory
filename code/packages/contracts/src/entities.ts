/**
 * 模块职责：跨端共享的**业务实体与状态类型** —— 这里是权威定义，`packages/core` 反过来 import。
 *
 * 为什么在 contracts 而不是 core：Web 与 API 都要读这些形状；如果定义在 core，contracts 只能
 *   再导出（依赖方向是反的），而 Web 的类型完整性就只能靠 parity 测试事后发现漂移。
 *   现在 contracts 是最底层：core → contracts、api → contracts、web → contracts。
 *
 * 维护提示：
 *   1) **本文件只用 TS 类型，不含运行时值**。默认值（如 DEFAULT_WORKTREE_FILTER）、校验函数
 *      与状态机仍留在 core；把它们搬进来会让 Web 构建带上服务端逻辑。
 *   2) 新增跨端字段时先改这里；core 的模块会按需 `import type` + `export type` 转发，
 *      旧调用点从 `@pipeline-factory/core` 导入仍然有效。
 *   3) 不要把 Provider 的私有形状（Codex/Claude 原始消息）搬进来：它们不属于 HTTP 契约。
 */

// ───────────────────────────── Plan / 派发 ─────────────────────────────

export type PlanStatus =
  "DRAFT" | "DISCARDED" | "READY" | "ENQUEUED" | "DISPATCHED" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "MERGED" | "BLOCKED";

export type PlanLifecycleStatus = PlanStatus | "NEEDS_CONFIGURATION";

/** 当前 Plan Revision 的统一生命周期时间线投影。时间未知时保持 null，不用 lastEventAt 猜测。 */
export type PlanLifecycleEntry = {
  status: PlanLifecycleStatus;
  occurredAt: string | null;
  revision: number;
  current: boolean;
  reason?: string | null;
  runId?: string | null;
  executionThreadId?: string | null;
};

export type PlanDispatchStatus = "QUEUED" | "WAITING" | "DISPATCHING" | "RUNNING" | "VERIFYING" | "NEEDS_REVIEW" | "BLOCKED" | "COMPLETED";

export type PlanDispatchWaitReason =
  "WAITING_DEPENDENCY" | "WAITING_CONFLICT" | "WAITING_PROJECT_CAPACITY" | "WAITING_GLOBAL_CAPACITY" | "NEEDS_CONFIGURATION";

/** 自动派发的中间阶段；持久化后用于进程重启恢复。 */
export type PlanDispatchPhase =
  | "VALIDATING"
  | "VALIDATION_FAILED"
  | "FROZEN"
  | "ENQUEUING"
  | "ENQUEUE_FAILED"
  | "ENQUEUED"
  | "DISPATCHING"
  | "DISPATCH_FAILED"
  | "DISPATCHED"
  | "STARTING_RUN"
  | "RUN_STARTED"
  | "WAITING"
  | "RUN_START_FAILED"
  | "NEEDS_REVIEW"
  | "ATTENTION"
  | "COMPLETED";

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
  /** 持久化的自动确认/派发阶段；旧的人工入队记录可能没有此字段。 */
  phase?: PlanDispatchPhase;
  automatic?: boolean;
  confirmedBy?: string | null;
}>;

// ───────────────────────────── Run / 执行 ─────────────────────────────

/** Run 的执行、验证、合并和恢复状态；BLOCKED 需要人工关注。 */
export type RunStatus =
  | "QUEUED"
  | "STARTING"
  | "IN_PROGRESS"
  | "READY_FOR_VERIFY"
  | "VERIFYING"
  | "MERGE_READY"
  | "BLOCKED"
  | "STALE"
  | "RECOVERING"
  | "CANCELLED";

export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";

export type JournalEntryType =
  | "RUN_CREATED"
  | "HOOK_COMPLETED"
  | "HOOK_FAILED"
  | "HOOK_SKIPPED"
  | "MODEL_OUTPUT"
  | "PROVIDER_ACTIVITY"
  | "TOOL_CALL"
  | "TASK_PROGRESS"
  | "USER_GUIDANCE"
  | "VERIFICATION"
  | "RECOVERY";

/** 跨模型轮次、Plan 任务和 Provider 调用的稳定关联字段。 */
export type ExecutionJournalCorrelation = {
  taskId?: string;
  modelStep?: number;
  loopId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  callId?: string;
};
export type ExecutionJournalPayload = Record<string, unknown> & ExecutionJournalCorrelation;

export type ExecutionJournalEntry = {
  sequence: number;
  type: JournalEntryType;
  occurredAt: string;
  payload: ExecutionJournalPayload;
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};
export type ModelUsageScope = "turn" | "total";

export type ExecutionTelemetry = {
  model: string | null;
  reasoningEffort: string | null;
  backend?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage | null;
  usageSource: "provider" | "not-recorded";
  usageScope: ModelUsageScope | null;
};

export type ExecutionThreadSummary = {
  id: string;
  runId: string;
  state: string;
  model?: string | null;
  backend?: string | null;
} | null;

export type VerificationStatus = "PASSED" | "SKIPPED" | "FAILED" | "BLOCKED";

/** 命令执行的原始结果；验证、Hook 与工具共用。 */
export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type VerificationRun = {
  id: string;
  runId: string;
  status: VerificationStatus;
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: CommandResult }>;
  reason?: "NO_PROJECT_VERIFICATION_COMMANDS";
  completedAt: string;
};

export type MergeRequest = {
  id: string;
  runId: string;
  planId: string;
  sourceCommit: string;
  targetBranch: string;
  status: "OPEN" | "MERGED" | "SUPERSEDED";
  humanConfirmationRequired: true;
  createdAt: string;
  mergedAt: string | null;
  detectedTargetCommit?: string | null;
};

export type RunGuidanceMode = "STEER" | "QUEUE";
export type RunGuidanceStatus = "PENDING" | "CONSUMED" | "CANCELLED";

export type RunGuidance = {
  id: string;
  runId: string;
  content: string;
  mode: RunGuidanceMode;
  status: RunGuidanceStatus;
  authorId: string;
  createdAt: string;
  consumedAt: string | null;
  attachments?: MessageAttachmentView[];
};

// ───────────────────────────── Agent Loop ─────────────────────────────

export type AgentLoopState =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "PAUSED"
  | "RECOVERING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NEEDS_RECONCILIATION";

export type AgentLoopDiagnostics = {
  providerActivityCount: number;
  lastGate: { action: string; reason: string } | null;
  terminal: { code: string; message: string } | null;
};

// ───────────────────────────── Explorer ─────────────────────────────

export type ModelMessagePhase = "commentary" | "final_answer";

export type PlanExplorationStatus = "INCOMPLETE" | "READY";

export type ExplorerThreadContextSummary = {
  version: 1;
  updatedAt: string;
  completedPlans: Array<{
    explorerPlanId: string;
    title: string;
    status: PlanExplorationStatus;
    goal: string | null;
    keyConstraints: string[];
    latestUserMessageSummary: string | null;
  }>;
  openPlanIds: string[];
};

/** 用户随消息上传的图片视图；`url` 相对 API 根。 */
export type MessageAttachmentView = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  url: string;
  createdAt: string;
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
  explorerPlanId?: string;
  attachments?: MessageAttachmentView[];
};

export type ModelInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type ExplorerInputRequestStatus = "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "RECOVERY_REQUIRED";

export type ExplorerInputRequest = {
  id: string;
  threadId: string;
  explorerPlanId?: string;
  localTurnId: string;
  providerRequestId: string | number;
  providerThreadId: string;
  providerTurnId: string;
  itemId: string;
  questions: ModelInputQuestion[];
  isBlocking: boolean;
  status: ExplorerInputRequestStatus;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
};

export type ExplorerActivityKind =
  | "USER_MESSAGE"
  | "ASSISTANT_MESSAGE"
  | "REASONING"
  | "COMMAND"
  | "FILE_CHANGE"
  | "TOOL_CALL"
  | "MCP_CALL"
  | "SUBAGENT"
  | "WEB_SEARCH"
  | "IMAGE_GENERATION"
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
  | "CONTEXT"
  | "GATE"
  | "TURN_STATUS";

export type ExplorerActivityItem = {
  id: string;
  explorerId: string;
  explorerPlanId?: string;
  turnId: string;
  sequence: number;
  kind: ExplorerActivityKind;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "WAITING" | "UNKNOWN";
  title: string;
  summary: string;
  details: Record<string, unknown> | null;
  occurredAt: string;
};

// ───────────────────────────── 项目执行线程 ─────────────────────────────

export type ProjectExecutionThread = {
  id: string;
  projectId: string;
  providerThreadId: string | null;
  modelOverride: string | null;
  reasoningEffortOverride: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectExecutionTurnStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED";

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
  attachments?: MessageAttachmentView[];
};

// ───────────────────────────── Worktree 管理 ─────────────────────────────

export type ProjectWorktreeFilter = {
  filterMode: "all" | "patterns";
  branchPatterns: string[];
  ignoredBranches: string[];
  includeDetachedWorktrees: boolean;
};

export type WorktreeGitDirtyState = "clean" | "dirty" | "conflict";
export type WorktreeItemKind = "base_branch" | "local_branch" | "branch_worktree" | "detached_worktree";

export type WorktreeItemStatus =
  | "no_updates"
  | "dirty_uncommitted"
  | "dirty_with_commits"
  | "committed_unmerged"
  | "merge_conflict"
  | "merged_dirty"
  | "merged_clean"
  | "detached_unmerged"
  | "detached_dirty_with_commits"
  | "detached_dirty"
  | "detached_clean";

export type WorktreeMergeRelation = "current_merged" | "current_unmerged" | "was_merged_before" | "detached";

export type WorktreeFactoryLink = {
  runId: string;
  planId: string;
  planTitle: string | null;
  runStatus: RunStatus;
  verificationStatus: VerificationStatus | null;
  mergeRequestStatus: "OPEN" | "MERGED" | "SUPERSEDED" | null;
};

export type WorktreeItem = {
  itemId: string;
  kind: WorktreeItemKind;
  branch: string | null;
  displayName: string;
  isBaseBranch: boolean;
  hasWorktree: boolean;
  isDetached: boolean;
  worktreePath: string | null;
  effectivePath: string;
  missing: boolean;
  status: WorktreeItemStatus;
  mergeRelation: WorktreeMergeRelation;
  gitDirtyState: WorktreeGitDirtyState;
  conflictFiles: string[];
  aheadCount: number;
  behindCount: number;
  merged: boolean;
  lastCommit: string | null;
  lastCommitAt: number | null;
  mergeable: boolean;
  blockers: string[];
  cleanupable: boolean;
  cleanupBlockers: string[];
  isLiveRunWorkspace: boolean;
  everMerged: boolean;
  isIgnored: boolean;
  matchesScope: boolean;
  containedInBranch: boolean;
  factory: WorktreeFactoryLink | null;
};

export type WorktreeInProgressOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export type WorktreeMergeInProgress = {
  kind: WorktreeInProgressOperation;
  mergeHead: string | null;
  currentBranch: string | null;
  conflictFiles: string[];
};

export type WorktreeInventory = {
  projectId: string;
  repoRoot: string;
  baseBranch: string;
  baseHead: string | null;
  currentBranch: string | null;
  mergeInProgress: WorktreeMergeInProgress | null;
  activeRunIds: string[];
  filter: ProjectWorktreeFilter;
  filteredOutCount: number;
  items: WorktreeItem[];
  truncated: boolean;
  warnings: string[];
};

export type WorktreePreviewCommit = { hash: string; subject: string; author: string; relativeTime: string };

export type WorktreeFileSummary = {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
  typeChanged: number;
  unknown: number;
};

export type WorktreeFileChange = { status: string; path: string; previousPath: string | null };

export type WorktreeConflictPrediction = {
  status: "clean" | "conflicts" | "unavailable";
  hasConflicts: boolean;
  conflictFiles: string[];
  message: string | null;
};

export type WorktreeMergeConclusion = "ready" | "conflict_risk" | "blocked";

export type WorktreeMergePreview = {
  projectId: string;
  repoRoot: string;
  itemId: string;
  branch: string | null;
  baseBranch: string;
  baseHead: string | null;
  taskHead: string | null;
  mergeBase: string | null;
  aheadCount: number;
  behindCount: number;
  dirtyState: WorktreeGitDirtyState;
  merged: boolean;
  conclusion: WorktreeMergeConclusion;
  conclusionLabel: string;
  canConfirm: boolean;
  blockers: string[];
  warnings: string[];
  recentCommits: WorktreePreviewCommit[];
  fileSummary: WorktreeFileSummary;
  fileChanges: WorktreeFileChange[];
  conflictPrediction: WorktreeConflictPrediction;
  commands: string[];
  expectedBranchHead: string | null;
  expectedBaseHead: string | null;
  factory: WorktreeFactoryLink | null;
};

export type WorktreeFactorySync = {
  mergeRequest: "confirmed" | "not_found" | "failed";
  runId: string | null;
  workspace: { released: boolean; worktreeRemoved: boolean } | null;
  message: string | null;
};

export type WorktreeMergeResult = {
  status: "merged" | "merge_conflict" | "aborted" | "error";
  message: string;
  branch: string | null;
  baseBranch: string;
  conflictFiles: string[];
  baseHeadBefore: string | null;
  baseHeadAfter: string | null;
  commands: string[];
  factory: WorktreeFactorySync | null;
};

export type WorktreeCleanupResult = {
  message: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  runWorkspaceCleared: boolean;
  cleanupHookNeedsAttention: boolean;
};

export type WorktreeLogCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  relativeTime: string;
};

export type WorktreeServiceConfig = {
  serviceId: string;
  name: string;
  role: string;
  workdir: string;
  argv: string[] | null;
  shellCommand: string | null;
  healthUrl: string | null;
  enabled: boolean;
  source: "runtime" | "pipeline-factory" | "worktree-manage" | "project-settings";
};

export type WorktreeServiceStatus = "stopped" | "running" | "failed";

export type WorktreeServiceState = {
  serviceId: string;
  status: WorktreeServiceStatus;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
};

export type WorktreeServiceLogEntry = { sequence: number; stream: "stdout" | "stderr"; text: string };

export type WorktreeServices = {
  itemId: string;
  worktreePath: string;
  configSource: "runtime" | "worktree-file" | "project-fallback" | null;
  configPath: string | null;
  configError: string | null;
  services: WorktreeServiceConfig[];
  states: WorktreeServiceState[];
};

export type WorktreeRuntimeInfo = {
  path: string;
  exists: boolean;
  link: { path: string; target: string | null; isSymlink: boolean; exists: boolean } | null;
  current: { itemId: string; branch: string | null; displayName: string; worktreePath: string } | null;
  servicesConfigPath: string | null;
};

export type RuntimeSwitchResult = {
  runtime: WorktreeRuntimeInfo;
  previousTarget: string | null;
};

export type RuntimeClearResult = {
  cleared: boolean;
  previousTarget: string | null;
};

export type WorktreeDependencyLinkResult = {
  worktreePath: string;
  folders: string[];
  linked: string[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
};
