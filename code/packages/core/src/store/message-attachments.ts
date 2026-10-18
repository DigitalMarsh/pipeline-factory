/**
 * 模块职责：把落库的消息附件转成模型消息里的图片项 —— 三个对话入口（探索回合、项目执行消息、
 *   Run 补充要求）在"组装 ModelMessage"时共用这一处。
 *
 * 为什么单独一个叶子文件：`MessageAttachment.relativePath` 是相对**存储目录**的，而模型要的是
 *   本机绝对路径；领域层不知道数据库放在哪，所以由组合根注入 `AttachmentPathResolver`。
 *   三个服务各写一遍映射的话，迟早有一处忘记解析路径，Provider 收到一个读不到的相对路径。
 *
 * 维护提示：
 *   1) 没有 resolver 时**不产生图片项**，而不是把相对路径原样传下去——Provider 拿相对路径
 *      只会去它自己的 cwd 下找，结果是一轮静默的"图没发出去"。
 *   2) 按 owner 分组返回，调用方一次就能把若干条历史消息的图都挂上（`listAttachments` 本身是
 *      批量查询，不要退化成逐条 getAttachment）。
 */
import type { ModelImagePart } from "../model/types.js";
import type { PipelineStore } from "./pipeline-store.js";
import type { AttachmentOwnerType, MessageAttachment } from "./types.js";

/** 只需要附件读取能力的窄端口；图片映射不应该要求整个 PipelineStore。 */
type AttachmentReader = Pick<PipelineStore, "listAttachments">;

/** 把一条附件记录解析成本机绝对路径；由组合根按存储目录注入。 */
export type AttachmentPathResolver = (attachment: MessageAttachment) => string;

/** 某个 owner 的附件 → 模型图片项，顺序保持落库顺序（即用户选择顺序）。 */
export function imagesByOwner(
  store: AttachmentReader,
  ownerType: AttachmentOwnerType,
  ownerIds: readonly string[],
  resolvePath: AttachmentPathResolver | undefined,
): Map<string, ModelImagePart[]> {
  const grouped = new Map<string, ModelImagePart[]>();
  if (!resolvePath || ownerIds.length === 0) return grouped;
  for (const attachment of store.listAttachments(ownerType, ownerIds)) {
    if (!attachment.ownerId) continue;
    const images = grouped.get(attachment.ownerId) ?? [];
    images.push({ path: resolvePath(attachment), mimeType: attachment.mimeType });
    grouped.set(attachment.ownerId, images);
  }
  return grouped;
}
