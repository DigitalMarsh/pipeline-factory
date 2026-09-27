/**
 * 模块职责：历史 V1 扁平 Plan 合同的运行时结构校验。
 *
 * 为什么从 index.ts 抽出来：plan/completion.ts 的 assessPlanArtifact 在 V1 分支上要调它。
 *   计划里"S4 只需要 plan-v2.js 与 REQUIRED_PLAN_AREAS"这一条与实测不符——V1 校验器一直在
 *   index.ts 里。若不一起搬走，completion.ts 就会从 index.ts 取值导入它，与 index.ts 对
 *   completion.ts 的导入构成新的双模块值级环：回流边从 termination-gates 换成 completion，
 *   计数不变，等于白做。它只依赖 platform/guards.ts 与 PlanContract 类型，因此可以独立成模块。
 *
 * 维护提示：
 *   1) V1 是**历史形态**：新 Explorer 只产出 V2（见 assessPlanArtifact 的 schemaVersion === 2 分支），
 *      本文件存在只是为了让旧库里的 V1 合同仍能被校验与确认。不要在这里加新字段。
 *   2) 本函数是"抛错"语义（Error），而 plan-v2.ts 的 validateGeneratedPlanSpecV2 是"返回问题列表"
 *      语义。assessPlanArtifact 靠 try/catch 适配这个差异，改动任一侧的错误类型都会影响对方。
 *   3) 任务依赖环检测用的是 visiting/visited 双集合的 DFS。改成单集合 visited 会把"重复引用
 *      同一个前置任务"误判成环。
 */
import { isNonEmptyStringArray, isStringArray } from "../platform/guards.js";
import type { PlanContract } from "../index.js";

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
