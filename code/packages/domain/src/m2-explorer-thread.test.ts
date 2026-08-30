/**
 * 测试职责：验证 m2-explorer-thread 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { ExplorerThreadService, InMemoryPipelineStore, StubModelGateway, assessPlanCompletion, type ExplorerInputRequest, type ModelEvent, type ModelGateway, type ModelRequest } from "./index.js";

describe("ExplorerThread", () => {
  it("requires the explicit complete-plan protocol before marking exploration ready", () => {
    expect(assessPlanCompletion("已记录方案 B，但还需要确认验证方式。")).toMatchObject({ status: "INCOMPLETE", artifact: null });
    expect(assessPlanCompletion("<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad json}</pipeline-factory-plan>")).toMatchObject({ status: "INCOMPLETE", missing: ["完整执行契约"] });
  });

  it("allows only one open blocking input request per thread", () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const request = (id: string): ExplorerInputRequest => ({ id, threadId: "thread-1", localTurnId: "turn-1", providerRequestId: id, providerThreadId: "provider-1", providerTurnId: "turn-1", itemId: id, questions: [{ id: "q1", header: "选择", question: "请选择", isOther: false, isSecret: false, options: [{ label: "A", description: "A" }] }], isBlocking: true, autoResolutionMs: null, status: "OPEN", createdAt: store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null });
    store.saveInputRequest(request("input-1"));
    expect(() => store.saveInputRequest(request("input-2"))).toThrow("open blocking input request");
  });

  it("continues exploring after a turn completes until a complete plan artifact is available", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const requests: ModelRequest[] = [];
    const completeArtifact = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>
<pipeline-factory-plan>${JSON.stringify({
  title: "Personal information manager",
  goal: "Build a local single-user personal information manager",
  acceptanceCriteria: ["User can create and search records", "Data is encrypted at rest"],
  include: ["apps/web", "apps/api"],
  exclude: ["deploy/*"],
  baseBranch: "main",
  baseCommit: "HEAD",
  tasks: [{ id: "task-1", title: "Implement record management", dependencies: [], status: "READY" }],
  conflictKeys: ["project-1:apps"],
  executorModelRole: "executor",
  toolPolicy: "executor-scoped-write",
  verificationCommandIds: ["project.test"],
  maxRepairAttempts: 2,
  mergeStrategy: "manual",
  requireHumanMerge: true,
})}</pipeline-factory-plan>`;
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
    const accepted = await service.startTurn({ threadId: "thread-1", content: "请为个人信息管理系统形成完整设计方案", clientTurnId: "client-turn-complete-plan" });
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

    const service = new ExplorerThreadService(store, model, { maxAutoContinuationTurns: 0 });
    await service.startTurn({ threadId: "thread-1", content: "请继续设计", clientTurnId: "client-turn-incomplete-plan" });
    for (let attempt = 0; attempt < 50 && store.listTurns("thread-1")[1]?.status === "RUNNING"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(store.listPlans()).toHaveLength(0);
    expect(store.getThread("thread-1")).toMatchObject({ exploration: { status: "INCOMPLETE" } });
    expect(store.getThread("thread-1")?.exploration.missing.length).toBeGreaterThan(0);
  });

  it("persists user and assistant turns while keeping one logical thread", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const service = new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "explorer" }, executor: { model: "executor" } }));
    const turn = await service.send("thread-1", "Help me refine the plan");

    expect(turn.assistant.content).toBe("Stub Explorer response");
    expect(store.listTurns("thread-1").map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(store.getThread("thread-1")).toMatchObject({ messageCount: 2, state: "ACTIVE" });
  });

  it("persists an explicit failed assistant turn instead of a blank response", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "turn.failed", error: "Codex rejected the configured model" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    const turn = await new ExplorerThreadService(store, model).send("thread-1", "hello");

    expect(turn.assistant).toMatchObject({
      role: "assistant",
      status: "FAILED",
      error: "Codex rejected the configured model",
      content: "模型调用失败：Codex rejected the configured model",
    });
    expect(store.listTurns("thread-1")[1]?.content).not.toBe("");
    expect(store.listEvents().at(-1)).toMatchObject({ type: "explorer.turn.failed" });
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
            autoResolutionMs: null,
          },
        };
        resumeOrder.push("stream-resumed");
        if (answer?.type === "turn.input_required") yield { type: "text.delta", text: "已收到方案 A" };
        yield { type: "turn.completed" };
      },
      async answerUserInput(input) {
        answer = { type: "turn.input_required", request: { requestId: input.requestId, threadId: "provider-thread-1", turnId: "provider-turn-1", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } };
        resumeOrder.push("answer-called");
      },
      async cancel() { undefined; },
    };

    const service = new ExplorerThreadService(store, model, { maxAutoContinuationTurns: 0 });
    const accepted = await service.startTurn({ threadId: "thread-1", content: "请继续", clientTurnId: "client-turn-1" });
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
    store.saveInputRequest({ id: "input-1", threadId: "thread-1", localTurnId: "turn-2", providerRequestId: "provider-1", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1", itemId: "item-1", questions: [{ id: "q1", header: "方向", question: "选择方案", isOther: false, isSecret: false, options: [{ label: "方案 A", description: "保持兼容" }] }], isBlocking: true, autoResolutionMs: null, status: "OPEN", createdAt: store.now(), answeredAt: null, answeredBy: null, redactedAnswerSummary: null });

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
