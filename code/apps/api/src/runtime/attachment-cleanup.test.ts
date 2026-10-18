/**
 * 测试职责：启动期清理只删"未挂载且超过 TTL"的附件，已挂载的与新上传的都必须留下。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore } from "@pipeline-factory/core";
import { AttachmentStore } from "./attachment-store.js";
import { purgeUnattachedAttachments, UNATTACHED_ATTACHMENT_TTL_MS } from "./attachment-cleanup.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-attachment-cleanup-"));
  directories.push(directory);
  const store = new InMemoryPipelineStore();
  const attachments = new AttachmentStore(join(directory, "db.sqlite"));
  return { store, attachments, directory };
}

function saveAttachment(
  store: InMemoryPipelineStore,
  attachments: AttachmentStore,
  input: { id: string; createdAt: string; owner?: "explorer-turn" | null },
) {
  const written = attachments.write({
    projectId: "project-1",
    attachmentId: input.id,
    mimeType: "image/png",
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  store.saveAttachment({
    id: input.id,
    projectId: "project-1",
    ownerType: input.owner ?? null,
    ownerId: input.owner ? "turn-1" : null,
    fileName: `${input.id}.png`,
    mimeType: "image/png",
    byteSize: written.byteSize,
    relativePath: written.relativePath,
    createdAt: input.createdAt,
  });
  return written;
}

describe("purgeUnattachedAttachments", () => {
  it("removes stale unattached rows and files, keeping attached and recent uploads", () => {
    const { store, attachments } = setup();
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    const old = new Date(now - UNATTACHED_ATTACHMENT_TTL_MS - 1000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    const oldFile = saveAttachment(store, attachments, { id: "old-unattached", createdAt: old });
    const attachedFile = saveAttachment(store, attachments, { id: "old-attached", createdAt: old, owner: "explorer-turn" });
    const recentFile = saveAttachment(store, attachments, { id: "recent-unattached", createdAt: recent });

    expect(purgeUnattachedAttachments(store, attachments, { now })).toBe(1);
    expect(store.getAttachment("old-unattached")).toBeUndefined();
    expect(exists(attachments, oldFile.relativePath)).toBe(false);
    expect(store.getAttachment("old-attached")).toBeDefined();
    expect(exists(attachments, attachedFile.relativePath)).toBe(true);
    expect(store.getAttachment("recent-unattached")).toBeDefined();
    expect(exists(attachments, recentFile.relativePath)).toBe(true);
  });
});

function exists(attachments: AttachmentStore, relativePath: string): boolean {
  try {
    attachments.read(relativePath);
    return true;
  } catch {
    return false;
  }
}
