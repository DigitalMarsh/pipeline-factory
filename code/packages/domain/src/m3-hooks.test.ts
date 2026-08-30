/**
 * 测试职责：验证 m3-hooks 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { RegisteredCommandExecutor, type HookContext } from "./index.js";

describe("RegisteredCommandExecutor", () => {
  it("runs only fixed registered argv and injects structured HookContext", async () => {
    let received: { argv: string[]; cwd: string; timeoutMs: number; env: Record<string, string> } | null = null;
    const executor = new RegisteredCommandExecutor([
      { commandId: "project.start", argv: ["node", "scripts/start.mjs"], environment: { PIPELINE_TEST_FIXED: "fixed-from-config" } },
    ], async (argv, cwd, timeoutMs, env) => {
      received = { argv, cwd, timeoutMs, env };
      return { exitCode: 0, stdout: "ready", stderr: "" };
    });
    const context: HookContext = { projectId: "project-1", runId: "run-1", workspacePath: "/tmp/worktree", branch: "factory/run-1", baseCommit: "abc", exitReason: "running" };
    await executor.execute({ commandId: "project.start", cwd: "/tmp/worktree", timeoutMs: 5000, context });

    expect(received).toMatchObject({ argv: ["node", "scripts/start.mjs"], cwd: "/tmp/worktree", timeoutMs: 5000, env: { PIPELINE_TEST_FIXED: "fixed-from-config", PIPELINE_PROJECT_ID: "project-1", PIPELINE_RUN_ID: "run-1", PIPELINE_WORKSPACE_PATH: "/tmp/worktree", PIPELINE_BRANCH: "factory/run-1", PIPELINE_BASE_COMMIT: "abc", PIPELINE_EXIT_REASON: "running" } });
    await expect(executor.execute({ commandId: "unregistered", cwd: "/tmp/worktree", timeoutMs: 5000, context })).resolves.toMatchObject({ exitCode: 127 });
  });
});
