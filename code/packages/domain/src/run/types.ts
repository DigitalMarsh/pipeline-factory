/**
 * 模块职责：Run 及其执行 / 验证 / 合并的契约 —— RunStatus、执行线程与它的 journal、
 *   执行遥测、验证与修复端口、Merge 请求与只读 reconciliation 报告。
 *
 * 为什么从 index.ts 抽出来（批 E）：这是 index.ts 内联类型里最后、也最"重"的一块。
 *   搬进 run/ 之后它与 run/scheduler.ts、run/dispatch-coordinator.ts、run/verification.ts、
 *   run/merge.ts、run/recovery-coordinator.ts 同目录 —— 那些 Service 的状态转换
 *   正是这些类型上方的注释所描述的规则。
 *
 * 维护提示：
 *   1) **RunStatus 是控制状态，ExecutionThreadState 是展示状态，两者不能互相推导。**
 *      Run 的 BLOCKED / NEEDS_PLAN_CHANGE / STALE / RECOVERING 各有进入条件
 *      （见 run/dispatch-coordinator.ts 与 run/recovery-coordinator.ts），
 *      **不要用"线程还活着"推断 Run 在跑**，也不要反过来用 Run 状态推线程状态。
 *   2) **ExecutionTelemetry 的 usageSource 是两条互斥的事实，不是"可信度"**：
 *      Provider 没给 usage 时 usage 保持 null 且 usageSource 记 "not-recorded"，
 *      **绝不在本地估算 token**（model/usage.ts 的注释写明了这条）。
 *      usageScope 记录用量是整轮还是单步；缺了它消费方无法判断累计口径，
 *      只能把累计值当单轮值展示。
 *   3) **journal 是只追加的回放事实，不决定控制状态**：ExecutionJournalEntry.payload
 *      与 DomainEvent.payload 同理，只放结构化事实。ExecutionJournalCorrelation 是
 *      跨模型轮次、Plan 任务与 Provider 调用之间**唯一**的稳定关联字段集合；
 *      新增关联维度时加到这里，不要在 payload 里另起一个同义字段名。
 *   4) **VerificationRun.commandResults 保存 CommandResult 原文**（含 exitCode / stdout /
 *      stderr），它是**证据**而不是结论；status 与 reason 才是结论。
 *      只存结论会让失败无法复盘 —— 这是排查验证失败时唯一的输入。
 *   5) **MergeReconciliationOutcome 的 UNAVAILABLE 不是失败**：它表示"暂时读不到 Git 事实"
 *      （仓库缺失等），必须与 NOT_MERGED 分开 —— 把前者当后者会把暂不可用的 Run
 *      误标成"未合并"并触发错误的人工动作。这条约束在 git/merge-inspector.ts 里实现，
 *      该文件四个方法的"仓库缺失"返回值刻意不一致（见该文件头）。
 *   6) **MergeRequest.humanConfirmationRequired 是字面量 true**：自动合并这条路
 *      在类型上就不存在，不要把它放宽成 boolean。
 *   7) ExecutionThreadSummary 目前**没有真正的使用者**：全仓唯一引用是 plan/service.ts
 *      顶部的一条 import（导入了但从未使用）；前端 TaskLifecycleCard 用的是
 *      apps/web/src/types.ts 里自己的同名副本。它仍是 barrel 的公共契约，故保留；
 *      若将来要清理，先确认 web 侧确实不再需要从 domain 取。
 */
import type { ModelUsage, ModelUsageScope } from "../model/usage.js";
import type { CommandResult } from "../platform/commands.js";

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

/** 执行线程的持久化遥测；不对缺失的 Provider usage 做本地估算。 */
export type ExecutionTelemetry = {
  model: string | null;
  reasoningEffort: string | null;
  /**
   * 这次 Run 由哪个 agent（后端 id）执行 —— 取自 `agent.loop.started` 的端点指纹。
   * 与 model 是两件事：同一个模型名可能来自不同后端，而"这一轮到底是谁跑的"是排障第一问。
   * **可选**：遥测是以 JSON 落库的，本字段引入之前的历史行没有这个键。
   */
  backend?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  usage: ModelUsage | null;
  usageSource: "provider" | "not-recorded";
  usageScope: ModelUsageScope | null;
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

export type ExecutionThreadSummary = {
  id: string;
  runId: string;
  state: string;
} | null;

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
