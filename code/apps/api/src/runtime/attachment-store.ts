/**
 * 模块职责：消息附件的**文件**部分 —— 落盘、读取、删除，以及把 `MessageAttachment.relativePath`
 *   解析成本机绝对路径（模型 Provider 要的就是这个路径）。
 *
 * 为什么放在 apps/api 而不是 domain：领域层只保存元数据（`pipeline-store.ts`），不碰文件系统；
 *   "文件放在哪"是部署事实，和数据库文件放在一起（`<dirname(databasePath)>/attachments/<projectId>/`），
 *   不新增配置项。领域服务通过注入的 `attachmentPathFor` 拿绝对路径（见 domain 的
 *   `store/message-attachments.ts`）。
 *
 * 维护提示：
 *   1) **所有读路径都要过一次 `absolutePath`**：数据库里那条 relativePath 是写入时生成的，但它
 *      仍然是被持久化的数据；拼路径时若出现 `..` 或绝对路径，必须拒绝而不是"相信"。
 *      这是附件目录不会变成任意文件读取入口的唯一关口。
 *   2) 文件名只用附件 id + 由 mime 推导的扩展名，**不用用户给的 fileName**——用户文件名可能带
 *      路径分隔符、空格、Unicode 归一化差异，落盘只需要一个稳定、可预测的键。
 *   3) 删除是尽力而为：元数据行删了、文件不存在不算错误（用户可能手工清理过）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import type { MessageAttachment } from "@pipeline-factory/domain";

/** 白名单 mime → 落盘扩展名。与上传路由、前端校验共用同一组取值。 */
export const ATTACHMENT_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MESSAGE = 5;

export class AttachmentStore {
  private readonly baseDir: string;

  constructor(databasePath: string) {
    // `:memory:` 之类的虚拟路径没有目录概念；退到进程 cwd，测试与临时实例都能跑。
    const resolved =
      databasePath === ":memory:" || databasePath.startsWith("file::memory:") ? resolve("pipeline-factory.sqlite") : resolve(databasePath);
    this.baseDir = dirname(resolved);
  }

  /** 相对路径（`attachments/<projectId>/<id>.<ext>`）→ 本机绝对路径；越界直接抛错。 */
  absolutePath(relativePath: string): string {
    if (isAbsolute(relativePath)) throw new Error("Attachment path must be relative to the storage directory");
    const absolute = resolve(this.baseDir, relativePath);
    if (!absolute.startsWith(`${this.baseDir}/`)) throw new Error("Attachment path escapes the storage directory");
    return absolute;
  }

  /** 领域服务用的解析器：附件记录 → 绝对路径。 */
  readonly pathFor = (attachment: MessageAttachment): string => this.absolutePath(attachment.relativePath);

  /** 写入一个附件文件，返回相对路径与真实字节数。 */
  write(input: { projectId: string; attachmentId: string; mimeType: string; data: Buffer }): { relativePath: string; byteSize: number } {
    const extension = ATTACHMENT_MIME_EXTENSIONS[input.mimeType];
    if (!extension) throw new Error(`ATTACHMENT_MIME_UNSUPPORTED: ${input.mimeType}`);
    const relativePath = `attachments/${input.projectId}/${input.attachmentId}${extension}`;
    const absolute = this.absolutePath(relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.data);
    return { relativePath, byteSize: input.data.byteLength };
  }

  /** 读取附件文件；不存在时抛错（路由据此 404）。 */
  read(relativePath: string): Buffer {
    return readFileSync(this.absolutePath(relativePath));
  }

  /** 删除附件文件；不存在不算错误。 */
  delete(relativePath: string): void {
    try {
      const absolute = this.absolutePath(relativePath);
      if (existsSync(absolute)) rmSync(absolute, { force: true });
    } catch {
      // 路径本身非法时也没有可删的东西。
    }
  }

  /** 供测试与诊断：附件根目录。 */
  get root(): string {
    return resolve(this.baseDir, "attachments");
  }
}

/**
 * 按文件头复核 mime：客户端声明的 content-type 只作为"期望值"，真实类型以字节为准。
 * 不一致时拒绝——把一段任意字节存成 .png 再让浏览器按 image/png 渲染，等于给附件接口开了
 * 一个内容嗅探口子。
 */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

/** 扩展名（任意大小写、带不带点）只在诊断时用；落盘扩展名由 mime 决定。 */
export function extensionOf(fileName: string): string {
  return extname(fileName).toLowerCase();
}
