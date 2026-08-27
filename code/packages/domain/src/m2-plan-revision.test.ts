import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService } from "./index.js";

describe("PlanRevisionV2", () => {
  it("freezes the execution contract and records a stable artifact hash on confirmation", () => {
    const service = new PlanService(new InMemoryPipelineStore());
    const candidate = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Freeze this plan" });
    service.confirm(candidate.id, "user-1");

    const revision = service.getRevision(candidate.id, 1);
    expect(revision).toMatchObject({ planId: candidate.id, revision: 1, confirmedBy: "user-1", artifactHash: expect.stringMatching(/^sha256:/) });
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.contract)).toBe(true);
    expect(service.enqueue(candidate.id).revision).toBe(1);
  });
});
