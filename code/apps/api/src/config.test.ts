/**
 * 测试职责：验证 config 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactoryConfig, resolveConfigPath, resolveModelBackends, roleBackendId } from "./config.js";

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

  it("defaults Explorer and Executor to the configured Codex model", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "defaults.json");
    writeFileSync(configPath, "{}", "utf8");

    const config = loadFactoryConfig(configPath);

    expect(config.model.roles.explorer.model).toBe("gpt-5.6-luna");
    expect(config.model.roles.executor.model).toBe("gpt-5.6-luna");
    expect(config.runtime.executionTimeoutMs).toBe(1_800_000);
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

  it("accepts the Claude Agent SDK backend with an optional endpoint override", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "claude.json");
    writeFileSync(configPath, JSON.stringify({
      model: {
        backend: "claude-agent-sdk",
        claudeAgent: { baseUrl: "http://127.0.0.1:15721", authToken: "token", settingsPath: "./claude-settings.json", env: { CLAUDE_CODE_USE_BEDROCK: "0" }, maxTurns: 12 },
        roles: { explorer: { model: "claude-opus-5", mode: "plan" }, executor: { model: "claude-opus-5", mode: "default" } },
      },
    }), "utf8");

    const config = loadFactoryConfig(configPath);

    expect(config.model.backend).toBe("claude-agent-sdk");
    expect(config.model.claudeAgent?.baseUrl).toBe("http://127.0.0.1:15721");
    // settingsPath 与其它路径字段一致，按配置文件所在目录解析。
    expect(config.model.claudeAgent?.settingsPath).toBe(join(directory, "claude-settings.json"));
    expect(config.model.claudeAgent?.maxTurns).toBe(12);
    expect(config.model.roles.explorer.mode).toBe("plan");
  });

  it("keeps the Claude Agent SDK block optional so the CLI resolves its own credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "claude-default.json");
    writeFileSync(configPath, JSON.stringify({ model: { backend: "claude-agent-sdk" } }), "utf8");

    const config = loadFactoryConfig(configPath);

    // 不给 claudeAgent 是合法用法：端点与凭据交给 CLI 自己解析（~/.claude/settings.json）。
    expect(config.model.claudeAgent).toBeUndefined();
    expect(config.model.backend).toBe("claude-agent-sdk");
  });

  it("routes explorer and executor to different agents through named backends", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "split.json");
    writeFileSync(configPath, JSON.stringify({
      model: {
        backend: "codex-app-server",
        codexAppServer: { cwd: "./project" },
        backends: {
          deepseek: { kind: "claude-agent-sdk", baseUrl: "https://api.deepseek.com/anthropic", authToken: "t", settingsPath: "./claude.json", models: ["deepseek-chat"] },
        },
        roles: {
          explorer: { model: "gpt-5.6-sol", backend: "codex-app-server" },
          executor: { model: "deepseek-chat", backend: "deepseek" },
        },
      },
    }), "utf8");

    const config = loadFactoryConfig(configPath);
    const backends = resolveModelBackends(config.model);

    expect(roleBackendId(config.model, "explorer")).toBe("codex-app-server");
    expect(roleBackendId(config.model, "executor")).toBe("deepseek");
    expect(backends.get("deepseek")).toMatchObject({ kind: "claude-agent-sdk", source: "registry", models: ["deepseek-chat"] });
    // 注册项里的相对路径与 codexAppServer/claudeAgent 同一基准目录，不引入第二种解析规则。
    expect(backends.get("deepseek")?.claudeAgent?.settingsPath).toBe(join(directory, "claude.json"));
    expect(backends.get("codex-app-server")?.codexAppServer?.cwd).toBe(join(directory, "project"));
  });

  it("keeps the four kind names usable as backend ids without a registry", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "implicit.json");
    // 一个注册表项都不写：两个角色仍可各选一个 agent —— 这是"探索 Codex、执行 Claude"的最小写法。
    writeFileSync(configPath, JSON.stringify({
      model: { backend: "codex-app-server", roles: { explorer: { model: "gpt-5.6-sol" }, executor: { model: "claude-opus-5", backend: "claude-agent-sdk" } } },
    }), "utf8");

    const config = loadFactoryConfig(configPath);
    const backends = resolveModelBackends(config.model);

    expect(backends.get("claude-agent-sdk")).toMatchObject({ kind: "claude-agent-sdk", source: "implicit" });
    expect(roleBackendId(config.model, "executor")).toBe("claude-agent-sdk");
    // 没写 backend 的角色跟随全局默认。
    expect(roleBackendId(config.model, "explorer")).toBe("codex-app-server");
  });

  it("fails at startup when a role references an unknown backend", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-config-"));
    directories.push(directory);
    const configPath = join(directory, "unknown-backend.json");
    writeFileSync(configPath, JSON.stringify({ model: { roles: { executor: { model: "x", backend: "typo" } } } }), "utf8");

    const config = loadFactoryConfig(configPath);
    // 启动期失败而不是等第一个回合：错误信息直接列出可用 id。
    expect(() => resolveModelBackends(config.model)).toThrow(/model\.roles\.executor\.backend "typo" is not defined.*Known backends: codex-app-server, claude-agent-sdk, openai-responses, stub/s);
  });
});
