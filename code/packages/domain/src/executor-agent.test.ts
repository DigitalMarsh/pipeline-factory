import { describe, expect, it } from "vitest";
import { ExecutorAgent } from "./executor-agent.js";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, ToolGateway, type AgentLoop, type ModelEvent, type ModelGateway, type ModelRequest } from "./index.js";
import { DurableToolRuntime } from "./tool-runtime.js";

const executionReport = (taskId: string) => `<pipeline-factory-execution-report>${JSON.stringify({
  completedTaskIds: [taskId],
  pathsWithinScope: true,
  report: "Task completed with verification-ready evidence",
})}</pipeline-factory-execution-report>`;

function createQueuedRun(saveRun = true) {
  const store = new InMemoryPipelineStore();
  const plans = new PlanService(store);
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Executor plan", contract: {
    goal: "Implement the feature",
    acceptanceCriteria: ["The feature works"],
    include: ["src"],
    exclude: [".env"],
    baseBranch: "main",
    baseCommit: "abc",
    tasks: [{ id: "task-1", title: "Implement the feature", dependencies: [], status: "READY" }],
    conflictKeys: [],
    executorModelRole: "executor",
    toolPolicy: "executor-scoped-write",
    verificationCommandIds: ["project.test"],
    maxRepairAttempts: 1,
    mergeStrategy: "manual",
    requireHumanMerge: true,
  } });
  plans.confirm(plan.id, "user-1");
  plans.enqueue(plan.id);
  const run = { id: "run-1", projectId: "project-1", planId: plan.id, planRevision: 1, status: "IN_PROGRESS" as const, branch: "factory/run-1", workspacePath: "/tmp/project", baseCommit: "abc", executionThreadId: "execution-thread-1", createdAt: store.now(), startedAt: store.now() };
  if (saveRun) {
    store.saveRun(run);
    store.saveExecutionThread({ id: run.executionThreadId, runId: run.id, state: "ACTIVE", journal: [] });
  }
  return { store, plan: store.getRevision(plan.id, 1)!, run };
}

describe("ExecutorAgent", () => {
  it("runs the executor loop and only becomes ready for verification after the task gate passes", async () => {
    const { store, plan, run } = createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        expect(request.role).toBe("executor");
        yield { type: "text.delta", text: executionReport(plan.contract.tasks[0]!.id) };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const gateway = new ToolGateway({ role: "executor", workspaceRoot: run.workspacePath!, registeredCommandIds: new Set(["project.test"]) });
    const agent = new ExecutorAgent(store, model, new DurableToolRuntime(store, gateway));

    const loop = await agent.run(run, plan);

    expect(loop.state).toBe("COMPLETED");
    expect(store.getRun(run.id)?.status).toBe("READY_FOR_VERIFY");
    expect(store.getExecutionThread(run.executionThreadId)?.journal.map((entry) => entry.type)).toEqual(expect.arrayContaining(["MODEL_OUTPUT", "TASK_PROGRESS"]));
  });

  it("does not treat a model completion message as task completion", async () => {
    const { store, plan, run } = createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() { yield { type: "text.delta", text: "已完成，请进入验证" }; yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };
    const agent = new ExecutorAgent(store, model);

    const loop = await agent.run(run, plan);

    expect(loop.state).toBe("BLOCKED");
    expect(store.getRun(run.id)?.status).toBe("BLOCKED");
    expect(store.getRun(run.id)?.status).not.toBe("READY_FOR_VERIFY");
  });

  it("starts the Executor Loop only after the workspace and start hook succeed", async () => {
    const { store, plan } = createQueuedRun(false);
    const order: string[] = [];
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => { order.push("worktree.add"); return { path: "/tmp/project", branch: "factory/run-2", baseCommit: "abc" }; },
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async (command) => { order.push(command.commandId); return { exitCode: 0, stdout: "", stderr: "" }; }),
      executor: {
        start: async (run, revision) => {
          order.push("executor.start");
          expect(run.workspacePath).toBe("/tmp/project");
          expect(revision.planId).toBe(plan.planId);
          return { id: "loop-1", ownerType: "run", ownerId: run.id, role: "executor", mode: "provider-controlled", state: "CREATED", stepCount: 0, maxSteps: 40, startedAt: null, completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null } satisfies AgentLoop;
        },
      },
    });

    const run = await scheduler.start(plan.planId, { start: { commandId: "project.start" } });

    expect(run.status).toBe("IN_PROGRESS");
    expect(order).toEqual(["worktree.add", "project.start", "executor.start"]);
    expect(store.listEvents().some((event) => event.type === "run.executor.event")).toBe(true);
  });
});
