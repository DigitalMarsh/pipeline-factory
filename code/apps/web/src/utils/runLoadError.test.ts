/**
 * 测试职责：验证 Run 详情页对 Run 主请求、API 连接和附加数据错误的区分。
 * 设计说明：错误提示必须反映用户可执行的下一步，不能把所有失败都归因于 Run 不存在。
 * 维护提示：后端错误契约或页面加载阶段变化时，应同步调整这些场景。
 */
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api";
import { api } from "../api";
import { describeRunLoadError } from "./runLoadError";

describe("describeRunLoadError", () => {
  it("identifies a missing Run only when the primary Run request returns 404", () => {
    expect(describeRunLoadError(new ApiRequestError("Run not found", 404), "run")).toBe("Run 不存在，请从 Runs 列表重新打开");
  });

  it("identifies an unavailable API when the primary request cannot connect", () => {
    expect(describeRunLoadError(new TypeError("Failed to fetch"), "run")).toBe("API 未连接，请启动 API 服务后重试");
  });

  it("keeps an auxiliary AgentLoop failure from masquerading as a missing Run", () => {
    expect(describeRunLoadError(new ApiRequestError("AgentLoop not found", 404), "agent-loop")).toBe("Run 已加载，但 Agent Loop 详情暂时不可用");
  });

  it("encodes the Run id before building the detail request URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await api.getRun("run/with spaces");

    expect(fetchSpy).toHaveBeenCalledWith("/api/v4/runs/run%2Fwith%20spaces", expect.objectContaining({ headers: {} }));
    fetchSpy.mockRestore();
  });
});
