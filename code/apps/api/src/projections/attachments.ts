/**
 * 模块职责：消息附件的**对外视图**（`AttachmentDto`）与按 owner 批量补齐。
 *
 * 为什么放在 projections/ 而不是 routes/：Run 的执行线程投影（run-telemetry.ts）也要把补充要求的图片
 *   挂到 journal 上，而投影不该反向 import 路由。这里只依赖 store 类型，两边都能用。
 *
 * 维护提示：
 *   1) `url` 是相对 API 根的路径，浏览器直接当 `<img src>`；不要在别处再拼一遍。
 *   2) 一次 `listAttachments` 批量取，**不要在调用方逐条 getAttachment**。
 */
import type { AttachmentOwnerType, MessageAttachment, PipelineStore } from "@pipeline-factory/core";

export type AttachmentDto = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  url: string;
  createdAt: string;
};

export function attachmentDto(projectId: string, attachment: MessageAttachment): AttachmentDto {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    url: `/api/v4/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachment.id)}`,
    createdAt: attachment.createdAt,
  };
}

export function attachmentsFor(
  store: PipelineStore,
  projectId: string,
  ownerType: AttachmentOwnerType,
  ownerIds: readonly string[],
): Map<string, AttachmentDto[]> {
  const grouped = new Map<string, AttachmentDto[]>();
  for (const attachment of store.listAttachments(ownerType, ownerIds)) {
    if (!attachment.ownerId) continue;
    const list = grouped.get(attachment.ownerId) ?? [];
    list.push(attachmentDto(projectId, attachment));
    grouped.set(attachment.ownerId, list);
  }
  return grouped;
}
