/**
 * 测试职责：验证 Web API facade 保留 HTTP 错误状态（供页面展示可诊断提示），
 *   并锁住那批**没有任何调用方**的包装没有被重新加回来。
 * 设计说明：通过真实 facade 发起请求，只有网络边界使用 fetch stub。
 * 维护提示：统一请求错误契约变化时，应同步调整页面错误映射。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

const apiSource = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");

/**
 * 这九个包装曾长期躺在 facade 上，**生产代码一处都没调**（其中两个还被别的测试断言过
 * "不该出现在视图里"）。它们对应的 HTTP 端点仍留着——端点是对外契约，删不删是另一回事；
 * 但客户端这一侧空着只会让后来的人以为有人在用。
 *
 * 要加回来，先有调用方：加一个只被测试用的包装，等于又把这条线长回去了。
 */
describe("API facade 上删掉的那批空转包装", () => {
  it("不再暴露这些没人调的方法", () => {
    for (const name of [
      "projectConfigHistory",
      "agentLoopTools",
      "explorerAgentLoops",
      "projectTasks",
      "getExecutionThread",
      "getMergeRequest",
      "plans",
      "explorerCandidate",
      "explorerRevisionDraft",
    ]) {
      expect(api).not.toHaveProperty(name);
    }
  });

  it("源码里也没有留下它们的定义", () => {
    for (const name of ["projectConfigHistory:", "agentLoopTools:", "explorerAgentLoops:", "projectTasks:"]) {
      expect(apiSource).not.toContain(name);
    }
    // `plans` / `getMergeRequest` 这类名字在别处也会出现，只认"作为 api 方法定义"那个形状。
    expect(apiSource).not.toContain("  plans: (projectId: string");
    expect(apiSource).not.toContain("  getExecutionThread: ");
    expect(apiSource).not.toContain("  getMergeRequest: ");
    expect(apiSource).not.toContain("  explorerCandidate: ");
    expect(apiSource).not.toContain("  explorerRevisionDraft: ");
  });
});

describe("api request errors", () => {
  it("loads the API health endpoint and preserves health request failures", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", model: "gpt-5.6-luna" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "API unavailable" }), { status: 500 }));

    await expect(api.health()).resolves.toEqual({ status: "ok", model: "gpt-5.6-luna" });
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/health", { headers: {} });
    await expect(api.health()).rejects.toMatchObject({ name: "ApiRequestError", status: 500, message: "API unavailable" });

    fetchSpy.mockRestore();
  });

  it("loads confirmed plans for an Explorer through the dedicated projection", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ items: [{ planId: "plan-1", status: "READY" }] }), { status: 200 }));

    await expect(api.explorerConfirmedPlans("project-1", "explorer-1")).resolves.toMatchObject({
      items: [{ planId: "plan-1", status: "READY" }],
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/explorers/explorer-1/confirmed-plans", { headers: {} });

    fetchSpy.mockRestore();
  });

  it("reconciles external merges through the project-scoped endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ projectId: "project-1", checkedAt: "2026-09-06T00:00:00.000Z", items: [] }), { status: 200 }),
      );

    await expect(api.reconcileProjectMerges("project-1")).resolves.toMatchObject({ projectId: "project-1", items: [] });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/merge-reconciliation", { method: "POST", headers: {} });

    fetchSpy.mockRestore();
  });

  it("renames an Explorer through the existing typed endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ explorer: { id: "explorer-1", title: "Renamed thread" } }), { status: 200 }));

    await expect(api.renameExplorer("project-1", "explorer-1", "Renamed thread")).resolves.toMatchObject({
      explorer: { title: "Renamed thread" },
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/explorers/explorer-1/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed thread" }),
    });

    fetchSpy.mockRestore();
  });

  it("deletes an Explorer through the project-scoped DELETE endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          deletedExplorerId: "explorer-1",
          replacementExplorer: { id: "explorer-2" },
          project: { id: "project-1" },
          deleted: { taskCount: 1, planCount: 2, runCount: 0 },
        }),
        { status: 200 },
      ),
    );

    await expect(api.deleteExplorer("project/1", "explorer/1")).resolves.toMatchObject({
      deletedExplorerId: "explorer-1",
      deleted: { planCount: 2 },
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project%2F1/explorers/explorer%2F1", { method: "DELETE", headers: {} });

    fetchSpy.mockRestore();
  });

  it("creates a configuration revision through the Plan recovery endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ plan: { id: "plan-1", revision: 2, status: "READY" } }), { status: 200 }));

    await expect(api.revisePlanConfiguration("plan-1")).resolves.toMatchObject({ plan: { revision: 2, status: "READY" } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/plans/plan-1/revise-configuration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "local-user" }),
    });

    fetchSpy.mockRestore();
  });

  it("preserves the HTTP status for a missing Run", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "Run not found" }), { status: 404 }));

    await expect(api.getRun("run-1")).rejects.toMatchObject({ name: "ApiRequestError", status: 404, message: "Run not found" });

    fetchSpy.mockRestore();
  });
});

/**
 * Worktree 管理这一组是**唯一会改写受管仓库 Git 状态**的客户端调用，所以路径与凭据要逐字锁住：
 * `expected*` 少传一个，服务端就会把"没带凭据"当成"状态已变"，用户看到的是莫名 409。
 */
describe("Worktree 管理接口", () => {
  it("预览把 itemId 放 body（分支名里的 / 不进路径）", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ preview: { itemId: "branch:feature/a" } }), { status: 200 }));

    await expect(api.previewWorktreeMerge("project-1", "branch:feature/a")).resolves.toMatchObject({
      preview: { itemId: "branch:feature/a" },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v4/projects/project-1/worktrees/preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ itemId: "branch:feature/a" }) }),
    );

    fetchSpy.mockRestore();
  });

  it("合并与清理原样带回乐观并发凭据", async () => {
    // 每次调用都要一个**新的** Response：同一个对象被读第二次会抛 "Body is unusable"。
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ result: { status: "merged" } }), { status: 200 }));

    await api.mergeWorktree("project-1", { itemId: "branch:feature/a", expectedBranchHead: "task", expectedBaseHead: "base" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v4/projects/project-1/worktrees/merge",
      expect.objectContaining({
        body: JSON.stringify({ itemId: "branch:feature/a", expectedBranchHead: "task", expectedBaseHead: "base" }),
      }),
    );

    await api.cleanupWorktree("project-1", { itemId: "branch:feature/a", expectedBranchHead: "task" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v4/projects/project-1/worktrees/cleanup",
      expect.objectContaining({ body: JSON.stringify({ itemId: "branch:feature/a", expectedBranchHead: "task" }) }),
    );

    fetchSpy.mockRestore();
  });

  it("继续/中止走 POST，不需要请求体", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ result: { status: "aborted" } }), { status: 200 }));

    await api.continueWorktreeMerge("project-1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/worktrees/merge/continue", { method: "POST", headers: {} });
    await api.abortWorktreeMerge("project-1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/worktrees/merge/abort", { method: "POST", headers: {} });

    fetchSpy.mockRestore();
  });
});
