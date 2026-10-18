/**
 * 模块职责：进程对外报告的版本号。
 *
 * 为什么读 package.json 而不是写常量：发布产物（`scripts/package.mjs`）会把 package.json 一起
 *   带走，版本号因此只有一个来源；写死常量会在发版时忘记同步，而 `/health` 正是排障时第一眼看的地方。
 *
 * 维护提示：`dist/version.js` 与 `src/version.ts` 的上一级都是 `apps/api`，所以同一个相对路径
 *   在 dev（tsx 直接跑 src）与 prod（tsc 产物）都成立。读不到时返回 "0.0.0" 而不是抛错——
 *   版本号不该让服务起不来。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
