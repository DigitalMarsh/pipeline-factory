/**
 * 测试职责：验证 listEvents 的 aggregateIds / types 过滤在两种 Store 上语义一致。
 * 设计说明：这两个参数是把"读全表再在内存里筛"下推到 SQL 的关键，
 * 一旦某个实现漏掉某个过滤维度，调用方会静默丢事件而不是报错，因此必须锁死契约。
 * 维护提示：新增过滤维度时，两个实现和本文件都要同步。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, SqlitePipelineStore, type PipelineStore } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed(store: PipelineStore): void {
  store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: { revision: 1 } });
  store.appendEvent({ type: "plan.enqueued", aggregateId: "plan-a", payload: { revision: 1 } });
  store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "explorer-a", payload: { text: "streaming" } });
  store.appendEvent({ type: "verification.completed", aggregateId: "run-a", payload: { planId: "plan-a", status: "PASSED" } });
  store.appendEvent({ type: "merge.detected", aggregateId: "merge-a", payload: { planId: "plan-a" } });
}

/** 两种 Store 必须对同一组过滤参数给出完全相同的结果，否则调用方会按实现分叉。 */
function assertBothStores(assertion: (store: PipelineStore) => void): void {
  const memory = new InMemoryPipelineStore();
  seed(memory);
  assertion(memory);

  const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-event-query-"));
  temporaryDirectories.push(directory);
  const sqlite = new SqlitePipelineStore(join(directory, "factory.sqlite"));
  seed(sqlite);
  assertion(sqlite);
}

describe("listEvents filtering", () => {
  it("returns events for several aggregates in one query", () => {
    assertBothStores((store) => {
      const events = store.listEvents({ aggregateIds: ["plan-a", "run-a"] });

      expect(events.map((event) => event.aggregateId)).toEqual(["plan-a", "plan-a", "run-a"]);
    });
  });

  it("filters by event type without dropping the aggregate restriction", () => {
    assertBothStores((store) => {
      const events = store.listEvents({ aggregateIds: ["plan-a", "run-a", "merge-a"], types: ["plan.confirmed", "verification.completed"] });

      expect(events.map((event) => event.type)).toEqual(["plan.confirmed", "verification.completed"]);
    });
  });

  it("treats an empty filter list as no filter rather than as an empty result", () => {
    assertBothStores((store) => {
      expect(store.listEvents({ types: [] }).map((event) => event.type)).toEqual([
        "plan.confirmed", "plan.enqueued", "explorer.turn.text.delta", "verification.completed", "merge.detected",
      ]);
      expect(store.listEvents({ aggregateIds: [] })).toHaveLength(5);
    });
  });

  it("keeps limit as the newest N of the filtered set", () => {
    assertBothStores((store) => {
      expect(store.listEvents({ aggregateIds: ["plan-a"], limit: 1 }).map((event) => event.type)).toEqual(["plan.enqueued"]);
    });
  });

  it("rejects mixing aggregateId with aggregateIds", () => {
    assertBothStores((store) => {
      expect(() => store.listEvents({ aggregateId: "plan-a", aggregateIds: ["plan-a"] })).toThrow(/either aggregateId or aggregateIds/);
    });
  });
});
