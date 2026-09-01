import { describe, expect, it } from "vitest";
import { workbenchLayoutForWidth } from "./workbenchLayout";

describe("workbenchLayoutForWidth", () => {
  it("keeps all evidence columns at desktop width", () => {
    expect(workbenchLayoutForWidth(1280)).toEqual({ mode: "wide", showHistory: true, showContext: true, showMobileTabs: false });
  });

  it("moves the context panel below the inspector before stacking", () => {
    expect(workbenchLayoutForWidth(980)).toMatchObject({ mode: "compact", showHistory: true, showContext: false, showMobileTabs: false });
    expect(workbenchLayoutForWidth(680)).toMatchObject({ mode: "stacked", showHistory: true, showContext: true, showMobileTabs: true });
  });
});
