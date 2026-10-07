import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { statusVisualFor } from "./statusVisual";
import { planStatusLabel } from "./planStatus";

describe("statusVisualFor", () => {
  it("Plan 与派发状态共用一套语气色", () => {
    expect(statusVisualFor("IN_PROGRESS")).toMatchObject({ label: "执行中", tone: "info" });
    expect(statusVisualFor("WAITING_GLOBAL_CAPACITY")).toMatchObject({ label: "等待中 · 全局并发已满", tone: "warning" });
    expect(statusVisualFor("MERGED")).toMatchObject({ label: "已合并", tone: "success" });
    expect(statusVisualFor("unexpected")).toMatchObject({ label: "Unexpected", tone: "neutral" });
  });

  it("Plan 状态的文案只有一份：本文件不再自带第二张表", () => {
    // 此前这里另有一份 `DRAFT: "Draft"` / `READY: "Ready"` / `MERGE_READY: "Needs review"`，
    // 而 `planStatusLabel` 给的是 Candidate / Confirmed / Ready for review——同一个 Plan
    // 在抽屉里一个词、在工作台上另一个词。现在 Plan 状态一律从那边取。
    // 这份清单就是 `PlanStatus` 的全部取值——"哪里有 Plan 状态文案"与"Plan 能到达哪些状态"是同一个集合。
    const statuses: string[] = [
      "DRAFT",
      "READY",
      "ENQUEUED",
      "DISPATCHED",
      "IN_PROGRESS",
      "VERIFYING",
      "MERGE_READY",
      "MERGED",
      "BLOCKED",
      "NEEDS_PLAN_CHANGE",
      "DISCARDED",
    ];
    for (const status of statuses) expect(statusVisualFor(status).label).toBe(planStatusLabel(status));

    const source = readFileSync(fileURLToPath(new URL("./statusVisual.ts", import.meta.url)), "utf8");
    for (const status of statuses) expect(source).not.toContain(`  ${status}: { label:`);
  });
});
