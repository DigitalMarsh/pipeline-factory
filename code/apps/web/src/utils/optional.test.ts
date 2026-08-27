import { describe, expect, it } from "vitest";
import { optional } from "./optional";

describe("optional async loading", () => {
  it("returns the resolved value", async () => {
    await expect(optional(async () => "value")).resolves.toBe("value");
  });

  it("turns a missing optional resource into null", async () => {
    await expect(optional(async () => { throw new Error("not found"); })).resolves.toBeNull();
  });
});
