/**
 * 测试职责：验证 project 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExplorerThreadService, InMemoryPipelineStore, LifecycleHookRunner, PlanService, ProjectService, Scheduler, SqlitePipelineStore, type ModelGateway } from "./index.js";

describe("ProjectService", () => {
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
      repoRoot: "/repo/demo",
      defaultBranch: "main",
      worktreeRoot: "/tmp/demo-worktrees",
      status: "ACTIVE",
      configVersion: 1,
    });
    expect(project.configHash).toMatch(/^sha256:/);
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

  it("freezes the project snapshot when a plan is confirmed", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Frozen plan" });

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

    await explorer.startTurn({ threadId: "explorer-1", content: "Inspect the repository", clientTurnId: "turn-1" });

    expect(requestCwd).toBe("/repo/demo");
  });

  it("persists projects and configuration history across SQLite reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-project-test-"));
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const firstProjects = new ProjectService(firstStore);
    firstProjects.create({ id: "project-sqlite", name: "SQLite", repoRoot: "/repo/sqlite", defaultBranch: "main", worktreeRoot: "/tmp/sqlite-worktrees" });
    firstProjects.update("project-sqlite", { name: "SQLite Updated", expectedConfigVersion: 1 });
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    const project = reopened.getProject("project-sqlite");
    const history = reopened.listProjectConfigRevisions("project-sqlite");
    reopened.close();
    rmSync(directory, { recursive: true, force: true });

    expect(project).toMatchObject({ id: "project-sqlite", name: "SQLite Updated", configVersion: 2 });
    expect(history.map((item) => item.version)).toEqual([1, 2]);
  });

  it("runs confirmed plans with the immutable project snapshot adapters", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-snapshot", name: "Snapshot", repoRoot: "/repo/snapshot", defaultBranch: "main", worktreeRoot: "/tmp/snapshot-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "thread-snapshot", projectId: "project-snapshot", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-snapshot", sourceExplorerThreadId: "thread-snapshot", title: "Snapshot execution" });
    plans.confirm(plan.id, "local-user");
    plans.enqueue(plan.id);
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
