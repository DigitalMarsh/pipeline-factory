/**
 * 测试职责：验证 project 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExplorerThreadService, InMemoryPipelineStore, LifecycleHookRunner, PlanService, ProjectService, Scheduler, SqlitePipelineStore, validateGeneratedPlanSpec, type ModelGateway } from "../index.js";
import { planContractFixture } from "../plan/plan-fixture.js";

describe("ProjectService", () => {
  it("rejects duplicate and unknown task dependencies", () => {
    // 这条原先打的是 V1 校验器 `validatePlanContract`，它随 V1 扁平合同一起删掉了。
    // 当前形状的任务图由 `validateGeneratedPlanSpec` 把关（重复 id → DUPLICATE，未知依赖 → INVALID）。
    // **任务依赖环不再被拦**：V2 里任务依赖只进执行者的提示词，不驱动调度（进度来自 journal），
    // 环不影响任何执行路径。
    const spec = {
      schemaVersion: 2,
      title: "Task graph",
      artifact: { mode: "REPOSITORY_FILE" },
      objective: { goal: "goal", audience: [], acceptanceCriteria: ["works"], outOfScope: [] },
      design: { technicalConstraints: [], dataSecurity: [], failureHandling: [] },
      scope: { includePaths: ["src"], excludePaths: [] },
      tasks: [{ id: "task-1", title: "one", dependencies: [] }],
      dependencies: [],
      conflicts: [],
      execution: {},
      verification: { mode: "NONE" },
      merge: { strategy: "manual", requireHumanMerge: true },
    };
    expect(validateGeneratedPlanSpec({ ...spec, tasks: [{ id: "task-1", title: "one", dependencies: [] }, { id: "task-1", title: "duplicate", dependencies: [] }] }).map((issue) => issue.code)).toContain("DUPLICATE");
    expect(validateGeneratedPlanSpec({ ...spec, tasks: [{ id: "task-1", title: "one", dependencies: ["missing"] }] }).some((issue) => issue.message.includes("不存在的任务"))).toBe(true);
  });
  it("creates a project with a versioned configuration", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);

    const project = projects.create({
      id: "project-1",
      name: "Demo",
      repoRoot: "/repo/demo",
      defaultBranch: "main",
      worktreeRoot: "/tmp/demo-worktrees",
    });

    expect(project).toMatchObject({
      id: "project-1",
      name: "Demo",
      shortName: "Demo",
      repoRoot: "/repo/demo",
      defaultBranch: "main",
      worktreeRoot: "/tmp/demo-worktrees",
      status: "ACTIVE",
      configVersion: 1,
    });
    expect(project.configHash).toMatch(/^sha256:/);
  });

  it("rejects unsafe runtime settings before persisting a project", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const base = { id: "project-settings", name: "Settings", repoRoot: "/repo/settings", defaultBranch: "main", worktreeRoot: "/tmp/settings-worktrees" };

    expect(() => projects.create({ ...base, settings: { concurrency: { maxParallelRuns: 0 } } })).toThrow(/maxParallelRuns/i);
    expect(() => projects.create({ ...base, id: "project-settings-command", settings: { commands: [{ commandId: "bad", argv: [] as never }] } })).toThrow(/argv/i);
    expect(() => projects.create({ ...base, id: "project-settings-hook", settings: { hooks: { start: { commandId: "hook", maxAttempts: 0 } } } })).toThrow(/maxAttempts/i);
  });

  it("validates the role backend and its reasoning levels when a catalog is provided", () => {
    const store = new InMemoryPipelineStore();
    // catalog 由组合根按配置注入；domain 默认不持有配置，所以没有 catalog 时不校验取值。
    const projects = new ProjectService(store, {
      has: (id) => id === "codex-app-server" || id === "deepseek",
      effortLevelsFor: (id) => (id === "codex-app-server" ? ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] : ["low", "medium", "high", "xhigh", "max"]),
    });
    const base = { id: "project-backend", name: "Backend", repoRoot: "/repo/backend", defaultBranch: "main", worktreeRoot: "/tmp/backend-worktrees" };

    expect(() => projects.create({ ...base, settings: { models: { explorer: { model: "x", backend: "typo" } } } })).toThrow(/models\.explorer\.backend "typo" is not a configured model backend/);
    // Claude 侧只认 5 档：配 minimal 会被后端静默丢弃，所以在保存时就拒绝，而不是等到运行期。
    expect(() => projects.create({ ...base, id: "project-effort", settings: { models: { executor: { model: "x", backend: "deepseek", reasoningEffort: "minimal" } } } })).toThrow(/reasoningEffort "minimal" is not supported by backend deepseek; supported: low, medium, high, xhigh, max/);

    const created = projects.create({ ...base, id: "project-ok", settings: { models: { executor: { model: "deepseek-chat", backend: "deepseek", reasoningEffort: "high" } } } });
    expect(created.settings.models.executor).toMatchObject({ backend: "deepseek", reasoningEffort: "high" });

    // backend: null 表示"清除覆盖、跟随全局"：不区分它的话，控制台第一次保存就会把当前全局后端固化进
    // Project，之后既不再跟随全局，也会被家族迁移跳过。
    const cleared = projects.update("project-ok", { settings: { models: { executor: { model: "gpt-5.6-luna", backend: null } } } });
    expect(cleared.settings.models.executor).not.toHaveProperty("backend");
    expect(cleared.settings.models.executor.model).toBe("gpt-5.6-luna");
  });

  it("rejects command tags that are empty, duplicated, or padded with whitespace", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const base = { id: "project-tags", name: "Tags", repoRoot: "/repo/tags", defaultBranch: "main", worktreeRoot: "/tmp/tags-worktrees" };

    // tag 是 Plan 选验证子集的词表：空白与重复会让"命中哪条命令"变得不可预测，直接拒绝。
    expect(() => projects.create({ ...base, settings: { commands: [{ commandId: "project.test", argv: ["true"], tags: ["unit", "unit"] }] } })).toThrow(/must not contain duplicates/);
    expect(() => projects.create({ ...base, id: "project-tags-pad", settings: { commands: [{ commandId: "project.test", argv: ["true"], tags: [" unit "] }] } })).toThrow(/must not contain surrounding whitespace/);
    expect(() => projects.create({ ...base, id: "project-tags-empty", settings: { commands: [{ commandId: "project.test", argv: ["true"], tags: [""] }] } })).toThrow(/non-empty strings/);

    const created = projects.create({ ...base, id: "project-tags-ok", settings: { commands: [{ commandId: "project.test", argv: ["true"], tags: ["unit", "docs"] }] } });
    expect(created.settings.commands[0]?.tags).toEqual(["unit", "docs"]);
  });

  it("increments the configuration version when project settings change", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const originalHash = projects.get("project-1").configHash;

    const updated = projects.update("project-1", { name: "Renamed", expectedConfigVersion: 1 });

    expect(updated).toMatchObject({ name: "Renamed", configVersion: 2 });
    expect(updated.configHash).not.toBe(originalHash);
  });

  it("persists and snapshots an explicit project short name", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const created = projects.create({ id: "project-short", name: "Demo Project", shortName: "DP", repoRoot: "/repo/short", defaultBranch: "main", worktreeRoot: "/tmp/short-worktrees" });

    expect(created).toMatchObject({ name: "Demo Project", shortName: "DP", configVersion: 1 });
    const originalHash = created.configHash;
    const updated = projects.update("project-short", { shortName: "D2", expectedConfigVersion: 1 });

    expect(updated).toMatchObject({ shortName: "D2", configVersion: 2 });
    expect(updated.configHash).not.toBe(originalHash);
    expect(projects.snapshot("project-short")).toMatchObject({ name: "Demo Project", shortName: "D2" });
  });

  it("blocks archiving while a run is active", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    store.saveRun({
      id: "run-1",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-1",
      workspacePath: "/tmp/demo-worktrees/run-1",
      baseCommit: "abc",
      executionThreadId: "execution-1",
      createdAt: store.now(),
      startedAt: store.now(),
    });

    expect(() => projects.archive("project-1")).toThrow(/active runs/i);
  });

  it("counts only execution states as active runs", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const baseRun = { projectId: "project-1", planId: "plan-1", planRevision: 1, branch: "factory/run", workspacePath: "/tmp/demo-worktrees/run", baseCommit: "abc", executionThreadId: "execution-1", createdAt: store.now(), startedAt: store.now() };
    for (const [index, status] of (["MERGE_READY", "READY_FOR_VERIFY", "VERIFYING"] as const).entries()) {
      store.saveRun({ ...baseRun, id: `run-${index}`, status });
    }

    expect(projects.summary("project-1").activeRunCount).toBe(1);
  });

  it("keeps settings editable while a run is active, and still blocks paths, branches and hooks", () => {
    // 设置页的原话分得很清楚：General 栏说"仓库目录、Worktree 和分支修改**需要没有运行中的 Run**"，
    // 而 Execution 栏说"这些设置会在下一次 Plan Confirm 时冻结"、Models 栏说"同样在 Plan Confirm 时冻结"。
    // 运行中的 Run 用的是自己那份冻结快照（`executor-agent` 从 revision.projectConfigSnapshot 取模型），
    // 所以"趁跑着把执行模型换成 claude"是安全且预期的操作。
    //
    // 这里曾经把**任何** settings 变更都当成高风险，于是最自然的这次操作被 409 挡下，错误还是一句
    // 英文 "has active runs"——用户看到的现象是"我明明改了，怎么还是老模型"。
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees", settings: { commands: [{ commandId: "project.cleanup", argv: ["true"], enabled: true, category: "lifecycle" }] } });
    store.saveRun({ id: "run-active", projectId: "project-1", planId: "plan-1", planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-active", workspacePath: "/tmp/demo-worktrees/run-active", baseCommit: "abc", executionThreadId: "execution-1", createdAt: store.now(), startedAt: store.now() });

    const updated = projects.update("project-1", { settings: { models: { executor: { model: "claude-opus-5", backend: "claude-agent-sdk" } } } });
    expect(updated.settings.models.executor).toMatchObject({ model: "claude-opus-5", backend: "claude-agent-sdk" });

    // 路径、分支照旧要挡：运行中的 Worktree 就在 worktreeRoot 下，分支还牵着合并。
    expect(() => projects.update("project-1", { repoRoot: "/repo/other" })).toThrow(/active runs/i);
    expect(() => projects.update("project-1", { defaultBranch: "release" })).toThrow(/active runs/i);
    // hooks 也要挡：`PATCH /hooks` 那条路由本来就有自己的活动 Run 守卫，不能从这里开后门。
    expect(() => projects.update("project-1", { settings: { hooks: { cleanup: { commandId: "project.cleanup", enabled: true, timeoutMs: 1000, maxAttempts: 1 } } } })).toThrow(/active runs/i);
  });

  it("freezes the project snapshot when a plan is confirmed", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Frozen plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Frozen plan" }) });

    plans.confirm(plan.id, "local-user");
    const revision = plans.getRevision(plan.id, 1);
    projects.update("project-1", { name: "Changed", expectedConfigVersion: 1 });

    expect(revision.projectConfigSnapshot).toMatchObject({ projectId: "project-1", name: "Demo", repoRoot: "/repo/demo", configVersion: 1 });
    expect(revision.projectConfigHash).toBe(revision.projectConfigSnapshot!.configHash);
  });

  it("bootstraps the legacy project without replacing its id", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    store.saveThread({ id: "explorer-old", projectId: "project-demo", parentThreadId: null, createdAt: "2026-08-28T00:00:00.000Z" });
    store.saveThread({ id: "explorer-current", projectId: "project-demo", parentThreadId: null, createdAt: "2026-08-29T00:00:00.000Z" });

    const project = projects.bootstrapLegacy({
      id: "project-demo",
      name: "ai-tools",
      repoRoot: "/repo/ai-tools",
      defaultBranch: "master",
      worktreeRoot: "/tmp/ai-tools-worktrees",
    });

    expect(project).toMatchObject({ id: "project-demo", name: "ai-tools", currentExplorerThreadId: "explorer-current" });
    expect(projects.bootstrapLegacy({
      id: "project-demo",
      name: "ignored",
      repoRoot: "/repo/ai-tools",
      defaultBranch: "main",
      worktreeRoot: "/tmp/other",
    })).toMatchObject({ id: "project-demo", name: "ai-tools", currentExplorerThreadId: "explorer-current" });
  });

  it("repairs an unmodified legacy seed when the static project root changes", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const seeded = projects.create({
      id: "project-demo",
      name: "old-root",
      repoRoot: "/repo/old-root",
      defaultBranch: "main",
      worktreeRoot: "/tmp/old-worktrees",
    });
    expect(seeded.configVersion).toBe(1);

    const repaired = projects.bootstrapLegacy({
      id: "project-demo",
      name: "ai-tools",
      repoRoot: "/repo/ai-tools",
      defaultBranch: "master",
      worktreeRoot: "/tmp/ai-tools-worktrees",
    });

    expect(repaired).toMatchObject({
      id: "project-demo",
      name: "ai-tools",
      repoRoot: "/repo/ai-tools",
      defaultBranch: "master",
      worktreeRoot: "/tmp/ai-tools-worktrees",
      configVersion: 2,
    });
  });

  it("uses the project repository as the Explorer working directory", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    let requestCwd: string | undefined;
    const model: ModelGateway = {
      configFor: () => ({ model: "stub" }),
      async *stream(request) { requestCwd = request.cwd; yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const explorer = new ExplorerThreadService(store, model, { cwdForProject: (projectId) => projects.get(projectId).repoRoot });

    await explorer.startTurn({ threadId: "explorer-1", explorerPlanId: store.listExplorerPlans("explorer-1")[0]!.id, content: "Inspect the repository", clientTurnId: "turn-1" });

    expect(requestCwd).toBe("/repo/demo");
  });

  it("persists projects and configuration history across SQLite reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-project-test-"));
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const firstProjects = new ProjectService(firstStore);
    firstProjects.create({ id: "project-sqlite", name: "SQLite", shortName: "SQL", repoRoot: "/repo/sqlite", defaultBranch: "main", worktreeRoot: "/tmp/sqlite-worktrees" });
    firstProjects.update("project-sqlite", { name: "SQLite Updated", expectedConfigVersion: 1 });
    const firstPlans = new PlanService(firstStore, firstProjects);
    const thread = firstPlans.registerThread({ id: "sqlite-candidates", projectId: "project-sqlite", parentThreadId: null });
    const requirement = firstStore.listExplorerPlans(thread.id)[0]!;
    const candidate = firstPlans.createCandidatePlan({ projectId: "project-sqlite", sourceExplorerThreadId: thread.id, explorerPlanId: requirement.id, title: "Saved candidate",
      resolvedContract: planContractFixture({ store: firstStore, projectId: "project-sqlite", title: "Saved candidate" }) });
    firstPlans.selectCandidate(requirement.id, null);
    firstStore.updateExplorerPlan({ ...firstStore.getExplorerPlan(requirement.id)!, providerThreadId: "provider-requirement-1", repositoryContextKey: "repository-v2" });
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    const project = reopened.getProject("project-sqlite");
    const history = reopened.listProjectConfigRevisions("project-sqlite");
    const restoredRequirement = reopened.listExplorerPlans(thread.id)[0];
    const candidateVersions = reopened.listCandidateVersions(candidate.id);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });

    expect(project).toMatchObject({ id: "project-sqlite", name: "SQLite Updated", shortName: "SQL", configVersion: 2 });
    expect(history.map((item) => item.version)).toEqual([1, 2]);
    expect(restoredRequirement).toMatchObject({ candidatePlanId: null, newPlanRequested: true, providerThreadId: "provider-requirement-1", repositoryContextKey: "repository-v2" });
    expect(candidateVersions).toMatchObject([{ id: candidate.id, revision: 1, title: "Saved candidate", status: "DRAFT" }]);
  });

  it("runs confirmed plans with the immutable project snapshot adapters", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-snapshot", name: "Snapshot", repoRoot: "/repo/snapshot", defaultBranch: "main", worktreeRoot: "/tmp/snapshot-worktrees", settings: { commands: [{ commandId: "project.test", category: "verification", enabled: true, argv: ["true"] }, { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] }] } });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "thread-snapshot", projectId: "project-snapshot", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-snapshot", sourceExplorerThreadId: "thread-snapshot", title: "Snapshot execution",
      resolvedContract: planContractFixture({ store, projectId: "project-snapshot", title: "Snapshot execution" }) });
    plans.confirm(plan.id, "local-user");
    plans.enqueue(plan.id);
    plans.dispatch(plan.id);
    projects.update("project-snapshot", { repoRoot: "/repo/new-location", worktreeRoot: "/tmp/new-worktrees", expectedConfigVersion: 1 });
    const resolved: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => { throw new Error("default workspace must not be used"); }, remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      workspaceFactory: (snapshot) => {
        resolved.push(`workspace:${snapshot.repoRoot}:${snapshot.worktreeRoot}`);
        return { create: async () => ({ path: "/tmp/snapshot-worktrees/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined };
      },
      hookRunnerFactory: (snapshot) => {
        resolved.push(`hooks:${snapshot.repoRoot}`);
        return new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
      },
    });

    const run = await scheduler.start(plan.id, { start: { commandId: "should-not-be-used" } });

    expect(run.status).toBe("IN_PROGRESS");
    expect(resolved).toEqual(["workspace:/repo/snapshot:/tmp/snapshot-worktrees", "hooks:/repo/snapshot"]);
  });
});

describe("ProjectService legacy model migration", () => {
  const legacySettings = {
    models: {
      explorer: { model: "deepseek-v4-flash" },
      executor: { model: "deepseek-v4-flash" },
    },
  };
  const codexModels = { explorer: "gpt-5.6-luna", executor: "gpt-5.6-luna" };

  function createLegacyProject(store: InMemoryPipelineStore, projects: ProjectService, id = "project-legacy") {
    return projects.create({ id, name: "Legacy", repoRoot: `/repo/${id}`, defaultBranch: "main", worktreeRoot: `/tmp/${id}-worktrees`, settings: legacySettings });
  }

  it("replaces legacy DeepSeek model slugs once and records a new config revision", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const before = createLegacyProject(store, projects);

    expect(projects.migrateLegacyModels(codexModels).map((project) => project.id)).toEqual(["project-legacy"]);

    const after = store.getProject("project-legacy")!;
    expect(after.settings.models.explorer).toMatchObject({ model: "gpt-5.6-luna", mode: "plan", loopMode: "provider-controlled" });
    expect(after.settings.models.executor).toMatchObject({ model: "gpt-5.6-luna", mode: "default", loopMode: "provider-controlled" });
    expect(after.configVersion).toBe(before.configVersion + 1);
    expect(after.configHash).not.toBe(before.configHash);
    expect(store.listProjectConfigRevisions("project-legacy").map((revision) => revision.version)).toEqual([1, 2]);
    expect(store.listEvents({ aggregateId: "project-legacy" }).some((event) => event.type === "project.config.updated")).toBe(true);

    expect(projects.migrateLegacyModels(codexModels)).toEqual([]);
    expect(store.getProject("project-legacy")!.configVersion).toBe(after.configVersion);
  });

  it("leaves projects that already use a supported model and archived projects untouched", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const current = projects.create({ id: "project-current", name: "Current", repoRoot: "/repo/current", defaultBranch: "main", worktreeRoot: "/tmp/current-worktrees" });
    const archived = createLegacyProject(store, projects, "project-archived");
    projects.archive("project-archived");

    expect(projects.migrateLegacyModels(codexModels)).toEqual([]);
    expect(store.getProject("project-current")!.configVersion).toBe(current.configVersion);
    expect(store.getProject("project-archived")!.settings).toEqual(archived.settings);
  });

  it("skips projects with active runs so the migration can retry later", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    createLegacyProject(store, projects);
    const run = store.saveRun({
      id: "run-1",
      projectId: "project-legacy",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-1",
      workspacePath: "/tmp/project-legacy-worktrees/run-1",
      baseCommit: "abc",
      executionThreadId: "execution-1",
      createdAt: store.now(),
      startedAt: store.now(),
    });

    expect(projects.migrateLegacyModels(codexModels)).toEqual([]);
    expect(store.getProject("project-legacy")!.settings.models.explorer.model).toBe("deepseek-v4-flash");

    store.saveRun({ ...run, status: "MERGE_READY" });

    expect(projects.migrateLegacyModels(codexModels).map((project) => project.id)).toEqual(["project-legacy"]);
    expect(store.getProject("project-legacy")!.settings.models.executor.model).toBe("gpt-5.6-luna");
  });

  it("rewrites slugs left over from the other provider family and keeps everything else", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const before = createLegacyProject(store, projects, "project-switch");
    projects.update("project-switch", { settings: { models: { explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna" } } } });

    // 切到 Claude 后端：gpt-* 是上一个家族留下的 slug，按角色配置的模型替换；mode 等其余字段保留。
    expect(projects.migrateForeignFamilyModels({ familyForRole: { explorer: "claude", executor: "claude" }, models: { explorer: "claude-opus-5", executor: "claude-sonnet-5" } }).map((project) => project.id)).toEqual(["project-switch"]);

    const after = store.getProject("project-switch")!;
    expect(after.settings.models.explorer).toMatchObject({ model: "claude-opus-5", mode: "plan" });
    expect(after.settings.models.executor).toMatchObject({ model: "claude-sonnet-5", mode: "default" });
    expect(after.configVersion).toBeGreaterThan(before.configVersion);
    // 幂等：第二次没有可迁移的 slug。
    expect(projects.migrateForeignFamilyModels({ familyForRole: { explorer: "claude", executor: "claude" }, models: { explorer: "claude-opus-5", executor: "claude-sonnet-5" } })).toEqual([]);
  });

  it("migrates each role against its own family so a split-backend project keeps both slugs", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    // 探索用 Codex、执行用 Claude：两个角色各自的 slug 都属于**自己那个后端**的家族。
    projects.create({
      id: "project-split",
      name: "Split",
      repoRoot: "/repo/split",
      defaultBranch: "main",
      worktreeRoot: "/tmp/split-worktrees",
      settings: { models: { explorer: { model: "gpt-5.6-sol" }, executor: { model: "claude-sonnet-5" } } },
    });

    // 用单一家族判定的旧实现会把其中一个角色正确的 slug 改坏；逐角色判定必须两个都不动。
    expect(projects.migrateForeignFamilyModels({ familyForRole: { explorer: "openai", executor: "claude" }, models: { explorer: "gpt-5.6-luna", executor: "claude-opus-5" } })).toEqual([]);
    expect(store.getProject("project-split")!.settings.models.explorer.model).toBe("gpt-5.6-sol");
    expect(store.getProject("project-split")!.settings.models.executor.model).toBe("claude-sonnet-5");
  });

  it("never rewrites a role whose Project explicitly picked a backend", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    // 项目显式选了后端的角色：slug 是用户有意写的，该由 Provider 侧报错暴露，不该被静默替换。
    projects.create({
      id: "project-pinned",
      name: "Pinned",
      repoRoot: "/repo/pinned",
      defaultBranch: "main",
      worktreeRoot: "/tmp/pinned-worktrees",
      settings: { models: { explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna", backend: "claude-agent-sdk" } } },
    });

    expect(projects.migrateForeignFamilyModels({ familyForRole: { explorer: "claude", executor: "claude" }, models: { explorer: "claude-opus-5", executor: "claude-opus-5" } }).map((project) => project.id)).toEqual(["project-pinned"]);
    const after = store.getProject("project-pinned")!;
    // explorer 没固定后端 → 按全局家族迁移；executor 固定了后端 → 原样保留。
    expect(after.settings.models.explorer.model).toBe("claude-opus-5");
    expect(after.settings.models.executor).toMatchObject({ model: "gpt-5.6-luna", backend: "claude-agent-sdk" });
  });

  it("leaves unknown model slugs and same-family slugs alone", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    // 本地别名/自建网关的名字不是任何一种已知家族：宁可让 provider 侧报错，也不要静默替换。
    projects.create({
      id: "project-custom",
      name: "Custom",
      repoRoot: "/repo/custom",
      defaultBranch: "main",
      worktreeRoot: "/tmp/custom-worktrees",
      settings: { models: { explorer: { model: "my-local-alias" }, executor: { model: "claude-sonnet-5" } } },
    });

    expect(projects.migrateForeignFamilyModels({ familyForRole: { explorer: "claude", executor: "claude" }, models: { explorer: "claude-opus-5", executor: "claude-opus-5" } })).toEqual([]);
    expect(store.getProject("project-custom")!.settings.models.explorer.model).toBe("my-local-alias");
    expect(store.getProject("project-custom")!.settings.models.executor.model).toBe("claude-sonnet-5");
  });
});
