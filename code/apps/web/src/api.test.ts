/**
 * 测试职责：验证 Web API facade 保留 HTTP 错误状态，供页面展示可诊断提示。
 * 设计说明：通过真实 facade 发起请求，只有网络边界使用 fetch stub。
 * 维护提示：统一请求错误契约变化时，应同步调整页面错误映射。
 */
import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("api request errors", () => {
  it("loads the API health endpoint and preserves health request failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", model: "gpt-5.6-luna" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "API unavailable" }), { status: 500 }));

    await expect(api.health()).resolves.toEqual({ status: "ok", model: "gpt-5.6-luna" });
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "/health", { headers: {} });
    await expect(api.health()).rejects.toMatchObject({ name: "ApiRequestError", status: 500, message: "API unavailable" });

    fetchSpy.mockRestore();
  });

  it("loads confirmed plans for an Explorer through the dedicated projection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [{ planId: "plan-1", status: "READY" }] }), { status: 200 }));

    await expect(api.explorerConfirmedPlans("project-1", "explorer-1")).resolves.toMatchObject({ items: [{ planId: "plan-1", status: "READY" }] });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/explorers/explorer-1/confirmed-plans", { headers: {} });

    fetchSpy.mockRestore();
  });

  it("renames an Explorer through the existing typed endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ explorer: { id: "explorer-1", title: "Renamed thread" } }), { status: 200 }));

    await expect(api.renameExplorer("project-1", "explorer-1", "Renamed thread")).resolves.toMatchObject({ explorer: { title: "Renamed thread" } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/projects/project-1/explorers/explorer-1/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed thread" }),
    });

    fetchSpy.mockRestore();
  });

  it("creates a configuration revision through the Plan recovery endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ plan: { id: "plan-1", revision: 2, status: "READY" } }), { status: 200 }));

    await expect(api.revisePlanConfiguration("plan-1")).resolves.toMatchObject({ plan: { revision: 2, status: "READY" } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/plans/plan-1/revise-configuration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "local-user" }),
    });

    fetchSpy.mockRestore();
  });

  it("preserves the HTTP status for a missing Run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Run not found" }), { status: 404 }));

    await expect(api.getRun("run-1")).rejects.toMatchObject({ name: "ApiRequestError", status: 404, message: "Run not found" });

    fetchSpy.mockRestore();
  });
});
