/**
 * 模块职责：给界面用的**单一契约视图** —— 同一份 Plan 在数据里有两层表示
 *   （模型产出的 `generatedSpec`、Factory 解析后的 `resolvedContract`），
 *   本模块决定"界面该读哪一个"，避免每个组件各自决定一遍。
 *
 * 为什么需要它：界面上有多处要读 goal / scope / 任务 / 验证命令，取值顺序若各自决定一遍就会漂移。
 *   事实来源是 `resolvedContract`（Confirm 时冻结），草稿期才回落到模型产出的 `generatedSpec`。
 *   曾经还有第三层——V1 扁平合同 `plan.contract`，那是一份**有损投影**（`dependsOnPlanIds` 被填成 []、
 *   `priority` 归 0），字段名短反而被优先读，界面显示的可能不是真正执行的那份。它已经删掉了。
 *
 * 维护提示：
 *   1) 取值顺序固定为 `resolvedContract → generatedSpec`，没有第三种来源。
 *   2) 这里**只做读投影**，不构造对象、不补默认值——缺失就是缺失，界面该显示占位符而不是编一个。
 *   3) 新页面要读 Plan 的 goal / scope / tasks / 验证命令时用这里，不要直接摸 `plan.resolvedContract`。
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
  /** 这一视图来自哪一层，便于界面标注"(冻结)"/"(生成)"。 */
  source: "resolved" | "generated";
};

/** 把两层表示收敛成界面唯一的读取面；优先 `resolvedContract`。 */
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
      dependsOnPlanIds: resolved.dependsOnPlanIds ?? [],
      source: "resolved",
    };
  }
  const generated = plan.generatedSpec;
  if (!generated) return null;
  // 尚未解析的 spec：基底与验证命令都还没被 Factory 填上，只能是占位符——不编。
  return {
    goal: generated.objective.goal,
    acceptanceCriteria: generated.objective.acceptanceCriteria ?? [],
    include: generated.scope.includePaths ?? [],
    exclude: generated.scope.excludePaths ?? [],
    baseBranch: "—",
    baseCommit: "—",
    tasks: (generated.tasks ?? []) as PlanTask[],
    verificationCommandIds: [],
    maxRepairAttempts: generated.execution?.maxRepairAttempts ?? null,
    mergeStrategy: generated.merge?.strategy ?? "—",
    artifactMode: generated.artifact?.mode ?? null,
    artifactPath: generated.artifact?.path ?? null,
    // 模型写不出 Plan id（它只写得出 `dependencies` 那串自然语言先决条件），草稿期恒为空。
    dependsOnPlanIds: [],
    source: "generated",
  };
}
