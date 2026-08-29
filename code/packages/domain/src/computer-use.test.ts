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
