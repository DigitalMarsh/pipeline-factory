/**
 * 模块职责：启动期清理**未挂载附件** —— 上传成功、但回合/消息没创建成功的图片。
 *
 * 为什么需要：附件分两步落库（先上传行、回合创建后挂 owner）。第二步失败时（用户关掉对话框、
 *   回合参数非法、进程在两步之间退出），行与文件会永远留下；没有清理，长期运行会持续吃磁盘。
 *   清理放在启动期，避免和"正在提交中的上传"抢同一个附件。
 *
 * 维护提示：
 *   1) **只删 `owner_id IS NULL` 且早于 TTL 的行**。TTL 是给"正在提交"留的窗口，不能改成 0。
 *   2) 先删文件再删行：反过来的话，行没了就再也查不到文件路径（虽然文件也可能已不存在）。
 *      文件删除失败不会阻止行删除——孤儿文件比孤儿行更容易被发现与手工清理。
 *   3) 清理失败只记日志，不让 API 起不来：这是运维优化，不是启动前置条件。
 */
import type { PipelineStore } from "@pipeline-factory/core";
import type { AttachmentStore } from "./attachment-store.js";

/** 未挂载附件的保留时长：足够覆盖一次慢请求/浏览器重试，又不会长期堆积。 */
export const UNATTACHED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export function purgeUnattachedAttachments(
  store: PipelineStore,
  attachments: AttachmentStore,
  options: { now?: number; ttlMs?: number } = {},
): number {
  const cutoff = new Date((options.now ?? Date.now()) - (options.ttlMs ?? UNATTACHED_ATTACHMENT_TTL_MS)).toISOString();
  let removed = 0;
  for (const attachment of store.listUnattachedAttachments(cutoff)) {
    attachments.delete(attachment.relativePath);
    store.deleteAttachment(attachment.id);
    removed += 1;
  }
  return removed;
}

/** `createApp` 用的安全包装：清理失败不阻断启动。 */
export function purgeUnattachedAttachmentsSafe(store: PipelineStore, attachments: AttachmentStore): void {
  try {
    const removed = purgeUnattachedAttachments(store, attachments);
    if (removed > 0) console.log(`[attachments] removed ${removed} unattached attachment(s) older than 24h`);
  } catch (error) {
    console.error(`[attachments] failed to purge unattached attachments: ${error instanceof Error ? error.message : String(error)}`);
  }
}
