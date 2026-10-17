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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore, ProjectService, type Project } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

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
function setup(options: { withAheadBranch?: boolean } = {}): { app: ReturnType<typeof createApp>; project: Project; repoRoot: string } {
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
  return { app, project, repoRoot };
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
