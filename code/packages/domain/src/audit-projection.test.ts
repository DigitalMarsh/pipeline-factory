/**
 * 测试职责：验证 SQLite 关系约束、追加式执行事实和 Plan 查询投影。
 * 维护提示：这些测试只检查持久化契约，不依赖模型或真实 Git 进程。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, SqlitePipelineStore, type HookExecution } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite audit and query projections", () => {
  it("enables foreign keys and creates normalized audit/query tables", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-audit-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const store = new SqlitePipelineStore(databasePath);
    const database = new DatabaseSync(databasePath);

    expect(Number((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('execution_journal', 'hook_executions', 'plan_query_projection') ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(["execution_journal", "hook_executions", "plan_query_projection"]);

    database.close();
    store.close();
  });

  it("appends journal facts and hook executions across a SQLite reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-audit-reopen-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    firstStore.saveRun({ id: "run-1", projectId: "project-1", planId: "plan-1", planRevision: 1, status: "STARTING", branch: "factory/run-1", workspacePath: "/tmp/worktree", baseCommit: "HEAD", executionThreadId: "execution-thread-1", createdAt: "2026-09-01T00:00:00.000Z", startedAt: null });
    firstStore.saveExecutionThread({ id: "execution-thread-1", runId: "run-1", state: "ACTIVE", journal: [] });

    expect(firstStore.appendExecutionJournal({ executionThreadId: "execution-thread-1", runId: "run-1", type: "TASK_PROGRESS", payload: { action: "started" } })).toMatchObject({ sequence: 1, type: "TASK_PROGRESS" });
    expect(firstStore.appendExecutionJournal({ executionThreadId: "execution-thread-1", runId: "run-1", type: "TASK_PROGRESS", payload: { action: "continued" } })).toMatchObject({ sequence: 2, type: "TASK_PROGRESS" });
    const hook: HookExecution = {
      id: "hook-execution-1",
      runId: "run-1",
      hookType: "start",
      attempt: 1,
      commandId: "project.start",
      cwd: "/tmp/worktree",
      timeoutMs: 5_000,
      status: "failed",
      exitCode: 1,
      stdout: "out",
      stderr: "err",
      startedAt: "2026-09-01T00:00:00.000Z",
      completedAt: "2026-09-01T00:00:01.000Z",
    };
    firstStore.saveHookExecution(hook);
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getExecutionThread("execution-thread-1")?.journal.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(reopened.listHookExecutions("run-1")).toEqual([hook]);
    reopened.close();
  });

  it("persists a searchable Plan query projection for queued plans", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Searchable plan" });
    plans.confirm(plan.id, "local-user");
    plans.enqueue(plan.id);

    expect(store.listPlanQueryProjection("project-1")).toEqual([expect.objectContaining({ planId: plan.id, title: "Searchable plan", projectId: "project-1", sourceExplorerThreadId: "explorer-1", queuedAt: expect.any(String), goal: "Searchable plan", priority: 0 })]);
  });
});
