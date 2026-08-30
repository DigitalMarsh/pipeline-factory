/**
 * 模块职责：定义 Project 配置、版本、快照、路径校验和归档生命周期。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  HookDefinition,
  ModelRoleConfig,
  PipelineStore,
  RegisteredCommandDefinition,
  RunStatus,
} from "./index.js";

/** Project 生命周期状态；ARCHIVED 保留历史但关闭新的写入和执行入口。 */
export type ProjectStatus = "ACTIVE" | "ARCHIVED";

/** Project 的项目级运行策略；确认 Plan 时会深拷贝进不可变执行快照。 */
export type ProjectSettings = {
  concurrency: {
    maxParallelRuns: number;
    defaultTimeoutMs: number;
    maxAutoContinuationTurns: number;
    maxRepairAttempts: number;
  };
  commands: RegisteredCommandDefinition[];
  hooks: {
    start?: HookDefinition;
    cleanup?: HookDefinition;
  };
  models: {
    explorer: ModelRoleConfig;
    executor: ModelRoleConfig;
  };
  toolPolicy: {
    allowedMcpTools: string[];
    allowedPluginTools: string[];
    computerUseEnabled: boolean;
  };
};

/** Project Settings 的局部更新输入；未提供的字段沿用当前配置。 */
export type ProjectSettingsInput = {
  concurrency?: Partial<ProjectSettings["concurrency"]>;
  commands?: RegisteredCommandDefinition[];
  hooks?: ProjectSettings["hooks"];
  models?: {
    explorer?: Partial<ModelRoleConfig> & Pick<ModelRoleConfig, "model">;
    executor?: Partial<ModelRoleConfig> & Pick<ModelRoleConfig, "model">;
  };
  toolPolicy?: Partial<ProjectSettings["toolPolicy"]>;
};

/** Project 的当前配置实体；configHash 与 configVersion 标识可执行策略版本。 */
export type Project = {
  id: string;
  name: string;
  repoRoot: string;
  defaultBranch: string;
  worktreeRoot: string;
  status: ProjectStatus;
  currentExplorerThreadId: string | null;
  configVersion: number;
  configHash: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

/** 随 PlanRevision 冻结的执行输入，后续 Project 修改不得回写此对象。 */
export type ProjectExecutionSnapshot = Readonly<{
  projectId: string;
  name: string;
  repoRoot: string;
  defaultBranch: string;
  worktreeRoot: string;
  configVersion: number;
  configHash: string;
  settings: ProjectSettings;
}>;

/** Project 配置历史记录，用于审计和解释旧 Run 的行为。 */
export type ProjectConfigRevision = Readonly<{
  projectId: string;
  version: number;
  hash: string;
  snapshot: ProjectExecutionSnapshot;
  createdAt: string;
}>;

/** 创建 Project 所需的仓库、Worktree 和初始运行策略。 */
export type CreateProjectInput = {
  id?: string;
  name: string;
  repoRoot: string;
  defaultBranch: string;
  worktreeRoot: string;
  settings?: ProjectSettingsInput;
};

/** 更新 Project 的局部输入；expectedConfigVersion 用于乐观并发控制。 */
export type UpdateProjectInput = {
  name?: string;
  repoRoot?: string;
  defaultBranch?: string;
  worktreeRoot?: string;
  settings?: ProjectSettingsInput;
  expectedConfigVersion?: number;
};

/** Project Catalog/详情页使用的聚合统计，不复制领域写模型。 */
export type ProjectSummary = {
  project: Project;
  currentExplorerThread: string | null;
  threadCount: number;
  planCount: number;
  runCount: number;
  activeRunCount: number;
  needsAttentionCount: number;
  lastActivityAt: string | null;
};

/** 占用并发槽位的 Run 状态；QUEUED 和终态不占用执行中的槽位。 */
export const EXECUTION_SLOT_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "STARTING",
  "IN_PROGRESS",
  "VERIFYING",
]);

/** 新 Project 的安全默认值；具体项目可在创建向导中显式覆盖。 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  concurrency: {
    maxParallelRuns: 2,
    defaultTimeoutMs: 120_000,
    maxAutoContinuationTurns: 4,
    maxRepairAttempts: 2,
  },
  commands: [],
  hooks: {},
  models: {
    explorer: { model: "gpt-5.6-luna", mode: "plan", temperature: 0.1, loopMode: "provider-controlled" },
    executor: { model: "gpt-5.6-luna", mode: "default", temperature: 0, loopMode: "provider-controlled" },
  },
  toolPolicy: {
    allowedMcpTools: [],
    allowedPluginTools: [],
    computerUseEnabled: false,
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

/** 合并并校验局部 Settings，返回可安全保存和快照的完整配置。 */
export function normalizeProjectSettings(input?: ProjectSettingsInput, base: ProjectSettings = DEFAULT_PROJECT_SETTINGS): ProjectSettings {
  const value = input ?? {};
  return {
    concurrency: { ...base.concurrency, ...value.concurrency },
    commands: value.commands ? value.commands.map((command) => ({ ...command, argv: [...command.argv], ...(command.environment ? { environment: { ...command.environment } } : {}) })) : clone(base.commands),
    hooks: { ...base.hooks, ...value.hooks },
    models: {
      explorer: { ...base.models.explorer, ...value.models?.explorer },
      executor: { ...base.models.executor, ...value.models?.executor },
    },
    toolPolicy: {
      ...base.toolPolicy,
      ...value.toolPolicy,
      allowedMcpTools: value.toolPolicy?.allowedMcpTools ? [...value.toolPolicy.allowedMcpTools] : [...base.toolPolicy.allowedMcpTools],
      allowedPluginTools: value.toolPolicy?.allowedPluginTools ? [...value.toolPolicy.allowedPluginTools] : [...base.toolPolicy.allowedPluginTools],
    },
  };
}

function projectHash(input: Pick<Project, "name" | "repoRoot" | "defaultBranch" | "worktreeRoot" | "settings">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ name: input.name, repoRoot: input.repoRoot, defaultBranch: input.defaultBranch, worktreeRoot: input.worktreeRoot, settings: input.settings })).digest("hex")}`;
}

/** 从当前 Project 生成深拷贝快照；快照不含运行时可变字段。 */
export function projectSnapshot(project: Project): ProjectExecutionSnapshot {
  return freezeDeep({
    projectId: project.id,
    name: project.name,
    repoRoot: project.repoRoot,
    defaultBranch: project.defaultBranch,
    worktreeRoot: project.worktreeRoot,
    configVersion: project.configVersion,
    configHash: project.configHash,
    settings: clone(project.settings),
  });
}

function normalizeAbsolutePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (!isAbsolute(trimmed)) throw new Error(`${field} must be an absolute path`);
  return resolve(trimmed);
}

function assertProjectPaths(repoRoot: string, worktreeRoot: string): void {
  if (repoRoot === worktreeRoot) throw new Error("repoRoot and worktreeRoot must be different");
}

function hasActiveRun(store: PipelineStore, projectId: string): boolean {
  return store.listRuns().some((run) => run.projectId === projectId && EXECUTION_SLOT_RUN_STATUSES.has(run.status));
}

/**
 * 管理 Project 的生命周期、配置版本和执行快照。
 * 所有高风险路径或运行策略变更都会递增 configVersion，并为历史 Plan 保留旧快照。
 */
export class ProjectService {
  constructor(private readonly store: PipelineStore) {}

  /** 创建唯一绑定一个 Git 根目录的 Project，并保存初始配置版本。 */
  create(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new Error("Project name is required");
    const repoRoot = normalizeAbsolutePath(input.repoRoot, "repoRoot");
    const worktreeRoot = normalizeAbsolutePath(input.worktreeRoot, "worktreeRoot");
    assertProjectPaths(repoRoot, worktreeRoot);
    if (this.store.listProjects().some((project) => project.repoRoot === repoRoot)) throw new Error(`A project already uses repoRoot ${repoRoot}`);
    const createdAt = this.store.now();
    const settings = normalizeProjectSettings(input.settings);
    const project: Project = {
      id: input.id ?? this.store.nextId("project"),
      name,
      repoRoot,
      defaultBranch: input.defaultBranch.trim() || "main",
      worktreeRoot,
      status: "ACTIVE",
      currentExplorerThreadId: null,
      configVersion: 1,
      configHash: projectHash({ name, repoRoot, defaultBranch: input.defaultBranch.trim() || "main", worktreeRoot, settings }),
      settings,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    };
    const saved = this.store.saveProject(project);
    this.saveConfigRevision(saved);
    this.store.appendEvent({ type: "project.created", aggregateId: saved.id, payload: { projectId: saved.id, repoRoot: saved.repoRoot } });
    return saved;
  }

  /** 幂等补全旧数据迁移；只修复未被用户修改且没有活动 Run 的旧种子。 */
  bootstrapLegacy(input: CreateProjectInput): Project {
    const existing = this.store.getProject(input.id ?? "");
    if (existing) {
      // 首次迁移可能从过期的相对路径创建 project-demo；用户改过名称或配置后，
      // configVersion 已推进，此修复分支不再自动改写用户数据。
      const isUnmodifiedLegacySeed = existing.configVersion === 1 && existing.name === basename(existing.repoRoot);
      if (isUnmodifiedLegacySeed && existing.repoRoot !== input.repoRoot) {
        // 旧 Run 活动期间不改写高风险路径；Run 结束后下次启动仍可幂等重试，
        // 同时确保现有历史数据始终可读。
        if (hasActiveRun(this.store, existing.id)) return existing;
        const repair: UpdateProjectInput = {
          name: input.name,
          repoRoot: input.repoRoot,
          defaultBranch: input.defaultBranch,
          worktreeRoot: input.worktreeRoot,
          expectedConfigVersion: existing.configVersion,
        };
        if (input.settings) repair.settings = input.settings;
        return this.update(input.id ?? existing.id, repair);
      }
      if (existing.currentExplorerThreadId) return existing;
      const current = this.store.listThreads()
        .filter((thread) => thread.projectId === existing.id && thread.state !== "ARCHIVED")
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
      if (!current) return existing;
      return this.store.updateProject({ ...existing, currentExplorerThreadId: current.id, updatedAt: this.store.now() });
    }
    const project = this.create(input);
    const current = this.store.listThreads()
      .filter((thread) => thread.projectId === project.id && thread.state !== "ARCHIVED")
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    if (!current) return project;
    return this.store.updateProject({ ...project, currentExplorerThreadId: current.id, updatedAt: this.store.now() });
  }

  /** 读取 Project；未知 ID 明确失败，禁止回退到默认 Project。 */
  get(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    return project;
  }

  /** 按状态列出 Project，结果按名称稳定排序以供 Catalog 使用。 */
  list(status?: ProjectStatus): Project[] {
    return this.store.listProjects().filter((project) => !status || project.status === status).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 更新 Project 配置；expectedConfigVersion 用于阻止并发编辑覆盖最新版本。 */
  update(projectId: string, input: UpdateProjectInput): Project {
    const project = this.get(projectId);
    if (project.status === "ARCHIVED") throw new Error(`Project ${projectId} is archived`);
    if (input.expectedConfigVersion !== undefined && input.expectedConfigVersion !== project.configVersion) throw new Error(`Project ${projectId} configuration version conflict`);
    const name = input.name === undefined ? project.name : input.name.trim();
    if (!name) throw new Error("Project name is required");
    const repoRoot = input.repoRoot === undefined ? project.repoRoot : normalizeAbsolutePath(input.repoRoot, "repoRoot");
    const worktreeRoot = input.worktreeRoot === undefined ? project.worktreeRoot : normalizeAbsolutePath(input.worktreeRoot, "worktreeRoot");
    assertProjectPaths(repoRoot, worktreeRoot);
    if (repoRoot !== project.repoRoot && this.store.listProjects().some((item) => item.id !== projectId && item.repoRoot === repoRoot)) throw new Error(`A project already uses repoRoot ${repoRoot}`);
    const nextSettings = input.settings ? normalizeProjectSettings(input.settings, project.settings) : clone(project.settings);
    const defaultBranch = input.defaultBranch === undefined ? project.defaultBranch : input.defaultBranch.trim();
    if (!defaultBranch) throw new Error("defaultBranch is required");
    const changed = name !== project.name || repoRoot !== project.repoRoot || worktreeRoot !== project.worktreeRoot || defaultBranch !== project.defaultBranch || JSON.stringify(nextSettings) !== JSON.stringify(project.settings);
    if (!changed) return project;
    const highRiskChanged = repoRoot !== project.repoRoot || worktreeRoot !== project.worktreeRoot || defaultBranch !== project.defaultBranch || JSON.stringify(nextSettings) !== JSON.stringify(project.settings);
    if (highRiskChanged && hasActiveRun(this.store, projectId)) throw new Error(`Project ${projectId} has active runs`);
    const updated: Project = {
      ...project,
      name,
      repoRoot,
      defaultBranch,
      worktreeRoot,
      settings: nextSettings,
      configVersion: project.configVersion + 1,
      configHash: projectHash({ name, repoRoot, defaultBranch, worktreeRoot, settings: nextSettings }),
      updatedAt: this.store.now(),
    };
    const saved = this.store.updateProject(updated);
    this.saveConfigRevision(saved);
    this.store.appendEvent({ type: "project.config.updated", aggregateId: projectId, payload: { projectId, configVersion: saved.configVersion, configHash: saved.configHash } });
    return saved;
  }

  /** 归档 Project；历史数据保留，但活动 Run 存在时拒绝归档。 */
  archive(projectId: string): Project {
    const project = this.get(projectId);
    if (project.status === "ARCHIVED") return project;
    if (hasActiveRun(this.store, projectId)) throw new Error(`Project ${projectId} has active runs`);
    const archived = this.store.updateProject({ ...project, status: "ARCHIVED", archivedAt: this.store.now(), updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.archived", aggregateId: projectId, payload: { projectId } });
    return archived;
  }

  /** 恢复已归档 Project 的新建和执行能力。 */
  activate(projectId: string): Project {
    const project = this.get(projectId);
    if (project.status === "ACTIVE") return project;
    const active = this.store.updateProject({ ...project, status: "ACTIVE", archivedAt: null, updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.activated", aggregateId: projectId, payload: { projectId } });
    return active;
  }

  /** 设置当前 ExplorerThread；线程必须属于同一 Project 且未归档。 */
  selectExplorer(projectId: string, explorerId: string): Project {
    const project = this.get(projectId);
    const thread = this.store.getThread(explorerId);
    if (!thread || thread.projectId !== projectId) throw new Error(`Explorer ${explorerId} does not belong to project ${projectId}`);
    if (thread.state === "ARCHIVED") throw new Error(`Explorer ${explorerId} is archived`);
    const updated = this.store.updateProject({ ...project, currentExplorerThreadId: explorerId, updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.explorer.selected", aggregateId: projectId, payload: { projectId, explorerId } });
    return updated;
  }

  /** 生成深度冻结的执行快照，供 Confirm 后的 PlanRevision 长期使用。 */
  snapshot(projectId: string): ProjectExecutionSnapshot {
    return projectSnapshot(this.get(projectId));
  }

  /** 返回 Project 配置版本历史，便于解释旧 Plan 使用的运行策略。 */
  configHistory(projectId: string): ProjectConfigRevision[] {
    this.get(projectId);
    return this.store.listProjectConfigRevisions(projectId);
  }

  /** 聚合 Project 维度的线程、Plan、Run 和 Needs Attention 统计。 */
  summary(projectId: string): ProjectSummary {
    const project = this.get(projectId);
    const threads = this.store.listThreads().filter((thread) => thread.projectId === projectId);
    const plans = this.store.listPlans().filter((plan) => plan.projectId === projectId);
    const runs = this.store.listRuns().filter((run) => run.projectId === projectId);
    const lastActivityAt = [project.updatedAt, ...threads.map((thread) => thread.lastActivityAt), ...plans.map((plan) => plan.lastEventAt), ...runs.map((run) => run.startedAt ?? run.createdAt)].sort().at(-1) ?? null;
    return {
      project,
      currentExplorerThread: project.currentExplorerThreadId,
      threadCount: threads.length,
      planCount: plans.length,
      runCount: runs.length,
      activeRunCount: runs.filter((run) => EXECUTION_SLOT_RUN_STATUSES.has(run.status)).length,
      needsAttentionCount: plans.filter((plan) => Boolean(plan.attentionReason) || plan.status === "BLOCKED" || plan.status === "NEEDS_PLAN_CHANGE").length,
      lastActivityAt,
    };
  }

  private saveConfigRevision(project: Project): void {
    this.store.saveProjectConfigRevision({ projectId: project.id, version: project.configVersion, hash: project.configHash, snapshot: projectSnapshot(project), createdAt: project.updatedAt });
  }
}
