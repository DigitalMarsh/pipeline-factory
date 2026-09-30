/**
 * Plan V2 deliberately separates untrusted model output from the contract that
 * Factory persists and executes. In particular the model never supplies a
 * command id, repository identity, branch, commit or Project configuration.
 */
import type { ProjectExecutionSnapshot } from "../project/project.js";
import type { RegisteredCommandDefinition } from "../platform/commands.js";
import { isRecord } from "../platform/guards.js";

export type PlanArtifactMode = "CONVERSATION" | "REPOSITORY_FILE";
export type PlanValidationIssueCode = "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE";
export type PlanValidationIssue = { path: string; code: PlanValidationIssueCode; area: string; message: string };

/**
 * 计划里的一个执行步骤。`status` 是**计划态**（"这一步在计划里是否可开工"），不是运行时状态：
 * 每一步真正的进度来自 Run 的 journal（`TASK_PROGRESS` 条目），由执行侧推进。
 * 它曾是模型可填字段，但从来没有任何代码推进过它，界面却按"实时状态"显示恒定的 READY —— 所以
 * prompt 不再示范、界面不再当实时状态用；为了兼容库里已有的 CandidatePlan，校验器仍接受这个键。
 */
export type PlanTaskShape = { id: string; title: string; dependencies: string[]; status?: "PENDING" | "READY" | "DONE" };

export type GeneratedPlanSpecV2 = {
  schemaVersion: 2;
  title: string;
  artifact: { mode: PlanArtifactMode; path?: string | undefined };
  objective: { goal: string; audience: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
  design: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[] };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: PlanTaskShape[];
  /** Human-readable execution prerequisites; these are not CandidatePlan IDs. */
  dependencies: string[];
  conflicts: string[];
  /**
   * **只有 Factory 能决定的部分**。这里曾经还有 `executorModelRole` 与 `toolPolicy`，模型可以填、
   * 却没有任何消费方（执行侧读的是 Project 快照里的 executor 配置），于是它们在界面上显示成
   * "执行策略"而实际不生效。会撒谎的字段不如没有：这两个值现在由 Factory 固定填进
   * `ResolvedPlanContractV2.execution`，模型不再有机会声明它们。
   */
  execution: { maxRepairAttempts?: number | undefined };
  verification: {
    mode: "PROJECT_DEFAULT" | "NONE";
    /**
     * 可选：只要**项目声明过的验证 tag**（如 ["docs"]），Factory 解析成命中的命令 ID 子集。
     * 模型仍然不能指定命令 ID——它声明的是"哪一类验证"，映射由 Factory 做。
     * 与 mode: "NONE" 互斥（NONE 意味着不跑验证，再声明 suites 就是自相矛盾）。
     */
    suites?: string[] | undefined;
  };
  merge: { strategy: "manual" | "fast-forward" | "squash"; requireHumanMerge: true };
};

export type ResolvedPlanContractV2 = {
  schemaVersion: 2;
  artifact: GeneratedPlanSpecV2["artifact"];
  objective: GeneratedPlanSpecV2["objective"];
  design: GeneratedPlanSpecV2["design"];
  conflicts: string[];
  repository: { projectId: string; name: string; repoRoot: string; baseBranch: string; baseCommit: string; configVersion: number; configHash: string };
  scope: GeneratedPlanSpecV2["scope"];
  /** 冻结后的步骤清单；`status` 恒为计划态（见 PlanTaskShape 的说明）。 */
  tasks: Array<{ id: string; title: string; dependencies: string[]; status: "PENDING" | "READY" | "DONE" }>;
  /** Human-readable execution prerequisites; these are not CandidatePlan IDs. */
  dependencies: string[];
  execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number };
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] };
  merge: { strategy: "manual" | "fast-forward" | "squash"; requireHumanMerge: true };
};

export type GitBaseline = { baseBranch: string; baseCommit: string };

/**
 * 执行角色与工具策略由 Factory 固定，**不是模型可填的字段**（见 GeneratedPlanSpecV2.execution 的说明）。
 * 取这两个具体值是历史兼容：下游 `PlanContract` 投影、审计视图与既有 Run 的 journal 都在读它们。
 */
export const EXECUTOR_ROLE = "executor";
export const EXECUTOR_TOOL_POLICY = "executor-scoped-write";

export class GeneratedPlanSpecV2ValidationError extends Error {
  constructor(readonly issues: PlanValidationIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; ") || "Generated Plan V2 is invalid");
    this.name = "GeneratedPlanSpecV2ValidationError";
  }
}

function issue(issues: PlanValidationIssue[], path: string, code: PlanValidationIssueCode, area: string, message: string): void {
  issues.push({ path, code, area, message });
}

function objectAt(source: Record<string, unknown>, key: string, area: string, issues: PlanValidationIssue[]): Record<string, unknown> {
  const value = source[key];
  if (isRecord(value)) return value;
  issue(issues, key, "REQUIRED", area, "必须是对象。");
  return {};
}

function stringAt(source: Record<string, unknown>, key: string, path: string, area: string, issues: PlanValidationIssue[], required = true): string | undefined {
  const value = source[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, value === undefined ? "REQUIRED" : "INVALID", area, "必须是非空字符串。");
    return undefined;
  }
  return value.trim();
}

function stringsAt(source: Record<string, unknown>, key: string, path: string, area: string, issues: PlanValidationIssue[], nonEmpty = false): string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    issue(issues, path, value === undefined ? "REQUIRED" : "INVALID", area, "必须是字符串数组。");
    return [];
  }
  if (value.some((item) => typeof item !== "string" || !item.trim())) issue(issues, path, "INVALID", area, "数组项必须是非空字符串。");
  if (nonEmpty && value.length === 0) issue(issues, path, "REQUIRED", area, "至少需要一项。");
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
}

/** A scope entry is always a repository-relative path or glob. */
export function assertSafeProjectRelativeGlob(value: string, field = "scope path"): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error(`${field} must be a project-root-relative path or glob`);
  if (normalized.includes("\0") || /\b(do not|concept|anything|all files)\b/i.test(normalized)) throw new Error(`${field} must be a concrete project-root-relative path or glob`);
  return normalized;
}

function safePaths(paths: string[], path: string, area: string, issues: PlanValidationIssue[]): string[] {
  return paths.map((value) => {
    try { return assertSafeProjectRelativeGlob(value, path); }
    catch { issue(issues, path, "INVALID", area, "必须是项目根相对路径或 glob，不能使用绝对路径、.. 或概念性描述。"); return value; }
  });
}

/** Returns every structural violation so continuation can repair the full artifact at once. */
export function validateGeneratedPlanSpecV2(value: unknown): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是 JSON 对象。" }];
  const source = value;
  if (source.schemaVersion !== 2) issue(issues, "schemaVersion", "INVALID", "完整执行契约", "必须为 2。");
  stringAt(source, "title", "title", "方案标题", issues);

  const artifact = objectAt(source, "artifact", "产物模式", issues);
  const mode = artifact.mode;
  if (mode !== "CONVERSATION" && mode !== "REPOSITORY_FILE") issue(issues, "artifact.mode", mode === undefined ? "REQUIRED" : "INVALID", "产物模式", "必须为 CONVERSATION 或 REPOSITORY_FILE。");
  const artifactPath = stringAt(artifact, "path", "artifact.path", "产物模式", issues, mode === "REPOSITORY_FILE");
  if (mode === "CONVERSATION" && artifact.path !== undefined) issue(issues, "artifact.path", "MODE_CONFLICT", "产物模式", "CONVERSATION 模式不能设置仓库文件路径。");
  if (artifactPath) safePaths([artifactPath], "artifact.path", "产物模式", issues);

  const objective = objectAt(source, "objective", "目标与用户范围", issues);
  stringAt(objective, "goal", "objective.goal", "目标与用户范围", issues);
  stringsAt(objective, "audience", "objective.audience", "目标与用户范围", issues, true);
  stringsAt(objective, "acceptanceCriteria", "objective.acceptanceCriteria", "验收标准与验证命令", issues, true);
  stringsAt(objective, "outOfScope", "objective.outOfScope", "功能范围与排除项", issues);

  const design = objectAt(source, "design", "技术方案与关键约束", issues);
  stringsAt(design, "technicalConstraints", "design.technicalConstraints", "技术方案与关键约束", issues, true);
  stringsAt(design, "dataSecurity", "design.dataSecurity", "数据、安全与异常处理", issues, true);
  stringsAt(design, "failureHandling", "design.failureHandling", "数据、安全与异常处理", issues, true);

  const scope = objectAt(source, "scope", "功能范围与排除项", issues);
  const includePaths = safePaths(stringsAt(scope, "includePaths", "scope.includePaths", "功能范围与排除项", issues, mode === "REPOSITORY_FILE"), "scope.includePaths", "功能范围与排除项", issues);
  safePaths(stringsAt(scope, "excludePaths", "scope.excludePaths", "功能范围与排除项", issues), "scope.excludePaths", "功能范围与排除项", issues);
  if (mode === "CONVERSATION" && includePaths.length > 0) issue(issues, "scope.includePaths", "MODE_CONFLICT", "功能范围与排除项", "CONVERSATION 模式必须为空数组。");
  if (mode === "REPOSITORY_FILE" && artifactPath && !includePaths.includes(artifactPath.replaceAll("\\", "/"))) issue(issues, "scope.includePaths", "MODE_CONFLICT", "功能范围与排除项", "必须包含 artifact.path。");

  const rawTasks = source.tasks;
  const taskIds: string[] = [];
  const taskDependencies: Array<{ id: string; dependencies: string[] }> = [];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) issue(issues, "tasks", rawTasks === undefined ? "REQUIRED" : "INVALID", "实施任务、依赖与冲突", "必须是至少包含一个任务的数组。");
  else rawTasks.forEach((rawTask, index) => {
    const path = `tasks[${index}]`;
    if (!isRecord(rawTask)) { issue(issues, path, "INVALID", "实施任务、依赖与冲突", "必须是对象。"); return; }
    const id = stringAt(rawTask, "id", `${path}.id`, "实施任务、依赖与冲突", issues);
    stringAt(rawTask, "title", `${path}.title`, "实施任务、依赖与冲突", issues);
    const dependencies = stringsAt(rawTask, "dependencies", `${path}.dependencies`, "实施任务、依赖与冲突", issues);
    if (rawTask.status !== undefined && rawTask.status !== "PENDING" && rawTask.status !== "READY" && rawTask.status !== "DONE") issue(issues, `${path}.status`, "INVALID", "实施任务、依赖与冲突", "只能为 PENDING、READY 或 DONE。");
    if (id) { taskIds.push(id); taskDependencies.push({ id, dependencies }); }
  });
  if (new Set(taskIds).size !== taskIds.length) issue(issues, "tasks", "DUPLICATE", "实施任务、依赖与冲突", "任务 id 必须唯一。");
  const knownTaskIds = new Set(taskIds);
  for (const task of taskDependencies) for (const dependency of task.dependencies) if (!knownTaskIds.has(dependency)) issue(issues, `tasks.${task.id}.dependencies`, "INVALID", "实施任务、依赖与冲突", `引用了不存在的任务 ${dependency}。`);
  stringsAt(source, "dependencies", "dependencies", "实施任务、依赖与冲突", issues);
  stringsAt(source, "conflicts", "conflicts", "实施任务、依赖与冲突", issues);

  const execution = objectAt(source, "execution", "实施任务、依赖与冲突", issues);
  // `execution.executorModelRole` / `execution.toolPolicy` 不再被读取，但**故意不报 FORBIDDEN**：
  // 库里已有的 CandidatePlan 带着这两个键，报错会让它们连 confirm 都过不去。忽略是这里的正确语义。
  if (execution.maxRepairAttempts !== undefined && (!Number.isInteger(execution.maxRepairAttempts) || Number(execution.maxRepairAttempts) < 0)) issue(issues, "execution.maxRepairAttempts", "INVALID", "实施任务、依赖与冲突", "如填写，必须是非负整数。");

  const verification = objectAt(source, "verification", "验收标准与验证命令", issues);
  if (verification.mode !== "PROJECT_DEFAULT" && verification.mode !== "NONE") issue(issues, "verification.mode", verification.mode === undefined ? "REQUIRED" : "INVALID", "验收标准与验证命令", "必须为 PROJECT_DEFAULT 或 NONE。");
  const suites = verification.suites === undefined ? [] : stringsAt(verification, "suites", "verification.suites", "验收标准与验证命令", issues);
  if (verification.suites !== undefined && suites.length === 0) issue(issues, "verification.suites", "INVALID", "验收标准与验证命令", "如填写，必须是至少一项的字符串数组；不要用空数组表达“全部”。");
  if (verification.suites !== undefined && verification.mode === "NONE") issue(issues, "verification.suites", "MODE_CONFLICT", "验收标准与验证命令", "verification.mode 为 NONE 时不能声明 suites。");
  if (mode === "CONVERSATION" && verification.mode !== "NONE") issue(issues, "verification.mode", "MODE_CONFLICT", "验收标准与验证命令", "CONVERSATION 模式必须为 NONE。");

  const merge = objectAt(source, "merge", "合并策略与人工确认", issues);
  if (merge.strategy !== "manual" && merge.strategy !== "fast-forward" && merge.strategy !== "squash") issue(issues, "merge.strategy", merge.strategy === undefined ? "REQUIRED" : "INVALID", "合并策略与人工确认", "必须为 manual、fast-forward 或 squash。");
  if (merge.requireHumanMerge !== true) issue(issues, "merge.requireHumanMerge", merge.requireHumanMerge === undefined ? "REQUIRED" : "INVALID", "合并策略与人工确认", "必须为 true。");

  for (const field of ["repository", "baseBranch", "baseCommit", "configVersion", "configHash", "verificationCommandIds"]) if (field in source) issue(issues, field, "FORBIDDEN", "Factory 自动补全", "只能由 Factory 基于当前 Project 与 Git 基线补全。");
  if ("commandIds" in verification) issue(issues, "verification.commandIds", "FORBIDDEN", "Factory 自动补全", "只能由 Factory 补全。");
  return issues;
}

export function parseGeneratedPlanSpecV2(value: unknown): GeneratedPlanSpecV2 {
  const issues = validateGeneratedPlanSpecV2(value);
  if (issues.length) throw new GeneratedPlanSpecV2ValidationError(issues);
  const source = value as Record<string, unknown>;
  const artifact = source.artifact as Record<string, unknown>;
  const objective = source.objective as Record<string, unknown>;
  const design = source.design as Record<string, unknown>;
  const scope = source.scope as Record<string, unknown>;
  const execution = source.execution as Record<string, unknown>;
  const verification = source.verification as Record<string, unknown>;
  const merge = source.merge as Record<string, unknown>;
  const normalize = (values: unknown) => (values as string[]).map((item) => item.trim());
  return {
    schemaVersion: 2,
    title: String(source.title).trim(),
    artifact: { mode: artifact.mode as PlanArtifactMode, ...(typeof artifact.path === "string" ? { path: assertSafeProjectRelativeGlob(artifact.path, "artifact.path") } : {}) },
    objective: { goal: String(objective.goal).trim(), audience: normalize(objective.audience), acceptanceCriteria: normalize(objective.acceptanceCriteria), outOfScope: normalize(objective.outOfScope) },
    design: { technicalConstraints: normalize(design.technicalConstraints), dataSecurity: normalize(design.dataSecurity), failureHandling: normalize(design.failureHandling) },
    scope: { includePaths: normalize(scope.includePaths).map((path) => assertSafeProjectRelativeGlob(path, "scope.includePaths")), excludePaths: normalize(scope.excludePaths).map((path) => assertSafeProjectRelativeGlob(path, "scope.excludePaths")) },
    tasks: (source.tasks as Array<Record<string, unknown>>).map((task) => ({ id: String(task.id).trim(), title: String(task.title).trim(), dependencies: normalize(task.dependencies), status: (task.status as "PENDING" | "READY" | "DONE" | undefined) ?? "READY" })),
    dependencies: normalize(source.dependencies),
    conflicts: normalize(source.conflicts),
    execution: { maxRepairAttempts: typeof execution.maxRepairAttempts === "number" ? execution.maxRepairAttempts : undefined },
    verification: { mode: verification.mode as "PROJECT_DEFAULT" | "NONE", ...(verification.suites === undefined ? {} : { suites: normalize(verification.suites) }) },
    merge: { strategy: merge.strategy as GeneratedPlanSpecV2["merge"]["strategy"], requireHumanMerge: true },
  };
}

/**
 * 把 Plan 声明的 suites（**tag 词表**）解析成命令 ID 子集。
 *
 * 三条规则都是"宁可失败也不静默改变语义"：
 *   1) 没声明 suites → 项目默认全集（与引入 suites 之前逐字相同）。
 *   2) 声明了项目未登记过的 tag → 抛错并列出**已登记的 tag**，让模型/用户按词表改。
 *   3) 声明了合法 tag 但一条默认命令都没命中 → 抛错，而不是退化成一个空的验证集
 *      （那会被记成"验证通过"式的假象）。
 */
function selectVerificationCommands(defaults: string[], enabledVerification: Map<string, RegisteredCommandDefinition>, suites: string[]): string[] {
  if (suites.length === 0) return [...defaults];
  const knownTags = new Set([...enabledVerification.values()].flatMap((command) => command.tags ?? []));
  const unknown = suites.filter((suite) => !knownTags.has(suite));
  if (unknown.length > 0) {
    const declared = [...knownTags].sort().join(", ");
    throw new Error(`Plan verification suites are not declared by this Project: ${unknown.join(", ")}. Declared tags: ${declared || "(none)"}`);
  }
  const selected = defaults.filter((commandId) => {
    const tags = enabledVerification.get(commandId)?.tags ?? [];
    return suites.some((suite) => tags.includes(suite));
  });
  if (selected.length === 0) throw new Error(`Plan verification suites ${suites.join(", ")} match none of the Project default verification commands (${defaults.join(", ")})`);
  return selected;
}

export function resolvePlanContractV2(specValue: unknown, project: ProjectExecutionSnapshot, baseline: GitBaseline): ResolvedPlanContractV2 {
  const spec = parseGeneratedPlanSpecV2(specValue);
  if (!baseline.baseBranch.trim() || !baseline.baseCommit.trim() || /^(HEAD|unknown|unverified)$/i.test(baseline.baseCommit.trim())) throw new Error("Factory must resolve a verified Git baseline before creating a V2 plan");
  const defaults = project.settings.defaultVerificationCommandIds ?? [];
  const enabledVerification = new Map(project.settings.commands.filter((command) => command.category === "verification" && command.enabled !== false).map((command) => [command.commandId, command]));
  if (defaults.some((id) => !enabledVerification.has(id))) throw new Error("Project default verification commands are invalid");
  const mode = spec.verification.mode === "NONE" || defaults.length === 0 ? "NONE" : "PROJECT_DEFAULT";
  // 解析后的 commandIds 才是执行事实；请求过的 suites 留在 generatedSpec 里可审计。
  const commandIds = mode === "PROJECT_DEFAULT" ? selectVerificationCommands(defaults, enabledVerification, spec.verification.suites ?? []) : [];
  const technicalConstraints = [...new Set([...spec.design.technicalConstraints, ...spec.dependencies])];
  return { schemaVersion: 2, artifact: spec.artifact, objective: spec.objective, design: { ...spec.design, technicalConstraints }, conflicts: spec.conflicts, repository: { projectId: project.projectId, name: project.name, repoRoot: project.repoRoot, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, configVersion: project.configVersion, configHash: project.configHash }, scope: spec.scope, tasks: spec.tasks.map((task) => ({ ...task, status: task.status ?? "READY" })), dependencies: spec.dependencies, execution: { executorModelRole: EXECUTOR_ROLE, toolPolicy: EXECUTOR_TOOL_POLICY, maxRepairAttempts: Number.isInteger(spec.execution.maxRepairAttempts) && spec.execution.maxRepairAttempts! >= 0 ? spec.execution.maxRepairAttempts! : project.settings.concurrency.maxRepairAttempts }, verification: { mode, commandIds }, merge: { strategy: spec.merge.strategy, requireHumanMerge: true } };
}
