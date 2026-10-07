/**
 * 模块职责：Explorer 域的公共契约 —— 线程与它的跨 Plan 上下文摘要、需求分区（ExplorerPlan）、
 *   对话轮次（ExplorerTurn）、探索完整度投影，以及结构化追问与注册/删除的输入类型。
 *
 * 为什么从 index.ts 抽出来（批 E）：Explorer 的类型此前与 Plan、Run、Merge 的类型
 *   在 index.ts 里交错排列，而它真正的邻居是 explorer/service.ts、explorer/thread-service.ts、
 *   explorer/thread-selection.ts、explorer/explorer-title.ts、explorer/explorer-activity.ts。
 *   搬进同目录后，"会话生命周期"与"会话记录形状"可以一起读。
 *
 * 维护提示：
 *   1) **ExplorerThread 与 ExplorerPlan 是一对多的两层结构，不要合并**：线程是长期会话
 *      （持有跨 Plan 的 Provider 上下文摘要），其下每个需求分区**拥有隔离的 Provider 会话**
 *      （providerThreadId 挂在 ExplorerPlan 上）。这正是"换需求不串上下文"的实现方式 ——
 *      把 providerThreadId 提到线程层会直接破坏它。
 *   2) **ExplorerThreadState 的 ARCHIVED 只禁止新写入，不删除历史**（见类型上方注释）；
 *      真正的删除走 explorer/service.ts 的 ExplorerDeleteBlockedError 那条路径，
 *      且有基于 Run 状态的前置校验（见 explorer/service.ts 的 EXPLORER_DELETE_ACTIVE_RUN_STATUSES）。
 *   3) **PlanExploration.status 只表达"当前探索是否还缺关键决策"**，取值只有
 *      INCOMPLETE / READY；缺什么写在 missing、已完成什么写在 completed，
 *      两者都由 platform/plan-requirements.ts 的 REQUIRED_PLAN_AREAS 推导。
 *      它与 PlanStatus 无关 —— 一个 READY 的探索完全可以对应 DRAFT 的候选 Plan。
 *   4) **ExplorerPlan.newPlanRequested 是"用户显式要求开新 Plan"的标记，不是缓存**：
 *      store/sqlite-store.ts 的投影逻辑里 `newPlanRequested ? null : plan.candidatePlanId ?? …`
 *      会在它为 true 时**忽略 candidatePlanId**。因此不要用"有没有 candidatePlanId"
 *      去反推它，也不要用 `?? false` 把"未设置"与"显式设为 false"混为一谈。
 *   5) **ModelInputQuestion.isSecret 的答案只能保存脱敏摘要**：ExplorerInputRequest
 *      只存 redactedAnswerSummary，不存原文。在这个类型上加一个 answers 原文字段，
 *      等于把口令/密钥写进审计表。
 *   6) ExplorerThread / ExplorerPlan / ExplorerTurn 的部分字段（titleSource、titleStatus、
 *      providerThreadId、runtimeStatus 等）在历史数据里可能整体缺失，读路径必须容忍
 *      undefined —— store/records.ts 的反序列化刻意不抛错，原因见该文件头。
 *   7) ExplorerTurn.sequence 用于稳定回放与定位 Plan 卡片，**不是数组下标**；
 *      explorerPlanId 缺失表示需要按旧线程回填到 Plan 1（见字段注释），不要当成 null 处理。
 */
import type { ExplorerTitleSource, ExplorerTitleStatus } from "./explorer-title.js";
import type { PlanValidationIssue } from "../plan/plan-spec.js";

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

/**
 * 删除**线程里的一条需求**所需的关联集合。
 *
 * 与 `ExplorerDeletionInput` 的两个区别是刻意的：
 *   1) 没有 `replacementExplorerId`——线程不删，项目上的当前线程指针不用动；
 *   2) 这里列的 id 全部由调用方**按需求**算好（不是按线程）——store 侧只按 id 删行，
 *      并按 `explorerPlanIds` 处理两处只有需求级才有的关联（回合、结构化提问），
 *      再不去碰线程行。线程行上的六个指针由 ExplorerService 用既有的 updateThread 写回。
 */
export type ExplorerPlanDeletionInput = {
  projectId: string;
  explorerId: string;
  explorerPlanIds: string[];
  turnIds: string[];
  planIds: string[];
  runIds: string[];
  executionThreadIds: string[];
  agentLoopIds: string[];
  inputRequestIds: string[];
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
};

/** 提交给 Provider 的按问题 id 分组答案。 */
export type ModelInputAnswers = Record<string, { answers: string[] }>;

/**
 * 本地持久化的结构化输入请求状态。
 *
 * 曾经还有一个 `AUTO_RESOLVED`：类型、界面文案、样式类都写好了，但**全仓没有任何写入点**，
 * 永远不可能出现。它在上一次清点里被删掉——要恢复自动应答，先有"谁在什么条件下自动作答"
 * 这一事实，再回来加状态。
 *
 * `autoResolutionMs` 是同一件事的另一半，2026-10-07 一起清掉：Codex 的 requestUserInput 载荷里
 * 有这个名字，我们把它一路带着（模型类型 → 领域事实 → SQLite 列 → SSE 载荷 → web 类型），
 * 却**没有任何消费方**；而且本机 40 条真实请求里它**一次都不是非空**（40/40 NULL）。
 * 一个从来不到达、也没人读的字段，唯一的作用是让人以为"超时自动应答"已经实现了。
 */
export type ExplorerInputRequestStatus = "OPEN" | "SUBMITTING" | "ANSWERED" | "CANCELLED" | "RECOVERY_REQUIRED";

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
  status: ExplorerInputRequestStatus;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  redactedAnswerSummary: Record<string, unknown> | null;
};
