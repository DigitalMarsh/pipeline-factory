import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type {
  HookDefinition,
  ModelRoleConfig,
  PipelineStore,
  RegisteredCommandDefinition,
  RunStatus,
} from "./index.js";

export type ProjectStatus = "ACTIVE" | "ARCHIVED";

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

export type ProjectConfigRevision = Readonly<{
  projectId: string;
  version: number;
  hash: string;
  snapshot: ProjectExecutionSnapshot;
  createdAt: string;
}>;

export type CreateProjectInput = {
  id?: string;
  name: string;
  repoRoot: string;
  defaultBranch: string;
  worktreeRoot: string;
  settings?: ProjectSettingsInput;
};

export type UpdateProjectInput = {
  name?: string;
  repoRoot?: string;
  defaultBranch?: string;
  worktreeRoot?: string;
  settings?: ProjectSettingsInput;
  expectedConfigVersion?: number;
};

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

export const EXECUTION_SLOT_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "STARTING",
  "IN_PROGRESS",
  "VERIFYING",
]);

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

export class ProjectService {
  constructor(private readonly store: PipelineStore) {}

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

  bootstrapLegacy(input: CreateProjectInput): Project {
    const existing = this.store.getProject(input.id ?? "");
    if (existing) {
      // The first migration may have seeded project-demo from a stale relative
      // root. Once a user changes the project name/configuration, the version
      // advances and this repair path is no longer eligible.
      const isUnmodifiedLegacySeed = existing.configVersion === 1 && existing.name === basename(existing.repoRoot);
      if (isUnmodifiedLegacySeed && existing.repoRoot !== input.repoRoot) {
        // Never rewrite a high-risk project path while an old Run is still
        // active. The next restart will retry this idempotent repair after the
        // Run is resolved, while the existing history remains readable.
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

  get(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    return project;
  }

  list(status?: ProjectStatus): Project[] {
    return this.store.listProjects().filter((project) => !status || project.status === status).sort((a, b) => a.name.localeCompare(b.name));
  }

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

  archive(projectId: string): Project {
    const project = this.get(projectId);
    if (project.status === "ARCHIVED") return project;
    if (hasActiveRun(this.store, projectId)) throw new Error(`Project ${projectId} has active runs`);
    const archived = this.store.updateProject({ ...project, status: "ARCHIVED", archivedAt: this.store.now(), updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.archived", aggregateId: projectId, payload: { projectId } });
    return archived;
  }

  activate(projectId: string): Project {
    const project = this.get(projectId);
    if (project.status === "ACTIVE") return project;
    const active = this.store.updateProject({ ...project, status: "ACTIVE", archivedAt: null, updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.activated", aggregateId: projectId, payload: { projectId } });
    return active;
  }

  selectExplorer(projectId: string, explorerId: string): Project {
    const project = this.get(projectId);
    const thread = this.store.getThread(explorerId);
    if (!thread || thread.projectId !== projectId) throw new Error(`Explorer ${explorerId} does not belong to project ${projectId}`);
    if (thread.state === "ARCHIVED") throw new Error(`Explorer ${explorerId} is archived`);
    const updated = this.store.updateProject({ ...project, currentExplorerThreadId: explorerId, updatedAt: this.store.now() });
    this.store.appendEvent({ type: "project.explorer.selected", aggregateId: projectId, payload: { projectId, explorerId } });
    return updated;
  }

  snapshot(projectId: string): ProjectExecutionSnapshot {
    return projectSnapshot(this.get(projectId));
  }

  configHistory(projectId: string): ProjectConfigRevision[] {
    this.get(projectId);
    return this.store.listProjectConfigRevisions(projectId);
  }

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
