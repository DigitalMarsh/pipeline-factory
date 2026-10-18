/**
 * 测试职责：消息附件的**跨实现契约** —— 保存、挂载、按 owner 批量读取、级联删除，
 *   以及"一个附件只能属于一个 owner"这条防止跨消息串图的约束。
 *
 * 设计说明：与 store-contract.test.ts 同一套做法，同一批断言在内存与 SQLite 上各跑一遍。
 *   这里单独成文件而不是塞进那份契约套件，是因为附件表是新加的、风险集中在"两种存储对归属的处理"，
 *   单独成篇读起来更直接；store-contract 已断言两侧都暴露了这几个端口方法。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, SqlitePipelineStore, type MessageAttachment, type PipelineStore } from "./index.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function memoryStore(): PipelineStore {
  return new InMemoryPipelineStore();
}

function sqliteStore(): PipelineStore {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-attachments-"));
  const store = new SqlitePipelineStore(join(directory, "store.sqlite"));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function assertBothStores(assert: (store: PipelineStore, kind: "memory" | "sqlite") => void): void {
  assert(memoryStore(), "memory");
  assert(sqliteStore(), "sqlite");
}

function attachment(id: string, projectId = "project-1"): MessageAttachment {
  return {
    id,
    projectId,
    ownerType: null,
    ownerId: null,
    fileName: `${id}.png`,
    mimeType: "image/png",
    byteSize: 12,
    relativePath: `attachments/${projectId}/${id}.png`,
    createdAt: `2026-10-18T00:00:0${id.slice(-1)}.000Z`,
  };
}

describe("message attachments contract", () => {
  it("round-trips an uploaded attachment and reports rows scoped by project", () => {
    assertBothStores((store) => {
      const saved = store.saveAttachment(attachment("attachment-1"));
      expect(store.getAttachment(saved.id)).toMatchObject({ id: "attachment-1", projectId: "project-1", ownerType: null, ownerId: null });
      expect(store.getAttachment("missing")).toBeUndefined();
    });
  });

  it("attaches uploads to their owner and lists them in stable order", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1"));
      store.saveAttachment(attachment("attachment-2"));
      expect(store.attachAttachments("explorer-turn", "turn-1", ["attachment-2", "attachment-1"])).toHaveLength(2);

      const listed = store.listAttachments("explorer-turn", ["turn-1"]);
      expect(listed.map((item) => item.id)).toEqual(["attachment-1", "attachment-2"]);
      expect(listed.every((item) => item.ownerType === "explorer-turn" && item.ownerId === "turn-1")).toBe(true);
      // 别的 owner / 别的 owner 类型都读不到。
      expect(store.listAttachments("explorer-turn", ["turn-2"])).toEqual([]);
      expect(store.listAttachments("run-guidance", ["turn-1"])).toEqual([]);
    });
  });

  it("never moves an attachment that already belongs to another owner", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1"));
      store.attachAttachments("explorer-turn", "turn-1", ["attachment-1"]);
      store.attachAttachments("explorer-turn", "turn-2", ["attachment-1"]);

      expect(store.listAttachments("explorer-turn", ["turn-1"]).map((item) => item.id)).toEqual(["attachment-1"]);
      expect(store.listAttachments("explorer-turn", ["turn-2"])).toEqual([]);
    });
  });

  it("treats re-attaching to the same owner as idempotent", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1"));
      store.attachAttachments("explorer-turn", "turn-1", ["attachment-1"]);
      expect(store.attachAttachments("explorer-turn", "turn-1", ["attachment-1"])).toHaveLength(1);
      expect(store.listAttachments("explorer-turn", ["turn-1"])).toHaveLength(1);
    });
  });

  it("deletes attachment rows for the given owners only", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1"));
      store.saveAttachment(attachment("attachment-2"));
      store.attachAttachments("explorer-turn", "turn-1", ["attachment-1"]);
      store.attachAttachments("explorer-turn", "turn-2", ["attachment-2"]);

      expect(store.deleteAttachmentsForOwners("explorer-turn", ["turn-1"]).map((item) => item.id)).toEqual(["attachment-1"]);
      expect(store.getAttachment("attachment-1")).toBeUndefined();
      expect(store.getAttachment("attachment-2")).toBeDefined();
    });
  });

  it("returns nothing for an empty owner list instead of scanning every attachment", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1"));
      store.attachAttachments("explorer-turn", "turn-1", ["attachment-1"]);
      expect(store.listAttachments("explorer-turn", [])).toEqual([]);
    });
  });

  it("finds only unattached attachments older than the cutoff, and deletes them by id", () => {
    assertBothStores((store) => {
      store.saveAttachment(attachment("attachment-1")); // createdAt 01
      store.saveAttachment(attachment("attachment-2")); // createdAt 02
      store.attachAttachments("explorer-turn", "turn-1", ["attachment-2"]);

      expect(store.listUnattachedAttachments("2026-10-18T00:00:05.000Z").map((item) => item.id)).toEqual(["attachment-1"]);
      // 已挂载的即使更旧也不该出现在清理清单里。
      expect(store.listUnattachedAttachments("2026-10-19T00:00:00.000Z").map((item) => item.id)).toEqual(["attachment-1"]);

      expect(store.deleteAttachment("attachment-1")?.id).toBe("attachment-1");
      expect(store.getAttachment("attachment-1")).toBeUndefined();
      expect(store.deleteAttachment("attachment-1")).toBeUndefined();
    });
  });
});
