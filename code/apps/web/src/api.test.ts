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

  it("preserves the HTTP status for a missing Run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Run not found" }), { status: 404 }));

    await expect(api.getRun("run-1")).rejects.toMatchObject({ name: "ApiRequestError", status: 404, message: "Run not found" });

    fetchSpy.mockRestore();
  });
});
