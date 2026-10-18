/**
 * 测试职责：Worktree 服务进程管理 —— 配置解析（原生 / 兼容两种形状）、配置文件定位、
 *   以及与真实子进程的启停闭环（启动 → 有日志 → 停止 → 进程消失）。
 *
 * 设计说明：起停用例**用真的 `node -e` 子进程**，不是桩：这里最容易错的地方恰恰是进程语义
 *   （进程组、detached、SIGTERM 与退出事件），桩恰好把这一层抹掉。
 *
 * 维护提示：用例结束必须把进程停掉（`afterEach` 里 `stopAll`），否则 vitest 会挂在未退出的句柄上。
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeServiceRunner, isProcessAlive, locateServiceConfig, parseServiceConfig } from "./worktree-services.js";

const temporaryPaths: string[] = [];
const runners: WorktreeServiceRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stopAll();
});

afterAll(() => {
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

function makeTemporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function runnerWith(options: ConstructorParameters<typeof WorktreeServiceRunner>[0] = {}): WorktreeServiceRunner {
  const runner = new WorktreeServiceRunner(options);
  runners.push(runner);
  return runner;
}

describe("配置解析", () => {
  it("原生格式：argv 直接执行，workdir 相对 worktree", () => {
    const services = parseServiceConfig(
      { services: [{ serviceId: "api", name: "后端", role: "backend", workdir: "backend", argv: ["node", "server.js"] }] },
      "pipeline-factory",
    );

    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      serviceId: "api",
      name: "后端",
      workdir: "backend",
      argv: ["node", "server.js"],
      shellCommand: null,
      enabled: true,
      source: "pipeline-factory",
    });
  });

  it("兼容格式：start_command 走 shell，repo_path 与 workdir 拼成启动目录", () => {
    const services = parseServiceConfig(
      {
        services: [{ service_id: "web", name: "前端", role: "frontend", repo_path: "..", workdir: "front", start_command: "npm run dev" }],
      },
      "worktree-manage",
    );

    expect(services[0]).toMatchObject({
      serviceId: "web",
      workdir: "../front",
      argv: null,
      shellCommand: "npm run dev",
      source: "worktree-manage",
    });
  });

  it("坏配置直接报错：重复 id、缺少启动命令、形状不对", () => {
    expect(() =>
      parseServiceConfig(
        {
          services: [
            { serviceId: "a", argv: ["true"] },
            { serviceId: "a", argv: ["true"] },
          ],
        },
        "pipeline-factory",
      ),
    ).toThrow("serviceId 重复");
    expect(() => parseServiceConfig({ services: [{ serviceId: "a" }] }, "pipeline-factory")).toThrow("需要 argv");
    expect(() => parseServiceConfig({ services: "nope" }, "pipeline-factory")).toThrow("services");
  });

  it("配置文件优先原生路径，其次兼容路径", () => {
    const root = makeTemporary("pipeline-services-config-");
    expect(locateServiceConfig(root)).toBeNull();

    mkdirSync(join(root, ".worktree-manage"), { recursive: true });
    writeFileSync(join(root, ".worktree-manage", "services.json"), JSON.stringify({ services: [] }));
    expect(locateServiceConfig(root)).toMatchObject({ format: "worktree-manage" });

    mkdirSync(join(root, ".pipeline-factory"), { recursive: true });
    writeFileSync(join(root, ".pipeline-factory", "services.json"), JSON.stringify({ services: [] }));
    expect(locateServiceConfig(root)).toMatchObject({ format: "pipeline-factory" });
  });
});

describe("项目级兜底配置", () => {
  const fallback = [
    {
      serviceId: "fallback",
      name: "兜底服务",
      role: "worker",
      workdir: ".",
      argv: ["true"],
      shellCommand: null,
      healthUrl: null,
      enabled: true,
    },
  ];

  it("worktree 里没有配置文件时使用兜底", () => {
    const root = makeTemporary("pipeline-services-fallback-");
    const snapshot = runnerWith().inspect("project-1", "branch:x", root, fallback);

    expect(snapshot.configSource).toBe("project-fallback");
    expect(snapshot.configPath).toBeNull();
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]).toMatchObject({ serviceId: "fallback", source: "project-settings" });
  });

  it("worktree 文件整份优先，且坏文件不回落", () => {
    const root = makeTemporary("pipeline-services-precedence-");
    mkdirSync(join(root, ".pipeline-factory"), { recursive: true });
    writeFileSync(
      join(root, ".pipeline-factory", "services.json"),
      JSON.stringify({ services: [{ serviceId: "from-file", name: "文件", argv: ["true"] }] }),
    );
    const fromFile = runnerWith().inspect("project-1", "branch:x", root, fallback);
    expect(fromFile.configSource).toBe("worktree-file");
    expect(fromFile.services.map((service) => service.serviceId)).toEqual(["from-file"]);

    writeFileSync(join(root, ".pipeline-factory", "services.json"), "{ 坏掉的 json");
    const broken = runnerWith().inspect("project-1", "branch:x", root, fallback);
    expect(broken.configSource).toBe("worktree-file");
    expect(broken.configError).toBeTruthy();
    // **不回落**：回落会把"文件写坏了"伪装成"用了另一份配置"。
    expect(broken.services).toHaveLength(0);
  });
});

describe("进程启停", () => {
  it("启动后能读到日志，停止后进程消失", async () => {
    const root = makeTemporary("pipeline-services-run-");
    mkdirSync(join(root, ".pipeline-factory"), { recursive: true });
    writeFileSync(
      join(root, ".pipeline-factory", "services.json"),
      JSON.stringify({
        services: [
          {
            serviceId: "ticker",
            name: "Ticker",
            argv: [process.execPath, "-e", "console.log('service-ready'); setInterval(() => {}, 1000);"],
          },
        ],
      }),
    );
    const runner = runnerWith({ maxLogLines: 50 });
    const snapshot = runner.inspect("project-1", "branch:feature/a", root);
    expect(snapshot.configError).toBeNull();
    const config = snapshot.services[0];
    expect(config).toBeDefined();

    const state = runner.start("project-1", "branch:feature/a", root, config!);
    expect(state.status).toBe("running");
    expect(state.pid).toBeTruthy();

    // **必须精确匹配整行**：启动日志里会把命令行原样写出来，而命令行本身包含
    // `console.log('service-ready')`——用 `includes` 会在子进程还没输出时就通过（实测踩过）。
    await waitFor(() => runner.logs("project-1", "branch:feature/a", "ticker").some((entry) => entry.text.trim() === "service-ready"));
    expect(isProcessAlive(state.pid)).toBe(true);
    expect(runner.states("project-1", "branch:feature/a")[0]).toMatchObject({ serviceId: "ticker", status: "running" });

    const pid = state.pid;
    const stopped = await runner.stop("project-1", "branch:feature/a", "ticker");
    expect(stopped.status).toBe("stopped");
    await waitFor(() => !isProcessAlive(pid));
  });

  it("工作目录逃出 worktree 时拒绝启动", () => {
    const root = makeTemporary("pipeline-services-escape-");
    const runner = runnerWith();
    expect(() =>
      runner.start("project-1", "branch:x", root, {
        serviceId: "evil",
        name: "evil",
        role: "worker",
        workdir: "../..",
        argv: [process.execPath, "-e", "process.exit(0)"],
        shellCommand: null,
        healthUrl: null,
        enabled: true,
        source: "pipeline-factory",
      }),
    ).toThrow("不在 worktree 内");
  });

  it("配置里 enabled:false 的服务不能启动", () => {
    const root = makeTemporary("pipeline-services-disabled-");
    const runner = runnerWith();
    expect(() =>
      runner.start("project-1", "branch:x", root, {
        serviceId: "off",
        name: "off",
        role: "worker",
        workdir: ".",
        argv: [process.execPath, "-e", "process.exit(0)"],
        shellCommand: null,
        healthUrl: null,
        enabled: false,
        source: "pipeline-factory",
      }),
    ).toThrow("禁用");
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
