import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, type ModelGateway, type VerificationCommandExecutor } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Pipeline Factory v3 API", () => {
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
});
