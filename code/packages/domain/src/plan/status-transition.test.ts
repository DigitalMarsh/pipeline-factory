/**
 * 测试职责：钉住 Plan 状态的**转换表**——它是"哪些转换存在"的唯一出处，也是 `updatePlanStatus` 的守卫。
 *
 * 为什么值得单独一个文件：建表之前，"哪些转换合法"有四处互不知道的副本（四处 `includes` 白名单、
 * 三块归一化补丁、两份 Run→Plan 映射），而写入点本身没有任何检查——从 `BLOCKED` 直接跳回 `READY`
 * 也只是安静地落库。这里的每条断言都对应那个缺口。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { PlanService } from "./service.js";
import { canTransitionPlanStatus, updatePlanStatus } from "./status-transition.js";
import { planContractFixture } from "./plan-fixture.js";
import type { PlanStatus } from "./types.js";

const ALL_STATUSES: PlanStatus[] = ["DRAFT", "DISCARDED", "READY", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED", "BLOCKED", "NEEDS_PLAN_CHANGE"];

/** 主路径，逐步可走。 */
const MAIN_PATH: PlanStatus[] = ["READY", "ENQUEUED", "DISPATCHED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED"];

/** 「从任意非终态进入」的三个入口。 */
const RESET_TARGETS: PlanStatus[] = ["BLOCKED", "READY", "NEEDS_PLAN_CHANGE"];

function fixture() {
  const store = new InMemoryPipelineStore();
  const plans = new PlanService(store);
  const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Transition table", resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Transition table" }) });
  return { store, plans, planId: plan.id, current: () => store.getPlan(plan.id)! };
}

describe("Plan 状态转换表", () => {
  it("主路径一步步走通，每一步都落在表里", () => {
    const { store, planId, current } = fixture();
    let from = current().status;
    for (const status of MAIN_PATH) {
      expect(canTransitionPlanStatus(from, status), `${from} → ${status}`).toBe(true);
      updatePlanStatus(store, current(), { status });
      from = status;
    }
    expect(current().status).toBe("MERGED");
  });

  it("三个「推翻重来」的入口从任意非终态都能进，DISCARDED 除外", () => {
    for (const from of ALL_STATUSES) {
      for (const to of RESET_TARGETS) {
        expect(canTransitionPlanStatus(from, to), `${from} → ${to}`).toBe(from !== "DISCARDED");
      }
    }
  });

  it("DISCARDED 只能从 DRAFT 进，且它自己出不去——真正不可逆的终态只有它", () => {
    for (const from of ALL_STATUSES) {
      expect(canTransitionPlanStatus(from, "DISCARDED"), `${from} → DISCARDED`).toBe(from === "DRAFT");
    }
    expect(canTransitionPlanStatus("DISCARDED", "DRAFT")).toBe(false);
    expect(canTransitionPlanStatus("DISCARDED", "BLOCKED")).toBe(false);
    expect(canTransitionPlanStatus("DISCARDED", "READY")).toBe(false);
  });

  it("跨级的边不合法：草稿不能直接变成已合并，也不能跳过入队", () => {
    expect(canTransitionPlanStatus("DRAFT", "MERGED")).toBe(false);
    expect(canTransitionPlanStatus("DRAFT", "IN_PROGRESS")).toBe(false);
    expect(canTransitionPlanStatus("READY", "IN_PROGRESS")).toBe(false);
    expect(canTransitionPlanStatus("READY", "MERGED")).toBe(false);
    expect(canTransitionPlanStatus("ENQUEUED", "IN_PROGRESS")).toBe(false);
  });

  it("**先判后写**：非法转换抛错，而且 store 里的状态没有被动过", () => {
    const { store, planId, current } = fixture();
    expect(() => updatePlanStatus(store, current(), { status: "MERGED" })).toThrow(/Illegal plan status transition: DRAFT → MERGED/);
    expect(current().status).toBe("DRAFT");
    // 抛错也没留下半条审计事件。
    expect(store.listEvents({ aggregateId: planId }).filter((event) => event.type === "plan.status.changed")).toEqual([]);
  });

  it("同状态不算转换：传一个不改状态的 updates 不会触发守卫，也不会写事件", () => {
    const { store, current } = fixture();
    expect(() => updatePlanStatus(store, current(), { title: "改个标题" })).not.toThrow();
    expect(current().title).toBe("改个标题");
  });
});
