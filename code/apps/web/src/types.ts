/**
 * 模块职责：集中声明 Web 使用的领域响应、事件和交互状态类型。
 *
 * 维护提示：
 *   1) **跨端共享的类型一律从 `@pipeline-factory/contracts` 再导出**，不要在这里重新手抄。
 *      此前每个 DTO 都在 domain 与 web 各写一遍，再靠 `type-parity.test.ts` 锁住——那只能发现
 *      漂移，不能阻止它。现在只有 Web 自己的页面投影类型（Plan、Project 视图等）留在这里。
 *   2) 这里保留的 `export type { … }` 在编译后被擦除，Web 不会因此把 contracts 的运行时代码
 *      （zod schema）打进浏览器；将来如果要在表单里复用 schema，再显式 import。
 *   3) **同一份清单要同时 import 一次**：`export type { X } from` 只把 X 再导出，不会把它带进
 *      本模块的作用域；下面那些 Web 自己的投影类型（Plan、Run 等）还要按名字引用它们。
 */
import type {
  AgentLoopDiagnostics,
  AgentLoopState,
  ExecutionJournalPayload,
  ExecutionTelemetry,
  ExecutionThreadSummary,
  ExplorerThreadContextSummary,
  MergeRequest,
  PlanDispatchState,
  PlanLifecycleEntry,
  PlanStatus,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  VerificationRun,
  WorktreeServices,
} from "@pipeline-factory/contracts";
export type {
  AgentLoopDiagnostics,
  AgentLoopState,
  ExecutionJournalPayload,
  ExecutionTelemetry,
  ExecutionThreadSummary,
  ExplorerActivityItem,
  ExplorerActivityKind,
  ExplorerInputRequest,
  ExplorerThreadContextSummary,
  ExplorerTurn,
  MergeRequest,
  MessageAttachment,
  ModelInputQuestion,
  ModelMessagePhase,
  ModelUsage,
  PlanDispatchState,
  PlanDispatchStatus,
  PlanDispatchWaitReason,
  PlanLifecycleEntry,
  PlanLifecycleStatus,
  PlanStatus,
  ProjectExecutionMessage,
  ProjectExecutionThread,
  ProjectExecutionTurnStatus,
  RunGuidance,
  VerificationRun,
  WorktreeCleanupResult,
  WorktreeInventory,
  WorktreeItem,
  WorktreeLogCommit,
  WorktreeMergePreview,
  WorktreeMergeResult,
  WorktreeServices,
} from "@pipeline-factory/contracts";

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
  commands: Array<{
    commandId: string;
    category?: "verification" | "lifecycle" | "executor-tool" | "unclassified";
    description?: string;
    enabled?: boolean;
    argv: string[];
    environment?: Record<string, string>;
    timeoutMs?: number;
    tags?: string[];
  }>;
  defaultVerificationCommandIds?: string[];
  /** 探索产出 Plan 时默认的产物模式；工厂把它注入探索提示词，模型据此不再逐次询问。缺省 REPOSITORY_FILE。 */
  defaultArtifactMode?: "CONVERSATION" | "REPOSITORY_FILE";
  hooks: {
    /** `blocking: false` = 这条命令失败了也放 Run 往下走（建索引、预热这类锦上添花的初始化）。缺省阻塞。 */
    start?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number; blocking?: boolean };
    cleanup?: { commandId: string; enabled?: boolean; timeoutMs?: number; maxAttempts?: number };
  };
  models: {
    explorer: {
      model: string;
      backend?: string;
      mode?: string;
      loopMode?: string;
      temperature?: number;
      maxOutputTokens?: number;
      reasoningEffort?: string;
      developerInstructions?: string;
    };
    executor: {
      model: string;
      backend?: string;
      mode?: string;
      loopMode?: string;
      temperature?: number;
      maxOutputTokens?: number;
      reasoningEffort?: string;
      developerInstructions?: string;
    };
  };
  toolPolicy: { allowedMcpTools: string[]; allowedPluginTools: string[]; computerUseEnabled: boolean };
  /** Worktree 清单的默认范围（可选：老项目没有这一格，读路径按缺省处理）。 */
  worktree?: {
    filterMode: "all" | "patterns";
    branchPatterns: string[];
    ignoredBranches: string[];
    includeDetachedWorktrees: boolean;
  };
  /** 项目级兜底服务配置（worktree 内没有 services.json 时使用）。 */
  worktreeServices?: ProjectWorktreeService[];
  /** 需要从主仓库软链到每个 worktree 的依赖目录（相对路径）。 */
  linkedFolders?: string[];
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

export type ProjectCatalogSummary = Omit<ProjectSummary, "project" | "currentExplorerThread"> & {
  currentExplorerThread: string | null;
  currentExplorerTitle: string | null;
};
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
  /**
   * 这条**探索线程**实际用的 agent。`model` 来自最近一次探索回合的 loop 记录（事实），
   * `backend` 取项目当前的探索配置；都没有就是 null——界面留空，不回填一个猜的值。
   */
  agent?: { model: string | null; backend: string | null } | null;
  contextSummary?: ExplorerThreadContextSummary | null;
  exploration: {
    status: "INCOMPLETE" | "READY";
    missing: string[];
    completed: string[];
    diagnostics: Array<{
      path: string;
      code: "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE";
      area: string;
      message: string;
    }>;
    candidatePlanId: string | null;
    lastAssessedTurnId: string | null;
  };
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
    diagnostics: Array<{
      path: string;
      code: "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE";
      area: string;
      message: string;
    }>;
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
/**
 * 与领域侧 `ExplorerActivityKind` 同集合；两边的名字也是执行线程那套词表（见 utils/conversationTypes.ts）。
 *
 * 顺序按**五类**排，与领域侧逐字一致（见 `docs/Provider消息格式与消息大类调研.md`）：
 * ① 你说的 → ② 模型说的 → ③ 模型做的 → ④ Provider 说的 → ⑤ Factory 说的。
 * ④ 那一组不进会话正文，归宿是头部状态卡的「Provider 运行事实」。
 */
/**
 * 用户随消息上传的附件（本轮只有图片）。
 * `url` 是相对 API 根的路径，浏览器可直接当 `<img src>` 用，无需再拼 query。
 */
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
  /** 这个后端能不能原生接收图片；false 时输入框隐藏附图入口。 */
  supportsImages?: boolean;
  endpoint: string | null;
  endpointSource: "config" | "provider-settings";
};

export type ModelBackendsResponse = {
  backends: ModelBackendDescriptor[];
  roles: { explorer: string; executor: string };
  defaultBackend: string;
};

/** 结构化提问的安全投影；答案正文不从 API 响应回填，避免泄露敏感值。 */
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

/** Plan Center（共享抽屉）使用的候选/执行计划投影。 */
export type PlanTaskChange = { path: string; action: "create" | "modify" | "delete"; detail: string };

export type PlanTask = {
  id?: string;
  title: string;
  /**
   * `status` 在**结构化 Plan** 里已经不作数（模型侧没有这个字段了，冻结契约里那个是 Factory 填的
   * 常量）——每一步真正的进度来自 Run 的 journal，投影成 `ExecutionTask.status`（见 `executionTasks.ts`）。
   * 之所以留成可选：`ExecutionTask` 由它派生，那一边的 `status` 是有意义的实时状态。
   */
  status?: string;
  dependencies: string[];
  changes?: PlanTaskChange[];
  /** 认领的验收标准序号（从 1 开始，见 domain 的 `PlanTaskShape.acceptanceRefs`）。 */
  acceptanceRefs?: number[];
};

export type GeneratedPlanSpec = {
  schemaVersion: 2;
  title: string;
  artifact: { mode: "CONVERSATION" | "REPOSITORY_FILE"; path?: string };
  objective: { goal: string; context?: string[]; audience: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
  design: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[]; risks?: string[] };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: Array<{ id: string; title: string; dependencies: string[]; changes?: PlanTaskChange[]; acceptanceRefs?: number[] }>;
  dependencies: string[];
  conflicts: string[];
  /** 只含 Factory 允许模型决定的项；执行角色与工具策略由 Factory 固定（见 domain 的 plan-spec.ts）。 */
  execution: { maxRepairAttempts?: number };
  /** `suites` 是模型请求的验证 tag 词表（可选）；Factory 解析成 resolvedContract 里的 commandIds。 */
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; suites?: string[] };
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

export type PlanDetail = {
  plan: Plan;
  revision: { artifactHash: string; resolvedContract?: ResolvedPlanContract } | null;
  projectSnapshot: { repoRoot: string; configVersion: number; configHash: string } | null;
  dispatch: PlanDispatchState | null;
  mergeRequest: MergeRequest | null;
};
export type PlanRevisionDraft = {
  draftId: string;
  planId: string;
  projectId: string;
  basedOnRevision: number;
  targetRevision: number;
  status: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED";
  title: string;
  resolvedContract?: ResolvedPlanContract;
  sourceExplorerThreadId: string;
  sourceTurnId: string | null;
  explorerPlanId?: string | undefined;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  baseBranch: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
};
export type ResolvedPlanContract = {
  schemaVersion: 2;
  artifact?: { mode: "CONVERSATION" | "REPOSITORY_FILE"; path?: string };
  objective: { goal: string; context?: string[]; audience?: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
  design?: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[]; risks?: string[] };
  conflicts?: string[];
  repository: {
    projectId: string;
    name: string;
    repoRoot: string;
    baseBranch: string;
    baseCommit: string;
    configVersion: number;
    configHash: string;
  };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: PlanTask[];
  dependencies: string[];
  dependsOnPlanIds: string[];
  execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number };
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] };
  /**
   * 合并策略与"必须人工确认"是 **Factory 填的常量**（模型侧已无此字段）。这里 `strategy` 收成宽松的
   * `string` 是因为页面读的是库里存下来的历史契约——2026-10 之前冻结的那些可能带着模型当年写的值。
   * 界面只**展示**它，不按它做判断。
   */
  merge: { strategy: string; requireHumanMerge: true };
};

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

/** Run 的可审计 journal 容器，也是执行对话的事实来源。 */
/**
 * 一条补充要求及其投递状态。
 * `mode` 是投递方式：`STEER` 在正在跑的那一轮的下一个步骤边界生效，`QUEUE` 等它结束后起新的一轮。
 * **`status === "PENDING"` 时必须显示成「待处理」**——它还没到模型手里，显示成已生效就是在骗人。
 */
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

// ─────────────────────── 项目视角的 Worktree 管理（与 domain 的 worktree/types.ts 逐字对齐） ───────────────────────
// 这一组 DTO 由 `type-parity.test.ts` 锁住：改这里就必须同步改 domain 的权威类型。
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
  runStatus:
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
  verificationStatus: VerificationRun["status"] | null;
  mergeRequestStatus: "OPEN" | "MERGED" | "SUPERSEDED" | null;
};

export type WorktreeInProgressOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export type WorktreeMergeInProgress = {
  kind: WorktreeInProgressOperation;
  mergeHead: string | null;
  currentBranch: string | null;
  conflictFiles: string[];
};

/** 项目级兜底服务配置的一条（与 domain 的 ProjectWorktreeService 逐字对齐）。 */
export type ProjectWorktreeService = {
  serviceId: string;
  name: string;
  role: string;
  workdir: string;
  argv: string[] | null;
  shellCommand: string | null;
  healthUrl: string | null;
  enabled: boolean;
};

export type ProjectWorktreeFilter = {
  filterMode: "all" | "patterns";
  branchPatterns: string[];
  ignoredBranches: string[];
  includeDetachedWorktrees: boolean;
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

export type WorktreeFactorySync = {
  mergeRequest: "confirmed" | "not_found" | "failed";
  runId: string | null;
  workspace: { released: boolean; worktreeRemoved: boolean } | null;
  message: string | null;
};

// ─────────────── Worktree 内的服务启停（进程管理在 API 侧，这里是契约） ───────────────
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

// ─────────────────────── 执行目录（合并前验证） ───────────────────────
export type WorktreeRuntimeInfo = {
  path: string;
  exists: boolean;
  link: { path: string; target: string | null; isSymlink: boolean; exists: boolean } | null;
  current: { itemId: string; branch: string | null; displayName: string; worktreePath: string } | null;
  servicesConfigPath: string | null;
};

/** 路由层的组装形状：执行目录现状 + 从 runtime 配置链解析出的服务清单。 */
export type WorktreeRuntimeResponse = {
  runtime: WorktreeRuntimeInfo;
  services: WorktreeServices | null;
};

export type RuntimeSwitchResponse = {
  runtime: WorktreeRuntimeInfo;
  previousTarget: string | null;
  stoppedServices: number;
  services: WorktreeServices | null;
};

export type RuntimeClearResponse = { cleared: boolean; previousTarget: string | null; stoppedServices: number };

/** 补齐依赖软链的结果。 */
export type WorktreeDependencyLinkResult = {
  worktreePath: string;
  folders: string[];
  linked: string[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
};
