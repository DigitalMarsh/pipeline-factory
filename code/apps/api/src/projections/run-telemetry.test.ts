/**
 * 测试职责：锁住 Run 遥测投影的两个契约 —— **已有的记录必须原样带过去**，以及
 *   **没有记录时回退到这次 Run 冻结的项目配置**（而不是回退到"当前"项目设置）。
 *
 * 为什么值得单独测：投影是每次读 Run 时现算的，它**不写库**，所以错了也不会留下痕迹。
 *   本文件对应的真实缺陷是：重建 telemetry 对象时漏搬 `backend`，于是库里记着
 *   `codex-app-server`、界面上"AGENT"一栏却永远是"未记录"——数据是对的，展示是丢的。
 *
 * 维护提示：
 *   1) 新增遥测字段时在这里补一条"existing 里有值 → 投影后还在"的断言。
 *   2) 回退顺序是契约，不要为了让某个用例好写而调换。**`backend` 是唯一的例外，而且是被
 *      证据逼出来的**：它只由 `agent.loop.started` 的端点指纹写入，那个指纹是配置推导的、
 *      不是 Provider 上报的；指纹早先只吃角色名，于是一律按**全局**角色默认算，项目覆盖了
 *      执行侧后端时它就指向一个没跑过的后端（现场：冻结配置与当前项目都写 claude-agent-sdk，
 *      2026-10-07 那条 Run 的记录里却是 codex-app-server，用量栏据此显示 Agent=Codex 而
 *      模型=claude-opus-5）。根因已在 agent-loop 修掉（现在会把 effectiveModelConfig 传下去），
 *      所以**修好之后两个来源本就一致**，这条优先级的翻转只会纠正旧记录、不会覆盖新事实。
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryPipelineStore,
  PlanService,
  ProjectService,
  type ExecutionTelemetry,
  type PlanRevision,
  planContractFixture,
} from "@pipeline-factory/domain";
import { projectRunThreadTelemetry, resolveRunExecutorConfig } from "./run-telemetry.js";

/** `frozenBackend: null` 表示冻结配置里**没写**后端——那一格就跟随全局，只能由指纹回答。 */
function seed(store: InMemoryPipelineStore, telemetry: ExecutionTelemetry | null, frozenBackend: string | null = "claude-agent-sdk") {
  const projects = new ProjectService(store);
  const project = projects.create({
    id: "project-1",
    name: "Demo",
    repoRoot: "/repo/demo",
    defaultBranch: "main",
    worktreeRoot: "/tmp/demo-worktrees",
  });
  const plans = new PlanService(store, projects);
  const candidate = plans.createCandidatePlan({
    projectId: project.id,
    sourceExplorerThreadId: "explorer-1",
    title: "Run telemetry",
    resolvedContract: planContractFixture({ store, projectId: project.id, title: "Run telemetry" }),
  });
  const snapshot = projects.snapshot(project.id);
  // 快照里的 executor 与"当前项目设置"**故意不同**：只有这样才测得出"快照优先"。
  const revision = {
    planId: candidate.id,
    revision: 1,
    resolvedContract: candidate.resolvedContract,
    artifactHash: "sha256:test",
    confirmedBy: "tester",
    confirmedAt: store.now(),
    sourceExplorerThreadId: "explorer-1",
    projectConfigVersion: snapshot.configVersion,
    projectConfigHash: snapshot.configHash,
    projectConfigSnapshot: {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        models: {
          ...snapshot.settings.models,
          executor: {
            ...snapshot.settings.models.executor,
            model: "frozen-at-confirm",
            ...(frozenBackend ? { backend: frozenBackend } : {}),
          },
        },
      },
    },
  } as unknown as PlanRevision;
  store.saveRevision(revision);
  const thread = store.saveExecutionThread({ id: "execution-thread-1", runId: "run-1", state: "ACTIVE", journal: [], telemetry });
  // Run 必须指向**真实的** Plan id：用占位字符串的话投影找不到 Revision，于是"快照优先"那条断言
  // 实际上走的是"没有快照"的分支，测试还会以为自己验的是快照。
  return { project, thread, run: { id: "run-1", planId: candidate.id, planRevision: 1, projectId: project.id } };
}

const recorded: ExecutionTelemetry = {
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  backend: "codex-app-server",
  startedAt: "2026-10-01T02:52:14.765Z",
  completedAt: "2026-10-01T02:55:22.200Z",
  durationMs: 187435,
  usage: { inputTokens: 191197, outputTokens: 2313, reasoningTokens: 738, totalTokens: 193510 },
  usageSource: "provider",
  usageScope: "total",
};

describe("projectRunThreadTelemetry", () => {
  it("carries every recorded fact through", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, recorded);

    const projected = projectRunThreadTelemetry(store, seeded.run, seeded.thread).telemetry;

    // 这条就是那个真实缺陷的回归断言：漏搬 backend 时它会变成 undefined。
    // 注意 backend 的**取值**来自冻结配置而不是记录（见下面的用例与文件头维护提示 2）。
    expect(projected).toMatchObject({
      model: "gpt-5.6-luna",
      backend: "claude-agent-sdk",
      reasoningEffort: "high",
      durationMs: 187435,
      usageSource: "provider",
    });
    expect(projected?.usage?.inputTokens).toBe(191197);
  });

  /**
   * 记录里写 codex、冻结配置写 claude-agent-sdk —— 这正是 2026-10-07 那条 Run 的形状：
   * 指纹当时按**全局**角色默认算，而项目把执行侧覆盖成了 claude。冻结配置才是路由真正用的
   * 那个后端，所以它赢。
   */
  it("**冻结配置写了后端时以它为准**，即使记录里是另一个", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, recorded);

    const projected = projectRunThreadTelemetry(store, seeded.run, seeded.thread).telemetry;

    expect(recorded.backend).toBe("codex-app-server");
    expect(projected?.backend).toBe("claude-agent-sdk");
  });

  it("冻结配置没写后端（跟随全局）时，才用记录的指纹回答那时全局是哪个", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, recorded, null);

    const projected = projectRunThreadTelemetry(store, seeded.run, seeded.thread).telemetry;

    expect(projected?.backend).toBe("codex-app-server");
  });

  it("falls back to the Run's frozen config when nothing was recorded yet", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, null);

    const projected = projectRunThreadTelemetry(store, seeded.run, seeded.thread).telemetry;

    // 快照优先：不是当前项目设置里的那一份。
    expect(projected).toMatchObject({ model: "frozen-at-confirm", backend: "claude-agent-sdk" });
    // 用量没有记录就是没有，**不估算**。
    expect(projected?.usage).toBeNull();
    expect(projected?.usageSource).toBe("not-recorded");
  });

  it("still reports the run window from the executor loop when telemetry is empty", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, null);
    store.saveAgentLoop({
      id: "loop-1",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "provider-controlled",
      state: "COMPLETED",
      stepCount: 3,
      maxSteps: 40,
      startedAt: "2026-10-01T02:52:14.765Z",
      completedAt: "2026-10-01T02:55:22.200Z",
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });

    const projected = projectRunThreadTelemetry(store, seeded.run, seeded.thread).telemetry;

    expect(projected?.startedAt).toBe("2026-10-01T02:52:14.765Z");
    expect(projected?.durationMs).toBe(187435);
  });
});

describe("resolveRunExecutorConfig", () => {
  it("prefers the frozen Revision snapshot over the current project settings", () => {
    const store = new InMemoryPipelineStore();
    const seeded = seed(store, null);

    expect(resolveRunExecutorConfig(store, seeded.run)).toEqual({
      model: "frozen-at-confirm",
      backend: "claude-agent-sdk",
      reasoningEffort: null,
    });
  });

  it("returns null instead of inventing a model when neither source exists", () => {
    const store = new InMemoryPipelineStore();

    expect(resolveRunExecutorConfig(store, { planId: "plan-missing", planRevision: 1 })).toBeNull();
  });
});
