/**
 * Plan V2 deliberately separates untrusted model output from the contract that
 * Factory persists and executes.  In particular the model never supplies a
 * command id, repository identity, branch, commit or Project configuration.
 */
import type { ProjectExecutionSnapshot } from "./project.js";

export type GeneratedPlanSpecV2 = {
  schemaVersion: 2;
  title: string;
  objective: { goal: string; acceptanceCriteria: string[]; outOfScope: string[] };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: Array<{ id: string; title: string; dependencies: string[]; status?: "PENDING" | "READY" | "DONE" }>;
  dependencies?: string[];
  execution: { executorModelRole?: string | undefined; toolPolicy?: string | undefined; maxRepairAttempts?: number | undefined };
  verification: { mode: "PROJECT_DEFAULT" | "NONE" };
  merge: { strategy?: "manual" | "fast-forward" | "squash" | undefined; requireHumanMerge?: boolean | undefined };
};

export type ResolvedPlanContractV2 = {
  schemaVersion: 2;
  objective: GeneratedPlanSpecV2["objective"];
  repository: { projectId: string; name: string; repoRoot: string; baseBranch: string; baseCommit: string; configVersion: number; configHash: string };
  scope: GeneratedPlanSpecV2["scope"];
  tasks: Array<{ id: string; title: string; dependencies: string[]; status: "PENDING" | "READY" | "DONE" }>;
  dependencies: string[];
  execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number };
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] };
  merge: { strategy: "manual" | "fast-forward" | "squash"; requireHumanMerge: true };
};

export type GitBaseline = { baseBranch: string; baseCommit: string };

function strings(value: unknown, field: string, nonEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || (nonEmpty && value.length === 0)) throw new Error(`${field} must be ${nonEmpty ? "a non-empty" : "an"} array of non-empty strings`);
  return value.map((item) => item.trim());
}

/** A scope entry is always a repository-relative path or glob. */
export function assertSafeProjectRelativeGlob(value: string, field = "scope path"): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error(`${field} must be a project-root-relative path or glob`);
  if (normalized.includes("\0") || /\b(do not|concept|anything|all files)\b/i.test(normalized)) throw new Error(`${field} must be a concrete project-root-relative path or glob`);
  return normalized;
}

export function parseGeneratedPlanSpecV2(value: unknown): GeneratedPlanSpecV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Generated Plan V2 must be an object");
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 2) throw new Error("Generated Plan must use schemaVersion 2");
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const objective = source.objective as Record<string, unknown> | undefined;
  const scope = source.scope as Record<string, unknown> | undefined;
  const execution = source.execution as Record<string, unknown> | undefined;
  const verification = source.verification as Record<string, unknown> | undefined;
  const merge = source.merge as Record<string, unknown> | undefined;
  if (!title || !objective || typeof objective.goal !== "string" || !objective.goal.trim() || !scope || !execution || !verification || !merge) throw new Error("Generated Plan V2 is incomplete");
  if ("commandIds" in verification || "verificationCommandIds" in source || "baseCommit" in source || "baseBranch" in source || "repository" in source) throw new Error("Generated Plan V2 may not set Factory-derived repository or command fields");
  const tasks = Array.isArray(source.tasks) ? source.tasks.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Plan task is invalid");
    const task = item as Record<string, unknown>;
    if (typeof task.id !== "string" || !task.id.trim() || typeof task.title !== "string" || !task.title.trim()) throw new Error("Plan task id and title are required");
    const status: "PENDING" | "READY" | "DONE" = task.status === "PENDING" || task.status === "DONE" || task.status === "READY" ? task.status : "READY";
    return { id: task.id.trim(), title: task.title.trim(), dependencies: strings(task.dependencies, `task ${task.id}.dependencies`), status };
  }) : (() => { throw new Error("Plan tasks are required"); })();
  if (!tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Plan task ids must be unique");
  const known = new Set(tasks.map((task) => task.id));
  if (tasks.some((task) => task.dependencies.some((id) => !known.has(id)))) throw new Error("Plan task depends on unknown task");
  const includePaths = strings(scope.includePaths, "scope.includePaths", true).map((path) => assertSafeProjectRelativeGlob(path, "scope.includePaths"));
  const excludePaths = strings(scope.excludePaths, "scope.excludePaths").map((path) => assertSafeProjectRelativeGlob(path, "scope.excludePaths"));
  const acceptanceCriteria = strings(objective.acceptanceCriteria, "objective.acceptanceCriteria", true);
  const outOfScope = strings(objective.outOfScope, "objective.outOfScope");
  if (verification.mode !== "PROJECT_DEFAULT" && verification.mode !== "NONE") throw new Error("verification.mode is invalid");
  if (merge.strategy !== undefined && !["manual", "fast-forward", "squash"].includes(String(merge.strategy))) throw new Error("merge.strategy is invalid");
  return { schemaVersion: 2, title, objective: { goal: objective.goal.trim(), acceptanceCriteria, outOfScope }, scope: { includePaths, excludePaths }, tasks, dependencies: strings(source.dependencies ?? [], "dependencies"), execution: { executorModelRole: typeof execution.executorModelRole === "string" ? execution.executorModelRole : undefined, toolPolicy: typeof execution.toolPolicy === "string" ? execution.toolPolicy : undefined, maxRepairAttempts: typeof execution.maxRepairAttempts === "number" ? execution.maxRepairAttempts : undefined }, verification: { mode: verification.mode }, merge: { strategy: merge.strategy as GeneratedPlanSpecV2["merge"]["strategy"], requireHumanMerge: merge.requireHumanMerge === true } };
}

export function resolvePlanContractV2(specValue: unknown, project: ProjectExecutionSnapshot, baseline: GitBaseline): ResolvedPlanContractV2 {
  const spec = parseGeneratedPlanSpecV2(specValue);
  if (!baseline.baseBranch.trim() || !baseline.baseCommit.trim() || /^(HEAD|unknown|unverified)$/i.test(baseline.baseCommit.trim())) throw new Error("Factory must resolve a verified Git baseline before creating a V2 plan");
  const defaults = project.settings.defaultVerificationCommandIds ?? [];
  const enabledVerification = new Map(project.settings.commands.filter((command) => command.category === "verification" && command.enabled !== false).map((command) => [command.commandId, command]));
  if (defaults.some((id) => !enabledVerification.has(id))) throw new Error("Project default verification commands are invalid");
  const mode = spec.verification.mode === "NONE" || defaults.length === 0 ? "NONE" : "PROJECT_DEFAULT";
  return { schemaVersion: 2, objective: spec.objective, repository: { projectId: project.projectId, name: project.name, repoRoot: project.repoRoot, baseBranch: baseline.baseBranch, baseCommit: baseline.baseCommit, configVersion: project.configVersion, configHash: project.configHash }, scope: spec.scope, tasks: spec.tasks.map((task) => ({ ...task, status: task.status ?? "READY" })), dependencies: spec.dependencies ?? [], execution: { executorModelRole: spec.execution.executorModelRole?.trim() || "executor", toolPolicy: spec.execution.toolPolicy?.trim() || "executor-scoped-write", maxRepairAttempts: Number.isInteger(spec.execution.maxRepairAttempts) && spec.execution.maxRepairAttempts! >= 0 ? spec.execution.maxRepairAttempts! : project.settings.concurrency.maxRepairAttempts }, verification: { mode, commandIds: mode === "PROJECT_DEFAULT" ? [...defaults] : [] }, merge: { strategy: spec.merge.strategy ?? "manual", requireHumanMerge: true } };
}
