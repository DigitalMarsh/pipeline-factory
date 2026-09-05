/**
 * 测试职责：验证 executor-agent 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutorAgent, inspectWorkspaceScope, parseExecutorReport } from "./executor-agent.js";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, ToolGateway, type AgentLoop, type ModelEvent, type ModelGateway, type ModelRequest } from "./index.js";
import { DurableToolRuntime } from "./tool-runtime.js";

const executionReport = (taskId: string) => `<pipeline-factory-execution-report>${JSON.stringify({
  completedTaskIds: [taskId],
  changedPaths: ["src/implemented.ts"],
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
  plans.dispatch(plan.id);
  const run = { id: "run-1", projectId: "project-1", planId: plan.id, planRevision: 1, status: "IN_PROGRESS" as const, branch: "factory/run-1", workspacePath: "/tmp/project", baseCommit: "abc", executionThreadId: "execution-thread-1", createdAt: store.now(), startedAt: store.now() };
  if (saveRun) {
    store.saveRun(run);
    store.saveExecutionThread({ id: run.executionThreadId, runId: run.id, state: "ACTIVE", journal: [] });
  }
  return { store, plan: store.getRevision(plan.id, 1)!, run };
}

describe("ExecutorAgent", () => {
  it("normalizes provider reports that return changed paths as an array", () => {
    const report = parseExecutorReport(`<pipeline-factory-execution-report>${JSON.stringify({
      completedTaskIds: ["task-1"],
      pathsWithinScope: ["README.md", "docs/guide.md"],
      report: "All work completed",
    })}</pipeline-factory-execution-report>`);

    expect(report).toEqual({
      completedTaskIds: ["task-1"],
      changedPaths: ["README.md", "docs/guide.md"],
      report: "All work completed",
    });
  });

  it("checks the actual Git diff instead of trusting the model scope claim", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-scope-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "Pipeline Test"], { cwd: workspace });
      await writeFile(join(workspace, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace });
      mkdirSync(join(workspace, "docs"));
      await writeFile(join(workspace, "README.md"), "changed\n");
      await writeFile(join(workspace, "docs", "guide.md"), "guide\n");

      await expect(inspectWorkspaceScope({ workspacePath: workspace, baseCommit: "HEAD", include: ["docs"], exclude: [] })).resolves.toEqual({
        changedPaths: ["README.md", "docs/guide.md"],
        outsidePaths: ["README.md"],
        pathsWithinScope: false,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sends the complete approved Plan contract to the executor model", async () => {
    const { store, plan, run } = createQueuedRun();
    let receivedMessages: ModelRequest["messages"] = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        receivedMessages = request.messages;
        yield { type: "text.delta", text: executionReport(plan.contract.tasks[0]!.id) };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    await new ExecutorAgent(store, model).run(run, plan);

    const systemMessage = receivedMessages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("The approved Plan contract is the source of truth");
    expect(systemMessage?.content).toContain("Implement the feature");
    expect(systemMessage?.content).toContain('"id": "task-1"');
  });

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

  it("projects a blocked executor loop onto its execution thread", async () => {
    const { store, plan, run } = createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() { yield { type: "text.delta", text: "not finished" }; yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    await new ExecutorAgent(store, model, undefined, { maxSteps: 1 }).run(run, plan);

    expect(store.getExecutionThread(run.executionThreadId)?.state).toBe("BLOCKED");
  });

  it("injects a durable built-in ToolRuntime for Factory-controlled execution", async () => {
    const { store, plan, run } = createQueuedRun();
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-executor-"));
    run.workspacePath = workspace;
    store.saveRun(run);
    let modelCalls = 0;
    const model: ModelGateway = {
      configFor: () => ({ model: "executor", loopMode: "factory-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: true, supportedLoopModes: ["factory-controlled"] }),
      async *stream() {
        modelCalls += 1;
        if (modelCalls === 1) yield { type: "tool.call", call: { callId: "write-1", tool: "write_file", input: { path: "src/generated.ts", content: "export const generated = true;\n" } } };
        else yield { type: "text.delta", text: executionReport(plan.contract.tasks[0]!.id) };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    try {
      const agent = new ExecutorAgent(store, model, undefined, {
        mode: "factory-controlled",
        toolRuntimeFactory: () => new DurableToolRuntime(store, new ToolGateway({ role: "executor", workspaceRoot: workspace })),
      });
      const loop = await agent.run(run, plan);

      expect(loop.state).toBe("COMPLETED");
      await expect(readFile(join(workspace, "src/generated.ts"), "utf8")).resolves.toContain("generated");
      expect(store.listToolCalls()).toMatchObject([{ callId: "write-1", status: "SUCCEEDED" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
          const latestThread = store.getExecutionThread(run.executionThreadId)!;
          store.saveExecutionThread({
            ...latestThread,
            journal: [...latestThread.journal, { sequence: latestThread.journal.length + 1, type: "TASK_PROGRESS", occurredAt: store.now(), payload: { event: "agent.loop.started" } }],
          });
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
    expect(store.getExecutionThread(run.executionThreadId)?.journal.some((entry) => entry.payload.event === "agent.loop.started")).toBe(true);
  });
});
