/**
 * 测试职责：图片附件的**前端准入与上传** —— 类型 / 大小 / 张数校验、逐张报告原因、
 *   移除时释放 object URL、上传后按顺序返回 attachmentIds，以及上传失败时的定位文案。
 *
 * 设计说明：jsdom 没有 `URL.createObjectURL`，这里按测试需要补上（并断言 revoke 被调用）；
 *   `api.uploadAttachment` 用 mock 替换，不访问网络。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

const { uploadAttachment } = vi.hoisted(() => ({ uploadAttachment: vi.fn() }));
vi.mock("../api", () => ({ api: { uploadAttachment } }));

import { ATTACHMENT_MAX_BYTES, attachmentRejection, fileToBase64, useImageAttachments } from "./useImageAttachments";

const createObjectURL = vi.fn(() => "blob:preview");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  uploadAttachment.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true, writable: true });
});

function image(name = "a.png", type = "image/png", size = 4): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

/** composable 用 onScopeDispose，必须在 effectScope 里调用。 */
function withAttachments<T>(run: (attachments: ReturnType<typeof useImageAttachments>) => T): T {
  const scope = effectScope();
  const result = scope.run(() => run(useImageAttachments()))!;
  scope.stop();
  return result;
}

describe("attachmentRejection", () => {
  it("accepts the four whitelisted image types only", () => {
    expect(attachmentRejection(image("a.png", "image/png"), 0)).toBeNull();
    expect(attachmentRejection(image("a.jpg", "image/jpeg"), 0)).toBeNull();
    expect(attachmentRejection(image("a.webp", "image/webp"), 0)).toBeNull();
    expect(attachmentRejection(image("a.gif", "image/gif"), 0)).toBeNull();
    expect(attachmentRejection(image("a.pdf", "application/pdf"), 0)).toBe("只支持 PNG / JPEG / WebP / GIF 图片");
  });

  it("rejects images over 5MB and more than five per message", () => {
    expect(attachmentRejection(image("big.png", "image/png", ATTACHMENT_MAX_BYTES + 1), 0)).toBe("单张图片不能超过 5MB");
    expect(attachmentRejection(image("a.png"), 5)).toBe("每条消息最多 5 张图片");
  });
});

describe("useImageAttachments", () => {
  it("keeps valid files, reports the rejecting index for a mixed batch, and stops at five", () =>
    withAttachments((attachments) => {
      attachments.addFiles([image("1.png"), image("2.png"), image("bad.pdf", "application/pdf"), image("4.png")]);
      expect(attachments.items.value).toHaveLength(3);
      expect(attachments.error.value).toBe("第 3 张：只支持 PNG / JPEG / WebP / GIF 图片");

      attachments.addFiles([image("5.png"), image("6.png"), image("7.png")]);
      expect(attachments.items.value).toHaveLength(5);
      // 前两张补满 5 张，第 3 张才被拒——报的是它在这次选择里的序号。
      expect(attachments.error.value).toBe("第 3 张：每条消息最多 5 张图片");
    }));

  it("revokes the preview URL when an item is removed or cleared", () =>
    withAttachments((attachments) => {
      attachments.addFiles([image("1.png"), image("2.png")]);
      const [first, second] = attachments.items.value;
      attachments.remove(first!.key);
      expect(revokeObjectURL).toHaveBeenCalledWith(first!.previewUrl);
      expect(attachments.items.value).toEqual([second]);
      attachments.clear();
      expect(revokeObjectURL).toHaveBeenCalledWith(second!.previewUrl);
      expect(attachments.items.value).toEqual([]);
    }));

  it("uploads every attachment and returns ids in selection order", () =>
    withAttachments(async (attachments) => {
      uploadAttachment
        .mockResolvedValueOnce({ attachment: { id: "attachment-1" } })
        .mockResolvedValueOnce({ attachment: { id: "attachment-2" } });
      attachments.addFiles([image("1.png"), image("2.png")]);

      await expect(attachments.upload("project-1")).resolves.toEqual(["attachment-1", "attachment-2"]);
      expect(uploadAttachment).toHaveBeenCalledTimes(2);
      expect(uploadAttachment).toHaveBeenNthCalledWith(1, "project-1", {
        fileName: "1.png",
        mimeType: "image/png",
        dataBase64: expect.any(String),
      });
    }).then((value) => value));

  it("names the failing image when an upload fails", () =>
    withAttachments(async (attachments) => {
      uploadAttachment.mockResolvedValueOnce({ attachment: { id: "attachment-1" } }).mockRejectedValueOnce(new Error("请求失败：413"));
      attachments.addFiles([image("1.png"), image("2.png")]);

      await expect(attachments.upload("project-1")).rejects.toThrow("第 2 张图片上传失败：请求失败：413");
    }).then((value) => value));

  it("converts file bytes to plain base64", async () => {
    await expect(fileToBase64(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" }))).resolves.toBe(
      btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)),
    );
  });
});
