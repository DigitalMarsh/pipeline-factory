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
// 批 D：命令执行端口与其本地实现搬进 platform/commands.ts。
// CommandResult 在本模块剩下的 GitCommandRunner / VerificationCommandExecutor 里仍有引用，
// 所以走 import + export 两条保住本地绑定；CommandExecutor / HookContext 随 Hook 一并搬进
// run/hooks.ts 后已无内部引用，与其余四个类型一起纯 re-export。
import type { CommandResult } from "./platform/commands.js";
export type { CommandExecutor, CommandInvocation, CommandResult, HookContext, ProcessRunner, RegisteredCommandDefinition } from "./platform/commands.js";
// defaultProcessRunner 搬迁前就是**未导出**的内部函数（只在 RegisteredCommandExecutor 的
// 默认参数里出现），搬进 platform/commands.ts 后仍是模块私有，本 barrel 不转发它，
// 避免凭空扩大公共契约。
export { RegisteredCommandExecutor } from "./platform/commands.js";
// 批 D：Hook 执行器与其结果类型搬进 run/hooks.ts。本模块内部已无引用，全部纯 re-export。
export { LifecycleHookRunner } from "./run/hooks.js";
export type { HookDefinition, HookExecution, HookRunResult } from "./run/hooks.js";
// PipelineStore 是**类型**，纯 re-export 不涉及运行时绑定，天然不会引出 S1 那类 ReferenceError；
// 而它被 index.ts 内部大量用作参数类型（`store: PipelineStore`），所以仍用 import + export 两条，
// 保持"类型在本模块作用域内可见"。
import type { PipelineStore } from "./store/pipeline-store.js";
export type { PipelineStore };
// Plan Center 的查询投影与游标。5 个类型原本就是 `export type`（公共契约），批 C5 之后
// index.ts 内部已不再使用它们（PlanService 与两个 Store 都已搬走），故用纯 re-export。
// 三个函数原先未 export，且使用方全部已搬走，这里不 import 也不 re-export。
export type { PlanIndexRow, PlanQuery, PlanQueryProjection, PlanQueryResult, PlanQuerySort } from "./plan/query.js";
// freezeDeep 与 freezeRevision 的使用方（两个 Store、PlanService、ChangeProposalService）都已搬走，
// index.ts 内部不再引用它们——保持不导出（原先就不是公共契约）。
// 注意：不要把上面两行"没被使用"当成可以删除——它们是 barrel 的公共契约。
// store/records.ts 的 11 个辅助原先都是 index.ts 的**内部**函数（未 export），只 import 不 re-export。
// 它们是 Store 两个实现与 ExplorerService / ExplorerThreadService 的共用依赖；留在 index.ts 会让
// 批 B 搬 store 时产生 store → index 的值级回流边，P2 刚清零的环会重新出现。
import { containsAnyString, defaultExplorerPlan, defaultPlanExploration, defaultThreadContextSummary, isVerificationRun, parsePlanValidationIssues, parseStringArray, parseThreadContextSummary, stripPlanProtocol, summarizeExplorerMessage, threadTitleMetadata } from "./store/records.js";
// InMemoryPipelineStore 用纯 re-export：index.ts 内部从不实例化它（只有 api 的 server.ts
// 与测试从本 barrel 取），无需为它建本地绑定。SqlitePipelineStore 随后同理。
export { InMemoryPipelineStore } from "./store/in-memory-store.js";
export { SqlitePipelineStore } from "./store/sqlite-store.js";
// explorer/thread-selection.ts 的两个辅助（selectCurrentExplorer / projectPlaceholderExplorerTitle）
// 的使用方（PlanService / ExplorerService / ExplorerThreadService）在批 C 已全部搬走，
// index.ts 内部不再引用；它们**不是**公共契约（原先就没 export），故这里不 import 也不 re-export。
// 业务 Service 在批 C 全部搬走。每一行都是纯 re-export：index.ts 内部不再实例化它们
// （组合根在 apps/api），只需要把绑定转发给从 barrel 取用的消费者。
// 注意 PlanService 的 import + export 已降级为纯 re-export——唯一在 index.ts 内 new 它的
// Scheduler 也随批 C 搬走了。
export { ChangeProposalService } from "./run/change-proposal.js";
export { VerificationService } from "./run/verification.js";
export { MergeService } from "./run/merge.js";
export { PlanService } from "./plan/service.js";
// ExplorerService 与它的阻塞错误：ExplorerDeleteBlockedError 原先就是公共契约
// （api 侧按 instanceof / code 映射 409）。
export { ExplorerDeleteBlockedError, ExplorerService } from "./explorer/service.js";
export { ExplorerThreadService } from "./explorer/thread-service.js";
export { Scheduler, type SchedulerOptions } from "./run/scheduler.js";
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




export type CreateChangeProposalInput = {
  runId: string;
  reason: string;
  requestedChanges: string[];
  contract: PlanContract;
  createdBy?: string;
};



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
