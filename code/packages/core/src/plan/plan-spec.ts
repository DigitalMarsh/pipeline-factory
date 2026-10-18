/**
 * The plan spec deliberately separates untrusted model output from the contract that
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
 * 一步实施要动的**具体文件**。
 * 这是"任务标题"与"真正动手"之间的那层：只有标题时，Executor 得对着标题重新探索一遍
 * （反复读文件、偶尔跑偏）；写清动哪个文件、怎么动，它才有靶子。
 */
export type PlanTaskChange = {
  /** 项目根相对路径；与 `scope.includePaths` 同一套路径安全规则。 */
  path: string;
  action: "create" | "modify" | "delete";
  /** 这一步在这个文件上做什么。 */
  detail: string;
};

/**
 * 计划里的一个执行步骤（**模型产出的形状**）。
 *
 * `status` 曾经在这里。它从来没有任何代码推进过它，`resolvePlanContract` 只是把它原样抄进冻结契约，
 * 界面却把它当"实时状态"显示——而每一步真正的进度来自 Run 的 journal（`TASK_PROGRESS` 条目），由
 * 执行侧推进。会撒谎的字段不如没有：**模型侧已经没有它了**（写了也不读，见校验器的说明），
 * 冻结契约里那个 `status: "READY"` 是 Factory 填的常量，只为既有读法保留。
 */
export type PlanTaskShape = {
  id: string;
  title: string;
  dependencies: string[];
  /**
   * **这一步做完了，哪几条验收算数**——`objective.acceptanceCriteria` 的序号（从 1 开始）。
   *
   * 这一条边此前是缺的：验收标准是计划级的一串话，`changes` 说"动哪些文件"，却没有"这一步对哪条
   * 验收负责"。后果在执行侧是具体的：一个多步计划里第 3 步做歪了，要等到计划级的验证一并发现，
   * 然后靠 `maxRepairAttempts` 重新修。有它之后，"哪条验收没人认领"还能被门禁当场拦下。
   */
  acceptanceRefs?: number[] | undefined;
  /** 要动哪些文件、怎么动（见 `PlanTaskChange`）。 */
  changes?: PlanTaskChange[] | undefined;
};

export type GeneratedPlanSpec = {
  schemaVersion: 2;
  title: string;
  artifact: { mode: PlanArtifactMode; path?: string | undefined };
  objective: {
    goal: string;
    /**
     * 现状与调查发现：Explorer 在仓库里**看到了什么、依据是什么**。
     * 此前这些只能塞进 goal 的散文里，于是"为什么这么改"在计划里没有位置。
     */
    context?: string[] | undefined;
    audience: string[];
    acceptanceCriteria: string[];
    outOfScope: string[];
  };
  design: { technicalConstraints: string[]; dataSecurity: string[]; failureHandling: string[]; risks?: string[] | undefined };
  scope: { includePaths: string[]; excludePaths: string[] };
  tasks: PlanTaskShape[];
  /** Human-readable execution prerequisites; these are not CandidatePlan IDs. */
  dependencies: string[];
  conflicts: string[];
  /**
   * **只有 Factory 能决定的部分**。这里曾经还有 `executorModelRole` 与 `toolPolicy`，模型可以填、
   * 却没有任何消费方（执行侧读的是 Project 快照里的 executor 配置），于是它们在界面上显示成
   * "执行策略"而实际不生效。会撒谎的字段不如没有：这两个值现在由 Factory 固定填进
   * `ResolvedPlanContract.execution`，模型不再有机会声明它们。
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
  /**
   * 这里曾经有 `merge: { strategy, requireHumanMerge }`。**真正的合并不经过 Factory**——人在 Git 侧
   * 合并完再调 `confirmMerged`（见 `run/merge.ts` 的开头），所以那个 `strategy` 从来没有任何消费方：
   * 27 份真实计划里它 27/27 都是 `manual`、`requireHumanMerge` 27/27 都是 `true`。界面上却写着
   * "策略：manual，需人工审阅"，让人以为 Factory 会照着策略合并。与 `execution.executorModelRole`
   * 是同一个病，用同一个处方：**从模型侧删掉，由 Factory 填常量**（`MERGE_STRATEGY` /
   * `REQUIRE_HUMAN_MERGE`），落盘文档与界面照常显示。
   */
};

export type ResolvedPlanContract = {
  schemaVersion: 2;
  artifact: GeneratedPlanSpec["artifact"];
  objective: GeneratedPlanSpec["objective"];
  design: GeneratedPlanSpec["design"];
  conflicts: string[];
  repository: {
    projectId: string;
    name: string;
    repoRoot: string;
    baseBranch: string;
    baseCommit: string;
    configVersion: number;
    configHash: string;
  };
  scope: GeneratedPlanSpec["scope"];
  /**
   * 冻结后的步骤清单。`status` 恒为 `"READY"`——**Factory 填的常量**，模型侧已经没有这个字段
   * （类型收窄成一个字面量，就是为了让"拿它判断进度"这种写法当场通不过编译）。
   * 库里 2026-10 之前冻结的契约里可能还留着模型当年写的 `PENDING`/`DONE`，读的时候一律不当作数。
   */
  tasks: Array<{
    id: string;
    title: string;
    dependencies: string[];
    status: "READY";
    /** 认领的验收标准序号（从 1 开始），见 `PlanTaskShape.acceptanceRefs`。 */
    acceptanceRefs?: number[] | undefined;
    changes?: PlanTaskChange[] | undefined;
  }>;
  /** Human-readable execution prerequisites; these are not CandidatePlan IDs. */
  dependencies: string[];
  /**
   * 本 Plan 的**前置 CandidatePlan id**（调度用，要求前置达到 MERGED）。**Factory-owned 字段**：
   * 模型不产它（它只写得出 `dependencies` 那串自然语言），解析时恒为 `[]`，只有
   * `PlanService.setDependencies` 能写。不要把它与 `dependencies` 混起来——两者曾经共用 V1 镜像的
   * 一个字段，结果是"把自然语言先决条件当成 Plan id"。
   */
  dependsOnPlanIds: string[];
  execution: { executorModelRole: string; toolPolicy: string; maxRepairAttempts: number };
  verification: { mode: "PROJECT_DEFAULT" | "NONE"; commandIds: string[] };
  /**
   * Factory 填的常量（见 `GeneratedPlanSpec` 末尾的说明）。类型收窄成字面量，是为了让"按它决定
   * 怎么合并"这种写法当场通不过编译——Factory 从不合并，合并由人在 Git 侧做完再调 `confirmMerged`。
   * 库里 2026-10 之前冻结的契约可能还留着模型当年写的别的策略，读的时候一律不当作数。
   */
  merge: { strategy: "manual"; requireHumanMerge: true };
};

export type GitBaseline = { baseBranch: string; baseCommit: string };

/**
 * 执行角色与工具策略由 Factory 固定，**不是模型可填的字段**（见 GeneratedPlanSpec.execution 的说明）。
 * 取这两个具体值是历史兼容：审计视图与既有 Run 的 journal 都在读它们。
 */
export const EXECUTOR_ROLE = "executor";
export const EXECUTOR_TOOL_POLICY = "executor-scoped-write";

/** 合并策略与"必须人工确认"由 Factory 固定，**不是模型可填的字段**（见 GeneratedPlanSpec 末尾的说明）。 */
export const MERGE_STRATEGY = "manual";
export const REQUIRE_HUMAN_MERGE = true;

export class GeneratedPlanSpecValidationError extends Error {
  constructor(readonly issues: PlanValidationIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; ") || "Generated plan spec is invalid");
    this.name = "GeneratedPlanSpecValidationError";
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

function stringAt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  area: string,
  issues: PlanValidationIssue[],
  required = true,
): string | undefined {
  const value = source[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    issue(issues, path, value === undefined ? "REQUIRED" : "INVALID", area, "必须是非空字符串。");
    return undefined;
  }
  return value.trim();
}

function stringsAt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  area: string,
  issues: PlanValidationIssue[],
  nonEmpty = false,
): string[] {
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
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.split("/").includes(".."))
    throw new Error(`${field} must be a project-root-relative path or glob`);
  if (normalized.includes("\0") || /\b(do not|concept|anything|all files)\b/i.test(normalized))
    throw new Error(`${field} must be a concrete project-root-relative path or glob`);
  return normalized;
}

function safePaths(paths: string[], path: string, area: string, issues: PlanValidationIssue[]): string[] {
  return paths.map((value) => {
    try {
      return assertSafeProjectRelativeGlob(value, path);
    } catch {
      issue(issues, path, "INVALID", area, "必须是项目根相对路径或 glob，不能使用绝对路径、.. 或概念性描述。");
      return value;
    }
  });
}

/**
 * 可选字符串数组：**不存在就跳过**（历史 spec 没有这些键），存在时必须是至少一项的字符串数组。
 * 空数组一律拒绝——它是自相矛盾的声明（"有风险"却一条不写），与 `verification.suites` 同一条约定。
 */
function optionalStringsAt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  area: string,
  issues: PlanValidationIssue[],
): string[] | undefined {
  if (source[key] === undefined) return undefined;
  const value = stringsAt(source, key, path, area, issues);
  if (value.length === 0) issue(issues, path, "INVALID", area, "如填写，必须是至少一项的字符串数组。");
  return value;
}

/** 一步实施要动的文件清单；同样可选，出现时逐项校验形状。 */
function optionalTaskChanges(rawTask: Record<string, unknown>, path: string, issues: PlanValidationIssue[]): PlanTaskChange[] | undefined {
  const value = rawTask.changes;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    issue(
      issues,
      `${path}.changes`,
      "INVALID",
      "实施任务、依赖与冲突",
      "如填写，必须是至少一项的数组，每项形如 { path, action, detail }。",
    );
    return undefined;
  }
  const changes: PlanTaskChange[] = [];
  value.forEach((rawChange, index) => {
    const changePath = `${path}.changes[${index}]`;
    if (!isRecord(rawChange)) {
      issue(issues, changePath, "INVALID", "实施任务、依赖与冲突", "必须是对象。");
      return;
    }
    const filePath = stringAt(rawChange, "path", `${changePath}.path`, "实施任务、依赖与冲突", issues);
    const detail = stringAt(rawChange, "detail", `${changePath}.detail`, "实施任务、依赖与冲突", issues);
    const action = rawChange.action;
    const validAction = action === "create" || action === "modify" || action === "delete";
    if (!validAction)
      issue(
        issues,
        `${changePath}.action`,
        action === undefined ? "REQUIRED" : "INVALID",
        "实施任务、依赖与冲突",
        "必须为 create、modify 或 delete。",
      );
    if (filePath) safePaths([filePath], `${changePath}.path`, "实施任务、依赖与冲突", issues);
    if (!filePath || !detail || !validAction) return;
    changes.push({ path: filePath, action, detail });
  });
  return changes;
}

/**
 * 这一步认领哪几条验收标准（`objective.acceptanceCriteria` 的**序号，从 1 开始**）。
 *
 * 为什么用序号而不是让验收项自带 id：验收标准本来就是给人看的一串话，加一层 id 会让模型在
 * "编号 - 文本"两处之间维护映射。序号只有一个来源（数组顺序），校验器能把越界当场挡住，
 * 门禁还能反过来查出"哪条验收没人认领"。
 *
 * 空数组一律拒绝：与 `changes` / `risks` / `suites` 同一条约定——"这部分不用验收"是个决定，
 * 而不是可以留白。
 */
function optionalTaskAcceptanceRefs(
  rawTask: Record<string, unknown>,
  path: string,
  issues: PlanValidationIssue[],
  acceptanceCount: number,
): number[] | undefined {
  const value = rawTask.acceptanceRefs;
  if (value === undefined) return undefined;
  const problem = (code: PlanValidationIssueCode, message: string) =>
    issue(issues, `${path}.acceptanceRefs`, code, "实施任务、依赖与冲突", message);
  if (!Array.isArray(value) || value.length === 0) {
    problem("INVALID", "如填写，必须是至少一项的数组，元素是 objective.acceptanceCriteria 的序号（从 1 开始）。");
    return undefined;
  }
  const refs: number[] = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || (acceptanceCount > 0 && raw > acceptanceCount)) {
      problem("INVALID", `每个元素必须是 1 到 ${acceptanceCount || "验收条数"} 之间的整数序号；收到了 ${JSON.stringify(raw)}。`);
      return undefined;
    }
    refs.push(raw);
  }
  return [...new Set(refs)];
}

/** Returns every structural violation so continuation can repair the full artifact at once. */
export function validateGeneratedPlanSpec(value: unknown): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: "$", code: "INVALID", area: "完整执行契约", message: "必须是 JSON 对象。" }];
  const source = value;
  if (source.schemaVersion !== 2) issue(issues, "schemaVersion", "INVALID", "完整执行契约", "必须为 2。");
  stringAt(source, "title", "title", "方案标题", issues);

  const artifact = objectAt(source, "artifact", "产物模式", issues);
  const mode = artifact.mode;
  if (mode !== "CONVERSATION" && mode !== "REPOSITORY_FILE")
    issue(issues, "artifact.mode", mode === undefined ? "REQUIRED" : "INVALID", "产物模式", "必须为 CONVERSATION 或 REPOSITORY_FILE。");
  const artifactPath = stringAt(artifact, "path", "artifact.path", "产物模式", issues, mode === "REPOSITORY_FILE");
  if (mode === "CONVERSATION" && artifact.path !== undefined)
    issue(issues, "artifact.path", "MODE_CONFLICT", "产物模式", "CONVERSATION 模式不能设置仓库文件路径。");
  if (artifactPath) safePaths([artifactPath], "artifact.path", "产物模式", issues);

  const objective = objectAt(source, "objective", "目标与用户范围", issues);
  stringAt(objective, "goal", "objective.goal", "目标与用户范围", issues);
  // 可选：历史 spec 没有这两个键（见文件头关于"不报 FORBIDDEN"的说明），存在时才校验。
  optionalStringsAt(objective, "context", "objective.context", "目标与用户范围", issues);
  stringsAt(objective, "audience", "objective.audience", "目标与用户范围", issues, true);
  const acceptanceCriteria = stringsAt(objective, "acceptanceCriteria", "objective.acceptanceCriteria", "验收标准与验证命令", issues, true);
  stringsAt(objective, "outOfScope", "objective.outOfScope", "功能范围与排除项", issues);

  const design = objectAt(source, "design", "技术方案与关键约束", issues);
  stringsAt(design, "technicalConstraints", "design.technicalConstraints", "技术方案与关键约束", issues, true);
  stringsAt(design, "dataSecurity", "design.dataSecurity", "数据、安全与异常处理", issues, true);
  stringsAt(design, "failureHandling", "design.failureHandling", "数据、安全与异常处理", issues, true);
  optionalStringsAt(design, "risks", "design.risks", "技术方案与关键约束", issues);

  const scope = objectAt(source, "scope", "功能范围与排除项", issues);
  const includePaths = safePaths(
    stringsAt(scope, "includePaths", "scope.includePaths", "功能范围与排除项", issues, mode === "REPOSITORY_FILE"),
    "scope.includePaths",
    "功能范围与排除项",
    issues,
  );
  safePaths(
    stringsAt(scope, "excludePaths", "scope.excludePaths", "功能范围与排除项", issues),
    "scope.excludePaths",
    "功能范围与排除项",
    issues,
  );
  if (mode === "CONVERSATION" && includePaths.length > 0)
    issue(issues, "scope.includePaths", "MODE_CONFLICT", "功能范围与排除项", "CONVERSATION 模式必须为空数组。");
  if (mode === "REPOSITORY_FILE" && artifactPath && !includePaths.includes(artifactPath.replaceAll("\\", "/")))
    issue(issues, "scope.includePaths", "MODE_CONFLICT", "功能范围与排除项", "必须包含 artifact.path。");

  const rawTasks = source.tasks;
  const taskIds: string[] = [];
  const taskDependencies: Array<{ id: string; dependencies: string[] }> = [];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0)
    issue(issues, "tasks", rawTasks === undefined ? "REQUIRED" : "INVALID", "实施任务、依赖与冲突", "必须是至少包含一个任务的数组。");
  else
    rawTasks.forEach((rawTask, index) => {
      const path = `tasks[${index}]`;
      if (!isRecord(rawTask)) {
        issue(issues, path, "INVALID", "实施任务、依赖与冲突", "必须是对象。");
        return;
      }
      const id = stringAt(rawTask, "id", `${path}.id`, "实施任务、依赖与冲突", issues);
      stringAt(rawTask, "title", `${path}.title`, "实施任务、依赖与冲突", issues);
      const dependencies = stringsAt(rawTask, "dependencies", `${path}.dependencies`, "实施任务、依赖与冲突", issues);
      optionalTaskChanges(rawTask, path, issues);
      optionalTaskAcceptanceRefs(rawTask, path, issues, acceptanceCriteria.length);
      // `tasks[].status` **故意不读也不校验**：进度的事实来源是 Run 的 journal，这个键谁都不推进。
      // 提示词已经说过"不要填写"，实测 74/74 个任务还是照写（压不住），所以它现在是"写了也被忽略"。
      // 老 CandidatePlan 带着这个键，报 FORBIDDEN 会让它们连重新解析都过不去——忽略才是正确语义。
      if (id) {
        taskIds.push(id);
        taskDependencies.push({ id, dependencies });
      }
    });
  if (new Set(taskIds).size !== taskIds.length) issue(issues, "tasks", "DUPLICATE", "实施任务、依赖与冲突", "任务 id 必须唯一。");
  const knownTaskIds = new Set(taskIds);
  for (const task of taskDependencies)
    for (const dependency of task.dependencies)
      if (!knownTaskIds.has(dependency))
        issue(issues, `tasks.${task.id}.dependencies`, "INVALID", "实施任务、依赖与冲突", `引用了不存在的任务 ${dependency}。`);
  stringsAt(source, "dependencies", "dependencies", "实施任务、依赖与冲突", issues);
  stringsAt(source, "conflicts", "conflicts", "实施任务、依赖与冲突", issues);

  const execution = objectAt(source, "execution", "实施任务、依赖与冲突", issues);
  // `execution.executorModelRole` / `execution.toolPolicy` 不再被读取，但**故意不报 FORBIDDEN**：
  // 库里已有的 CandidatePlan 带着这两个键，报错会让它们连 confirm 都过不去。忽略是这里的正确语义。
  if (
    execution.maxRepairAttempts !== undefined &&
    (!Number.isInteger(execution.maxRepairAttempts) || Number(execution.maxRepairAttempts) < 0)
  )
    issue(issues, "execution.maxRepairAttempts", "INVALID", "实施任务、依赖与冲突", "如填写，必须是非负整数。");

  const verification = objectAt(source, "verification", "验收标准与验证命令", issues);
  if (verification.mode !== "PROJECT_DEFAULT" && verification.mode !== "NONE")
    issue(
      issues,
      "verification.mode",
      verification.mode === undefined ? "REQUIRED" : "INVALID",
      "验收标准与验证命令",
      "必须为 PROJECT_DEFAULT 或 NONE。",
    );
  const suites =
    verification.suites === undefined ? [] : stringsAt(verification, "suites", "verification.suites", "验收标准与验证命令", issues);
  if (verification.suites !== undefined && suites.length === 0)
    issue(issues, "verification.suites", "INVALID", "验收标准与验证命令", "如填写，必须是至少一项的字符串数组；不要用空数组表达“全部”。");
  if (verification.suites !== undefined && verification.mode === "NONE")
    issue(issues, "verification.suites", "MODE_CONFLICT", "验收标准与验证命令", "verification.mode 为 NONE 时不能声明 suites。");
  if (mode === "CONVERSATION" && verification.mode !== "NONE")
    issue(issues, "verification.mode", "MODE_CONFLICT", "验收标准与验证命令", "CONVERSATION 模式必须为 NONE。");

  // `merge`（strategy / requireHumanMerge）**故意不读也不校验**：真正的合并不经过 Factory，这两个值
  // 由 Factory 固定填进冻结契约（见 GeneratedPlanSpec 末尾的说明）。老 CandidatePlan 带着这个键，
  // 报 FORBIDDEN 会让它们连重新解析都过不去——忽略才是正确语义（与 executorModelRole 同一条处理）。

  for (const field of ["repository", "baseBranch", "baseCommit", "configVersion", "configHash", "verificationCommandIds"])
    if (field in source) issue(issues, field, "FORBIDDEN", "Factory 自动补全", "只能由 Factory 基于当前 Project 与 Git 基线补全。");
  if ("commandIds" in verification) issue(issues, "verification.commandIds", "FORBIDDEN", "Factory 自动补全", "只能由 Factory 补全。");
  return issues;
}

export function parseGeneratedPlanSpec(value: unknown): GeneratedPlanSpec {
  const issues = validateGeneratedPlanSpec(value);
  if (issues.length) throw new GeneratedPlanSpecValidationError(issues);
  const source = value as Record<string, unknown>;
  const artifact = source.artifact as Record<string, unknown>;
  const objective = source.objective as Record<string, unknown>;
  const design = source.design as Record<string, unknown>;
  const scope = source.scope as Record<string, unknown>;
  const execution = source.execution as Record<string, unknown>;
  const verification = source.verification as Record<string, unknown>;
  const normalize = (values: unknown) => (values as string[]).map((item) => item.trim());
  return {
    schemaVersion: 2,
    title: String(source.title).trim(),
    artifact: {
      mode: artifact.mode as PlanArtifactMode,
      ...(typeof artifact.path === "string" ? { path: assertSafeProjectRelativeGlob(artifact.path, "artifact.path") } : {}),
    },
    objective: {
      goal: String(objective.goal).trim(),
      ...(objective.context === undefined ? {} : { context: normalize(objective.context) }),
      audience: normalize(objective.audience),
      acceptanceCriteria: normalize(objective.acceptanceCriteria),
      outOfScope: normalize(objective.outOfScope),
    },
    design: {
      technicalConstraints: normalize(design.technicalConstraints),
      dataSecurity: normalize(design.dataSecurity),
      failureHandling: normalize(design.failureHandling),
      ...(design.risks === undefined ? {} : { risks: normalize(design.risks) }),
    },
    scope: {
      includePaths: normalize(scope.includePaths).map((path) => assertSafeProjectRelativeGlob(path, "scope.includePaths")),
      excludePaths: normalize(scope.excludePaths).map((path) => assertSafeProjectRelativeGlob(path, "scope.excludePaths")),
    },
    tasks: (source.tasks as Array<Record<string, unknown>>).map((task) => ({
      id: String(task.id).trim(),
      title: String(task.title).trim(),
      dependencies: normalize(task.dependencies),
      ...(task.acceptanceRefs === undefined
        ? {}
        : { acceptanceRefs: [...new Set(task.acceptanceRefs as number[])].sort((left, right) => left - right) }),
      ...(task.changes === undefined
        ? {}
        : {
            changes: (task.changes as Array<Record<string, unknown>>).map((change) => ({
              path: assertSafeProjectRelativeGlob(String(change.path), "tasks.changes.path"),
              action: change.action as PlanTaskChange["action"],
              detail: String(change.detail).trim(),
            })),
          }),
    })),
    dependencies: normalize(source.dependencies),
    conflicts: normalize(source.conflicts),
    execution: { maxRepairAttempts: typeof execution.maxRepairAttempts === "number" ? execution.maxRepairAttempts : undefined },
    verification: {
      mode: verification.mode as "PROJECT_DEFAULT" | "NONE",
      ...(verification.suites === undefined ? {} : { suites: normalize(verification.suites) }),
    },
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
function selectVerificationCommands(
  defaults: string[],
  enabledVerification: Map<string, RegisteredCommandDefinition>,
  suites: string[],
): string[] {
  if (suites.length === 0) return [...defaults];
  const knownTags = new Set([...enabledVerification.values()].flatMap((command) => command.tags ?? []));
  const unknown = suites.filter((suite) => !knownTags.has(suite));
  if (unknown.length > 0) {
    const declared = [...knownTags].sort().join(", ");
    throw new Error(
      `Plan verification suites are not declared by this Project: ${unknown.join(", ")}. Declared tags: ${declared || "(none)"}`,
    );
  }
  const selected = defaults.filter((commandId) => {
    const tags = enabledVerification.get(commandId)?.tags ?? [];
    return suites.some((suite) => tags.includes(suite));
  });
  if (selected.length === 0)
    throw new Error(
      `Plan verification suites ${suites.join(", ")} match none of the Project default verification commands (${defaults.join(", ")})`,
    );
  return selected;
}

export function resolvePlanContract(specValue: unknown, project: ProjectExecutionSnapshot, baseline: GitBaseline): ResolvedPlanContract {
  const spec = parseGeneratedPlanSpec(specValue);
  if (!baseline.baseBranch.trim() || !baseline.baseCommit.trim() || /^(HEAD|unknown|unverified)$/i.test(baseline.baseCommit.trim()))
    throw new Error("Factory must resolve a verified Git baseline before creating a plan");
  const defaults = project.settings.defaultVerificationCommandIds ?? [];
  const enabledVerification = new Map(
    project.settings.commands
      .filter((command) => command.category === "verification" && command.enabled !== false)
      .map((command) => [command.commandId, command]),
  );
  if (defaults.some((id) => !enabledVerification.has(id))) throw new Error("Project default verification commands are invalid");
  const mode = spec.verification.mode === "NONE" || defaults.length === 0 ? "NONE" : "PROJECT_DEFAULT";
  // 解析后的 commandIds 才是执行事实；请求过的 suites 留在 generatedSpec 里可审计。
  const commandIds =
    mode === "PROJECT_DEFAULT" ? selectVerificationCommands(defaults, enabledVerification, spec.verification.suites ?? []) : [];
  const technicalConstraints = [...new Set([...spec.design.technicalConstraints, ...spec.dependencies])];
  return {
    schemaVersion: 2,
    artifact: spec.artifact,
    objective: spec.objective,
    design: { ...spec.design, technicalConstraints },
    conflicts: spec.conflicts,
    repository: {
      projectId: project.projectId,
      name: project.name,
      repoRoot: project.repoRoot,
      baseBranch: baseline.baseBranch,
      baseCommit: baseline.baseCommit,
      configVersion: project.configVersion,
      configHash: project.configHash,
    },
    scope: spec.scope,
    tasks: spec.tasks.map((task) => ({ ...task, status: "READY" as const })),
    dependencies: spec.dependencies,
    dependsOnPlanIds: [],
    execution: {
      executorModelRole: EXECUTOR_ROLE,
      toolPolicy: EXECUTOR_TOOL_POLICY,
      maxRepairAttempts:
        Number.isInteger(spec.execution.maxRepairAttempts) && spec.execution.maxRepairAttempts! >= 0
          ? spec.execution.maxRepairAttempts!
          : project.settings.concurrency.maxRepairAttempts,
    },
    verification: { mode, commandIds },
    merge: { strategy: MERGE_STRATEGY, requireHumanMerge: REQUIRE_HUMAN_MERGE },
  };
}
