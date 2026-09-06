/**
 * Plan V2 deliberately separates untrusted model output from the contract that
 * Factory persists and executes. In particular the model never supplies a
 * command id, repository identity, branch, commit or Project configuration.
 */
import type { ProjectExecutionSnapshot } from "./project.js";

export type PlanArtifactMode = "CONVERSATION" | "REPOSITORY_FILE";
export type PlanValidationIssueCode = "REQUIRED" | "INVALID" | "FORBIDDEN" | "MODE_CONFLICT" | "DUPLICATE";
export type PlanValidationIssue = { path: string; code: PlanValidationIssueCode; area: string; message: string };

export type GeneratedPlanSpecV2 = {
  schemaVersion: 2;
  title: string;
  artifact: { mode: PlanArtifactMode; path?: string | undefined };
  objective: { goal: string; audience: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
  design: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[] };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: Array<{ id: string; title: string; dependencies: string[]; status?: "PENDING" | "READY" | "DONE" }>;
  dependencies: string[];
  conflicts: string[];
  execution: { executorModelRole?: string | undefined; toolPolicy?: string | undefined; maxRepairAttempts?: number | undefined };
  verification: { mode: "PROJECT_DEFAULT" | "NONE" };
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
  tasks: Array<{ id: string; title: string; dependencies: string[]; status: "PENDING" | "READY" | "DONE" }>;
  dependencies: string[];
  execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number };
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] };
  merge: { strategy: "manual" | "fast-forward" | "squash"; requireHumanMerge: true };
};

export type GitBaseline = { baseBranch: string; baseCommit: string };

export class GeneratedPlanSpecV2ValidationError extends Error {
  constructor(readonly issues: PlanValidationIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; ") || "Generated Plan V2 is invalid");
    this.name = "GeneratedPlanSpecV2ValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function optionalExecutionString(source: Record<string, unknown>, key: "executorModelRole" | "toolPolicy", issues: PlanValidationIssue[]): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) { issue(issues, `execution.${key}`, "INVALID", "实施任务、依赖与冲突", "如填写，必须是非空字符串。"); return undefined; }
  return value.trim();
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
  optionalExecutionString(execution, "executorModelRole", issues);
  optionalExecutionString(execution, "toolPolicy", issues);
  if (execution.maxRepairAttempts !== undefined && (!Number.isInteger(execution.maxRepairAttempts) || Number(execution.maxRepairAttempts) < 0)) issue(issues, "execution.maxRepairAttempts", "INVALID", "实施任务、依赖与冲突", "如填写，必须是非负整数。");

  const verification = objectAt(source, "verification", "验收标准与验证命令", issues);
  if (verification.mode !== "PROJECT_DEFAULT" && verification.mode !== "NONE") issue(issues, "verification.mode", verification.mode === undefined ? "REQUIRED" : "INVALID", "验收标准与验证命令", "必须为 PROJECT_DEFAULT 或 NONE。");
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
    execution: { executorModelRole: typeof execution.executorModelRole === "string" ? execution.executorModelRole.trim() : undefined, toolPolicy: typeof execution.toolPolicy === "string" ? execution.toolPolicy.trim() : undefined, maxRepairAttempts: typeof execution.maxRepairAttempts === "number" ? execution.maxRepairAttempts : undefined },
    verification: { mode: verification.mode as "PROJECT_DEFAULT" | "NONE" },
    merge: { strategy: merge.strategy as GeneratedPlanSpecV2["merge"]["strategy"], requireHumanMerge: true },
  };
}

export function resolvePlanContractV2(specValue: unknown, project: ProjectExecutionSnapshot, baseline: GitBaseline): ResolvedPlanContractV2 {
  const spec = parseGeneratedPlanSpecV2(specValue);
  if (!baseline.baseBranch.trim() || !baseline.baseCommit.trim() || /^(HEAD|unknown|unverified)$/i.test(baseline.baseCommit.trim())) throw new Error("Factory must resolve a verified Git baseline before creating a V2 plan");
  const defaults = project.settings.defaultVerificationCommandIds ?? [];
  const enabledVerification = new Map(project.settings.commands.filter((command) => command.category === "verification" && command.enabled !== false).map((command) => [command.commandId, command]));
  if (defaults.some((id) => !enabledVerification.has(id))) throw new Error("Project default verification commands are invalid");
  const mode = spec.verification.mode === "NONE" || defaults.length === 0 ? "NONE" : "PROJECT_DEFAULT";
  return { schemaVersion: 2, artifact: spec.artifact, objective: spec.objective, design: spec.design, conflicts: spec.conflicts, repository: { projectId: project.projectId, name: project.name, repoRoot: project.repoRoot, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, configVersion: project.configVersion, configHash: project.configHash }, scope: spec.scope, tasks: spec.tasks.map((task) => ({ ...task, status: task.status ?? "READY" })), dependencies: spec.dependencies, execution: { executorModelRole: spec.execution.executorModelRole?.trim() || "executor", toolPolicy: spec.execution.toolPolicy?.trim() || "executor-scoped-write", maxRepairAttempts: Number.isInteger(spec.execution.maxRepairAttempts) && spec.execution.maxRepairAttempts! >= 0 ? spec.execution.maxRepairAttempts! : project.settings.concurrency.maxRepairAttempts }, verification: { mode, commandIds: mode === "PROJECT_DEFAULT" ? [...defaults] : [] }, merge: { strategy: spec.merge.strategy, requireHumanMerge: true } };
}
