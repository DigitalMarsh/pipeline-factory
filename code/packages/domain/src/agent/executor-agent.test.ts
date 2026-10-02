/**
 * 测试职责：验证 executor-agent 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutorAgent, inspectWorkspaceScope, parseExecutorReport } from "./executor-agent.js";
import { resolveExecutorWorkingDirectory } from "../tools/executor-working-directory.js";
import { InMemoryPipelineStore, LifecycleHookRunner, PlanService, Scheduler, ToolGateway, type AgentLoop, type ModelEvent, type ModelGateway, type ModelRequest } from "../index.js";
import { DEFAULT_PROJECT_SETTINGS } from "../project/project.js";
import { DurableToolRuntime } from "../tools/tool-runtime.js";

const executionReport = (taskId: string) => `<pipeline-factory-execution-report>${JSON.stringify({
  completedTaskIds: [taskId],
  changedPaths: ["src/implemented.ts"],
  report: "Task completed with verification-ready evidence",
})}</pipeline-factory-execution-report>`;

const temporaryWorkspaces: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

async function createQueuedRun(saveRun = true, include = ["src/**"], artifactPath?: string) {
  const workspacePath = await mkdtemp(join(tmpdir(), "pipeline-executor-fixture-"));
  temporaryWorkspaces.push(workspacePath);
  const store = new InMemoryPipelineStore();
  const plans = new PlanService(store);
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "explorer-1", title: "Executor plan", contract: {
    goal: "Implement the feature",
    acceptanceCriteria: ["The feature works"],
    include,
    exclude: [".env"],
    ...(artifactPath ? { artifactPath } : {}),
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
  const run = { id: "run-1", projectId: "project-1", planId: plan.id, planRevision: 1, status: "IN_PROGRESS" as const, branch: "factory/run-1", workspacePath, baseCommit: "abc", executionThreadId: "execution-thread-1", createdAt: store.now(), startedAt: store.now() };
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

  it("accepts structured active and blocked task facts", () => {
    expect(parseExecutorReport(`<pipeline-factory-execution-report>${JSON.stringify({
      completedTaskIds: ["task-1"],
      changedPaths: [],
      report: "Task 1 completed; task 2 is blocked",
      activeTaskId: "task-2",
      blockedTaskId: "task-3",
      blockedReason: "No Git remote",
    })}</pipeline-factory-execution-report>`)).toMatchObject({ activeTaskId: "task-2", blockedTaskId: "task-3", blockedReason: "No Git remote" });
  });

  it("treats null optional task facts as absent instead of failing the report", () => {
    expect(parseExecutorReport(`<pipeline-factory-execution-report>${JSON.stringify({
      completedTaskIds: ["task-1", "task-2"],
      changedPaths: ["docs/pear-introduction.md"],
      report: "All tasks completed",
      activeTaskId: null,
      blockedTaskId: null,
      blockedReason: null,
    })}</pipeline-factory-execution-report>`)).toEqual({
      completedTaskIds: ["task-1", "task-2"],
      changedPaths: ["docs/pear-introduction.md"],
      report: "All tasks completed",
    });
  });

  it("still rejects optional task facts of the wrong type", () => {
    expect(parseExecutorReport(`<pipeline-factory-execution-report>${JSON.stringify({
      completedTaskIds: ["task-1"],
      changedPaths: [],
      report: "Done",
      activeTaskId: 42,
    })}</pipeline-factory-execution-report>`)).toBeNull();
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
    const { store, plan, run } = await createQueuedRun();
    const detailedRevision = {
      ...plan,
      resolvedContract: {
        schemaVersion: 2 as const,
        artifact: { mode: "REPOSITORY_FILE" as const, path: "src/implemented.ts" },
        objective: {
          goal: "Implement the feature",
          context: ["The current endpoint omits the project id; the server validator rejects the request."],
          audience: ["Project users"],
          acceptanceCriteria: ["The feature works"],
          outOfScope: ["No redesign"],
        },
        design: {
          technicalConstraints: ["Reuse the current API contract"],
          dataSecurity: ["Do not expose tokens"],
          failureHandling: ["Keep the form values on failure"],
          risks: ["Old clients may still call the legacy endpoint; keep a compatibility route."],
        },
        repository: { projectId: "project-1", name: "Test", repoRoot: "/repo", baseBranch: "main", baseCommit: "abc", configVersion: 1, configHash: "sha256:test" },
        scope: { includePaths: ["src/**"], excludePaths: [".env"] },
        tasks: [{ id: "task-1", title: "Implement the feature", dependencies: [], status: "READY" as const, changes: [{ path: "src/implemented.ts", action: "modify" as const, detail: "Update the handler to pass the current project id." }] }],
        dependencies: ["Use the existing package manager and lockfile."],
        conflicts: [],
        execution: { executorModelRole: "executor", toolPolicy: "executor-scoped-write", maxRepairAttempts: 1 },
        verification: { mode: "PROJECT_DEFAULT" as const, commandIds: ["project.test"] },
        merge: { strategy: "manual" as const, requireHumanMerge: true as const },
      },
    };
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

    await new ExecutorAgent(store, model).run(run, detailedRevision);

    const systemMessage = receivedMessages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("The approved Plan contract is the source of truth");
    expect(systemMessage?.content).toContain("Implement the feature");
    expect(systemMessage?.content).toContain('"context":');
    expect(systemMessage?.content).toContain("The current endpoint omits the project id; the server validator rejects the request.");
    expect(systemMessage?.content).toContain('"risks":');
    expect(systemMessage?.content).toContain("Old clients may still call the legacy endpoint; keep a compatibility route.");
    expect(systemMessage?.content).toContain('"path": "src/implemented.ts"');
    expect(systemMessage?.content).toContain("Update the handler to pass the current project id.");
    expect(systemMessage?.content).toContain('"dependencies":');
    expect(systemMessage?.content).toContain("Use the existing package manager and lockfile.");
  });

  it("blocks instead of waiting when the model asks for structured input", async () => {
    // Run 会话没有回答入口。executor 启动 Loop 时带 allowStructuredInput: false，
    // 所以模型真要提问就是一次明确的能力不匹配，而不是挂进等不到答案的 WAITING_FOR_INPUT。
    const { store, plan, run } = await createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "turn.input_required", request: { requestId: "request-1", threadId: "provider-thread", turnId: "provider-turn", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { throw new Error("不该被调用：Run 没有回答入口"); },
      async cancel() { return undefined; },
    };

    const loop = await new ExecutorAgent(store, model).run(run, plan);

    expect(loop.state).toBe("BLOCKED");
    expect(loop.checkpointJson).toContain("STRUCTURED_INPUT_UNSUPPORTED");
    expect(store.listAgentLoopSteps(loop.id).map((step) => step.stepType)).not.toContain("INPUT_REQUIRED");
  });

  it("uses the declared artifact directory when include scope spans multiple paths", async () => {
    const include = ["code/personal-site/**", "docs/**"];
    const artifactPath = "code/personal-site/**";
    const { store, plan, run } = await createQueuedRun(true, include, artifactPath);
    let requestCwd: string | undefined;
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        requestCwd = request.cwd;
        yield { type: "text.delta", text: executionReport(plan.contract.tasks[0]!.id) };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    await new ExecutorAgent(store, model).run(run, plan);

    const expectedCwd = await resolveExecutorWorkingDirectory(run.workspacePath!, include, artifactPath);
    expect(requestCwd).toBe(expectedCwd);
    expect(requestCwd).toMatch(/code\/personal-site$/);
  });

  it("rejects an included artifact directory that escapes through a symlink", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-executor-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "pipeline-executor-outside-"));
    try {
      await symlink(outside, join(workspace, "code"));
      await expect(resolveExecutorWorkingDirectory(workspace, ["code/personal-site/**"])).rejects.toThrow("EXECUTOR_WORKING_DIRECTORY_SYMLINK_BLOCKED");
    } finally {
      await Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it("runs the executor loop and only becomes ready for verification after the task gate passes", async () => {
    const { store, plan, run } = await createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        expect(request.role).toBe("executor");
        yield { type: "model.usage", usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 12, totalTokens: 140 }, scope: "turn" };
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
    expect(store.getExecutionThread(run.executionThreadId)?.telemetry).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: null, usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 12, totalTokens: 140 }, usageSource: "provider" });
    expect(store.getExecutionThread(run.executionThreadId)?.telemetry?.durationMs).toEqual(expect.any(Number));
    expect(store.getExecutionThread(run.executionThreadId)?.journal.map((entry) => entry.type)).toEqual(expect.arrayContaining(["MODEL_OUTPUT", "TASK_PROGRESS"]));
    const taskStatus = store.getExecutionThread(run.executionThreadId)?.journal.find((entry) => entry.payload.action === "task-status");
    const completedTaskIds = taskStatus?.payload.completedTaskIds;
    expect(Array.isArray(completedTaskIds) && completedTaskIds.includes("task-1")).toBe(true);
  });

  it("does not treat a model completion message as task completion", async () => {
    const { store, plan, run } = await createQueuedRun();
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
    const { store, plan, run } = await createQueuedRun();
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

  it("**把 Provider 活动的原文记进 journal** —— 否则执行会话只能写「命令 · Provider reported success」", async () => {
    const { store, plan, run } = await createQueuedRun();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna", loopMode: "provider-controlled" }),
      capabilities: () => ({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] }),
      async *stream() {
        // summary 就是"这条活动到底是什么"：命令原文、被改动的文件路径。UI 的标题靠它。
        yield { type: "provider.activity", phase: "started", itemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "running", title: null, summary: "npm install --ignore-scripts", providerItemId: "exec-1" };
        yield { type: "provider.activity", phase: "completed", itemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "succeeded", title: null, summary: "npm install --ignore-scripts", providerItemId: "exec-1" };
        yield { type: "text.delta", text: "done" };
        yield { type: "turn.completed" };
      },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    await new ExecutorAgent(store, model, undefined, { maxSteps: 1 }).run(run, plan);

    const recorded = (store.getExecutionThread(run.executionThreadId)?.journal ?? []).filter((entry) => entry.type === "PROVIDER_ACTIVITY");
    expect(recorded[0]?.payload).toMatchObject({ activityKind: "command", outcome: "running", summary: "npm install --ignore-scripts" });
    expect(recorded[1]?.payload).toMatchObject({ outcome: "succeeded", summary: "npm install --ignore-scripts" });
  });

  it("injects a durable built-in ToolRuntime for Factory-controlled execution", async () => {
    const { store, plan, run } = await createQueuedRun();
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

  it("judges capabilities against the backend the Project actually configured", async () => {
    const { store, plan, run } = await createQueuedRun();
    // 角色默认后端支持 factory-controlled；项目把 executor 覆盖到一个**只支持 provider-controlled**
    // 的后端。判定必须按覆盖后的那个后端来，否则失败会被推迟到第一次模型调用。
    const snapshot = {
      projectId: "project-1",
      name: "Project",
      shortName: "Project",
      repoRoot: "/tmp/project-1",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-1-worktrees",
      configVersion: 1,
      configHash: "sha256:snapshot",
      settings: {
        ...DEFAULT_PROJECT_SETTINGS,
        models: {
          explorer: { ...DEFAULT_PROJECT_SETTINGS.models.explorer },
          executor: { ...DEFAULT_PROJECT_SETTINGS.models.executor, backend: "claude-agent-sdk", loopMode: "factory-controlled" as const },
        },
      },
    };
    const revision = { ...plan, projectConfigSnapshot: snapshot };
    const observedConfigs: Array<{ backend?: string | undefined } | undefined> = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "executor" }),
      capabilities: (_role, config) => {
        observedConfigs.push(config);
        return { supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] };
      },
      async *stream() { yield { type: "turn.completed" }; },
      async answerUserInput() { return undefined; },
      async cancel() { return undefined; },
    };

    await expect(new ExecutorAgent(store, model, undefined, { maxSteps: 1 }).run(run, revision)).rejects.toThrow("MODEL_CAPABILITY_UNAVAILABLE");
    expect(observedConfigs).toMatchObject([{ backend: "claude-agent-sdk", loopMode: "factory-controlled" }]);
  });

  it("starts the Executor Loop only after the workspace and start hook succeed", async () => {
    const { store, plan } = await createQueuedRun(false);
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
