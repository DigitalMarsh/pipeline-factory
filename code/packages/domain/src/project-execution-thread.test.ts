/**
 * Tests for the project-scoped long-lived execution conversation.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore, ProjectService, SqlitePipelineStore, type ModelEvent, type ModelGateway, type ModelRequest } from "./index.js";
import { ProjectExecutionThreadService } from "./project-execution-thread.js";

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

function projectStore() {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  projects.create({
    id: "project-execution-test",
    name: "Execution test",
    repoRoot: "/repo/execution-test",
    defaultBranch: "main",
    worktreeRoot: "/tmp/execution-test-worktrees",
    settings: { models: { executor: { model: "gpt-5.6-luna", reasoningEffort: "low" } } },
  });
  return { store, projects };
}

function captureModel(onRequest: (request: ModelRequest) => Promise<void> | void = () => undefined) {
  const requests: ModelRequest[] = [];
  const model: ModelGateway = {
    configFor: () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" }),
    async *stream(request) {
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      await onRequest(request);
      yield { type: "thread.started", threadId: `provider-${request.conversationId}` } satisfies ModelEvent;
      const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "request";
      yield { type: "text.delta", text: `completed: ${lastUserMessage}`, providerThreadId: `provider-${request.conversationId}`, providerTurnId: `turn-${requests.length}`, providerItemId: `item-${requests.length}` } satisfies ModelEvent;
      yield { type: "turn.completed" } satisfies ModelEvent;
    },
    async answerUserInput() { return undefined; },
    async cancel() { return undefined; },
  };
  return { model, requests };
}

describe("ProjectExecutionThreadService", () => {
  it("creates one thread, persists nullable preferences separately from project defaults, and validates options", async () => {
    const { store, projects } = projectStore();
    const { model, requests } = captureModel();
    const service = new ProjectExecutionThreadService(store, model);

    const first = service.get("project-execution-test");
    const reopened = service.get("project-execution-test");
    expect(reopened.thread.id).toBe(first.thread.id);
    expect(store.listEvents().filter((event) => event.type === "project.execution.thread.created")).toHaveLength(1);
    expect(first).toMatchObject({ defaultModel: "gpt-5.6-luna", defaultReasoningEffort: "low" });

    const updated = service.updatePreferences("project-execution-test", { model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(updated).toMatchObject({ modelOverride: "gpt-5.6-sol", reasoningEffortOverride: "high" });
    expect(projects.get("project-execution-test").settings.models.executor).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: "low" });
    expect(new ProjectExecutionThreadService(store, model).get("project-execution-test").thread).toMatchObject({ modelOverride: "gpt-5.6-sol", reasoningEffortOverride: "high" });
    expect(() => service.updatePreferences("project-execution-test", { model: "not-a-model", reasoningEffort: null })).toThrow("PROJECT_EXECUTION_MODEL_INVALID");
    expect(() => service.updatePreferences("project-execution-test", { model: null, reasoningEffort: "super-high" })).toThrow("PROJECT_EXECUTION_REASONING_EFFORT_INVALID");

    projects.update("project-execution-test", { settings: { models: { executor: { model: "gpt-6-sol", reasoningEffort: "medium" } } } });
    service.updatePreferences("project-execution-test", { model: null, reasoningEffort: null });
    expect(service.get("project-execution-test")).toMatchObject({ defaultModel: "gpt-6-sol", defaultReasoningEffort: "medium", thread: { modelOverride: null, reasoningEffortOverride: null } });
    const inheritedTurn = service.submit("project-execution-test", { content: "use the current project default", clientTurnId: "project-default-turn" });
    await waitUntil(() => store.listProjectExecutionMessages(inheritedTurn.thread.id).find((message) => message.id === inheritedTurn.assistant.id)?.status === "COMPLETED");
    expect(requests[0]?.modelConfig).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "medium" });
  });

  it("queues a project's requests in order and reuses the provider thread at the repository root", async () => {
    const { store } = projectStore();
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const { model, requests } = captureModel(async (request) => {
      const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user")?.content;
      if (lastUserMessage === "first request") await firstPaused;
    });
    const service = new ProjectExecutionThreadService(store, model);
    service.updatePreferences("project-execution-test", { model: "gpt-5.6-sol", reasoningEffort: "high" });

    const first = service.submit("project-execution-test", { content: "first request", clientTurnId: "first-client-turn" });
    await waitUntil(() => requests.length === 1);
    const second = service.submit("project-execution-test", { content: "second request", clientTurnId: "second-client-turn" });
    expect(second.assistant.status).toBe("QUEUED");
    expect(service.submit("project-execution-test", { content: "duplicate", clientTurnId: "second-client-turn" }).assistant.id).toBe(second.assistant.id);
    expect(requests).toHaveLength(1);

    releaseFirst();
    await waitUntil(() => store.listProjectExecutionMessages(first.thread.id).find((message) => message.id === second.assistant.id)?.status === "COMPLETED");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ cwd: "/repo/execution-test", modelConfig: { model: "gpt-5.6-sol", reasoningEffort: "high" } });
    expect(requests[0]?.providerThreadId).toBeUndefined();
    expect(requests[1]).toMatchObject({ cwd: "/repo/execution-test", providerThreadId: `provider-${first.thread.id}`, modelConfig: { model: "gpt-5.6-sol", reasoningEffort: "high" } });
    expect(store.listProjectExecutionMessages(first.thread.id).find((message) => message.id === first.assistant.id)).toMatchObject({ status: "COMPLETED", model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(store.listProjectExecutionMessages(first.thread.id).find((message) => message.id === second.assistant.id)).toMatchObject({ status: "COMPLETED", model: "gpt-5.6-sol", reasoningEffort: "high" });
    expect(store.listPlans().filter((plan) => plan.projectId === "project-execution-test")).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it("restores thread preferences, provider identity, ordered messages, and event cursor after a SQLite reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-project-execution-"));
    const databasePath = join(directory, "factory.sqlite");
    const firstStore = new SqlitePipelineStore(databasePath);
    new ProjectService(firstStore).create({ id: "project-execution-sqlite", name: "SQLite execution", repoRoot: "/repo/execution-sqlite", defaultBranch: "main", worktreeRoot: "/tmp/execution-sqlite-worktrees" });
    const { model } = captureModel();
    const firstService = new ProjectExecutionThreadService(firstStore, model);
    const firstThread = firstService.get("project-execution-sqlite").thread;
    firstService.updatePreferences("project-execution-sqlite", { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
    const submitted = firstService.submit("project-execution-sqlite", { content: "persist this turn", clientTurnId: "persisted-turn" });
    await waitUntil(() => firstStore.listProjectExecutionMessages(firstThread.id).find((message) => message.id === submitted.assistant.id)?.status === "COMPLETED");
    const lastSequence = firstStore.getLastEventSequence(firstThread.id);
    firstStore.close();

    const reopened = new SqlitePipelineStore(databasePath);
    const restored = new ProjectExecutionThreadService(reopened, model).get("project-execution-sqlite");
    expect(restored.thread).toMatchObject({ id: firstThread.id, providerThreadId: `provider-${firstThread.id}`, modelOverride: "gpt-5.6-sol", reasoningEffortOverride: "xhigh" });
    expect(restored.messages).toMatchObject([
      { id: submitted.user.id, sequence: 1, role: "user", content: "persist this turn" },
      { id: submitted.assistant.id, sequence: 2, role: "assistant", status: "COMPLETED", content: "completed: persist this turn", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    ]);
    expect(restored.lastEventSequence).toBe(lastSequence);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
