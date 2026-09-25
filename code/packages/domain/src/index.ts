/**
 * 模块职责：聚合 Pipeline Factory 的核心领域模型、存储、Plan、Run、Scheduler 和验证服务。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { projectAgentLoopDiagnostics } from "./agent-loop.js";
import type { AgentLoop, AgentLoopDiagnostics, AgentLoopEvent, AgentLoopRunner, AgentLoopStep, AgentLoopStepInput } from "./agent-loop.js";
import type { MappedCodexRateLimits } from "./codex-rate-limits.js";
import { BuiltinToolExecutor, type BuiltinToolContext, type BuiltinToolExecutorOptions } from "./builtin-tool-executor.js";
import { AgentLoopEngine } from "./agent-loop.js";
import { PlanCompletenessGate } from "./termination-gates.js";
import { composeExplorerTitle, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle, type ExplorerTitleGenerator, type ExplorerTitleSource, type ExplorerTitleStatus } from "./explorer-title.js";
import { allocateRunBranchLeaf, composeRunBranchLeaf, ModelRunBranchNameGenerator, normalizeRunBranchSlug, runBranchName, type RunBranchNameGenerator } from "./run-branch.js";
import { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project.js";
import type { Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings } from "./project.js";
import type { PlanDispatchState } from "./dispatch-coordinator.js";
import { redactAuditPayload, redactAuditText } from "./redaction.js";
import { GeneratedPlanSpecV2ValidationError, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2 } from "./plan-v2.js";
import type { GeneratedPlanSpecV2, PlanValidationIssue, ResolvedPlanContractV2 } from "./plan-v2.js";
export { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project.js";
export { redactAuditPayload, redactAuditText } from "./redaction.js";
export type { CreateProjectInput, Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings, ProjectSettingsInput, ProjectStatus, ProjectSummary, UpdateProjectInput } from "./project.js";
export { PlanDispatchCoordinator } from "./dispatch-coordinator.js";
export type { PlanDispatchCoordinatorOptions, PlanDispatchPhase, PlanDispatchState, PlanDispatchStatus, PlanDispatchWaitReason } from "./dispatch-coordinator.js";
export { projectExplorerActivity } from "./explorer-activity.js";
export type { ExplorerActivityInput, ExplorerActivityItem, ExplorerActivityKind } from "./explorer-activity.js";
export { assertSafeProjectRelativeGlob, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2 } from "./plan-v2.js";
export type { GeneratedPlanSpecV2, GitBaseline, PlanArtifactMode, PlanValidationIssue, PlanValidationIssueCode, ResolvedPlanContractV2 } from "./plan-v2.js";
export { composeExplorerTitle, explorerTimestamp, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle } from "./explorer-title.js";
export type { ExplorerTitleGenerator, ExplorerTitleSource, ExplorerTitleStatus } from "./explorer-title.js";
export { allocateRunBranchLeaf, composeRunBranchLeaf, ModelRunBranchNameGenerator, normalizeRunBranchSlug, runBranchDate, runBranchName } from "./run-branch.js";
export type { RunBranchNameGenerator, RunBranchNameInput } from "./run-branch.js";

export type { AgentLoop, AgentLoopDiagnostics, AgentLoopInput, AgentLoopMode, AgentLoopResult, AgentLoopState, AgentLoopStep, AgentLoopStepInput, AgentLoopStepStatus, AgentLoopRunner, AgentStepType, GateContext, GateDecision, TerminationGate } from "./agent-loop.js";
export { AgentLoopEngine } from "./agent-loop.js";
export { projectAgentLoopDiagnostics } from "./agent-loop.js";
export { PlanCompletenessGate, TaskProgressGate } from "./termination-gates.js";
export { ExecutorAgent, inspectWorkspaceScope, parseExecutorReport } from "./executor-agent.js";
export type { ExecutorAgentOptions, ExecutorReport, WorkspaceScopeInspection, WorkspaceScopeInspector } from "./executor-agent.js";
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

/** Plan 从草稿到执行、验证和合并的持久化状态；DISCARDED 为不可逆终态。 */
export type PlanStatus =
  | "DRAFT"
  | "DISCARDED"
  | "DESIGNED"
  | "PLANNED"
  | "READY"
  | "ENQUEUED"
  | "DISPATCHED"
  | "QUEUED"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "MERGE_READY"
  | "MERGED"
  | "BLOCKED"
  | "NEEDS_PLAN_CHANGE";

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

export type ExecutionThreadSummary = {
  id: string;
  runId: string;
  state: string;
} | null;

/** ExplorerThread 的工作状态；ARCHIVED 只禁止新写入，不删除历史。 */
export type ExplorerThreadState = "ACTIVE" | "WAITING_FOR_INPUT" | "COMPRESSED" | "ARCHIVED";

/** 当前 Explorer 方案是否仍缺少关键决策。 */
export type PlanExplorationStatus = "INCOMPLETE" | "READY";

/** Explorer 对 Plan 完整性检查的投影，供线程页和候选页显示进度。 */
export type PlanExploration = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  diagnostics: PlanValidationIssue[];
  candidatePlanId: string | null;
  lastAssessedTurnId: string | null;
};

/** 形成可执行方案必须覆盖的业务和工程领域。 */
export const REQUIRED_PLAN_AREAS = [
  "目标与用户范围",
  "功能范围与排除项",
  "技术方案与关键约束",
  "数据、安全与异常处理",
  "验收标准与验证命令",
  "实施任务、依赖与冲突",
  "合并策略与人工确认",
] as const;

export type ExplorerPlanRequirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] | undefined };
export const EXPLORER_PLAN_REQUIREMENTS = {
  requirementsVersion: 1,
  schemaVersion: 2,
  areas: [
    { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal", "objective.audience"], optionalFields: [] },
    { key: "scope", label: "功能范围与排除项", requiredFields: ["objective.outOfScope", "scope.includePaths", "scope.excludePaths"], optionalFields: [] },
    { key: "design", label: "技术方案与关键约束", requiredFields: ["design.technicalConstraints"], optionalFields: [] },
    { key: "safety", label: "数据、安全与异常处理", requiredFields: ["design.dataSecurity", "design.failureHandling"], optionalFields: [] },
    { key: "verification", label: "验收标准与验证命令", requiredFields: ["objective.acceptanceCriteria", "verification.mode"], optionalFields: [] },
    { key: "delivery", label: "实施任务、依赖与冲突", requiredFields: ["tasks", "dependencies", "conflicts", "execution"], optionalFields: ["execution.executorModelRole", "execution.toolPolicy", "execution.maxRepairAttempts"] },
    { key: "merge", label: "合并策略与人工确认", requiredFields: ["merge.strategy", "merge.requireHumanMerge"], optionalFields: [] },
  ] satisfies ExplorerPlanRequirement[],
  artifactModes: [
    { mode: "CONVERSATION", label: "对话产物", includePaths: "EMPTY", verificationMode: "NONE", executable: false },
    { mode: "REPOSITORY_FILE", label: "仓库文件", includePaths: "NON_EMPTY", verificationMode: "PROJECT_DEFAULT_OR_NONE", executable: true },
  ] as const,
  factoryOwnedFields: ["repository", "baseBranch", "baseCommit", "configVersion", "configHash", "verification.commandIds", "verificationCommandIds"],
} as const;

/** 注入 Explorer 的职责和 machine-readable Plan 协议；变更需同步协议解析器。 */
export const EXPLORER_PLAN_INSTRUCTIONS = `
你是 Pipeline Factory 的 Plan Explorer。你的职责是围绕用户需求持续探索，直到形成可执行的完整设计方案；一次普通 turn 结束不代表探索完成。
先分析目标、用户范围、功能边界、技术方案、数据与安全、异常处理、验收标准、实施任务、依赖、冲突、验证和合并策略。把当前所有互不依赖且需要用户决策的问题合并到一次原生 item/tool/requestUserInput 请求中；不要在普通文本中把问题伪装成选择题。若用户没有明确产物模式，必须询问 CONVERSATION（仅对话审阅）或 REPOSITORY_FILE（写入仓库文件），不得自行假设。
完整方案的模型必填字段为：title；artifact.mode（REPOSITORY_FILE 时 artifact.path 必填）；objective.goal、objective.audience、objective.acceptanceCriteria、objective.outOfScope；design.technicalConstraints、design.dataSecurity、design.failureHandling；scope.includePaths、scope.excludePaths；tasks、dependencies、conflicts、execution、verification.mode、merge.strategy、merge.requireHumanMerge。outOfScope、excludePaths、dependencies、conflicts、task.dependencies 可以为空数组；技术/安全/异常/受众/验收必须显式给出至少一项，“无新增约束”也必须写明。execution 内的 executorModelRole、toolPolicy、maxRepairAttempts 可省略，由 Factory 使用默认值。
REPOSITORY_FILE：artifact.path 必须是项目根相对路径或 glob，且必须包含在 scope.includePaths 中，scope.includePaths 至少一项。CONVERSATION：artifact.path 不得出现，scope.includePaths 必须为 []，verification.mode 必须为 NONE；它仍会生成可审阅 CandidatePlan，但不能入队或执行。
模型不得填写 repository、baseBranch、baseCommit、configVersion、configHash、commandIds 或 verificationCommandIds；这些字段只能由 Factory 基于当前 Project 与 Git 基线解析。范围不能填绝对路径、.. 或概念性描述。
只有所有关键项都已确认，才能输出完整方案。完整方案必须在普通说明之后追加以下机器可校验协议块，JSON 必须是严格 JSON，不要使用 Markdown 代码围栏：
<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>
<pipeline-factory-plan>{"schemaVersion":2,"title":"...","artifact":{"mode":"REPOSITORY_FILE","path":"docs/guide.md"},"objective":{"goal":"...","audience":["..."],"acceptanceCriteria":["..."],"outOfScope":[]},"design":{"technicalConstraints":["..."],"dataSecurity":["..."],"failureHandling":["..."]},"scope":{"includePaths":["docs/guide.md"],"excludePaths":[]},"tasks":[{"id":"task-1","title":"...","dependencies":[],"status":"READY"}],"dependencies":[],"conflicts":[],"execution":{},"verification":{"mode":"PROJECT_DEFAULT"},"merge":{"strategy":"manual","requireHumanMerge":true}}</pipeline-factory-plan>
不要在缺少关键决策时输出 READY；不要把“已记录某个选择”当作完整方案。收到字段级校验错误后，逐项修复；不得原样重复未通过的 READY 协议块。`;

/** Factory 内部的长期 Explorer 工作区，与外部 Provider Thread 标识分离。 */
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
  activeExplorerPlanId: string | null;
  contextSummary: ExplorerThreadContextSummary | null;
  lastActivityAt: string;
  exploration: PlanExploration;
  /** 当前正在此 Explorer 中编辑的修订草稿；确认或丢弃后清空。 */
  activeRevisionDraftId: string | null;
};

/** 一个 ExplorerThread 下的独立 Plan 对话分区；不拥有独立 Provider 会话。 */
export type ExplorerPlan = {
  id: string;
  explorerThreadId: string;
  projectId: string;
  ordinal: number;
  title: string;
  titleSource: ExplorerTitleSource;
  titleStatus: ExplorerTitleStatus;
  messageCount: number;
  latestUserMessageSummary: string | null;
  exploration: PlanExploration;
  candidatePlanId: string | null;
  /** Explicit null selection means the next READY output starts a new independent Plan. */
  newPlanRequested?: boolean;
  lastAssessedTurnId: string | null;
  createdAt: string;
  lastActivityAt: string;
  runtimeStatus?: ExplorerTurn["status"];
};

/** Factory 生成的线程级跨 Plan 上下文摘要；不包含敏感答案或仓库基线。 */
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

/** Explorer 的用户/模型消息事实；sequence 用于稳定回放和定位 Plan 卡片。 */
export type ExplorerTurn = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status?: "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "COMPLETED" | "FAILED" | "CANCELLED";
  error?: string;
  createdAt: string;
  sequence: number;
  /** 新数据必填；缺失表示需要按旧线程回填到 Plan 1。 */
  explorerPlanId?: string;
};

/** Plan 中可独立追踪的任务及其依赖状态。 */
export type PlanTask = {
  id: string;
  title: string;
  dependencies: string[];
  status: "PENDING" | "READY" | "DONE";
};

/** Confirm 后供 Executor、Verification 和 Merge 共同消费的执行合同。 */
/** @deprecated Flat V1 contracts are retained only to display historical records. */
export type PlanContract = {
  schemaVersion?: 1;
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
  /** Conversation plans are reviewable but never executable. Undefined keeps historical contracts compatible. */
  artifactMode?: "CONVERSATION" | "REPOSITORY_FILE";
  artifactPath?: string;
  dependsOnPlanIds?: string[];
  priority?: number;
};

/** 从 Explorer 对话投影出的候选 Plan；Confirm 前仍允许编辑或丢弃。 */
export type CandidatePlan = {
  id: string;
  projectId: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string;
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
  dispatchedAt?: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  contract: PlanContract;
  /** V2 is the only contract admitted from Explorer output and executable by new scheduling. */
  generatedSpec?: GeneratedPlanSpecV2;
  resolvedContract?: ResolvedPlanContractV2;
};

/** 执行中发现范围变化时，ChangeProposal 的人工决策状态。 */
export type ChangeProposalStatus = "OPEN" | "APPROVED" | "REJECTED" | "SUPERSEDED";

/** 从 Run 返回 Plan 的变更提案；合同原值保持不可变。 */
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

/** 已批准变更及其新 Revision/Run 的聚合返回值。 */
export type ApprovedChangeProposal = {
  proposal: ChangeProposal;
  plan: CandidatePlan;
  revision: PlanRevisionV2;
  run: Run | null;
};

/** Confirm 时冻结的 Plan 合同和 ProjectExecutionSnapshot，不随当前配置变化。 */
export type PlanRevisionV2 = Readonly<{
  planId: string;
  revision: number;
  contract: Readonly<PlanContract>;
  resolvedContract?: Readonly<ResolvedPlanContractV2>;
  artifactHash: string;
  confirmedBy: string;
  confirmedAt: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string;
  sourceTurnId?: string | null;
  providerThreadId?: string | null;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  /** 旧数据无法补齐快照时只允许浏览，不能作为新执行来源。 */
  provenance?: "CURRENT" | "LEGACY";
  projectConfigVersion?: number;
  projectConfigHash?: string;
  projectConfigSnapshot?: ProjectExecutionSnapshot;
}>;

/** 已确认 Revision 之间唯一可写的工作副本。Draft 永不直接成为 Executor 契约。 */
export type PlanRevisionDraftStatus = "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED";
export type PlanRevisionDraft = Readonly<{
  draftId: string;
  planId: string;
  projectId: string;
  basedOnRevision: number;
  targetRevision: number;
  status: PlanRevisionDraftStatus;
  title: string;
  contract: Readonly<PlanContract>;
  generatedSpec?: GeneratedPlanSpecV2;
  resolvedContract?: ResolvedPlanContractV2;
  sourceExplorerThreadId: string;
  explorerPlanId?: string;
  sourceTurnId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  baseBranch: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}>;

/** 用复合 PlanRef 表示的版本生命周期投影；不能用 latest 隐式替代 revision。 */
export type RevisionLifecycleProjection = {
  planId: string;
  revision: number;
  projectId: string;
  title: string;
  status: PlanStatus | PlanRevisionDraftStatus | "LEGACY";
  sourceExplorerThreadId: string;
  runId: string | null;
  lastEventAt: string;
};

/** Plan Center 和 Explorer Plans 导航使用的轻量索引行。 */
export type PlanIndexRow = {
  planId: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string;
  sourceTurnId: string | null;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  createdAt: string;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  priority: number;
};

/** Plan Center 使用的持久化查询投影；只包含可检索、可排序的只读字段。 */
export type PlanQueryProjection = {
  planId: string;
  projectId: string;
  sourceExplorerThreadId: string;
  sourceTurnId: string | null;
  title: string;
  goal: string;
  revision: number;
  status: PlanStatus;
  priority: number;
  createdAt: string;
  queuedAt: string | null;
  dispatchedAt?: string | null;
  lastEventAt: string;
  runId: string | null;
  attentionReason: string | null;
};

export type PlanQuerySort = "queued_at" | "last_event_at" | "priority" | "status";

/** Plan Center 的完整查询契约；cursor 与 sort 一起形成稳定分页边界。 */
export type PlanQuery = {
  projectId: string;
  explorerThreadId?: string;
  includeLineage?: boolean;
  status?: PlanStatus[];
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
  sort: PlanQuerySort;
};

export type PlanQueryResult = { items: PlanIndexRow[]; nextCursor: string | null };

function planQueryProjectionFor(plan: CandidatePlan): PlanQueryProjection {
  return {
    planId: plan.id,
    projectId: plan.projectId,
    sourceExplorerThreadId: plan.sourceExplorerThreadId,
    sourceTurnId: plan.sourceTurnId,
    title: plan.title,
    goal: plan.contract.goal,
    revision: plan.revision,
    status: plan.status,
    priority: plan.contract.priority ?? 0,
    createdAt: plan.createdAt,
    queuedAt: plan.queuedAt,
    dispatchedAt: plan.dispatchedAt ?? null,
    lastEventAt: plan.lastEventAt,
    runId: plan.runId,
    attentionReason: plan.attentionReason,
  };
}

type PlanCursor = { sort: PlanQuerySort; planId: string };

function encodePlanCursor(cursor: PlanCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePlanCursor(value: string): PlanCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PlanCursor>;
    if (typeof parsed.planId !== "string" || !parsed.planId || !["queued_at", "last_event_at", "priority", "status"].includes(parsed.sort ?? "")) throw new Error("invalid");
    return { planId: parsed.planId, sort: parsed.sort as PlanQuerySort };
  } catch {
    throw new Error("Invalid Plan query cursor");
  }
}

function selectCurrentExplorer(store: PipelineStore, thread: ExplorerThread): void {
  const project = store.getProject(thread.projectId);
  if (project && project.currentExplorerThreadId !== thread.id) {
    store.updateProject({ ...project, currentExplorerThreadId: thread.id, updatedAt: store.now() });
    store.appendEvent({ type: "project.explorer.selected", aggregateId: project.id, payload: { projectId: project.id, explorerId: thread.id } });
  }
}

/** 所有聚合共享的审计事件格式；payload 只保存结构化业务事实。 */
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
    | "explorer.deleted"
    | "explorer.title.updated"
    | "explorer.archived"
    | "explorer.activated"
    | "explorer.continued"
    | "explorer.plan.created"
    | "explorer.plan.renamed"
    | "explorer.plan.selected"
    | "explorer.turn.accepted"
    | "explorer.turn.started"
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
    | "plan.candidate.revised"
    | "plan.status.changed"
    | "plan.discarded"
    | "plan.confirmed"
    | "plan.enqueued"
    | "plan.dispatched"
    | "plan.configuration.revised"
    | "plan.revision.draft.created"
    | "plan.revision.draft.ready"
    | "plan.revision.draft.discarded"
    | "plan.revision.confirmed"
    | "plan.dispatch.state.changed"
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
    | "merge.detected"
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

/** ExplorerThread 删除所需的完整业务关联集合；物理删除由 Store 统一执行。 */
export type ExplorerDeletionInput = {
  projectId: string;
  explorerId: string;
  explorerPlanIds: string[];
  turnIds: string[];
  planIds: string[];
  runIds: string[];
  executionThreadIds: string[];
  agentLoopIds: string[];
  inputRequestIds: string[];
  replacementExplorerId: string;
};

export type ExplorerDeletionSummary = {
  taskCount: number;
  planCount: number;
  runCount: number;
};

/** 从 Explorer turn 创建 CandidatePlan 的最小输入。 */
export type CreateCandidatePlanInput = {
  projectId: string;
  sourceExplorerThreadId: string;
  explorerPlanId?: string | undefined;
  title: string;
  contract?: PlanContract | undefined;
  generatedSpec?: GeneratedPlanSpecV2 | undefined;
  sourceTurnId?: string | null | undefined;
  providerThreadId?: string | null | undefined;
  providerTurnId?: string | null | undefined;
  providerItemId?: string | null | undefined;
};

export type CreateRevisionDraftInput = {
  planId: string;
  fromRevision: number;
  explorerThreadId: string;
  discardUnmergedRun: boolean;
  clientRequestId: string;
};

/** 注册已有 Provider 关联的本地 ExplorerThread。 */
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

/** 创建全新或显式继承来源的 ExplorerThread。 */
export type CreateExplorerInput = {
  projectId: string;
  title?: string | undefined;
  originThreadId?: string | undefined;
  createdAt?: string | undefined;
};

/** Project 快照中注册的 Hook 命令及其启用/超时策略。 */
export type HookDefinition = {
  commandId: string;
  enabled?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
};

/** Hook 执行上下文；路径固定指向当前 Run 的 Worktree。 */
export type HookContext = {
  projectId: string;
  runId: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  exitReason: string;
};

/** 已注册命令的一次确定性调用，不携带任意 shell 字符串。 */
export type CommandInvocation = {
  commandId: string;
  cwd: string;
  timeoutMs: number;
  context: HookContext;
};

/** 进程执行结果；exitCode 为 null 表示进程被信号或运行时中断。 */
export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** Hook/验证共用的命令执行端口。 */
export type CommandExecutor = (command: CommandInvocation) => Promise<CommandResult>;

/** Provider 结构化询问中的单个问题；secret 答案只能保存脱敏摘要。 */
export type ModelInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

/** Provider 等待用户回答的结构化请求及其生命周期标识。 */
export type ModelInputRequest = {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ModelInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
};

/** 提交给 Provider 的按问题 id 分组答案。 */
export type ModelInputAnswers = Record<string, { answers: string[] }>;

/** 本地持久化的结构化输入请求状态。 */
export type ExplorerInputRequestStatus = "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "AUTO_RESOLVED" | "RECOVERY_REQUIRED";

/** Explorer 输入请求事实；保存可回放的脱敏摘要而非 secret 原文。 */
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
  autoResolutionMs: number | null;
  status: ExplorerInputRequestStatus;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
};

/** Start/Cleanup Hook 的归一化结果及其是否阻塞 Run 的判断。 */
export type HookRunResult = {
  hook: "start" | "cleanup";
  status: "completed" | "failed" | "skipped";
  blocked: boolean;
  needsAttention: boolean;
  result: CommandResult | null;
  attempts: Array<{
    attempt: number;
    commandId: string | null;
    cwd: string;
    timeoutMs: number;
    status: "completed" | "failed" | "skipped";
    result: CommandResult | null;
    startedAt: string;
    completedAt: string;
  }>;
};

/** 一次 Hook 尝试的完整审计事实；同一 Run/Hook 的 attempt 不可复用。 */
export type HookExecution = {
  id: string;
  runId: string;
  hookType: "start" | "cleanup";
  attempt: number;
  commandId: string | null;
  cwd: string;
  timeoutMs: number;
  status: "completed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
};

/** Domain 的持久化端口；内存和 SQLite 实现必须保持相同的事实及事件语义。 */
export type PipelineStore = {
  now(): string;
  nextId(prefix: string): string;
  saveThread(input: RegisterThreadInput): ExplorerThread;
  getThread(id: string): ExplorerThread | undefined;
  listThreads(): ExplorerThread[];
  updateThread(thread: ExplorerThread): ExplorerThread;
  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan;
  getExplorerPlan(id: string): ExplorerPlan | undefined;
  listExplorerPlans(threadId?: string): ExplorerPlan[];
  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan;
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
  saveCandidateVersion(plan: CandidatePlan): CandidatePlan;
  listCandidateVersions(planId: string): CandidatePlan[];
  saveDispatchState(state: PlanDispatchState): PlanDispatchState;
  /** 删除当前调度投影；历史状态变更仍保留在领域事件中。 */
  deleteDispatchState(planId: string): void;
  getDispatchState(planId: string): PlanDispatchState | undefined;
  listDispatchStates(projectId?: string): PlanDispatchState[];
  saveRevision(revision: PlanRevisionV2): PlanRevisionV2;
  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined;
  listRevisions(planId: string): PlanRevisionV2[];
  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft;
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined;
  listRevisionDrafts(planId?: string): PlanRevisionDraft[];
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft;
  saveRevisionLifecycleProjection(projection: RevisionLifecycleProjection): RevisionLifecycleProjection;
  listRevisionLifecycleProjections(projectId?: string, planId?: string): RevisionLifecycleProjection[];
  saveChangeProposal(proposal: ChangeProposal): ChangeProposal;
  getChangeProposal(id: string): ChangeProposal | undefined;
  listChangeProposals(runId?: string): ChangeProposal[];
  updateChangeProposal(proposal: ChangeProposal): ChangeProposal;
  saveRun(run: Run): Run;
  getRun(runId: string): Run | undefined;
  listRuns(): Run[];
  saveExecutionThread(thread: ExecutionThread): ExecutionThread;
  getExecutionThread(threadId: string): ExecutionThread | undefined;
  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry;
  saveHookExecution(execution: HookExecution): HookExecution;
  listHookExecutions(runId?: string): HookExecution[];
  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection;
  listPlanQueryProjection(projectId?: string): PlanQueryProjection[];
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
  subscribeEvents?(listener: (event: DomainEvent) => void): () => void;
  listEvents(options?: { afterSequence?: number; aggregateId?: string }): DomainEvent[];
  getLastEventSequence(aggregateId?: string): number;
  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary;
  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined;
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void;
  /** Optional store-level transaction used for startup recovery atomicity. */
  runInTransaction?<T>(work: () => T): T;
};

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

function defaultPlanExploration(): PlanExploration {
  return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], candidatePlanId: null, lastAssessedTurnId: null };
}

function defaultExplorerPlan(thread: Pick<ExplorerThread, "id" | "projectId" | "createdAt">, id: string, ordinal: number, now: string): ExplorerPlan {
  return {
    id,
    explorerThreadId: thread.id,
    projectId: thread.projectId,
    ordinal,
    title: `Plan ${ordinal} / 待探索`,
    titleSource: "AUTO",
    titleStatus: "PLACEHOLDER",
    messageCount: 0,
    latestUserMessageSummary: null,
    exploration: defaultPlanExploration(),
    candidatePlanId: null,
    newPlanRequested: false,
    lastAssessedTurnId: null,
    createdAt: thread.createdAt,
    lastActivityAt: now,
  };
}

function defaultThreadContextSummary(now: string): ExplorerThreadContextSummary {
  return { version: 1, updatedAt: now, completedPlans: [], openPlanIds: [] };
}

export type PlanArtifact = { title: string; contract?: PlanContract; generatedSpec?: GeneratedPlanSpecV2 };
export type PlanCompletionAssessment = {
  status: PlanExplorationStatus;
  missing: string[];
  completed: string[];
  diagnostics: PlanValidationIssue[];
  artifact: PlanArtifact | null;
};

/** 解析模型协议块并检查 Plan 是否具备可执行的完整契约。 */
export function assessPlanCompletion(content: string): PlanCompletionAssessment {
  const candidates = planProtocolCandidates(content);
  if (candidates.length === 0) return { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], artifact: null };

  let sawReadyCandidate = false;
  let latestIncomplete: PlanCompletionAssessment | null = null;
  for (const candidate of [...candidates].reverse()) {
    if (candidate.status !== "READY") continue;
    sawReadyCandidate = true;
    const assessment = assessPlanArtifact(candidate.artifactText);
    if (assessment.status === "READY") return assessment;
    latestIncomplete ??= assessment;
  }
  if (latestIncomplete) {
    const latest = [...candidates].reverse().find((candidate) => candidate.status === "READY");
    const repeats = latest ? candidates.filter((candidate) => candidate.status === "READY" && candidate.artifactText === latest.artifactText).length : 0;
    if (repeats > 1) return { ...latestIncomplete, diagnostics: [...latestIncomplete.diagnostics, { path: "$", code: "DUPLICATE", area: "完整执行契约", message: "本轮已重复输出相同的未通过 READY 协议块；请按字段诊断修改后再提交。" }] };
    return latestIncomplete;
  }
  return sawReadyCandidate
    ? { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "READY 协议块不完整。" }], artifact: null }
    : { status: "INCOMPLETE", missing: [...REQUIRED_PLAN_AREAS], completed: [], diagnostics: [], artifact: null };
}

function planProtocolCandidates(content: string): Array<{ status: string; artifactText: string }> {
  const statusMatches = [...content.matchAll(/<pipeline-factory-plan-status>\s*([^<]+?)\s*<\/pipeline-factory-plan-status>/gi)];
  const planMatches = [...content.matchAll(/<pipeline-factory-plan>\s*([\s\S]*?)\s*<\/pipeline-factory-plan>/gi)];
  return statusMatches.flatMap((statusMatch, index) => {
    const statusEnd = (statusMatch.index ?? 0) + statusMatch[0].length;
    const nextStatusStart = statusMatches[index + 1]?.index ?? content.length;
    const plan = planMatches.find((candidate) => (candidate.index ?? -1) >= statusEnd && (candidate.index ?? content.length) < nextStatusStart);
    const statusText = statusMatch[1];
    return plan && typeof plan[1] === "string" && typeof statusText === "string" ? [{ status: statusText.trim().toUpperCase(), artifactText: plan[1] }] : [];
  });
}

function assessPlanArtifact(artifactText: string): PlanCompletionAssessment {
  let parsed: unknown;
  try { parsed = JSON.parse(artifactText); } catch { return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是严格 JSON，不能使用代码围栏或残缺 JSON。" }], artifact: null }; }
  if (!isRecord(parsed)) return { status: "INCOMPLETE", missing: ["完整执行契约"], completed: [], diagnostics: [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是 JSON 对象。" }], artifact: null };
  // V2 is intentionally a generated spec: Factory adds project identity, Git
  // baseline and default verification commands only after this boundary.
  if (parsed.schemaVersion === 2) {
    try {
      const generatedSpec = parseGeneratedPlanSpecV2(parsed);
      return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], artifact: { title: generatedSpec.title, generatedSpec } };
    } catch (error) {
      const diagnostics = error instanceof GeneratedPlanSpecV2ValidationError ? error.issues : validateGeneratedPlanSpecV2(parsed);
      const missing = [...new Set(diagnostics.map((item) => item.area))];
      return { status: "INCOMPLETE", missing: missing.length ? missing : ["完整执行契约"], completed: REQUIRED_PLAN_AREAS.filter((area) => !missing.includes(area)), diagnostics, artifact: null };
    }
  }
  const missing: string[] = [];
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) missing.push("方案标题");
  const contract = parsed as Partial<PlanContract>;
  if (typeof contract.goal !== "string" || !contract.goal.trim()) missing.push("目标与用户范围");
  if (!isNonEmptyStringArray(contract.acceptanceCriteria)) missing.push("验收标准与验证命令");
  if (!isStringArray(contract.include) || !isStringArray(contract.exclude)) missing.push("功能范围与排除项");
  if (typeof contract.baseBranch !== "string" || !contract.baseBranch.trim() || typeof contract.baseCommit !== "string" || !contract.baseCommit.trim()) missing.push("基线 Branch 与 Commit");
  if (!Array.isArray(contract.tasks) || contract.tasks.length === 0 || contract.tasks.some((task) => !isRecord(task) || typeof task.id !== "string" || !task.id.trim() || typeof task.title !== "string" || !task.title.trim() || !isStringArray(task.dependencies))) missing.push("实施任务、依赖与冲突");
  if (contract.dependsOnPlanIds !== undefined && !isStringArray(contract.dependsOnPlanIds)) missing.push("实施任务、依赖与冲突");
  if (!isStringArray(contract.conflictKeys)) missing.push("实施任务、依赖与冲突");
  if (typeof contract.executorModelRole !== "string" || !contract.executorModelRole.trim() || typeof contract.toolPolicy !== "string" || !contract.toolPolicy.trim()) missing.push("Executor 模型与 ToolPolicy");
  if (!isNonEmptyStringArray(contract.verificationCommandIds)) missing.push("验收标准与验证命令");
  if (typeof contract.maxRepairAttempts !== "number" || contract.maxRepairAttempts < 0 || !Number.isInteger(contract.maxRepairAttempts)) missing.push("修复次数上限");
  if (contract.mergeStrategy !== "manual" && contract.mergeStrategy !== "fast-forward" && contract.mergeStrategy !== "squash") missing.push("合并策略与人工确认");
  if (contract.requireHumanMerge !== true) missing.push("合并策略与人工确认");
  if (missing.length === 0) {
    try { validatePlanContract(contract as PlanContract); } catch { missing.push("实施任务、依赖与冲突"); }
  }
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) return { status: "INCOMPLETE", missing: uniqueMissing, completed: REQUIRED_PLAN_AREAS.filter((area) => !uniqueMissing.includes(area)), diagnostics: uniqueMissing.map((area) => ({ path: "$", code: "REQUIRED" as const, area, message: "历史 V1 合同缺少必填字段。" })), artifact: null };
  // Flat artifacts are history-only. New Explorer instructions only emit V2.
  return { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], artifact: { title, contract: { ...(contract as PlanContract), schemaVersion: 1 } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerificationRun(value: unknown): value is VerificationRun {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.runId === "string"
    && (value.status === "PASSED" || value.status === "SKIPPED" || value.status === "FAILED" || value.status === "BLOCKED")
    && typeof value.repairAttempts === "number"
    && Number.isInteger(value.repairAttempts)
    && Array.isArray(value.commandResults)
    && typeof value.completedAt === "string";
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

function parseThreadContextSummary(value: unknown, fallbackTime: string): ExplorerThreadContextSummary {
  if (typeof value !== "string") return defaultThreadContextSummary(fallbackTime);
  try {
    const parsed = JSON.parse(value) as Partial<ExplorerThreadContextSummary>;
    if (parsed.version !== 1 || !Array.isArray(parsed.completedPlans) || !Array.isArray(parsed.openPlanIds)) return defaultThreadContextSummary(fallbackTime);
    return { version: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallbackTime, completedPlans: parsed.completedPlans as ExplorerThreadContextSummary["completedPlans"], openPlanIds: parsed.openPlanIds.filter((id): id is string => typeof id === "string") };
  } catch {
    return defaultThreadContextSummary(fallbackTime);
  }
}

function parsePlanValidationIssues(value: unknown): PlanValidationIssue[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PlanValidationIssue => isRecord(item)
      && typeof item.path === "string"
      && typeof item.code === "string"
      && typeof item.area === "string"
      && typeof item.message === "string")
      .map((item) => ({ path: item.path, code: item.code as PlanValidationIssue["code"], area: item.area, message: item.message }));
  } catch { return []; }
}

const LEGACY_AUTO_TITLES = new Set(["New Explorer", "Previous exploration", "ExplorerThread"]);

function threadTitleMetadata(title: string | undefined, createdAt: string): { title: string; titleSource: ExplorerTitleSource; titleStatus: ExplorerTitleStatus } {
  const normalized = title?.trim();
  if (!normalized || LEGACY_AUTO_TITLES.has(normalized)) return { title: placeholderExplorerTitle(createdAt), titleSource: "AUTO", titleStatus: "PLACEHOLDER" };
  return { title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED" };
}

function projectPlaceholderExplorerTitle(store: PipelineStore, thread: ExplorerThread): string {
  return placeholderExplorerTitle(thread.createdAt, store.getProject(thread.projectId)?.shortName);
}

function containsAnyString(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => containsAnyString(item, ids));
  if (isRecord(value)) return Object.values(value).some((item) => containsAnyString(item, ids));
  return false;
}

function stripPlanProtocol(content: string): string {
  return content
    .replace(/<pipeline-factory-plan-status>[\s\S]*?<\/pipeline-factory-plan-status>/gi, "")
    .replace(/<pipeline-factory-plan>[\s\S]*?<\/pipeline-factory-plan>/gi, "")
    .trim();
}

function summarizeExplorerMessage(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

/** 用于测试和轻量集成的内存 Store，不改变领域服务的持久化接口。 */
export class InMemoryPipelineStore implements PipelineStore {
  private readonly projects = new Map<string, Project>();
  private readonly projectConfigRevisions = new Map<string, ProjectConfigRevision[]>();
  private readonly explorerPlans = new Map<string, ExplorerPlan>();
  private readonly plans = new Map<string, CandidatePlan>();
  private readonly candidateVersions = new Map<string, CandidatePlan>();
  private readonly dispatchStates = new Map<string, PlanDispatchState>();
  private readonly revisions = new Map<string, PlanRevisionV2>();
  private readonly revisionDrafts = new Map<string, PlanRevisionDraft>();
  private readonly revisionLifecycleProjections = new Map<string, RevisionLifecycleProjection>();
  private readonly changeProposals = new Map<string, ChangeProposal>();
  private readonly runs = new Map<string, Run>();
  private readonly executionThreads = new Map<string, ExecutionThread>();
  private readonly hookExecutions = new Map<string, HookExecution>();
  private readonly planQueryProjections = new Map<string, PlanQueryProjection>();
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
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();
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
      activeExplorerPlanId: null,
      contextSummary: defaultThreadContextSummary(this.now()),
      lastActivityAt: this.now(),
      exploration: defaultPlanExploration(),
      activeRevisionDraftId: null,
    };
    this.threads.set(thread.id, thread);
    const plan = defaultExplorerPlan(thread, this.nextId("explorer-plan"), 1, thread.lastActivityAt);
    this.explorerPlans.set(plan.id, plan);
    const updated = { ...thread, activeExplorerPlanId: plan.id, contextSummary: { ...thread.contextSummary!, openPlanIds: [plan.id] } };
    this.threads.set(thread.id, updated);
    return updated;
  }

  getThread(id: string): ExplorerThread | undefined {
    return this.threads.get(id);
  }

  listThreads(): ExplorerThread[] {
    return [...this.threads.values()];
  }

  updateThread(thread: ExplorerThread): ExplorerThread { this.threads.set(thread.id, thread); return thread; }
  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan { this.explorerPlans.set(plan.id, plan); return plan; }
  getExplorerPlan(id: string): ExplorerPlan | undefined { return this.explorerPlans.get(id); }
  listExplorerPlans(threadId?: string): ExplorerPlan[] { return [...this.explorerPlans.values()].filter((plan) => !threadId || plan.explorerThreadId === threadId).sort((a, b) => a.ordinal - b.ordinal || a.createdAt.localeCompare(b.createdAt)); }
  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    if (!this.explorerPlans.has(plan.id)) throw new Error(`ExplorerPlan ${plan.id} does not exist`);
    this.explorerPlans.set(plan.id, plan);
    return plan;
  }
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
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
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
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    return plan;
  }

  saveCandidateVersion(plan: CandidatePlan): CandidatePlan {
    const key = `${plan.id}:${plan.revision}`;
    if (!this.candidateVersions.has(key)) this.candidateVersions.set(key, structuredClone(plan));
    return this.candidateVersions.get(key)!;
  }

  listCandidateVersions(planId: string): CandidatePlan[] {
    return [...this.candidateVersions.values()].filter((plan) => plan.id === planId).sort((a, b) => a.revision - b.revision);
  }

  saveDispatchState(state: PlanDispatchState): PlanDispatchState {
    this.dispatchStates.set(state.planId, state);
    return state;
  }

  deleteDispatchState(planId: string): void {
    this.dispatchStates.delete(planId);
  }

  getDispatchState(planId: string): PlanDispatchState | undefined {
    return this.dispatchStates.get(planId);
  }

  listDispatchStates(projectId?: string): PlanDispatchState[] {
    return [...this.dispatchStates.values()]
      .filter((state) => !projectId || state.projectId === projectId)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.planId.localeCompare(b.planId));
  }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.revisions.set(`${revision.planId}:${revision.revision}`, revision);
    return revision;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    return this.revisions.get(`${planId}:${revision}`);
  }
  listRevisions(planId: string): PlanRevisionV2[] {
    return [...this.revisions.values()].filter((item) => item.planId === planId).sort((a, b) => a.revision - b.revision);
  }
  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    const active = this.listRevisionDrafts(draft.planId).find((item) => (item.status === "EDITING" || item.status === "READY_TO_CONFIRM" || item.status === "BASE_CHANGED") && item.draftId !== draft.draftId);
    if (active) throw new Error(`Plan ${draft.planId} already has active RevisionDraft ${active.draftId}`);
    this.revisionDrafts.set(draft.draftId, draft);
    return draft;
  }
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined { return this.revisionDrafts.get(draftId); }
  listRevisionDrafts(planId?: string): PlanRevisionDraft[] { return [...this.revisionDrafts.values()].filter((item) => !planId || item.planId === planId).sort((a, b) => a.targetRevision - b.targetRevision || a.createdAt.localeCompare(b.createdAt)); }
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    if (!this.revisionDrafts.has(draft.draftId)) throw new Error(`RevisionDraft ${draft.draftId} does not exist`);
    this.revisionDrafts.set(draft.draftId, draft);
    return draft;
  }
  saveRevisionLifecycleProjection(projection: RevisionLifecycleProjection): RevisionLifecycleProjection {
    this.revisionLifecycleProjections.set(`${projection.planId}:${projection.revision}`, projection);
    return projection;
  }
  listRevisionLifecycleProjections(projectId?: string, planId?: string): RevisionLifecycleProjection[] {
    return [...this.revisionLifecycleProjections.values()].filter((item) => (!projectId || item.projectId === projectId) && (!planId || item.planId === planId)).sort((a, b) => a.planId.localeCompare(b.planId) || a.revision - b.revision);
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
  saveExecutionThread(thread: ExecutionThread): ExecutionThread {
    const safe = { ...thread, journal: thread.journal.map((entry) => ({ ...entry, payload: redactAuditPayload(entry.payload) })) };
    this.executionThreads.set(thread.id, safe);
    return safe;
  }
  getExecutionThread(threadId: string): ExecutionThread | undefined { return this.executionThreads.get(threadId); }
  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry {
    const thread = this.executionThreads.get(input.executionThreadId);
    if (!thread || thread.runId !== input.runId) throw new Error(`ExecutionThread ${input.executionThreadId} does not belong to Run ${input.runId}`);
    const entry: ExecutionJournalEntry = { sequence: thread.journal.length + 1, type: input.type, occurredAt: input.occurredAt ?? this.now(), payload: redactAuditPayload(input.payload) };
    this.executionThreads.set(thread.id, { ...thread, journal: [...thread.journal, entry] });
    return entry;
  }
  saveHookExecution(execution: HookExecution): HookExecution {
    const safe = { ...execution, stdout: redactAuditText(execution.stdout), stderr: redactAuditText(execution.stderr) };
    const key = `${safe.runId}:${safe.hookType}:${safe.attempt}`;
    if (!this.hookExecutions.has(key)) this.hookExecutions.set(key, safe);
    return this.hookExecutions.get(key)!;
  }
  listHookExecutions(runId?: string): HookExecution[] {
    return [...this.hookExecutions.values()].filter((execution) => !runId || execution.runId === runId).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attempt - b.attempt);
  }
  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection { this.planQueryProjections.set(projection.planId, projection); return projection; }
  listPlanQueryProjection(projectId?: string): PlanQueryProjection[] {
    return [...this.planQueryProjections.values()].filter((projection) => !projectId || projection.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
  }
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
    const saved: DomainEvent = { ...event, payload: redactAuditPayload(event.payload), id: this.nextId("event"), sequence: ++this.eventSequence, occurredAt: this.now() };
    this.events.push(saved);
    for (const listener of this.eventListeners) listener(saved);
    return saved;
  }

  subscribeEvents(listener: (event: DomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  listEvents(options: { afterSequence?: number; aggregateId?: string } = {}): DomainEvent[] {
    return this.events.filter((event) => event.sequence > (options.afterSequence ?? 0) && (!options.aggregateId || event.aggregateId === options.aggregateId));
  }

  getLastEventSequence(aggregateId?: string): number {
    return this.events.filter((event) => !aggregateId || event.aggregateId === aggregateId).at(-1)?.sequence ?? 0;
  }

  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary {
    const project = this.projects.get(input.projectId);
    const replacement = this.threads.get(input.replacementExplorerId);
    if (!project || !replacement || replacement.projectId !== input.projectId || replacement.id === input.explorerId) throw new Error("Explorer deletion replacement is invalid");
    if (project.currentExplorerThreadId === input.explorerId) this.projects.set(input.projectId, { ...project, currentExplorerThreadId: replacement.id, updatedAt: this.now() });

    const explorerPlanIds = new Set(input.explorerPlanIds);
    const planIds = new Set(input.planIds);
    const runIds = new Set(input.runIds);
    const executionThreadIds = new Set(input.executionThreadIds);
    const agentLoopIds = new Set(input.agentLoopIds);
    const deletedIds = new Set([input.explorerId, ...explorerPlanIds, ...input.turnIds, ...planIds, ...runIds, ...executionThreadIds, ...agentLoopIds, ...input.inputRequestIds]);

    for (const [key, proposal] of this.changeProposals) if (runIds.has(proposal.runId) || planIds.has(proposal.planId)) this.changeProposals.delete(key);
    for (const key of [...this.dispatchStates.keys()]) if (planIds.has(key)) this.dispatchStates.delete(key);
    for (const key of [...this.revisions.keys()]) if (planIds.has(key.split(":")[0] ?? "")) this.revisions.delete(key);
    for (const [key, draft] of this.revisionDrafts) if (planIds.has(draft.planId) || draft.sourceExplorerThreadId === input.explorerId) this.revisionDrafts.delete(key);
    for (const [key, projection] of this.revisionLifecycleProjections) if (planIds.has(projection.planId) || projection.sourceExplorerThreadId === input.explorerId) this.revisionLifecycleProjections.delete(key);
    for (const [key, projection] of this.planQueryProjections) if (planIds.has(projection.planId) || projection.sourceExplorerThreadId === input.explorerId) this.planQueryProjections.delete(key);
    for (const [key, execution] of this.hookExecutions) if (runIds.has(execution.runId)) this.hookExecutions.delete(key);
    for (const [key, verification] of this.verificationRuns) if (runIds.has(verification.runId)) this.verificationRuns.delete(key);
    for (const [key, request] of this.mergeRequests) if (runIds.has(request.runId) || planIds.has(request.planId)) this.mergeRequests.delete(key);
    for (const runId of runIds) this.runs.delete(runId);
    for (const executionThreadId of executionThreadIds) this.executionThreads.delete(executionThreadId);
    for (const call of [...this.toolCalls.values()]) if (agentLoopIds.has(call.loopId)) this.toolCalls.delete(call.callId);
    for (const loopId of agentLoopIds) {
      this.agentLoopSteps.delete(loopId);
      this.agentLoops.delete(loopId);
    }
    for (const [id, request] of this.inputRequests) if (request.threadId === input.explorerId || input.inputRequestIds.includes(id)) this.inputRequests.delete(id);
    for (const [threadId] of this.turns) if (threadId === input.explorerId) this.turns.delete(threadId);
    for (const planId of planIds) this.plans.delete(planId);
    for (const [id, plan] of this.plans) if (plan.sourceExplorerThreadId === input.explorerId) this.plans.delete(id);
    for (const [id, plan] of this.explorerPlans) if (explorerPlanIds.has(id) || plan.explorerThreadId === input.explorerId) this.explorerPlans.delete(id);
    this.threads.delete(input.explorerId);
    for (const [key, result] of this.idempotency) if (containsAnyString(result, deletedIds)) this.idempotency.delete(key);
    return { taskCount: input.explorerPlanIds.length, planCount: input.planIds.length, runCount: input.runIds.length };
  }

  getIdempotency(scope: string, key: string): Record<string, unknown> | undefined { return this.idempotency.get(`${scope}:${key}`); }
  saveIdempotency(scope: string, key: string, result: Record<string, unknown>): void { this.idempotency.set(`${scope}:${key}`, result); }
}

type SqliteRow = Record<string, unknown>;

function sqlIn(column: string, values: readonly string[]): { clause: string; values: string[] } | null {
  if (values.length === 0) return null;
  return { clause: `${column} IN (${values.map(() => "?").join(", ")})`, values: [...values] };
}

function parseRequestId(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

function normalizeSqliteError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(message)) return new Error("DATABASE_BUSY");
  return error instanceof Error ? error : new Error(message);
}

/** SQLite Store；启动时负责幂等 migration，并保留事件、快照和运行历史。 */
export class SqlitePipelineStore implements PipelineStore {
  private readonly database: DatabaseSync;
  private readonly eventListeners = new Set<(event: DomainEvent) => void>();

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS factory_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
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
        active_explorer_plan_id TEXT,
        context_summary_json TEXT,
        last_activity_at TEXT NOT NULL,
        exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE',
        exploration_missing_json TEXT NOT NULL DEFAULT '[]',
        exploration_completed_json TEXT NOT NULL DEFAULT '[]',
        exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]',
        candidate_plan_id TEXT,
        last_assessed_turn_id TEXT,
        active_revision_draft_id TEXT
      );
      CREATE TABLE IF NOT EXISTS explorer_plans (
        id TEXT PRIMARY KEY,
        explorer_thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'AUTO',
        title_status TEXT NOT NULL DEFAULT 'PLACEHOLDER',
        message_count INTEGER NOT NULL DEFAULT 0,
        latest_user_message_summary TEXT,
        exploration_status TEXT NOT NULL DEFAULT 'INCOMPLETE',
        exploration_missing_json TEXT NOT NULL DEFAULT '[]',
        exploration_completed_json TEXT NOT NULL DEFAULT '[]',
        exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]',
        candidate_plan_id TEXT,
        new_plan_requested INTEGER NOT NULL DEFAULT 0,
        last_assessed_turn_id TEXT,
        runtime_status TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        UNIQUE(explorer_thread_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS explorer_plans_thread_idx ON explorer_plans(explorer_thread_id, ordinal);
      CREATE TABLE IF NOT EXISTS explorer_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        error TEXT,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        explorer_plan_id TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
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
        dispatched_at TEXT,
        run_id TEXT,
        last_event_at TEXT NOT NULL,
        attention_reason TEXT,
        contract_json TEXT NOT NULL,
        generated_spec_json TEXT,
        resolved_contract_json TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_dispatch_states (
        plan_id TEXT PRIMARY KEY,
        revision INTEGER,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        wait_reason TEXT,
        queued_at TEXT NOT NULL,
        run_id TEXT,
        attempt INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        phase TEXT,
        automatic INTEGER NOT NULL DEFAULT 0,
        confirmed_by TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_plan_versions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        plan_json TEXT NOT NULL,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS plan_revisions (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        project_config_version INTEGER,
        project_config_hash TEXT,
        project_config_snapshot_json TEXT,
        resolved_contract_json TEXT,
        PRIMARY KEY (plan_id, revision)
      );
      CREATE TABLE IF NOT EXISTS plan_revision_drafts (
        draft_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        based_on_revision INTEGER NOT NULL,
        target_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        generated_spec_json TEXT,
        resolved_contract_json TEXT,
        source_explorer_thread_id TEXT NOT NULL,
        explorer_plan_id TEXT,
        source_turn_id TEXT,
        provider_thread_id TEXT,
        provider_turn_id TEXT,
        provider_item_id TEXT,
        base_branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        UNIQUE(plan_id, target_revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS plan_revision_drafts_active_uq
        ON plan_revision_drafts(plan_id)
        WHERE status IN ('EDITING', 'READY_TO_CONFIRM', 'BASE_CHANGED');
      CREATE TABLE IF NOT EXISTS revision_lifecycle_projection (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source_explorer_thread_id TEXT NOT NULL,
        run_id TEXT,
        last_event_at TEXT NOT NULL,
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
        journal_json TEXT NOT NULL,
        telemetry_json TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_journal (
        execution_thread_id TEXT NOT NULL REFERENCES execution_threads(id),
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (execution_thread_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS hook_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        hook_type TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        command_id TEXT,
        cwd TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE (run_id, hook_type, attempt)
      );
      CREATE TABLE IF NOT EXISTS plan_query_projection (
        plan_id TEXT PRIMARY KEY REFERENCES candidate_plans(id),
        project_id TEXT NOT NULL REFERENCES factory_projects(id),
        source_explorer_thread_id TEXT NOT NULL REFERENCES explorer_threads(id),
        source_turn_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        queued_at TEXT,
        dispatched_at TEXT,
        last_event_at TEXT NOT NULL,
        run_id TEXT,
        attention_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS plan_query_projection_project_idx ON plan_query_projection(project_id, status, queued_at, last_event_at);
      CREATE INDEX IF NOT EXISTS plan_query_projection_source_idx ON plan_query_projection(source_explorer_thread_id, queued_at, last_event_at);
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
        merged_at TEXT,
        detected_target_commit TEXT
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
        explorer_plan_id TEXT,
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
    try { this.database.exec("ALTER TABLE factory_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE factory_projects SET short_name = name WHERE short_name = ''").run();
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
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN exploration_diagnostics_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN candidate_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN last_assessed_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN active_revision_draft_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN active_explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_threads ADD COLUMN context_summary_json TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.prepare("UPDATE explorer_threads SET exploration_missing_json = ? WHERE exploration_status = 'INCOMPLETE' AND last_assessed_turn_id IS NULL AND exploration_missing_json IN ('[]', '')").run(JSON.stringify(REQUIRED_PLAN_AREAS));
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'COMPLETED'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN error TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_turns ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_input_requests ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revision_drafts ADD COLUMN explorer_plan_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN runtime_status TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE explorer_plans ADD COLUMN new_plan_requested INTEGER NOT NULL DEFAULT 0"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE explorer_turns SET status = 'FAILED', error = COALESCE(error, '历史记录未包含模型文本') WHERE role = 'assistant' AND trim(content) = '' AND status = 'COMPLETED'");
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN contract_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN generated_spec_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN resolved_contract_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN source_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN provider_item_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE candidate_plans ADD COLUMN dispatched_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN resolved_contract_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_query_projection ADD COLUMN dispatched_at TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN phase TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN confirmed_by TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_dispatch_states ADD COLUMN revision INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE merge_requests ADD COLUMN detected_target_commit TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec(`
      UPDATE candidate_plans
      SET dispatched_at = COALESCE(dispatched_at, queued_at)
      WHERE dispatched_at IS NULL
        AND queued_at IS NOT NULL
        AND status IN ('QUEUED', 'DISPATCHED', 'IN_PROGRESS', 'VERIFYING', 'MERGE_READY', 'MERGED', 'BLOCKED', 'NEEDS_PLAN_CHANGE');
      UPDATE candidate_plans
      SET status = 'DISPATCHED'
      WHERE status = 'QUEUED';
    `);
    try { this.database.exec("ALTER TABLE domain_events ADD COLUMN sequence INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE execution_threads ADD COLUMN telemetry_json TEXT"); } catch { /* Existing databases already have the column. */ }
    this.database.exec("UPDATE domain_events SET sequence = rowid WHERE sequence IS NULL");
    try { this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS domain_events_sequence_uq ON domain_events(sequence)"); } catch { /* Existing databases already have the index. */ }
    try { this.database.exec("ALTER TABLE change_proposals ADD COLUMN revision INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_version INTEGER"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_hash TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN project_config_snapshot_json TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN source_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_thread_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_turn_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provider_item_id TEXT"); } catch { /* Existing databases already have the column. */ }
    try { this.database.exec("ALTER TABLE plan_revisions ADD COLUMN provenance TEXT NOT NULL DEFAULT 'LEGACY'"); } catch { /* Existing databases already have the column. */ }
    this.repairUnconfirmedProgressedPlans();
    this.backfillExplorerPlans();
    this.backfillLegacyRevisionHistory();
    this.backfillCandidateVersions();
    this.backfillLegacyVerificationRuns();
    this.backfillPlanQueryProjection();
  }

  now(): string { return new Date().toISOString(); }

  nextId(prefix: string): string { return `${prefix}-${randomUUID().slice(0, 12)}`; }

  runInTransaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original failure. */ }
      throw normalizeSqliteError(error);
    }
  }

  saveProject(project: Project): Project {
    this.database.prepare(`
      INSERT INTO factory_projects (id, name, short_name, repo_root, default_branch, worktree_root, status, current_explorer_thread_id, config_version, config_hash, settings_json, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name, repo_root=excluded.repo_root, default_branch=excluded.default_branch, worktree_root=excluded.worktree_root, status=excluded.status, current_explorer_thread_id=excluded.current_explorer_thread_id, config_version=excluded.config_version, config_hash=excluded.config_hash, settings_json=excluded.settings_json, created_at=excluded.created_at, updated_at=excluded.updated_at, archived_at=excluded.archived_at
    `).run(project.id, project.name, project.shortName, project.repoRoot, project.defaultBranch, project.worktreeRoot, project.status, project.currentExplorerThreadId, project.configVersion, project.configHash, JSON.stringify(project.settings), project.createdAt, project.updatedAt, project.archivedAt);
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
      activeExplorerPlanId: null,
      contextSummary: defaultThreadContextSummary(this.now()),
      lastActivityAt: this.now(),
      exploration: defaultPlanExploration(),
      activeRevisionDraftId: null,
    };
    this.database.prepare(`
      INSERT INTO explorer_threads (id, project_id, title, created_at, title_source, title_status, context_mode, origin_thread_id, parent_thread_id, provider_thread_id, state, message_count, summary_ref, active_explorer_plan_id, context_summary_json, last_activity_at, exploration_status, exploration_missing_json, exploration_completed_json, exploration_diagnostics_json, candidate_plan_id, last_assessed_turn_id, active_revision_draft_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, created_at=excluded.created_at, title_source=excluded.title_source, title_status=excluded.title_status, context_mode=excluded.context_mode, origin_thread_id=excluded.origin_thread_id, parent_thread_id=excluded.parent_thread_id
    `).run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.parentThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.activeExplorerPlanId, thread.contextSummary ? JSON.stringify(thread.contextSummary) : null, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), JSON.stringify(thread.exploration.diagnostics), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId, thread.activeRevisionDraftId);
    this.ensureExplorerPlansForThread(thread.id);
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
    this.database.prepare("UPDATE explorer_threads SET title = ?, created_at = ?, title_source = ?, title_status = ?, context_mode = ?, origin_thread_id = ?, provider_thread_id = ?, state = ?, message_count = ?, summary_ref = ?, active_explorer_plan_id = ?, context_summary_json = ?, last_activity_at = ?, exploration_status = ?, exploration_missing_json = ?, exploration_completed_json = ?, exploration_diagnostics_json = ?, candidate_plan_id = ?, last_assessed_turn_id = ?, active_revision_draft_id = ? WHERE id = ?").run(thread.title, thread.createdAt, thread.titleSource, thread.titleStatus, thread.contextMode, thread.originThreadId, thread.providerThreadId, thread.state, thread.messageCount, thread.summaryRef, thread.activeExplorerPlanId, thread.contextSummary ? JSON.stringify(thread.contextSummary) : null, thread.lastActivityAt, thread.exploration.status, JSON.stringify(thread.exploration.missing), JSON.stringify(thread.exploration.completed), JSON.stringify(thread.exploration.diagnostics), thread.exploration.candidatePlanId, thread.exploration.lastAssessedTurnId, thread.activeRevisionDraftId, thread.id);
    return this.getThread(thread.id) as ExplorerThread;
  }

  saveExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    this.database.prepare(`
      INSERT INTO explorer_plans (id, explorer_thread_id, project_id, ordinal, title, title_source, title_status, message_count, latest_user_message_summary, exploration_status, exploration_missing_json, exploration_completed_json, exploration_diagnostics_json, candidate_plan_id, new_plan_requested, last_assessed_turn_id, runtime_status, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, title_source=excluded.title_source, title_status=excluded.title_status, message_count=excluded.message_count, latest_user_message_summary=excluded.latest_user_message_summary, exploration_status=excluded.exploration_status, exploration_missing_json=excluded.exploration_missing_json, exploration_completed_json=excluded.exploration_completed_json, exploration_diagnostics_json=excluded.exploration_diagnostics_json, candidate_plan_id=excluded.candidate_plan_id, new_plan_requested=excluded.new_plan_requested, last_assessed_turn_id=excluded.last_assessed_turn_id, runtime_status=excluded.runtime_status, last_activity_at=excluded.last_activity_at
    `).run(plan.id, plan.explorerThreadId, plan.projectId, plan.ordinal, plan.title, plan.titleSource, plan.titleStatus, plan.messageCount, plan.latestUserMessageSummary, plan.exploration.status, JSON.stringify(plan.exploration.missing), JSON.stringify(plan.exploration.completed), JSON.stringify(plan.exploration.diagnostics), plan.candidatePlanId, plan.newPlanRequested ? 1 : 0, plan.lastAssessedTurnId, plan.runtimeStatus ?? null, plan.createdAt, plan.lastActivityAt);
    return this.getExplorerPlan(plan.id) as ExplorerPlan;
  }

  getExplorerPlan(id: string): ExplorerPlan | undefined {
    const row = this.database.prepare("SELECT * FROM explorer_plans WHERE id = ?").get(id) as SqliteRow | undefined;
    return row ? this.explorerPlanFromRow(row) : undefined;
  }

  listExplorerPlans(threadId?: string): ExplorerPlan[] {
    const rows = this.database.prepare(`SELECT * FROM explorer_plans ${threadId ? "WHERE explorer_thread_id = ?" : ""} ORDER BY ordinal ASC, created_at ASC`).all(...(threadId ? [threadId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.explorerPlanFromRow(row));
  }

  updateExplorerPlan(plan: ExplorerPlan): ExplorerPlan {
    if (!this.getExplorerPlan(plan.id)) throw new Error(`ExplorerPlan ${plan.id} does not exist`);
    return this.saveExplorerPlan(plan);
  }

  saveTurn(turn: ExplorerTurn): ExplorerTurn {
    this.database.prepare("INSERT INTO explorer_turns (id, thread_id, role, content, status, error, created_at, sequence, explorer_plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(turn.id, turn.threadId, turn.role, turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.createdAt, turn.sequence, turn.explorerPlanId ?? null);
    return turn;
  }

  updateTurn(turn: ExplorerTurn): ExplorerTurn {
    this.database.prepare("UPDATE explorer_turns SET content = ?, status = ?, error = ? WHERE id = ?").run(turn.content, turn.status ?? "COMPLETED", turn.error ?? null, turn.id);
    return this.listTurns(turn.threadId).find((item) => item.id === turn.id) as ExplorerTurn;
  }

  listTurns(threadId: string): ExplorerTurn[] {
    const rows = this.database.prepare("SELECT * FROM explorer_turns WHERE thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    return rows.map((row) => ({ id: String(row.id), threadId: String(row.thread_id), role: String(row.role) as ExplorerTurn["role"], content: String(row.content), status: String(row.status ?? "COMPLETED") as NonNullable<ExplorerTurn["status"]>, ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), sequence: Number(row.sequence), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}) }));
  }

  saveInputRequest(request: ExplorerInputRequest): ExplorerInputRequest {
    const existing = this.database.prepare("SELECT * FROM explorer_input_requests WHERE provider_thread_id = ? AND provider_turn_id = ? AND provider_request_id = ?").get(request.providerThreadId, request.providerTurnId, String(request.providerRequestId)) as SqliteRow | undefined;
    if (existing) return this.inputRequestFromRow(existing);
    if (request.isBlocking && this.database.prepare("SELECT 1 FROM explorer_input_requests WHERE thread_id = ? AND is_blocking = 1 AND status = 'OPEN' LIMIT 1").get(request.threadId)) throw new Error(`ExplorerThread ${request.threadId} already has an open blocking input request`);
    this.database.prepare("INSERT INTO explorer_input_requests (id, thread_id, explorer_plan_id, local_turn_id, provider_request_id, provider_thread_id, provider_turn_id, item_id, questions_json, is_blocking, auto_resolution_ms, status, created_at, answered_at, answered_by, redacted_answer_summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.threadId, request.explorerPlanId ?? null, request.localTurnId, String(request.providerRequestId), request.providerThreadId, request.providerTurnId, request.itemId, JSON.stringify(request.questions), request.isBlocking ? 1 : 0, request.autoResolutionMs, request.status, request.createdAt, request.answeredAt, request.answeredBy, request.redactedAnswerSummary ? JSON.stringify(request.redactedAnswerSummary) : null);
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
      INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, explorer_plan_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, title, revision, status, created_at, confirmed_by, confirmed_at, queued_at, dispatched_at, run_id, last_event_at, attention_reason, contract_json, generated_spec_json, resolved_contract_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, explorer_plan_id=excluded.explorer_plan_id, source_turn_id=excluded.source_turn_id, provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id, provider_item_id=excluded.provider_item_id, title=excluded.title, revision=excluded.revision, status=excluded.status, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at, queued_at=excluded.queued_at, dispatched_at=excluded.dispatched_at, run_id=excluded.run_id, last_event_at=excluded.last_event_at, attention_reason=excluded.attention_reason, contract_json=excluded.contract_json, generated_spec_json=excluded.generated_spec_json, resolved_contract_json=excluded.resolved_contract_json
    `).run(plan.id, plan.projectId, plan.sourceExplorerThreadId, plan.explorerPlanId ?? null, plan.sourceTurnId, plan.providerThreadId, plan.providerTurnId, plan.providerItemId, plan.title, plan.revision, plan.status, plan.createdAt, plan.confirmedBy, plan.confirmedAt, plan.queuedAt, plan.dispatchedAt ?? null, plan.runId, plan.lastEventAt, plan.attentionReason, JSON.stringify(plan.contract), plan.generatedSpec ? JSON.stringify(plan.generatedSpec) : null, plan.resolvedContract ? JSON.stringify(plan.resolvedContract) : null);
    if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
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

  saveCandidateVersion(plan: CandidatePlan): CandidatePlan {
    this.database.prepare("INSERT OR IGNORE INTO candidate_plan_versions (plan_id, revision, plan_json) VALUES (?, ?, ?)").run(plan.id, plan.revision, JSON.stringify(plan));
    return this.listCandidateVersions(plan.id).find((item) => item.revision === plan.revision)!;
  }

  listCandidateVersions(planId: string): CandidatePlan[] {
    const rows = this.database.prepare("SELECT plan_json FROM candidate_plan_versions WHERE plan_id = ? ORDER BY revision ASC").all(planId) as unknown as SqliteRow[];
    return rows.map((row) => JSON.parse(String(row.plan_json)) as CandidatePlan);
  }

  saveDispatchState(state: PlanDispatchState): PlanDispatchState {
    this.database.prepare(`
      INSERT INTO plan_dispatch_states (plan_id, revision, project_id, status, wait_reason, queued_at, run_id, attempt, updated_at, last_error, phase, automatic, confirmed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET revision=excluded.revision, project_id=excluded.project_id, status=excluded.status, wait_reason=excluded.wait_reason, queued_at=excluded.queued_at, run_id=excluded.run_id, attempt=excluded.attempt, updated_at=excluded.updated_at, last_error=excluded.last_error, phase=excluded.phase, automatic=excluded.automatic, confirmed_by=excluded.confirmed_by
    `).run(state.planId, state.revision ?? null, state.projectId, state.status, state.waitReason, state.queuedAt, state.runId, state.attempt, state.updatedAt, state.lastError, state.phase ?? null, state.automatic ? 1 : 0, state.confirmedBy ?? null);
    return this.getDispatchState(state.planId) as PlanDispatchState;
  }

  deleteDispatchState(planId: string): void {
    this.database.prepare("DELETE FROM plan_dispatch_states WHERE plan_id = ?").run(planId);
  }

  getDispatchState(planId: string): PlanDispatchState | undefined {
    const row = this.database.prepare("SELECT * FROM plan_dispatch_states WHERE plan_id = ?").get(planId) as SqliteRow | undefined;
    return row ? this.dispatchStateFromRow(row) : undefined;
  }

  listDispatchStates(projectId?: string): PlanDispatchState[] {
    const rows = this.database.prepare(`SELECT * FROM plan_dispatch_states ${projectId ? "WHERE project_id = ?" : ""} ORDER BY queued_at ASC, plan_id ASC`).all(...(projectId ? [projectId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.dispatchStateFromRow(row));
  }

  saveRevision(revision: PlanRevisionV2): PlanRevisionV2 {
    this.database.prepare("INSERT OR IGNORE INTO plan_revisions (plan_id, revision, contract_json, artifact_hash, confirmed_by, confirmed_at, source_explorer_thread_id, explorer_plan_id, project_config_version, project_config_hash, project_config_snapshot_json, resolved_contract_json, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(revision.planId, revision.revision, JSON.stringify(revision.contract), revision.artifactHash, revision.confirmedBy, revision.confirmedAt, revision.sourceExplorerThreadId, revision.explorerPlanId ?? null, revision.projectConfigVersion ?? null, revision.projectConfigHash ?? null, revision.projectConfigSnapshot ? JSON.stringify(revision.projectConfigSnapshot) : null, revision.resolvedContract ? JSON.stringify(revision.resolvedContract) : null, revision.sourceTurnId ?? null, revision.providerThreadId ?? null, revision.providerTurnId ?? null, revision.providerItemId ?? null, revision.provenance ?? "CURRENT");
    return this.getRevision(revision.planId, revision.revision) as PlanRevisionV2;
  }

  getRevision(planId: string, revision: number): PlanRevisionV2 | undefined {
    const row = this.database.prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?").get(planId, revision) as SqliteRow | undefined;
    if (!row) return undefined;
    return freezeRevision({ planId: String(row.plan_id), revision: Number(row.revision), contract: JSON.parse(String(row.contract_json)) as PlanContract, ...(row.resolved_contract_json ? { resolvedContract: JSON.parse(String(row.resolved_contract_json)) as ResolvedPlanContractV2 } : {}), artifactHash: String(row.artifact_hash), confirmedBy: String(row.confirmed_by), confirmedAt: String(row.confirmed_at), sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id === null || row.explorer_plan_id === undefined ? {} : { explorerPlanId: String(row.explorer_plan_id) }), sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null || row.provider_turn_id === undefined ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null || row.provider_item_id === undefined ? null : String(row.provider_item_id), provenance: row.provenance === "CURRENT" ? "CURRENT" : "LEGACY", ...(row.project_config_version === null || row.project_config_version === undefined ? {} : { projectConfigVersion: Number(row.project_config_version) }), ...(row.project_config_hash === null || row.project_config_hash === undefined ? {} : { projectConfigHash: String(row.project_config_hash) }), ...(row.project_config_snapshot_json === null || row.project_config_snapshot_json === undefined ? {} : { projectConfigSnapshot: JSON.parse(String(row.project_config_snapshot_json)) as ProjectExecutionSnapshot }) });
  }

  listRevisions(planId: string): PlanRevisionV2[] {
    const rows = this.database.prepare("SELECT revision FROM plan_revisions WHERE plan_id = ? ORDER BY revision ASC").all(planId) as unknown as SqliteRow[];
    return rows.map((row) => this.getRevision(planId, Number(row.revision))!).filter(Boolean);
  }

  saveRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    this.database.prepare("INSERT INTO plan_revision_drafts (draft_id, plan_id, project_id, based_on_revision, target_revision, status, title, contract_json, generated_spec_json, resolved_contract_json, source_explorer_thread_id, explorer_plan_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, base_branch, base_commit, created_at, updated_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(draft.draftId, draft.planId, draft.projectId, draft.basedOnRevision, draft.targetRevision, draft.status, draft.title, JSON.stringify(draft.contract), draft.generatedSpec ? JSON.stringify(draft.generatedSpec) : null, draft.resolvedContract ? JSON.stringify(draft.resolvedContract) : null, draft.sourceExplorerThreadId, draft.explorerPlanId ?? null, draft.sourceTurnId, draft.providerThreadId, draft.providerTurnId, draft.providerItemId, draft.baseBranch, draft.baseCommit, draft.createdAt, draft.updatedAt, draft.confirmedAt);
    return this.getRevisionDraft(draft.draftId)!;
  }
  getRevisionDraft(draftId: string): PlanRevisionDraft | undefined {
    const row = this.database.prepare("SELECT * FROM plan_revision_drafts WHERE draft_id = ?").get(draftId) as SqliteRow | undefined;
    return row ? this.revisionDraftFromRow(row) : undefined;
  }
  listRevisionDrafts(planId?: string): PlanRevisionDraft[] {
    const rows = this.database.prepare(`SELECT * FROM plan_revision_drafts ${planId ? "WHERE plan_id = ?" : ""} ORDER BY target_revision ASC, created_at ASC`).all(...(planId ? [planId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.revisionDraftFromRow(row));
  }
  updateRevisionDraft(draft: PlanRevisionDraft): PlanRevisionDraft {
    this.database.prepare("UPDATE plan_revision_drafts SET status = ?, title = ?, contract_json = ?, generated_spec_json = ?, resolved_contract_json = ?, source_explorer_thread_id = ?, explorer_plan_id = ?, source_turn_id = ?, provider_thread_id = ?, provider_turn_id = ?, provider_item_id = ?, base_branch = ?, base_commit = ?, updated_at = ?, confirmed_at = ? WHERE draft_id = ?").run(draft.status, draft.title, JSON.stringify(draft.contract), draft.generatedSpec ? JSON.stringify(draft.generatedSpec) : null, draft.resolvedContract ? JSON.stringify(draft.resolvedContract) : null, draft.sourceExplorerThreadId, draft.explorerPlanId ?? null, draft.sourceTurnId, draft.providerThreadId, draft.providerTurnId, draft.providerItemId, draft.baseBranch, draft.baseCommit, draft.updatedAt, draft.confirmedAt, draft.draftId);
    return this.getRevisionDraft(draft.draftId)!;
  }
  saveRevisionLifecycleProjection(projection: RevisionLifecycleProjection): RevisionLifecycleProjection {
    this.database.prepare("INSERT INTO revision_lifecycle_projection (plan_id, revision, project_id, title, status, source_explorer_thread_id, run_id, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id, revision) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, status=excluded.status, source_explorer_thread_id=excluded.source_explorer_thread_id, run_id=excluded.run_id, last_event_at=excluded.last_event_at").run(projection.planId, projection.revision, projection.projectId, projection.title, projection.status, projection.sourceExplorerThreadId, projection.runId, projection.lastEventAt);
    return projection;
  }
  listRevisionLifecycleProjections(projectId?: string, planId?: string): RevisionLifecycleProjection[] {
    const clauses = [projectId ? "project_id = ?" : "", planId ? "plan_id = ?" : ""].filter(Boolean);
    const values = [projectId, planId].filter((value): value is string => Boolean(value));
    const rows = this.database.prepare(`SELECT * FROM revision_lifecycle_projection ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY plan_id ASC, revision ASC`).all(...values) as unknown as SqliteRow[];
    return rows.map((row) => ({ planId: String(row.plan_id), revision: Number(row.revision), projectId: String(row.project_id), title: String(row.title), status: String(row.status) as RevisionLifecycleProjection["status"], sourceExplorerThreadId: String(row.source_explorer_thread_id), runId: row.run_id === null ? null : String(row.run_id), lastEventAt: String(row.last_event_at) }));
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
    const safe = { ...thread, journal: thread.journal.map((entry) => ({ ...entry, payload: redactAuditPayload(entry.payload) })) };
    this.database.prepare("INSERT INTO execution_threads (id, run_id, state, journal_json, telemetry_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, journal_json=excluded.journal_json, telemetry_json=excluded.telemetry_json").run(safe.id, safe.runId, safe.state, JSON.stringify(safe.journal), safe.telemetry ? JSON.stringify(safe.telemetry) : null);
    for (const entry of safe.journal) {
      this.database.prepare("INSERT OR IGNORE INTO execution_journal (execution_thread_id, run_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(safe.id, safe.runId, entry.sequence, entry.type, entry.occurredAt, JSON.stringify(entry.payload));
    }
    return this.getExecutionThread(safe.id) as ExecutionThread;
  }

  appendExecutionJournal(input: { executionThreadId: string; runId: string; type: JournalEntryType; payload: Record<string, unknown>; occurredAt?: string }): ExecutionJournalEntry {
    const thread = this.getExecutionThread(input.executionThreadId);
    if (!thread || thread.runId !== input.runId) throw new Error(`ExecutionThread ${input.executionThreadId} does not belong to Run ${input.runId}`);
    const sequence = Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM execution_journal WHERE run_id = ?").get(input.runId) as SqliteRow).next_sequence);
    const entry: ExecutionJournalEntry = { sequence, type: input.type, occurredAt: input.occurredAt ?? this.now(), payload: redactAuditPayload(input.payload) };
    this.database.prepare("INSERT INTO execution_journal (execution_thread_id, run_id, sequence, type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(input.executionThreadId, input.runId, entry.sequence, entry.type, entry.occurredAt, JSON.stringify(entry.payload));
    return entry;
  }

  saveHookExecution(execution: HookExecution): HookExecution {
    const safe = { ...execution, stdout: redactAuditText(execution.stdout), stderr: redactAuditText(execution.stderr) };
    this.database.prepare("INSERT OR IGNORE INTO hook_executions (id, run_id, hook_type, attempt, command_id, cwd, timeout_ms, status, exit_code, stdout, stderr, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(safe.id, safe.runId, safe.hookType, safe.attempt, safe.commandId, safe.cwd, safe.timeoutMs, safe.status, safe.exitCode, safe.stdout, safe.stderr, safe.startedAt, safe.completedAt);
    return this.getHookExecution(safe.runId, safe.hookType, safe.attempt) as HookExecution;
  }

  getHookExecution(runId: string, hookType: HookExecution["hookType"], attempt: number): HookExecution | undefined {
    const row = this.database.prepare("SELECT * FROM hook_executions WHERE run_id = ? AND hook_type = ? AND attempt = ?").get(runId, hookType, attempt) as SqliteRow | undefined;
    return row ? this.hookExecutionFromRow(row) : undefined;
  }

  listHookExecutions(runId?: string): HookExecution[] {
    const rows = this.database.prepare(`SELECT * FROM hook_executions ${runId ? "WHERE run_id = ?" : ""} ORDER BY started_at ASC, attempt ASC`).all(...(runId ? [runId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.hookExecutionFromRow(row));
  }

  savePlanQueryProjection(projection: PlanQueryProjection): PlanQueryProjection {
    this.database.prepare("INSERT INTO plan_query_projection (plan_id, project_id, source_explorer_thread_id, source_turn_id, title, goal, revision, status, priority, created_at, queued_at, dispatched_at, last_event_at, run_id, attention_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id) DO UPDATE SET project_id=excluded.project_id, source_explorer_thread_id=excluded.source_explorer_thread_id, source_turn_id=excluded.source_turn_id, title=excluded.title, goal=excluded.goal, revision=excluded.revision, status=excluded.status, priority=excluded.priority, created_at=excluded.created_at, queued_at=excluded.queued_at, dispatched_at=excluded.dispatched_at, last_event_at=excluded.last_event_at, run_id=excluded.run_id, attention_reason=excluded.attention_reason").run(projection.planId, projection.projectId, projection.sourceExplorerThreadId, projection.sourceTurnId, projection.title, projection.goal, projection.revision, projection.status, projection.priority, projection.createdAt, projection.queuedAt, projection.dispatchedAt ?? null, projection.lastEventAt, projection.runId, projection.attentionReason);
    return this.getPlanQueryProjection(projection.planId) as PlanQueryProjection;
  }

  getPlanQueryProjection(planId: string): PlanQueryProjection | undefined {
    const row = this.database.prepare("SELECT * FROM plan_query_projection WHERE plan_id = ?").get(planId) as SqliteRow | undefined;
    return row ? this.planQueryProjectionFromRow(row) : undefined;
  }

  listPlanQueryProjection(projectId?: string): PlanQueryProjection[] {
    const rows = this.database.prepare(`SELECT * FROM plan_query_projection ${projectId ? "WHERE project_id = ?" : ""} ORDER BY created_at ASC, plan_id ASC`).all(...(projectId ? [projectId] : [])) as unknown as SqliteRow[];
    return rows.map((row) => this.planQueryProjectionFromRow(row));
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

  private backfillLegacyVerificationRuns(): void {
    const insert = this.database.prepare("INSERT OR IGNORE INTO verification_runs (id, run_id, status, repair_attempts, command_results_json, completed_at) VALUES (?, ?, ?, ?, ?, ?)");
    const rows = this.database.prepare("SELECT journal_json FROM execution_threads").all() as unknown as SqliteRow[];
    for (const row of rows) {
      let journal: unknown;
      try { journal = JSON.parse(String(row.journal_json)); } catch { continue; }
      if (!Array.isArray(journal)) continue;
      for (const entry of journal) {
        if (!isRecord(entry) || entry.type !== "VERIFICATION" || !isVerificationRun(entry.payload)) continue;
        const verification = entry.payload;
        insert.run(verification.id, verification.runId, verification.status, verification.repairAttempts, JSON.stringify(verification.commandResults), verification.completedAt);
      }
    }
  }

  saveMergeRequest(request: MergeRequest): MergeRequest {
    this.database.prepare("INSERT OR IGNORE INTO merge_requests (id, run_id, plan_id, source_commit, target_branch, status, human_confirmation_required, created_at, merged_at, detected_target_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(request.id, request.runId, request.planId, request.sourceCommit, request.targetBranch, request.status, request.humanConfirmationRequired ? 1 : 0, request.createdAt, request.mergedAt, request.detectedTargetCommit ?? null);
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
    this.database.prepare("UPDATE merge_requests SET status = ?, merged_at = ?, detected_target_commit = ? WHERE id = ?").run(request.status, request.mergedAt, request.detectedTargetCommit ?? null, request.id);
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
    if (!row) return undefined;
    const journalRows = this.database.prepare("SELECT sequence, type, occurred_at, payload_json FROM execution_journal WHERE execution_thread_id = ? ORDER BY sequence ASC").all(threadId) as unknown as SqliteRow[];
    const journal = journalRows.length > 0
      ? journalRows.map((entry) => ({ sequence: Number(entry.sequence), type: String(entry.type) as JournalEntryType, occurredAt: String(entry.occurred_at), payload: JSON.parse(String(entry.payload_json)) as Record<string, unknown> }))
      : JSON.parse(String(row.journal_json)) as ExecutionJournalEntry[];
    const telemetry = typeof row.telemetry_json === "string" && row.telemetry_json.length > 0 ? JSON.parse(row.telemetry_json) as ExecutionTelemetry : null;
    return { id: String(row.id), runId: String(row.run_id), state: String(row.state) as ExecutionThreadState, journal, telemetry };
  }

  appendEvent(event: Omit<DomainEvent, "id" | "occurredAt" | "sequence">): DomainEvent {
    const saved: DomainEvent = { ...event, payload: redactAuditPayload(event.payload), id: this.nextId("event"), sequence: Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM domain_events").get() as SqliteRow).next_sequence), occurredAt: this.now() };
    this.database.prepare("INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run(saved.id, saved.sequence, saved.type, saved.aggregateId, saved.occurredAt, JSON.stringify(saved.payload));
    for (const listener of this.eventListeners) listener(saved);
    return saved;
  }

  subscribeEvents(listener: (event: DomainEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
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

  deleteExplorerCascade(input: ExplorerDeletionInput): ExplorerDeletionSummary {
    const project = this.getProject(input.projectId);
    const replacement = this.getThread(input.replacementExplorerId);
    if (!project || !replacement || replacement.projectId !== input.projectId || replacement.id === input.explorerId) throw new Error("Explorer deletion replacement is invalid");
    if (project.currentExplorerThreadId === input.explorerId) this.database.prepare("UPDATE factory_projects SET current_explorer_thread_id = ?, updated_at = ? WHERE id = ?").run(replacement.id, this.now(), input.projectId);

    const explorerPlanIds = sqlIn("id", input.explorerPlanIds);
    const planIds = sqlIn("plan_id", input.planIds);
    const planEntityIds = sqlIn("id", input.planIds);
    const runIds = sqlIn("run_id", input.runIds);
    const runEntityIds = sqlIn("id", input.runIds);
    const loopIds = sqlIn("loop_id", input.agentLoopIds);
    const loopEntityIds = sqlIn("id", input.agentLoopIds);
    const executionThreadEntityIds = sqlIn("id", input.executionThreadIds);

    if (runIds) {
      this.database.prepare(`DELETE FROM execution_journal WHERE ${runIds.clause}`).run(...runIds.values);
      this.database.prepare(`DELETE FROM hook_executions WHERE ${runIds.clause}`).run(...runIds.values);
      this.database.prepare(`DELETE FROM verification_runs WHERE ${runIds.clause}`).run(...runIds.values);
      this.database.prepare(`DELETE FROM merge_requests WHERE ${runIds.clause}`).run(...runIds.values);
    }
    if (loopIds) {
      this.database.prepare(`DELETE FROM agent_loop_steps WHERE ${loopIds.clause}`).run(...loopIds.values);
      this.database.prepare(`DELETE FROM tool_calls WHERE ${loopIds.clause}`).run(...loopIds.values);
      if (loopEntityIds) this.database.prepare(`DELETE FROM agent_loops WHERE ${loopEntityIds.clause}`).run(...loopEntityIds.values);
    }
    if (executionThreadEntityIds) this.database.prepare(`DELETE FROM execution_threads WHERE ${executionThreadEntityIds.clause}`).run(...executionThreadEntityIds.values);
    if (runEntityIds) this.database.prepare(`DELETE FROM runs WHERE ${runEntityIds.clause}`).run(...runEntityIds.values);
    if (planIds) {
      this.database.prepare(`DELETE FROM change_proposals WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM plan_dispatch_states WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM plan_revisions WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM plan_revision_drafts WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM candidate_plan_versions WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM revision_lifecycle_projection WHERE ${planIds.clause}`).run(...planIds.values);
      this.database.prepare(`DELETE FROM plan_query_projection WHERE ${planIds.clause}`).run(...planIds.values);
      if (planEntityIds) this.database.prepare(`DELETE FROM candidate_plans WHERE ${planEntityIds.clause}`).run(...planEntityIds.values);
    }
    if (explorerPlanIds) this.database.prepare(`DELETE FROM explorer_plans WHERE ${explorerPlanIds.clause}`).run(...explorerPlanIds.values);
    const inputRequestIds = sqlIn("id", input.inputRequestIds);
    if (inputRequestIds) this.database.prepare(`DELETE FROM explorer_input_requests WHERE thread_id = ? OR ${inputRequestIds.clause}`).run(input.explorerId, ...inputRequestIds.values);
    else this.database.prepare("DELETE FROM explorer_input_requests WHERE thread_id = ?").run(input.explorerId);
    this.database.prepare("DELETE FROM explorer_turns WHERE thread_id = ?").run(input.explorerId);

    const deletedIds = new Set([input.explorerId, ...input.explorerPlanIds, ...input.turnIds, ...input.planIds, ...input.runIds, ...input.executionThreadIds, ...input.agentLoopIds, ...input.inputRequestIds]);
    const idempotencyRows = this.database.prepare("SELECT scope, key, result_json FROM idempotency_keys").all() as unknown as SqliteRow[];
    for (const row of idempotencyRows) {
      let result: unknown;
      try { result = JSON.parse(String(row.result_json)); } catch { continue; }
      if (containsAnyString(result, deletedIds)) this.database.prepare("DELETE FROM idempotency_keys WHERE scope = ? AND key = ?").run(String(row.scope), String(row.key));
    }
    this.database.prepare("DELETE FROM explorer_threads WHERE id = ? AND project_id = ?").run(input.explorerId, input.projectId);
    return { taskCount: input.explorerPlanIds.length, planCount: input.planIds.length, runCount: input.runIds.length };
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
      shortName: String(row.short_name ?? row.name),
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
    const lastActivityAt = String(row.last_activity_at);
    return {
      id: String(row.id), projectId: String(row.project_id), title: String(row.title ?? "New Explorer"), createdAt: String(row.created_at ?? lastActivityAt),
      titleSource: String(row.title_source ?? "AUTO") as ExplorerTitleSource, titleStatus: String(row.title_status ?? "PLACEHOLDER") as ExplorerTitleStatus,
      contextMode: String(row.context_mode ?? "FRESH") as ExplorerThread["contextMode"],
      originThreadId: row.origin_thread_id === null || row.origin_thread_id === undefined ? null : String(row.origin_thread_id),
      parentThreadId: row.parent_thread_id === null ? null : String(row.parent_thread_id),
      providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id),
      state: String(row.state) as ExplorerThreadState, messageCount: Number(row.message_count),
      summaryRef: row.summary_ref === null ? null : String(row.summary_ref),
      activeExplorerPlanId: row.active_explorer_plan_id === null || row.active_explorer_plan_id === undefined ? null : String(row.active_explorer_plan_id),
      contextSummary: parseThreadContextSummary(row.context_summary_json, lastActivityAt), lastActivityAt,
      exploration: { status: String(row.exploration_status ?? "INCOMPLETE") as PlanExplorationStatus, missing: parseStringArray(row.exploration_missing_json, [...REQUIRED_PLAN_AREAS]), completed: parseStringArray(row.exploration_completed_json, []), diagnostics: parsePlanValidationIssues(row.exploration_diagnostics_json), candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id) },
      activeRevisionDraftId: row.active_revision_draft_id === null || row.active_revision_draft_id === undefined ? null : String(row.active_revision_draft_id),
    };
  }

  private explorerPlanFromRow(row: SqliteRow): ExplorerPlan {
    return {
      id: String(row.id), explorerThreadId: String(row.explorer_thread_id), projectId: String(row.project_id), ordinal: Number(row.ordinal),
      title: String(row.title), titleSource: String(row.title_source ?? "AUTO") as ExplorerTitleSource, titleStatus: String(row.title_status ?? "PLACEHOLDER") as ExplorerTitleStatus,
      messageCount: Number(row.message_count ?? 0), latestUserMessageSummary: row.latest_user_message_summary === null || row.latest_user_message_summary === undefined ? null : String(row.latest_user_message_summary),
      exploration: { status: String(row.exploration_status ?? "INCOMPLETE") as PlanExplorationStatus, missing: parseStringArray(row.exploration_missing_json, [...REQUIRED_PLAN_AREAS]), completed: parseStringArray(row.exploration_completed_json, []), diagnostics: parsePlanValidationIssues(row.exploration_diagnostics_json), candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id) },
      newPlanRequested: Number(row.new_plan_requested ?? 0) === 1,
      candidatePlanId: row.candidate_plan_id === null || row.candidate_plan_id === undefined ? null : String(row.candidate_plan_id), lastAssessedTurnId: row.last_assessed_turn_id === null || row.last_assessed_turn_id === undefined ? null : String(row.last_assessed_turn_id), ...(row.runtime_status === null || row.runtime_status === undefined ? {} : { runtimeStatus: String(row.runtime_status) as NonNullable<ExplorerTurn["status"]> }), createdAt: String(row.created_at), lastActivityAt: String(row.last_activity_at),
    };
  }

  private inputRequestFromRow(row: SqliteRow): ExplorerInputRequest {
    return {
      id: String(row.id), threadId: String(row.thread_id), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}), localTurnId: String(row.local_turn_id),
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

  private hookExecutionFromRow(row: SqliteRow): HookExecution {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      hookType: String(row.hook_type) as HookExecution["hookType"],
      attempt: Number(row.attempt),
      commandId: row.command_id === null || row.command_id === undefined ? null : String(row.command_id),
      cwd: String(row.cwd),
      timeoutMs: Number(row.timeout_ms),
      status: String(row.status) as HookExecution["status"],
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      stdout: String(row.stdout),
      stderr: String(row.stderr),
      startedAt: String(row.started_at),
      completedAt: String(row.completed_at),
    };
  }

  private planQueryProjectionFromRow(row: SqliteRow): PlanQueryProjection {
    return {
      planId: String(row.plan_id),
      projectId: String(row.project_id),
      sourceExplorerThreadId: String(row.source_explorer_thread_id),
      sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id),
      title: String(row.title),
      goal: String(row.goal),
      revision: Number(row.revision),
      status: String(row.status) as PlanStatus,
      priority: Number(row.priority),
      createdAt: String(row.created_at),
      queuedAt: row.queued_at === null || row.queued_at === undefined ? null : String(row.queued_at),
      dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined ? null : String(row.dispatched_at),
      lastEventAt: String(row.last_event_at),
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      attentionReason: row.attention_reason === null || row.attention_reason === undefined ? null : String(row.attention_reason),
    };
  }

  private revisionDraftFromRow(row: SqliteRow): PlanRevisionDraft {
    return Object.freeze({
      draftId: String(row.draft_id), planId: String(row.plan_id), projectId: String(row.project_id), basedOnRevision: Number(row.based_on_revision), targetRevision: Number(row.target_revision), status: String(row.status) as PlanRevisionDraftStatus,
      title: String(row.title), contract: JSON.parse(String(row.contract_json)) as PlanContract,
      ...(row.generated_spec_json ? { generatedSpec: JSON.parse(String(row.generated_spec_json)) as GeneratedPlanSpecV2 } : {}),
      ...(row.resolved_contract_json ? { resolvedContract: JSON.parse(String(row.resolved_contract_json)) as ResolvedPlanContractV2 } : {}),
      sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id === null || row.explorer_plan_id === undefined ? {} : { explorerPlanId: String(row.explorer_plan_id) }), sourceTurnId: row.source_turn_id === null ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null ? null : String(row.provider_item_id),
      baseBranch: String(row.base_branch), baseCommit: String(row.base_commit), createdAt: String(row.created_at), updatedAt: String(row.updated_at), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    });
  }

  /** 为新旧线程确保至少存在一个 Plan，并把历史事实归入默认 Plan。 */
  private ensureExplorerPlansForThread(threadId: string): void {
    const thread = this.getThread(threadId);
    if (!thread) return;
    let plans = this.listExplorerPlans(threadId);
    if (plans.length === 0) {
      const plan = defaultExplorerPlan(thread, this.nextId("explorer-plan"), 1, thread.lastActivityAt);
      this.saveExplorerPlan(plan);
      plans = [plan];
    }
    const activePlan = plans.find((plan) => plan.id === thread.activeExplorerPlanId) ?? plans[0];
    if (!activePlan) return;
    for (const turn of this.listTurns(threadId)) {
      if (!turn.explorerPlanId) this.database.prepare("UPDATE explorer_turns SET explorer_plan_id = ? WHERE id = ?").run(activePlan.id, turn.id);
    }
    for (const plan of this.listPlans().filter((item) => item.sourceExplorerThreadId === threadId)) {
      if (plan.explorerPlanId) continue;
      const owner = plan.sourceTurnId ? this.listTurns(threadId).find((turn) => turn.id === plan.sourceTurnId) : undefined;
      this.database.prepare("UPDATE candidate_plans SET explorer_plan_id = ? WHERE id = ?").run(owner?.explorerPlanId ?? activePlan.id, plan.id);
    }
    for (const request of this.listInputRequests(threadId)) {
      if (!request.explorerPlanId) this.database.prepare("UPDATE explorer_input_requests SET explorer_plan_id = ? WHERE id = ?").run(activePlan.id, request.id);
    }
    const current = this.getThread(threadId)!;
    const associatedPlans = this.listPlans().filter((plan) => plan.sourceExplorerThreadId === threadId);
    for (const plan of plans) {
      const planTurns = this.listTurns(threadId).filter((turn) => turn.explorerPlanId === plan.id);
      const latestUser = [...planTurns].reverse().find((turn) => turn.role === "user");
      const latestAssistant = [...planTurns].reverse().find((turn) => turn.role === "assistant");
      const associatedCandidate = associatedPlans.filter((item) => item.explorerPlanId === plan.id && item.status === "DRAFT").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const legacyProjection = plans.length === 1 && plan.id === activePlan.id && planTurns.length > 0 ? current.exploration : plan.exploration;
      const selectedCandidateId = plan.newPlanRequested ? null : plan.candidatePlanId ?? associatedCandidate?.id ?? legacyProjection.candidatePlanId;
      this.saveExplorerPlan({
        ...plan,
        messageCount: planTurns.length || plan.messageCount,
        latestUserMessageSummary: latestUser ? summarizeExplorerMessage(latestUser.content) : plan.latestUserMessageSummary,
        exploration: { ...legacyProjection, candidatePlanId: selectedCandidateId },
        candidatePlanId: selectedCandidateId,
        newPlanRequested: Boolean(plan.newPlanRequested),
        lastAssessedTurnId: legacyProjection.lastAssessedTurnId ?? plan.lastAssessedTurnId,
        ...(latestAssistant?.status ? { runtimeStatus: latestAssistant.status } : {}),
      });
    }
    const refreshedPlans = this.listExplorerPlans(threadId);
    const contextSummary = current.contextSummary ?? defaultThreadContextSummary(current.lastActivityAt);
    const completedPlans = refreshedPlans.filter((plan) => plan.exploration.status === "READY").map((plan) => {
      const candidate = plan.candidatePlanId ? this.getPlan(plan.candidatePlanId) : undefined;
      return { explorerPlanId: plan.id, title: plan.title, status: plan.exploration.status, goal: candidate?.contract.goal ?? null, keyConstraints: [...(candidate?.generatedSpec?.design?.technicalConstraints ?? [])], latestUserMessageSummary: plan.latestUserMessageSummary };
    });
    const updatedSummary = { ...contextSummary, completedPlans, openPlanIds: refreshedPlans.filter((plan) => plan.exploration.status !== "READY").map((plan) => plan.id) };
    this.database.prepare("UPDATE explorer_threads SET active_explorer_plan_id = ?, context_summary_json = ? WHERE id = ?").run(activePlan.id, JSON.stringify(updatedSummary), threadId);
  }

  private backfillExplorerPlans(): void {
    for (const thread of this.listThreads()) this.ensureExplorerPlansForThread(thread.id);
  }

  /**
   * 旧版本可能只保存了 queued/dispatched 事实，没有保存确认事实。
   * 这类记录不能继续被当作可执行 Plan，保留历史时间但转入 BLOCKED，等待重新确认。
   */
  private repairUnconfirmedProgressedPlans(): void {
    const rows = this.database.prepare("SELECT * FROM candidate_plans WHERE confirmed_at IS NULL AND status IN (?, ?, ?, ?, ?, ?, ?, ?)").all("READY", "QUEUED", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED") as unknown as SqliteRow[];
    const hasConfirmationEvent = this.database.prepare("SELECT 1 AS present FROM domain_events WHERE aggregate_id = ? AND type IN (?, ?, ?) LIMIT 1");
    for (const row of rows) {
      const planId = String(row.id);
      if (hasConfirmationEvent.get(planId, "plan.confirmed", "plan.revision.confirmed", "plan.configuration.revised")) continue;
      const plan = this.planFromRow(row);
      const reason = "Plan lifecycle is invalid: it reached a later state without a confirmation record.";
      const repairedAt = this.now();
      updatePlanStatus(this, plan, { status: "BLOCKED", attentionReason: reason, lastEventAt: repairedAt }, reason);
    }
  }

  private backfillPlanQueryProjection(): void {
    for (const plan of this.listPlans()) {
      if (this.getProject(plan.projectId) && this.getThread(plan.sourceExplorerThreadId)) this.savePlanQueryProjection(planQueryProjectionFor(plan));
    }
  }

  /** 历史未确认内容被覆盖时只剩当前快照；保留它为可查看版本，不伪造丢失的旧内容。 */
  private backfillCandidateVersions(): void {
    for (const plan of this.listPlans()) {
      if (plan.status === "DRAFT") this.saveCandidateVersion(plan);
    }
  }

  /** 将旧 candidate 聚合回填为只读 Revision；缺少当时快照的一律标记 LEGACY。 */
  private backfillLegacyRevisionHistory(): void {
    const insertRevision = this.database.prepare("INSERT OR IGNORE INTO plan_revisions (plan_id, revision, contract_json, artifact_hash, confirmed_by, confirmed_at, source_explorer_thread_id, source_turn_id, provider_thread_id, provider_turn_id, provider_item_id, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LEGACY')");
    const insertProjection = this.database.prepare("INSERT OR IGNORE INTO revision_lifecycle_projection (plan_id, revision, project_id, title, status, source_explorer_thread_id, run_id, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const plan of this.listPlans()) {
      if (!["READY", "ENQUEUED", "DISPATCHED", "QUEUED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED", "BLOCKED", "NEEDS_PLAN_CHANGE"].includes(plan.status)) continue;
      const confirmedAt = plan.confirmedAt ?? plan.createdAt;
      const artifactHash = `sha256:${createHash("sha256").update(JSON.stringify(plan.contract)).digest("hex")}`;
      insertRevision.run(plan.id, plan.revision, JSON.stringify(plan.contract), artifactHash, plan.confirmedBy ?? "legacy", confirmedAt, plan.sourceExplorerThreadId, plan.sourceTurnId, plan.providerThreadId, plan.providerTurnId, plan.providerItemId);
      insertProjection.run(plan.id, plan.revision, plan.projectId, plan.title, "LEGACY", plan.sourceExplorerThreadId, plan.runId, plan.lastEventAt);
    }
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
      ...(row.detected_target_commit === null || row.detected_target_commit === undefined ? {} : { detectedTargetCommit: String(row.detected_target_commit) }),
    };
  }

  private planFromRow(row: SqliteRow): CandidatePlan {
    return { id: String(row.id), projectId: String(row.project_id), sourceExplorerThreadId: String(row.source_explorer_thread_id), ...(row.explorer_plan_id ? { explorerPlanId: String(row.explorer_plan_id) } : {}), sourceTurnId: row.source_turn_id === null || row.source_turn_id === undefined ? null : String(row.source_turn_id), providerThreadId: row.provider_thread_id === null || row.provider_thread_id === undefined ? null : String(row.provider_thread_id), providerTurnId: row.provider_turn_id === null || row.provider_turn_id === undefined ? null : String(row.provider_turn_id), providerItemId: row.provider_item_id === null || row.provider_item_id === undefined ? null : String(row.provider_item_id), title: String(row.title), revision: Number(row.revision), status: String(row.status) as PlanStatus, createdAt: String(row.created_at), confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by), confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at), queuedAt: row.queued_at === null ? null : String(row.queued_at), dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined ? null : String(row.dispatched_at), runId: row.run_id === null ? null : String(row.run_id), lastEventAt: String(row.last_event_at), attentionReason: row.attention_reason === null ? null : String(row.attention_reason), contract: JSON.parse(String(row.contract_json ?? "{}")) as PlanContract, ...(row.generated_spec_json ? { generatedSpec: JSON.parse(String(row.generated_spec_json)) as GeneratedPlanSpecV2 } : {}), ...(row.resolved_contract_json ? { resolvedContract: JSON.parse(String(row.resolved_contract_json)) as ResolvedPlanContractV2 } : {}) };
  }

  private dispatchStateFromRow(row: SqliteRow): PlanDispatchState {
    return {
      planId: String(row.plan_id),
      ...(row.revision === null || row.revision === undefined ? {} : { revision: Number(row.revision) }),
      projectId: String(row.project_id),
      status: String(row.status) as PlanDispatchState["status"],
      waitReason: row.wait_reason === null || row.wait_reason === undefined ? null : String(row.wait_reason) as PlanDispatchState["waitReason"],
      queuedAt: String(row.queued_at),
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      attempt: Number(row.attempt),
      updatedAt: String(row.updated_at),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      ...(row.phase ? { phase: String(row.phase) as NonNullable<PlanDispatchState["phase"]> } : {}),
      automatic: Number(row.automatic ?? 0) === 1,
      confirmedBy: row.confirmed_by === null || row.confirmed_by === undefined ? null : String(row.confirmed_by),
    };
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
    acceptanceCriteria: ["Legacy record: no executable V2 contract is available"],
    include: ["."],
    exclude: [],
    baseBranch: "unverified",
    baseCommit: "unverified",
    tasks: [{ id: "legacy", title: "Historical plan", dependencies: [], status: "PENDING" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test", "project.typecheck"],
    maxRepairAttempts: 2,
    mergeStrategy: "manual",
    requireHumanMerge: true,
    dependsOnPlanIds: [],
    priority: 0,
  };
}

/** Internal adapter for pre-existing executor ports; API and revisions expose resolvedContract instead. */
function executionContractFromResolvedV2(contract: ResolvedPlanContractV2): PlanContract {
  return {
    goal: contract.objective.goal,
    acceptanceCriteria: contract.objective.acceptanceCriteria,
    include: contract.scope.includePaths,
    exclude: contract.scope.excludePaths,
    baseBranch: contract.repository.baseBranch,
    baseCommit: contract.repository.baseCommit,
    tasks: contract.tasks,
    conflictKeys: contract.conflicts,
    executorModelRole: contract.execution.executorModelRole,
    toolPolicy: contract.execution.toolPolicy,
    verificationCommandIds: contract.verification.commandIds,
    maxRepairAttempts: contract.execution.maxRepairAttempts,
    mergeStrategy: contract.merge.strategy,
    requireHumanMerge: true,
    artifactMode: contract.artifact.mode,
    ...(contract.artifact.path ? { artifactPath: contract.artifact.path } : {}),
    dependsOnPlanIds: contract.dependencies,
    priority: 0,
  };
}

function verifiedProjectBaseline(project: Project): { baseBranch: string; baseCommit: string } {
  try {
    const baseCommit = execFileSync("git", ["rev-parse", "--verify", `${project.defaultBranch}^{commit}`], { cwd: project.repoRoot, encoding: "utf8" }).trim();
    if (!baseCommit) throw new Error("empty commit");
    return { baseBranch: project.defaultBranch, baseCommit };
  } catch (error) {
    throw new Error(`Project ${project.id} has no verified Git baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Confirm/Enqueue 前校验执行合同的结构，避免无效任务图进入不可恢复的 Run。 */
export function validatePlanContract(contract: PlanContract): void {
  if (typeof contract.goal !== "string" || !contract.goal.trim()) throw new Error("Plan goal is required");
  if (!isNonEmptyStringArray(contract.acceptanceCriteria)) throw new Error("Plan acceptance criteria must be a non-empty list");
  for (const [field, values] of [["include", contract.include], ["exclude", contract.exclude], ["conflictKeys", contract.conflictKeys], ["verificationCommandIds", contract.verificationCommandIds]] as const) {
    if (!isStringArray(values) || values.some((value) => !value.trim())) throw new Error(`Plan ${field} must contain non-empty strings`);
  }
  if (typeof contract.baseBranch !== "string" || !contract.baseBranch.trim() || typeof contract.baseCommit !== "string" || !contract.baseCommit.trim()) throw new Error("Plan base branch and commit are required");
  if (typeof contract.executorModelRole !== "string" || !contract.executorModelRole.trim() || typeof contract.toolPolicy !== "string" || !contract.toolPolicy.trim()) throw new Error("Plan executor and tool policy are required");
  if (!Number.isInteger(contract.maxRepairAttempts) || contract.maxRepairAttempts < 0) throw new Error("Plan max repair attempts must be a non-negative integer");
  if (!["manual", "fast-forward", "squash"].includes(contract.mergeStrategy)) throw new Error("Plan merge strategy is invalid");
  if (contract.requireHumanMerge !== true) throw new Error("Plan requires human merge confirmation");
  if (contract.priority !== undefined && (!Number.isInteger(contract.priority) || contract.priority < 0)) throw new Error("Plan priority must be a non-negative integer");
  const taskIds = contract.tasks.map((task) => task.id);
  if (taskIds.some((id) => !id.trim())) throw new Error("Plan task ids must be non-empty");
  if (new Set(taskIds).size !== taskIds.length) throw new Error("Plan task ids must be unique");
  const known = new Set(taskIds);
  for (const task of contract.tasks) {
    if (!["PENDING", "READY", "DONE"].includes(task.status)) throw new Error(`Invalid status for task ${task.id}`);
    for (const dependency of task.dependencies) if (!known.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
  }
  if (contract.dependsOnPlanIds !== undefined && (!isStringArray(contract.dependsOnPlanIds) || contract.dependsOnPlanIds.some((id) => id.trim().length === 0))) {
    throw new Error("Plan dependencies must be a list of non-empty plan ids");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new Error(`Plan task dependency cycle includes ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    const task = contract.tasks.find((candidate) => candidate.id === taskId)!;
    for (const dependency of task.dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);
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

/**
 * 负责 ExplorerThread、CandidatePlan、Confirm、Enqueue 和 Revision 的业务边界。
 * CandidatePlan 的状态变化始终先写事实，再追加领域事件，避免 UI 投影领先于持久化状态。
 */
/** 统一记录 Plan 状态变更；领域语义事件仍由各业务服务分别保留。 */
export function updatePlanStatus(
  store: PipelineStore,
  plan: CandidatePlan,
  updates: Partial<CandidatePlan>,
  reason?: string | null,
): CandidatePlan {
  const updated = store.updatePlan({ ...plan, ...updates });
  if (updated.status !== plan.status) {
    store.appendEvent({
      type: "plan.status.changed",
      aggregateId: plan.id,
      payload: {
        planId: plan.id,
        fromStatus: plan.status,
        toStatus: updated.status,
        revision: updated.revision,
        runId: updated.runId,
        reason: reason ?? updated.attentionReason ?? null,
      },
    });
  }
  return updated;
}

export class PlanService {
  private readonly projects: ProjectService;

  constructor(private readonly store: PipelineStore, projects?: ProjectService) {
    this.projects = projects ?? new ProjectService(store);
  }

  /** 注册与 Project 绑定的本地线程，并追加创建事件。 */
  registerThread(input: RegisterThreadInput): ExplorerThread {
    const thread = this.store.saveThread(input);
    selectCurrentExplorer(this.store, thread);
    this.store.appendEvent({
      type: "explorer.thread.created",
      aggregateId: thread.id,
      payload: { projectId: thread.projectId, parentThreadId: thread.parentThreadId, explorerPlanId: thread.activeExplorerPlanId, turnId: null, loopId: null },
    });
    return thread;
  }

  /** 创建 Draft CandidatePlan；只在源线程产生新的候选投影，不创建 Revision 或 Run。 */
  createCandidatePlan(input: CreateCandidatePlanInput): CandidatePlan {
    if (!this.store.getThread(input.sourceExplorerThreadId)) {
      this.registerThread({ id: input.sourceExplorerThreadId, projectId: input.projectId, parentThreadId: null });
    }
    const createdAt = this.store.now();
    const project = this.store.getProject(input.projectId);
    let generatedSpec: GeneratedPlanSpecV2 | undefined;
    let resolvedContract: ResolvedPlanContractV2 | undefined;
    if (input.generatedSpec) {
      if (!project) throw new Error(`Project ${input.projectId} not found`);
      generatedSpec = parseGeneratedPlanSpecV2(input.generatedSpec);
      resolvedContract = resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project));
    }
    const plan: CandidatePlan = {
      id: this.store.nextId("plan"),
      projectId: input.projectId,
      sourceExplorerThreadId: input.sourceExplorerThreadId,
      ...(input.explorerPlanId ? { explorerPlanId: input.explorerPlanId } : {}),
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
      dispatchedAt: null,
      runId: null,
      lastEventAt: createdAt,
      attentionReason: null,
      contract: resolvedContract ? executionContractFromResolvedV2(resolvedContract) : input.contract ?? defaultPlanContract(input.title),
      ...(generatedSpec ? { generatedSpec } : {}),
      ...(resolvedContract ? { resolvedContract } : {}),
    };
    this.store.savePlan(plan);
    this.store.saveCandidateVersion(plan);
    this.store.appendEvent({ type: "plan.candidate.created", aggregateId: plan.id, payload: { title: plan.title, revision: plan.revision, explorerPlanId: plan.explorerPlanId ?? null, sourceTurnId: plan.sourceTurnId, providerThreadId: plan.providerThreadId, providerTurnId: plan.providerTurnId, providerItemId: plan.providerItemId } });
    return plan;
  }

  /** 每次重新生成 READY 产物都保存不可变的候选版本，确认只能使用最新版。 */
  reviseCandidate(planId: string, artifact: PlanArtifact, source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null }): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error("Only an unconfirmed Plan can be edited");
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpecV2(artifact.generatedSpec) : undefined;
    const resolvedContract = generatedSpec ? resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), verifiedProjectBaseline(project)) : undefined;
    const revision = Math.max(plan.revision, ...this.store.listCandidateVersions(plan.id).map((item) => item.revision)) + 1;
    const planWithoutGeneratedSpec = { ...plan };
    delete planWithoutGeneratedSpec.generatedSpec;
    delete planWithoutGeneratedSpec.resolvedContract;
    const updated = this.store.updatePlan({
      ...planWithoutGeneratedSpec, title: artifact.title, revision,
      contract: resolvedContract ? executionContractFromResolvedV2(resolvedContract) : artifact.contract ?? plan.contract,
      ...(generatedSpec ? { generatedSpec } : {}),
      ...(resolvedContract ? { resolvedContract } : {}),
      ...source, lastEventAt: this.store.now(),
    });
    this.store.saveCandidateVersion(updated);
    this.store.appendEvent({ type: "plan.candidate.revised", aggregateId: plan.id, payload: { revision, sourceTurnId: source.sourceTurnId } });
    return updated;
  }

  /** 读取 Plan；未知 id 直接失败，调用方不得回退到默认 Project。 */
  get(planId: string): CandidatePlan {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);
    return plan;
  }

  /** 在一个需求对话内切换待编辑的独立 Plan；null 表示下一次 READY 新建 Plan。 */
  selectCandidate(explorerPlanId: string, planId: string | null): ExplorerPlan {
    const requirement = this.store.getExplorerPlan(explorerPlanId);
    if (!requirement) throw new Error("Requirement not found");
    if (planId) {
      const plan = this.get(planId);
      if (plan.projectId !== requirement.projectId || plan.explorerPlanId !== requirement.id || plan.sourceExplorerThreadId !== requirement.explorerThreadId || plan.status !== "DRAFT") throw new Error("Plan is not an editable candidate for this requirement");
    }
    const updated = this.store.updateExplorerPlan({ ...requirement, candidatePlanId: planId, newPlanRequested: planId === null, exploration: { ...requirement.exploration, candidatePlanId: planId }, lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.plan.selected", aggregateId: requirement.explorerThreadId, payload: { explorerPlanId, planId } });
    return updated;
  }

  /**
   * 创建或复用同一 Plan 的下一版草稿。此入口只建立可编辑 Draft，绝不创建不可变 Revision。
   * Run/worktree 的实际终止和清理由 API 协调器先完成；这里拒绝任何未确认清理的历史执行。
   */
  createRevisionDraft(input: CreateRevisionDraftInput): PlanRevisionDraft {
    const cached = this.store.getIdempotency("revision-draft", input.clientRequestId);
    if (cached) return cached as unknown as PlanRevisionDraft;
    const plan = this.get(input.planId);
    const thread = this.store.getThread(input.explorerThreadId);
    if (!thread || thread.projectId !== plan.projectId) throw new Error("EXPLORER_THREAD_PROJECT_MISMATCH");
    if (input.fromRevision > plan.revision || input.fromRevision < 1 || !this.store.getRevision(plan.id, input.fromRevision)) throw new Error("REVISION_NOT_FOUND");
    const active = this.store.listRevisionDrafts(plan.id).find((draft) => draft.status === "EDITING" || draft.status === "READY_TO_CONFIRM" || draft.status === "BASE_CHANGED");
    if (active) {
      this.store.saveIdempotency("revision-draft", input.clientRequestId, active as unknown as Record<string, unknown>);
      return active;
    }
    const unmergedRuns = this.store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === input.fromRevision && !this.store.findMergeRequestByRun(run.id)?.mergedAt && (run.workspacePath !== null || !["CANCELLED", "STALE"].includes(run.status)));
    if (unmergedRuns.length && !input.discardUnmergedRun) throw new Error("UNMERGED_RUN_CONFIRMATION_REQUIRED");
    const source = this.store.getRevision(plan.id, input.fromRevision)!;
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const now = this.store.now();
    const draft: PlanRevisionDraft = Object.freeze({
      draftId: this.store.nextId("revision-draft"), planId: plan.id, projectId: plan.projectId,
      basedOnRevision: input.fromRevision, targetRevision: plan.revision + 1, status: "EDITING",
      // A revision draft is rebased on the current verified default branch.  Carrying a
      // historical contract's base commit here can otherwise create an unstartable Run.
      title: plan.title, contract: { ...source.contract, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit }, ...(source.resolvedContract ? { resolvedContract: source.resolvedContract } : {}),
      sourceExplorerThreadId: thread.id, ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}), sourceTurnId: source.sourceTurnId ?? null, providerThreadId: source.providerThreadId ?? null, providerTurnId: source.providerTurnId ?? null, providerItemId: source.providerItemId ?? null,
      baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, createdAt: now, updatedAt: now, confirmedAt: null,
    });
    const saved = this.store.saveRevisionDraft(draft);
    if (thread.state === "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    else this.store.updateThread({ ...thread, activeRevisionDraftId: saved.draftId, lastActivityAt: now });
    this.store.saveRevisionLifecycleProjection({ planId: plan.id, revision: saved.targetRevision, projectId: plan.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: thread.id, runId: null, lastEventAt: now });
    this.store.appendEvent({ type: "plan.revision.draft.created", aggregateId: plan.id, payload: { draftId: saved.draftId, fromRevision: input.fromRevision, targetRevision: saved.targetRevision, explorerThreadId: thread.id, discardUnmergedRun: input.discardUnmergedRun } });
    this.store.saveIdempotency("revision-draft", input.clientRequestId, saved as unknown as Record<string, unknown>);
    return saved;
  }

  /** READY 只更新同一个 Draft；不会为同一业务计划创建新的 planId。 */
  updateRevisionDraftFromExplorer(draftId: string, artifact: PlanArtifact, source: { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null }): PlanRevisionDraft {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error(`RevisionDraft ${draftId} not found`);
    if (draft.status !== "EDITING" && draft.status !== "READY_TO_CONFIRM" && draft.status !== "BASE_CHANGED") throw new Error(`RevisionDraft ${draftId} is not editable`);
    const project = this.store.getProject(draft.projectId);
    if (!project) throw new Error(`Project ${draft.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    const generatedSpec = artifact.generatedSpec ? parseGeneratedPlanSpecV2(artifact.generatedSpec) : undefined;
    const resolvedContract = generatedSpec ? resolvePlanContractV2(generatedSpec, this.projects.snapshot(project.id), baseline) : undefined;
    const contract = resolvedContract ? executionContractFromResolvedV2(resolvedContract) : artifact.contract ?? draft.contract;
    const updated: PlanRevisionDraft = Object.freeze({ ...draft, title: artifact.title, contract, ...(generatedSpec ? { generatedSpec } : {}), ...(resolvedContract ? { resolvedContract } : {}), sourceExplorerThreadId: draft.sourceExplorerThreadId, ...source, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, status: "READY_TO_CONFIRM", updatedAt: this.store.now() });
    const saved = this.store.updateRevisionDraft(updated);
    this.store.saveRevisionLifecycleProjection({ planId: saved.planId, revision: saved.targetRevision, projectId: saved.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: saved.sourceExplorerThreadId, runId: null, lastEventAt: saved.updatedAt });
    this.store.appendEvent({ type: "plan.revision.draft.ready", aggregateId: saved.planId, payload: { draftId: saved.draftId, targetRevision: saved.targetRevision, sourceTurnId: source.sourceTurnId } });
    return saved;
  }

  confirmRevisionDraft(draftId: string, confirmedBy: string): CandidatePlan {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error("REVISION_DRAFT_NOT_FOUND");
    if (draft.status === "CONFIRMED") return this.get(draft.planId);
    if (draft.status !== "READY_TO_CONFIRM") throw new Error(`RevisionDraft ${draftId} cannot be confirmed from ${draft.status}`);
    const plan = this.get(draft.planId);
    if (plan.revision + 1 !== draft.targetRevision) throw new Error("REVISION_NOT_LATEST");
    const project = this.store.getProject(draft.projectId);
    if (!project) throw new Error(`Project ${draft.projectId} not found`);
    const baseline = verifiedProjectBaseline(project);
    if (baseline.baseCommit !== draft.baseCommit || baseline.baseBranch !== draft.baseBranch) {
      const changed = this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "BASE_CHANGED", updatedAt: this.store.now() }));
      this.store.saveRevisionLifecycleProjection({ planId: changed.planId, revision: changed.targetRevision, projectId: changed.projectId, title: changed.title, status: changed.status, sourceExplorerThreadId: changed.sourceExplorerThreadId, runId: null, lastEventAt: changed.updatedAt });
      throw new Error("BASE_CHANGED");
    }
    validatePlanContract(draft.contract);
    const snapshot = this.projects.snapshot(project.id);
    const confirmedAt = this.store.now();
    const revision = freezeRevision({ planId: plan.id, revision: draft.targetRevision, contract: draft.contract, ...(draft.resolvedContract ? { resolvedContract: draft.resolvedContract } : {}), artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: draft.contract, projectConfigSnapshot: snapshot })).digest("hex")}`, confirmedBy, confirmedAt, sourceExplorerThreadId: draft.sourceExplorerThreadId, ...(draft.explorerPlanId ? { explorerPlanId: draft.explorerPlanId } : {}), sourceTurnId: draft.sourceTurnId, providerThreadId: draft.providerThreadId, providerTurnId: draft.providerTurnId, providerItemId: draft.providerItemId, provenance: "CURRENT", projectConfigVersion: snapshot.configVersion, projectConfigHash: snapshot.configHash, projectConfigSnapshot: snapshot });
    this.store.saveRevision(revision);
    const updatedPlan = updatePlanStatus(this.store, plan, { title: draft.title, revision: draft.targetRevision, status: "READY", contract: draft.contract, ...(draft.generatedSpec ? { generatedSpec: draft.generatedSpec } : {}), ...(draft.resolvedContract ? { resolvedContract: draft.resolvedContract } : {}), sourceExplorerThreadId: draft.sourceExplorerThreadId, sourceTurnId: draft.sourceTurnId, providerThreadId: draft.providerThreadId, providerTurnId: draft.providerTurnId, providerItemId: draft.providerItemId, confirmedBy, confirmedAt, queuedAt: null, dispatchedAt: null, runId: null, attentionReason: null, lastEventAt: confirmedAt });
    this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "CONFIRMED", confirmedAt, updatedAt: confirmedAt }));
    const thread = this.store.getThread(draft.sourceExplorerThreadId);
    if (thread?.activeRevisionDraftId === draftId) this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: confirmedAt });
    this.store.saveRevisionLifecycleProjection({ planId: plan.id, revision: draft.targetRevision, projectId: plan.projectId, title: draft.title, status: "READY", sourceExplorerThreadId: draft.sourceExplorerThreadId, runId: null, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.revision.confirmed", aggregateId: plan.id, payload: { draftId, revision: draft.targetRevision, confirmedBy } });
    return updatedPlan;
  }

  discardRevisionDraft(draftId: string, actorId: string): PlanRevisionDraft {
    const draft = this.store.getRevisionDraft(draftId);
    if (!draft) throw new Error("REVISION_DRAFT_NOT_FOUND");
    if (draft.status === "DISCARDED") return draft;
    if (draft.status === "CONFIRMED") throw new Error("REVISION_DRAFT_CONFIRMED");
    const now = this.store.now();
    const saved = this.store.updateRevisionDraft(Object.freeze({ ...draft, status: "DISCARDED", updatedAt: now }));
    const thread = this.store.getThread(saved.sourceExplorerThreadId);
    if (thread?.activeRevisionDraftId === saved.draftId) this.store.updateThread({ ...thread, activeRevisionDraftId: null, lastActivityAt: now });
    this.store.saveRevisionLifecycleProjection({ planId: saved.planId, revision: saved.targetRevision, projectId: saved.projectId, title: saved.title, status: saved.status, sourceExplorerThreadId: saved.sourceExplorerThreadId, runId: null, lastEventAt: now });
    this.store.appendEvent({ type: "plan.revision.draft.discarded", aggregateId: saved.planId, payload: { draftId, actorId } });
    return saved;
  }

  listRevisions(planId: string): PlanRevisionV2[] { this.get(planId); return this.store.listRevisions(planId); }

  /** 丢弃仍处于 DRAFT 的候选计划；记录审计事件且不生成后续执行事实。 */
  discard(planId: string, actorId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DRAFT") throw new Error(`Plan ${planId} cannot be discarded from ${plan.status}`);
    const discardedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "DISCARDED", lastEventAt: discardedAt });
    this.store.appendEvent({ type: "plan.discarded", aggregateId: planId, payload: { actorId } });
    return updated;
  }

  /** 确认 Plan 并冻结当前 Project 配置，生成后续 Run 唯一使用的 Revision。 */
  confirm(planId: string, confirmedBy: string, expectedRevision?: number): CandidatePlan {
    const plan = this.get(planId);
    if (expectedRevision !== undefined && plan.revision !== expectedRevision) throw new Error("REVISION_NOT_LATEST");
    if (plan.status === "READY" || plan.status === "ENQUEUED" || plan.status === "DISPATCHED") return plan;
    if (plan.status !== "DRAFT" && plan.status !== "DESIGNED" && plan.status !== "PLANNED") {
      throw new Error(`Plan ${planId} cannot be confirmed from ${plan.status}`);
    }
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be executed by V2 scheduling`);
    if (plan.resolvedContract) {
      const project = this.store.getProject(plan.projectId);
      if (!project || project.id !== plan.resolvedContract.repository.projectId) throw new Error(`Plan ${planId} is bound to an invalid Project`);
      if (project.configVersion !== plan.resolvedContract.repository.configVersion || project.configHash !== plan.resolvedContract.repository.configHash) throw new Error(`Plan ${planId} is stale because Project configuration changed; regenerate it`);
    }
    validatePlanContract(plan.contract);
    this.validatePlanDependencies(plan);
    const confirmedAt = this.store.now();
    const project = this.store.getProject(plan.projectId);
    const projectConfigSnapshot = project ? this.projects.snapshot(project.id) : undefined;
    const revision = freezeRevision({
      planId: plan.id,
      revision: plan.revision,
      contract: plan.contract,
      ...(plan.resolvedContract ? { resolvedContract: plan.resolvedContract } : {}),
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: plan.contract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const updated = updatePlanStatus(this.store, plan, { status: "READY", confirmedBy, confirmedAt, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "plan.confirmed", aggregateId: planId, payload: { confirmedBy, revision: plan.revision } });
    return updated;
  }

  private validatePlanDependencies(plan: CandidatePlan): void {
    const dependencies = plan.contract.dependsOnPlanIds ?? [];
    const plans = new Map(this.store.listPlans().filter((item) => item.projectId === plan.projectId).map((item) => [item.id, item]));
    for (const dependencyId of dependencies) {
      if (dependencyId === plan.id) throw new Error(`Plan ${plan.id} cannot depend on itself`);
      if (!plans.has(dependencyId)) throw new Error(`Plan ${plan.id} depends on unknown plan ${dependencyId}`);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (planId: string): void => {
      if (visiting.has(planId)) throw new Error(`Plan dependency cycle detected at ${planId}`);
      if (visited.has(planId)) return;
      visiting.add(planId);
      const current = plans.get(planId);
      for (const dependencyId of current?.contract.dependsOnPlanIds ?? []) {
        if (!plans.has(dependencyId)) {
          if (planId === plan.id) throw new Error(`Plan ${plan.id} depends on unknown plan ${dependencyId}`);
          continue;
        }
        visit(dependencyId);
      }
      visiting.delete(planId);
      visited.add(planId);
    };
    visit(plan.id);
  }

  /** 执行 Plan Center 查询：只读已 Enqueued 的计划，并以 projection 提供稳定排序和游标。 */
  query(query: PlanQuery): PlanQueryResult {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new Error("Plan query limit must be between 1 and 100");
    const sourceIds = query.explorerThreadId ? this.explorerLineage(query.explorerThreadId, query.includeLineage !== false) : null;
    const keyword = query.q?.trim().toLowerCase();
    const statuses = query.status && query.status.length > 0 ? new Set(query.status) : null;
    const rows = this.store.listPlanQueryProjection(query.projectId)
      .filter((row) => row.queuedAt !== null)
      .filter((row) => !sourceIds || sourceIds.has(row.sourceExplorerThreadId))
      .filter((row) => !statuses || statuses.has(row.status))
      .filter((row) => !keyword || `${row.planId} ${row.title} ${row.goal}`.toLowerCase().includes(keyword))
      .filter((row) => !query.from || Date.parse(row.queuedAt!) >= Date.parse(query.from))
      .filter((row) => !query.to || Date.parse(row.queuedAt!) <= Date.parse(query.to))
      .map((row) => {
        const plan = this.store.getPlan(row.planId);
        if (!plan) throw new Error(`Plan query projection ${row.planId} has no source Plan`);
        return {
          planId: row.planId,
          title: row.title,
          revision: row.revision,
          status: row.status,
          projectId: row.projectId,
          sourceExplorerThreadId: row.sourceExplorerThreadId,
          sourceTurnId: row.sourceTurnId,
          providerThreadId: plan.providerThreadId,
          providerTurnId: plan.providerTurnId,
          providerItemId: plan.providerItemId,
          createdAt: row.createdAt,
          queuedAt: row.queuedAt as string,
          dispatchedAt: row.dispatchedAt ?? null,
          runId: row.runId,
          lastEventAt: row.lastEventAt,
          attentionReason: row.attentionReason,
          priority: row.priority,
        } satisfies PlanIndexRow;
      })
      .sort((a, b) => this.comparePlanRows(a, b, query.sort));

    let start = 0;
    if (query.cursor) {
      const cursor = decodePlanCursor(query.cursor);
      if (cursor.sort !== query.sort) throw new Error("Plan query cursor sort does not match request");
      const cursorIndex = rows.findIndex((row) => row.planId === cursor.planId);
      if (cursorIndex < 0) throw new Error("Plan query cursor is no longer valid");
      start = cursorIndex + 1;
    }
    const items = rows.slice(start, start + query.limit);
    const last = items.at(-1);
    return { items, nextCursor: last && start + items.length < rows.length ? encodePlanCursor({ sort: query.sort, planId: last.planId }) : null };
  }

  private explorerLineage(threadId: string, includeLineage: boolean): Set<string> {
    const thread = this.store.getThread(threadId);
    if (!thread) return new Set();
    if (!includeLineage) return new Set([threadId]);
    const lineage = new Set<string>([threadId]);
    let parentId = thread.parentThreadId;
    while (parentId) {
      lineage.add(parentId);
      parentId = this.store.getThread(parentId)?.parentThreadId ?? null;
    }
    let changed = true;
    const projectThreads = this.store.listThreads().filter((candidate) => candidate.projectId === thread.projectId);
    while (changed) {
      changed = false;
      for (const candidate of projectThreads) {
        if (candidate.parentThreadId && lineage.has(candidate.parentThreadId) && !lineage.has(candidate.id)) {
          lineage.add(candidate.id);
          changed = true;
        }
      }
    }
    return lineage;
  }

  private comparePlanRows(a: PlanIndexRow, b: PlanIndexRow, sort: PlanQuerySort): number {
    if (sort === "priority") {
      const priority = b.priority - a.priority;
      if (priority !== 0) return priority;
      const queued = (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "");
      if (queued !== 0) return queued;
    } else if (sort === "status") {
      const status = a.status.localeCompare(b.status);
      if (status !== 0) return status;
    } else {
      const field = sort === "queued_at" ? "queuedAt" : "lastEventAt";
      const time = (b[field] ?? "").localeCompare(a[field] ?? "");
      if (time !== 0) return time;
    }
    return a.planId.localeCompare(b.planId);
  }

  /** 读取指定不可变 Revision；缺失快照的旧数据仍按 LEGACY 兼容读取。 */
  getRevision(planId: string, revision: number): PlanRevisionV2 {
    const value = this.store.getRevision(planId, revision);
    if (!value) throw new Error(`Plan revision ${planId}@${revision} not found`);
    return value;
  }

  /** 将已确认 Plan 放入人工 Enqueued 阶段；只有显式派发才会唤醒 Scheduler。 */
  enqueue(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be enqueued`);
    if (plan.contract.artifactMode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (plan.status === "ENQUEUED" || plan.status === "DISPATCHED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") {
      return plan;
    }
    if (plan.status !== "READY") throw new Error(`Plan ${planId} must be confirmed before enqueue`);
    const queuedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "ENQUEUED", queuedAt, dispatchedAt: null, lastEventAt: queuedAt });
    this.store.appendEvent({ type: "plan.enqueued", aggregateId: planId, payload: { queuedAt, revision: plan.revision } });
    return updated;
  }

  /** 将人工入队的 Plan 交给调度器；派发时间保留用于 Dispatched 历史投影。 */
  dispatch(planId: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.contract.schemaVersion === 1) throw new Error(`Legacy V1 Plan ${planId} is read-only and cannot be dispatched`);
    if (plan.contract.artifactMode === "CONVERSATION") throw new Error("CONVERSATION_ARTIFACT_NOT_EXECUTABLE");
    if (plan.status === "DISPATCHED" || plan.status === "IN_PROGRESS" || plan.status === "VERIFYING" || plan.status === "MERGE_READY" || plan.status === "MERGED") return plan;
    if (plan.status !== "ENQUEUED") throw new Error(`Plan ${planId} must be enqueued before dispatch`);
    const dispatchedAt = this.store.now();
    const updated = updatePlanStatus(this.store, plan, { status: "DISPATCHED", dispatchedAt, lastEventAt: dispatchedAt });
    this.store.appendEvent({ type: "plan.dispatched", aggregateId: planId, payload: { dispatchedAt, revision: plan.revision } });
    return updated;
  }

  /**
   * 使用当前 Project 配置冻结一份新 Revision，修复尚未创建 Run 的配置阻塞派发。
   * 原 Revision 与原调度事件保持不变；新的 Revision 必须再次经过 Enqueue 与 Dispatch。
   */
  reviseConfiguration(planId: string, confirmedBy: string): CandidatePlan {
    const plan = this.get(planId);
    if (plan.status !== "DISPATCHED" || plan.runId !== null) {
      throw new Error(`Plan ${planId} is not eligible for a configuration revision`);
    }
    validatePlanContract(plan.contract);
    this.validatePlanDependencies(plan);
    const project = this.store.getProject(plan.projectId);
    if (!project) throw new Error(`Project ${plan.projectId} not found`);
    const projectConfigSnapshot = this.projects.snapshot(project.id);
    const registeredCommands = new Set(projectConfigSnapshot.settings.commands.map((command) => command.commandId));
    const missingCommands = plan.contract.verificationCommandIds.filter((commandId) => !registeredCommands.has(commandId));
    if (missingCommands.length) {
      throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missingCommands.join(", ")}`);
    }

    const confirmedAt = this.store.now();
    const revisionNumber = plan.revision + 1;
    const revision = freezeRevision({
      planId: plan.id,
      revision: revisionNumber,
      contract: plan.contract,
      artifactHash: `sha256:${createHash("sha256").update(JSON.stringify({ contract: plan.contract, projectConfigSnapshot })).digest("hex")}`,
      confirmedBy,
      confirmedAt,
      sourceExplorerThreadId: plan.sourceExplorerThreadId,
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      projectConfigVersion: projectConfigSnapshot.configVersion,
      projectConfigHash: projectConfigSnapshot.configHash,
      projectConfigSnapshot,
    });
    this.store.saveRevision(revision);
    const updated = updatePlanStatus(this.store, plan, {
      revision: revisionNumber,
      status: "READY",
      confirmedBy,
      confirmedAt,
      queuedAt: null,
      dispatchedAt: null,
      runId: null,
      attentionReason: null,
      lastEventAt: confirmedAt,
    });
    this.store.appendEvent({ type: "plan.configuration.revised", aggregateId: planId, payload: { confirmedBy, fromRevision: plan.revision, revision: revisionNumber, projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash } });
    return updated;
  }

  /** 返回线程谱系下已确认或已排队的 Plan，供 Explorer 的 Plans 导航使用。 */
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
        ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
        sourceTurnId: plan.sourceTurnId,
        providerThreadId: plan.providerThreadId,
        providerTurnId: plan.providerTurnId,
        providerItemId: plan.providerItemId,
        createdAt: plan.createdAt,
        queuedAt: plan.queuedAt,
        dispatchedAt: plan.dispatchedAt ?? null,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
        priority: plan.contract.priority ?? 0,
      }))
      .sort((a, b) => (b.queuedAt ?? "").localeCompare(a.queuedAt ?? "") || b.lastEventAt.localeCompare(a.lastEventAt) || b.planId.localeCompare(a.planId));
  }

  /** 按 Project 隔离返回 Plan，避免多个仓库之间出现跨项目数据串联。 */
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
        ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
        sourceTurnId: plan.sourceTurnId,
        providerThreadId: plan.providerThreadId,
        providerTurnId: plan.providerTurnId,
        providerItemId: plan.providerItemId,
        createdAt: plan.createdAt,
        queuedAt: plan.queuedAt as string,
        dispatchedAt: plan.dispatchedAt ?? null,
        runId: plan.runId,
        lastEventAt: plan.lastEventAt,
        attentionReason: plan.attentionReason,
        priority: plan.contract.priority ?? 0,
      }))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
  }

  /** 当前探索线程中跨所有需求分区的完整 Plan 集合。 */
  listExplorerThreadPlans(threadId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.sourceExplorerThreadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** 项目 Plan 中心只列尚未确认的 Candidate。 */
  listProjectPlanCandidates(projectId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.projectId === projectId && plan.status === "DRAFT" && plan.confirmedAt === null)
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }

  /** 项目任务中心只列已确认 Plan；合并状态仍由人工确认接口推进。 */
  listProjectTasks(projectId: string): CandidatePlan[] {
    return this.store.listPlans()
      .filter((plan) => plan.projectId === projectId && !["DRAFT", "DISCARDED"].includes(plan.status))
      .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id));
  }
}

export class ExplorerDeleteBlockedError extends Error {
  readonly code = "EXPLORER_DELETE_BLOCKED" as const;

  constructor(readonly activeRunIds: string[], readonly activeLoopIds: string[]) {
    super("ExplorerThread has active execution work; pause or cancel it before deleting the thread");
    this.name = "ExplorerDeleteBlockedError";
  }
}

const EXPLORER_DELETE_ACTIVE_RUN_STATUSES = new Set(["QUEUED", "STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"]);

/** 管理 ExplorerThread 的创建、继承、归档、激活和标题修改。 */
export class ExplorerService {
  constructor(private readonly store: PipelineStore) {}

  /** 创建 Project 内的新 ExplorerThread，可显式继承来源线程。 */
  create(input: CreateExplorerInput): ExplorerThread {
    const origin = input.originThreadId ? this.store.getThread(input.originThreadId) : undefined;
    if (input.originThreadId && (!origin || origin.projectId !== input.projectId)) throw new Error("Origin Explorer does not belong to this project");
    let thread = this.store.saveThread({
      id: this.store.nextId("explorer"),
      projectId: input.projectId,
      parentThreadId: null,
      title: input.title?.trim() || "New Explorer",
      contextMode: origin ? "EXPLICIT_CONTINUATION" : "FRESH",
      originThreadId: origin?.id ?? null,
      createdAt: input.createdAt,
    });
    if (thread.titleSource === "AUTO" && thread.titleStatus === "PLACEHOLDER") {
      thread = this.store.updateThread({ ...thread, title: projectPlaceholderExplorerTitle(this.store, thread), titleStatus: "GENERATED" });
    }
    this.store.appendEvent({ type: "explorer.created", aggregateId: thread.id, payload: { projectId: thread.projectId, contextMode: thread.contextMode, originThreadId: thread.originThreadId, explorerPlanId: thread.activeExplorerPlanId, turnId: null, loopId: null } });
    if (origin) this.store.appendEvent({ type: "explorer.continued", aggregateId: thread.id, payload: { originThreadId: origin.id, explorerPlanId: thread.activeExplorerPlanId, turnId: null, loopId: null } });
    selectCurrentExplorer(this.store, thread);
    return thread;
  }

  /** 按 id 读取 ExplorerThread。 */
  get(explorerId: string): ExplorerThread {
    const explorer = this.store.getThread(explorerId);
    if (!explorer) throw new Error(`Explorer ${explorerId} not found`);
    return explorer;
  }

  /** 返回线程下按创建顺序排列的 Plan 分区，并保证旧线程已有默认 Plan。 */
  listPlans(explorerId: string): ExplorerPlan[] {
    const explorer = this.get(explorerId);
    let plans = this.store.listExplorerPlans(explorer.id);
    if (!plans.length) {
      const created = this.createPlan(explorer.id);
      plans = [created];
    }
    return plans;
  }

  /** 创建空 Plan 分区；不启动 Provider，也不复制旧消息。 */
  createPlan(explorerId: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    if (explorer.state === "ARCHIVED") throw new Error(`ExplorerThread ${explorerId} is archived`);
    const plans = this.store.listExplorerPlans(explorer.id);
    const createdAt = this.store.now();
    const plan = defaultExplorerPlan(explorer, this.store.nextId("explorer-plan"), (plans.at(-1)?.ordinal ?? 0) + 1, createdAt);
    this.store.saveExplorerPlan(plan);
    const contextSummary = explorer.contextSummary ?? defaultThreadContextSummary(createdAt);
    const updatedThread = this.store.updateThread({ ...explorer, activeExplorerPlanId: plan.id, contextSummary: { ...contextSummary, updatedAt: createdAt, openPlanIds: [...new Set([...contextSummary.openPlanIds, plan.id])] }, lastActivityAt: createdAt });
    this.store.appendEvent({ type: "explorer.plan.created", aggregateId: explorer.id, payload: { explorerId: explorer.id, explorerPlanId: plan.id, turnId: null, loopId: null, ordinal: plan.ordinal } });
    void updatedThread;
    return plan;
  }

  /** 切换当前 Plan；只更新线程的活动投影，不修改 Provider 会话。 */
  activatePlan(explorerId: string, explorerPlanId: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== explorer.id || plan.projectId !== explorer.projectId) throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    this.store.updateThread({ ...explorer, activeExplorerPlanId: plan.id, lastActivityAt: this.store.now() });
    return plan;
  }

  renamePlan(explorerId: string, explorerPlanId: string, title: string): ExplorerPlan {
    const explorer = this.get(explorerId);
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== explorer.id) throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    const normalized = title.trim();
    if (!normalized) throw new Error("ExplorerPlan title cannot be empty");
    const updated = this.store.updateExplorerPlan({ ...plan, title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED", lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.plan.renamed", aggregateId: explorer.id, payload: { explorerId: explorer.id, explorerPlanId: plan.id, turnId: null, loopId: null, title: normalized } });
    return updated;
  }

  /** 只列出指定 Project 的线程，按最近活动倒序。 */
  list(projectId: string): ExplorerThread[] {
    return this.store.listThreads().filter((thread) => thread.projectId === projectId).sort((a, b) => Number(b.state === "ACTIVE") - Number(a.state === "ACTIVE") || b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  /** 归档线程并保留其 Turn、Plan 和事件历史。 */
  archive(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ARCHIVED") return explorer;
    const project = this.store.getProject(explorer.projectId);
    if (project?.currentExplorerThreadId === explorerId) throw new Error("Current Explorer cannot be archived");
    const archived = this.store.updateThread({ ...explorer, state: "ARCHIVED", lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.archived", aggregateId: explorerId, payload: { explorerId, explorerPlanId: explorer.activeExplorerPlanId, turnId: null, loopId: null } });
    return archived;
  }

  /** 恢复归档线程的可写状态。 */
  activate(explorerId: string): ExplorerThread {
    const explorer = this.get(explorerId);
    if (explorer.state === "ACTIVE") return explorer;
    const active = this.store.updateThread({ ...explorer, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.store.appendEvent({ type: "explorer.activated", aggregateId: explorerId, payload: { explorerId, explorerPlanId: active.activeExplorerPlanId, turnId: null, loopId: null } });
    selectCurrentExplorer(this.store, active);
    return active;
  }

  /** 更新手工标题；空标题被拒绝且不会覆盖已有标题。 */
  rename(explorerId: string, title: string): ExplorerThread {
    const explorer = this.get(explorerId);
    const normalized = title.trim();
    if (!normalized) throw new Error("Explorer title cannot be empty");
    return this.store.updateThread({ ...explorer, title: normalized, titleSource: "MANUAL", titleStatus: "GENERATED", lastActivityAt: this.store.now() });
  }

  /** 删除线程及其全部业务投影；审计事件保留，已结束 Run 的 worktree 不做文件系统清理。 */
  delete(explorerId: string): { replacementExplorer: ExplorerThread; project: Project; deleted: ExplorerDeletionSummary } {
    const explorer = this.get(explorerId);
    const project = this.store.getProject(explorer.projectId);
    if (!project) throw new Error(`Project ${explorer.projectId} not found`);
    const explorerPlans = this.store.listExplorerPlans(explorer.id);
    const explorerPlanIds = explorerPlans.map((plan) => plan.id);
    const explorerPlanIdSet = new Set(explorerPlanIds);
    const turns = this.store.listTurns(explorer.id);
    const turnIds = turns.map((turn) => turn.id);
    const turnIdSet = new Set(turnIds);
    const plans = this.store.listPlans().filter((plan) => plan.sourceExplorerThreadId === explorer.id || (plan.explorerPlanId ? explorerPlanIdSet.has(plan.explorerPlanId) : false));
    const planIds = plans.map((plan) => plan.id);
    const planIdSet = new Set(planIds);
    const runs = this.store.listRuns().filter((run) => planIdSet.has(run.planId));
    const runIds = runs.map((run) => run.id);
    const runIdSet = new Set(runIds);
    const loops = this.store.listAgentLoops().filter((loop) => (loop.ownerType === "explorer-turn" && turnIdSet.has(loop.ownerId)) || (loop.ownerType === "run" && runIdSet.has(loop.ownerId)));
    const activeLoopStates = new Set(["CREATED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "RECOVERING"]);
    const activeRunIds = runs.filter((run) => EXPLORER_DELETE_ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id);
    const activeLoopIds = loops.filter((loop) => activeLoopStates.has(loop.state)).map((loop) => loop.id);
    if (activeRunIds.length || activeLoopIds.length) throw new ExplorerDeleteBlockedError(activeRunIds, activeLoopIds);

    const replacementCandidate = this.store.listThreads()
      .filter((thread) => thread.projectId === explorer.projectId && thread.id !== explorer.id && thread.state !== "ARCHIVED")
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    const input: Omit<ExplorerDeletionInput, "replacementExplorerId"> = {
      projectId: explorer.projectId,
      explorerId: explorer.id,
      explorerPlanIds,
      turnIds,
      planIds,
      runIds,
      executionThreadIds: runs.map((run) => run.executionThreadId),
      agentLoopIds: loops.map((loop) => loop.id),
      inputRequestIds: this.store.listInputRequests(explorer.id).map((request) => request.id),
    };

    const remove = () => {
      const replacementExplorer = replacementCandidate ?? this.create({ projectId: explorer.projectId });
      const deleted = this.store.deleteExplorerCascade({ ...input, replacementExplorerId: replacementExplorer.id });
      this.store.appendEvent({ type: "explorer.deleted", aggregateId: explorer.id, payload: { projectId: explorer.projectId, explorerId: explorer.id, replacementExplorerId: replacementExplorer.id, taskCount: deleted.taskCount, planCount: deleted.planCount, runCount: deleted.runCount } });
      const savedProject = this.store.getProject(explorer.projectId);
      if (!savedProject) throw new Error(`Project ${explorer.projectId} not found after Explorer deletion`);
      return { replacementExplorer: this.store.getThread(replacementExplorer.id) as ExplorerThread, project: savedProject, deleted };
    };
    return this.store.runInTransaction ? this.store.runInTransaction(remove) : remove();
  }
}

export type CreateChangeProposalInput = {
  runId: string;
  reason: string;
  requestedChanges: string[];
  contract: PlanContract;
  createdBy?: string;
};

/** 将执行阶段发现的范围变化安全地送回 Plan；批准会创建新的不可变 Revision。 */
export class ChangeProposalService {
  constructor(private readonly store: PipelineStore) {}

  /** 为 Run 创建唯一 OPEN 提案；重复调用返回已有开放提案。 */
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
    updatePlanStatus(this.store, plan, { status: "NEEDS_PLAN_CHANGE", attentionReason: input.reason, lastEventAt: proposal.createdAt }, input.reason);
    this.store.appendEvent({ type: "change.proposal.created", aggregateId: proposal.id, payload: { runId: run.id, planId: plan.id, revision: plan.revision, reason: input.reason, requestedChanges: input.requestedChanges } });
    return proposal;
  }

  async approve(proposalId: string, actorId: string): Promise<ApprovedChangeProposal> {
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
      ...(plan.explorerPlanId ? { explorerPlanId: plan.explorerPlanId } : {}),
      ...(projectConfigSnapshot ? { projectConfigVersion: projectConfigSnapshot.configVersion, projectConfigHash: projectConfigSnapshot.configHash, projectConfigSnapshot } : {}),
    });
    this.store.saveRevision(revision);
    const approvedProposal = this.store.updateChangeProposal({ ...proposal, status: "APPROVED", decidedAt: confirmedAt, decidedBy: actorId, revision: revisionNumber });
    const enqueuedPlan = updatePlanStatus(this.store, plan, { revision: revisionNumber, contract: proposal.contract, status: "ENQUEUED", confirmedBy: actorId, confirmedAt, queuedAt: confirmedAt, dispatchedAt: null, runId: null, attentionReason: null, lastEventAt: confirmedAt });
    this.store.appendEvent({ type: "change.proposal.approved", aggregateId: proposal.id, payload: { actorId, revision: revisionNumber, planId: plan.id } });
    return { proposal: approvedProposal, plan: enqueuedPlan, revision, run: null };
  }
}

/** 执行 Project 快照中声明的 Start/Cleanup Hook，并把失败映射为运行关注项。 */
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
    const cwd = hook === "start" ? context.workspacePath : this.cleanupCwd;
    const timeoutMs = definition?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    if (!definition || definition.enabled === false) {
      return {
        hook,
        status: "skipped",
        blocked: false,
        needsAttention: false,
        result: null,
        attempts: [{ attempt: 1, commandId: definition?.commandId ?? null, cwd, timeoutMs, status: "skipped", result: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      };
    }
    const attempts: HookRunResult["attempts"] = [];
    const maxAttempts = Math.max(1, definition.maxAttempts ?? 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = new Date().toISOString();
      let result: CommandResult;
      try {
        result = await this.executor({ commandId: definition.commandId, cwd, timeoutMs, context });
      } catch (error) {
        result = { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
      const completedAt = new Date().toISOString();
      const status = result.exitCode === 0 ? "completed" : "failed";
      attempts.push({ attempt, commandId: definition.commandId, cwd, timeoutMs, status, result, startedAt, completedAt });
      if (status === "completed") break;
    }
    const finalAttempt = attempts.at(-1)!;
    const failed = finalAttempt.status === "failed";
    return {
      hook,
      status: failed ? "failed" : "completed",
      blocked: failed && blocksRun,
      needsAttention: failed && !blocksRun,
      result: finalAttempt.result,
      attempts,
    };
  }
}

/** Commands are policy objects, not model input. Unclassified legacy commands are disabled by migration. */
export type RegisteredCommandDefinition = {
  commandId: string;
  category?: "verification" | "lifecycle" | "executor-tool" | "unclassified";
  description?: string;
  enabled?: boolean;
  argv: readonly [string, ...string[]];
  environment?: Readonly<Record<string, string>> | undefined;
  timeoutMs?: number;
};
export type ProcessRunner = (argv: string[], cwd: string, timeoutMs: number, env: Record<string, string>) => Promise<CommandResult>;

/** 只执行已注册的 argv 命令，禁止模型通过字符串拼接调用任意 Shell。 */
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
    if (definition.enabled === false) return Promise.resolve({ exitCode: 126, stdout: "", stderr: `Command ${command.commandId} is disabled` });
    const env: Record<string, string> = { ...(definition.environment ?? {}) };
    // PATH is process resolution infrastructure, not project data; preserve it
    // when a Project command leaves the optional environment block empty.
    if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
    if (!env.Path && process.env.Path) env.Path = process.env.Path;
    Object.assign(env, {
      PIPELINE_PROJECT_ID: command.context.projectId,
      PIPELINE_RUN_ID: command.context.runId,
      PIPELINE_WORKSPACE_PATH: command.context.workspacePath,
      PIPELINE_BRANCH: command.context.branch,
      PIPELINE_BASE_COMMIT: command.context.baseCommit,
      PIPELINE_EXIT_REASON: command.context.exitReason,
    });
    return this.runProcess([...definition.argv], command.cwd, definition.timeoutMs ?? command.timeoutMs, env);
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

/** 工具调用角色；Explorer 和 Executor 使用不同的允许集合。 */
export type ToolRole = "explorer" | "executor";
/** 内置、MCP、Plugin 和宿主工具的统一名称。 */
export type ToolName = "read_file" | "list_files" | "git_status" | "git_diff" | "git_log" | "search_text" | "write_file" | "apply_patch" | "run_command" | "run_registered_command" | "run_verification" | "git_commit" | string;

/** 一次模型发起的工具调用；callId 用于幂等、审计和恢复。 */
export type ToolCall = {
  callId: string;
  tool: ToolName;
  input: Record<string, unknown>;
};

/** 工具调用的归一化结果；禁止、失败和未知副作用必须可区分。 */
export type ToolCallResult = {
  callId: string;
  allowed: boolean;
  status?: "SUCCEEDED" | "DENIED" | "FAILED" | "NEEDS_RECONCILIATION" | undefined;
  reason: string | null;
  result: unknown | null;
  audited: true;
};

/** 持久化工具调用状态；UNKNOWN 不允许静默重放。 */
export type DurableToolCallStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "NEEDS_RECONCILIATION";
/** SQLite 中保存的工具调用事实和输入 hash。 */
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

/** ToolGateway 的角色白名单、工作区边界和外部工具桥接配置。 */
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

/** 汇总 Builtin、MCP、Plugin 和 Computer Use 工具，并执行统一白名单检查。 */
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

/** 模型职责角色；Explorer 只读分析，Executor 在 Run Worktree 中执行。 */
export type ModelRole = "explorer" | "executor";
/** 一个角色的模型和推理/循环策略，来源可为全局默认或 Project 快照。 */
export type ModelRoleConfig = {
  model: string;
  mode?: "plan" | "default" | undefined;
  loopMode?: "provider-controlled" | "factory-controlled" | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  reasoningEffort?: string | undefined;
  developerInstructions?: string | undefined;
};
/** Provider 能力声明，决定结构化输入、工具和 Loop 模式是否可用。 */
export type ModelCapabilities = {
  supportsStructuredUserInput: boolean;
  supportsToolCalls: boolean;
  supportedLoopModes: import("./agent-loop.js").AgentLoopMode[];
};
/** 传给模型的受控工具描述和输入 schema。 */
export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};
/** Provider 会话中的规范化消息。 */
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string };
/** Provider 返回的精确 token 用量；null 表示 Provider 没有返回对应字段。 */
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};
export type ModelUsageScope = "turn" | "total";

/** 执行线程的持久化遥测；不对缺失的 Provider usage 做本地估算。 */
export type ExecutionTelemetry = {
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage | null;
  usageSource: "provider" | "not-recorded";
  usageScope: ModelUsageScope | null;
};

const usageField = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** 兼容 OpenAI snake_case、App Server camelCase 及其嵌套 reasoning 字段。 */
export function normalizeModelUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const outputDetails = candidate.output_tokens_details && typeof candidate.output_tokens_details === "object" ? candidate.output_tokens_details as Record<string, unknown> : {};
  const outputDetailsCamel = candidate.outputTokensDetails && typeof candidate.outputTokensDetails === "object" ? candidate.outputTokensDetails as Record<string, unknown> : {};
  const usage: ModelUsage = {
    inputTokens: usageField(candidate.input_tokens ?? candidate.inputTokens),
    outputTokens: usageField(candidate.output_tokens ?? candidate.outputTokens),
    reasoningTokens: usageField(candidate.reasoning_tokens ?? candidate.reasoningTokens ?? candidate.reasoning_output_tokens ?? candidate.reasoningOutputTokens ?? outputDetails.reasoning_tokens ?? outputDetailsCamel.reasoningTokens),
    totalTokens: usageField(candidate.total_tokens ?? candidate.totalTokens),
  };
  return Object.values(usage).some((item) => item !== null) ? usage : null;
}

/** 聚合多个 Provider turn；total scope 使用 Provider 的累计值而不是重复相加。 */
export function mergeModelUsage(previous: ModelUsage | null, incoming: ModelUsage, scope: ModelUsageScope): ModelUsage {
  if (scope === "total") {
    return {
      inputTokens: incoming.inputTokens ?? previous?.inputTokens ?? null,
      outputTokens: incoming.outputTokens ?? previous?.outputTokens ?? null,
      reasoningTokens: incoming.reasoningTokens ?? previous?.reasoningTokens ?? null,
      totalTokens: incoming.totalTokens ?? previous?.totalTokens ?? null,
    };
  }
  const add = (before: number | null | undefined, after: number | null): number | null => before === null || before === undefined ? after : after === null ? before : before + after;
  return {
    inputTokens: add(previous?.inputTokens, incoming.inputTokens),
    outputTokens: add(previous?.outputTokens, incoming.outputTokens),
    reasoningTokens: add(previous?.reasoningTokens, incoming.reasoningTokens),
    totalTokens: add(previous?.totalTokens, incoming.totalTokens),
  };
}
/** 一次 Explorer/Executor 模型调用的完整上下文。 */
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
/** ModelGateway 输出的统一流事件，供 Agent Loop 和消息流共同消费。 */
export type ModelEvent =
  | { type: "thread.started"; threadId: string }
  | { type: "text.delta"; text: string; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "provider.activity"; phase: "started" | "completed"; itemId: string; itemType: string; title: string | null; summary: string | null; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
  | { type: "model.usage"; usage: ModelUsage; scope: ModelUsageScope; providerThreadId?: string | undefined; providerTurnId?: string | undefined }
  | { type: "tool.call"; call: ToolCall }
  | { type: "turn.input_required"; request: ModelInputRequest }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" };

export interface ModelGateway {
  /** 流式调用模型并按事件顺序返回文本、工具和输入请求。 */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** 将本地脱敏校验后的答案转交给 Provider。 */
  answerUserInput(input: { requestId: string | number; answers: ModelInputAnswers }): Promise<void>;
  /** 取消指定 Provider conversation/turn。 */
  cancel(request: { conversationId: string; providerThreadId: string; providerTurnId?: string }): Promise<void>;
  /** 返回指定角色当前生效的模型配置。 */
  configFor(role: ModelRole): ModelRoleConfig;
  capabilities?(role: ModelRole): ModelCapabilities;
  readRateLimits?(): Promise<MappedCodexRateLimits>;
}

/** 测试用 ModelGateway；保持事件协议但不访问外部模型。 */
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

/** 非流式模型调用的规范化结果。 */
export type ModelResult = { text: string; requestId: string | null; model: string; usage: ModelUsage | null };
/** OpenAI Responses API 的最小响应端口，便于测试替换 fetch。 */
export type ModelFetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
/** 可注入的 HTTP 调用函数，避免 Domain 直接绑定全局 fetch。 */
export type ModelFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal | undefined }) => Promise<ModelFetchResponse>;
/** OpenAI ModelGateway 配置；apiKey 由运行环境提供，不应持久化到 Project。 */
export type OpenAIModelGatewayOptions = { apiKey: string; roles: Record<ModelRole, ModelRoleConfig>; baseUrl?: string | undefined; fetchFn?: ModelFetch | undefined };

/** OpenAI Responses API 适配器；API Key 只从运行时配置读取。 */
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
    return { text: typeof payload.output_text === "string" ? payload.output_text : extractResponseText(payload), requestId: typeof payload.id === "string" ? payload.id : null, model: config.model, usage: normalizeModelUsage(payload.usage) };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) { yield { type: "turn.cancelled" }; return; }
    try {
      const result = await this.complete(request);
      if (result.usage) yield { type: "model.usage", usage: result.usage, scope: "turn", ...(request.providerThreadId ? { providerThreadId: request.providerThreadId } : {}) };
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

/**
 * 运行 Explorer 对话和结构化输入流程，并把 Provider 事件投影为本地消息流。
 * 模型回合结束后必须通过 Plan completeness gate，才会创建 CandidatePlan；普通文本完成不会越过门禁。
 */
export class ExplorerThreadService {
  private readonly jobs = new Map<string, { userId: string; assistantId: string; explorerPlanId: string; loopId?: string | undefined; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean }>();
  private readonly queuedTurns = new Map<string, string[]>();
  private readonly agentLoops: AgentLoopEngine;
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();
  private readonly plans: PlanService;
  private readonly loopMaxSteps: number;
  private readonly titleGenerator: ExplorerTitleGenerator | undefined;
  private readonly cwdForProject: ((projectId: string) => string | undefined) | undefined;
  private readonly modelConfigForProject: ((projectId: string) => ModelRoleConfig | undefined) | undefined;

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, options: { /** @deprecated retained for compatibility; Explorer uses the global model.loop.maxSteps. */ maxAutoContinuationTurns?: number | undefined; maxSteps?: number | undefined; maxDurationMs?: number | undefined; maxRepeatedToolCalls?: number | undefined; maxNoProgressSteps?: number | undefined; titleGenerator?: ExplorerTitleGenerator | undefined; cwdForProject?: ((projectId: string) => string | undefined) | undefined; modelConfigForProject?: ((projectId: string) => ModelRoleConfig | undefined) | undefined } = {}) {
    this.titleGenerator = options.titleGenerator;
    this.cwdForProject = options.cwdForProject;
    this.modelConfigForProject = options.modelConfigForProject;
    this.plans = new PlanService(store);
    this.loopMaxSteps = options.maxSteps ?? 40;
    this.agentLoops = new AgentLoopEngine(store, model, undefined, {
      defaultMaxSteps: this.loopMaxSteps,
      ...(options.maxDurationMs === undefined ? {} : { defaultMaxDurationMs: options.maxDurationMs }),
      ...(options.maxRepeatedToolCalls === undefined ? {} : { defaultMaxRepeatedToolCalls: options.maxRepeatedToolCalls }),
      ...(options.maxNoProgressSteps === undefined ? {} : { defaultMaxNoProgressSteps: options.maxNoProgressSteps }),
    });
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
            if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED");
            recoveredTurnIds.add(turn.id);
          }
          if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
        }
      }
      for (const turn of store.listTurns(thread.id)) {
        if (recoveredTurnIds.has(turn.id) || (turn.status !== "RUNNING" && turn.status !== "WAITING_FOR_INPUT")) continue;
        store.updateTurn({ ...turn, status: "FAILED", error: "EXPLORER_TURN_RECOVERY_REQUIRED", content: turn.content || "模型回合中断，需要重新开始探索" });
        if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED");
        if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
      }
    }
    for (const thread of store.listThreads()) {
      const queued = store.listTurns(thread.id).filter((turn) => turn.role === "assistant" && turn.status === "QUEUED").map((turn) => turn.id);
      if (queued.length) this.queuedTurns.set(thread.id, queued);
    }
  }

  async recoverQueuedTurns(): Promise<void> {
    for (const threadId of this.queuedTurns.keys()) await this.startNextQueuedTurn(threadId);
  }

  async startTurn(input: { threadId: string; explorerPlanId?: string; content: string; clientTurnId: string }): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null }> {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`ExplorerThread ${input.threadId} not found`);
    const prior = this.store.getIdempotency("explorer-turn", input.clientTurnId);
    if (prior) return prior as unknown as { user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null };
    if (thread.state === "ARCHIVED") throw new Error(`ExplorerThread ${input.threadId} is archived`);
    const plan = this.resolveExplorerPlan(thread, input.explorerPlanId);
    const turns = this.store.listTurns(input.threadId);
    const hasActiveJob = this.jobs.has(input.threadId) || this.store.listTurns(input.threadId).some((turn) => turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT");
    const user: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "user", content: input.content, status: "COMPLETED", createdAt: this.store.now(), sequence: turns.length + 1, explorerPlanId: plan.id };
    const assistant: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "assistant", content: "", status: hasActiveJob ? "QUEUED" : "RUNNING", createdAt: this.store.now(), sequence: turns.length + 2, explorerPlanId: plan.id };
    this.store.saveTurn(user);
    this.store.saveTurn(assistant);
    this.store.updateThread({ ...thread, activeExplorerPlanId: plan.id, messageCount: thread.messageCount + 2, lastActivityAt: assistant.createdAt });
    this.store.updateExplorerPlan({ ...plan, messageCount: plan.messageCount + 2, latestUserMessageSummary: summarizeExplorerMessage(input.content), runtimeStatus: assistant.status, lastActivityAt: assistant.createdAt });
    this.scheduleTitleGeneration(thread.id, input.content);
    const accepted = { user, assistant, eventsUrl: `/api/v4/projects/${thread.projectId}/explorer-thread/events?threadId=${encodeURIComponent(thread.id)}` };
    this.publish(this.store.appendEvent({ type: "explorer.turn.accepted", aggregateId: input.threadId, payload: { turnId: assistant.id, userTurnId: user.id, explorerPlanId: plan.id, loopId: null, state: assistant.status } }));
    if (hasActiveJob) {
      const queue = this.queuedTurns.get(thread.id) ?? [];
      queue.push(assistant.id);
      this.queuedTurns.set(thread.id, queue);
      const acceptedWithQueue = { ...accepted, loopId: null };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithQueue as unknown as Record<string, unknown>);
      return acceptedWithQueue;
    }
    const loop = await this.startQueuedTurn(thread.id, assistant.id);
    const acceptedWithLoop = { ...accepted, loopId: loop.id };
    this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithLoop as unknown as Record<string, unknown>);
    return acceptedWithLoop;
  }

  private async startQueuedTurn(threadId: string, assistantId: string): Promise<AgentLoop> {
    const thread = this.store.getThread(threadId);
    const assistant = this.store.listTurns(threadId).find((turn) => turn.id === assistantId && turn.role === "assistant");
    if (!thread || !assistant) throw new Error(`Explorer turn ${assistantId} not found`);
    const plan = this.resolveExplorerPlan(thread, assistant.explorerPlanId);
    if (assistant.status === "QUEUED") this.store.updateTurn({ ...assistant, status: "RUNNING" });
    const job: { userId: string; assistantId: string; explorerPlanId: string; loopId?: string; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean } = { userId: this.store.listTurns(threadId).find((turn) => turn.role === "user" && turn.sequence < assistant.sequence && turn.explorerPlanId === plan.id)?.id ?? "", assistantId, explorerPlanId: plan.id, providerThreadId: thread.providerThreadId, providerTurnId: null, cancelled: false };
    this.jobs.set(threadId, job);
    const user = this.store.listTurns(threadId).find((turn) => turn.id === job.userId);
    const planBoundary = this.planBoundary(thread, plan, user?.content ?? "");
    const loop = await this.agentLoops.start({
      ownerType: "explorer-turn",
      ownerId: assistant.id,
      role: "explorer",
      mode: this.modelConfigForProject?.(thread.projectId)?.loopMode ?? "provider-controlled",
      maxSteps: this.loopMaxSteps,
      modelRequest: { messages: this.store.listTurns(thread.id).filter((turn) => turn.id !== assistant.id && !(turn.role === "assistant" && turn.status === "QUEUED")).map((turn) => ({ role: turn.role, content: turn.content })), conversationId: thread.id, continuationPrompt: planBoundary, ...(thread.providerThreadId ? { providerThreadId: thread.providerThreadId } : {}), ...(this.cwdForProject?.(thread.projectId) ? { cwd: this.cwdForProject(thread.projectId) } : {}), ...(this.modelConfigForProject?.(thread.projectId) ? { modelConfig: this.modelConfigForProject(thread.projectId) } : {}) },
      gate: new PlanCompletenessGate(),
      onEvent: (event) => this.handleExplorerLoopEvent(thread.id, assistant.id, event),
    });
    job.loopId = loop.id;
    this.updatePlanRuntimeStatus(threadId, plan.id, "RUNNING");
    this.publish(this.store.appendEvent({ type: "explorer.turn.started", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: plan.id, loopId: loop.id } }));
    return loop;
  }

  private async startNextQueuedTurn(threadId: string): Promise<void> {
    if (this.jobs.has(threadId)) return;
    const queue = this.queuedTurns.get(threadId) ?? [];
    let assistantId: string | undefined;
    while (queue.length > 0 && !assistantId) {
      const candidateId = queue.shift();
      const candidate = candidateId ? this.store.listTurns(threadId).find((turn) => turn.id === candidateId) : undefined;
      if (candidate?.role === "assistant" && candidate.status === "QUEUED") assistantId = candidate.id;
    }
    if (queue.length === 0) this.queuedTurns.delete(threadId);
    else this.queuedTurns.set(threadId, queue);
    if (!assistantId) return;
    try {
      await this.startQueuedTurn(threadId, assistantId);
    } catch (error) {
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (current) this.store.updateTurn({ ...current, status: "FAILED", error: error instanceof Error ? error.message : String(error), content: "模型调用未能启动" });
      if (current?.explorerPlanId) this.updatePlanRuntimeStatus(threadId, current.explorerPlanId, "FAILED");
      this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: current?.explorerPlanId ?? null, loopId: null, error: error instanceof Error ? error.message : String(error) } }));
      await this.startNextQueuedTurn(threadId);
    }
  }

  private updatePlanRuntimeStatus(threadId: string, explorerPlanId: string, runtimeStatus: NonNullable<ExplorerTurn["status"]>): void {
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== threadId) return;
    this.store.updateExplorerPlan({ ...plan, runtimeStatus, lastActivityAt: this.store.now() });
  }

  private resolveExplorerPlan(thread: ExplorerThread, explorerPlanId?: string): ExplorerPlan {
    const selected = explorerPlanId ? this.store.getExplorerPlan(explorerPlanId) : this.store.getExplorerPlan(thread.activeExplorerPlanId ?? "");
    if (explorerPlanId && (!selected || selected.explorerThreadId !== thread.id || selected.projectId !== thread.projectId)) throw new Error("ExplorerPlan does not belong to this ExplorerThread");
    if (selected && selected.explorerThreadId === thread.id && selected.projectId === thread.projectId) return selected;
    const first = this.store.listExplorerPlans(thread.id)[0];
    if (first) return first;
    const createdAt = this.store.now();
    const created = defaultExplorerPlan(thread, this.store.nextId("explorer-plan"), 1, createdAt);
    this.store.saveExplorerPlan(created);
    this.store.updateThread({ ...thread, activeExplorerPlanId: created.id, contextSummary: { ...(thread.contextSummary ?? defaultThreadContextSummary(createdAt)), openPlanIds: [created.id] } });
    return created;
  }

  private planBoundary(thread: ExplorerThread, plan: ExplorerPlan, content: string): string {
    const firstPlanTurn = this.store.listTurns(thread.id).filter((turn) => turn.explorerPlanId === plan.id && turn.role === "user").length <= 1;
    const summary = thread.contextSummary ? JSON.stringify(thread.contextSummary) : "{}";
    return `[Explorer Plan ${plan.ordinal}: ${plan.title}]\n${firstPlanTurn ? `Thread summary: ${summary}\n` : ""}Only continue the current Explorer Plan. Keep artifacts and decisions scoped to this Plan while retaining the shared ExplorerThread context.\nUser message:\n${content}`;
  }

  async backfillTitles(): Promise<void> {
    if (!this.titleGenerator) return;
    await Promise.all(this.store.listThreads().map(async (thread) => {
      if (thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
      const firstUser = this.store.listTurns(thread.id).find((turn) => turn.role === "user" && turn.content.trim());
      if (!firstUser) return;
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
      this.publish(this.store.appendEvent({ type: "explorer.title.updated", aggregateId: threadId, payload: { explorerId: threadId, explorerPlanId: updated.activeExplorerPlanId, turnId: null, loopId: null, title: updated.title, titleStatus: updated.titleStatus } }));
    } catch {
      const thread = this.store.getThread(threadId);
      if (thread?.titleSource === "AUTO" && thread.titleStatus === "GENERATING") this.store.updateThread({ ...thread, title: projectPlaceholderExplorerTitle(this.store, thread), titleStatus: "FAILED" });
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
      this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: input.threadId, payload: { inputRequestId: request.id, turnId: request.localTurnId, explorerPlanId: request.explorerPlanId ?? null, loopId: job.loopId ?? null, recoveryRequired: true, error: error instanceof Error ? error.message : String(error) } }));
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
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === request.localTurnId && turn.role === "assistant");
    if (!assistant) throw new Error("Assistant turn for input request not found");
    this.store.updateTurn({ ...assistant, status: "RUNNING" });
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "RUNNING");
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: "explorer.turn.input.resolved", aggregateId: input.threadId, payload: { inputRequestId: request.id, turnId: request.localTurnId, explorerPlanId: request.explorerPlanId ?? null, loopId: job.loopId ?? null, actorId: input.actorId, answerCounts: answered.redactedAnswerSummary } }));
    const result = { request: answered, turn: { ...assistant, status: "RUNNING" as const } };
    this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
    return result;
  }

  async cancelTurn(input: { threadId: string; turnId: string; reason: string }): Promise<ExplorerTurn> {
    const job = this.jobs.get(input.threadId);
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === input.turnId && turn.role === "assistant");
    if (!assistant) throw new Error("Active Explorer turn not found");
    if (!job || job.assistantId !== assistant.id) {
      const queue = this.queuedTurns.get(input.threadId) ?? [];
      if (assistant.status !== "QUEUED" || !queue.includes(assistant.id)) throw new Error("Active Explorer turn not found");
      this.queuedTurns.set(input.threadId, queue.filter((id) => id !== assistant.id));
      const cancelledQueued = { ...assistant, status: "CANCELLED" as const, content: "本轮已取消", error: input.reason };
      this.store.updateTurn(cancelledQueued);
      if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED");
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: input.threadId, payload: { turnId: input.turnId, explorerPlanId: assistant.explorerPlanId ?? null, loopId: null, reason: input.reason } }));
      return cancelledQueued;
    }
    job.cancelled = true;
    if (job.loopId) await this.agentLoops.cancel(job.loopId, input.reason);
    else if (job.providerThreadId) await this.model.cancel({ conversationId: input.threadId, providerThreadId: job.providerThreadId, ...(job.providerTurnId ? { providerTurnId: job.providerTurnId } : {}) });
    for (const request of this.store.listInputRequests(input.threadId, "OPEN")) if (request.localTurnId === assistant.id) this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
    job.resolveInput?.();
    const cancelled: ExplorerTurn = { ...assistant, status: "CANCELLED", content: "本轮已取消", error: input.reason };
    this.store.updateTurn(cancelled);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED");
    this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: input.threadId, payload: { turnId: input.turnId, explorerPlanId: assistant.explorerPlanId ?? null, loopId: job.loopId ?? null, reason: input.reason } }));
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
    const pausedTurn = this.store.listTurns(threadId).find((turn) => turn.id === turnId);
    this.publish(this.store.appendEvent({ type: "explorer.thread.state.changed", aggregateId: threadId, payload: { state: "PAUSED", loopId, turnId, explorerPlanId: pausedTurn?.explorerPlanId ?? null, reason } }));
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
      const providerThreadId = typeof event.payload.providerThreadId === "string" ? event.payload.providerThreadId : null;
      if (providerThreadId) {
        const currentThread = this.store.getThread(threadId);
        if (currentThread && currentThread.providerThreadId !== providerThreadId) this.store.updateThread({ ...currentThread, providerThreadId, lastActivityAt: this.store.now() });
      }
      this.store.updateTurn({ ...current, content: current.content + text, status: "RUNNING" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "RUNNING");
      this.publish(this.store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, text } }));
      return;
    }
    if (event.type === "agent.input.required") {
      const request = event.payload.request as ModelInputRequest | undefined;
      if (!request) return;
      job.providerThreadId = request.threadId;
      job.providerTurnId = request.turnId;
      const inputRequest: ExplorerInputRequest = { id: this.store.nextId("input"), threadId, explorerPlanId: job.explorerPlanId, localTurnId: assistantId, providerRequestId: request.requestId, providerThreadId: request.threadId, providerTurnId: request.turnId, itemId: request.itemId, questions: request.questions, isBlocking: request.isBlocking, autoResolutionMs: request.autoResolutionMs, status: "OPEN", createdAt: this.store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null };
      const saved = this.store.saveInputRequest(inputRequest);
      const currentThread = this.store.getThread(threadId);
      if (currentThread) this.store.updateThread({ ...currentThread, state: "WAITING_FOR_INPUT", lastActivityAt: this.store.now() });
      const currentTurn = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (currentTurn) this.store.updateTurn({ ...currentTurn, status: "WAITING_FOR_INPUT" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "WAITING_FOR_INPUT");
      this.publish(this.store.appendEvent({ type: "explorer.turn.input_required", aggregateId: threadId, payload: { requestId: saved.id, threadId, turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, localTurnId: assistantId, providerRequestId: saved.providerRequestId, providerThreadId: saved.providerThreadId, providerTurnId: saved.providerTurnId, itemId: saved.itemId, questions: saved.questions, isBlocking: saved.isBlocking, autoResolutionMs: saved.autoResolutionMs } }));
      return;
    }
    if (event.type === "agent.loop.completed") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    if (event.type === "agent.loop.cancelled") {
      for (const request of this.store.listInputRequests(threadId)) if (request.localTurnId === assistantId && (request.status === "OPEN" || request.status === "SUBMITTING")) this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
      const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (current && current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "CANCELLED", content: current.content || "本轮已取消" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "CANCELLED");
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, reason: event.payload.reason } }));
      this.finishExplorerJob(threadId);
      return;
    }
    if (event.type === "agent.loop.failed") this.handleExplorerLoopFailure(threadId, assistantId, String(event.payload.error ?? event.payload.reason ?? "AgentLoop failed"));
  }

  private finalizeExplorerLoop(threadId: string, assistantId: string): void {
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const thread = this.store.getThread(threadId);
    if (!current || !thread) return;
    const explorerPlan = this.resolveExplorerPlan(thread, current.explorerPlanId);
    const assessment = assessPlanCompletion(current.content);
    const updatedPlan = this.store.updateExplorerPlan({ ...explorerPlan, exploration: { ...explorerPlan.exploration, status: assessment.status, missing: assessment.missing, completed: assessment.completed, diagnostics: assessment.diagnostics, lastAssessedTurnId: assistantId }, lastAssessedTurnId: assistantId, runtimeStatus: "COMPLETED", lastActivityAt: this.store.now() });
    const mirror = { status: assessment.status, missing: assessment.missing, completed: assessment.completed, diagnostics: assessment.diagnostics, candidatePlanId: explorerPlan.candidatePlanId, lastAssessedTurnId: assistantId };
    this.updateThreadContextSummary(threadId, updatedPlan, assessment.artifact?.contract?.goal ?? assessment.artifact?.generatedSpec?.objective?.goal ?? null);
    const currentThread = this.store.getThread(threadId) ?? thread;
    this.store.updateThread({ ...currentThread, ...(currentThread.activeExplorerPlanId === explorerPlan.id ? { exploration: mirror } : {}), lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: assessment.status === "READY" ? "explorer.plan.ready" : "explorer.plan.incomplete", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: explorerPlan.id, missing: assessment.missing, completed: assessment.completed, diagnostics: assessment.diagnostics } }));
    if (assessment.status === "READY" && assessment.artifact) {
      const source = this.planSource(assistantId);
      const activeDraftId = thread.activeRevisionDraftId && (this.store.getRevisionDraft(thread.activeRevisionDraftId)?.explorerPlanId === undefined || this.store.getRevisionDraft(thread.activeRevisionDraftId)?.explorerPlanId === explorerPlan.id) ? thread.activeRevisionDraftId : null;
      if (activeDraftId) {
        this.plans.updateRevisionDraftFromExplorer(activeDraftId, assessment.artifact, source);
        const revisedPlan = this.store.getRevisionDraft(activeDraftId)?.planId ?? null;
        const planAfterDraft = this.store.getExplorerPlan(explorerPlan.id);
        if (planAfterDraft) this.store.updateExplorerPlan({ ...planAfterDraft, exploration: { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], candidatePlanId: revisedPlan, lastAssessedTurnId: assistantId }, candidatePlanId: revisedPlan, newPlanRequested: false, lastAssessedTurnId: assistantId, lastActivityAt: this.store.now() });
      } else {
        const existing = explorerPlan.candidatePlanId ? this.store.getPlan(explorerPlan.candidatePlanId) : undefined;
        const plan = existing?.status === "DRAFT" ? this.plans.reviseCandidate(existing.id, assessment.artifact, source) : this.plans.createCandidatePlan({ projectId: thread.projectId, sourceExplorerThreadId: threadId, explorerPlanId: explorerPlan.id, title: assessment.artifact.title, ...(assessment.artifact.generatedSpec ? { generatedSpec: assessment.artifact.generatedSpec } : { contract: assessment.artifact.contract }), ...source });
        const planAfterCandidate = this.store.updateExplorerPlan({ ...this.store.getExplorerPlan(explorerPlan.id)!, exploration: { status: "READY", missing: [], completed: [...REQUIRED_PLAN_AREAS], diagnostics: [], candidatePlanId: plan.id, lastAssessedTurnId: assistantId }, candidatePlanId: plan.id, newPlanRequested: false, lastAssessedTurnId: assistantId, lastActivityAt: this.store.now() });
        this.updateThreadContextSummary(threadId, planAfterCandidate, plan.contract.goal ?? null);
        const latestThread = this.store.getThread(threadId)!;
        if (latestThread.activeExplorerPlanId === explorerPlan.id) this.store.updateThread({ ...latestThread, exploration: planAfterCandidate.exploration, lastActivityAt: this.store.now() });
      }
    }
    this.store.updateTurn({ ...current, status: "COMPLETED", content: stripPlanProtocol(current.content) });
    this.publish(this.store.appendEvent({ type: "explorer.turn.completed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: explorerPlan.id, loopId: this.jobs.get(threadId)?.loopId ?? null, planReady: assessment.status === "READY" } }));
    this.finishExplorerJob(threadId);
  }

  private handleExplorerLoopFailure(threadId: string, assistantId: string, error: string): void {
    if (error === "MAX_STEPS_EXCEEDED" || error === "NO_PROGRESS") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    for (const request of this.store.listInputRequests(threadId)) if (request.localTurnId === assistantId && (request.status === "OPEN" || request.status === "SUBMITTING")) this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const job = this.jobs.get(threadId);
    if (current && current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "FAILED", error, content: current.content || `模型调用失败：${error}` });
    if (job) this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "FAILED");
    this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: job?.explorerPlanId ?? current?.explorerPlanId ?? null, loopId: job?.loopId ?? null, error } }));
    this.finishExplorerJob(threadId);
  }

  private finishExplorerJob(threadId: string): void {
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: this.store.now() });
    this.jobs.delete(threadId);
    void this.startNextQueuedTurn(threadId);
  }

  private updateThreadContextSummary(threadId: string, changedPlan: ExplorerPlan, goal: string | null): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const plans = this.store.listExplorerPlans(threadId).map((plan) => plan.id === changedPlan.id ? changedPlan : plan);
    const completedPlans = plans.filter((plan) => plan.exploration.status === "READY").map((plan) => {
      const candidate = plan.candidatePlanId ? this.store.getPlan(plan.candidatePlanId) : undefined;
      const resolvedGoal = goal && plan.id === changedPlan.id ? goal : candidate?.contract.goal ?? null;
      const keyConstraints = candidate?.generatedSpec?.design.technicalConstraints ?? [];
      return { explorerPlanId: plan.id, title: plan.title, status: plan.exploration.status, goal: resolvedGoal, keyConstraints: [...keyConstraints], latestUserMessageSummary: plan.latestUserMessageSummary };
    });
    const contextSummary: ExplorerThreadContextSummary = { version: 1, updatedAt: this.store.now(), completedPlans, openPlanIds: plans.filter((plan) => plan.exploration.status !== "READY").map((plan) => plan.id) };
    this.store.updateThread({ ...thread, contextSummary });
  }

  private planSource(assistantId: string): { sourceTurnId: string; providerThreadId: string | null; providerTurnId: string | null; providerItemId: string | null } {
    const loop = this.store.listAgentLoops(assistantId).at(-1);
    const steps = loop ? this.store.listAgentLoopSteps(loop.id) : [];
    const latestTextStep = [...steps].reverse().find((step) => step.stepType === "MODEL_TEXT_DELTA" && typeof step.payload.providerItemId === "string");
    const latestProviderStep = latestTextStep ?? [...steps].reverse().find((step) => typeof step.payload.providerItemId === "string" || typeof step.payload.itemId === "string");
    const providerThreadId = loop?.providerThreadId ?? [...steps].reverse().find((step) => step.providerThreadId)?.providerThreadId ?? null;
    const providerTurnId = loop?.providerTurnId ?? [...steps].reverse().find((step) => step.providerTurnId)?.providerTurnId ?? null;
    const providerItemId = typeof latestProviderStep?.payload.providerItemId === "string"
      ? latestProviderStep.payload.providerItemId
      : typeof latestProviderStep?.payload.itemId === "string" ? latestProviderStep.payload.itemId : null;
    return { sourceTurnId: assistantId, providerThreadId, providerTurnId, providerItemId };
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

/** Run 的执行、验证、合并和恢复状态；BLOCKED 需要人工关注。 */
export type RunStatus = "QUEUED" | "STARTING" | "IN_PROGRESS" | "READY_FOR_VERIFY" | "VERIFYING" | "MERGE_READY" | "BLOCKED" | "NEEDS_PLAN_CHANGE" | "STALE" | "RECOVERING" | "CANCELLED";
/** ExecutionThread 的展示状态，承载 Run 的实时模型输出和控制事实。 */
export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";
/** Run journal 中可回放的事件类别。 */
export type JournalEntryType = "RUN_CREATED" | "HOOK_COMPLETED" | "HOOK_FAILED" | "HOOK_SKIPPED" | "MODEL_OUTPUT" | "TOOL_CALL" | "TASK_PROGRESS" | "USER_GUIDANCE" | "REPAIR" | "VERIFICATION" | "COMMIT" | "RECOVERY";

/** 一条 Execution journal 事实；payload 供详情页诊断而不是控制状态的唯一来源。 */
export type ExecutionJournalEntry = {
  sequence: number;
  type: JournalEntryType;
  occurredAt: string;
  payload: Record<string, unknown>;
};

/** Run 专属的执行消息流聚合。 */
export type ExecutionThread = {
  id: string;
  runId: string;
  state: ExecutionThreadState;
  journal: ExecutionJournalEntry[];
  telemetry?: ExecutionTelemetry | null;
};

/** 运行实例；projectId、planRevision 和 workspacePath 共同确定执行边界。 */
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

/** 一个 Run 的 Git Worktree 事实。 */
export type Workspace = { path: string; branch: string; baseCommit: string };
/** Worktree 创建/移除端口；实现必须使用 Revision 快照中的路径。 */
export type WorkspaceAdapter = {
  create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace>;
  remove(workspace: Workspace): Promise<void>;
};

/** 可注入的 Git 命令执行端口。 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<CommandResult>;
/** 本地 Git Worktree 适配器配置。 */
export type LocalGitWorktreeOptions = { projectRoot: string; worktreeRoot: string; runGit?: GitCommandRunner | undefined };

/** 使用 Git 创建和移除 Run 专属 Worktree；执行目录与只读 Explorer 的 repoRoot 分离。 */
export class LocalGitWorktreeAdapter implements WorkspaceAdapter {
  private readonly runGit: GitCommandRunner;

  constructor(private readonly options: LocalGitWorktreeOptions) {
    this.runGit = options.runGit ?? defaultGitCommand;
  }

  async create(input: { projectId: string; runId: string; branch: string; baseCommit: string }): Promise<Workspace> {
    const branchLeaf = input.branch.slice(input.branch.lastIndexOf("/") + 1);
    const workspaceName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchLeaf) ? branchLeaf : input.runId;
    const path = resolve(this.options.worktreeRoot, workspaceName);
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
  branchNameGenerator?: RunBranchNameGenerator;
  executor?: {
    start(run: Run, revision: PlanRevisionV2): Promise<AgentLoop>;
    pause?: AgentLoopRunner["pause"];
    resume?: AgentLoopRunner["resume"];
    cancel?: AgentLoopRunner["cancel"];
  };
};

/**
 * 协调 Plan 队列、Worktree、Hook、Executor、Verification 和 Run 状态。
 * 调度使用 Revision 中冻结的 Project 快照，不重新读取当前 Project 配置。
 */
export class Scheduler {
  private readonly planService: PlanService;
  private readonly runs = new Map<string, Run>();
  private readonly threads = new Map<string, ExecutionThread>();

  constructor(private readonly options: SchedulerOptions) {
    this.planService = new PlanService(options.store);
  }

  /** @deprecated Capacity limits are ignored; this remains for old configuration readers. */
  globalConcurrency(): number | undefined {
    return undefined;
  }

  /** 暴露 Executor Loop 的控制端口，供 API 的暂停、恢复和终止按钮调用。 */
  agentLoopController(): Pick<AgentLoopRunner, "pause" | "resume" | "cancel"> | undefined {
    const executor = this.options.executor;
    if (!executor?.pause || !executor.resume || !executor.cancel) return undefined;
    return { pause: executor.pause.bind(executor), resume: executor.resume.bind(executor), cancel: executor.cancel.bind(executor) };
  }

  /** 每个不可变 Plan Revision 最多创建一个 Run；失败重试复用原 Run 和 ExecutionThread。 */
  async start(planId: string, hooks: { start?: HookDefinition | undefined; cleanup?: HookDefinition | undefined } = {}): Promise<Run> {
    const plan = this.planService.get(planId);
    const existing = this.options.store.listRuns().find((run) => run.planId === planId && run.planRevision === plan.revision);
    if (existing) {
      this.runs.set(existing.id, existing);
      const savedThread = this.options.store.getExecutionThread(existing.executionThreadId);
      if (savedThread) this.threads.set(savedThread.id, savedThread);
      return existing;
    }
    if (plan.status !== "DISPATCHED") throw new Error(`Plan ${planId} must be dispatched before a run starts`);
    const revision = this.options.store.getRevision(plan.id, plan.revision);
    if (!revision) throw new Error(`Plan revision ${plan.id}@${plan.revision} is missing`);
    this.assertVerificationCommands(revision);
    const createdAt = this.options.store.now();
    const baseBranchLeaf = await this.runBranchLeaf(plan, revision, createdAt);
    const createOrReuse = (): { run: Run; thread: ExecutionThread; created: boolean } => {
      const raced = this.options.store.listRuns().find((run) => run.planId === planId && run.planRevision === revision.revision);
      if (raced) return { run: raced, thread: this.options.store.getExecutionThread(raced.executionThreadId) ?? { id: raced.executionThreadId, runId: raced.id, state: "ACTIVE", journal: [] }, created: false };
      const branchLeaf = allocateRunBranchLeaf(baseBranchLeaf, this.options.store.listRuns().map((run) => run.branch));
      const runId = this.options.store.nextId("run");
      const thread: ExecutionThread = { id: this.options.store.nextId("execution-thread"), runId, state: "ACTIVE", journal: [] };
      const run: Run = { id: runId, projectId: plan.projectId, planId: plan.id, planRevision: revision.revision, status: "STARTING", branch: runBranchName(branchLeaf), workspacePath: null, baseCommit: revision.contract.baseCommit, executionThreadId: thread.id, createdAt, startedAt: null };
      this.options.store.saveRun(run);
      this.options.store.saveExecutionThread(thread);
      this.append(thread.id, "RUN_CREATED", { planId: plan.id, revision: revision.revision });
      return { run, thread, created: true };
    };
    const record = this.options.store.runInTransaction ? this.options.store.runInTransaction(createOrReuse) : createOrReuse();
    const { run, thread } = record;
    this.runs.set(run.id, run);
    this.threads.set(thread.id, thread);
    if (!record.created) return run;
    const workspaceAdapter = this.workspaceAdapterFor(revision);
    const hookRunner = this.hookRunnerFor(revision);
    const executionHooks = revision.projectConfigSnapshot?.settings.hooks ?? hooks;
    // Worktree、Start Hook 和 Executor 按顺序执行：任何前置阶段失败都阻止模型写入，
    // 同时把 BLOCKED 事实写回 Plan 和 ExecutionThread，便于 UI 显示可诊断原因。
    const workspace = await workspaceAdapter.create({ projectId: plan.projectId, runId: run.id, branch: run.branch, baseCommit: run.baseCommit });
    run.workspacePath = workspace.path;
    const startResult = await hookRunner.runStart(executionHooks.start, { projectId: plan.projectId, runId: run.id, workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit, exitReason: "running" });
    this.recordHookExecutions(run.id, startResult);
    if (startResult.status === "failed") {
      run.status = "BLOCKED";
      thread.state = "BLOCKED";
      this.setThreadState(thread.id, "BLOCKED");
      this.append(thread.id, "HOOK_FAILED", { hook: "start", stderr: startResult.result?.stderr ?? "" });
      updatePlanStatus(this.options.store, plan, { runId: run.id, status: "BLOCKED", attentionReason: "start hook failed", lastEventAt: this.options.store.now() }, "start hook failed");
      this.options.store.saveRun(run);
      return run;
    }
    run.status = "IN_PROGRESS";
    run.startedAt = this.options.store.now();
    this.append(thread.id, startResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "start" });
    if (!revision.projectConfigSnapshot) this.append(thread.id, "TASK_PROGRESS", { action: "legacy_plan_revision", reason: "Project configuration snapshot unavailable; using legacy/global runtime settings" });
    updatePlanStatus(this.options.store, plan, { runId: run.id, status: "IN_PROGRESS", lastEventAt: run.startedAt });
    this.options.store.saveRun(run);
    if (this.options.executor) {
      try {
        const loop = await this.options.executor.start(run, revision);
        this.append(thread.id, "TASK_PROGRESS", { action: "executor_loop_created", loopId: loop.id });
        this.options.store.appendEvent({ type: "run.executor.event", aggregateId: run.id, payload: { executionThreadId: thread.id, action: "executor_loop_created", loopId: loop.id } });
      } catch (error) {
        run.status = "BLOCKED";
        this.setThreadState(thread.id, "BLOCKED");
        const reason = error instanceof Error ? error.message : String(error);
        this.append(thread.id, "RECOVERY", { action: "executor_loop_start_failed", reason });
        updatePlanStatus(this.options.store, plan, { runId: run.id, status: "BLOCKED", attentionReason: reason, lastEventAt: this.options.store.now() }, reason);
        this.options.store.saveRun(run);
      }
    }
    return run;
  }

  private async runBranchLeaf(plan: CandidatePlan, revision: PlanRevisionV2, createdAt: string): Promise<string> {
    let summary = normalizeRunBranchSlug(plan.title) ?? "change";
    if (this.options.branchNameGenerator) {
      try {
        summary = await this.options.branchNameGenerator.generate({ createdAt, planTitle: plan.title, goal: revision.contract.goal });
      } catch {
        summary = "change";
      }
    }
    return composeRunBranchLeaf(createdAt, summary);
  }

  /** 完成或取消 Run，按同一 Revision 执行 Worktree 清理和 Cleanup Hook。 */
  async finish(runId: string, exitReason: string, hooks: { cleanup?: HookDefinition | undefined } = {}, cancellationReason = exitReason): Promise<Run> {
    const run = this.run(runId);
    if (run.status === "CANCELLED") {
      if (exitReason === "cancelled") {
        const plan = this.options.store.getPlan(run.planId);
        if (plan && plan.status !== "BLOCKED" && plan.status !== "MERGED") {
          updatePlanStatus(this.options.store, plan, { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() }, `Run cancelled: ${cancellationReason}`);
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
    this.recordHookExecutions(run.id, cleanupResult);
    this.append(thread.id, cleanupResult.status === "failed" ? "HOOK_FAILED" : cleanupResult.status === "skipped" ? "HOOK_SKIPPED" : "HOOK_COMPLETED", { hook: "cleanup", exitReason });
    if (cleanupResult.needsAttention) {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) this.options.store.updatePlan({ ...plan, attentionReason: "cleanup hook failed", lastEventAt: this.options.store.now() });
    }
    if (exitReason === "cancelled") run.status = "CANCELLED";
    this.setThreadState(thread.id, exitReason === "cancelled" ? "CANCELLED" : "COMPLETED");
    this.options.store.saveRun(run);
    if (exitReason === "cancelled") {
      const plan = this.options.store.getPlan(run.planId);
      if (plan) updatePlanStatus(this.options.store, plan, { status: "BLOCKED", attentionReason: `Run cancelled: ${cancellationReason}`, lastEventAt: this.options.store.now() }, `Run cancelled: ${cancellationReason}`);
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

  /** 暂停活动 Run；暂停事实写入 ExecutionThread，便于恢复和审计。 */
  pause(runId: string): Run {
    const run = this.run(runId);
    if (run.status !== "IN_PROGRESS") throw new Error(`Run ${runId} cannot be paused from ${run.status}`);
    const thread = this.thread(run.executionThreadId);
    if (thread.state !== "ACTIVE") throw new Error(`ExecutionThread ${thread.id} cannot be paused from ${thread.state}`);
    this.setThreadState(thread.id, "PAUSED");
    this.append(thread.id, "TASK_PROGRESS", { action: "paused", runId });
    this.options.store.appendEvent({ type: "run.paused", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  /** 恢复已暂停 Run；仅允许 ACTIVE/PAUSED 的合法状态转换。 */
  resume(runId: string): Run {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (run.status !== "IN_PROGRESS" || thread.state !== "PAUSED") throw new Error(`Run ${runId} cannot be resumed from ${run.status}/${thread.state}`);
    this.setThreadState(thread.id, "ACTIVE");
    this.append(thread.id, "TASK_PROGRESS", { action: "resumed", runId });
    this.options.store.appendEvent({ type: "run.resumed", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.options.store.saveRun(run);
  }

  /** 向执行消息流追加人工指导，不改写已确认的 PlanRevision。 */
  addGuidance(runId: string, content: string): ExecutionThread {
    const run = this.run(runId);
    const thread = this.thread(run.executionThreadId);
    if (thread.state === "CANCELLED" || thread.state === "COMPLETED") throw new Error(`Run ${runId} is no longer accepting guidance`);
    this.append(thread.id, "USER_GUIDANCE", { content, runId });
    this.options.store.appendEvent({ type: "run.guidance.added", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return thread;
  }

  /** 读取 Run 的 ExecutionThread。 */
  thread(threadId: string): ExecutionThread {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) throw new Error(`ExecutionThread ${threadId} not found`);
    this.threads.set(threadId, thread);
    return thread;
  }

  /** 读取 Run 并同步到 Scheduler 的短期缓存。 */
  run(runId: string): Run {
    const run = this.options.store.getRun(runId) ?? this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    this.runs.set(runId, run);
    return run;
  }

  private append(threadId: string, type: JournalEntryType, payload: Record<string, unknown>): void {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (!thread) return;
    this.options.store.appendExecutionJournal({ executionThreadId: thread.id, runId: thread.runId, type, payload });
  }

  private recordHookExecutions(runId: string, result: HookRunResult): void {
    for (const attempt of result.attempts) {
      const commandResult = attempt.result;
      this.options.store.saveHookExecution({
        id: `hook-execution-${runId}-${result.hook}-${attempt.attempt}`,
        runId,
        hookType: result.hook,
        attempt: attempt.attempt,
        commandId: attempt.commandId,
        cwd: attempt.cwd,
        timeoutMs: attempt.timeoutMs,
        status: attempt.status,
        exitCode: commandResult?.exitCode ?? null,
        stdout: commandResult?.stdout ?? "",
        stderr: commandResult?.stderr ?? "",
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
      });
    }
  }

  private setThreadState(threadId: string, state: ExecutionThreadState): void {
    const thread = this.options.store.getExecutionThread(threadId) ?? this.threads.get(threadId);
    if (thread) this.options.store.saveExecutionThread({ ...thread, state });
  }

  private assertVerificationCommands(revision: PlanRevisionV2): void {
    const snapshot = revision.projectConfigSnapshot;
    if (!snapshot) return;
    const registered = new Set(snapshot.settings.commands.map((command) => command.commandId));
    const missing = revision.contract.verificationCommandIds.filter((commandId) => !registered.has(commandId));
    if (missing.length > 0) throw new Error(`RUN_PREREQUISITES_UNSATISFIED: missing registered commands: ${missing.join(", ")}`);
  }
}

export type VerificationStatus = "PASSED" | "SKIPPED" | "FAILED" | "BLOCKED";
/** 单次验证及其修复尝试结果。 */
export type VerificationRun = {
  id: string;
  runId: string;
  status: VerificationStatus;
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: CommandResult }>;
  reason?: "NO_PROJECT_VERIFICATION_COMMANDS";
  completedAt: string;
};
/** 按 Project/Plan 注册命令执行验证的端口。 */
export type VerificationCommandExecutor = (commandId: string, run: Run) => Promise<CommandResult>;
/** 验证失败后的受控修复端口。 */
export type RepairExecutor = (run: Run, attempt: number) => Promise<boolean>;

/** 脱离模型会话执行确定性验证，并按 Revision 的 repair limit 控制修复重试。 */
export class VerificationService {
  constructor(private readonly store?: PipelineStore) {}

  /** 执行验证命令，失败时最多按 Plan contract 重试 repair。 */
  async verify(run: Run, revision: PlanRevisionV2, execute: VerificationCommandExecutor, repair?: RepairExecutor): Promise<VerificationRun> {
    if (run.status !== "IN_PROGRESS" && run.status !== "READY_FOR_VERIFY") throw new Error(`Run ${run.id} cannot be verified from ${run.status}`);
    run.status = "VERIFYING";
    this.store?.saveRun(run);
    const verifyingPlan = this.store?.getPlan(run.planId);
    if (this.store && verifyingPlan && verifyingPlan.runId === run.id) {
      updatePlanStatus(this.store, verifyingPlan, { status: "VERIFYING", lastEventAt: this.store.now() });
    }
    const v2Commands = revision.resolvedContract?.verification.commandIds;
    const commandIds = v2Commands ?? revision.contract.verificationCommandIds;
    if (revision.resolvedContract?.verification.mode === "NONE" || commandIds.length === 0) {
      run.status = "MERGE_READY";
      const verification: VerificationRun = { id: `verification-${randomUUID().slice(0, 12)}`, runId: run.id, status: "SKIPPED", reason: "NO_PROJECT_VERIFICATION_COMMANDS", repairAttempts: 0, commandResults: [], completedAt: this.store?.now() ?? new Date().toISOString() };
      this.record(run, verification);
      return verification;
    }
    const commandResults: Array<{ commandId: string; result: CommandResult }> = [];
    let repairAttempts = 0;
    for (;;) {
      commandResults.length = 0;
      let failed = false;
      for (const commandId of commandIds) {
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
      updatePlanStatus(this.store, plan, {
        status: verification.status === "PASSED" || verification.status === "SKIPPED" ? "MERGE_READY" : "BLOCKED",
        attentionReason: verification.status === "PASSED" || verification.status === "SKIPPED" ? null : "Verification failed",
        lastEventAt: verification.completedAt,
      }, verification.status === "PASSED" || verification.status === "SKIPPED" ? null : "Verification failed");
    }
    const thread = this.store.getExecutionThread(run.executionThreadId);
    if (thread) {
      this.store.appendExecutionJournal({ executionThreadId: thread.id, runId: thread.runId, type: "VERIFICATION", occurredAt: verification.completedAt, payload: verification });
    }
    this.store.appendEvent({ type: "verification.completed", aggregateId: run.id, payload: { ...verification, planId: run.planId, revision: run.planRevision } });
  }
}

/** 等待人工确认的源提交与目标分支关系。 */
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
  /** 最近一次只读 Git reconciliation 观察到的目标提交；人工创建的请求为空。 */
  detectedTargetCommit?: string | null;
};

export type MergeReconciliationOutcome = "DETECTED" | "ALREADY_OPEN" | "NOT_MERGED" | "UNAVAILABLE" | "ALREADY_MERGED";

export type MergeReconciliationItem = {
  runId: string;
  planId: string;
  outcome: MergeReconciliationOutcome;
  mergeRequest: MergeRequest | null;
  sourceCommit: string | null;
  targetBranch: string | null;
  targetCommit: string | null;
  reason: string | null;
};

export type MergeReconciliationReport = {
  projectId: string;
  checkedAt: string;
  items: MergeReconciliationItem[];
};

/** Merge 前必须由 Git 证明源提交和目标分支的关系；测试可注入确定性实现。 */
export type GitMergeInspector = {
  commitExists(repoRoot: string, commit: string): boolean;
  resolveCommit(repoRoot: string, ref: string): string | null;
  isAncestor(repoRoot: string, sourceCommit: string, targetCommit: string): boolean;
  branchContains(repoRoot: string, targetBranch: string, targetCommit: string): boolean;
};

function gitCommand(repoRoot: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function gitResolveCommit(repoRoot: string, ref: string): string | null {
  if (!existsSync(repoRoot)) return null;
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** 默认 Git 证据实现；无效的旧测试路径交由 Project API 的仓库校验拦截。 */
export const localGitMergeInspector: GitMergeInspector = {
  commitExists(repoRoot, commit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  },
  resolveCommit(repoRoot, ref) {
    return gitResolveCommit(repoRoot, ref);
  },
  isAncestor(repoRoot, sourceCommit, targetCommit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["merge-base", "--is-ancestor", sourceCommit, targetCommit]);
  },
  branchContains(repoRoot, targetBranch, targetCommit) {
    if (!existsSync(repoRoot)) return true;
    return gitCommand(repoRoot, ["merge-base", "--is-ancestor", targetCommit, targetBranch]);
  },
};

/** 创建并确认人工 MergeRequest；Factory 不替用户直接改写目标分支。 */
export class MergeService {
  constructor(private readonly store: PipelineStore, private readonly options: { git?: GitMergeInspector } = {}) {}

  /** 为验证通过的 Run 创建幂等 MergeRequest。 */
  createRequest(run: Run, verification: VerificationRun, sourceCommit: string): MergeRequest {
    if (run.status !== "MERGE_READY" || (verification.status !== "PASSED" && verification.status !== "SKIPPED")) throw new Error("MergeRequest requires completed verification evidence");
    if (verification.runId !== run.id) throw new Error("Verification evidence must belong to the same run");
    const existing = this.store.findMergeRequestByRun(run.id);
    if (existing) return existing;
    const project = this.store.getProject(run.projectId);
    if (project && this.options.git && !this.options.git.commitExists(project.repoRoot, sourceCommit)) {
      throw new Error(`Source commit ${sourceCommit} could not be verified in the project repository`);
    }
    return this.createOpenRequest(run, sourceCommit, null);
  }

  /** 按当前 Project 的 Git 事实补齐外部合并证据，但绝不自动改变 Plan 状态。 */
  reconcileProject(projectId: string): MergeReconciliationReport {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const items = this.store.listRuns()
      .filter((run) => run.projectId === projectId && run.status === "MERGE_READY")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((run) => this.reconcileRun(project, run));
    return { projectId, checkedAt: new Date().toISOString(), items };
  }

  /** 查找 Run 对应的 MergeRequest。 */
  findByRun(runId: string): MergeRequest | undefined { return this.store.findMergeRequestByRun(runId); }
  /** 按 id 读取 MergeRequest。 */
  get(requestId: string): MergeRequest | undefined { return this.store.getMergeRequest(requestId); }
  /** 列出全部 MergeRequest 供人工审核台使用。 */
  list(): MergeRequest[] { return this.store.listMergeRequests(); }

  /** 只有目标提交与已审核源提交一致时才确认合并。 */
  confirmMerged(requestId: string, targetCommit: string): MergeRequest {
    const request = this.store.getMergeRequest(requestId);
    if (!request) throw new Error(`MergeRequest ${requestId} not found`);
    if (request.status === "MERGED") return request;
    if (!this.options.git && targetCommit !== request.sourceCommit) throw new Error("Target commit does not match the reviewed source commit");
    const plan = this.store.getPlan(request.planId);
    const project = plan ? this.store.getProject(plan.projectId) : undefined;
    if (project && this.options.git) {
      if (!this.options.git.commitExists(project.repoRoot, targetCommit)) throw new Error(`Target commit ${targetCommit} could not be verified in the project repository`);
      if (!this.options.git.isAncestor(project.repoRoot, request.sourceCommit, targetCommit)) throw new Error("Source commit is not an ancestor of the target commit");
      if (!this.options.git.branchContains(project.repoRoot, request.targetBranch, targetCommit)) throw new Error("Target branch does not contain the reviewed source commit");
    }
    const merged = { ...request, status: "MERGED" as const, mergedAt: new Date().toISOString() };
    this.store.updateMergeRequest(merged);
    if (plan) updatePlanStatus(this.store, plan, { status: "MERGED", lastEventAt: merged.mergedAt ?? plan.lastEventAt });
    this.store.appendEvent({ type: "merge.confirmed", aggregateId: requestId, payload: { targetCommit, planId: request.planId, revision: plan?.revision ?? null } });
    return merged;
  }

  private reconcileRun(project: Project, run: Run): MergeReconciliationItem {
    const existing = this.store.findMergeRequestByRun(run.id);
    try {
      const targetBranch = existing?.targetBranch ?? this.targetBranch(run);
      if (existing?.status === "MERGED") {
        return { runId: run.id, planId: run.planId, outcome: "ALREADY_MERGED", mergeRequest: existing, sourceCommit: existing.sourceCommit, targetBranch, targetCommit: existing.detectedTargetCommit ?? null, reason: null };
      }
      const verification = this.store.getVerificationRun(run.id);
      if (!verification || (verification.status !== "PASSED" && verification.status !== "SKIPPED")) {
        return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch, targetCommit: null, reason: "A passed or skipped VerificationRun is required" };
      }
      const git = this.options.git;
      if (!git) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch, targetCommit: null, reason: "Git merge inspection is not configured" };

      const sourceCommit = existing?.sourceCommit ?? this.resolveRunSource(git, project, run);
      if (!targetBranch) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch: null, targetCommit: null, reason: "Frozen Plan revision base branch could not be resolved" };
      if (!sourceCommit) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: null, targetBranch, targetCommit: null, reason: "Run worktree and branch HEAD could not be resolved" };
      if (!git.commitExists(project.repoRoot, sourceCommit)) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit: null, reason: `Source commit ${sourceCommit} could not be verified in the project repository` };
      const targetCommit = git.resolveCommit(project.repoRoot, targetBranch);
      if (!targetCommit) return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit: null, reason: `Target branch ${targetBranch} could not be resolved` };
      const contained = git.isAncestor(project.repoRoot, sourceCommit, targetCommit) && git.branchContains(project.repoRoot, targetBranch, targetCommit);
      if (!contained) {
        if (existing?.status === "OPEN" && existing.detectedTargetCommit) {
          const cleared = { ...existing, detectedTargetCommit: null };
          this.store.updateMergeRequest(cleared);
          return { runId: run.id, planId: run.planId, outcome: "NOT_MERGED", mergeRequest: cleared, sourceCommit, targetBranch, targetCommit, reason: "Target branch does not currently contain the reviewed source commit" };
        }
        return { runId: run.id, planId: run.planId, outcome: "NOT_MERGED", mergeRequest: existing ?? null, sourceCommit, targetBranch, targetCommit, reason: "Target branch does not currently contain the reviewed source commit" };
      }
      if (existing) {
        const updated = existing.detectedTargetCommit === targetCommit ? existing : { ...existing, detectedTargetCommit: targetCommit };
        if (updated !== existing) {
          this.store.updateMergeRequest(updated);
          this.store.appendEvent({ type: "merge.detected", aggregateId: updated.id, payload: { runId: run.id, planId: run.planId, sourceCommit, targetBranch, targetCommit } });
        }
        return { runId: run.id, planId: run.planId, outcome: "ALREADY_OPEN", mergeRequest: updated, sourceCommit, targetBranch, targetCommit, reason: null };
      }
      const request = this.createOpenRequest(run, sourceCommit, targetCommit);
      this.store.appendEvent({ type: "merge.detected", aggregateId: request.id, payload: { runId: run.id, planId: run.planId, sourceCommit, targetBranch, targetCommit } });
      return { runId: run.id, planId: run.planId, outcome: "DETECTED", mergeRequest: request, sourceCommit, targetBranch, targetCommit, reason: null };
    } catch (error) {
      return { runId: run.id, planId: run.planId, outcome: "UNAVAILABLE", mergeRequest: existing ?? null, sourceCommit: existing?.sourceCommit ?? null, targetBranch: existing?.targetBranch ?? null, targetCommit: null, reason: `Git merge inspection failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private createOpenRequest(run: Run, sourceCommit: string, detectedTargetCommit: string | null): MergeRequest {
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const request: MergeRequest = { id: `merge-${randomUUID().slice(0, 12)}`, runId: run.id, planId: run.planId, sourceCommit, targetBranch: revision?.contract.baseBranch ?? "main", status: "OPEN", humanConfirmationRequired: true, createdAt: new Date().toISOString(), mergedAt: null, ...(detectedTargetCommit ? { detectedTargetCommit } : {}) };
    this.store.saveMergeRequest(request);
    this.store.appendEvent({ type: "merge.request.created", aggregateId: request.id, payload: request });
    return request;
  }

  private targetBranch(run: Run): string | null {
    const plan = this.store.getPlan(run.planId);
    const revision = plan ? this.store.getRevision(plan.id, run.planRevision) : undefined;
    const branch = revision?.contract.baseBranch?.trim();
    return branch || null;
  }

  private resolveRunSource(git: GitMergeInspector, project: Project, run: Run): string | null {
    if (run.workspacePath) {
      const workspaceHead = git.resolveCommit(run.workspacePath, "HEAD");
      if (workspaceHead) return workspaceHead;
    }
    return git.resolveCommit(project.repoRoot, run.branch);
  }
}

export type ToolCallLedgerStatus = "PENDING" | "COMPLETED" | "DENIED" | "UNCERTAIN" | "NEEDS_RECONCILIATION";
export type ToolCallLedgerEntry = { callId: string; tool: ToolName; status: ToolCallLedgerStatus; result: ToolCallResult; replay: boolean };

/** 记录工具调用的确定性结果；UNCERTAIN 恢复为 NEEDS_RECONCILIATION，禁止静默重放。 */
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
import { execFile, execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
