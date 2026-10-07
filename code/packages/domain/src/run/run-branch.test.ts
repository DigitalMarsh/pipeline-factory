import { describe, expect, it } from "vitest";
import {
  ModelRunBranchNameGenerator,
  allocateRunBranchLeaf,
  composeRunBranchLeaf,
  normalizeRunBranchSlug,
  runBranchStamp,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
} from "../index.js";

function model(output: string): { gateway: ModelGateway; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway = {
    configFor: () => ({ model: "test-model" }),
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "text.delta", text: output };
      yield { type: "turn.completed" };
    },
    async answerUserInput() {
      return undefined;
    },
    async cancel() {
      return undefined;
    },
  };
  return { gateway, requests };
}

describe("Run branch naming", () => {
  it("formats the creation time **到秒** in Asia/Shanghai and composes the branch leaf", () => {
    // 2026-09-05T16:00:00Z 在 Asia/Shanghai 是 09-06 00:00:00。
    const createdAt = "2026-09-05T16:00:00.000Z";

    expect(runBranchStamp(createdAt)).toBe("20260906-000000");
    expect(composeRunBranchLeaf(createdAt, "vue intro")).toBe("20260906-000000-vue-intro");
    expect(composeRunBranchLeaf(createdAt, "")).toBe("20260906-000000-change");
  });

  /**
   * **这条是这次改名的理由**：戳只到天的时候，同一天里标题相近的两次 Run 会算出**同一个叶子**，
   * 而叶子就是 `git worktree add -b` 要用的分支名——撞上就把 Run 打成 BLOCKED（实测撞过：
   * 仓库里有同名分支，库里那条 Run 早被删了，分配器问库说"没占"）。
   */
  it("同一天里的两次 Run 拿到不同的叶子；同一秒才是同一个（那点交给 allocateRunBranchLeaf）", () => {
    const first = composeRunBranchLeaf("2026-09-05T16:00:00.000Z", "vue intro");
    const laterSameDay = composeRunBranchLeaf("2026-09-05T16:32:07.000Z", "vue intro");
    const sameSecond = composeRunBranchLeaf("2026-09-05T16:00:00.400Z", "vue intro");

    expect(laterSameDay).toBe("20260906-003207-vue-intro");
    expect(laterSameDay).not.toBe(first);
    expect(sameSecond).toBe(first);
  });

  it("normalizes model output into a bounded lowercase slug", () => {
    expect(normalizeRunBranchSlug('```text\n"Vue Intro: Router"\n```')).toBe("vue-intro-router");
    expect(normalizeRunBranchSlug("Vue Intro Router State Persistence Extra Word")).toBe("vue-intro-router-state");
    expect(normalizeRunBranchSlug("中文需求")).toBeNull();
  });

  it("uses the Explorer model role with the branch-specific English prompt", async () => {
    const { gateway, requests } = model("Vue Intro");
    const generator = new ModelRunBranchNameGenerator(gateway);

    await expect(
      generator.generate({ createdAt: "2026-09-06T00:00:00.000Z", planTitle: "Vue 使用手册", goal: "Build a Vue introduction guide" }),
    ).resolves.toBe("vue-intro");
    expect(requests[0]).toMatchObject({ role: "explorer", purpose: "title" });
    expect(requests[0]?.messages[0]?.content).toContain("Build a Vue introduction guide");
  });

  it("allocates readable numeric suffixes for persisted branch collisions", () => {
    expect(allocateRunBranchLeaf("20260906-vue-intro", [])).toBe("20260906-vue-intro");
    expect(allocateRunBranchLeaf("20260906-vue-intro", ["factory/20260906-vue-intro"])).toBe("20260906-vue-intro-2");
    expect(allocateRunBranchLeaf("20260906-vue-intro", ["factory/20260906-vue-intro", "factory/20260906-vue-intro-2"])).toBe(
      "20260906-vue-intro-3",
    );
  });
});
