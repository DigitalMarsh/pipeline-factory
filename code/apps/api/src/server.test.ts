import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, type AgentLoop, type ModelGateway, type VerificationCommandExecutor } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Pipeline Factory v3 API", () => {
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
    store.appendEvent({ type: "agent.loop.started", aggregateId: loop.id, payload: { role: loop.role } });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const state = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1" });
    const steps = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/steps" });
    const events = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/events" });

    expect(state.statusCode).toBe(200);
    expect(state.json().loop).toMatchObject({ id: "loop-1", state: "RUNNING" });
    expect(steps.json().items).toHaveLength(1);
    expect(events.json().items[0]).toMatchObject({ type: "agent.loop.started", aggregateId: "loop-1" });
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

    expect(paused.json().loop.state).toBe("PAUSED");
    expect(resumed.json().loop.state).toBe("RUNNING");
    expect(cancelled.json().loop.state).toBe("CANCELLED");
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).toEqual(["LOOP_SUSPENDED", "LOOP_RESUMED", "LOOP_COMPLETED"]);
  });

  it("enforces confirm before enqueue and exposes the thread plan projection", async () => {
    const store = new InMemoryPipelineStore();
    const app = createApp({ store, seed: false });
    apps.push(app);
    const planService = (await import("@pipeline-factory/domain")).PlanService;
    const plans = new planService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "API plan" });

    const rejected = await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/enqueue` });
    expect(rejected.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/enqueue` });
    const response = await app.inject({ method: "GET", url: "/api/v3/projects/project-1/explorer-thread/plans" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({ planId: plan.id, status: "QUEUED" });
  });

  it("keeps ExplorerThread turns in the API without granting write tools", async () => {
    const store = new InMemoryPipelineStore();
    const app = createApp({ store, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });

    const sent = await app.inject({ method: "POST", url: "/api/v3/projects/project-1/explorer-thread/turns", payload: { content: "Explore the repository" } });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().turn.assistant.content).toBe("Stub Explorer response");
    const turns = await app.inject({ method: "GET", url: "/api/v3/projects/project-1/explorer-thread/turns" });
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
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });

    const response = await app.inject({ method: "POST", url: "/api/v3/projects/project-1/explorer-thread/turns", payload: { content: "hello" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().turn.assistant).toMatchObject({ status: "FAILED", content: "模型调用失败：Codex turn failed" });
  });

  it("starts a queued plan only through the injected Scheduler", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Start from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/run` });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ planId: plan.id, status: "IN_PROGRESS" });
  });

  it("creates and approves a ChangeProposal through the v4 API without switching the old Run revision", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-change", projectId: "project-change", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-change", sourceExplorerThreadId: "thread-change", title: "Change API plan" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/change-api", branch: "factory/change-api", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/run` });
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
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Review from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const verificationExecutor: VerificationCommandExecutor = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const app = createApp({ store, scheduler, verificationExecutor, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const verified = await app.inject({ method: "POST", url: `/api/v3/runs/${runId}/verify` });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().verification).toMatchObject({ runId, status: "PASSED" });
    expect(store.getRun(runId)?.status).toBe("MERGE_READY");

    const review = await app.inject({ method: "POST", url: `/api/v3/runs/${runId}/merge-request`, payload: { sourceCommit: "abc123" } });
    expect(review.statusCode).toBe(200);
    const mergeRequestId = review.json().mergeRequest.id as string;
    const merged = await app.inject({ method: "POST", url: `/api/v3/merge-requests/${mergeRequestId}/confirm-merged`, payload: { targetCommit: "abc123" } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().mergeRequest.status).toBe("MERGED");
    expect(store.getPlan(plan.id)?.status).toBe("MERGED");
  });

  it("pauses, resumes, and journals bounded user guidance for a run", async () => {
    const store = new InMemoryPipelineStore();
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Control from API" });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({ store, workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined }, hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v3/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const paused = await app.inject({ method: "POST", url: `/api/v3/runs/${runId}/pause` });
    expect(paused.statusCode).toBe(200);
    const guidance = await app.inject({ method: "POST", url: `/api/v3/runs/${runId}/guidance`, payload: { content: "Keep the approved scope only" } });
    expect(guidance.statusCode).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `/api/v3/runs/${runId}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().thread.state).toBe("ACTIVE");
    expect(store.getExecutionThread(started.json().run.executionThreadId)?.journal.some((entry) => entry.type === "USER_GUIDANCE")).toBe(true);
  });

  it("supports asynchronous v4 turns and structured answers without changing v3", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    let streamCount = 0;
    const resumeOrder: string[] = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
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
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
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
    const candidate = await app.inject({ method: "GET", url: "/api/v3/projects/project-1/explorer-thread/candidate" });
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
    store.saveThread({ id: "old-explorer", projectId: "project-1", parentThreadId: null, title: "Old exploration", providerThreadId: "provider-old" });
    store.saveTurn({ id: "old-turn", threadId: "old-explorer", role: "user", content: "old plan", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorers", payload: { title: "Fresh requirement" } });
    expect(created.statusCode).toBe(201);
    const fresh = created.json().explorer;
    expect(fresh).toMatchObject({ projectId: "project-1", title: "Fresh requirement", contextMode: "FRESH", providerThreadId: null });
    expect(store.listTurns(fresh.id)).toEqual([]);

    const listed = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(fresh.id);
    const archived = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorers/${fresh.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().explorer.state).toBe("ARCHIVED");
    expect(store.listTurns(fresh.id)).toEqual([]);
  });

  it("projects Agent Loop steps as ordered Explorer activity items", async () => {
    const store = new InMemoryPipelineStore();
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
});
