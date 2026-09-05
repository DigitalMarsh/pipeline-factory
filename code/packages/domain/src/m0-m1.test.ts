/**
 * 测试职责：验证 m0-m1 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryPipelineStore,
  PlanService,
  SqlitePipelineStore,
  ToolGateway,
} from "./index.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite pipeline persistence", () => {
  it("migrates legacy Explorer defaults using message time without changing custom titles", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-explorer-legacy-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE explorer_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        context_mode TEXT NOT NULL,
        origin_thread_id TEXT,
        parent_thread_id TEXT,
        provider_thread_id TEXT,
        state TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary_ref TEXT,
        last_activity_at TEXT NOT NULL,
        exploration_status TEXT NOT NULL,
        exploration_missing_json TEXT NOT NULL,
        exploration_completed_json TEXT NOT NULL,
        candidate_plan_id TEXT,
        last_assessed_turn_id TEXT
      );
      CREATE TABLE explorer_turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
    `);
    legacy.prepare("INSERT INTO explorer_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-default", "project-1", "New Explorer", "FRESH", null, null, null, "ACTIVE", 1, null, "2026-08-29T05:50:00.000Z", "INCOMPLETE", "[]", "[]", null, null);
    legacy.prepare("INSERT INTO explorer_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-custom", "project-1", "已有人工名", "FRESH", null, null, null, "ACTIVE", 1, null, "2026-08-29T05:55:00.000Z", "INCOMPLETE", "[]", "[]", null, null);
    legacy.prepare("INSERT INTO explorer_turns VALUES (?, ?, ?, ?, ?, ?)").run("legacy-turn", "legacy-default", "user", "历史需求", "2026-08-29T05:45:15.000Z", 1);
    legacy.prepare("INSERT INTO explorer_turns VALUES (?, ?, ?, ?, ?, ?)").run("custom-turn", "legacy-custom", "user", "人工线程", "2026-08-29T05:46:15.000Z", 1);
    legacy.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getThread("legacy-default")).toMatchObject({ createdAt: "2026-08-29T05:45:15.000Z", title: "New Explorer", titleSource: "AUTO", titleStatus: "PLACEHOLDER" });
    expect(reopened.getThread("legacy-custom")).toMatchObject({ createdAt: "2026-08-29T05:46:15.000Z", title: "已有人工名", titleSource: "MANUAL" });
    reopened.close();
  });

  it("persists Explorer creation time and automatic title metadata across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-title-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const explorer = firstStore.saveThread({ id: "explorer-title", projectId: "project-1", parentThreadId: null, createdAt: "2026-08-29T05:45:15.000Z" });
    expect(explorer).toMatchObject({ title: "探索-20260829-13:45:15", createdAt: "2026-08-29T05:45:15.000Z", titleSource: "AUTO", titleStatus: "PLACEHOLDER" });
    firstStore.updateThread({ ...explorer, title: "20260829-13:45:15-订单流程优化", titleStatus: "GENERATED" });
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getThread(explorer.id)).toMatchObject({ title: "20260829-13:45:15-订单流程优化", createdAt: "2026-08-29T05:45:15.000Z", titleSource: "AUTO", titleStatus: "GENERATED" });
    reopened.close();
  });

  it("adds source metadata columns while preserving legacy plan rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-legacy-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE candidate_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_explorer_thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_by TEXT,
      confirmed_at TEXT,
      queued_at TEXT,
      run_id TEXT,
      last_event_at TEXT NOT NULL,
      attention_reason TEXT
    )`);
    legacy.prepare("INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, title, revision, status, created_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-plan", "project-1", "thread-1", "Legacy plan", 1, "DRAFT", "2026-08-29T10:00:00.000Z", "2026-08-29T10:00:00.000Z");
    legacy.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getPlan("legacy-plan")).toMatchObject({ id: "legacy-plan", createdAt: "2026-08-29T10:00:00.000Z", sourceTurnId: null, providerThreadId: null, providerTurnId: null, providerItemId: null });
    reopened.close();
  });

  it("migrates a legacy queued plan into the durable Dispatched stage", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-legacy-dispatched-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE candidate_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_explorer_thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_by TEXT,
      confirmed_at TEXT,
      queued_at TEXT,
      run_id TEXT,
      last_event_at TEXT NOT NULL,
      attention_reason TEXT
    )`);
    legacy.prepare("INSERT INTO candidate_plans (id, project_id, source_explorer_thread_id, title, revision, status, created_at, queued_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-queued", "project-1", "thread-1", "Legacy queued", 1, "QUEUED", "2026-08-29T10:00:00.000Z", "2026-08-29T10:02:00.000Z", "2026-08-29T10:02:00.000Z");
    legacy.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getPlan("legacy-queued")).toMatchObject({ status: "DISPATCHED", queuedAt: "2026-08-29T10:02:00.000Z", dispatchedAt: "2026-08-29T10:02:00.000Z" });
    reopened.close();
  });

  it("restores plans and append-only events after a service restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const firstService = new PlanService(firstStore);
    firstService.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = firstService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Persist me" });
    firstService.confirm(plan.id, "user-1");
    firstService.enqueue(plan.id);
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(new PlanService(reopened).get(plan.id)).toMatchObject({ id: plan.id, status: "ENQUEUED", revision: 1, dispatchedAt: null });
    expect(reopened.listEvents().map((event) => event.type)).toEqual(expect.arrayContaining(["plan.confirmed", "plan.enqueued"]));
    reopened.close();
  });

  it("persists a discarded candidate and its audit event across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-discarded-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const firstService = new PlanService(firstStore);
    firstService.registerThread({ id: "discard-thread", projectId: "project-1", parentThreadId: null });
    const plan = firstService.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "discard-thread", title: "Persist discarded" });
    firstService.discard(plan.id, "user-1");
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(new PlanService(reopened).get(plan.id)).toMatchObject({ id: plan.id, status: "DISCARDED" });
    expect(reopened.listEvents().map((event) => event.type)).toContain("plan.discarded");
    reopened.close();
  });

  it("restores an execution thread journal snapshot after a service restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-runtime-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    const run = { id: "run-1", projectId: "project-1", planId: "plan-1", planRevision: 1, status: "IN_PROGRESS" as const, branch: "factory/run-1", workspacePath: "/tmp/run-1", baseCommit: "abc", executionThreadId: "execution-thread-1", createdAt: new Date().toISOString(), startedAt: new Date().toISOString() };
    firstStore.saveRun(run);
    firstStore.saveExecutionThread({ id: run.executionThreadId, runId: run.id, state: "ACTIVE", journal: [{ sequence: 1, type: "RUN_CREATED", occurredAt: new Date().toISOString(), payload: { planId: run.planId } }] });
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    expect(reopened.getRun(run.id)).toMatchObject({ id: run.id, status: "IN_PROGRESS" });
    expect(reopened.getExecutionThread(run.executionThreadId)?.journal[0]).toMatchObject({ type: "RUN_CREATED", payload: { planId: run.planId } });
    reopened.close();
  });
});

describe("ToolGateway", () => {
  it("denies Explorer writes, commands and commits while allowing read-only tools", async () => {
    const gateway = new ToolGateway({ role: "explorer", workspaceRoot: "/tmp/project" });
    await expect(gateway.call({ callId: randomUUID(), tool: "read_file", input: { path: "README.md" } })).resolves.toMatchObject({ allowed: true });
    await expect(gateway.call({ callId: randomUUID(), tool: "write_file", input: { path: "README.md", content: "nope" } })).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/read.only/i) });
    await expect(gateway.call({ callId: randomUUID(), tool: "run_command", input: { commandId: "test" } })).resolves.toMatchObject({ allowed: false });
    await expect(gateway.call({ callId: randomUUID(), tool: "git_commit", input: { message: "nope" } })).resolves.toMatchObject({ allowed: false });
  });

  it("enforces scoped paths for Executor file access", async () => {
    const gateway = new ToolGateway({ role: "executor", workspaceRoot: "/tmp/project" });
    await expect(gateway.call({ callId: randomUUID(), tool: "write_file", input: { path: "src/index.ts", content: "export {}" } })).resolves.toMatchObject({ allowed: true });
    await expect(gateway.call({ callId: randomUUID(), tool: "write_file", input: { path: "../outside.txt", content: "nope" } })).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/path/i) });
  });

  it("protects secrets, repository internals, lockfiles and project configuration for both roles", async () => {
    for (const role of ["explorer", "executor"] as const) {
      const gateway = new ToolGateway({ role, workspaceRoot: "/tmp/project" });
      for (const path of [".env", ".git/config", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "tsconfig.json"]) {
        await expect(gateway.call({ callId: `${role}-${path}`, tool: "read_file", input: { path } })).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/protected|secret|internals/i) });
      }
    }
  });
});
