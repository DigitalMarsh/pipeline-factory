/**
 * 模块职责：历史 V1 扁平 Plan 合同的运行时结构校验。
 *
 * 为什么从 index.ts 抽出来：plan/completion.ts 的 assessPlanArtifact 在 V1 分支上要调它。
 *   计划里"S4 只需要 plan-spec.js 与 REQUIRED_PLAN_AREAS"这一条与实测不符——V1 校验器一直在
 *   index.ts 里。若不一起搬走，completion.ts 就会从 index.ts 取值导入它，与 index.ts 对
 *   completion.ts 的导入构成新的双模块值级环：回流边从 termination-gates 换成 completion，
 *   计数不变，等于白做。它只依赖 platform/guards.ts 与 PlanContract 类型，因此可以独立成模块。
 *
 * 维护提示：
 *   1) V1 是**历史形态**：新 Explorer 只产出 V2（见 assessPlanArtifact 的 schemaVersion === 2 分支），
 *      本文件存在只是为了让旧库里的 V1 合同仍能被校验与确认。不要在这里加新字段。
 *   2) 本函数是"抛错"语义（Error），而 plan-spec.ts 的 validateGeneratedPlanSpec 是"返回问题列表"
 *      语义。assessPlanArtifact 靠 try/catch 适配这个差异，改动任一侧的错误类型都会影响对方。
 *   3) 任务依赖环检测用的是 visiting/visited 双集合的 DFS。改成单集合 visited 会把"重复引用
 *      同一个前置任务"误判成环。
 *   4) `missingVerificationCommands` 是**跨模块的判定规则**（scheduler / dispatch-coordinator /
 *      plan service 都要用）。它放在本文件是因为本文件已在 barrel 的导出里，不必新增模块；
 *      但它与 V1 校验器没有语义关系，不要因为同处一文件就把它们合并。
 */
import { isNonEmptyStringArray, isStringArray } from "../platform/guards.js";
import type { PlanContract } from "../index.js";
import type { ResolvedPlanContract } from "./plan-spec.js";
import type { RegisteredCommandDefinition } from "../platform/commands.js";

/**
 * 判定"这个 Plan 还缺哪些已注册的验证命令"——**唯一出处**。
 *
 * 为什么必须唯一：这条规则原先在三处各写了一遍，而且分成两套不一致的规则：
 *   - run/scheduler.ts 的 assertVerificationCommands 与 PlanService.reviseConfiguration
 *     只读 V1 的 `contract.verificationCommandIds`，并把 settings.commands 里**任何**命令都算作已注册；
 *   - PlanDispatchCoordinator.evaluateWait 在 revision 带 resolvedContract 时改读已解析契约的
 *     `resolvedContract.verification.commandIds`，且只把 `category === "verification"` 且
 *     `enabled !== false` 的命令算作已注册。
 * 分歧的后果是"同一个 Plan 该不该被拦"取决于**谁先问**：派发前的 evaluateWait 放行，
 * 但 Scheduler.start 里的同名校验抛 `RUN_PREREQUISITES_UNSATISFIED`，最终表现为
 * `WAITING / NEEDS_CONFIGURATION`。典型触发是当前形状的 `verification.mode: "NONE"`
 * （解析后 commandIds 为空、按设计应当被 SKIPPED 而非被拦）却仍带着一份陈旧的 V1 镜像 id。
 *
 * 统一到 coordinator 的那套：已解析契约是权威来源；未启用或非 verification 类别的命令
 * 不该被当成"已注册"。传 `resolvedContract` 时以它为准，否则回落到 V1 平面。
 */
export function missingVerificationCommands(input: {
  contract: Pick<PlanContract, "verificationCommandIds">;
  resolvedContract?: Pick<ResolvedPlanContract, "verification"> | undefined;
  commands: readonly RegisteredCommandDefinition[];
}): string[] {
  const expected = input.resolvedContract ? input.resolvedContract.verification.commandIds : input.contract.verificationCommandIds;
  const registered = new Set(
    (input.resolvedContract
      ? input.commands.filter((command) => command.category === "verification" && command.enabled !== false)
      : input.commands
    ).map((command) => command.commandId),
  );
  return expected.filter((commandId) => !registered.has(commandId));
}

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
