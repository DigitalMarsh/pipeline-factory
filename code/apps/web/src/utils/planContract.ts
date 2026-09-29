/**
 * 模块职责：给界面用的**单一契约视图** —— 同一份 Plan 在数据里有三种表示
 *   （V1 扁平 `contract`、模型产出的 `generatedSpec`、Factory 解析后的 `resolvedContract`），
 *   本模块决定"界面该读哪一个"，避免每个组件各自决定一遍。
 *
 * 为什么需要它：V2 的 `contract` 是**有损投影**（`dependsOnPlanIds` 被填成 []、`priority` 为 0，
 *   见 domain 的 `executionContractFromResolvedV2`），却因为字段名简短而在界面里被优先读取——
 *   于是界面上显示的 scope / 任务 / 验证命令可能与真正执行的那份不一致。事实来源是
 *   `resolvedContract`（Confirm 时冻结），V2 Plan 必须优先读它。
 *
 * 维护提示：
 *   1) 取值顺序固定为 `resolvedContract → generatedSpec → contract`。不要为了某个页面"少一次判空"
 *      改成只读 `contract`：那正是本轮要消掉的分歧。
 *   2) 这里**只做读投影**，不构造对象、不补默认值——缺失就是缺失，界面该显示占位符而不是编一个。
 *   3) 新页面要读 Plan 的 goal / scope / tasks / 验证命令时用这里，不要直接摸 `plan.contract`。
 */
import type { Plan, PlanTask } from "../types";

export type PlanContractView = {
  goal: string;
  acceptanceCriteria: string[];
  include: string[];
  exclude: string[];
  baseBranch: string;
  baseCommit: string;
  tasks: PlanTask[];
  verificationCommandIds: string[];
  maxRepairAttempts: number | null;
  mergeStrategy: string;
  artifactMode: string | null;
  artifactPath: string | null;
  dependsOnPlanIds: string[];
  /** 这一视图来自哪一层，便于界面标注"(冻结)"/"(生成)"/"(历史记录)"。 */
  source: "resolved" | "generated" | "legacy";
};

/** 把三种表示收敛成界面唯一的读取面；V2 优先 `resolvedContract`。 */
export function planContractView(plan: Plan | null | undefined): PlanContractView | null {
  if (!plan) return null;
  const resolved = plan.resolvedContract;
  if (resolved) {
    return {
      goal: resolved.objective.goal,
      acceptanceCriteria: resolved.objective.acceptanceCriteria ?? [],
      include: resolved.scope.includePaths ?? [],
      exclude: resolved.scope.excludePaths ?? [],
      baseBranch: resolved.repository.baseBranch,
      baseCommit: resolved.repository.baseCommit,
      tasks: resolved.tasks ?? [],
      verificationCommandIds: resolved.verification?.commandIds ?? [],
      maxRepairAttempts: resolved.execution?.maxRepairAttempts ?? null,
      mergeStrategy: resolved.merge?.strategy ?? "—",
      artifactMode: resolved.artifact?.mode ?? null,
      artifactPath: resolved.artifact?.path ?? null,
      dependsOnPlanIds: plan.contract?.dependsOnPlanIds ?? [],
      source: "resolved",
    };
  }
  const generated = plan.generatedSpec;
  const contract = plan.contract;
  if (!contract) return null;
  return {
    goal: generated?.objective.goal ?? contract.goal ?? "",
    acceptanceCriteria: generated?.objective.acceptanceCriteria ?? contract.acceptanceCriteria ?? [],
    include: generated?.scope.includePaths ?? contract.include ?? [],
    exclude: generated?.scope.excludePaths ?? contract.exclude ?? [],
    baseBranch: contract.baseBranch ?? "—",
    baseCommit: contract.baseCommit ?? "—",
    tasks: (generated?.tasks ?? contract.tasks ?? []) as PlanTask[],
    verificationCommandIds: contract.verificationCommandIds ?? [],
    maxRepairAttempts: contract.maxRepairAttempts ?? null,
    mergeStrategy: generated?.merge.strategy ?? contract.mergeStrategy ?? "—",
    artifactMode: generated?.artifact.mode ?? contract.artifactMode ?? null,
    artifactPath: generated?.artifact.path ?? contract.artifactPath ?? null,
    dependsOnPlanIds: contract.dependsOnPlanIds ?? [],
    source: generated ? "generated" : "legacy",
  };
}
