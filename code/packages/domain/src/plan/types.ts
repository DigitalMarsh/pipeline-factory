/**
 * 模块职责：Plan 域的公共契约 —— 状态与生命周期投影、任务与执行合同、候选 Plan、
 *   变更提案、已确认 Revision 与可写 Draft，以及它们的创建输入。
 *
 * 为什么从 index.ts 抽出来（批 E）：Plan 是全系统的中心概念，这块类型此前占了
 *   index.ts 内联类型的最大一段。搬进 plan/ 之后它与 plan/service.ts、plan/plan-v2.ts、
 *   plan/status-transition.ts、plan/contract.ts、plan/completion.ts 同目录 ——
 *   "状态怎么流转、合同怎么校验、完成度怎么判定"都围着这几个类型展开。
 *
 * 维护提示：
 *   1) **PlanStatus 与 PlanLifecycleStatus 是两个层次**：前者是 Plan 自身的状态；
 *      后者多一个 NEEDS_CONFIGURATION（配置缺失，不是 Plan 的问题）。
 *      展示"当前走到哪一步"用 PlanLifecycleStatus；做状态机判断用 PlanStatus。
 *      **不要把 NEEDS_CONFIGURATION 塞进 PlanStatus** —— 它会让所有 switch 都要处理
 *      一个"根本不是 Plan 状态"的分支。基线豁免的那条失败
 *      （dispatch-coordinator.test.ts:121 期望 RUNNING，实得 WAITING / NEEDS_CONFIGURATION）
 *      就发生在这个层次交界处：改动这里之前先读该用例与豁免说明，不要顺手"修好"它。
 *   2) **PlanLifecycleEntry.occurredAt 为 null 表示"时间未知"，不是"刚刚"**。
 *      不要用同组其它条目的时间或 lastEventAt 去补 —— 那是猜的，会让时间线说谎。
 *   3) **PlanContract（V1 扁平合同）已标 @deprecated，只用于展示历史记录**；
 *      V2（GeneratedPlanSpecV2 / ResolvedPlanContractV2）才是 Explorer 输出与调度的唯一入口。
 *      新代码不要新增读取 PlanContract 字段的路径。
 *   4) **CandidatePlan.status 的每次变化都应走 plan/status-transition.ts 的 updatePlanStatus**，
 *      它同时维护 lastEventAt / attentionReason 并追加事件；直接赋值会让生命周期时间线缺条目。
 *   5) **PlanRevisionV2 是冻结快照**（Readonly + projectConfigSnapshot），确认之后不随
 *      Project 配置变化。provenance 为 LEGACY 表示旧数据无法补齐快照，只允许浏览、
 *      不能作为新执行来源 —— 别为了"让老 Plan 也能跑"去掉这个判断。
 *   6) **PlanRevisionDraft 是唯一可写的工作副本，永远不能直接成为 Executor 的合同**：
 *      必须先 confirm 成 PlanRevisionV2。BASE_CHANGED 表示基线已漂移，需要重建而不是继续编辑。
 *   7) ChangeProposal.contract 保持原值不可变（Readonly）：提案是"请求改"，不是"已经改"；
 *      批准后产生的是新 Revision，而不是就地改这个字段。
 *   8) CreateChangeProposalInput 只承载"请求"，因此没有 status / decidedAt 等决策字段 ——
 *      决策状态由 ChangeProposal 自己在批准/驳回时写入，不要提前塞进输入类型。
 */
import type { GeneratedPlanSpecV2, ResolvedPlanContractV2 } from "./plan-v2.js";
import type { ProjectExecutionSnapshot } from "../project/project.js";
import type { Run } from "../run/types.js";

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

export type CreateChangeProposalInput = {
  runId: string;
  reason: string;
  requestedChanges: string[];
  contract: PlanContract;
  createdBy?: string;
};
