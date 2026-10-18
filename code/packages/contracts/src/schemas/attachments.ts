/**
 * 模块职责：消息附件上传的输入 schema。
 *
 * 维护提示：
 *   1) **上传走 base64 JSON**，不引入 multipart 依赖。`dataBase64` 只校验"是 base64 形状"，
 *      真实大小与类型由路由在解码后复核（base64 长度 ≠ 字节数，schema 层算不准）。
 *   2) `mimeType` 的白名单与 `runtime/attachment-store.ts` 的扩展名表同源；在这里放宽会让
 *      一个落不了盘的 mime 通过校验，直到写文件时才 500。
 */
import { z } from "zod";

export const ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const attachmentUploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(ATTACHMENT_MIME_TYPES),
  /** 不含 data URL 前缀的纯 base64。 */
  dataBase64: z.string().min(1),
});

export const attachmentParams = z.object({ projectId: z.string().min(1), attachmentId: z.string().min(1) });

/** 三条回合接口共用的附件 id 列表；上限与服务端校验同源。 */
export const attachmentIds = z.array(z.string().min(1)).max(5).optional();
