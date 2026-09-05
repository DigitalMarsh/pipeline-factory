/**
 * 测试职责：验证 server 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, ProjectService, Scheduler, type AgentLoop, type ModelGateway, type VerificationCommandExecutor } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

function createTestProject(store: InMemoryPipelineStore, id = "project-1") {
  return new ProjectService(store).create({ id, name: id, repoRoot: `/repo/${id}`, defaultBranch: "main", worktreeRoot: `/tmp/${id}-worktrees`, settings: { commands: [{ commandId: "project.test", argv: ["true"] }, { commandId: "project.typecheck", argv: ["true"] }] } });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Pipeline Factory v4 API", () => {
  it("lists Project configuration and summary data", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({ id: "project-1", name: "Demo", repoRoot: "/repo/demo", defaultBranch: "main", worktreeRoot: "/tmp/demo-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: project.id, parentThreadId: null });
    projects.selectExplorer(project.id, "explorer-1");
    const app = createApp({ store, seed: false });
    apps.push(app);

    const list = await app.inject({ method: "GET", url: "/api/v4/projects" });
    const detail = await app.inject({ method: "GET", url: "/api/v4/projects/project-1" });

    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ id: "project-1", name: "Demo", repoRoot: "/repo/demo", status: "ACTIVE" }]);
    expect(list.json().items[0].summary).toMatchObject({ currentExplorerThread: "explorer-1", currentExplorerTitle: expect.any(String), threadCount: 1, runCount: 0 });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().summary).toMatchObject({ threadCount: 1, planCount: 0, runCount: 0, currentExplorerThread: "explorer-1" });
  });

  it("accepts a short name when creating and updating a Project", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-api-short-name-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline-test@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
      const store = new InMemoryPipelineStore();
      const app = createApp({ store, seed: false });
      apps.push(app);

      const created = await app.inject({ method: "POST", url: "/api/v4/projects", payload: { id: "project-short-api", name: "API Project", shortName: "APP", repoRoot, worktreeRoot: join(repoRoot, "worktrees") } });
      expect(created.statusCode).toBe(201);
      expect(created.json().project).toMatchObject({ name: "API Project", shortName: "APP" });

      const updated = await app.inject({ method: "PATCH", url: "/api/v4/projects/project-short-api", payload: { shortName: "API", expectedConfigVersion: 1 } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().project).toMatchObject({ name: "API Project", shortName: "API", configVersion: 2 });

      const reset = await app.inject({ method: "PATCH", url: "/api/v4/projects/project-short-api", payload: { shortName: "", expectedConfigVersion: 2 } });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().project).toMatchObject({ name: "API Project", shortName: "API Project", configVersion: 3 });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("serves only project-scoped Execute snapshots with replayable events", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({ id: "project-workbench", name: "Workbench", repoRoot: "/repo/workbench", defaultBranch: "main", worktreeRoot: "/tmp/workbench-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "workbench-thread", projectId: project.id, parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "workbench-thread", title: "Workbench plan" });
    plans.confirm(plan.id, "user-1");
    const app = createApp({ store, seed: false });
    apps.push(app);

    const global = await app.inject({ method: "GET", url: "/api/v4/workbench" });
    const scoped = await app.inject({ method: "GET", url: `/api/v4/workbench?projectId=${project.id}` });
    const cursor = scoped.json().cursor as number;
    const replay = await app.inject({ method: "GET", url: `/api/v4/workbench/events?projectId=${project.id}&afterSequence=${cursor - 1}` });

    expect(global.statusCode).toBe(400);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({ activeProjectId: project.id, projects: [{ id: project.id }], plans: [{ planId: plan.id, title: "Workbench plan", status: "READY", dispatch: null }] });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().items.at(-1)).toMatchObject({ type: "plan.confirmed", aggregateId: plan.id });
  });

  it("rejects project-scoped requests for an unknown Project", async () => {
    const store = new InMemoryPipelineStore();
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/projects/missing/explorers" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("lists all dispatched plans for a Project across ExplorerThreads", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({ id: "project-plans", name: "Plans", repoRoot: "/repo/plans", defaultBranch: "main", worktreeRoot: "/tmp/plans-worktrees" });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-a", projectId: project.id, parentThreadId: null });
    plans.registerThread({ id: "explorer-b", projectId: project.id, parentThreadId: null });
    const first = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-a", title: "Plan A" });
    const second = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-b", title: "Plan B" });
    plans.confirm(first.id, "user-1");
    plans.enqueue(first.id);
    plans.confirm(second.id, "user-1");
    plans.enqueue(second.id);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/plans` });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { title: string }) => item.title).sort()).toEqual(["Plan A", "Plan B"]);
  });

  it("exposes the active Explorer model in health metadata", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: (role) => ({ model: role === "explorer" ? "gpt-5.6-luna" : "gpt-5.6-luna" }),
      async *stream() { yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", model: "gpt-5.6-luna" });
  });

  it("exposes exact Codex 5-hour and 7-day rate-limit windows", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() { yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
      async readRateLimits() {
        return {
          available: true,
          fiveHour: { remainingPercent: 80, resetAt: "2026-06-17T00:00:00.000Z" },
          sevenDay: { remainingPercent: 45, resetAt: "2026-06-24T00:00:00.000Z" },
          reason: null,
        };
      },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/codex/rate-limits" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rateLimits: {
      available: true,
      fiveHour: { remainingPercent: 80, resetAt: "2026-06-17T00:00:00.000Z" },
      sevenDay: { remainingPercent: 45, resetAt: "2026-06-24T00:00:00.000Z" },
      reason: null,
    } });
  });

  it("exposes an empty MCP capability registry when no servers are configured", async () => {
    const app = createApp({ store: new InMemoryPipelineStore(), seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/mcp/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tools: [] });
  });

  it("exposes persisted Agent Loop state, steps, and event history", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = { id: "loop-1", ownerType: "run", ownerId: "run-1", role: "executor", mode: "provider-controlled", state: "RUNNING", stepCount: 1, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", checkpointJson: null };
    store.saveAgentLoop(loop);
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_STARTED", status: "RUNNING", payload: { step: 1 } });
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "PROVIDER_ACTIVITY", status: "RUNNING", payload: { providerItemId: "provider-item-1", itemId: "activity-1" } });
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "PROVIDER_ACTIVITY", status: "COMPLETED", payload: { providerItemId: "provider-item-1", itemId: "activity-1" } });
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "GATE_CHECKED", status: "COMPLETED", payload: { action: "continue", reason: "PLAN_INCOMPLETE:完整方案缺少验收标准与验证命令" } });
    store.appendEvent({ type: "agent.loop.started", aggregateId: loop.id, payload: { role: loop.role } });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const state = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1" });
    const steps = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/steps" });
    const events = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/events" });

    expect(state.statusCode).toBe(200);
    expect(state.json().loop).toMatchObject({ id: "loop-1", state: "RUNNING", diagnostics: { providerActivityCount: 1, lastGate: { action: "continue" }, terminal: null } });
    expect(steps.json().items).toHaveLength(4);
    expect(events.json().items[0]).toMatchObject({ type: "agent.loop.started", aggregateId: "loop-1" });
    expect(events.json().diagnostics).toMatchObject({ providerActivityCount: 1, lastGate: { action: "continue" }, terminal: null });
  });

  it("replays Run execution journal entries from a requested sequence", async () => {
    const store = new InMemoryPipelineStore();
    store.saveRun({ id: "run-stream", projectId: "project-1", planId: "plan-1", planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-stream", workspacePath: "/tmp/run-stream", baseCommit: "abc", executionThreadId: "execution-stream", createdAt: store.now(), startedAt: store.now() });
    store.saveExecutionThread({ id: "execution-stream", runId: "run-stream", state: "ACTIVE", journal: [
      { sequence: 1, type: "RUN_CREATED", occurredAt: store.now(), payload: { planId: "plan-1" } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: store.now(), payload: { text: "正在执行" } },
    ] });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/runs/run-stream/events?afterSequence=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ sequence: 2, type: "MODEL_OUTPUT", occurredAt: expect.any(String), payload: { text: "正在执行" } }] });

    const replayedFromLastEventId = await app.inject({
      method: "GET",
      url: "/api/v4/runs/run-stream/events?afterSequence=0",
      headers: { "last-event-id": "1" },
    });

    expect(replayedFromLastEventId.statusCode).toBe(200);
    expect(replayedFromLastEventId.json().items).toEqual([{ sequence: 2, type: "MODEL_OUTPUT", occurredAt: expect.any(String), payload: { text: "正在执行" } }]);
  });

  it("maps terminal database errors to safe Agent Loop diagnostics", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = { id: "loop-database-busy", ownerType: "run", ownerId: "run-1", role: "executor", mode: "provider-controlled", state: "FAILED", stepCount: 1, maxSteps: 40, startedAt: store.now(), completedAt: store.now(), providerThreadId: null, providerTurnId: null, checkpointJson: JSON.stringify({ error: "DATABASE_BUSY", detail: "database is locked: secret local detail" }) };
    store.saveAgentLoop(loop);
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_FAILED", status: "FAILED", payload: { error: "DATABASE_BUSY" } });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v4/agent-loops/${loop.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().loop.diagnostics).toEqual({ providerActivityCount: 0, lastGate: null, terminal: { code: "DATABASE_BUSY", message: "数据库写入暂时繁忙" } });
    expect(response.json().loop.checkpointJson).toBeNull();
    expect(JSON.stringify(response.json().loop.diagnostics)).not.toContain("secret local detail");
  });

  it("exposes durable tool-call status for an Agent Loop", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = { id: "loop-tools", ownerType: "run", ownerId: "run-1", role: "executor", mode: "factory-controlled", state: "RUNNING", stepCount: 1, maxSteps: 4, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null };
    store.saveAgentLoop(loop);
    store.saveToolCall({ callId: "tool-1", loopId: loop.id, role: "executor", tool: "mcp:docs:search", status: "RUNNING", inputHash: "hash", result: null, startedAt: store.now(), completedAt: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/agent-loops/" + loop.id + "/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toMatchObject([{ callId: "tool-1", tool: "mcp:docs:search", status: "RUNNING" }]);
  });

  it("makes Agent Loop pause, resume, and cancel controls observable", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = { id: "loop-controls", ownerType: "run", ownerId: "run-1", role: "executor", mode: "provider-controlled", state: "RUNNING", stepCount: 0, maxSteps: 4, startedAt: store.now(), completedAt: null, providerThreadId: "provider-thread", providerTurnId: "provider-turn", checkpointJson: null };
    store.saveAgentLoop(loop);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const paused = await app.inject({ method: "POST", url: `/api/v4/agent-loops/${loop.id}/pause`, payload: { reason: "inspect" } });
    const resumed = await app.inject({ method: "POST", url: `/api/v4/agent-loops/${loop.id}/resume` });
    const cancelled = await app.inject({ method: "POST", url: `/api/v4/agent-loops/${loop.id}/cancel`, payload: { reason: "stop" } });
    const terminalResume = await app.inject({ method: "POST", url: `/api/v4/agent-loops/${loop.id}/resume` });

    expect(paused.json().loop.state).toBe("PAUSED");
    expect(resumed.json().loop.state).toBe("RUNNING");
    expect(cancelled.json().loop.state).toBe("CANCELLED");
    expect(terminalResume.statusCode).toBe(409);
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toEqual(["LOOP_SUSPENDED", "LOOP_RESUMED", "LOOP_COMPLETED"]);
  });

  it("enforces confirm before enqueue and exposes the thread plan projection", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const planService = (await import("@pipeline-factory/domain")).PlanService;
    const plans = new planService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", sourceTurnId: "assistant-1", title: "API plan" });

    const rejected = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    expect(rejected.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    const response = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/plans" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ planId: plan.id, status: "QUEUED", createdAt: plan.createdAt, sourceTurnId: "assistant-1" });
  });

  it("discards a candidate through the API and hides it from candidate endpoints", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const plans = new PlanService(store);
    plans.registerThread({ id: "discard-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "discard-thread", title: "Discard through API" });

    const discarded = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/discard`, payload: { actorId: "user-1" } });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json()).toMatchObject({ plan: { id: plan.id, status: "DISCARDED" } });

    const candidate = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/discard-thread/candidate" });
    expect(candidate.statusCode).toBe(404);
    const confirm = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    expect(confirm.statusCode).toBe(409);
    const enqueue = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    expect(enqueue.statusCode).toBe(409);
    expect(store.listRuns()).toEqual([]);
  });

  it("accepts ExplorerThread turns through the asynchronous v4 API", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });

    const sent = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorer-thread/turns", payload: { threadId: "thread-1", content: "Explore the repository", clientTurnId: "client-1" } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().turn.assistant.status).toBe("RUNNING");
    const turns = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-1" });
    expect(turns.json().items).toHaveLength(2);
  });

  it("returns an observable model failure instead of a successful blank assistant turn", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "turn.failed", error: "Codex turn failed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    createTestProject(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });

    const response = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorer-thread/turns", payload: { threadId: "thread-1", content: "hello", clientTurnId: "client-failure" } });

    expect(response.statusCode).toBe(202);
    for (let attempt = 0; attempt < 50 && store.listTurns("thread-1")[1]?.status !== "FAILED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "FAILED", content: "模型调用失败：Codex turn failed" });
  });

  it("starts a queued plan only through the injected Scheduler", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Start from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ planId: plan.id, status: "IN_PROGRESS" });
  });

  it("routes direct Run requests through the coordinator and returns WAITING when capacity is full", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "coordinator-run-thread", projectId: "project-1", parentThreadId: null });
    const first = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "coordinator-run-thread", title: "First direct run" });
    const second = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "coordinator-run-thread", title: "Second direct run" });
    plans.confirm(first.id, "user-1");
    plans.enqueue(first.id);
    plans.confirm(second.id, "user-1");
    plans.enqueue(second.id);
    const scheduler = new Scheduler({ globalConcurrency: 1, store, workspace: { create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const firstResponse = await app.inject({ method: "POST", url: `/api/v4/plans/${first.id}/run` });
    const secondResponse = await app.inject({ method: "POST", url: `/api/v4/plans/${second.id}/run` });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({ run: null, dispatch: { planId: second.id, status: "WAITING", waitReason: "WAITING_GLOBAL_CAPACITY" } });
  });

  it("automatically dispatches a plan from the v4 enqueue endpoint and exposes its dispatch state", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "auto-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "auto-thread", title: "Automatic API dispatch" });
    plans.confirm(plan.id, "user-1");
    const scheduler = new Scheduler({ store, workspace: { create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const enqueued = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    const fetched = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });

    expect(enqueued.statusCode).toBe(200);
    expect(enqueued.json()).toMatchObject({ plan: { id: plan.id, status: "IN_PROGRESS" }, state: { status: "RUNNING", waitReason: null } });
    expect(fetched.json()).toMatchObject({ dispatch: { planId: plan.id, status: "RUNNING", runId: expect.any(String) } });
  });

  it("creates and approves a ChangeProposal through the v4 API without switching the old Run revision", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store, "project-change");
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-change", projectId: "project-change", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-change", sourceExplorerThreadId: "thread-change", title: "Change API plan" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/change-api", branch: "factory/change-api", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const run = started.json().run as { id: string };
    const contract = { ...plan.contract, include: [...plan.contract.include, "docs/*"] };
    const created = await app.inject({ method: "POST", url: `/api/v4/runs/${run.id}/change-proposals`, payload: { reason: "Documentation is in scope", requestedChanges: ["Include docs"], contract } });
    const approved = await app.inject({ method: "POST", url: `/api/v4/change-proposals/${created.json().proposal.id}/approve`, payload: { actorId: "reviewer" } });

    expect(created.statusCode).toBe(201);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ revision: { revision: 2 }, run: { planRevision: 2 } });
    expect(store.getRun(run.id)?.planRevision).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("NEEDS_PLAN_CHANGE");
  });

  it("verifies a run, opens a merge request, and confirms the reviewed commit", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Review from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const verificationExecutor: VerificationCommandExecutor = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const app = createApp({ store, scheduler, verificationExecutor, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const verified = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/verify` });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verification).toMatchObject({ runId, status: "PASSED" });
    expect(store.getRun(runId)?.status).toBe("MERGE_READY");

    const review = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/merge-request`, payload: { sourceCommit: "abc123" } });
    expect(review.statusCode).toBe(200);
    const mergeRequestId = review.json().mergeRequest.id as string;
    const queried = await app.inject({ method: "GET", url: `/api/v4/merge-requests/${mergeRequestId}` });
    expect(queried.statusCode).toBe(200);
    expect(queried.json().mergeRequest).toMatchObject({ id: mergeRequestId, status: "OPEN" });
    const merged = await app.inject({ method: "POST", url: `/api/v4/merge-requests/${mergeRequestId}/confirm-merged`, payload: { targetCommit: "abc123" } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().mergeRequest.status).toBe("MERGED");
    expect(store.getPlan(plan.id)?.status).toBe("MERGED");
  });

  it("pauses, resumes, and journals bounded user guidance for a run", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Control from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const paused = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/pause` });
    expect(paused.statusCode).toBe(200);
    const guidance = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/guidance`, payload: { content: "Keep the approved scope only" } });
    expect(guidance.statusCode).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().thread.state).toBe("ACTIVE");
    expect(store.getExecutionThread(started.json().run.executionThreadId)?.journal.some((entry) => entry.type === "USER_GUIDANCE")).toBe(true);
  });

  it("terminates a run and synchronizes its Plan status", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Terminate stale run" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    store.saveAgentLoop({ id: "loop-stale", ownerType: "run", ownerId: runId, role: "executor", mode: "provider-controlled", state: "RUNNING", stepCount: 1, maxSteps: 40, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });
    const cancelled = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/cancel`, payload: { reason: "stale_run" } });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({ id: runId, status: "CANCELLED" });
    expect(store.getAgentLoop("loop-stale")).toMatchObject({ state: "CANCELLED" });
    expect(store.getExecutionThread(cancelled.json().run.executionThreadId)?.state).toBe("CANCELLED");
    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Run cancelled: stale_run" });
  });

  it("supports asynchronous v4 turns and structured answers", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    let streamCount = 0;
    const resumeOrder: string[] = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        if (request.conversationId?.startsWith("title-")) {
          yield { type: "text.delta", text: "测试标题" };
          yield { type: "turn.completed" };
          return;
        }
        streamCount += 1;
        if (streamCount === 1) {
          yield { type: "thread.started", threadId: "provider-thread-1" };
          yield { type: "turn.input_required", request: { requestId: "request-1", threadId: "provider-thread-1", turnId: "provider-turn-1", itemId: "item-1", questions: [{ id: "q1", header: "选择", question: "请选择", isOther: true, isSecret: false, options: [{ label: "方案 A", description: "A" }, { label: "方案 B", description: "B" }] }], isBlocking: true, autoResolutionMs: null } };
          resumeOrder.push("stream-resumed");
          yield { type: "text.delta", text: "已记录选择，继续完善。" };
        } else {
          yield { type: "text.delta", text: `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify({ title: "API generated plan", goal: "Complete the requested system design", acceptanceCriteria: ["The approved scope is implemented"], include: ["apps/api"], exclude: ["deploy/*"], baseBranch: "main", baseCommit: "HEAD", tasks: [{ id: "task-1", title: "Implement the approved scope", dependencies: [], status: "READY" }], conflictKeys: [], executorModelRole: "executor", toolPolicy: "executor-scoped-write", verificationCommandIds: ["project.test"], maxRepairAttempts: 2, mergeStrategy: "manual", requireHumanMerge: true })}</pipeline-factory-plan>` };
        }
        yield { type: "turn.completed" };
      },
      async answerUserInput() { resumeOrder.push("answer-called"); },
      async cancel() { undefined; },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    const accepted = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorer-thread/turns", payload: { threadId: "thread-1", content: "继续探索", clientTurnId: "client-1" } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().turn.assistant.status).toBe("RUNNING");
    const turnsWithCursor = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-1" });
    expect(turnsWithCursor.statusCode).toBe(200);
    expect(turnsWithCursor.json().lastEventSequence).toEqual(expect.any(Number));
    let input = store.listInputRequests("thread-1", "OPEN")[0];
    for (let attempt = 0; !input && attempt < 20; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 1)); input = store.listInputRequests("thread-1", "OPEN")[0]; }
    expect(input).toBeDefined();
    const invalid = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`, payload: { clientRequestId: "bad", answers: { q1: { answers: ["方案 X", "方案 A"] } } } });
    expect(invalid.statusCode).toBe(409);
    const answered = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`, payload: { clientRequestId: "answer-1", answers: { q1: { answers: ["方案 A", "方案 B"] } } } });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().request.status).toBe("ANSWERED");
    const duplicate = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`, payload: { clientRequestId: "answer-1", answers: { q1: { answers: ["方案 A", "方案 B"] } } } });
    expect(duplicate.statusCode).toBe(200);
    for (let attempt = 0; attempt < 50 && store.listPlans().length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "COMPLETED", content: "已记录选择，继续完善。" });
    expect(resumeOrder).toEqual(["answer-called", "stream-resumed"]);
    const candidate = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-1/candidate" });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json().plan).toMatchObject({ title: "API generated plan", status: "DRAFT" });
    expect(store.getThread("thread-1")).toMatchObject({ exploration: { status: "READY" } });
    const activity = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-1/activity" });
    expect(activity.statusCode).toBe(200);
    expect(JSON.stringify(activity.json().items)).not.toContain("pipeline-factory-plan");
    expect(activity.json().items.some((item: { details?: { title?: string } | null }) => item.details?.title === "API generated plan")).toBe(true);
  });

  it("creates and lists isolated business Explorers without reusing the old context", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    store.saveThread({ id: "old-explorer", projectId: "project-1", parentThreadId: null, title: "Old exploration", providerThreadId: "provider-old" });
    store.saveTurn({ id: "old-turn", threadId: "old-explorer", role: "user", content: "old plan", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorers", payload: { title: "Fresh requirement" } });
    expect(created.statusCode).toBe(201);
    const fresh = created.json().explorer;
    expect(fresh).toMatchObject({ projectId: "project-1", title: "Fresh requirement", contextMode: "FRESH", providerThreadId: null });
    expect(store.listTurns(fresh.id)).toEqual([]);
    expect(store.getThread("old-explorer")?.state).toBe("ACTIVE");

    const listed = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(fresh.id);
    const archived = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorers/${fresh.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().explorer.state).toBe("ARCHIVED");
    expect(store.listTurns(fresh.id)).toEqual([]);
  });

  it("creates an Explorer with a timestamp placeholder and locks manual renames", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorers" });
    expect(created.statusCode).toBe(201);
    const explorer = created.json().explorer;
    expect(explorer.title).toMatch(/^探索-\d{8}-\d{2}:\d{2}:\d{2}$/);
    expect(explorer).toMatchObject({ titleSource: "AUTO", titleStatus: "PLACEHOLDER" });

    const renamed = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorers/${explorer.id}/rename`, payload: { title: "人工名称" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().explorer).toMatchObject({ title: "人工名称", titleSource: "MANUAL" });
  });

  it("projects Agent Loop steps as ordered Explorer activity items", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    store.saveThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    store.saveTurn({ id: "user-1", threadId: "explorer-1", role: "user", content: "hello", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 });
    store.saveTurn({ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "hello", status: "COMPLETED", createdAt: "2026-08-29T10:00:01.000Z", sequence: 2 });
    store.saveAgentLoop({ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.500Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null });
    store.appendAgentLoopStep({ loopId: "loop-1", stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "hello" }, occurredAt: "2026-08-29T10:00:01.000Z" });
    store.appendAgentLoopStep({ loopId: "loop-1", stepType: "TOOL_REQUESTED", status: "RUNNING", callId: "call-1", payload: { tool: "read_file" }, occurredAt: "2026-08-29T10:00:01.100Z" });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/explorer-1/activity" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { kind: string }) => item.kind)).toEqual(["USER_MESSAGE", "ASSISTANT_MESSAGE", "TOOL_STARTED"]);
  });

  it("exposes the Plan and Run lifecycle only through the v4 API", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "v4-only-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "v4-only-thread", title: "v4-only plan" });
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/v4-only", branch: "factory/v4-only", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const legacyPlan = await app.inject({ method: "GET", url: "/api/" + "v" + "3" + `/plans/${plan.id}` });
    const v4Plan = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });
    const confirmed = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    const enqueued = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const run = await app.inject({ method: "GET", url: `/api/v4/runs/${runId}` });

    expect(legacyPlan.statusCode).toBe(404);
    expect(v4Plan.statusCode).toBe(200);
    expect(confirmed.statusCode).toBe(200);
    expect(enqueued.statusCode).toBe(200);
    expect(started.statusCode).toBe(200);
    expect(run.statusCode).toBe(200);
    expect(run.json().run.id).toBe(runId);
  });
});
