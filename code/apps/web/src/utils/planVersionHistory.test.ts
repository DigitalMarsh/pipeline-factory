import { describe, expect, it } from "vitest";
import { isConfirmedPlanRevision, resolvePlanVersionHistory } from "./planVersionHistory";

describe("Plan version history", () => {
  it("keeps candidate snapshots browseable alongside frozen revisions", () => {
    expect(resolvePlanVersionHistory(
      [{ revision: 1 }, { revision: 2 }],
      [{ revision: 2 }],
    )).toEqual({ revisions: [1, 2], confirmedRevisions: [2] });
  });

  it("deduplicates and sorts versions from both histories", () => {
    expect(resolvePlanVersionHistory(
      [{ revision: 3 }, { revision: 1 }, { revision: 2 }],
      [{ revision: 2 }, { revision: 1 }],
    )).toEqual({ revisions: [1, 2, 3], confirmedRevisions: [1, 2] });
  });

  it("identifies which historical entries must load from the frozen revision store", () => {
    expect(isConfirmedPlanRevision(1, [1, 2])).toBe(true);
    expect(isConfirmedPlanRevision(3, [1, 2])).toBe(false);
  });
});
