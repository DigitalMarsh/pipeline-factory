import { describe, expect, it } from "vitest";
import {
  ModelRunBranchNameGenerator,
  allocateRunBranchLeaf,
  composeRunBranchLeaf,
  normalizeRunBranchSlug,
  runBranchDate,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
} from "./index.js";

function model(output: string): { gateway: ModelGateway; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway = {
    configFor: () => ({ model: "test-model" }),
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "text.delta", text: output };
      yield { type: "turn.completed" };
    },
    async answerUserInput() { return undefined; },
    async cancel() { return undefined; },
  };
  return { gateway, requests };
}

describe("Run branch naming", () => {
  it("formats the creation date in Asia/Shanghai and composes the branch leaf", () => {
    const createdAt = "2026-09-05T16:00:00.000Z";

    expect(runBranchDate(createdAt)).toBe("20260906");
    expect(composeRunBranchLeaf(createdAt, "vue intro")).toBe("20260906-vue-intro");
    expect(composeRunBranchLeaf(createdAt, "")).toBe("20260906-change");
  });

  it("normalizes model output into a bounded lowercase slug", () => {
    expect(normalizeRunBranchSlug("```text\n\"Vue Intro: Router\"\n```")).toBe("vue-intro-router");
    expect(normalizeRunBranchSlug("Vue Intro Router State Persistence Extra Word")).toBe("vue-intro-router-state");
    expect(normalizeRunBranchSlug("中文需求")).toBeNull();
  });

  it("uses the Explorer model role with the branch-specific English prompt", async () => {
    const { gateway, requests } = model("Vue Intro");
    const generator = new ModelRunBranchNameGenerator(gateway);

    await expect(generator.generate({ createdAt: "2026-09-06T00:00:00.000Z", planTitle: "Vue 使用手册", goal: "Build a Vue introduction guide" })).resolves.toBe("vue-intro");
    expect(requests[0]).toMatchObject({ role: "explorer", purpose: "title" });
    expect(requests[0]?.messages[0]?.content).toContain("Build a Vue introduction guide");
  });

  it("allocates readable numeric suffixes for persisted branch collisions", () => {
    expect(allocateRunBranchLeaf("20260906-vue-intro", [])).toBe("20260906-vue-intro");
    expect(allocateRunBranchLeaf("20260906-vue-intro", ["factory/20260906-vue-intro"])).toBe("20260906-vue-intro-2");
    expect(allocateRunBranchLeaf("20260906-vue-intro", ["factory/20260906-vue-intro", "factory/20260906-vue-intro-2"])).toBe("20260906-vue-intro-3");
  });
});
