/**
 * 模块职责：三个对话输入框共用的**待发送图片**状态 —— 粘贴 / 拖拽 / 选择文件、校验、预览、
 *   移除，以及提交时并行上传拿回 `attachmentIds`。
 *
 * 为什么做成 composable 而不是组件内部状态：探索、Run 补充要求、项目执行三处的输入框结构不同
 *   （一个是 textarea + 按钮，一个在详情页底部，一个在面板里），但"怎么收图、怎么校验、怎么上传"
 *   必须完全一致；复制三份之后上限与错误文案就会各说各话。
 *
 * 维护提示：
 *   1) **上限在前端与服务端各校验一次**（5MB / 5 张 / 四种 mime）。前端拦是为了立刻给原因，
 *      服务端拦是因为前端校验永远只是体验。
 *   2) object URL 属于预览，**移除 / 清空 / 作用域销毁时都要 revoke**；不 revoke 的话每张图
 *      都会把解码后的位图留在内存里，切几次线程就能看出来。
 *   3) 上传失败**不丢本地预览**：调用方拿到的异常里带"第几张、为什么"，用户可以重试或删掉那张。
 */
import { onScopeDispose, ref } from "vue";
import { api } from "../api";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;
export const ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type PendingImageAttachment = {
  key: string;
  file: File;
  /** 本地 object URL；只在发送前显示，服务端返回的记录用 `MessageAttachment.url`。 */
  previewUrl: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
};

let keySeed = 0;

/** 文件校验的单点：返回 null 表示可以收，否则是给用户看的原因。 */
export function attachmentRejection(file: File, currentCount: number): string | null {
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) return "只支持 PNG / JPEG / WebP / GIF 图片";
  if (file.size > ATTACHMENT_MAX_BYTES) return "单张图片不能超过 5MB";
  if (currentCount >= ATTACHMENT_MAX_FILES) return `每条消息最多 ${ATTACHMENT_MAX_FILES} 张图片`;
  return null;
}

/** File → 纯 base64（不含 data URL 前缀），与服务端 schema 的约定一致。 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // 分块拼接：一次性展开 5MB 的字节数组会让 `String.fromCharCode(...)` 撞上参数个数上限。
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function useImageAttachments() {
  const items = ref<PendingImageAttachment[]>([]);
  const error = ref<string | null>(null);

  function revoke(item: PendingImageAttachment): void {
    URL.revokeObjectURL(item.previewUrl);
  }

  /**
   * 收一批文件。**逐张校验、能收几张收几张**，并如实报告被拒的原因——整批拒绝会让用户
   * 不知道是第几张、为什么。
   */
  function addFiles(files: readonly File[]): void {
    error.value = null;
    const additions: PendingImageAttachment[] = [];
    for (const [index, file] of files.entries()) {
      const rejection = attachmentRejection(file, items.value.length + additions.length);
      if (rejection) {
        // 只保留**第一条**原因：一批里连拒三张时，最后一条通常只是"已经满了"，会把真正的原因盖掉。
        if (!error.value) error.value = files.length > 1 ? `第 ${index + 1} 张：${rejection}` : rejection;
        continue;
      }
      additions.push({
        key: `attachment-${++keySeed}`,
        file,
        previewUrl: URL.createObjectURL(file),
        fileName: file.name || `image-${keySeed}`,
        byteSize: file.size,
        mimeType: file.type,
      });
    }
    if (additions.length > 0) items.value = [...items.value, ...additions];
  }

  function remove(key: string): void {
    const item = items.value.find((candidate) => candidate.key === key);
    if (item) revoke(item);
    items.value = items.value.filter((candidate) => candidate.key !== key);
  }

  function clear(): void {
    for (const item of items.value) revoke(item);
    items.value = [];
    error.value = null;
  }

  /** 并行上传，返回按用户选择顺序排列的附件 id；任一张失败就抛错（前面已上传的保留在服务端待清理）。 */
  async function upload(projectId: string): Promise<string[]> {
    if (items.value.length === 0) return [];
    const uploaded = await Promise.all(
      items.value.map(async (item, index) => {
        try {
          const base64 = await fileToBase64(item.file);
          const result = await api.uploadAttachment(projectId, {
            fileName: item.fileName,
            mimeType: item.mimeType,
            dataBase64: base64,
          });
          return result.attachment.id;
        } catch (failure) {
          const reason = failure instanceof Error ? failure.message : "上传失败";
          throw new Error(`第 ${index + 1} 张图片上传失败：${reason}`, { cause: failure });
        }
      }),
    );
    return uploaded;
  }

  onScopeDispose(() => {
    for (const item of items.value) revoke(item);
  });

  return { items, error, addFiles, remove, clear, upload };
}
