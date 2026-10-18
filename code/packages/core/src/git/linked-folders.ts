/**
 * 模块职责：**依赖文件夹软链** —— 把主仓库里的 `node_modules` / `.next` / `target` 等目录用符号链接
 *   共享给 worktree，省磁盘、免重复安装。纯文件系统操作，不碰 Git 索引。
 *
 * 与参考实现（worktree-manager）的两处刻意差异：
 *   1) **目标已存在就跳过，绝不覆盖**。参考实现会在链接后执行 `git rm --cached -r` 把被跟踪的目录
 *      移出索引；那会改动分支的索引，Factory 不替用户做这件事。被跟踪的依赖目录应该由仓库自己
 *      gitignore，遇到就如实报告"目标已存在"。
 *   2) **失败不抛**。Run 的 worktree 创建不该因为一个依赖目录链不上而失败；调用方按 `failed` 报出即可。
 *
 * 维护提示：
 *   1) 路径必须是**相对仓库根目录**、且不含 `..`：这条校验是软链不会把内容指到仓库外的唯一关口。
 *   2) 用 `lstat` 判断目标是否存在：一个**坏链接**（目标已被删）也算存在，覆盖它可能藏着用户数据。
 *   3) 源与目标是同一个目录（对主仓库自己补链）时直接跳过——否则会创建自指链接。
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

/** 一条依赖文件夹路径的安全校验：相对、非空、不含 `..`、不是 `.`。 */
export function assertLinkableFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) throw new Error("linkedFolders 不能包含空路径");
  if (isAbsolute(trimmed)) throw new Error(`linkedFolders 必须是相对仓库根目录的路径：${trimmed}`);
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`linkedFolders 不能包含 ..：${trimmed}`);
  if (segments.every((segment) => segment === "" || segment === ".")) throw new Error(`linkedFolders 不能是仓库根目录本身：${trimmed}`);
  return trimmed;
}

export type LinkFoldersResult = {
  /** 成功建立的链接（相对路径）。 */
  linked: string[];
  /** 有意跳过的（目标已存在、主仓库没有、源目标同一处…），每条带原因。 */
  skipped: Array<{ path: string; reason: string }>;
  /** 建立失败（权限、跨设备等）。 */
  failed: Array<{ path: string; error: string }>;
};

/**
 * 把 `folders` 从 `sourceRoot`（主仓库）链到 `targetRoot`（worktree）。
 * 任何一条失败都只记在结果里，不抛。
 */
export function linkFolders(input: { sourceRoot: string; targetRoot: string; folders: readonly string[] }): LinkFoldersResult {
  const result: LinkFoldersResult = { linked: [], skipped: [], failed: [] };
  const sourceRoot = resolvePath(input.sourceRoot);
  const targetRoot = resolvePath(input.targetRoot);
  if (sourceRoot === targetRoot) {
    for (const folder of input.folders) result.skipped.push({ path: folder, reason: "目标就是主仓库本身" });
    return result;
  }

  for (const raw of input.folders) {
    let folder: string;
    try {
      folder = assertLinkableFolder(raw);
    } catch (error) {
      result.failed.push({ path: raw, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const source = resolvePath(sourceRoot, folder);
    const target = resolvePath(targetRoot, folder);
    // 防御：解析后仍必须在两个根之内（`assertLinkableFolder` 已挡掉 `..`，这里是第二道）。
    if (!source.startsWith(`${sourceRoot}/`)) {
      result.failed.push({ path: folder, error: "源路径越出了仓库根目录" });
      continue;
    }
    if (!target.startsWith(`${targetRoot}/`)) {
      result.failed.push({ path: folder, error: "目标路径越出了 worktree 根目录" });
      continue;
    }
    if (!existsSync(source)) {
      result.skipped.push({ path: folder, reason: "主仓库里没有这个目录" });
      continue;
    }
    try {
      if (lstatSync(target)) {
        result.skipped.push({ path: folder, reason: "目标已存在（已跟踪或被占用），不覆盖" });
        continue;
      }
    } catch {
      // 不存在：继续建链。
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, lstatSync(source).isDirectory() ? "dir" : "file");
      result.linked.push(folder);
    } catch (error) {
      result.failed.push({ path: folder, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
