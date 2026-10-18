/**
 * 模块职责：消息附件（本轮只有图片）的 2 条路由 —— 上传与读取，以及三条回合接口共用的
 *   "按 owner 批量补附件"辅助函数。
 *
 * 维护提示：
 *   1) **上传路由单独设 bodyLimit**（8MB）。Fastify 默认 1MB，而 5MB 图片转 base64 约 6.7MB；
 *      不改全局限制是有意的——其余路由不需要、也不该接受这么大的正文。
 *   2) 上传的校验顺序是 **schema → 解码大小 → 文件头类型 → 项目存在**。先解码再判大小是因为
 *      base64 字符串长度不等于字节数；先判类型再落盘是为了不让"声明的 png、实际是别的字节"
 *      变成一次可以公开读取的任意内容。
 *   3) 读取按 `project_id` 校验归属：附件 id 是全局唯一的，但跨项目的 id 必须 404，
 *      否则拿到别人的 id 就能读到别人的截图。
 *   4) `attachmentsFor` 一次 `listAttachments` 批量取，**不要在路由里逐条 getAttachment**。
 */
import type { FastifyInstance } from "fastify";
import type { PipelineStore } from "@pipeline-factory/core";
import { attachmentParams, attachmentUploadBody } from "@pipeline-factory/contracts";
import { attachmentDto } from "../projections/attachments.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_EXTENSIONS, sniffImageMime, type AttachmentStore } from "../runtime/attachment-store.js";

export type AttachmentRouteDeps = {
  store: PipelineStore;
  attachments: AttachmentStore;
};

/** 解码并校验 base64；形状不对时返回 null（不抛，让路由决定状态码）。 */
function decodeBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null;
  return Buffer.from(compact, "base64");
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  const { store, attachments } = deps;

  app.post("/api/v4/projects/:projectId/attachments", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const params = attachmentParams.pick({ projectId: true }).safeParse(request.params);
    const body = attachmentUploadBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ code: "ATTACHMENT_INVALID", error: "Invalid attachment upload" });
    const project = store.getProject(params.data.projectId);
    if (!project) return reply.code(404).send({ code: "PROJECT_NOT_FOUND", error: "Project not found" });
    if (!ATTACHMENT_MIME_EXTENSIONS[body.data.mimeType])
      return reply.code(415).send({ code: "ATTACHMENT_MIME_UNSUPPORTED", error: `Unsupported attachment type: ${body.data.mimeType}` });
    const data = decodeBase64(body.data.dataBase64);
    if (!data) return reply.code(400).send({ code: "ATTACHMENT_INVALID_BASE64", error: "Attachment data is not valid base64" });
    if (data.byteLength === 0) return reply.code(400).send({ code: "ATTACHMENT_EMPTY", error: "Attachment is empty" });
    if (data.byteLength > ATTACHMENT_MAX_BYTES)
      return reply.code(413).send({ code: "ATTACHMENT_TOO_LARGE", error: `Attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes` });
    const sniffed = sniffImageMime(data);
    if (sniffed !== body.data.mimeType)
      return reply.code(415).send({ code: "ATTACHMENT_MIME_MISMATCH", error: `Attachment content does not match ${body.data.mimeType}` });
    const id = store.nextId("attachment");
    try {
      const written = attachments.write({ projectId: project.id, attachmentId: id, mimeType: body.data.mimeType, data });
      const saved = store.saveAttachment({
        id,
        projectId: project.id,
        ownerType: null,
        ownerId: null,
        fileName: body.data.fileName,
        mimeType: body.data.mimeType,
        byteSize: written.byteSize,
        relativePath: written.relativePath,
        createdAt: store.now(),
      });
      return reply.code(201).send({ attachment: attachmentDto(project.id, saved) });
    } catch (error) {
      // 元数据写失败时把刚刚落盘的文件删掉，避免留下永远没人引用的孤儿文件。
      attachments.delete(`attachments/${project.id}/${id}${ATTACHMENT_MIME_EXTENSIONS[body.data.mimeType] ?? ""}`);
      const message = error instanceof Error ? error.message : "Attachment upload failed";
      return reply.code(500).send({ code: message, error: message });
    }
  });

  app.get("/api/v4/projects/:projectId/attachments/:attachmentId", async (request, reply) => {
    const params = attachmentParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "ATTACHMENT_INVALID", error: "Invalid attachment request" });
    const attachment = store.getAttachment(params.data.attachmentId);
    if (!attachment || attachment.projectId !== params.data.projectId)
      return reply.code(404).send({ code: "ATTACHMENT_NOT_FOUND", error: "Attachment not found" });
    try {
      const data = attachments.read(attachment.relativePath);
      const download = (request.query as Record<string, unknown> | undefined)?.download;
      if (download === "1" || download === "true")
        reply.header("content-disposition", `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
      return reply.type(attachment.mimeType).send(data);
    } catch {
      return reply.code(404).send({ code: "ATTACHMENT_NOT_FOUND", error: "Attachment file is missing" });
    }
  });
}
