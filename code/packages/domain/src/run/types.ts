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
 *      与 DomainEvent.payload 同理，只放结构化事实。**写入侧确实只追加**，但启动期的收缩迁移
 *      （`sqlite-store` 的 `compactTextStreams`）会把历史里逐次刷新留下的正文碎片并成段——
 *      读到的内容不变，条目边界会变，所以别拿"行数"或"某条 entry 还在不在"当业务依据。
 *      ExecutionJournalCorrelation 是跨模型轮次、Plan 任务与 Provider 调用之间**唯一**的稳定关联
 *      字段集合；新增关联维度时加到这里，不要在 payload 里另起一个同义字段名。
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
 *      顶部的一条 import（导入了但从未使用）。它仍是 barrel 的公共契约，故保留；
 *      若将来要清理，先确认 web 侧确实不再需要从 domain 取。
 */
import type { ModelUsage, ModelUsageScope } from "../model/usage.js";
import type { CommandResult } from "../platform/commands.js";

/** Run 的执行、验证、合并和恢复状态；BLOCKED 需要人工关注。 */
export type RunStatus = "QUEUED" | "STARTING" | "IN_PROGRESS" | "READY_FOR_VERIFY" | "VERIFYING" | "MERGE_READY" | "BLOCKED" | "NEEDS_PLAN_CHANGE" | "STALE" | "RECOVERING" | "CANCELLED";
/** ExecutionThread 的展示状态，承载 Run 的实时模型输出和控制事实。 */
export type ExecutionThreadState = "ACTIVE" | "PAUSED" | "BLOCKED" | "CANCELLED" | "COMPLETED";
/**
 * Run journal 中可回放的事件类别。
 *
 * 只列**真的有人写入**的类别（写入点见 agent/executor-agent.ts 的 `append` 调用）。
 * 曾经的 `REPAIR` / `COMMIT` 两个成员没有任何写入点，真出现也只会掉进执行会话的
 * `unclassified` 显示成"未识别"；它们在最近一次清点里被删掉。
 */
export type JournalEntryType = "RUN_CREATED" | "HOOK_COMPLETED" | "HOOK_FAILED" | "HOOK_SKIPPED" | "MODEL_OUTPUT" | "PROVIDER_ACTIVITY" | "TOOL_CALL" | "TASK_PROGRESS" | "USER_GUIDANCE" | "VERIFICATION" | "RECOVERY";

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
  /**
   * `SUPERSEDED` = 这个 Run 后来又被补充要求推回去重做了一轮，**这个请求指向的 commit 已经不是
   * 最新的那份工作了**。它必须存在：`createRequest` 按 run 幂等，而 `confirmMerged` 只校验
   * "旧 sourceCommit 是新 targetCommit 的祖先"——没有这个状态，重新开工之后旧的 OPEN 请求会被
   * 原样返回，**没验过的新改动会跟着旧请求一起被合进去**。
   */
  status: "OPEN" | "MERGED" | "SUPERSEDED";
  humanConfirmationRequired: true;
  createdAt: string;
  mergedAt: string | null;
  /** 最近一次只读 Git reconciliation 观察到的目标提交；人工创建的请求为空。 */
  detectedTargetCommit?: string | null;
};

/**
 * 补充要求的**投递方式**。两种都落在这张表里，区别只是"什么时候取出来"：
 *   `STEER` —— 在正在跑的那个 Loop 的**下一个步骤边界**投递给模型（下一轮生效，不是打断当前回合）；
 *   `QUEUE` —— 留在表里，等这一轮进终态后由 Scheduler 取走，拼成一条要求**起新的一轮**。
 */
export type RunGuidanceMode = "STEER" | "QUEUE";
/** `PENDING` = 还没投递出去（界面必须显示成「待处理」，不能显示成已生效）。 */
export type RunGuidanceStatus = "PENDING" | "CONSUMED" | "CANCELLED";

/**
 * 一条提交给执行线程的补充要求。
 *
 * 为什么它必须**落库**而不是放在内存里：`QUEUE` 要活到 Loop 结束（可能跨进程重启），
 * `STEER` 也可能还没等到下一个步骤边界进程就被重启了。丢了它 = 用户以为说了、Agent 没听见，
 * 而这正是这次要修的病。
 */
export type RunGuidance = {
  id: string;
  runId: string;
  content: string;
  mode: RunGuidanceMode;
  status: RunGuidanceStatus;
  authorId: string;
  createdAt: string;
  consumedAt: string | null;
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
