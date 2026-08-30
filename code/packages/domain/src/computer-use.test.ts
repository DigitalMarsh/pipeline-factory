/**
 * 测试职责：验证 computer-use 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { ComputerUseBridge, type ComputerUseHostAdapter } from "./index.js";

function adapter(events: string[]): ComputerUseHostAdapter {
  return {
    async screenshot() {
      events.push("screenshot");
      return { mediaType: "image/png", data: "c2NyZWVu" };
    },
    async perform(action) {
      events.push(action.type);
      return { performed: action.type };
    },
    async cancel() {
      events.push("cancel");
    },
  };
}

describe("Computer Use bridge", () => {
  it("denies desktop actions by default and requires approval when enabled", async () => {
    const events: string[] = [];
    const denied = new ComputerUseBridge({ adapter: adapter(events) });
    await expect(denied.call({ action: { type: "click", x: 10, y: 20 } })).rejects.toThrow(/disabled|denied/i);

    const approved = new ComputerUseBridge({ adapter: adapter(events), enabled: true, requireApproval: true, approve: async () => false });
    await expect(approved.call({ action: { type: "click", x: 10, y: 20 } })).rejects.toThrow(/approval/i);
    expect(events).toEqual([]);
  });

  it("records screenshots and executes approved actions", async () => {
    const events: string[] = [];
    const bridge = new ComputerUseBridge({ adapter: adapter(events), enabled: true, requireApproval: true, approve: async () => true });

    await expect(bridge.call({ action: { type: "screenshot" } })).resolves.toMatchObject({ mediaType: "image/png" });
    await expect(bridge.call({ action: { type: "type", text: "hello" } })).resolves.toMatchObject({ performed: "type" });
    expect(events).toEqual(["screenshot", "type"]);
  });
});
