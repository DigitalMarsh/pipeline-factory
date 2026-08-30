/**
 * 测试职责：验证 builtin-tool-executor 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolGateway, type CommandInvocation, type CommandResult, type ToolCall } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function call(tool: ToolCall["tool"], input: Record<string, unknown>, callId = String(tool) + "-1"): ToolCall {
  return { callId, tool, input };
}

describe("BuiltinToolExecutor", () => {
  it("executes scoped file, listing, and search tools without a custom handler", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-tools-"));
    directories.push(workspace);
    const gateway = new ToolGateway({ role: "executor", workspaceRoot: workspace });

    await expect(gateway.call(call("write_file", { path: "src/index.ts", content: "export const answer = 42;\n" }))).resolves.toMatchObject({ allowed: true, result: { path: "src/index.ts" } });
    await expect(gateway.call(call("read_file", { path: "src/index.ts" }, "read-1"))).resolves.toMatchObject({ allowed: true, result: { path: "src/index.ts", content: "export const answer = 42;\n" } });
    await expect(gateway.call(call("list_files", { path: "src" }, "list-1"))).resolves.toMatchObject({ allowed: true, result: { files: ["src/index.ts"] } });
    await expect(gateway.call(call("search_text", { query: "answer", path: "." }, "search-1"))).resolves.toMatchObject({ allowed: true, result: { matches: [{ path: "src/index.ts", line: 1 }] } });
  });

  it("runs registered commands with a bounded workspace context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-tools-"));
    directories.push(workspace);
    const invocations: CommandInvocation[] = [];
    const commandResult: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };
    const gateway = new ToolGateway({
      role: "executor",
      workspaceRoot: workspace,
      registeredCommandIds: new Set(["project.test"]),
      builtin: {
        registeredCommandExecutor: async (invocation) => {
          invocations.push(invocation);
          return commandResult;
        },
      },
    });

    const result = await gateway.call(call("run_registered_command", { commandId: "project.test", timeoutMs: 5_000 }));

    expect(result).toMatchObject({ allowed: true, result: commandResult });
    expect(invocations[0]).toMatchObject({ commandId: "project.test", cwd: workspace, timeoutMs: 5_000, context: { workspacePath: workspace } });
  });

  it("routes explicitly allowed MCP tools through the same audited gateway", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-tools-"));
    directories.push(workspace);
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const gateway = new ToolGateway({
      role: "explorer",
      workspaceRoot: workspace,
      mcpAllowedTools: new Set(["mcp:docs:search"]),
      builtin: {
        mcpToolExecutor: async (name, input) => {
          calls.push({ name, input });
          return { matches: 1 };
        },
      },
    });

    await expect(gateway.call(call("mcp:docs:search", { query: "rate limits" }))).resolves.toMatchObject({ allowed: true, result: { matches: 1 } });
    await expect(gateway.call(call("mcp:docs:write", { content: "nope" }, "mcp-denied"))).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/MCP|allow/i) });
    expect(calls).toEqual([{ name: "mcp:docs:search", input: { query: "rate limits" } }]);
  });

  it("does not follow a workspace symlink or expose protected files through reads", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pipeline-tools-"));
    const outside = await mkdtemp(join(tmpdir(), "pipeline-tools-outside-"));
    directories.push(workspace, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "link"), "dir");
    await writeFile(join(workspace, ".env"), "TOP_SECRET=1");
    const gateway = new ToolGateway({ role: "executor", workspaceRoot: workspace });

    await expect(gateway.call(call("read_file", { path: ".env" }))).resolves.toMatchObject({ allowed: false });
    await expect(gateway.call(call("read_file", { path: "link/secret.txt" }, "outside-1"))).resolves.toMatchObject({ allowed: false, reason: expect.stringMatching(/workspace|boundary|symlink/i) });
    await expect(gateway.call(call("list_files", { path: "." }, "list-protected"))).resolves.toMatchObject({ allowed: true, result: { files: ["link"] } });
    expect(await readFile(join(workspace, ".env"), "utf8")).toBe("TOP_SECRET=1");
  });
});
