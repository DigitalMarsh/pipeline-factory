import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(new PlanService(reopened).get(plan.id)).toMatchObject({ id: plan.id, status: "QUEUED", revision: 1 });
    expect(reopened.listEvents().map((event) => event.type)).toEqual(expect.arrayContaining(["plan.confirmed", "plan.enqueued"]));
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
