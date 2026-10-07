/**
 * 测试职责：验证 server 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplorerService,
  InMemoryPipelineStore,
  LifecycleHookRunner,
  MergeService,
  PlanService,
  ProjectService,
  Scheduler,
  type AgentLoop,
  type DomainEvent,
  type ExecutionTelemetry,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
  type PlanRevision,
  type VerificationCommandExecutor,
  planContractFixture,
} from "@pipeline-factory/domain";
import { createApp } from "./server.js";
import { loadFactoryConfig } from "./config.js";
import { DirectoryDialogError } from "./runtime/directory-dialog.js";
import { sanitizeExplorerRequirementStatusEvent } from "./projections/explorer.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

function createTestProject(store: InMemoryPipelineStore, id = "project-1") {
  return new ProjectService(store).create({
    id,
    name: id,
    repoRoot: `/repo/${id}`,
    defaultBranch: "main",
    worktreeRoot: `/tmp/${id}-worktrees`,
    settings: {
      commands: [
        { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
        { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
      ],
    },
  });
}

const temporaryRepos: string[] = [];

/**
 * **真 Git 仓库**支撑的 Project。当前形状的方案在落库时要 `resolvePlanContract` 拿一条可验证的
 * Git 基线（`verifiedProjectBaseline` 会跑 `git rev-parse`），所以"要求把一条 READY 协议落成
 * CandidatePlan"的用例必须用这个。只断言协议解析、不落库的用例用 `createTestProject` 就够。
 */
function createGitBackedTestProject(store: InMemoryPipelineStore, id = "project-1") {
  const repoRoot = mkdtempSync(join(tmpdir(), `pipeline-${id}-`));
  temporaryRepos.push(repoRoot);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline-test@example.com", "commit", "--allow-empty", "-m", "init"],
    { cwd: repoRoot, stdio: "ignore" },
  );
  return new ProjectService(store).create({
    id,
    name: id,
    repoRoot,
    defaultBranch: "main",
    worktreeRoot: join(repoRoot, "worktrees"),
    settings: {
      commands: [
        { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
        { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
      ],
    },
  });
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const repo of temporaryRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("Pipeline Factory v4 API", () => {
  it("routes explorer and executor to different agents and reports both over HTTP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-routing-"));
    const configPath = join(directory, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { databasePath: join(directory, "factory.sqlite"), worktreeRoot: join(directory, "worktrees") },
        project: { root: directory },
        model: {
          backend: "codex-app-server",
          codexAppServer: { cwd: directory },
          backends: { deepseek: { kind: "claude-agent-sdk", models: ["deepseek-chat"] } },
          roles: { explorer: { model: "gpt-5.6-sol" }, executor: { model: "deepseek-chat", backend: "deepseek" } },
        },
      }),
      "utf8",
    );
    const app = createApp({ store: new InMemoryPipelineStore(), config: loadFactoryConfig(configPath), seed: false });
    apps.push(app);

    try {
      // /health 会读 explorer 生效的后端配置：多后端下这一步曾经在懒构造里 500。
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        modelBackend: "codex-app-server",
        modelBackends: { explorer: "codex-app-server", executor: "deepseek" },
        model: "gpt-5.6-sol",
      });

      const catalog = await app.inject({ method: "GET", url: "/api/v4/model-backends" });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toMatchObject({
        roles: { explorer: "codex-app-server", executor: "deepseek" },
        defaultBackend: "codex-app-server",
      });
      // 注册表后端用它自己的模型清单；推理强度按 kind 给（Claude 侧没有 minimal/ultra）。
      expect(catalog.json().backends.find((backend: { id: string }) => backend.id === "deepseek")).toMatchObject({
        kind: "claude-agent-sdk",
        source: "registry",
        models: ["deepseek-chat"],
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes the Explorer plan requirements used by the prompt and UI", async () => {
    const app = createApp({ store: new InMemoryPipelineStore(), seed: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v4/explorer-plan-requirements" });
    expect(response.statusCode).toBe(200);
    expect(response.json().requirements).toMatchObject({
      schemaVersion: 2,
      requirementsVersion: 1,
      areas: expect.arrayContaining([expect.objectContaining({ label: "目标与用户范围" })]),
      artifactModes: expect.arrayContaining([
        expect.objectContaining({ mode: "CONVERSATION", executable: false }),
        expect.objectContaining({ mode: "REPOSITORY_FILE", executable: true }),
      ]),
    });
  });

  it("asks the local OS for a directory and reports cancel as a normal answer", async () => {
    // 对话框由注入的实现替代：测试机上不能真的弹窗（也就不可能在 CI 里挂住）。
    const picked = createApp({
      store: new InMemoryPipelineStore(),
      seed: false,
      chooseDirectory: async () => ({ path: "/Users/local/repo" }),
    });
    const cancelled = createApp({ store: new InMemoryPipelineStore(), seed: false, chooseDirectory: async () => ({ cancelled: true }) });
    const unsupported = createApp({
      store: new InMemoryPipelineStore(),
      seed: false,
      chooseDirectory: async () => {
        throw new DirectoryDialogError("DIALOG_UNSUPPORTED", "当前平台不支持弹出系统目录选择框，请手动输入绝对路径。");
      },
    });
    apps.push(picked, cancelled, unsupported);

    const ok = await picked.inject({ method: "POST", url: "/api/v4/dialogs/select-directory" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ cancelled: false, path: "/Users/local/repo" });

    // 用户点取消是正常结果，不是错误码——前端据此"什么都不做"，不该报红。
    const cancel = await cancelled.inject({ method: "POST", url: "/api/v4/dialogs/select-directory" });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: true, path: null });

    // 平台不支持要**说得出原因**（501），前端把这句话展示出来并让人手输。
    const unsupportedResponse = await unsupported.inject({ method: "POST", url: "/api/v4/dialogs/select-directory" });
    expect(unsupportedResponse.statusCode).toBe(501);
    expect(unsupportedResponse.json()).toMatchObject({ code: "DIALOG_UNSUPPORTED" });
  });

  it("lists Project configuration and summary data", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-1",
      name: "Demo",
      repoRoot: "/repo/demo",
      defaultBranch: "main",
      worktreeRoot: "/tmp/demo-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-1", projectId: project.id, parentThreadId: null });
    projects.selectExplorer(project.id, "explorer-1");
    const app = createApp({ store, seed: false });
    apps.push(app);

    const list = await app.inject({ method: "GET", url: "/api/v4/projects" });
    const detail = await app.inject({ method: "GET", url: "/api/v4/projects/project-1" });

    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ id: "project-1", name: "Demo", repoRoot: "/repo/demo", status: "ACTIVE" }]);
    expect(list.json().items[0].summary).toMatchObject({
      currentExplorerThread: "explorer-1",
      currentExplorerTitle: expect.any(String),
      threadCount: 1,
      runCount: 0,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().summary).toMatchObject({ threadCount: 1, planCount: 0, runCount: 0, currentExplorerThread: "explorer-1" });
  });

  it("accepts a short name when creating and updating a Project", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-api-short-name-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline-test@example.com", "commit", "--allow-empty", "-m", "init"],
        { cwd: repoRoot, stdio: "ignore" },
      );
      const store = new InMemoryPipelineStore();
      const app = createApp({ store, seed: false });
      apps.push(app);

      const created = await app.inject({
        method: "POST",
        url: "/api/v4/projects",
        payload: { id: "project-short-api", name: "API Project", shortName: "APP", repoRoot, worktreeRoot: join(repoRoot, "worktrees") },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().project).toMatchObject({ name: "API Project", shortName: "APP" });

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/v4/projects/project-short-api",
        payload: { shortName: "API", expectedConfigVersion: 1 },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().project).toMatchObject({ name: "API Project", shortName: "API", configVersion: 2 });

      const reset = await app.inject({
        method: "PATCH",
        url: "/api/v4/projects/project-short-api",
        payload: { shortName: "", expectedConfigVersion: 2 },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().project).toMatchObject({ name: "API Project", shortName: "API Project", configVersion: 3 });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("saves execution settings while a run is active", async () => {
    // 用户报障的复现路径：把执行模型换成 claude 时，项目里正好有 Run 在跑。
    // 设置页承诺"仓库目录、Worktree 和分支修改需要没有运行中的 Run"——模型不在其列，
    // 因为运行中的 Run 用的是自己那份冻结快照（见 executor-agent 取 executor 模型的写法）。
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store, "project-settings-api");
    store.saveRun({
      id: "run-active",
      projectId: project.id,
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-active",
      workspacePath: "/tmp/run-active",
      baseCommit: "abc",
      executionThreadId: "execution-active",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v4/projects/${project.id}`,
      payload: { expectedConfigVersion: 1, settings: { models: { executor: { model: "claude-opus-5", backend: "claude-agent-sdk" } } } },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().project.settings.models.executor).toMatchObject({ model: "claude-opus-5", backend: "claude-agent-sdk" });
    expect(saved.json().project.configVersion).toBe(2);
  });

  /**
   * `blocking` 是「启动钩子」的失败策略，**API 这一跳是它最容易死掉的地方**：zod 默认丢弃未知
   * 字段，漏掉它就表现为"设置页取消了勾、保存了、库里的值没变"——而且不报错（见 schemas/hooks.ts
   * 维护提示）。顺带钉住它**只属于 start**：配在 cleanup 上应当在入口就被丢掉，而不是走到领域层
   * 才 422（领域层拒它是另一条路，见 packages/domain 的 project.test.ts）。
   */
  it("carries the start hook's failure policy over HTTP, and only on start", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-hooks-api",
      name: "Hooks API",
      repoRoot: "/repo/hooks-api",
      defaultBranch: "main",
      worktreeRoot: "/tmp/hooks-api-worktrees",
      settings: { commands: [{ commandId: "project.codegraph-init", category: "lifecycle", enabled: true, argv: ["codegraph", "init"] }] },
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const soft = await app.inject({
      method: "PUT",
      url: `/api/v4/projects/${project.id}/settings/hooks`,
      payload: { start: { commandId: "project.codegraph-init", enabled: true, blocking: false } },
    });
    expect(soft.statusCode).toBe(200);
    expect(store.getProject(project.id)?.settings.hooks.start).toMatchObject({ commandId: "project.codegraph-init", blocking: false });

    // 不写这个键时库里不该多出它：不然"老项目行为与引入前一致"就只能靠读代码来保证。
    const implicit = await app.inject({
      method: "PUT",
      url: `/api/v4/projects/${project.id}/settings/hooks`,
      payload: { start: { commandId: "project.codegraph-init" } },
    });
    expect(implicit.statusCode).toBe(200);
    expect(store.getProject(project.id)?.settings.hooks.start).not.toHaveProperty("blocking");

    const withCleanup = await app.inject({
      method: "PUT",
      url: `/api/v4/projects/${project.id}/settings/hooks`,
      payload: { start: { commandId: "project.codegraph-init" }, cleanup: { commandId: "project.codegraph-init", blocking: true } },
    });
    expect(withCleanup.statusCode).toBe(200);
    expect(store.getProject(project.id)?.settings.hooks.cleanup).toEqual({ commandId: "project.codegraph-init" });
  });

  it("sets Factory-owned prerequisite plans over HTTP and rejects unknown ids", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-deps-api",
      name: "Deps API",
      repoRoot: "/repo/deps-api",
      defaultBranch: "main",
      worktreeRoot: "/tmp/deps-api-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "deps-thread", projectId: project.id, parentThreadId: null });
    const upstream = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "deps-thread",
      title: "Upstream",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Upstream" }),
    });
    const downstream = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "deps-thread",
      title: "Downstream",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Downstream" }),
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const saved = await app.inject({
      method: "PUT",
      url: `/api/v4/plans/${downstream.id}/dependencies`,
      payload: { dependsOnPlanIds: [upstream.id], actorId: "tester" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().plan.resolvedContract.dependsOnPlanIds).toEqual([upstream.id]);

    // 未知 Plan 由 domain 拒绝，HTTP 层映射成 409 而不是 500。
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/v4/plans/${downstream.id}/dependencies`,
      payload: { dependsOnPlanIds: ["plan-missing"], actorId: "tester" },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ code: "PLAN_DEPENDENCIES_INVALID" });

    const unknownPlan = await app.inject({
      method: "PUT",
      url: "/api/v4/plans/plan-missing/dependencies",
      payload: { dependsOnPlanIds: [], actorId: "tester" },
    });
    expect(unknownPlan.statusCode).toBe(404);
  });

  it("re-picks the verification subset over HTTP and reports unknown tags as 409", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-suite-api-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@test", "commit", "--allow-empty", "-m", "init"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      const store = new InMemoryPipelineStore();
      const projects = new ProjectService(store);
      const project = projects.create({
        id: "project-suite-api",
        name: "Suite API",
        repoRoot,
        defaultBranch: "main",
        worktreeRoot: join(repoRoot, "worktrees"),
        settings: {
          commands: [
            { commandId: "project.test", category: "verification", enabled: true, argv: ["true"], tags: ["unit"] },
            { commandId: "docs.validate", category: "verification", enabled: true, argv: ["true"], tags: ["docs"] },
          ],
          defaultVerificationCommandIds: ["project.test", "docs.validate"],
        },
      });
      const plans = new PlanService(store, projects);
      const candidate = plans.createCandidatePlan({
        projectId: project.id,
        sourceExplorerThreadId: "thread-suite-api",
        title: "Suite candidate",
        generatedSpec: {
          schemaVersion: 2,
          title: "Suite candidate",
          artifact: { mode: "REPOSITORY_FILE", path: "docs/guide.md" },
          objective: { goal: "Document it", audience: ["devs"], acceptanceCriteria: ["guide updated"], outOfScope: [] },
          design: { technicalConstraints: ["markdown"], dataSecurity: ["no personal data"], failureHandling: ["keep old docs"] },
          scope: { includePaths: ["docs/guide.md"], excludePaths: [] },
          tasks: [{ id: "docs", title: "Update guide", dependencies: [] }],
          dependencies: [],
          conflicts: [],
          execution: {},
          verification: { mode: "PROJECT_DEFAULT" },
          merge: { strategy: "manual", requireHumanMerge: true },
        },
      });
      const app = createApp({ store, seed: false });
      apps.push(app);

      const narrowed = await app.inject({
        method: "PUT",
        url: `/api/v4/plans/${candidate.id}/verification-suites`,
        payload: { suites: ["docs"], actorId: "tester" },
      });
      expect(narrowed.statusCode).toBe(200);
      expect(narrowed.json().plan.resolvedContract.verification.commandIds).toEqual(["docs.validate"]);

      const unknown = await app.inject({
        method: "PUT",
        url: `/api/v4/plans/${candidate.id}/verification-suites`,
        payload: { suites: ["nope"], actorId: "tester" },
      });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json()).toMatchObject({ code: "PLAN_VERIFICATION_SUITES_INVALID" });

      const missingPlan = await app.inject({
        method: "PUT",
        url: "/api/v4/plans/plan-missing/verification-suites",
        payload: { suites: [], actorId: "tester" },
      });
      expect(missingPlan.statusCode).toBe(404);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("serves only project-scoped Execute snapshots with replayable events", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-workbench",
      name: "Workbench",
      repoRoot: "/repo/workbench",
      defaultBranch: "main",
      worktreeRoot: "/tmp/workbench-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "workbench-thread", projectId: project.id, parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "workbench-thread",
      title: "Workbench plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Workbench plan" }),
    });
    plans.confirm(plan.id, "user-1");
    const app = createApp({ store, seed: false });
    apps.push(app);

    const global = await app.inject({ method: "GET", url: "/api/v4/workbench" });
    const scoped = await app.inject({ method: "GET", url: `/api/v4/workbench?projectId=${project.id}` });
    const cursor = scoped.json().cursor as number;
    const replay = await app.inject({ method: "GET", url: `/api/v4/workbench/events?projectId=${project.id}&afterSequence=${cursor - 1}` });

    expect(global.statusCode).toBe(400);
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({
      activeProjectId: project.id,
      projects: [{ id: project.id }],
      plans: [{ planId: plan.id, title: "Workbench plan", status: "READY", dispatch: null }],
    });
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

  it("persists the project execution thread and its preferences without creating a Plan or Run", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store, "project-execution-api");
    const requests: ModelRequest[] = [];
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream(request) {
        requests.push(request);
        yield { type: "thread.started", threadId: "provider-project-execution" } satisfies ModelEvent;
        yield {
          type: "text.delta",
          text: "finished",
          providerThreadId: "provider-project-execution",
          providerTurnId: "turn-1",
          providerItemId: "item-1",
        } satisfies ModelEvent;
        yield { type: "turn.completed" } satisfies ModelEvent;
      },
      async answerUserInput() {
        return undefined;
      },
      async cancel() {
        return undefined;
      },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/api/v4/projects/project-execution-api/execution-thread" });
    const reopened = await app.inject({ method: "GET", url: "/api/v4/projects/project-execution-api/execution-thread" });
    expect(initial.statusCode).toBe(200);
    expect(reopened.json().thread.id).toBe(initial.json().thread.id);

    const invalidPreference = await app.inject({
      method: "PATCH",
      url: "/api/v4/projects/project-execution-api/execution-thread/preferences",
      payload: { model: "arbitrary-model", reasoningEffort: null },
    });
    expect(invalidPreference.statusCode).toBe(422);
    expect(invalidPreference.json()).toMatchObject({ code: "PROJECT_EXECUTION_MODEL_INVALID" });

    const preference = await app.inject({
      method: "PATCH",
      url: "/api/v4/projects/project-execution-api/execution-thread/preferences",
      payload: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    });
    expect(preference.statusCode).toBe(200);
    expect(preference.json().thread).toMatchObject({ modelOverride: "gpt-5.6-sol", reasoningEffortOverride: "high" });
    const submitted = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-execution-api/execution-thread/turns",
      payload: { content: "直接修复", clientTurnId: "api-turn-1" },
    });
    expect(submitted.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-execution-api/execution-thread/turns",
      payload: { content: "重试请求", clientTurnId: "api-turn-1" },
    });
    expect(duplicate.json().assistant.id).toBe(submitted.json().assistant.id);
    await waitUntil(
      () =>
        store.listProjectExecutionMessages(initial.json().thread.id).find((message) => message.id === submitted.json().assistant.id)
          ?.status === "COMPLETED",
    );

    const snapshot = await app.inject({ method: "GET", url: "/api/v4/projects/project-execution-api/execution-thread" });
    const scopedEvents = await app.inject({ method: "GET", url: "/api/v4/workbench/events?projectId=project-execution-api" });
    expect(snapshot.json().messages).toContainEqual(
      expect.objectContaining({ id: submitted.json().assistant.id, model: "gpt-5.6-sol", reasoningEffort: "high", content: "finished" }),
    );
    expect(scopedEvents.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "project.execution.turn.completed", aggregateId: initial.json().thread.id }),
      ]),
    );
    expect(requests[0]).toMatchObject({
      cwd: "/repo/project-execution-api",
      modelConfig: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    });
    expect(store.listPlans().filter((plan) => plan.projectId === "project-execution-api")).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it("deletes an Explorer and returns the replacement thread", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-delete-api",
      name: "Delete API",
      repoRoot: "/repo/delete-api",
      defaultBranch: "main",
      worktreeRoot: "/tmp/delete-api-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "delete-thread", projectId: project.id, parentThreadId: null });
    plans.registerThread({ id: "replacement-thread", projectId: project.id, parentThreadId: null });
    plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "delete-thread",
      title: "Deleted plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Deleted plan" }),
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "DELETE", url: `/api/v4/projects/${project.id}/explorers/delete-thread` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deletedExplorerId: "delete-thread",
      replacementExplorer: { id: "replacement-thread" },
      project: { currentExplorerThreadId: "replacement-thread" },
      deleted: { taskCount: 1, planCount: 1, runCount: 0 },
    });
    expect(store.getThread("delete-thread")).toBeUndefined();
    expect(store.listEvents({ aggregateId: "delete-thread" }).some((event) => event.type === "explorer.deleted")).toBe(true);

    const replacementId = response.json().replacementExplorer.id as string;
    const replacementPlans = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/explorers/${replacementId}/explorer-plans`,
    });
    expect(replacementPlans.statusCode).toBe(200);
    const replacementPlanId = replacementPlans.json().items[0].id as string;
    const replacementWorkspace = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/explorers/${replacementId}/explorer-plans/${replacementPlanId}/workspace`,
    });
    expect(replacementWorkspace.statusCode).toBe(200);
  });

  it("rejects deleting an Explorer that has an active Run", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-delete-active",
      name: "Delete Active",
      repoRoot: "/repo/delete-active",
      defaultBranch: "main",
      worktreeRoot: "/tmp/delete-active-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "active-delete-thread", projectId: project.id, parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "active-delete-thread",
      title: "Active plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Active plan" }),
    });
    store.saveRun({
      id: "active-delete-run",
      projectId: project.id,
      planId: plan.id,
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/active-delete-run",
      workspacePath: "/tmp/active-delete-worktree",
      baseCommit: "HEAD",
      executionThreadId: "active-delete-execution",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "DELETE", url: `/api/v4/projects/${project.id}/explorers/active-delete-thread` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EXPLORER_DELETE_BLOCKED", activeRunIds: ["active-delete-run"] });
    expect(store.getThread("active-delete-thread")).toBeDefined();
  });

  it("deletes one requirement and reports the surviving list", async () => {
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store, "project-requirement-delete");
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: project.id, title: "Thread" });
    const first = store.listExplorerPlans(explorer.id)[0]!;
    const second = explorers.createPlan(explorer.id);
    const third = explorers.createPlan(explorer.id);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v4/projects/${project.id}/explorers/${explorer.id}/explorer-plans/${second.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deletedExplorerPlanId: second.id, deleted: { taskCount: 1, planCount: 0, runCount: 0 } });
    expect(response.json().explorerPlans.map((plan: { id: string }) => plan.id)).toEqual([first.id, third.id]);
    expect(response.json().explorer).toMatchObject({ id: explorer.id, activeExplorerPlanId: third.id });
    expect(store.getExplorerPlan(second.id)).toBeUndefined();
    expect(store.getThread(explorer.id)).toBeDefined();
  });

  it("refuses to delete the last requirement of a thread", async () => {
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store, "project-requirement-last");
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: project.id, title: "Only one" });
    const only = store.listExplorerPlans(explorer.id)[0]!;
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v4/projects/${project.id}/explorers/${explorer.id}/explorer-plans/${only.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EXPLORER_PLAN_DELETE_FORBIDDEN", reason: "LAST_REQUIREMENT" });
    expect(store.getExplorerPlan(only.id)).toBeDefined();
  });

  it("rejects deleting a requirement that has an active Run", async () => {
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store, "project-requirement-active");
    const projects = new ProjectService(store);
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: project.id, title: "Thread" });
    const first = store.listExplorerPlans(explorer.id)[0]!;
    const second = explorers.createPlan(explorer.id);
    const plan = new PlanService(store, projects).createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: explorer.id,
      explorerPlanId: second.id,
      title: "Running plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Running plan" }),
    });
    store.saveRun({
      id: "requirement-delete-run",
      projectId: project.id,
      planId: plan.id,
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/requirement-delete-run",
      workspacePath: "/tmp/requirement-delete-worktree",
      baseCommit: "HEAD",
      executionThreadId: "requirement-delete-execution",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v4/projects/${project.id}/explorers/${explorer.id}/explorer-plans/${second.id}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EXPLORER_DELETE_BLOCKED", activeRunIds: ["requirement-delete-run"] });
    expect(store.getExplorerPlan(second.id)).toBeDefined();
    expect(store.getPlan(plan.id)).toBeDefined();
    expect(store.getExplorerPlan(first.id)).toBeDefined();
  });

  it("does not allow deleting a requirement through another thread", async () => {
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store, "project-requirement-owner");
    const explorers = new ExplorerService(store);
    const explorer = explorers.create({ projectId: project.id, title: "Thread" });
    const other = explorers.create({ projectId: project.id, title: "Other thread" });
    const foreign = store.listExplorerPlans(other.id)[0]!;
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v4/projects/${project.id}/explorers/${explorer.id}/explorer-plans/${foreign.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(store.getExplorerPlan(foreign.id)).toBeDefined();
  });

  it("does not allow deleting an Explorer through another Project", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-delete-owner",
      name: "Owner",
      repoRoot: "/repo/delete-owner",
      defaultBranch: "main",
      worktreeRoot: "/tmp/delete-owner-worktrees",
    });
    const otherProject = projects.create({
      id: "project-delete-other",
      name: "Other",
      repoRoot: "/repo/delete-other",
      defaultBranch: "main",
      worktreeRoot: "/tmp/delete-other-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "owned-delete-thread", projectId: project.id, parentThreadId: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "DELETE", url: `/api/v4/projects/${otherProject.id}/explorers/owned-delete-thread` });

    expect(response.statusCode).toBe(404);
    expect(store.getThread("owned-delete-thread")).toBeDefined();
  });

  it("lists all Enqueued plans for a Project across ExplorerThreads", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-plans",
      name: "Plans",
      repoRoot: "/repo/plans",
      defaultBranch: "main",
      worktreeRoot: "/tmp/plans-worktrees",
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "explorer-a", projectId: project.id, parentThreadId: null });
    plans.registerThread({ id: "explorer-b", projectId: project.id, parentThreadId: null });
    const first = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "explorer-a",
      title: "Plan A",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Plan A" }),
    });
    const second = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "explorer-b",
      title: "Plan B",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Plan B" }),
    });
    plans.confirm(first.id, "user-1");
    plans.enqueue(first.id);
    plans.confirm(second.id, "user-1");
    plans.enqueue(second.id);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/plans` });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .items.map((item: { title: string }) => item.title)
        .sort(),
    ).toEqual(["Plan A", "Plan B"]);
  });

  it("exposes the active Explorer model in health metadata", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: (role) => ({ model: role === "explorer" ? "gpt-5.6-luna" : "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "turn.completed" };
      },
      async answerUserInput() {
        return undefined;
      },
      async cancel() {
        return undefined;
      },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", model: "gpt-5.6-luna" });
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
    const app = createApp({ store, seed: false });
    apps.push(app);
    // Loop 摆在 **`createApp` 之后**：创建应用时会先跑一次启动恢复，而那一刻仍停在 RUNNING 的
    // Run Loop 必然是上一次进程留下的僵尸，会被收成 RECOVERING（并追加一条 LOOP_SUSPENDED）。
    // 本用例考的是"读接口能不能把状态、步骤、事件原样暴露出来"，所以让 Loop 在进程起来之后再开跑。
    const loop: AgentLoop = {
      id: "loop-1",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "provider-controlled",
      state: "RUNNING",
      stepCount: 1,
      maxSteps: 40,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
      checkpointJson: null,
    };
    store.saveAgentLoop(loop);
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_STARTED", status: "RUNNING", payload: { step: 1 } });
    store.appendAgentLoopStep({
      loopId: loop.id,
      stepType: "PROVIDER_ACTIVITY",
      status: "RUNNING",
      payload: { providerItemId: "provider-item-1", itemId: "activity-1" },
    });
    store.appendAgentLoopStep({
      loopId: loop.id,
      stepType: "PROVIDER_ACTIVITY",
      status: "COMPLETED",
      payload: { providerItemId: "provider-item-1", itemId: "activity-1" },
    });
    store.appendAgentLoopStep({
      loopId: loop.id,
      stepType: "GATE_CHECKED",
      status: "COMPLETED",
      payload: { action: "continue", reason: "PLAN_INCOMPLETE:完整方案缺少验收标准与验证命令" },
    });
    store.appendEvent({ type: "agent.loop.started", aggregateId: loop.id, payload: { role: loop.role } });

    const state = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1" });
    const steps = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/steps" });
    const events = await app.inject({ method: "GET", url: "/api/v4/agent-loops/loop-1/events" });

    expect(state.statusCode).toBe(200);
    expect(state.json().loop).toMatchObject({
      id: "loop-1",
      state: "RUNNING",
      diagnostics: { providerActivityCount: 1, lastGate: { action: "continue" }, terminal: null },
    });
    expect(steps.json().items).toHaveLength(4);
    expect(events.json().items[0]).toMatchObject({ type: "agent.loop.started", aggregateId: "loop-1" });
    expect(events.json().diagnostics).toMatchObject({ providerActivityCount: 1, lastGate: { action: "continue" }, terminal: null });
  });

  it("replays Run execution journal entries from a requested sequence", async () => {
    const store = new InMemoryPipelineStore();
    store.saveRun({
      id: "run-stream",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-stream",
      workspacePath: "/tmp/run-stream",
      baseCommit: "abc",
      executionThreadId: "execution-stream",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    store.saveExecutionThread({
      id: "execution-stream",
      runId: "run-stream",
      state: "ACTIVE",
      journal: [
        { sequence: 1, type: "RUN_CREATED", occurredAt: store.now(), payload: { planId: "plan-1" } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: store.now(), payload: { text: "正在执行" } },
      ],
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/runs/run-stream/events?afterSequence=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ sequence: 2, type: "MODEL_OUTPUT", occurredAt: expect.any(String), payload: { text: "正在执行" } }],
    });

    const replayedFromLastEventId = await app.inject({
      method: "GET",
      url: "/api/v4/runs/run-stream/events?afterSequence=0",
      headers: { "last-event-id": "1" },
    });

    expect(replayedFromLastEventId.statusCode).toBe(200);
    expect(replayedFromLastEventId.json().items).toEqual([
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: expect.any(String), payload: { text: "正在执行" } },
    ]);
  });

  it("returns persisted Run execution telemetry", async () => {
    const store = new InMemoryPipelineStore();
    const telemetry: ExecutionTelemetry = {
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      backend: "codex-app-server",
      startedAt: "2026-09-06T12:00:00.000Z",
      completedAt: "2026-09-06T12:00:03.000Z",
      durationMs: 3000,
      usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 10, totalTokens: 140 },
      usageSource: "provider",
      usageScope: "turn",
    };
    store.saveRun({
      id: "run-telemetry",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "READY_FOR_VERIFY",
      branch: "factory/run-telemetry",
      workspacePath: "/tmp/run-telemetry",
      baseCommit: "abc",
      executionThreadId: "execution-telemetry",
      createdAt: store.now(),
      startedAt: telemetry.startedAt,
    });
    store.saveExecutionThread({ id: "execution-telemetry", runId: "run-telemetry", state: "COMPLETED", journal: [], telemetry });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/runs/run-telemetry" });

    expect(response.statusCode).toBe(200);
    // `backend` 必须原样带出来：投影重建 telemetry 时漏搬过它，界面因此永远显示"未记录"。
    expect(response.json().executionThread.telemetry).toEqual(telemetry);
    // 这个 Run 既没有 Revision 快照、项目也不存在：配置侧只能是 null，**不编造**模型名。
    expect(response.json().executorConfig).toBeNull();
  });

  it("answers which executor a Run uses even before it has recorded telemetry", async () => {
    // 遥测要这一轮跑完才落库；运行中的界面只能靠 executorConfig 回答"现在用的是什么模型"。
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-telemetry",
      name: "Telemetry",
      repoRoot: "/repo/telemetry",
      defaultBranch: "main",
      worktreeRoot: "/tmp/telemetry-worktrees",
    });
    const explorer = new ExplorerService(store).create({ projectId: project.id, title: "Telemetry explorer" });
    const candidate = new PlanService(store, projects).createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: explorer.id,
      title: "Telemetry plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Telemetry plan" }),
    });
    const snapshot = projects.snapshot(project.id);
    store.saveRevision({
      planId: candidate.id,
      revision: 1,
      resolvedContract: candidate.resolvedContract,
      artifactHash: "sha256:test",
      confirmedBy: "tester",
      confirmedAt: store.now(),
      sourceExplorerThreadId: explorer.id,
      projectConfigVersion: snapshot.configVersion,
      projectConfigHash: snapshot.configHash,
      projectConfigSnapshot: {
        ...snapshot,
        settings: {
          ...snapshot.settings,
          models: {
            ...snapshot.settings.models,
            executor: { ...snapshot.settings.models.executor, model: "frozen-model", backend: "claude-agent-sdk" },
          },
        },
      },
    } as unknown as PlanRevision);
    store.saveRun({
      id: "run-fresh",
      projectId: project.id,
      planId: candidate.id,
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-fresh",
      workspacePath: "/tmp/run-fresh",
      baseCommit: "abc",
      executionThreadId: "execution-fresh",
      createdAt: store.now(),
      startedAt: null,
    });
    store.saveExecutionThread({ id: "execution-fresh", runId: "run-fresh", state: "ACTIVE", journal: [], telemetry: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/runs/run-fresh" });

    expect(response.statusCode).toBe(200);
    // 冻结快照优先（项目当前设置不是这个值），模型与 agent 一起回答。
    expect(response.json().executorConfig).toEqual({ model: "frozen-model", backend: "claude-agent-sdk", reasoningEffort: null });
    expect(response.json().executionThread.telemetry).toMatchObject({
      model: "frozen-model",
      backend: "claude-agent-sdk",
      usage: null,
      usageSource: "not-recorded",
    });
  });

  it("maps terminal database errors to safe Agent Loop diagnostics", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = {
      id: "loop-database-busy",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "provider-controlled",
      state: "FAILED",
      stepCount: 1,
      maxSteps: 40,
      startedAt: store.now(),
      completedAt: store.now(),
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: JSON.stringify({ error: "DATABASE_BUSY", detail: "database is locked: secret local detail" }),
    };
    store.saveAgentLoop(loop);
    store.appendAgentLoopStep({ loopId: loop.id, stepType: "LOOP_FAILED", status: "FAILED", payload: { error: "DATABASE_BUSY" } });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/api/v4/agent-loops/${loop.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().loop.diagnostics).toEqual({
      providerActivityCount: 0,
      lastGate: null,
      terminal: { code: "DATABASE_BUSY", message: "数据库写入暂时繁忙" },
    });
    expect(response.json().loop.checkpointJson).toBeNull();
    expect(JSON.stringify(response.json().loop.diagnostics)).not.toContain("secret local detail");
  });

  it("exposes durable tool-call status for an Agent Loop", async () => {
    const store = new InMemoryPipelineStore();
    const loop: AgentLoop = {
      id: "loop-tools",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "factory-controlled",
      state: "RUNNING",
      stepCount: 1,
      maxSteps: 4,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    };
    store.saveAgentLoop(loop);
    store.saveToolCall({
      callId: "tool-1",
      loopId: loop.id,
      role: "executor",
      tool: "mcp:docs:search",
      status: "RUNNING",
      inputHash: "hash",
      result: null,
      startedAt: store.now(),
      completedAt: null,
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v4/agent-loops/" + loop.id + "/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toMatchObject([{ callId: "tool-1", tool: "mcp:docs:search", status: "RUNNING" }]);
  });

  it("makes Agent Loop pause, resume, and cancel controls observable", async () => {
    const store = new InMemoryPipelineStore();
    const app = createApp({ store, seed: false });
    apps.push(app);
    // 同前一条用例：Loop 摆在 `createApp` 之后，否则启动恢复会先把这个 RUNNING 的僵尸收成 RECOVERING。
    const loop: AgentLoop = {
      id: "loop-controls",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "provider-controlled",
      state: "RUNNING",
      stepCount: 0,
      maxSteps: 4,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: "provider-thread",
      providerTurnId: "provider-turn",
      checkpointJson: null,
    };
    store.saveAgentLoop(loop);

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

  it("enforces confirm before enqueue and exposes the Enqueued thread plan projection", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const planService = (await import("@pipeline-factory/domain")).PlanService;
    const plans = new planService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      sourceTurnId: "assistant-1",
      title: "API plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "API plan" }),
    });

    const rejected = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    expect(rejected.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    const enqueued = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    expect(enqueued.json()).toMatchObject({ plan: { id: plan.id, status: "ENQUEUED", dispatchedAt: null }, dispatch: null });
    expect(store.listRuns()).toEqual([]);
    const response = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/plans" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      planId: plan.id,
      status: "ENQUEUED",
      createdAt: plan.createdAt,
      sourceTurnId: "assistant-1",
      dispatchedAt: null,
    });
  });

  it("keeps the Confirmed projection to READY plans while preserving Enqueued plans in the thread projection", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    createTestProject(store, "project-2");
    const plans = new PlanService(store);
    plans.registerThread({ id: "confirmed-root", projectId: "project-1", parentThreadId: null });
    plans.registerThread({ id: "confirmed-child", projectId: "project-1", parentThreadId: "confirmed-root" });
    plans.registerThread({ id: "other-project-thread", projectId: "project-2", parentThreadId: null });

    const ready = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-root",
      title: "Ready confirmed plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Ready confirmed plan" }),
    });
    const queued = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-child",
      title: "Queued confirmed plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Queued confirmed plan" }),
    });
    const draft = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-child",
      title: "Still a draft",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Still a draft" }),
    });
    const discarded = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-child",
      title: "Discarded plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Discarded plan" }),
    });
    const otherProject = plans.createCandidatePlan({
      projectId: "project-2",
      sourceExplorerThreadId: "other-project-thread",
      title: "Other project plan",
      resolvedContract: planContractFixture({ store, projectId: "project-2", title: "Other project plan" }),
    });
    plans.confirm(ready.id, "user-1");
    plans.confirm(queued.id, "user-1");
    plans.enqueue(queued.id);
    plans.discard(discarded.id, "user-1");
    plans.confirm(otherProject.id, "user-1");

    const app = createApp({ store, seed: false });
    apps.push(app);

    const confirmed = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/confirmed-child/confirmed-plans" });
    const dispatched = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/confirmed-child/plans" });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().items.map((item: { title: string }) => item.title)).toEqual(["Ready confirmed plan"]);
    expect(confirmed.json().items.map((item: { status: string }) => item.status)).toEqual(["READY"]);
    expect(confirmed.json().items.some((item: { planId: string }) => item.planId === draft.id)).toBe(false);
    expect(confirmed.json().items.some((item: { planId: string }) => item.planId === discarded.id)).toBe(false);
    expect(confirmed.json().items.some((item: { title: string }) => item.title === "Other project plan")).toBe(false);
    expect(dispatched.statusCode).toBe(200);
    expect(dispatched.json().items.map((item: { title: string }) => item.title)).toEqual(["Queued confirmed plan"]);
  });

  it("does not leak active and terminal plans into the Confirmed projection", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "confirmed-lifecycle-thread", projectId: "project-1", parentThreadId: null });
    const active = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-lifecycle-thread",
      title: "Active confirmed plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Active confirmed plan" }),
    });
    const terminal = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "confirmed-lifecycle-thread",
      title: "Merged confirmed plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Merged confirmed plan" }),
    });
    plans.confirm(active.id, "user-1");
    plans.confirm(terminal.id, "user-1");
    const activeQueued = plans.enqueue(active.id);
    const terminalQueued = plans.enqueue(terminal.id);
    store.updatePlan({ ...activeQueued, status: "IN_PROGRESS", runId: "run-confirmed-active", lastEventAt: store.now() });
    store.updatePlan({ ...terminalQueued, status: "MERGED", runId: "run-confirmed-terminal", lastEventAt: store.now() });

    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v4/projects/project-1/explorers/confirmed-lifecycle-thread/confirmed-plans",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("does not project downstream lifecycle states when confirmation evidence is missing", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "invalid-lifecycle-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "invalid-lifecycle-thread",
      title: "Invalid lifecycle",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Invalid lifecycle" }),
    });
    store.updatePlan({
      ...plan,
      status: "MERGE_READY",
      confirmedAt: null,
      queuedAt: "2026-09-19T01:02:00.000Z",
      dispatchedAt: "2026-09-19T01:03:00.000Z",
      lastEventAt: "2026-09-19T01:03:00.000Z",
    });

    const app = createApp({ store, seed: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().plan.lifecycle.map((entry: { status: string }) => entry.status)).toEqual(["DRAFT", "BLOCKED"]);
    expect(response.json().plan.lifecycle.at(-1)).toMatchObject({ status: "BLOCKED", current: true, occurredAt: null });
  });

  it("discards a candidate through the API and hides it from candidate endpoints", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const plans = new PlanService(store);
    plans.registerThread({ id: "discard-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "discard-thread",
      title: "Discard through API",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Discard through API" }),
    });

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

  it("does not expose an API for manually creating a CandidatePlan", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "manual-candidate-thread", projectId: "project-1", parentThreadId: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorers/manual-candidate-thread/candidate",
      payload: { title: "Manual plan" },
    });

    expect(response.statusCode).toBe(404);
    expect(store.listPlans()).toEqual([]);
  });

  it("accepts ExplorerThread turns through the asynchronous v4 API", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const explorerPlanId = store.listExplorerPlans("thread-1")[0]!.id;

    const missingContext = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: { threadId: "thread-1", content: "Explore the repository", clientTurnId: "missing-context" },
    });
    expect(missingContext.statusCode).toBe(400);
    const sent = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: { threadId: "thread-1", explorerPlanId, content: "Explore the repository", clientTurnId: "client-1" },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().turn.assistant.status).toBe("RUNNING");
    const missingQueryContext = await app.inject({
      method: "GET",
      url: "/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-1",
    });
    expect(missingQueryContext.statusCode).toBe(400);
    const turns = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-1&explorerPlanId=${explorerPlanId}`,
    });
    expect(turns.json().items).toHaveLength(2);
  });

  it("supports ExplorerPlan CRUD, scoped workspaces, and Plan ownership validation", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store, "project-1");
    createTestProject(store, "project-2");
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-plans", projectId: "project-1", parentThreadId: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-plans/explorer-plans" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().items).toMatchObject([{ ordinal: 1, title: "Plan 1 / 待探索", messageCount: 0 }]);
    const created = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorers/thread-plans/explorer-plans" });
    expect(created.statusCode).toBe(201);
    const plan2 = created.json().explorerPlan;
    expect(plan2).toMatchObject({ ordinal: 2, title: "Plan 2 / 待探索", explorerThreadId: "thread-plans" });

    const plan1 = initial.json().items[0];
    const otherThread = plans.registerThread({ id: "thread-other", projectId: "project-1", parentThreadId: null });
    const otherThreadPlan = store.listExplorerPlans(otherThread.id)[0]!;
    plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-plans",
      explorerPlanId: plan1.id,
      title: "Task 1 candidate",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Task 1 candidate" }),
    });
    plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-plans",
      explorerPlanId: plan2.id,
      title: "Task 2 candidate",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Task 2 candidate" }),
    });
    store.saveTurn({
      id: "task-1-user",
      threadId: "thread-plans",
      role: "user",
      content: "Task 1 message",
      status: "COMPLETED",
      createdAt: "2026-09-19T10:00:00.000Z",
      sequence: 1,
      explorerPlanId: plan1.id,
    });
    store.saveTurn({
      id: "task-1-assistant",
      threadId: "thread-plans",
      role: "assistant",
      content: "Task 1 reply",
      status: "COMPLETED",
      createdAt: "2026-09-19T10:00:01.000Z",
      sequence: 2,
      explorerPlanId: plan1.id,
    });
    store.saveTurn({
      id: "task-2-user",
      threadId: "thread-plans",
      role: "user",
      content: "Task 2 message",
      status: "COMPLETED",
      createdAt: "2026-09-19T10:01:00.000Z",
      sequence: 3,
      explorerPlanId: plan2.id,
    });
    store.saveTurn({
      id: "task-2-assistant",
      threadId: "thread-plans",
      role: "assistant",
      content: "Task 2 reply",
      status: "COMPLETED",
      createdAt: "2026-09-19T10:01:01.000Z",
      sequence: 4,
      explorerPlanId: plan2.id,
    });
    const activatePlan1 = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorers/thread-plans/explorer-plans/${plan1.id}/activate`,
    });
    expect(activatePlan1.statusCode).toBe(200);

    const activeCandidate = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-plans/candidate" });
    const task1Candidate = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/thread-plans/candidate?explorerPlanId=${plan1.id}`,
    });
    const task2Candidate = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/thread-plans/candidate?explorerPlanId=${plan2.id}`,
    });
    expect(activeCandidate.statusCode).toBe(200);
    expect(activeCandidate.json().plan).toMatchObject({ title: "Task 1 candidate", explorerPlanId: plan1.id });
    expect(task1Candidate.json().plan).toMatchObject({ title: "Task 1 candidate", explorerPlanId: plan1.id });
    expect(task2Candidate.json().plan).toMatchObject({ title: "Task 2 candidate", explorerPlanId: plan2.id });

    const workspace = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/thread-plans/explorer-plans/${plan2.id}/workspace`,
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      explorerPlan: { id: plan2.id },
      inputRequests: [],
      candidate: { title: "Task 2 candidate", explorerPlanId: plan2.id },
    });
    expect(workspace.json().turns.map((turn: { id: string }) => turn.id)).toEqual(["task-2-user", "task-2-assistant"]);
    expect(workspace.json().activity.every((item: { explorerPlanId?: string }) => item.explorerPlanId === plan2.id)).toBe(true);
    const crossProject = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-2/explorers/thread-plans/explorer-plans/${plan2.id}/workspace`,
    });
    expect(crossProject.statusCode).toBe(404);
    const invalidTurnPlan = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: { threadId: "thread-plans", explorerPlanId: "missing-plan", content: "invalid", clientTurnId: "invalid-plan-turn" },
    });
    expect(invalidTurnPlan.statusCode).toBe(409);
    const crossThreadTurnPlan = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: {
        threadId: "thread-plans",
        explorerPlanId: otherThreadPlan.id,
        content: "invalid cross-thread requirement",
        clientTurnId: "cross-thread-plan-turn",
      },
    });
    expect(crossThreadTurnPlan.statusCode).toBe(409);
    const scopedTurns = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-plans&explorerPlanId=${plan2.id}`,
    });
    expect(scopedTurns.statusCode).toBe(200);
    expect(scopedTurns.json().items.map((turn: { id: string }) => turn.id)).toEqual(["task-2-user", "task-2-assistant"]);
    const crossThreadQuery = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-plans&explorerPlanId=${otherThreadPlan.id}`,
    });
    expect(crossThreadQuery.statusCode).toBe(404);
    const scopedActivity = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/thread-plans/activity?explorerPlanId=${plan2.id}`,
    });
    expect(scopedActivity.statusCode).toBe(200);
    expect(scopedActivity.json().items.map((item: { turnId: string }) => item.turnId)).toEqual(["task-2-user", "task-2-assistant"]);
    const missingActivityContext = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-plans/activity" });
    const missingInputContext = await app.inject({
      method: "GET",
      url: "/api/v4/projects/project-1/explorer-thread/input-requests?threadId=thread-plans",
    });
    const missingLoopContext = await app.inject({
      method: "GET",
      url: "/api/v4/projects/project-1/explorer-thread/agent-loops?threadId=thread-plans",
    });
    const missingEventContext = await app.inject({
      method: "GET",
      url: "/api/v4/projects/project-1/explorer-thread/events?threadId=thread-plans",
    });
    expect(missingActivityContext.statusCode).toBe(400);
    expect(missingInputContext.statusCode).toBe(400);
    expect(missingLoopContext.statusCode).toBe(400);
    expect(missingEventContext.statusCode).toBe(400);
  });

  it("returns an observable model failure instead of a successful blank assistant turn", async () => {
    const store = new InMemoryPipelineStore();
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "turn.failed", error: "Codex turn failed" };
      },
      async answerUserInput() {
        return undefined;
      },
      async cancel() {
        return undefined;
      },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);
    const plans = new (await import("@pipeline-factory/domain")).PlanService(store);
    createTestProject(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });

    const explorerPlanId = store.listExplorerPlans("thread-1")[0]!.id;
    const response = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: { threadId: "thread-1", explorerPlanId, content: "hello", clientTurnId: "client-failure" },
    });

    expect(response.statusCode).toBe(202);
    for (let attempt = 0; attempt < 50 && store.listTurns("thread-1")[1]?.status !== "FAILED"; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "FAILED", content: "模型调用失败：Codex turn failed" });
  });

  it("projects only requirement status metadata and validates status-stream ownership", async () => {
    const store = new InMemoryPipelineStore();
    const project = createTestProject(store);
    const plans = new PlanService(store);
    const thread = plans.registerThread({ id: "status-stream-thread", projectId: project.id, parentThreadId: null });
    const requirement = store.listExplorerPlans(thread.id)[0]!;
    const app = createApp({ store, seed: false });
    apps.push(app);
    const missingThread = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/explorer-thread/requirement-status/events?threadId=missing-thread`,
    });
    expect(missingThread.statusCode).toBe(404);
    const event: DomainEvent = {
      id: "status-event-1",
      sequence: 7,
      type: "explorer.requirement.status.changed",
      aggregateId: thread.id,
      occurredAt: "2026-09-25T12:00:00.000Z",
      payload: {
        explorerPlanId: requirement.id,
        turnId: "turn-1",
        status: "RUNNING",
        occurredAt: "2026-09-25T12:00:00.000Z",
        text: "SECRET-CONVERSATION-BODY",
        prompt: "private prompt",
      },
    };
    const projected = sanitizeExplorerRequirementStatusEvent(store, thread, event);
    expect(projected).toEqual({
      sequence: 7,
      payload: { explorerPlanId: requirement.id, turnId: "turn-1", status: "RUNNING", occurredAt: "2026-09-25T12:00:00.000Z" },
    });
    expect(JSON.stringify(projected)).not.toContain("SECRET-CONVERSATION-BODY");
    expect(JSON.stringify(projected)).not.toContain("private prompt");
    expect(sanitizeExplorerRequirementStatusEvent(store, { ...thread, id: "another-thread" }, event)).toBeNull();
    expect(sanitizeExplorerRequirementStatusEvent(store, thread, { ...event, type: "explorer.turn.text.delta" })).toBeNull();
  });

  it("dispatches an Enqueued plan only through the injected Scheduler", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Start from API",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Start from API" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ planId: plan.id, status: "IN_PROGRESS" });
  });

  it("creates a new confirmed revision after configuration blocks dispatch", async () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    const project = projects.create({
      id: "project-configuration",
      name: "Configuration",
      repoRoot: "/repo/project-configuration",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-configuration-worktrees",
      settings: { commands: [] },
    });
    const plans = new PlanService(store, projects);
    plans.registerThread({ id: "configuration-thread", projectId: project.id, parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: project.id,
      sourceExplorerThreadId: "configuration-thread",
      title: "Recover configuration",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Recover configuration" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const dispatched = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    expect(dispatched.json()).toMatchObject({ run: null, dispatch: { status: "WAITING", waitReason: "NEEDS_CONFIGURATION" } });
    const unresolved = await app.inject({
      method: "POST",
      url: `/api/v4/plans/${plan.id}/revise-configuration`,
      payload: { actorId: "reviewer" },
    });
    expect(unresolved.statusCode).toBe(409);
    expect(unresolved.json()).toMatchObject({
      code: "PLAN_CONFIGURATION_REVISION_FAILED",
      error: "RUN_PREREQUISITES_UNSATISFIED: missing registered commands: project.test, project.typecheck",
    });
    const configured = projects.update(project.id, {
      expectedConfigVersion: project.configVersion,
      settings: {
        ...project.settings,
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["true"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["true"] },
        ],
      },
    });

    const revised = await app.inject({
      method: "POST",
      url: `/api/v4/plans/${plan.id}/revise-configuration`,
      payload: { actorId: "reviewer" },
    });

    expect(revised.statusCode, JSON.stringify(revised.json())).toBe(200);
    expect(revised.json()).toMatchObject({
      plan: { id: plan.id, revision: 2, status: "READY", queuedAt: null, dispatchedAt: null, runId: null },
    });
    expect(store.getRevision(plan.id, 1)?.projectConfigVersion).toBe(project.configVersion);
    expect(store.getRevision(plan.id, 2)?.projectConfigVersion).toBe(configured.configVersion);
    expect(store.getDispatchState(plan.id)).toBeUndefined();
  });

  it("routes direct Run requests without global concurrency limits", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "coordinator-run-thread", projectId: "project-1", parentThreadId: null });
    const first = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "coordinator-run-thread",
      title: "First direct run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "First direct run" }),
    });
    const second = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "coordinator-run-thread",
      title: "Second direct run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Second direct run" }),
    });
    plans.confirm(first.id, "user-1");
    plans.enqueue(first.id);
    plans.confirm(second.id, "user-1");
    plans.enqueue(second.id);
    // 没有 config 时全局容量不限（缺省=不限制）；容量语义的用例在 dispatch-coordinator.test.ts。
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const firstResponse = await app.inject({ method: "POST", url: `/api/v4/plans/${first.id}/run` });
    const secondResponse = await app.inject({ method: "POST", url: `/api/v4/plans/${second.id}/run` });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({ run: { planId: second.id }, dispatch: { planId: second.id, status: "RUNNING" } });
    expect(store.listRuns()).toHaveLength(2);
  });

  it("separates thread Plans, unconfirmed candidates, and confirmed Project tasks", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    const thread = plans.registerThread({ id: "multi-plan-thread", projectId: "project-1", parentThreadId: null });
    const [requirement] = store.listExplorerPlans(thread.id);
    const first = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: thread.id,
      explorerPlanId: requirement!.id,
      title: "First independent Plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "First independent Plan" }),
    });
    const second = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: thread.id,
      explorerPlanId: requirement!.id,
      title: "Second independent Plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Second independent Plan" }),
    });
    plans.reviseCandidate(
      second.id,
      {
        title: "Second independent Plan V2",
        resolvedContract: { ...second.resolvedContract, objective: { ...second.resolvedContract.objective, goal: "Updated second Plan" } },
      },
      { sourceTurnId: "turn-v2", providerThreadId: null, providerTurnId: null, providerItemId: null },
    );
    plans.confirm(first.id, "user-1");
    const app = createApp({ store, seed: false });
    apps.push(app);

    const threadPlans = await app.inject({ method: "GET", url: `/api/v4/projects/project-1/explorers/${thread.id}/all-plans` });
    const candidates = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/candidate-plans" });
    const tasks = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/tasks" });
    const versions = await app.inject({ method: "GET", url: `/api/v4/plans/${second.id}/candidate-versions` });
    const olderVersion = await app.inject({ method: "GET", url: `/api/v4/plans/${second.id}/candidate-versions/1` });
    const staleConfirm = await app.inject({
      method: "POST",
      url: `/api/v4/plans/${second.id}/revisions/1/confirm`,
      payload: { actorId: "user-1" },
    });
    const selected = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorers/${thread.id}/explorer-plans/${requirement!.id}/selected-plan`,
      payload: { planId: null },
    });
    const workspace = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/${thread.id}/explorer-plans/${requirement!.id}/workspace`,
    });

    expect(threadPlans.json().items.map((plan: { id: string }) => plan.id)).toEqual([first.id, second.id]);
    expect(candidates.json().items).toMatchObject([{ id: second.id, revision: 2, title: "Second independent Plan V2" }]);
    expect(tasks.json().items.map((plan: { id: string }) => plan.id)).toEqual([first.id]);
    expect(versions.json().items).toMatchObject([
      { revision: 1, isLatest: false, readOnly: true },
      { revision: 2, isLatest: true, readOnly: false },
    ]);
    expect(olderVersion.json()).toMatchObject({ version: { revision: 1, title: "Second independent Plan" }, readOnly: true });
    expect(staleConfirm.statusCode).toBe(409);
    expect(staleConfirm.json()).toMatchObject({ code: "REVISION_NOT_LATEST" });
    expect(selected.json().explorerPlan).toMatchObject({ candidatePlanId: null, newPlanRequested: true });
    expect(workspace.json()).toMatchObject({ explorerPlan: { candidatePlanId: null, newPlanRequested: true }, candidate: null });
  });

  it("confirms and starts a candidate in one idempotent server flow", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    const thread = plans.registerThread({ id: "confirm-start-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: thread.id,
      title: "Confirm starts Run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Confirm starts Run" }),
    });
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v4/plans/${plan.id}/revisions/1/confirm`,
      payload: { actorId: "user-1" },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v4/plans/${plan.id}/revisions/1/confirm`,
      payload: { actorId: "user-1" },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      plan: { status: "IN_PROGRESS", revision: 1 },
      run: { planId: plan.id, planRevision: 1 },
      confirmation: { stage: "RUN_STARTED" },
    });
    expect(duplicate.json().run.id).toBe(confirmed.json().run.id);
    expect(store.listRuns().filter((run) => run.planId === plan.id && run.planRevision === 1)).toHaveLength(1);
  });

  it("keeps an enqueued plan out of scheduler state until Start run", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "auto-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "auto-thread",
      title: "Automatic API dispatch",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Automatic API dispatch" }),
    });
    plans.confirm(plan.id, "user-1");
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async ({ runId }) => ({ path: `/tmp/${runId}`, branch: `factory/${runId}`, baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const enqueued = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/enqueue` });
    const fetched = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });

    expect(enqueued.statusCode).toBe(200);
    expect(enqueued.json()).toMatchObject({ plan: { id: plan.id, status: "ENQUEUED", dispatchedAt: null }, dispatch: null });
    expect(fetched.json()).toMatchObject({ plan: { id: plan.id, status: "ENQUEUED" }, dispatch: null });
    expect(store.listRuns()).toEqual([]);
  });

  it("creates and approves a ChangeProposal through the v4 API without switching the old Run revision", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store, "project-change");
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-change", projectId: "project-change", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-change",
      sourceExplorerThreadId: "thread-change",
      title: "Change API plan",
      resolvedContract: planContractFixture({ store, projectId: "project-change", title: "Change API plan" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/change-api", branch: "factory/change-api", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const run = started.json().run as { id: string };
    const resolvedContract = {
      ...plan.resolvedContract,
      scope: { ...plan.resolvedContract.scope, includePaths: [...plan.resolvedContract.scope.includePaths, "docs/*"] },
    };
    const created = await app.inject({
      method: "POST",
      url: `/api/v4/runs/${run.id}/change-proposals`,
      payload: { reason: "Documentation is in scope", requestedChanges: ["Include docs"], resolvedContract },
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v4/change-proposals/${created.json().proposal.id}/approve`,
      payload: { actorId: "reviewer" },
    });

    expect(created.statusCode).toBe(201);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      revision: { revision: 2 },
      plan: { status: "ENQUEUED", dispatchedAt: null, runId: null },
      run: null,
    });
    expect(store.getRun(run.id)?.planRevision).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("NEEDS_PLAN_CHANGE");
  });

  it("verifies a run, opens a merge request, and confirms the reviewed commit", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Review from API",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Review from API" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
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
    const merged = await app.inject({
      method: "POST",
      url: `/api/v4/merge-requests/${mergeRequestId}/confirm-merged`,
      payload: { targetCommit: "abc123" },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().mergeRequest.status).toBe("MERGED");
    expect(store.getPlan(plan.id)?.status).toBe("MERGED");
    expect(store.getDispatchState(plan.id)?.status).toBe("COMPLETED");
  });

  it("reconciles externally merged runs within the requested project", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-reconcile", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-reconcile",
      title: "Reconcile from API",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Reconcile from API" }),
    });
    const configuredPlan = store.updatePlan({
      ...plan,
      resolvedContract: {
        ...plan.resolvedContract,
        repository: { ...plan.resolvedContract.repository, baseBranch: "main", baseCommit: "base" },
      },
    });
    plans.confirm(configuredPlan.id, "user-1");
    const run = {
      id: "run-reconcile",
      projectId: "project-1",
      planId: plan.id,
      planRevision: 1,
      status: "MERGE_READY",
      branch: "factory/run-reconcile",
      workspacePath: "/workspace/run-reconcile",
      baseCommit: "base",
      executionThreadId: "thread-run-reconcile",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    } as const;
    store.saveRun(run);
    store.updatePlan({ ...store.getPlan(plan.id)!, status: "MERGE_READY", runId: run.id, queuedAt: new Date().toISOString() });
    store.saveVerificationRun({
      id: "verification-reconcile",
      runId: run.id,
      status: "PASSED",
      repairAttempts: 0,
      commandResults: [],
      completedAt: new Date().toISOString(),
    });
    const mergeService = new MergeService(store, {
      git: {
        commitExists: (_repoRoot, commit) => ["source", "target"].includes(commit),
        resolveCommit: (_repoRoot, ref) => (ref === "HEAD" ? "source" : ref === "main" ? "target" : null),
        isAncestor: (_repoRoot, source, target) => source === "source" && target === "target",
        branchContains: () => true,
      },
    });
    const app = createApp({ store, mergeService, seed: false });
    apps.push(app);

    const reconciled = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/merge-reconciliation" });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().items[0]).toMatchObject({
      runId: run.id,
      planId: plan.id,
      outcome: "DETECTED",
      targetCommit: "target",
      mergeRequest: { status: "OPEN", detectedTargetCommit: "target" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/plans" });
    expect(listed.json().items[0]).toMatchObject({ mergeRequest: { status: "OPEN", detectedTargetCommit: "target" } });
    const details = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });
    expect(details.json()).toMatchObject({ mergeRequest: { status: "OPEN", detectedTargetCommit: "target" } });

    const requestId = reconciled.json().items[0].mergeRequest.id as string;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v4/merge-requests/${requestId}/confirm-merged`,
      payload: { targetCommit: "target" },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().mergeRequest.status).toBe("MERGED");
    expect(store.getPlan(plan.id)?.status).toBe("MERGED");
  });

  it("pauses, resumes, and journals bounded user guidance for a run", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Control from API",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Control from API" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    const paused = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/pause` });
    expect(paused.statusCode).toBe(200);
    const guidance = await app.inject({
      method: "POST",
      url: `/api/v4/runs/${runId}/guidance`,
      payload: { content: "Keep the approved scope only" },
    });
    expect(guidance.statusCode).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/resume` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().thread.state).toBe("ACTIVE");
    expect(store.getExecutionThread(started.json().run.executionThreadId)?.journal.some((entry) => entry.type === "USER_GUIDANCE")).toBe(
      true,
    );
  });

  /**
   * `mode` 是投递方式，不是"这条要求重不重要"。HTTP 用小写、领域枚举用大写，这一层是那条翻译边——
   * 认不出来的取值必须在**入口**就被拒，而不是等到投递时才发现它落进了一个没人懂的分支。
   */
  it("validates the guidance delivery mode at the edge", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Guidance modes",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Guidance modes" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);
    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;

    const unknown = await app.inject({
      method: "POST",
      url: `/api/v4/runs/${runId}/guidance`,
      payload: { content: "试试", mode: "shout" },
    });
    expect(unknown.statusCode).toBe(400);

    // 没有在跑的 Loop 时 `auto` 与两种显式模式等价：都收下，都记成 QUEUE（那正是接下来实际走的那条路）。
    const auto = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/guidance`, payload: { content: "补一句", mode: "auto" } });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().guidance).toMatchObject({ mode: "QUEUE", status: "PENDING" });
  });

  it("terminates a run and synchronizes its Plan status", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Terminate stale run",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Terminate stale run" }),
    });
    plans.confirm(plan.id, "user-1");
    plans.enqueue(plan.id);
    const scheduler = new Scheduler({
      store,
      workspace: { create: async () => ({ path: "/tmp/run", branch: "factory/run", baseCommit: "abc" }), remove: async () => undefined },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const started = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/run` });
    const runId = started.json().run.id as string;
    store.saveAgentLoop({
      id: "loop-stale",
      ownerType: "run",
      ownerId: runId,
      role: "executor",
      mode: "provider-controlled",
      state: "RUNNING",
      stepCount: 1,
      maxSteps: 40,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });
    const cancelled = await app.inject({ method: "POST", url: `/api/v4/runs/${runId}/cancel`, payload: { reason: "stale_run" } });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run).toMatchObject({ id: runId, status: "CANCELLED" });
    expect(store.getAgentLoop("loop-stale")).toMatchObject({ state: "CANCELLED" });
    expect(store.getExecutionThread(cancelled.json().run.executionThreadId)?.state).toBe("CANCELLED");
    expect(store.getPlan(plan.id)).toMatchObject({ status: "BLOCKED", attentionReason: "Run cancelled: stale_run" });
  });

  it("supports asynchronous v4 turns and structured answers", async () => {
    const store = new InMemoryPipelineStore();
    createGitBackedTestProject(store);
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const explorerPlanId = store.listExplorerPlans("thread-1")[0]!.id;
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
          yield {
            type: "turn.input_required",
            request: {
              requestId: "request-1",
              threadId: "provider-thread-1",
              turnId: "provider-turn-1",
              itemId: "item-1",
              questions: [
                {
                  id: "q1",
                  header: "选择",
                  question: "请选择",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "方案 A", description: "A" },
                    { label: "方案 B", description: "B" },
                  ],
                },
              ],
              isBlocking: true,
            },
          };
          resumeOrder.push("stream-resumed");
          yield { type: "text.delta", text: "已记录选择，继续完善。" };
        } else {
          yield {
            type: "text.delta",
            text: `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify({ schemaVersion: 2, title: "API generated plan", artifact: { mode: "REPOSITORY_FILE", path: "apps/api/server.ts" }, objective: { goal: "Complete the requested system design", context: ["现状：接口还没有这套能力"], audience: ["接口使用者"], acceptanceCriteria: ["The approved scope is implemented"], outOfScope: [] }, design: { technicalConstraints: ["沿用现有接口"], dataSecurity: ["不引入新凭据"], failureHandling: ["失败时保持原行为"], risks: ["回滚：还原这次改动"] }, scope: { includePaths: ["apps/api/server.ts"], excludePaths: ["deploy/*"] }, tasks: [{ id: "task-1", title: "Implement the approved scope", dependencies: [], status: "READY", changes: [{ path: "apps/api/server.ts", action: "modify", detail: "接上新的接口" }] }], dependencies: [], conflicts: [], execution: { maxRepairAttempts: 2 }, verification: { mode: "PROJECT_DEFAULT" }, merge: { strategy: "manual", requireHumanMerge: true } })}</pipeline-factory-plan>`,
          };
        }
        yield { type: "turn.completed" };
      },
      async answerUserInput() {
        resumeOrder.push("answer-called");
      },
      async cancel() {
        /* 本用例不走取消路径 */
      },
    };
    const app = createApp({ store, model, seed: false });
    apps.push(app);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: { threadId: "thread-1", explorerPlanId, content: "继续探索", clientTurnId: "client-1" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().turn.assistant.status).toBe("RUNNING");
    const turnsWithCursor = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorer-thread/turns?threadId=thread-1&explorerPlanId=${explorerPlanId}`,
    });
    expect(turnsWithCursor.statusCode).toBe(200);
    expect(turnsWithCursor.json().lastEventSequence).toEqual(expect.any(Number));
    let input = store.listInputRequests("thread-1", "OPEN")[0];
    for (let attempt = 0; !input && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      input = store.listInputRequests("thread-1", "OPEN")[0];
    }
    expect(input).toBeDefined();
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`,
      payload: { clientRequestId: "bad", answers: { q1: { answers: ["方案 X", "方案 A"] } } },
    });
    expect(invalid.statusCode).toBe(409);
    const answered = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`,
      payload: { clientRequestId: "answer-1", answers: { q1: { answers: ["方案 A", "方案 B"] } } },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().request.status).toBe("ANSWERED");
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorer-thread/input-requests/${input!.id}/answer`,
      payload: { clientRequestId: "answer-1", answers: { q1: { answers: ["方案 A", "方案 B"] } } },
    });
    expect(duplicate.statusCode).toBe(200);
    for (let attempt = 0; attempt < 50 && store.listPlans().length === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(store.listTurns("thread-1")[1]).toMatchObject({ status: "COMPLETED", content: "已记录选择，继续完善。" });
    expect(resumeOrder).toEqual(["answer-called", "stream-resumed"]);
    const candidate = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers/thread-1/candidate" });
    expect(candidate.statusCode).toBe(200);
    expect(candidate.json().plan).toMatchObject({ title: "API generated plan", status: "DRAFT" });
    expect(store.getThread("thread-1")).toMatchObject({ exploration: { status: "READY" } });
    const activity = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/thread-1/activity?explorerPlanId=${explorerPlanId}`,
    });
    expect(activity.statusCode).toBe(200);
    expect(JSON.stringify(activity.json().items)).not.toContain("pipeline-factory-plan");
    expect(
      activity.json().items.some((item: { details?: { title?: string } | null }) => item.details?.title === "API generated plan"),
    ).toBe(true);
  });

  it("creates and lists isolated business Explorers without reusing the old context", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    store.saveThread({
      id: "old-explorer",
      projectId: "project-1",
      parentThreadId: null,
      title: "Old exploration",
      providerThreadId: "provider-old",
    });
    store.saveTurn({
      id: "old-turn",
      threadId: "old-explorer",
      role: "user",
      content: "old plan",
      status: "COMPLETED",
      createdAt: store.now(),
      sequence: 1,
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorers",
      payload: { title: "Fresh requirement" },
    });
    expect(created.statusCode).toBe(201);
    const fresh = created.json().explorer;
    expect(fresh).toMatchObject({ projectId: "project-1", title: "Fresh requirement", contextMode: "FRESH", providerThreadId: null });
    expect(store.listTurns(fresh.id)).toEqual([]);
    expect(store.getThread("old-explorer")?.state).toBe("ACTIVE");
    new PlanService(store).registerThread({ id: "replacement-explorer", projectId: "project-1", parentThreadId: null });

    const listed = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/explorers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(fresh.id);
    const archived = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorers/${fresh.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().explorer.state).toBe("ARCHIVED");
    expect(store.listTurns(fresh.id)).toEqual([]);
  });

  it("rejects archiving the current Explorer and starting turns on archived Explorers", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    const archived = plans.registerThread({ id: "archived-explorer", projectId: "project-1", parentThreadId: null });
    store.updateThread({ ...archived, state: "ARCHIVED" });
    const current = plans.registerThread({ id: "current-explorer", projectId: "project-1", parentThreadId: null });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const archiveCurrent = await app.inject({ method: "POST", url: `/api/v4/projects/project-1/explorers/${current.id}/archive` });
    const startArchived = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/explorer-thread/turns",
      payload: {
        threadId: archived.id,
        explorerPlanId: store.listExplorerPlans(archived.id)[0]!.id,
        content: "继续探索",
        clientTurnId: "archived-turn",
      },
    });

    expect(archiveCurrent.statusCode).toBe(409);
    expect(archiveCurrent.json()).toMatchObject({ code: "EXPLORER_ARCHIVE_NOT_ALLOWED" });
    expect(startArchived.statusCode).toBe(409);
    expect(startArchived.json().error).toContain("archived");
    expect(store.getThread(current.id)?.state).toBe("ACTIVE");
    expect(store.listTurns(archived.id)).toEqual([]);
  });

  it("creates an Explorer with a timestamp placeholder and locks manual renames", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/explorers" });
    expect(created.statusCode).toBe(201);
    const explorer = created.json().explorer;
    expect(explorer.title).toMatch(/^project-1-\d{8}-\d{2}:\d{2}:\d{2}$/);
    expect(explorer).toMatchObject({ titleSource: "AUTO", titleStatus: "GENERATED" });

    const renamed = await app.inject({
      method: "POST",
      url: `/api/v4/projects/project-1/explorers/${explorer.id}/rename`,
      payload: { title: "人工名称" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().explorer).toMatchObject({ title: "人工名称", titleSource: "MANUAL" });
  });

  it("projects Agent Loop steps as ordered Explorer activity items", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    store.saveThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const explorerPlanId = store.listExplorerPlans("explorer-1")[0]!.id;
    store.saveTurn({
      id: "user-1",
      threadId: "explorer-1",
      role: "user",
      content: "hello",
      status: "COMPLETED",
      createdAt: "2026-08-29T10:00:00.000Z",
      sequence: 1,
      explorerPlanId,
    });
    store.saveTurn({
      id: "assistant-1",
      threadId: "explorer-1",
      role: "assistant",
      content: "hello",
      status: "COMPLETED",
      createdAt: "2026-08-29T10:00:01.000Z",
      sequence: 2,
      explorerPlanId,
    });
    store.saveAgentLoop({
      id: "loop-1",
      ownerType: "explorer-turn",
      ownerId: "assistant-1",
      role: "explorer",
      mode: "provider-controlled",
      state: "COMPLETED",
      stepCount: 1,
      maxSteps: 40,
      startedAt: "2026-08-29T10:00:00.500Z",
      completedAt: "2026-08-29T10:00:02.000Z",
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });
    store.appendAgentLoopStep({
      loopId: "loop-1",
      stepType: "MODEL_TEXT_DELTA",
      status: "COMPLETED",
      payload: { text: "hello" },
      occurredAt: "2026-08-29T10:00:01.000Z",
    });
    store.appendAgentLoopStep({
      loopId: "loop-1",
      stepType: "TOOL_REQUESTED",
      status: "RUNNING",
      callId: "call-1",
      payload: { tool: "read_file" },
      occurredAt: "2026-08-29T10:00:01.100Z",
    });
    const app = createApp({ store, seed: false });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v4/projects/project-1/explorers/explorer-1/activity?explorerPlanId=${explorerPlanId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { kind: string }) => item.kind)).toEqual(["USER_MESSAGE", "ASSISTANT_MESSAGE", "TOOL_CALL"]);
  });

  it("exposes the Plan and Run lifecycle only through the v4 API", async () => {
    const store = new InMemoryPipelineStore();
    createTestProject(store);
    const plans = new PlanService(store);
    plans.registerThread({ id: "v4-only-thread", projectId: "project-1", parentThreadId: null });
    const plan = plans.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "v4-only-thread",
      title: "v4-only plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "v4-only plan" }),
    });
    const scheduler = new Scheduler({
      store,
      workspace: {
        create: async () => ({ path: "/tmp/v4-only", branch: "factory/v4-only", baseCommit: "abc" }),
        remove: async () => undefined,
      },
      hooks: new LifecycleHookRunner(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const app = createApp({ store, scheduler, seed: false });
    apps.push(app);

    const legacyPlan = await app.inject({ method: "GET", url: "/api/" + "v" + "3" + `/plans/${plan.id}` });
    const v4Plan = await app.inject({ method: "GET", url: `/api/v4/plans/${plan.id}` });
    const confirmed = await app.inject({ method: "POST", url: `/api/v4/plans/${plan.id}/confirm`, payload: { actorId: "user-1" } });
    const runId = confirmed.json().run.id as string;
    const run = await app.inject({ method: "GET", url: `/api/v4/runs/${runId}` });

    expect(legacyPlan.statusCode).toBe(404);
    expect(v4Plan.statusCode).toBe(200);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      plan: { id: plan.id, status: "IN_PROGRESS", dispatchedAt: expect.any(String) },
      run: { id: runId, planId: plan.id },
      confirmation: { stage: "RUN_STARTED" },
    });
    expect(store.listRuns()).toHaveLength(1);
    expect(run.statusCode).toBe(200);
    expect(run.json().run.id).toBe(runId);
  });
});
