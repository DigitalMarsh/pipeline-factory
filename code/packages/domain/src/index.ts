/**
 * 模块职责：聚合 Pipeline Factory 的核心领域模型、存储、Plan、Run、Scheduler 和验证服务。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { projectAgentLoopDiagnostics } from "./agent/agent-loop.js";
import type { AgentLoop, AgentLoopDiagnostics, AgentLoopEvent, AgentLoopRunner, AgentLoopStep, AgentLoopStepInput } from "./agent/agent-loop.js";
import type { MappedCodexRateLimits } from "./model/codex-rate-limits.js";
import { AgentLoopEngine } from "./agent/agent-loop.js";
import { PlanCompletenessGate } from "./agent/termination-gates.js";
import { composeExplorerTitle, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle, type ExplorerTitleGenerator, type ExplorerTitleSource, type ExplorerTitleStatus } from "./explorer/explorer-title.js";
import { allocateRunBranchLeaf, composeRunBranchLeaf, ModelRunBranchNameGenerator, normalizeRunBranchSlug, runBranchName, type RunBranchNameGenerator } from "./run/run-branch.js";
import { snapshotProjectWorkingTree } from "./git/worktree-snapshot.js";
import { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project/project.js";
import type { Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings } from "./project/project.js";
import type { PlanDispatchState } from "./run/dispatch-coordinator.js";
import { redactAuditPayload, redactAuditText } from "./platform/redaction.js";
import { GeneratedPlanSpecV2ValidationError, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2 } from "./plan/plan-v2.js";
import type { GeneratedPlanSpecV2, PlanValidationIssue, ResolvedPlanContractV2 } from "./plan/plan-v2.js";
/**
 * P2 解环期间从 index.ts 抽出去的符号统一放在这里，用"先 import 再 export"的形态。
 * 不能写成 `export { ... } from "./x.js"`：纯 re-export 只把绑定转发给消费者，**不会给本模块
 * 作用域创建同名绑定**，而 index.ts 自己还要用 REQUIRED_PLAN_AREAS / normalizeModelUsage 等，
 * 写成纯 re-export 会得到一个只在运行时才炸的 `ReferenceError: ... is not defined`。
 * 每抽一个符号前都要先确认 index.ts 内部是否还在用它。
 */
import { EXPLORER_PLAN_INSTRUCTIONS, EXPLORER_PLAN_REQUIREMENTS, REQUIRED_PLAN_AREAS, type ExplorerPlanRequirement } from "./platform/plan-requirements.js";
import { mergeModelUsage, normalizeModelUsage, type ModelUsage, type ModelUsageScope } from "./model/usage.js";
import { updatePlanStatus } from "./plan/status-transition.js";
import { isRecord, isStringArray } from "./platform/guards.js";
import { validatePlanContract } from "./plan/contract.js";
import { assessPlanCompletion, type PlanArtifact, type PlanCompletionAssessment } from "./plan/completion.js";
export { EXPLORER_PLAN_INSTRUCTIONS, EXPLORER_PLAN_REQUIREMENTS, REQUIRED_PLAN_AREAS, type ExplorerPlanRequirement };
export { mergeModelUsage, normalizeModelUsage, type ModelUsage, type ModelUsageScope };
export { updatePlanStatus };
export { validatePlanContract };
export { assessPlanCompletion, type PlanArtifact, type PlanCompletionAssessment };
// isRecord / isStringArray / isNonEmptyStringArray 原先就是 index.ts 的**内部**函数（未 export），
// 这里同样只 import 不 re-export，避免凭空扩大公共契约；它们仍是本模块自用的实现细节。
// ToolGateway 用纯 re-export：搬走之后 index.ts 内部已不再使用它，无需为它建本地绑定
// （api 的 server.ts 与多个测试仍从本 barrel 取它，所以必须保留导出）。
export { ToolGateway, type ToolGatewayOptions } from "./tools/gateway.js";
// PipelineStore 是**类型**，纯 re-export 不涉及运行时绑定，天然不会引出 S1 那类 ReferenceError；
// 而它被 index.ts 内部大量用作参数类型（`store: PipelineStore`），所以仍用 import + export 两条，
// 保持"类型在本模块作用域内可见"。
import type { PipelineStore } from "./store/pipeline-store.js";
export type { PipelineStore };
// Plan Center 的查询投影与游标。5 个类型原本就是 `export type`（公共契约），且 index.ts 内部
// （PlanService.query / SqlitePipelineStore 行映射）直接把它们用作签名类型，所以 import + export 两条都要。
// 三个函数原先未 export，只 import 不 re-export。
import { encodePlanCursor, decodePlanCursor, planQueryProjectionFor, type PlanIndexRow, type PlanQuery, type PlanQueryProjection, type PlanQueryResult, type PlanQuerySort } from "./plan/query.js";
export type { PlanIndexRow, PlanQuery, PlanQueryProjection, PlanQueryResult, PlanQuerySort };
// freezeDeep 搬走后在 index.ts 内已无引用（只有 freezeRevision 仍在用），故只 import freezeRevision。
import { freezeRevision } from "./platform/freeze.js";
// store/records.ts 的 11 个辅助原先都是 index.ts 的**内部**函数（未 export），只 import 不 re-export。
// 它们是 Store 两个实现与 ExplorerService / ExplorerThreadService 的共用依赖；留在 index.ts 会让
// 批 B 搬 store 时产生 store → index 的值级回流边，P2 刚清零的环会重新出现。
import { containsAnyString, defaultExplorerPlan, defaultPlanExploration, defaultThreadContextSummary, isVerificationRun, parsePlanValidationIssues, parseStringArray, parseThreadContextSummary, stripPlanProtocol, summarizeExplorerMessage, threadTitleMetadata } from "./store/records.js";
// InMemoryPipelineStore 用纯 re-export：index.ts 内部从不实例化它（只有 api 的 server.ts
// 与测试从本 barrel 取），无需为它建本地绑定。SqlitePipelineStore 随后同理。
export { InMemoryPipelineStore } from "./store/in-memory-store.js";
export { SqlitePipelineStore } from "./store/sqlite-store.js";
export { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project/project.js";
export { redactAuditPayload, redactAuditText } from "./platform/redaction.js";
export type { CreateProjectInput, Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings, ProjectSettingsInput, ProjectStatus, ProjectSummary, UpdateProjectInput } from "./project/project.js";
export { PlanDispatchCoordinator } from "./run/dispatch-coordinator.js";
export type { PlanDispatchCoordinatorOptions, PlanDispatchPhase, PlanDispatchState, PlanDispatchStatus, PlanDispatchWaitReason } from "./run/dispatch-coordinator.js";
export { projectExplorerActivity } from "./explorer/explorer-activity.js";
export type { ExplorerActivityInput, ExplorerActivityItem, ExplorerActivityKind } from "./explorer/explorer-activity.js";
export { assertSafeProjectRelativeGlob, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2 } from "./plan/plan-v2.js";
export type { GeneratedPlanSpecV2, GitBaseline, PlanArtifactMode, PlanValidationIssue, PlanValidationIssueCode, ResolvedPlanContractV2 } from "./plan/plan-v2.js";
export { composeExplorerTitle, explorerTimestamp, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle } from "./explorer/explorer-title.js";
export type { ExplorerTitleGenerator, ExplorerTitleSource, ExplorerTitleStatus } from "./explorer/explorer-title.js";
export { allocateRunBranchLeaf, composeRunBranchLeaf, ModelRunBranchNameGenerator, normalizeRunBranchSlug, runBranchDate, runBranchName } from "./run/run-branch.js";
export type { RunBranchNameGenerator, RunBranchNameInput } from "./run/run-branch.js";

export type { AgentLoop, AgentLoopDiagnostics, AgentLoopInput, AgentLoopMode, AgentLoopResult, AgentLoopState, AgentLoopStep, AgentLoopStepInput, AgentLoopStepStatus, AgentLoopRunner, AgentStepType, GateContext, GateDecision, TerminationGate } from "./agent/agent-loop.js";
export { AgentLoopEngine } from "./agent/agent-loop.js";
export { PROJECT_EXECUTION_MODELS, PROJECT_EXECUTION_REASONING_EFFORTS, ProjectExecutionThreadService } from "./agent/project-execution-thread.js";
export type { ProjectExecutionThreadServiceOptions, ProjectExecutionThreadSnapshot } from "./agent/project-execution-thread.js";
export { AGENT_LOOP_DIAGNOSTIC_STEP_TYPES, projectAgentLoopDiagnostics } from "./agent/agent-loop.js";
export { PlanCompletenessGate, TaskProgressGate } from "./agent/termination-gates.js";
export { ExecutorAgent, inspectWorkspaceScope, parseExecutorReport } from "./agent/executor-agent.js";
export type { ExecutorAgentOptions, ExecutorReport, WorkspaceScopeInspection, WorkspaceScopeInspector } from "./agent/executor-agent.js";
export { RecoveryCoordinator } from "./run/recovery-coordinator.js";
export { mapCodexRateLimits } from "./model/codex-rate-limits.js";
export type { CodexRateLimitBucket, CodexRateLimitWindow, CodexRateLimitsResponse, MappedCodexRateLimits, MappedRateLimit } from "./model/codex-rate-limits.js";
export { BuiltinToolExecutor } from "./tools/builtin-tool-executor.js";
export type { BuiltinToolContext, BuiltinToolExecutorOptions } from "./tools/builtin-tool-executor.js";
export { DurableToolRuntime } from "./tools/tool-runtime.js";
export type { ToolExecutionContext, ToolRuntime } from "./tools/tool-runtime.js";
export { McpClient, McpToolRegistry } from "./tools/mcp.js";
export type { McpClientOptions, McpRpcTransport, McpServerConfig, McpToolCallResult, McpToolDefinition, McpToolRegistryOptions, QualifiedMcpTool } from "./tools/mcp.js";
export { PluginRegistry, PluginToolBridge } from "./tools/plugin.js";
export type { PluginManifest, PluginRegistryOptions, PluginStatus, PluginTool, PluginToolDefinition, PluginToolHandler } from "./tools/plugin.js";
export { ComputerUseBridge } from "./tools/computer-use.js";
export type { ComputerUseAction, ComputerUseBridgeOptions, ComputerUseEvent, ComputerUseHostAdapter, ComputerUseScreenshot } from "./tools/computer-use.js";

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

/** 一个 ExplorerThread 下的独立需求对话分区，拥有隔离的 Provider 会话。 */
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
  /** Provider conversation is isolated per requirement; null means not started yet. */
  providerThreadId?: string | null;
  /** Fingerprint of the project repository context last included in this requirement. */
  repositoryContextKey?: string | null;
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
  status?: "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
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
  /** IDs of other CandidatePlans in this Project; descriptive prerequisites belong in the V2 plan constraints. */
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
    | "project.execution.thread.created"
    | "project.execution.preferences.updated"
    | "project.execution.turn.accepted"
    | "project.execution.turn.started"
    | "project.execution.turn.text.delta"
    | "project.execution.turn.activity"
    | "project.execution.turn.completed"
    | "project.execution.turn.failed"
    | "project.execution.turn.cancelled"
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
    | "explorer.requirement.status.changed"
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

/** 每个项目唯一的长期执行会话；空偏好字段表示跟随项目 Executor 默认值。 */
export type ProjectExecutionThread = {
  id: string;
  projectId: string;
  providerThreadId: string | null;
  modelOverride: string | null;
  reasoningEffortOverride: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectExecutionTurnStatus = "QUEUED" | "RUNNING" | "WAITING_FOR_INPUT" | "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERY_REQUIRED";

/** 执行会话中的一条有序消息；用户和助手消息共享 turnId。 */
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

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;

function projectPlaceholderExplorerTitle(store: PipelineStore, thread: ExplorerThread): string {
  return placeholderExplorerTitle(thread.createdAt, store.getProject(thread.projectId)?.shortName);
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
    dependsOnPlanIds: [],
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

/**
 * 负责 ExplorerThread、CandidatePlan、Confirm、Enqueue 和 Revision 的业务边界。
 * CandidatePlan 的状态变化始终先写事实，再追加领域事件，避免 UI 投影领先于持久化状态。
 */
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
    let plan = this.get(planId);
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
    if (plan.generatedSpec && plan.resolvedContract) {
      const prerequisites = [...new Set([...plan.generatedSpec.dependencies, ...plan.resolvedContract.dependencies])];
      const prerequisiteSet = new Set(prerequisites);
      const currentPlanDependencies = plan.contract.dependsOnPlanIds ?? [];
      const dependsOnPlanIds = currentPlanDependencies.filter((dependencyId) => !prerequisiteSet.has(dependencyId));
      const currentTechnicalConstraints = plan.resolvedContract.design.technicalConstraints;
      const technicalConstraints = [...new Set([...currentTechnicalConstraints, ...prerequisites])];
      const dependenciesChanged = dependsOnPlanIds.length !== currentPlanDependencies.length;
      const constraintsChanged = technicalConstraints.length !== currentTechnicalConstraints.length || technicalConstraints.some((constraint, index) => constraint !== currentTechnicalConstraints[index]);
      if (dependenciesChanged || constraintsChanged) {
        plan = this.store.updatePlan({
          ...plan,
          contract: { ...plan.contract, dependsOnPlanIds },
          resolvedContract: { ...plan.resolvedContract, design: { ...plan.resolvedContract.design, technicalConstraints } },
        });
      }
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
  supportedLoopModes: import("./agent/agent-loop.js").AgentLoopMode[];
};
/** 传给模型的受控工具描述和输入 schema。 */
export type ModelToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};
/** Provider 会话中的规范化消息。 */
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string };

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
  | { type: "provider.activity"; phase: "started" | "completed"; itemId: string; itemType: string; title: string | null; summary: string | null; toolName?: string | undefined; serverName?: string | undefined; status?: string | undefined; error?: string | undefined; providerThreadId?: string | undefined; providerTurnId?: string | undefined; providerItemId?: string | undefined }
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
  private readonly jobs = new Map<string, { threadId: string; userId: string; assistantId: string; explorerPlanId: string; loopId?: string | undefined; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean }>();
  private readonly activeTurnByPlan = new Map<string, string>();
  private readonly queuedTurns = new Map<string, string[]>();
  private readonly agentLoops: AgentLoopEngine;
  private readonly listeners = new Map<string, Set<(event: DomainEvent) => void>>();
  private readonly plans: PlanService;
  private readonly loopMaxSteps: number;
  private readonly titleGenerator: ExplorerTitleGenerator | undefined;
  private readonly cwdForProject: ((projectId: string) => string | undefined) | undefined;
  private readonly modelConfigForProject: ((projectId: string) => ModelRoleConfig | undefined) | undefined;
  private readonly repositoryContextForProject: ((projectId: string) => { key: string; summary: string } | undefined) | undefined;

  constructor(private readonly store: PipelineStore, private readonly model: ModelGateway, options: { /** @deprecated retained for compatibility; Explorer uses the global model.loop.maxSteps. */ maxAutoContinuationTurns?: number | undefined; maxSteps?: number | undefined; maxDurationMs?: number | undefined; maxRepeatedToolCalls?: number | undefined; maxNoProgressSteps?: number | undefined; titleGenerator?: ExplorerTitleGenerator | undefined; cwdForProject?: ((projectId: string) => string | undefined) | undefined; modelConfigForProject?: ((projectId: string) => ModelRoleConfig | undefined) | undefined; repositoryContextForProject?: ((projectId: string) => { key: string; summary: string } | undefined) | undefined } = {}) {
    this.titleGenerator = options.titleGenerator;
    this.cwdForProject = options.cwdForProject;
    this.modelConfigForProject = options.modelConfigForProject;
    this.repositoryContextForProject = options.repositoryContextForProject;
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
          if (turn && (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED")) {
            store.updateTurn({ ...turn, status: "FAILED", error: "STRUCTURED_INPUT_RECOVERY_REQUIRED", content: turn.content || "模型回合中断，需要恢复结构化输入" });
            if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED", turn.id);
            recoveredTurnIds.add(turn.id);
          }
        }
      }
      for (const turn of store.listTurns(thread.id)) {
        if (recoveredTurnIds.has(turn.id) || (turn.status !== "RUNNING" && turn.status !== "WAITING_FOR_INPUT" && turn.status !== "PAUSED")) continue;
        store.updateTurn({ ...turn, status: "FAILED", error: "EXPLORER_TURN_RECOVERY_REQUIRED", content: turn.content || "模型回合中断，需要重新开始探索" });
        if (turn.explorerPlanId) this.updatePlanRuntimeStatus(thread.id, turn.explorerPlanId, "FAILED", turn.id);
      }
    }
    for (const thread of store.listThreads()) {
      if (thread.state === "WAITING_FOR_INPUT") store.updateThread({ ...thread, state: "ACTIVE", lastActivityAt: store.now() });
    }
    for (const thread of store.listThreads()) {
      for (const turn of store.listTurns(thread.id).filter((item) => item.role === "assistant" && item.status === "QUEUED")) {
        const planId = turn.explorerPlanId ?? store.listExplorerPlans(thread.id)[0]?.id;
        if (!planId) continue;
        const queue = this.queuedTurns.get(planId) ?? [];
        queue.push(turn.id);
        this.queuedTurns.set(planId, queue);
      }
    }
  }

  async recoverQueuedTurns(): Promise<void> {
    await Promise.all([...this.queuedTurns.keys()].map((explorerPlanId) => this.startNextQueuedTurn(explorerPlanId)));
  }

  async startTurn(input: { threadId: string; explorerPlanId: string; content: string; clientTurnId: string }): Promise<{ user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null }> {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`ExplorerThread ${input.threadId} not found`);
    if (!input.explorerPlanId) throw new Error("explorerPlanId is required for every Explorer turn");
    const prior = this.store.getIdempotency("explorer-turn", input.clientTurnId);
    if (prior) return prior as unknown as { user: ExplorerTurn; assistant: ExplorerTurn; eventsUrl: string; loopId: string | null };
    if (thread.state === "ARCHIVED") throw new Error(`ExplorerThread ${input.threadId} is archived`);
    const plan = this.resolveExplorerPlan(thread, input.explorerPlanId);
    const turns = this.store.listTurns(input.threadId);
    const firstRequirementMessage = turns.every((turn) => turn.explorerPlanId !== plan.id || turn.role !== "user");
    const hasActiveJob = this.activeTurnByPlan.has(plan.id) || this.store.listTurns(input.threadId).some((turn) => turn.explorerPlanId === plan.id && (turn.status === "RUNNING" || turn.status === "WAITING_FOR_INPUT" || turn.status === "PAUSED"));
    const user: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "user", content: input.content, status: "COMPLETED", createdAt: this.store.now(), sequence: turns.length + 1, explorerPlanId: plan.id };
    const assistant: ExplorerTurn = { id: this.store.nextId("turn"), threadId: input.threadId, role: "assistant", content: "", status: hasActiveJob ? "QUEUED" : "RUNNING", createdAt: this.store.now(), sequence: turns.length + 2, explorerPlanId: plan.id };
    this.store.saveTurn(user);
    this.store.saveTurn(assistant);
    this.store.updateThread({ ...thread, activeExplorerPlanId: plan.id, messageCount: thread.messageCount + 2, lastActivityAt: assistant.createdAt });
    const firstSummary = summarizeExplorerMessage(input.content);
    this.store.updateExplorerPlan({ ...plan, ...(firstRequirementMessage && plan.titleSource === "AUTO" ? { title: firstSummary || `Plan ${plan.ordinal} / 待探索`, titleStatus: firstSummary ? "GENERATED" : plan.titleStatus } : {}), messageCount: plan.messageCount + 2, latestUserMessageSummary: firstSummary, lastActivityAt: assistant.createdAt });
    this.scheduleTitleGeneration(thread.id, input.content, plan.id);
    const accepted = { user, assistant, eventsUrl: `/api/v4/projects/${thread.projectId}/explorer-thread/events?threadId=${encodeURIComponent(thread.id)}&explorerPlanId=${encodeURIComponent(plan.id)}` };
    this.publish(this.store.appendEvent({ type: "explorer.turn.accepted", aggregateId: input.threadId, payload: { turnId: assistant.id, userTurnId: user.id, explorerPlanId: plan.id, loopId: null, state: assistant.status } }));
    if (hasActiveJob) {
      const queue = this.queuedTurns.get(plan.id) ?? [];
      queue.push(assistant.id);
      this.queuedTurns.set(plan.id, queue);
      const acceptedWithQueue = { ...accepted, loopId: null };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithQueue as unknown as Record<string, unknown>);
      return acceptedWithQueue;
    }
    this.updatePlanRuntimeStatus(thread.id, plan.id, "RUNNING", assistant.id);
    try {
      const loop = await this.startQueuedTurn(thread.id, assistant.id);
      const acceptedWithLoop = { ...accepted, loopId: loop.id };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithLoop as unknown as Record<string, unknown>);
      return acceptedWithLoop;
    } catch (error) {
      const failed = this.failTurnStart(thread.id, assistant.id, error);
      const acceptedWithFailure = { ...accepted, assistant: failed ?? { ...assistant, status: "FAILED" as const }, loopId: null };
      this.store.saveIdempotency("explorer-turn", input.clientTurnId, acceptedWithFailure as unknown as Record<string, unknown>);
      void this.startNextQueuedTurn(plan.id);
      return acceptedWithFailure;
    }
  }

  private async startQueuedTurn(threadId: string, assistantId: string): Promise<AgentLoop> {
    const thread = this.store.getThread(threadId);
    const assistant = this.store.listTurns(threadId).find((turn) => turn.id === assistantId && turn.role === "assistant");
    if (!thread || !assistant) throw new Error(`Explorer turn ${assistantId} not found`);
    const plan = this.resolveExplorerPlan(thread, assistant.explorerPlanId);
    if (assistant.status === "QUEUED") this.store.updateTurn({ ...assistant, status: "RUNNING" });
    const job: { threadId: string; userId: string; assistantId: string; explorerPlanId: string; loopId?: string | undefined; providerThreadId: string | null; providerTurnId: string | null; resolveInput?: (() => void) | undefined; cancelled: boolean } = { threadId, userId: this.store.listTurns(threadId).find((turn) => turn.role === "user" && turn.sequence === assistant.sequence - 1 && turn.explorerPlanId === plan.id)?.id ?? "", assistantId, explorerPlanId: plan.id, providerThreadId: plan.providerThreadId ?? null, providerTurnId: null, cancelled: false };
    this.jobs.set(assistantId, job);
    this.activeTurnByPlan.set(plan.id, assistantId);
    const user = this.store.listTurns(threadId).find((turn) => turn.id === job.userId);
    const repositoryContext = this.repositoryContextForProject?.(thread.projectId);
    const repositoryContextChanged = Boolean(repositoryContext && plan.repositoryContextKey !== repositoryContext.key);
    const latestPlan = repositoryContextChanged && repositoryContext ? this.store.updateExplorerPlan({ ...plan, repositoryContextKey: repositoryContext.key }) : plan;
    const planBoundary = this.planBoundary(thread, latestPlan, user?.content ?? "", repositoryContextChanged ? repositoryContext?.summary : undefined);
    const loop = await this.agentLoops.start({
      ownerType: "explorer-turn",
      ownerId: assistant.id,
      role: "explorer",
      mode: this.modelConfigForProject?.(thread.projectId)?.loopMode ?? "provider-controlled",
      maxSteps: this.loopMaxSteps,
      modelRequest: { messages: this.store.listTurns(thread.id).filter((turn) => turn.explorerPlanId === plan.id && turn.sequence < assistant.sequence && !(turn.role === "assistant" && turn.status === "QUEUED")).map((turn) => ({ role: turn.role, content: turn.content })), conversationId: plan.id, continuationPrompt: planBoundary, ...(plan.providerThreadId ? { providerThreadId: plan.providerThreadId } : {}), ...(this.cwdForProject?.(thread.projectId) ? { cwd: this.cwdForProject(thread.projectId) } : {}), ...(this.modelConfigForProject?.(thread.projectId) ? { modelConfig: this.modelConfigForProject(thread.projectId) } : {}) },
      gate: new PlanCompletenessGate(),
      onEvent: (event) => this.handleExplorerLoopEvent(thread.id, assistant.id, event),
    });
    job.loopId = loop.id;
    this.updatePlanRuntimeStatus(threadId, plan.id, "RUNNING", assistantId);
    this.publish(this.store.appendEvent({ type: "explorer.turn.started", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: plan.id, loopId: loop.id } }));
    return loop;
  }

  private async startNextQueuedTurn(explorerPlanId: string): Promise<void> {
    if (this.activeTurnByPlan.has(explorerPlanId)) return;
    const queue = this.queuedTurns.get(explorerPlanId) ?? [];
    let assistantId: string | undefined;
    let threadId: string | undefined;
    while (queue.length > 0 && !assistantId) {
      const candidateId = queue.shift();
      const candidate = candidateId ? this.findTurn(candidateId) : undefined;
      if (candidate?.turn.role === "assistant" && candidate.turn.status === "QUEUED" && candidate.turn.explorerPlanId === explorerPlanId) {
        assistantId = candidate.turn.id;
        threadId = candidate.threadId;
      }
    }
    if (queue.length === 0) this.queuedTurns.delete(explorerPlanId);
    else this.queuedTurns.set(explorerPlanId, queue);
    if (!assistantId) return;
    try {
      await this.startQueuedTurn(threadId!, assistantId);
    } catch (error) {
      this.failTurnStart(threadId!, assistantId, error);
      await this.startNextQueuedTurn(explorerPlanId);
    }
  }

  private failTurnStart(threadId: string, assistantId: string, error: unknown): ExplorerTurn | undefined {
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId && turn.role === "assistant");
    const message = error instanceof Error ? error.message : String(error);
    const failed = current && current.status !== "FAILED"
      ? this.store.updateTurn({ ...current, status: "FAILED", error: message, content: current.content || "模型调用未能启动" })
      : current;
    const job = this.jobs.get(assistantId);
    this.jobs.delete(assistantId);
    const explorerPlanId = job?.explorerPlanId ?? current?.explorerPlanId;
    if (explorerPlanId && this.activeTurnByPlan.get(explorerPlanId) === assistantId) this.activeTurnByPlan.delete(explorerPlanId);
    if (explorerPlanId) this.updatePlanRuntimeStatus(threadId, explorerPlanId, "FAILED", assistantId);
    if (current?.status !== "FAILED") {
      this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: explorerPlanId ?? null, loopId: job?.loopId ?? null, error: message } }));
    }
    return failed;
  }

  private updatePlanRuntimeStatus(threadId: string, explorerPlanId: string, runtimeStatus: NonNullable<ExplorerTurn["status"]>, turnId?: string): void {
    const plan = this.store.getExplorerPlan(explorerPlanId);
    if (!plan || plan.explorerThreadId !== threadId) return;
    const statusChanged = plan.runtimeStatus !== runtimeStatus;
    this.store.updateExplorerPlan({ ...plan, runtimeStatus, lastActivityAt: this.store.now() });
    if (!statusChanged) return;
    this.publish(this.store.appendEvent({ type: "explorer.requirement.status.changed", aggregateId: threadId, payload: { explorerPlanId, turnId: turnId ?? this.activeTurnByPlan.get(explorerPlanId) ?? null, status: runtimeStatus, occurredAt: this.store.now() } }));
  }

  private findTurn(turnId: string): { threadId: string; turn: ExplorerTurn } | undefined {
    for (const thread of this.store.listThreads()) {
      const turn = this.store.listTurns(thread.id).find((item) => item.id === turnId);
      if (turn) return { threadId: thread.id, turn };
    }
    return undefined;
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

  private planBoundary(_thread: ExplorerThread, plan: ExplorerPlan, content: string, repositorySummary?: string): string {
    const firstPlanTurn = this.store.listTurns(plan.explorerThreadId).filter((turn) => turn.explorerPlanId === plan.id && turn.role === "user").length <= 1;
    return `[需求 ${plan.ordinal}: ${plan.title}]\n${repositorySummary ? `Project repository index (versioned, shared across requirements):\n${repositorySummary}\n` : ""}${firstPlanTurn ? "This is an isolated requirement conversation. Do not infer decisions from sibling requirements.\n" : "Continue only the current requirement conversation.\n"}User message:\n${content}`;
  }

  async backfillTitles(): Promise<void> {
    if (!this.titleGenerator) return;
    await Promise.all(this.store.listThreads().map(async (thread) => {
      if (thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
      const firstUser = this.store.listTurns(thread.id).find((turn) => turn.role === "user" && turn.content.trim());
      if (!firstUser) return;
      this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
      await this.generateTitle(thread.id, firstUser.content, firstUser.explorerPlanId);
    }));
  }

  private scheduleTitleGeneration(threadId: string, content: string, explorerPlanId: string): void {
    if (!this.titleGenerator || !content.trim()) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "PLACEHOLDER") return;
    if (this.store.listTurns(threadId).filter((turn) => turn.role === "user" && turn.content.trim()).length !== 1) return;
    this.store.updateThread({ ...thread, titleStatus: "GENERATING" });
    void this.generateTitle(threadId, content, explorerPlanId);
  }

  private async generateTitle(threadId: string, content: string, explorerPlanId?: string): Promise<void> {
    const generator = this.titleGenerator;
    if (!generator) return;
    try {
      const generated = normalizeExplorerTitle(await generator.generate({ threadId, content }));
      if (!generated) throw new Error("Explorer title generator returned an invalid title");
      const thread = this.store.getThread(threadId);
      if (!thread || thread.titleSource !== "AUTO" || thread.titleStatus !== "GENERATING") return;
      const updated = this.store.updateThread({ ...thread, title: composeExplorerTitle(thread.createdAt, generated), titleStatus: "GENERATED" });
      this.publish(this.store.appendEvent({ type: "explorer.title.updated", aggregateId: threadId, payload: { explorerId: threadId, explorerPlanId: explorerPlanId ?? updated.activeExplorerPlanId, turnId: null, loopId: null, title: updated.title, titleStatus: updated.titleStatus } }));
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
      const turn = this.store.listTurns(input.threadId).find((item) => item.id === request.localTurnId && item.role === "assistant");
      if (!turn) throw new Error("Assistant turn for input request not found");
      const result = { request, turn };
      this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
      return result;
    }
    if (request.status !== "OPEN") throw new Error(`Input request cannot be answered from ${request.status}`);
    validateInputAnswers(request.questions, input.answers);
    const job = this.jobs.get(request.localTurnId);
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
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "RUNNING", assistant.id);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    this.publish(this.store.appendEvent({ type: "explorer.turn.input.resolved", aggregateId: input.threadId, payload: { inputRequestId: request.id, turnId: request.localTurnId, explorerPlanId: request.explorerPlanId ?? null, loopId: job.loopId ?? null, actorId: input.actorId, answerCounts: answered.redactedAnswerSummary } }));
    const result = { request: answered, turn: { ...assistant, status: "RUNNING" as const } };
    this.store.saveIdempotency("input-answer", input.clientRequestId, result as unknown as Record<string, unknown>);
    return result;
  }

  async cancelTurn(input: { threadId: string; turnId: string; reason: string }): Promise<ExplorerTurn> {
    const assistant = this.store.listTurns(input.threadId).find((turn) => turn.id === input.turnId && turn.role === "assistant");
    if (!assistant) throw new Error("Active Explorer turn not found");
    const job = this.jobs.get(assistant.id);
    if (!job) {
      const planId = assistant.explorerPlanId;
      const queue = planId ? this.queuedTurns.get(planId) ?? [] : [];
      if (assistant.status !== "QUEUED" || !queue.includes(assistant.id)) throw new Error("Active Explorer turn not found");
      this.queuedTurns.set(planId!, queue.filter((id) => id !== assistant.id));
      const cancelledQueued = { ...assistant, status: "CANCELLED" as const, content: "本轮已取消", error: input.reason };
      this.store.updateTurn(cancelledQueued);
      if (assistant.explorerPlanId && !this.activeTurnByPlan.has(assistant.explorerPlanId)) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED", assistant.id);
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: input.threadId, payload: { turnId: input.turnId, explorerPlanId: assistant.explorerPlanId ?? null, loopId: null, reason: input.reason } }));
      return cancelledQueued;
    }
    job.cancelled = true;
    if (job.loopId) await this.agentLoops.cancel(job.loopId, input.reason);
    else if (job.providerThreadId) await this.model.cancel({ conversationId: job.explorerPlanId, providerThreadId: job.providerThreadId, ...(job.providerTurnId ? { providerTurnId: job.providerTurnId } : {}) });
    for (const request of this.store.listInputRequests(input.threadId, "OPEN")) if (request.localTurnId === assistant.id) this.store.updateInputRequest({ ...request, status: "CANCELLED", answeredAt: this.store.now(), answeredBy: "cancelled" });
    job.resolveInput?.();
    const cancelled: ExplorerTurn = { ...assistant, status: "CANCELLED", content: "本轮已取消", error: input.reason };
    this.store.updateTurn(cancelled);
    const thread = this.store.getThread(input.threadId);
    if (thread) this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    if (assistant.explorerPlanId) this.updatePlanRuntimeStatus(input.threadId, assistant.explorerPlanId, "CANCELLED", assistant.id);
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
    if (turn && turn.status === "RUNNING") this.store.updateTurn({ ...turn, status: "PAUSED" });
    const pausedTurn = this.store.listTurns(threadId).find((turn) => turn.id === turnId);
    if (pausedTurn?.explorerPlanId) this.updatePlanRuntimeStatus(threadId, pausedTurn.explorerPlanId, "PAUSED", turnId);
    return paused;
  }

  async resumeLoop(loopId: string): Promise<AgentLoop> {
    const { threadId, turnId } = this.loopTurn(loopId);
    const resumed = await this.agentLoops.resume(loopId);
    const turn = this.store.listTurns(threadId).find((item) => item.id === turnId);
    if (turn && turn.status === "PAUSED") this.store.updateTurn({ ...turn, status: "RUNNING" });
    if (turn?.explorerPlanId) this.updatePlanRuntimeStatus(threadId, turn.explorerPlanId, "RUNNING", turnId);
    const thread = this.store.getThread(threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
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
    const job = this.jobs.get(assistantId);
    if (!job) return;
    if (event.type === "agent.provider.thread.started") {
      const providerThreadId = String(event.payload.threadId ?? "");
      if (providerThreadId) {
        job.providerThreadId = providerThreadId;
        const plan = this.store.getExplorerPlan(job.explorerPlanId);
        if (plan) this.store.updateExplorerPlan({ ...plan, providerThreadId, lastActivityAt: this.store.now() });
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
        const currentPlan = this.store.getExplorerPlan(job.explorerPlanId);
        if (currentPlan && currentPlan.providerThreadId !== providerThreadId) this.store.updateExplorerPlan({ ...currentPlan, providerThreadId, lastActivityAt: this.store.now() });
      }
      this.store.updateTurn({ ...current, content: current.content + text, status: "RUNNING" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "RUNNING", assistantId);
      this.publish(this.store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, text } }));
      return;
    }
    if (event.type === "agent.input.required") {
      const request = event.payload.request as ModelInputRequest | undefined;
      if (!request) return;
      job.providerThreadId = request.threadId;
      job.providerTurnId = request.turnId;
      const currentPlan = this.store.getExplorerPlan(job.explorerPlanId);
      if (currentPlan && currentPlan.providerThreadId !== request.threadId) this.store.updateExplorerPlan({ ...currentPlan, providerThreadId: request.threadId, lastActivityAt: this.store.now() });
      const inputRequest: ExplorerInputRequest = { id: this.store.nextId("input"), threadId, explorerPlanId: job.explorerPlanId, localTurnId: assistantId, providerRequestId: request.requestId, providerThreadId: request.threadId, providerTurnId: request.turnId, itemId: request.itemId, questions: request.questions, isBlocking: request.isBlocking, autoResolutionMs: request.autoResolutionMs, status: "OPEN", createdAt: this.store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null };
      const saved = this.store.saveInputRequest(inputRequest);
      const currentThread = this.store.getThread(threadId);
      if (currentThread) this.store.updateThread({ ...currentThread, lastActivityAt: this.store.now() });
      const currentTurn = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
      if (currentTurn) this.store.updateTurn({ ...currentTurn, status: "WAITING_FOR_INPUT" });
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "WAITING_FOR_INPUT", assistantId);
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
      this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "CANCELLED", assistantId);
      this.publish(this.store.appendEvent({ type: "explorer.turn.cancelled", aggregateId: threadId, payload: { turnId: assistantId, explorerPlanId: job.explorerPlanId, loopId: job.loopId ?? null, reason: event.payload.reason } }));
      this.finishExplorerJob(assistantId);
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
    const updatedPlan = this.store.updateExplorerPlan({ ...explorerPlan, exploration: { ...explorerPlan.exploration, status: assessment.status, missing: assessment.missing, completed: assessment.completed, diagnostics: assessment.diagnostics, lastAssessedTurnId: assistantId }, lastAssessedTurnId: assistantId, lastActivityAt: this.store.now() });
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
    this.updatePlanRuntimeStatus(threadId, explorerPlan.id, "COMPLETED", assistantId);
    this.publish(this.store.appendEvent({ type: "explorer.turn.completed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: explorerPlan.id, loopId: this.jobs.get(assistantId)?.loopId ?? null, planReady: assessment.status === "READY" } }));
    this.finishExplorerJob(assistantId);
  }

  private handleExplorerLoopFailure(threadId: string, assistantId: string, error: string): void {
    if (error === "MAX_STEPS_EXCEEDED" || error === "NO_PROGRESS") {
      this.finalizeExplorerLoop(threadId, assistantId);
      return;
    }
    for (const request of this.store.listInputRequests(threadId)) if (request.localTurnId === assistantId && (request.status === "OPEN" || request.status === "SUBMITTING")) this.store.updateInputRequest({ ...request, status: "RECOVERY_REQUIRED" });
    const current = this.store.listTurns(threadId).find((turn) => turn.id === assistantId);
    const job = this.jobs.get(assistantId);
    if (current && current.status !== "CANCELLED") this.store.updateTurn({ ...current, status: "FAILED", error, content: current.content || `模型调用失败：${error}` });
    if (job) this.updatePlanRuntimeStatus(threadId, job.explorerPlanId, "FAILED", assistantId);
    this.publish(this.store.appendEvent({ type: "explorer.turn.failed", aggregateId: threadId, payload: { assistantTurnId: assistantId, turnId: assistantId, explorerPlanId: job?.explorerPlanId ?? current?.explorerPlanId ?? null, loopId: job?.loopId ?? null, error } }));
    this.finishExplorerJob(assistantId);
  }

  private finishExplorerJob(assistantId: string): void {
    const job = this.jobs.get(assistantId);
    if (!job) return;
    const thread = this.store.getThread(job.threadId);
    if (thread && thread.state !== "ARCHIVED") this.store.updateThread({ ...thread, lastActivityAt: this.store.now() });
    this.jobs.delete(assistantId);
    if (this.activeTurnByPlan.get(job.explorerPlanId) === assistantId) this.activeTurnByPlan.delete(job.explorerPlanId);
    void this.startNextQueuedTurn(job.explorerPlanId);
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

export { CodexAppServerClient, CodexAppServerGateway } from "./model/codex-app-server.js";
export type { CodexAppServerClientOptions, CodexAppServerEvent, CodexAppServerGatewayOptions, CodexAppServerSession, CodexAppServerSessionFactory, CodexSpawnProcess, CodexThreadStartParams, CodexTurnStartParams } from "./model/codex-app-server.js";

/** Run 的执行、验证、合并和恢复状态；BLOCKED 需要人工关注。 */
export type RunStatus = "QUEUED" | "STARTING" | "IN_PROGRESS" | "READY_FOR_VERIFY" | "VERIFYING" | "MERGE_READY" | "BLOCKED" | "NEEDS_PLAN_CHANGE" | "STALE" | "RECOVERING" | "CANCELLED";
/** ExecutionThread 的展示状态，承载 Run 的实时模型输出和控制事实。 */
export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";
/** Run journal 中可回放的事件类别。 */
export type JournalEntryType = "RUN_CREATED" | "HOOK_COMPLETED" | "HOOK_FAILED" | "HOOK_SKIPPED" | "MODEL_OUTPUT" | "PROVIDER_ACTIVITY" | "TOOL_CALL" | "TASK_PROGRESS" | "USER_GUIDANCE" | "REPAIR" | "VERIFICATION" | "COMMIT" | "RECOVERY";

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

/** 一条可回放的 Execution journal 事实；payload 用于会话呈现与断线恢复，不单独决定 Run 控制状态。 */
export type ExecutionJournalEntry = {
  sequence: number;
  type: JournalEntryType;
  occurredAt: string;
  payload: ExecutionJournalPayload;
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
    try {
      const baseCommit = await snapshotProjectWorkingTree({
        projectRoot: this.options.projectRoot,
        worktreeRoot: this.options.worktreeRoot,
        workspacePath: path,
        baseCommit: input.baseCommit,
        runGit: this.runGit,
      });
      return { path, branch: input.branch, baseCommit };
    } catch (error) {
      await this.runGit(["worktree", "remove", "--force", path], this.options.projectRoot).catch(() => undefined);
      await this.runGit(["branch", "-D", input.branch], this.options.projectRoot).catch(() => undefined);
      throw new Error(`Git worktree baseline could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async remove(workspace: Workspace): Promise<void> {
    const removed = await this.runGit(["worktree", "remove", "--force", workspace.path], this.options.projectRoot);
    if (removed.exitCode !== 0) throw new Error(`Git worktree could not be removed: ${removed.stderr}`);
  }
}

function defaultGitCommand(args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolveResult({ exitCode: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
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
    run.baseCommit = workspace.baseCommit;
    this.options.store.saveRun(run);
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
    const taskId = this.recordedActiveTaskId(thread.journal);
    this.append(thread.id, "USER_GUIDANCE", { content, runId, ...(taskId ? { taskId } : {}) });
    this.options.store.appendEvent({ type: "run.guidance.added", aggregateId: run.id, payload: { executionThreadId: thread.id } });
    return this.thread(thread.id);
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

  private recordedActiveTaskId(journal: ExecutionJournalEntry[]): string | undefined {
    let activeTaskId: string | undefined;
    for (const entry of journal) {
      if (entry.type !== "TASK_PROGRESS") continue;
      if (entry.payload.action === "task-lifecycle") {
        const taskId = typeof entry.payload.taskId === "string" ? entry.payload.taskId : undefined;
        if (entry.payload.state === "IN_PROGRESS") activeTaskId = taskId;
        else if (taskId && activeTaskId === taskId) activeTaskId = undefined;
      }
      if (entry.payload.action === "task-status") activeTaskId = typeof entry.payload.activeTaskId === "string" ? entry.payload.activeTaskId : undefined;
    }
    return activeTaskId;
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
import { resolve } from "node:path";
