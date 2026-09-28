/**
 * 模块职责：Pipeline Factory 领域层的**唯一公共入口**（barrel）—— 把 src/ 下各域模块的
 *   公共契约转发给消费者（apps/api、apps/web 的类型引用、以及 domain 自身的横切测试）。
 *
 * 本文件自批 E 起**不含任何声明体**：没有类型定义、没有值级语句，每一行都是 import / export。
 *   于是"领域层的公共契约有哪些"只读这一个文件即可，"某个符号实现在哪"顺着 specifier 走。
 *   它同时**不含任何 node: 前缀的导入**。这条不变量可随时复核：
 *       grep -nE 'from "(node|node:)' src/index.ts   # 必须为空
 *   **但这只是本文件的性质，不是领域层的性质。** 领域层并未把 IO 收敛到少数几处：
 *   58 个非测试模块里有 19 个直接 import node:，集中在 platform/（子进程）、git/
 *   （子进程 + 文件系统）、tools/（文件系统 + 子进程 + 哈希）、store/sqlite-store.ts
 *   （node:sqlite）、model/codex-app-server.ts（子进程），另有 node:crypto 散落在
 *   plan/service.ts、project/project.ts、run/{merge,change-proposal,verification}.ts。
 *   "本文件是纯的"与"领域层是纯的"是两件事，不要用前者推断后者。
 *   另一条不变量是本文件只有 import / export 语句：任何顶层声明（type / class / const /
 *   function）都不应再出现 —— 新概念一律放它所属的域目录，这里只加一行转发。
 *
 * 目录约定：按域分目录，域内 `types.ts` 只放类型，实现放在语义命名的模块里
 *   （platform/ model/ store/ plan/ explorer/ run/ agent/ tools/ project/ git/）。
 *
 * 模块可达性（批 F 实测，可复算）：58 个非测试模块 = 本文件自身 + 本文件直接转发的
 *   50 个 + 只被相对 import 的内部模块 7 个 + **孤立模块 0 个**。也就是说没有"谁都够不着"
 *   的隐蔽模块，每个模块要么是公共契约的域入口，要么在下面维护提示 3 里被显式登记为内部。
 *   **新增模块时必须落进这三类之一**；若出现第三类（没人 import），那是死代码，先判断
 *   是接线缺失还是该删，不要靠"补进 barrel"来消除账面孤立。
 *
 * 维护提示：
 *   1) **re-export 有两种形态，选错会在运行时才炸**：
 *      - 本文件内部不再使用该符号 → 纯 re-export：`export { X } from "./y.js";`
 *      - 本文件内部还要用它 → 必须写成两条：`import { X } from "./y.js";` 与 `export { X };`
 *        纯 re-export **不会在本模块作用域创建绑定**，此时内部引用会得到
 *        `ReferenceError: X is not defined`（P2 解环期间踩过这个坑，且只在运行时暴露）。
 *      批 E 之后本文件已无内部引用，**新符号默认用纯 re-export**；将来若又在这里做组装，
 *      必须先把对应行改回两条。
 *   2) **这些行就是公共契约，不要因为"看起来没人用"就删**：例如 ToolCallLedger
 *      （全仓唯一使用者是 m5-recovery.test.ts）与 ExecutionThreadSummary
 *      （唯一引用是 plan/service.ts 里一条导入后从未使用的 import）目前都没有真实调用方，
 *      但它们仍是导出契约的一部分。删之前先全仓 grep，并检查 README 与 apps/。
 *   3) **不是公共契约的符号一律不转发**（它们此前就不在 index.ts 的导出里）：
 *      defaultProcessRunner（platform/commands.ts）、defaultGitCommand / gitCommand /
 *      gitResolveCommit（git/）、extractResponseText（model/gateway-openai.ts）、
 *      isRecord / isStringArray / isNonEmptyStringArray（platform/guards.ts）、
 *      store/records.ts 的 11 个辅助、selectCurrentExplorer / projectPlaceholderExplorerTitle
 *      （explorer/thread-selection.ts）、freezeDeep / freezeRevision（platform/freeze.ts）、
 *      snapshotProjectWorkingTree（git/worktree-snapshot.ts，只被 git/worktree.ts 使用）、
 *      resolveExecutorWorkingDirectory（tools/executor-working-directory.ts，只被
 *      agent/executor-agent.ts 使用）。按模块看，内部模块恰好是这 7 个：
 *      explorer/thread-selection.ts、git/baseline.ts、git/worktree-snapshot.ts、
 *      platform/freeze.ts、platform/guards.ts、store/records.ts、
 *      tools/executor-working-directory.ts。
 *      **"没被外部引用"不等于"该公开"**：批 F 曾计划把 executor-working-directory.ts
 *      补进本文件，实测后否决 —— 它从未在导出契约里（253 个符号从来不含它），apps/ 零引用，
 *      是上述 7 个内部模块之一。给零外部消费者的符号增加公共面，只会让 P8 的类型共享多背
 *      一个无意义的契约。**判据：不是"它够不够得着"，而是"外部有没有人要它"。**
 *   4) 值的导出与类型的导出**分开写**（`export {}` / `export type {}`），不要混在一行 ——
 *      混写会让"哪些是运行时绑定"难以速查。
 *   5) 新增导出时放进所属域的段落，不要追加到文件末尾。
 *   6) 本文件曾长期承担"聚合核心领域模型"的角色（原 5,659 行），P3 的批 A–E 已把实现与类型
 *      全部按域搬走。**不要再往这里加实现**：新的领域概念放它所属的域目录，本文件只加一行转发。
 */

// ─────────────────────────── platform/：零领域依赖的通用设施 ───────────────────────────
export { EXPLORER_PLAN_INSTRUCTIONS, EXPLORER_PLAN_REQUIREMENTS, REQUIRED_PLAN_AREAS } from "./platform/plan-requirements.js";
export type { ExplorerPlanRequirement } from "./platform/plan-requirements.js";
export { redactAuditPayload, redactAuditText } from "./platform/redaction.js";
// 命令执行端口与它的本地实现。defaultProcessRunner 是模块私有（只出现在默认参数里），不转发。
export { RegisteredCommandExecutor } from "./platform/commands.js";
export type { CommandExecutor, CommandInvocation, CommandResult, HookContext, ProcessRunner, RegisteredCommandDefinition } from "./platform/commands.js";

// ─────────────────────────── store/：审计事件与持久化 ───────────────────────────
// DomainEvent 的 id / sequence / occurredAt 由 Store 赋值、脱敏也在 appendEvent 内完成，
// 所以它放在 store/types.ts 而不是某个业务域。
export type { DomainEvent } from "./store/types.js";
export type { EventQuery, PipelineStore } from "./store/pipeline-store.js";
export type { EventPruneInput } from "./store/event-retention.js";
export { PRUNABLE_EVENT_TYPES, isPrunableEvent, prunableEventIds } from "./store/event-retention.js";
export { InMemoryPipelineStore } from "./store/in-memory-store.js";
export { SqlitePipelineStore } from "./store/sqlite-store.js";

// ─────────────────────────── plan/：Plan 类型、合同校验与状态机 ───────────────────────────
export type { ApprovedChangeProposal, CandidatePlan, ChangeProposal, ChangeProposalStatus, CreateCandidatePlanInput, CreateChangeProposalInput, CreateRevisionDraftInput, PlanContract, PlanLifecycleEntry, PlanLifecycleStatus, PlanRevisionDraft, PlanRevisionDraftStatus, PlanRevisionV2, PlanStatus, PlanTask, RevisionLifecycleProjection } from "./plan/types.js";
export { updatePlanStatus } from "./plan/status-transition.js";
export { validatePlanContract } from "./plan/contract.js";
export { assessPlanCompletion } from "./plan/completion.js";
export type { PlanArtifact, PlanCompletionAssessment } from "./plan/completion.js";
export { assertSafeProjectRelativeGlob, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2 } from "./plan/plan-v2.js";
export type { GeneratedPlanSpecV2, GitBaseline, PlanArtifactMode, PlanValidationIssue, PlanValidationIssueCode, ResolvedPlanContractV2 } from "./plan/plan-v2.js";
export type { PlanIndexRow, PlanQuery, PlanQueryProjection, PlanQueryResult, PlanQuerySort } from "./plan/query.js";
export { PlanService } from "./plan/service.js";

// ─────────────────────────── explorer/：探索会话、需求分区与结构化追问 ───────────────────────────
export type { CreateExplorerInput, ExplorerDeletionInput, ExplorerDeletionSummary, ExplorerInputRequest, ExplorerInputRequestStatus, ExplorerPlan, ExplorerThread, ExplorerThreadContextSummary, ExplorerThreadState, ExplorerTurn, ModelInputAnswers, ModelInputQuestion, ModelInputRequest, PlanExploration, PlanExplorationStatus, RegisterThreadInput } from "./explorer/types.js";
export { composeExplorerTitle, explorerTimestamp, ModelExplorerTitleGenerator, normalizeExplorerTitle, placeholderExplorerTitle } from "./explorer/explorer-title.js";
export type { ExplorerTitleGenerator, ExplorerTitleSource, ExplorerTitleStatus } from "./explorer/explorer-title.js";
export { projectExplorerActivity } from "./explorer/explorer-activity.js";
export type { ExplorerActivityInput, ExplorerActivityItem, ExplorerActivityKind } from "./explorer/explorer-activity.js";
// ExplorerDeleteBlockedError 是公共契约：api 侧按 instanceof / code 把它映射成 409。
export { ExplorerDeleteBlockedError, ExplorerService } from "./explorer/service.js";
export { ExplorerThreadService } from "./explorer/thread-service.js";

// ─────────────────────────── run/：Run 状态机、journal、分支、验证与合并 ───────────────────────────
export type { ExecutionJournalCorrelation, ExecutionJournalEntry, ExecutionJournalPayload, ExecutionTelemetry, ExecutionThread, ExecutionThreadState, ExecutionThreadSummary, JournalEntryType, MergeReconciliationItem, MergeReconciliationOutcome, MergeReconciliationReport, MergeRequest, RepairExecutor, Run, RunStatus, VerificationCommandExecutor, VerificationRun, VerificationStatus } from "./run/types.js";
export { LifecycleHookRunner } from "./run/hooks.js";
export type { HookDefinition, HookExecution, HookRunResult } from "./run/hooks.js";
export { allocateRunBranchLeaf, composeRunBranchLeaf, ModelRunBranchNameGenerator, normalizeRunBranchSlug, runBranchDate, runBranchName } from "./run/run-branch.js";
export type { RunBranchNameGenerator, RunBranchNameInput } from "./run/run-branch.js";
export { Scheduler } from "./run/scheduler.js";
export type { SchedulerOptions } from "./run/scheduler.js";
// 四个业务 Service 全部是纯 re-export：index.ts 内部不再实例化任何一个（组合根在 apps/api）。
// PlanService 与 Scheduler 曾经需要 import + export 两条，批 C8 之后已降级。
export { ChangeProposalService } from "./run/change-proposal.js";
export { VerificationService } from "./run/verification.js";
export { MergeService } from "./run/merge.js";
export { PlanDispatchCoordinator } from "./run/dispatch-coordinator.js";
export type { PlanDispatchCoordinatorOptions, PlanDispatchPhase, PlanDispatchState, PlanDispatchStatus, PlanDispatchWaitReason } from "./run/dispatch-coordinator.js";
export { RecoveryCoordinator } from "./run/recovery-coordinator.js";

// ─────────────────────────── agent/：Agent Loop、终止门与 Executor ───────────────────────────
export type { ProjectExecutionMessage, ProjectExecutionThread, ProjectExecutionTurnStatus } from "./agent/types.js";
export { AGENT_LOOP_DIAGNOSTIC_STEP_TYPES, AgentLoopEngine, projectAgentLoopDiagnostics } from "./agent/agent-loop.js";
export type { AgentLoop, AgentLoopDiagnostics, AgentLoopInput, AgentLoopMode, AgentLoopResult, AgentLoopState, AgentLoopStep, AgentLoopStepInput, AgentLoopStepStatus, AgentLoopRunner, AgentStepType, GateContext, GateDecision, TerminationGate } from "./agent/agent-loop.js";
export { PlanCompletenessGate, TaskProgressGate } from "./agent/termination-gates.js";
export { ExecutorAgent, inspectWorkspaceScope, parseExecutorReport } from "./agent/executor-agent.js";
export type { ExecutorAgentOptions, ExecutorReport, WorkspaceScopeInspection, WorkspaceScopeInspector } from "./agent/executor-agent.js";
export { PROJECT_EXECUTION_MODELS, PROJECT_EXECUTION_REASONING_EFFORTS, ProjectExecutionThreadService } from "./agent/project-execution-thread.js";
export type { ProjectExecutionThreadServiceOptions, ProjectExecutionThreadSnapshot } from "./agent/project-execution-thread.js";

// ─────────────────────────── model/：ModelGateway 端口与三个实现 ───────────────────────────
export type { ModelCapabilities, ModelEvent, ModelGateway, ModelMessage, ModelRequest, ModelRole, ModelRoleConfig, ModelToolDefinition } from "./model/types.js";
export { mergeModelUsage, normalizeModelUsage } from "./model/usage.js";
export type { ModelUsage, ModelUsageScope } from "./model/usage.js";
// 三个 ModelGateway 实现并列：codex-app-server（生产，真流式）、gateway-openai（HTTP 适配器）、
// stub-gateway（测试替身）。apiKey 一律由组合根注入，本目录不读任何环境变量、不落库。
export { CodexAppServerClient, CodexAppServerGateway } from "./model/codex-app-server.js";
export type { CodexAppServerClientOptions, CodexAppServerEvent, CodexAppServerGatewayOptions, CodexAppServerSession, CodexAppServerSessionFactory, CodexSpawnProcess, CodexThreadStartParams, CodexTurnStartParams } from "./model/codex-app-server.js";
export { OpenAIModelGateway } from "./model/gateway-openai.js";
export type { ModelFetch, ModelFetchResponse, ModelResult, OpenAIModelGatewayOptions } from "./model/gateway-openai.js";
export { StubModelGateway } from "./model/stub-gateway.js";
export { mapCodexRateLimits } from "./model/codex-rate-limits.js";
export type { CodexRateLimitBucket, CodexRateLimitWindow, CodexRateLimitsResponse, MappedCodexRateLimits, MappedRateLimit } from "./model/codex-rate-limits.js";

// ─────────────────────────── tools/：工具端口、运行时与各来源的工具 ───────────────────────────
export type { DurableToolCallStatus, PersistedToolCall, ToolCall, ToolCallResult, ToolName, ToolRole } from "./tools/types.js";
export { ToolGateway } from "./tools/gateway.js";
export type { ToolGatewayOptions } from "./tools/gateway.js";
export { DurableToolRuntime } from "./tools/tool-runtime.js";
export type { ToolExecutionContext, ToolRuntime } from "./tools/tool-runtime.js";
export { BuiltinToolExecutor } from "./tools/builtin-tool-executor.js";
export type { BuiltinToolContext, BuiltinToolExecutorOptions } from "./tools/builtin-tool-executor.js";
export { McpClient, McpToolRegistry } from "./tools/mcp.js";
export type { McpClientOptions, McpRpcTransport, McpServerConfig, McpToolCallResult, McpToolDefinition, McpToolRegistryOptions, QualifiedMcpTool } from "./tools/mcp.js";
export { PluginRegistry, PluginToolBridge } from "./tools/plugin.js";
export type { PluginManifest, PluginRegistryOptions, PluginStatus, PluginTool, PluginToolDefinition, PluginToolHandler } from "./tools/plugin.js";
export { ComputerUseBridge } from "./tools/computer-use.js";
export type { ComputerUseAction, ComputerUseBridgeOptions, ComputerUseEvent, ComputerUseHostAdapter, ComputerUseScreenshot } from "./tools/computer-use.js";
export { ToolCallLedger } from "./tools/tool-call-ledger.js";
export type { ToolCallLedgerEntry, ToolCallLedgerStatus } from "./tools/tool-call-ledger.js";

// ─────────────────────────── git/：领域层的 Git IO 边界 ───────────────────────────
// 领域层唯一的 Git 子进程与文件系统访问点。它与 platform/commands.ts 一起构成本 barrel
// 内仅有的两处 IO —— 注意本文件自身不含 node: 导入，IO 都在被转发的模块里。
export { LocalGitWorktreeAdapter } from "./git/worktree.js";
export type { GitCommandRunner, LocalGitWorktreeOptions, Workspace, WorkspaceAdapter } from "./git/worktree.js";
export { localGitMergeInspector } from "./git/merge-inspector.js";
export type { GitMergeInspector } from "./git/merge-inspector.js";

// ─────────────────────────── project/：项目聚合与配置快照 ───────────────────────────
export { EXECUTION_SLOT_RUN_STATUSES, ProjectService } from "./project/project.js";
export type { CreateProjectInput, Project, ProjectConfigRevision, ProjectExecutionSnapshot, ProjectSettings, ProjectSettingsInput, ProjectStatus, ProjectSummary, UpdateProjectInput } from "./project/project.js";
