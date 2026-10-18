/**
 * 测试职责：Worktree 路由的 HTTP 契约 —— 盘点、预览、合并、续做/中止、清理，以及错误码到
 *   状态码的映射（404 / 409 各自的原因要能被客户端区分）。
 *
 * 设计说明：用真临时 Git 仓库（同 `server.test.ts` 的 `createGitBackedTestProject` 思路），
 *   因为这一组路由的价值就在于"它真的动了 Git"；用桩替换 Git 会让这套用例失去意义。
 *
 * 维护提示：新增阻断判据时，在这里补一条"它返回哪个 code"的断言 —— 界面按 `code` 分支，
 *   只断言 409 挡不住"原因被换成了另一个"。
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore, ProjectService, type Project } from "@pipeline-factory/domain";
import { createApp } from "./server.js";
import { isProcessAlive } from "./runtime/worktree-services.js";

const temporaryPaths: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

afterAll(() => {
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

function makeTemporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(cwd: string, message: string): void {
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "-q", "-m", message], {
    cwd,
  });
}

/** 一个真仓库 + 一个已落库的 Project；`withAheadBranch` 控制是否额外造一条有提交的分支。 */
function setup(options: { withAheadBranch?: boolean } = {}): {
  app: ReturnType<typeof createApp>;
  project: Project;
  repoRoot: string;
  worktreeRoot: string;
} {
  const repoRoot = makeTemporary("pipeline-worktree-api-");
  const worktreeRoot = makeTemporary("pipeline-worktree-api-wt-");
  git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "base\n");
  git(repoRoot, ["add", "-A"]);
  commit(repoRoot, "init");
  if (options.withAheadBranch !== false) {
    git(repoRoot, ["switch", "-c", "feature/ahead", "main"]);
    writeFileSync(join(repoRoot, "ahead.txt"), "ahead\n");
    git(repoRoot, ["add", "-A"]);
    commit(repoRoot, "feature change");
    git(repoRoot, ["switch", "main"]);
  }
  const store = new InMemoryPipelineStore();
  const project = new ProjectService(store).create({
    id: "project-1",
    name: "project-1",
    repoRoot,
    defaultBranch: "main",
    worktreeRoot,
  });
  const app = createApp({ store, seed: false });
  apps.push(app);
  return { app, project, repoRoot, worktreeRoot };
}

describe("Worktree 路由", () => {
  it("GET 列出分支与主分支", async () => {
    const { app, project } = setup();
    const response = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { baseBranch: string; items: Array<{ branch: string | null; kind: string }> };
    expect(body.baseBranch).toBe("main");
    expect(body.items.some((item) => item.kind === "base_branch" && item.branch === "main")).toBe(true);
    expect(body.items.some((item) => item.branch === "feature/ahead")).toBe(true);
  });

  it("未知项目返回 404 PROJECT_NOT_FOUND", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/v4/projects/nope/worktrees" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("预览返回可合并结论与两个 expected SHA", async () => {
    const { app, project } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:feature/ahead" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ preview: { conclusion: "ready", canConfirm: true, aheadCount: 1 } });
  });

  it("预览未知 item 返回 404 WORKTREE_NOT_FOUND", async () => {
    const { app, project } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "WORKTREE_NOT_FOUND" });
  });

  it("合并成功后再次合并被拒（分支已合并）", async () => {
    const { app, project, repoRoot } = setup();
    const preview = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:feature/ahead" },
    });
    const expected = (preview.json() as { preview: { expectedBranchHead: string; expectedBaseHead: string } }).preview;

    const merged = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/merge`,
      payload: { itemId: "branch:feature/ahead", ...expected },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ result: { status: "merged" } });
    expect(git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");

    const again = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/merge`,
      payload: { itemId: "branch:feature/ahead", ...expected },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "WORKTREE_MERGE_BLOCKED" });
  });

  it("预览之后 base 前进（凭据过期）返回 409 WORKTREE_STATE_CHANGED", async () => {
    const { app, project, repoRoot } = setup();
    const preview = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:feature/ahead" },
    });
    const expected = (preview.json() as { preview: { expectedBranchHead: string; expectedBaseHead: string } }).preview;
    writeFileSync(join(repoRoot, "other.txt"), "other\n");
    git(repoRoot, ["add", "-A"]);
    commit(repoRoot, "move base");

    const response = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/merge`,
      payload: { itemId: "branch:feature/ahead", ...expected },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WORKTREE_STATE_CHANGED" });
  });

  it("继续/中止在没有进行中的合并时返回 409", async () => {
    const { app, project } = setup();
    for (const action of ["continue", "abort"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v4/projects/${project.id}/worktrees/merge/${action}`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "WORKTREE_NO_MERGE_IN_PROGRESS" });
    }
  });

  it("清理未合并分支返回 409 WORKTREE_CLEANUP_BLOCKED", async () => {
    const { app, project } = setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId: "branch:feature/ahead", expectedBranchHead: null },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WORKTREE_CLEANUP_BLOCKED" });
  });

  it("归档项目上的写请求被组合根拦成 409 PROJECT_ARCHIVED", async () => {
    const { app, project } = setup();
    // 通过 API 归档：与真实路径一致（ProjectService.archive 会检查活动 Run）。
    const archived = await app.inject({ method: "POST", url: `/api/v4/projects/${project.id}/archive` });
    expect(archived.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:feature/ahead" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PROJECT_ARCHIVED" });
  });
});

/**
 * 复盘后补齐的能力：项目范围过滤、提交历史与 diff、删除已合并本地分支、detached 清理、
 * 服务启停路由、进行中的 rebase。都走真实 HTTP（`app.inject`）与真实仓库。
 */
describe("Worktree 路由：范围过滤与提交历史", () => {
  it("includeFiltered 只影响读：被忽略的分支默认不出现", async () => {
    const { app, project } = setup();
    // 通过 API 改项目范围（与界面走同一条路）。
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v4/projects/${project.id}`,
      payload: { settings: { worktree: { ignoredBranches: ["feature/ahead"] } } },
    });
    expect(patched.statusCode).toBe(200);

    const hidden = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    expect(hidden.json()).toMatchObject({ filteredOutCount: 1 });
    expect((hidden.json() as { items: Array<{ branch: string | null }> }).items.some((item) => item.branch === "feature/ahead")).toBe(
      false,
    );

    const all = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees?includeFiltered=1` });
    const allItems = (all.json() as { items: Array<{ branch: string | null; isIgnored: boolean }> }).items;
    expect(allItems.find((item) => item.branch === "feature/ahead")?.isIgnored).toBe(true);
  });

  it("非法的范围配置返回 422 PROJECT_SETTINGS_INVALID，且不改动项目", async () => {
    const { app, project } = setup();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v4/projects/${project.id}`,
      payload: { settings: { worktree: { filterMode: "patterns", branchPatterns: [] } } },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "PROJECT_SETTINGS_INVALID" });

    const reloaded = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}` });
    // 项目上仍是默认范围（创建时写入了默认值），没有被这次非法请求改掉。
    expect(
      (reloaded.json() as { project: { settings: { worktree?: { filterMode: string; branchPatterns: string[] } } } }).project.settings
        .worktree,
    ).toMatchObject({ filterMode: "all", branchPatterns: [] });
  });

  it("提交历史、提交文件与文件 diff", async () => {
    const { app, project } = setup();
    const log = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/log?ref=${encodeURIComponent("feature/ahead")}&limit=5`,
    });
    expect(log.statusCode).toBe(200);
    const commits = (log.json() as { items: Array<{ hash: string; subject: string }> }).items;
    expect(commits[0]?.subject).toContain("feature change");

    const files = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/commits/${commits[0]?.hash}`,
    });
    expect(files.statusCode).toBe(200);
    expect((files.json() as { items: Array<{ path: string }> }).items.map((file) => file.path)).toContain("ahead.txt");

    const diff = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/commits/${commits[0]?.hash}/diff?path=ahead.txt`,
    });
    expect(diff.statusCode).toBe(200);
    expect((diff.json() as { diff: string }).diff).toContain("+ahead");
  });

  it("不存在的 ref / 提交返回 404", async () => {
    const { app, project } = setup();
    const log = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees/log?ref=nope` });
    expect(log.statusCode).toBe(404);
    expect(log.json()).toMatchObject({ code: "WORKTREE_NOT_FOUND" });

    const diff = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/commits/deadbeef/diff?path=a.txt`,
    });
    expect(diff.statusCode).toBe(404);
  });
});

describe("Worktree 路由：新的清理对象", () => {
  it("已合并的本地分支可以删除；未合并的不能", async () => {
    const { app, project, repoRoot } = setup();
    git(repoRoot, ["merge", "--no-ff", "--no-edit", "feature/ahead"]);

    const cleanup = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId: "branch:feature/ahead", expectedBranchHead: null },
    });
    // `expectedBranchHead` 必须与分支头一致，否则是 409 状态已变（乐观并发）。
    expect(cleanup.statusCode).toBe(409);
    expect(cleanup.json()).toMatchObject({ code: "WORKTREE_STATE_CHANGED" });

    const list = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    const item = (list.json() as { items: Array<{ branch: string | null; lastCommit: string; cleanupable: boolean }> }).items.find(
      (entry) => entry.branch === "feature/ahead",
    );
    expect(item?.cleanupable).toBe(true);

    const removed = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId: "branch:feature/ahead", expectedBranchHead: item?.lastCommit ?? null },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ result: { branchDeleted: true, worktreeRemoved: false } });
  });

  it("detached worktree 在提交被分支包含时可以删除目录", async () => {
    const { app, project, repoRoot } = setup();
    const worktreeRoot = mkdtempSync(join(tmpdir(), "pipeline-worktree-api-detached-"));
    temporaryPaths.push(worktreeRoot);
    git(repoRoot, ["worktree", "add", "--detach", worktreeRoot, "main"]);

    const list = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    const item = (
      list.json() as { items: Array<{ itemId: string; isDetached: boolean; lastCommit: string; cleanupable: boolean }> }
    ).items.find((entry) => entry.isDetached);
    expect(item?.cleanupable).toBe(true);

    const removed = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId: item?.itemId, expectedBranchHead: item?.lastCommit },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ result: { worktreeRemoved: true, branchDeleted: false } });
  });
});

describe("Worktree 路由：服务启停", () => {
  function withServiceConfig(repoRoot: string, worktreePath: string): void {
    mkdirSync(join(worktreePath, ".pipeline-factory"), { recursive: true });
    writeFileSync(
      join(worktreePath, ".pipeline-factory", "services.json"),
      JSON.stringify({
        services: [
          {
            serviceId: "ticker",
            name: "Ticker",
            argv: [process.execPath, "-e", "console.log('ticker-ready'); setInterval(() => {}, 1000);"],
          },
        ],
      }),
    );
    void repoRoot;
  }

  it("没有 worktree 的本地分支返回 409；有配置的 worktree 能启停并读日志", async () => {
    const { app, project, repoRoot } = setup();
    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-worktree-api-svc-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);
    withServiceConfig(repoRoot, worktreePath);
    const itemId = `branch:feature/ahead`;

    const services = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/services?itemId=${encodeURIComponent(itemId)}`,
    });
    expect(services.statusCode).toBe(200);
    expect((services.json() as { services: Array<{ serviceId: string }> }).services[0]?.serviceId).toBe("ticker");

    const started = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/services/start`,
      payload: { itemId, serviceId: "ticker" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: { status: "running" } });

    await waitFor(async () => {
      const logs = await app.inject({
        method: "GET",
        url: `/api/v4/projects/${project.id}/worktrees/services/logs?itemId=${encodeURIComponent(itemId)}&serviceId=ticker`,
      });
      return (logs.json() as { items: Array<{ text: string }> }).items.some((entry) => entry.text.trim() === "ticker-ready");
    });

    const stopped = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/services/stop`,
      payload: { itemId, serviceId: "ticker" },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ state: { status: "stopped" } });
  });

  it("清理 worktree 前先停掉它上面运行的服务", async () => {
    const { app, project, repoRoot } = setup();
    git(repoRoot, ["switch", "-c", "feature/merged", "main"]);
    writeFileSync(join(repoRoot, "merged.txt"), "merged\n");
    git(repoRoot, ["add", "-A"]);
    commit(repoRoot, "merged change");
    git(repoRoot, ["switch", "main"]);
    git(repoRoot, ["merge", "--no-ff", "--no-edit", "feature/merged"]);
    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-worktree-api-svc-cleanup-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/merged"]);
    withServiceConfig(repoRoot, worktreePath);
    const itemId = "branch:feature/merged";

    const started = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/services/start`,
      payload: { itemId, serviceId: "ticker" },
    });
    expect(started.statusCode).toBe(200);
    const pid = (started.json() as { state: { pid: number | null } }).state.pid;
    expect(pid).toBeTruthy();

    const list = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    const item = (list.json() as { items: Array<{ branch: string | null; lastCommit: string }> }).items.find(
      (entry) => entry.branch === "feature/merged",
    );

    const cleaned = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId, expectedBranchHead: item?.lastCommit ?? null },
    });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json()).toMatchObject({ stoppedServices: 1 });
    await waitFor(() => !isProcessAlive(pid));
  });

  it("worktree 里没有配置文件时用项目级兜底", async () => {
    const { app, project, repoRoot } = setup();
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v4/projects/${project.id}`,
      payload: {
        settings: {
          worktreeServices: [
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
          ],
        },
      },
    });
    expect(patched.statusCode).toBe(200);

    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-worktree-api-fallback-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/services?itemId=${encodeURIComponent("branch:feature/ahead")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configSource: "project-fallback",
      configPath: null,
      services: [{ serviceId: "fallback", source: "project-settings" }],
    });
  });

  it("没有 worktree 的条目返回 409 WORKTREE_SERVICES_UNSUPPORTED", async () => {
    const { app, project } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${project.id}/worktrees/services?itemId=branch:feature/ahead`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "WORKTREE_SERVICES_UNSUPPORTED" });
  });
});

describe("Worktree 路由：进行中的 rebase", () => {
  it("rebase 停在冲突中间时，预览给出 409 与原因", async () => {
    const { app, project, repoRoot } = setup();
    writeFileSync(join(repoRoot, "README.md"), "main side\n");
    git(repoRoot, ["add", "-A"]);
    commit(repoRoot, "main changes README");
    git(repoRoot, ["switch", "feature/ahead"]);
    // feature/ahead 上改同一行，rebase 到 main 会冲突并停在 rebase-merge。
    writeFileSync(join(repoRoot, "README.md"), "feature side\n");
    git(repoRoot, ["add", "-A"]);
    commit(repoRoot, "feature changes README");
    expect(() => git(repoRoot, ["rebase", "main"])).toThrow();

    const list = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    expect(list.json()).toMatchObject({ mergeInProgress: { kind: "rebase" } });

    const preview = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/preview`,
      payload: { itemId: "branch:feature/ahead" },
    });
    // 预览本身照常返回（预览不改仓库），但结论是阻断。
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ preview: { canConfirm: false } });
    expect((preview.json() as { preview: { blockers: string[] } }).preview.blockers.join("\n")).toContain("rebase");
  });
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 执行目录：合并前验证用的固定路径。 */
describe("Worktree 路由：依赖软链", () => {
  it("给已有 worktree 补齐依赖目录；没有 worktree 的分支返回 409", async () => {
    const { app, project, repoRoot } = setup();
    mkdirSync(join(repoRoot, "node_modules"));
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v4/projects/${project.id}`,
      payload: { settings: { linkedFolders: ["node_modules"] } },
    });
    expect(patched.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/dependencies`,
      payload: { itemId: "branch:feature/ahead" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "WORKTREE_DEPENDENCY_BLOCKED" });

    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-link-api-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);

    const linked = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/dependencies`,
      payload: { itemId: "branch:feature/ahead" },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ result: { folders: ["node_modules"], linked: ["node_modules"] } });
    expect(lstatSync(join(worktreePath, "node_modules")).isSymbolicLink()).toBe(true);
  });
});

describe("Worktree 路由：执行目录", () => {
  it("初始为空；切换后能反查出当前分支", async () => {
    const { app, project, repoRoot, worktreeRoot } = setup();
    const initial = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/runtime` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ runtime: { path: join(worktreeRoot, ".runtime"), exists: false, current: null } });

    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-runtime-api-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);

    const switched = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/switch`,
      payload: { itemId: "branch:feature/ahead" },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      runtime: { current: { itemId: "branch:feature/ahead", branch: "feature/ahead" } },
      previousTarget: null,
      stoppedServices: 0,
    });
  });

  it("无 worktree 的分支返回 409；清理当前目标也被拒", async () => {
    const { app, project, repoRoot } = setup();
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/switch`,
      payload: { itemId: "branch:feature/ahead" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "WORKTREE_RUNTIME_BLOCKED" });

    // 建一个 worktree、合并、切为执行目录，再尝试清理它。
    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-runtime-api-clean-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);
    git(repoRoot, ["merge", "--no-ff", "--no-edit", "feature/ahead"]);
    await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/switch`,
      payload: { itemId: "branch:feature/ahead" },
    });
    const list = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/worktrees` });
    const item = (list.json() as { items: Array<{ branch: string | null; lastCommit: string }> }).items.find(
      (entry) => entry.branch === "feature/ahead",
    );
    const cleanup = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/worktrees/cleanup`,
      payload: { itemId: "branch:feature/ahead", expectedBranchHead: item?.lastCommit ?? null },
    });
    expect(cleanup.statusCode).toBe(409);
    expect((cleanup.json() as { error: string }).error).toContain("执行目录");
  });

  it("runtime 服务走执行目录配置，切换时被停掉", async () => {
    const { app, project, repoRoot, worktreeRoot } = setup();
    const worktreePath = mkdtempSync(join(tmpdir(), "pipeline-runtime-api-svc-"));
    temporaryPaths.push(worktreePath);
    git(repoRoot, ["worktree", "add", worktreePath, "feature/ahead"]);
    const runtimePath = join(worktreeRoot, ".runtime");
    mkdirSync(runtimePath, { recursive: true });
    writeFileSync(
      join(runtimePath, "services.json"),
      JSON.stringify({
        services: [{ serviceId: "ticker", name: "Ticker", argv: [process.execPath, "-e", "setInterval(() => {}, 1000);"] }],
      }),
    );

    await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/switch`,
      payload: { itemId: "branch:feature/ahead" },
    });

    const services = await app.inject({ method: "GET", url: `/api/v4/projects/${project.id}/runtime/services` });
    expect(services.statusCode).toBe(200);
    expect(services.json()).toMatchObject({ configSource: "runtime", services: [{ serviceId: "ticker", source: "runtime" }] });

    const started = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/services/start`,
      payload: { serviceId: "ticker" },
    });
    expect(started.statusCode).toBe(200);
    const pid = (started.json() as { state: { pid: number | null } }).state.pid;
    expect(pid).toBeTruthy();

    // 切到主分支：runtime 服务应被停掉，进程消失。
    const switched = await app.inject({
      method: "POST",
      url: `/api/v4/projects/${project.id}/runtime/switch`,
      payload: { itemId: "branch:main" },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ stoppedServices: 1, runtime: { current: { itemId: "branch:main" } } });
    await waitFor(() => !isProcessAlive(pid));
  });
});
