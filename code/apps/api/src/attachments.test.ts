/**
 * 测试职责：消息附件的 HTTP 边界 —— 上传校验（大小 / mime / base64 / 文件头）、读取归属、
 *   以及"回合带上 attachmentIds 后，返回的消息里确实有附件"。
 *
 * 设计说明：用真实临时目录做附件存储（`databasePath` 的目录），项目用内存 Store 建；
 *   不需要起真实服务，全部走 `app.inject`。图片字节用一张 1×1 PNG，足以通过文件头校验。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, ProjectService } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_PREFIX_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function setup(projectIds: readonly string[] = ["project-1"]) {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-attachments-api-"));
  directories.push(directory);
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  for (const id of projectIds) {
    projects.create({ id, name: id, repoRoot: `/repo/${id}`, defaultBranch: "main", worktreeRoot: `/tmp/${id}-worktrees` });
  }
  const app = createApp({ store, seed: false, databasePath: join(directory, "api.sqlite") });
  apps.push(app);
  return { app, store, directory };
}

function uploadBody(overrides: Record<string, unknown> = {}) {
  return { fileName: "shot.png", mimeType: "image/png", dataBase64: PNG_BASE64, ...overrides };
}

describe("attachment routes", () => {
  it("stores a valid image and serves it back with its content type", async () => {
    const { app, directory } = setup();
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/attachments",
      payload: uploadBody(),
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = (uploaded.json() as { attachment: { id: string; url: string; byteSize: number; mimeType: string } }).attachment;
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.byteSize).toBe(Buffer.from(PNG_BASE64, "base64").byteLength);
    expect(attachment.url).toBe(`/api/v4/projects/project-1/attachments/${attachment.id}`);
    expect(readFileSync(join(directory, "attachments", "project-1", `${attachment.id}.png`)).byteLength).toBe(attachment.byteSize);

    const served = await app.inject({ method: "GET", url: attachment.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.rawPayload.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
  });

  it("rejects a declared mime that does not match the file bytes", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/attachments",
      payload: uploadBody({ mimeType: "image/jpeg", dataBase64: PNG_BASE64 }),
    });
    expect(response.statusCode).toBe(415);
    expect((response.json() as { code: string }).code).toBe("ATTACHMENT_MIME_MISMATCH");
  });

  it("rejects malformed base64 and oversized images", async () => {
    const { app } = setup();
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/attachments",
      payload: uploadBody({ dataBase64: "not-base64!!" }),
    });
    expect(malformed.statusCode).toBe(400);
    expect((malformed.json() as { code: string }).code).toBe("ATTACHMENT_INVALID_BASE64");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/attachments",
      payload: uploadBody({ dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }),
    });
    expect(oversized.statusCode).toBe(413);
    expect((oversized.json() as { code: string }).code).toBe("ATTACHMENT_TOO_LARGE");
  });

  it("returns 404 for another project's attachment id and for unknown ids", async () => {
    const { app } = setup(["project-1", "project-2"]);
    const uploaded = await app.inject({ method: "POST", url: "/api/v4/projects/project-1/attachments", payload: uploadBody() });
    const attachment = (uploaded.json() as { attachment: { id: string } }).attachment;

    const foreign = await app.inject({ method: "GET", url: `/api/v4/projects/project-2/attachments/${attachment.id}` });
    expect(foreign.statusCode).toBe(404);
    const missing = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/attachments/attachment-missing" });
    expect(missing.statusCode).toBe(404);
  });

  it("attaches uploaded images to the execution-thread message and rejects another project's ids", async () => {
    const { app } = setup(["project-1", "project-2"]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/attachments",
      payload: uploadBody({ fileName: "jpeg-shot.jpg", mimeType: "image/jpeg", dataBase64: JPEG_PREFIX_BASE64 }),
    });
    const attachment = (uploaded.json() as { attachment: { id: string } }).attachment;

    const turn = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/execution-thread/turns",
      payload: { content: "看这张图", clientTurnId: "client-1", attachmentIds: [attachment.id] },
    });
    expect(turn.statusCode).toBe(200);
    const body = turn.json() as { user: { attachments?: Array<{ id: string; url: string }> } };
    expect(body.user.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);

    // 读取快照时附件也在（刷新后仍然看得到）。
    const snapshot = await app.inject({ method: "GET", url: "/api/v4/projects/project-1/execution-thread" });
    const messages = (snapshot.json() as { messages: Array<{ role: string; attachments?: Array<{ id: string }> }> }).messages;
    expect(messages.find((message) => message.role === "user")?.attachments?.map((item) => item.id)).toEqual([attachment.id]);

    // 另一个项目拿到同一个 id 不能挂到自己的消息上。
    const foreign = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-2/execution-thread/turns",
      payload: { content: "偷图", clientTurnId: "client-2", attachmentIds: [attachment.id] },
    });
    expect(foreign.statusCode).toBe(400);
    expect((foreign.json() as { code: string }).code).toContain("ATTACHMENT_NOT_FOUND");
  });

  it("rejects more than five attachment ids on a turn", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v4/projects/project-1/execution-thread/turns",
      payload: { content: "太多图", clientTurnId: "client-many", attachmentIds: ["1", "2", "3", "4", "5", "6"] },
    });
    expect(response.statusCode).toBe(400);
  });
});
