import { EXPLORER_PLAN_REQUIREMENTS } from "@pipeline-factory/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORER_PLAN_REQUIREMENTS } from "./explorerPlanRequirements";

describe("Explorer requirements fallback", () => {
  it("matches the domain manifest area-for-area", () => {
    expect(DEFAULT_EXPLORER_PLAN_REQUIREMENTS).toEqual(EXPLORER_PLAN_REQUIREMENTS.areas);
  });
});
