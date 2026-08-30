/**
 * 测试职责：验证 config 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryConfig, resolveConfigPath } from "./config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Factory configuration", () => {
  it("loads runtime parameters from JSON and resolves relative paths from the config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "pipeline-factory.config.json");
    writeFileSync(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 4399 },
      storage: { databasePath: "./var/factory.sqlite", worktreeRoot: "./var/worktrees" },
      project: { root: "./project", commands: [{ commandId: "project.test", argv: ["node", "scripts/test.mjs"], environment: { PATH: "/usr/bin" } }] },
      model: {
        backend: "codex-app-server",
        codexAppServer: { command: "codex", args: ["app-server", "--stdio"], cwd: "./project", startupTimeoutMs: 5000, requestTimeoutMs: 10000, maxRestarts: 2 },
        roles: { explorer: { model: "gpt-5", temperature: 0.1 }, executor: { model: "gpt-5", temperature: 0 } },
      },
      runtime: { globalConcurrency: 4, projectConcurrency: 2, defaultTimeoutMs: 120000 },
      mcp: { servers: [{ name: "docs", transport: "streamable-http", url: "http://127.0.0.1:8787/mcp", allowedTools: ["search"], requestTimeoutMs: 5000 }] },
      plugins: { directories: ["./plugins"], supportedApiMajor: 1, allowedTools: ["plugin:com.example.docs:search"] },
      computerUse: { enabled: true, requireApproval: true, timeoutMs: 5000 },
    }), "utf8");

    const config = loadFactoryConfig(configPath);

    expect(config.server.port).toBe(4399);
    expect(config.storage.databasePath).toBe(join(directory, "var/factory.sqlite"));
    expect(config.storage.worktreeRoot).toBe(join(directory, "var/worktrees"));
    expect(config.project.root).toBe(join(directory, "project"));
    expect(config.model.backend).toBe("codex-app-server");
    expect(config.model.codexAppServer?.args).toEqual(["app-server", "--stdio"]);
    expect(config.mcp.servers[0]).toMatchObject({ name: "docs", transport: "streamable-http", allowedTools: ["search"] });
    expect(config.plugins).toMatchObject({ directories: [join(directory, "plugins")], allowedTools: ["plugin:com.example.docs:search"] });
    expect(config.computerUse).toMatchObject({ enabled: true, requireApproval: true, timeoutMs: 5000 });
  });

  it("rejects an invalid configuration instead of silently falling back", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "invalid.json");
    writeFileSync(configPath, JSON.stringify({ server: { port: 0 } }), "utf8");

    expect(() => loadFactoryConfig(configPath)).toThrow(/Invalid Factory configuration/);
  });

  it("defaults Explorer and Executor to the Codex 5.6 Luna model", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "defaults.json");
    writeFileSync(configPath, "{}", "utf8");

    const config = loadFactoryConfig(configPath);

    expect(config.model.roles.explorer.model).toBe("gpt-5.6-luna");
    expect(config.model.roles.executor.model).toBe("gpt-5.6-luna");
    expect(config.runtime.maxAutoContinuationTurns).toBe(4);
  });

  it("resolves a relative CLI path from an ancestor workspace when pnpm changes the package cwd", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    mkdirSync(join(directory, "config"), { recursive: true });
    mkdirSync(join(directory, "apps/api"), { recursive: true });
    writeFileSync(join(directory, "config/pipeline-factory.config.json"), "{}", "utf8");

    expect(resolveConfigPath("./config/pipeline-factory.config.json", join(directory, "apps/api"))).toBe(join(directory, "config/pipeline-factory.config.json"));
  });
});
