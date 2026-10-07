/**
 * 测试职责：验证 m2-explorer-thread 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExplorerService, ExplorerThreadService, InMemoryPipelineStore, ProjectService, StubModelGateway, assessPlanCompletion, type ExplorerInputRequest, type ModelEvent, type ModelGateway, type ModelRequest } from "./index.js";

const temporaryRepos: string[] = [];
afterAll(() => { for (const repo of temporaryRepos) rmSync(repo, { recursive: true, force: true }); });

/**
 * 建一个**真 Git 仓库**支撑的项目。
 *
 * 为什么需要：当前形状的方案在落库时要 `resolvePlanContract` 拿一条可验证的 Git 基线
 * （`verifiedProjectBaseline` 会跑 `git rev-parse`），所以"能完整跑完一个回合并生成 Plan"
 * 的用例必须有真仓库。V1 扁平合同时代不需要——那条路只把合同原样存下来。
 */
function createGitBackedProject(store: InMemoryPipelineStore, id: string): void {
  const repoRoot = mkdtempSync(join(tmpdir(), `pipeline-${id}-`));
  temporaryRepos.push(repoRoot);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "--allow-empty", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
  new ProjectService(store).create({ id, name: "Project", repoRoot, defaultBranch: "main", worktreeRoot: join(repoRoot, "worktrees") });
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}

/**
 * 一份**当前形状**的完整方案。V1 扁平合同已经不再支持（见 completion.ts 的维护提示 4），
 * 所以 fixture 只能长这样：`objective.context` / `design.risks` / 每个 task 的 `changes`
 * 是 Explorer 门禁额外要求的"细节"字段，缺哪一项都会被判为 INCOMPLETE。
 * `overrides` 用来构造"这一版有问题"的变体（例如重复 task id）。
 */
function planSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    title: "Plan",
    artifact: { mode: "REPOSITORY_FILE", path: "src/feature.ts" },
    objective: { goal: "Build the feature", context: ["现状：仓库里还没有这个入口"], audience: ["开发者"], acceptanceCriteria: ["test passes"], outOfScope: [] },
    design: { technicalConstraints: ["沿用现有路由"], dataSecurity: ["不引入新凭据"], failureHandling: ["失败时保持原行为"], risks: ["回滚：还原这次改动"] },
    scope: { includePaths: ["src/feature.ts"], excludePaths: [".env"] },
    tasks: [{ id: "task-1", title: "Implement", dependencies: [], status: "READY", changes: [{ path: "src/feature.ts", action: "create", detail: "新增入口" }] }],
    dependencies: [],
    conflicts: [],
    execution: { maxRepairAttempts: 1 },
    verification: { mode: "NONE" },
    merge: { strategy: "manual", requireHumanMerge: true },
    ...overrides,
  };
}

/** 一个 READY 的协议块，正文是上面的方案。 */
function readyProtocol(overrides: Record<string, unknown> = {}): string {
  return `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(planSpec(overrides))}</pipeline-factory-plan>`;
}

describe("ExplorerThread", () => {
  it("creates Plan 1 by default and keeps later Plans in the same ExplorerThread", () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const service = new ExplorerService(store);
    const first = service.listPlans(explorer.id);
    const second = service.createPlan(explorer.id);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ordinal: 1, title: "Plan 1 / 待探索", explorerThreadId: explorer.id, projectId: "project-1", messageCount: 0 });
    expect(second).toMatchObject({ ordinal: 2, title: "Plan 2 / 待探索", explorerThreadId: explorer.id, messageCount: 0 });
    expect(service.listPlans(explorer.id).map((plan) => plan.ordinal)).toEqual([1, 2]);
    expect(store.getThread(explorer.id)).toMatchObject({ activeExplorerPlanId: second.id, contextSummary: { openPlanIds: [first[0]?.id, second.id] } });
  });

  it("runs separate requirements concurrently while keeping turns within each requirement serial", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const plan1 = new ExplorerService(store).listPlans(explorer.id)[0]!;
    const plan2 = new ExplorerService(store).createPlan(explorer.id);
    const requests: ModelRequest[] = [];
    let releasePlan1!: () => void;
    let releasePlan2!: () => void;
    const plan1Paused = new Promise<void>((resolve) => { releasePlan1 = resolve; });
    const plan2Paused = new Promise<void>((resolve) => { releasePlan2 = resolve; });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        const requestNumber = requests.length;
        yield { type: "thread.started", threadId: `provider-${request.conversationId}` };
        if (request.continuationPrompt?.includes("Plan 1 first request")) await plan1Paused;
        if (request.continuationPrompt?.includes("Plan 2 request")) await plan2Paused;
        yield { type: "text.delta", text: `${request.conversationId} response ${requestNumber}`, providerThreadId: `provider-${request.conversationId}`, providerTurnId: `provider-turn-${requestNumber}`, providerItemId: `provider-item-${requestNumber}` };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const service = new ExplorerThreadService(store, model, { maxSteps: 1, repositoryContextForProject: () => ({ key: "repository-v1", summary: "shared repository facts: apps/web, apps/api" }) });
    const firstTurn = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan1.id, content: "Plan 1 first request", clientTurnId: "client-plan-1" });
    await waitUntil(() => requests.length === 1);
    const samePlanQueued = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan1.id, content: "Plan 1 follow-up", clientTurnId: "client-plan-1-follow-up" });
    const concurrent = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan2.id, content: "Plan 2 request", clientTurnId: "client-plan-2" });

    expect(samePlanQueued.assistant).toMatchObject({ status: "QUEUED", explorerPlanId: plan1.id });
    expect(concurrent.assistant).toMatchObject({ status: "RUNNING", explorerPlanId: plan2.id });
    await waitUntil(() => requests.length === 2);
    expect(new Set(requests.map((request) => request.conversationId))).toEqual(new Set([plan1.id, plan2.id]));
    expect(requests.some((request) => request.continuationPrompt?.includes("Plan 1 follow-up"))).toBe(false);
    expect(store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === plan1.id)).toHaveLength(4);
    expect(store.listTurns(explorer.id).filter((turn) => turn.explorerPlanId === plan2.id)).toHaveLength(2);
    releasePlan2();
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === concurrent.assistant.id)?.status === "COMPLETED");
    expect(store.listTurns(explorer.id).find((turn) => turn.id === firstTurn.assistant.id)?.status).toBe("RUNNING");
    expect(requests).toHaveLength(2);
    releasePlan1();
    await waitUntil(() => requests.length === 3);
    const plan2Request = requests.find((request) => request.continuationPrompt?.includes("Plan 2 request"));
    const plan1FollowupRequest = requests.find((request) => request.continuationPrompt?.includes("Plan 1 follow-up"));
    expect(requests[0]).toMatchObject({ conversationId: plan1.id });
    expect(requests[0]?.messages.map((message) => message.content)).toEqual(["Plan 1 first request"]);
    expect(requests[0]?.continuationPrompt).toContain("shared repository facts");
    expect(plan2Request).toMatchObject({ conversationId: plan2.id });
    expect(plan2Request?.providerThreadId).toBeUndefined();
    expect(plan2Request?.messages.map((message) => message.content)).toEqual(["Plan 2 request"]);
    expect(plan2Request?.continuationPrompt).toContain("shared repository facts");
    expect(plan1FollowupRequest).toMatchObject({ conversationId: plan1.id, providerThreadId: `provider-${plan1.id}` });
    expect(plan1FollowupRequest?.messages.map((message) => message.content)).toEqual(["Plan 1 first request", expect.stringContaining("response"), "Plan 1 follow-up"]);
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === samePlanQueued.assistant.id)?.status === "COMPLETED");
    expect(store.listTurns(explorer.id).find((turn) => turn.id === firstTurn.assistant.id)).toMatchObject({ status: "COMPLETED", explorerPlanId: plan1.id });
    expect(store.getExplorerPlan(plan1.id)?.providerThreadId).toBe(`provider-${plan1.id}`);
    expect(store.getExplorerPlan(plan2.id)?.providerThreadId).toBe(`provider-${plan2.id}`);
    expect(store.getExplorerPlan(plan1.id)?.providerThreadId).not.toBe(store.getExplorerPlan(plan2.id)?.providerThreadId);
    expect(store.getExplorerPlan(plan1.id)?.repositoryContextKey).toBe("repository-v1");
    expect(store.getExplorerPlan(plan2.id)?.repositoryContextKey).toBe("repository-v1");
  });

  it("cleans up a synchronous requirement start failure without blocking a sibling", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const plans = new ExplorerService(store);
    const firstPlan = plans.listPlans(explorer.id)[0]!;
    const secondPlan = plans.createPlan(explorer.id);
    let shouldFail = true;
    const service = new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "gpt-5.6-luna" }, executor: { model: "gpt-5.6-luna" } }), {
      repositoryContextForProject: () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Repository index unavailable");
        }
        return undefined;
      },
    });

    const first = await service.startTurn({ threadId: explorer.id, explorerPlanId: firstPlan.id, content: "first requirement", clientTurnId: "sync-failure-first" });
    const second = await service.startTurn({ threadId: explorer.id, explorerPlanId: secondPlan.id, content: "second requirement", clientTurnId: "sync-failure-second" });

    expect(first.assistant).toMatchObject({ status: "FAILED", error: "Repository index unavailable" });
    expect(second.assistant.status).toBe("RUNNING");
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === second.assistant.id)?.status === "COMPLETED");
    expect(store.getExplorerPlan(firstPlan.id)?.runtimeStatus).toBe("FAILED");
    expect(store.getExplorerPlan(secondPlan.id)?.runtimeStatus).toBe("COMPLETED");
  });

  it("routes simultaneous structured input answers to the matching requirement turn", async () => {
    const store = new InMemoryPipelineStore();
    createGitBackedProject(store, "project-1");
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const plan1 = store.listExplorerPlans(explorer.id)[0]!;
    const plan2 = new ExplorerService(store).createPlan(explorer.id);
    const resumeByRequestId = new Map<string, () => void>();
    const answerCalls: string[] = [];
    const readyResponse = readyProtocol({ title: "Input isolated plan", objective: { goal: "Complete a requirement after its own structured input", context: ["现状：这个需求还没成型"], audience: ["开发者"], acceptanceCriteria: ["The selected requirement completes independently"], outOfScope: [] }, tasks: [{ id: "task-input", title: "Complete requirement", dependencies: [], status: "READY", changes: [{ path: "src/feature.ts", action: "create", detail: "新增入口" }] }] });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        const inputId = `input-${request.conversationId}`;
        const providerThreadId = `provider-${request.conversationId}`;
        const inputAnswered = new Promise<void>((resolve) => { resumeByRequestId.set(inputId, resolve); });
        yield { type: "thread.started", threadId: providerThreadId };
        yield { type: "turn.input_required", request: { requestId: inputId, threadId: providerThreadId, turnId: `provider-turn-${request.conversationId}`, itemId: `item-${inputId}`, questions: [{ id: "q1", header: "方向", question: "请选择", isOther: false, isSecret: false, options: [{ label: "继续", description: "继续当前需求" }] }], isBlocking: true } };
        await inputAnswered;
        yield { type: "text.delta", text: readyResponse };
        yield { type: "turn.completed" };
      },
      async answerUserInput(input) {
        answerCalls.push(String(input.requestId));
        resumeByRequestId.get(String(input.requestId))?.();
      },
      async cancel() { return undefined; },
    };
    const service = new ExplorerThreadService(store, model, { maxSteps: 1 });
    const first = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan1.id, content: "question 1", clientTurnId: "input-client-1" });
    const second = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan2.id, content: "question 2", clientTurnId: "input-client-2" });
    await waitUntil(() => store.listInputRequests(explorer.id, "OPEN").length === 2);
    const requests = store.listInputRequests(explorer.id, "OPEN");
    const firstRequest = requests.find((request) => request.explorerPlanId === plan1.id)!;
    const secondRequest = requests.find((request) => request.explorerPlanId === plan2.id)!;

    const answeredSecond = await service.answerInput({ threadId: explorer.id, requestId: secondRequest.id, answers: { q1: { answers: ["继续"] } }, clientRequestId: "input-answer-2", actorId: "local-user" });
    expect(answeredSecond.turn.id).toBe(second.assistant.id);
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === second.assistant.id)?.status === "COMPLETED");
    expect(store.getInputRequest(firstRequest.id)?.status).toBe("OPEN");
    expect(store.listTurns(explorer.id).find((turn) => turn.id === first.assistant.id)?.status).toBe("WAITING_FOR_INPUT");

    const answeredFirst = await service.answerInput({ threadId: explorer.id, requestId: firstRequest.id, answers: { q1: { answers: ["继续"] } }, clientRequestId: "input-answer-1", actorId: "local-user" });
    expect(answeredFirst.turn.id).toBe(first.assistant.id);
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === first.assistant.id)?.status === "COMPLETED");
    expect(answerCalls).toEqual([`input-${plan2.id}`, `input-${plan1.id}`]);
  });

  it("isolates cancellation and provider failure while a third requirement completes", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const [plan1] = store.listExplorerPlans(explorer.id);
    const plan2 = new ExplorerService(store).createPlan(explorer.id);
    const plan3 = new ExplorerService(store).createPlan(explorer.id);
    let releaseCancellation!: () => void;
    let releaseFailure!: () => void;
    const cancellationGate = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const statusEvents: Array<{ payload: Record<string, unknown> }> = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        const conversationId = request.conversationId!;
        if (conversationId === plan1!.id) {
          yield { type: "thread.started", threadId: "provider-cancel-me" };
          yield { type: "text.delta", text: "partial work", providerThreadId: "provider-cancel-me", providerTurnId: "turn-cancel-me" };
          await cancellationGate;
          return;
        }
        if (conversationId === plan2.id) {
          yield { type: "thread.started", threadId: "provider-fail-me" };
          await failureGate;
          throw new Error("provider rejected this requirement");
        }
        yield { type: "thread.started", threadId: "provider-finish-me" };
        yield { type: "text.delta", text: "independent completed response", providerThreadId: "provider-finish-me", providerTurnId: "turn-finish-me" };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { releaseCancellation(); },
    };
    const service = new ExplorerThreadService(store, model, { maxSteps: 1 });
    service.subscribeEvents(explorer.id, (event) => { if (event.type === "explorer.requirement.status.changed") statusEvents.push({ payload: event.payload }); });
    const first = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan1!.id, content: "cancel this", clientTurnId: "isolated-cancel-1" });
    const second = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan2.id, content: "fail this", clientTurnId: "isolated-fail-2" });
    const third = await service.startTurn({ threadId: explorer.id, explorerPlanId: plan3.id, content: "finish this", clientTurnId: "isolated-finish-3" });
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === third.assistant.id)?.status === "COMPLETED");
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === first.assistant.id)?.content.includes("partial work") === true);
    expect(store.listTurns(explorer.id).find((turn) => turn.id === first.assistant.id)?.status).toBe("RUNNING");
    expect(store.listTurns(explorer.id).find((turn) => turn.id === second.assistant.id)?.status).toBe("RUNNING");

    await service.cancelTurn({ threadId: explorer.id, turnId: first.assistant.id, reason: "user_cancelled" });
    expect(store.listTurns(explorer.id).find((turn) => turn.id === first.assistant.id)).toMatchObject({ status: "CANCELLED", explorerPlanId: plan1!.id });
    expect(store.listTurns(explorer.id).find((turn) => turn.id === second.assistant.id)?.status).toBe("RUNNING");
    expect(store.listTurns(explorer.id).find((turn) => turn.id === third.assistant.id)?.status).toBe("COMPLETED");

    releaseFailure();
    await waitUntil(() => store.listTurns(explorer.id).find((turn) => turn.id === second.assistant.id)?.status === "FAILED");
    expect(store.getExplorerPlan(plan1!.id)?.runtimeStatus).toBe("CANCELLED");
    expect(store.getExplorerPlan(plan2.id)?.runtimeStatus).toBe("FAILED");
    expect(store.getExplorerPlan(plan3.id)?.runtimeStatus).toBe("COMPLETED");
    for (const event of statusEvents) {
      expect(Object.keys(event.payload).sort()).toEqual(["explorerPlanId", "occurredAt", "status", "turnId"]);
      expect(JSON.stringify(event.payload)).not.toContain("cancel this");
      expect(JSON.stringify(event.payload)).not.toContain("independent completed response");
    }
  });

  it("recovers queued turns concurrently by requirement while preserving each requirement's FIFO", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1" });
    const plan1 = store.listExplorerPlans(explorer.id)[0]!;
    const plan2 = new ExplorerService(store).createPlan(explorer.id);
    const createdAt = store.now();
    store.saveTurn({ id: "queued-user-1", threadId: explorer.id, role: "user", content: "first requirement turn", status: "COMPLETED", createdAt, sequence: 1, explorerPlanId: plan1.id });
    store.saveTurn({ id: "queued-assistant-1", threadId: explorer.id, role: "assistant", content: "", status: "QUEUED", createdAt, sequence: 2, explorerPlanId: plan1.id });
    store.saveTurn({ id: "queued-user-2", threadId: explorer.id, role: "user", content: "second requirement turn", status: "COMPLETED", createdAt, sequence: 3, explorerPlanId: plan1.id });
    store.saveTurn({ id: "queued-assistant-2", threadId: explorer.id, role: "assistant", content: "", status: "QUEUED", createdAt, sequence: 4, explorerPlanId: plan1.id });
    store.saveTurn({ id: "queued-user-3", threadId: explorer.id, role: "user", content: "parallel requirement turn", status: "COMPLETED", createdAt, sequence: 5, explorerPlanId: plan2.id });
    store.saveTurn({ id: "queued-assistant-3", threadId: explorer.id, role: "assistant", content: "", status: "QUEUED", createdAt, sequence: 6, explorerPlanId: plan2.id });
    const requests: ModelRequest[] = [];
    let releasePlan1!: () => void;
    let releasePlan2!: () => void;
    const plan1Gate = new Promise<void>((resolve) => { releasePlan1 = resolve; });
    const plan2Gate = new Promise<void>((resolve) => { releasePlan2 = resolve; });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        requests.push(request);
        yield { type: "thread.started", threadId: `provider-${request.conversationId}` };
        if (request.conversationId === plan1.id && request.messages.some((message) => message.content === "first requirement turn")) await plan1Gate;
        if (request.conversationId === plan2.id) await plan2Gate;
        yield { type: "text.delta", text: `recovered ${request.conversationId}` };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const service = new ExplorerThreadService(store, model, { maxSteps: 1 });
    await service.recoverQueuedTurns();
    await waitUntil(() => requests.length === 2);
    expect(requests.some((request) => request.conversationId === plan1.id && request.messages.some((message) => message.content === "second requirement turn"))).toBe(false);
    expect(requests.some((request) => request.conversationId === plan2.id)).toBe(true);
    releasePlan2();
    releasePlan1();
    await waitUntil(() => store.listTurns(explorer.id).filter((turn) => turn.role === "assistant").every((turn) => turn.status === "COMPLETED"));
    expect(requests.find((request) => request.messages.some((message) => message.content === "second requirement turn"))?.conversationId).toBe(plan1.id);
  });

  it("requires the explicit complete-plan protocol before marking exploration ready", () => {
    expect(assessPlanCompletion("已记录方案 B，但还需要确认验证方式。")).toMatchObject({ status: "INCOMPLETE", artifact: null });
    expect(assessPlanCompletion("<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad json}</pipeline-factory-plan>")).toMatchObject({ status: "INCOMPLETE", missing: ["完整执行契约"] });
  });

  it("allows concurrent blocking input requests across requirements but only one per turn", () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const request = (id: string, localTurnId: string): ExplorerInputRequest => ({ id, threadId: "thread-1", localTurnId, providerRequestId: id, providerThreadId: `provider-${id}`, providerTurnId: `turn-${localTurnId}`, itemId: id, questions: [{ id: "q1", header: "选择", question: "请选择", isOther: false, isSecret: false, options: [{ label: "A", description: "A" }] }], isBlocking: true, status: "OPEN", createdAt: store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null });
    store.saveInputRequest(request("input-1", "turn-1"));
    expect(store.saveInputRequest(request("input-2", "turn-2"))).toMatchObject({ id: "input-2" });
    expect(() => store.saveInputRequest(request("input-3", "turn-1"))).toThrow("open blocking input request");
  });

  it("uses the latest valid READY protocol block instead of an earlier invalid block", () => {
    const content = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad json}</pipeline-factory-plan>\n后来补全了方案：\n${readyProtocol()}`;

    expect(assessPlanCompletion(content)).toMatchObject({ status: "READY", artifact: { title: "Plan" } });
  });

  it("rejects duplicate task IDs before creating a CandidatePlan", () => {
    const artifact = JSON.stringify(planSpec({ tasks: [{ id: "task-1", title: "One", dependencies: [], status: "READY", changes: [{ path: "src/feature.ts", action: "create", detail: "新增入口" }] }, { id: "task-1", title: "Duplicate", dependencies: [], status: "READY", changes: [{ path: "src/feature.ts", action: "modify", detail: "改同一个文件" }] }] }));

    expect(assessPlanCompletion(`<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${artifact}</pipeline-factory-plan>`)).toMatchObject({ status: "INCOMPLETE", artifact: null, missing: expect.arrayContaining(["实施任务、依赖与冲突"]) });
  });

  it("continues exploring after a turn completes until a complete plan artifact is available", async () => {
    const store = new InMemoryPipelineStore();
    createGitBackedProject(store, "project-1");
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const requests: ModelRequest[] = [];
    const completeArtifact = readyProtocol({
      title: "Personal information manager",
      artifact: { mode: "CONVERSATION" },
      objective: { goal: "Build a local single-user personal information manager", context: ["现状：还没有可用的记录管理"], audience: ["单个本地用户"], acceptanceCriteria: ["User can create and search records", "Data is encrypted at rest"], outOfScope: ["多用户协作"] },
      design: { technicalConstraints: ["本地单用户"], dataSecurity: ["Data is encrypted at rest"], failureHandling: ["写入失败时回滚本次改动"], risks: ["回滚：还原这次改动"] },
      scope: { includePaths: [], excludePaths: [] },
      tasks: [{ id: "task-1", title: "Implement record management", dependencies: [], status: "READY", changes: [{ path: "apps/api/records.ts", action: "create", detail: "新增记录接口" }] }],
      conflicts: ["project-1:apps"],
      execution: { maxRepairAttempts: 2 },
    });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text.delta", text: "已记录这个选择，但设计还需要继续确认。" };
        } else {
          yield { type: "text.delta", text: completeArtifact, providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", providerItemId: "item-plan-1" };
        }
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    const service = new ExplorerThreadService(store, model, { maxAutoContinuationTurns: 2 });
    const accepted = await service.startTurn({ threadId: "thread-1", explorerPlanId: store.listExplorerPlans("thread-1")[0]!.id, content: "请为个人信息管理系统形成完整设计方案", clientTurnId: "client-turn-complete-plan" });
    for (let attempt = 0; attempt < 50 && store.listPlans().length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.continuationPrompt).toContain("继续完善");
    expect(store.listPlans()).toHaveLength(1);
    expect(store.listPlans()[0]).toMatchObject({ title: "Personal information manager", status: "DRAFT", sourceExplorerThreadId: "thread-1", sourceTurnId: accepted.assistant.id, providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", providerItemId: "item-plan-1" });
    expect(store.getThread("thread-1")).toMatchObject({ exploration: { status: "READY", missing: [], candidatePlanId: store.listPlans()[0]?.id }, messageCount: 2 });
    expect(store.listTurns("thread-1")[1]).toMatchObject({ id: accepted.assistant.id, status: "COMPLETED" });
    expect(store.listTurns("thread-1")[1]?.content).not.toContain("pipeline-factory-plan");
    expect(store.listEvents().some((event) => event.type === "explorer.plan.ready")).toBe(true);
  });

  it("keeps the thread incomplete when the model does not produce a complete artifact", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "text.delta", text: "已记录：采用方案 B。" };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    const service = new ExplorerThreadService(store, model, { maxSteps: 1 });
    await service.startTurn({ threadId: "thread-1", explorerPlanId: store.listExplorerPlans("thread-1")[0]!.id, content: "请继续设计", clientTurnId: "client-turn-incomplete-plan" });
    for (let attempt = 0; attempt < 50 && store.listTurns("thread-1")[1]?.status === "RUNNING"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(store.listPlans()).toHaveLength(0);
    expect(store.getThread("thread-1")).toMatchObject({ exploration: { status: "INCOMPLETE" } });
    expect(store.getThread("thread-1")?.exploration.missing.length).toBeGreaterThan(0);
  });

  it("returns immediately, persists a structured input request, and resumes the same turn after answering", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    let answer: ModelEvent | undefined;
    const resumeOrder: string[] = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "thread.started", threadId: "provider-thread-1" };
        yield {
          type: "turn.input_required",
          request: {
            requestId: "provider-request-1",
            threadId: "provider-thread-1",
            turnId: "provider-turn-1",
            itemId: "item-1",
            questions: [
              { id: "q1", header: "方向", question: "选择方案", isOther: false, isSecret: false, options: [{ label: "方案 A", description: "保持兼容" }] },
              { id: "secret", header: "密钥", question: "请输入密钥", isOther: true, isSecret: true, options: null },
            ],
            isBlocking: true,
          },
        };
        resumeOrder.push("stream-resumed");
        if (answer?.type === "turn.input_required") yield { type: "text.delta", text: "已收到方案 A" };
        yield { type: "turn.completed" };
      },
      async answerUserInput(input) {
        answer = { type: "turn.input_required", request: { requestId: input.requestId, threadId: "provider-thread-1", turnId: "provider-turn-1", itemId: "item-1", questions: [], isBlocking: true } };
        resumeOrder.push("answer-called");
      },
      async cancel() { undefined; },
    };

    const service = new ExplorerThreadService(store, model, { maxSteps: 1 });
    const accepted = await service.startTurn({ threadId: "thread-1", explorerPlanId: store.listExplorerPlans("thread-1")[0]!.id, content: "请继续", clientTurnId: "client-turn-1" });
    expect(accepted.assistant.status).toBe("RUNNING");
    const request = await new Promise<ReturnType<typeof store.listInputRequests>[number]>((resolve) => {
      const timer = setInterval(() => {
        const current = store.listInputRequests("thread-1", "OPEN")[0];
        if (current) { clearInterval(timer); resolve(current); }
      }, 1);
    });
    const answered = await service.answerInput({ threadId: "thread-1", requestId: request.id, answers: { q1: { answers: ["方案 A"] }, secret: { answers: ["do-not-display"] } }, clientRequestId: "answer-1", actorId: "local-user" });
    expect(answered.request.status).toBe("ANSWERED");
    expect(answered.request.redactedAnswerSummary).toEqual({ q1: { answerCount: 1, secret: false, answers: ["方案 A"] }, secret: { answerCount: 1, secret: true } });
    expect(JSON.stringify(answered.request.redactedAnswerSummary)).not.toContain("do-not-display");
    for (let attempt = 0; attempt < 100 && store.listTurns("thread-1")[1]?.status !== "COMPLETED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(resumeOrder).toEqual(["answer-called", "stream-resumed"]);
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "COMPLETED", content: "已收到方案 A" });
  });

  it("fails closed after restart and leaves a visible recovery record without blocking new turns", () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    store.saveTurn({ id: "turn-1", threadId: "thread-1", role: "user", content: "请探索", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    store.saveTurn({ id: "turn-2", threadId: "thread-1", role: "assistant", content: "", status: "WAITING_FOR_INPUT", createdAt: store.now(), sequence: 2 });
    store.updateThread({ ...store.getThread("thread-1")!, state: "WAITING_FOR_INPUT" });
    store.saveInputRequest({ id: "input-1", threadId: "thread-1", localTurnId: "turn-2", providerRequestId: "provider-1", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", itemId: "item-1", questions: [{ id: "q1", header: "方向", question: "选择方案", isOther: false, isSecret: false, options: [{ label: "方案 A", description: "保持兼容" }] }], isBlocking: true, status: "OPEN", createdAt: store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null });

    new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "explorer" }, executor: { model: "executor" } }));

    expect(store.getInputRequest("input-1")).toMatchObject({ status: "RECOVERY_REQUIRED" });
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "FAILED", error: "STRUCTURED_INPUT_RECOVERY_REQUIRED" });
    expect(store.getThread("thread-1")).toMatchObject({ state: "ACTIVE" });
  });

  it("fails an orphaned running turn after restart so the thread can accept a new turn", () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    store.saveTurn({ id: "turn-1", threadId: "thread-1", role: "user", content: "请继续探索", status: "COMPLETED", createdAt: store.now(), sequence: 1 });
    store.saveTurn({ id: "turn-2", threadId: "thread-1", role: "assistant", content: "已开始分析", status: "RUNNING", createdAt: store.now(), sequence: 2 });

    new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "explorer" }, executor: { model: "executor" } }));

    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "FAILED", error: "EXPLORER_TURN_RECOVERY_REQUIRED" });
    expect(store.getThread("thread-1")).toMatchObject({ state: "ACTIVE" });
  });
});
