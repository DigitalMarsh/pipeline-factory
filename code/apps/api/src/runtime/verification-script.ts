/**
 * 模块职责：把一份"验证脚本预设"**落到项目上** —— 写 `<repoRoot>/verify.sh`（可执行），
 *   并算出要并进项目设置的那两格。模板本身在 domain 的 `project/verification-script.js`，
 *   这里只有 IO。
 *
 * 三条行为约定：
 *   1) **已存在就不覆盖**（除非显式 `force`）：`verify.sh` 是人维护的文件，覆盖等于删掉他的检查。
 *      抛 `VerificationScriptExistsError`，由路由映射成 409 + code。
 *   2) **不替用户提交**：脚本得先提交才会出现在 Run 的 worktree 里；而且**未提交的它会让
 *      "工作区必须干净"那道闸门挡住新的 Run**（干净检查用 `git status --porcelain -uall`，
 *      未跟踪文件算脏）。所以返回里带 `commitHint`，让界面把这句原话说出来。
 *   3) 权限写成 `0755`：注册的命令是 `bash -c ./verify.sh`，没有可执行位就跑不起来。
 */
import { chmod, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VerificationScriptExistsError,
  applyVerificationScriptPlan,
  planVerificationScript,
  type Project,
  type VerificationScriptPlan,
  type VerificationScriptPreset,
} from "@pipeline-factory/core";

export type InstallVerificationScriptInput = {
  project: Project;
  preset: VerificationScriptPreset;
  subdirectory?: string | undefined;
  force?: boolean | undefined;
};

export type InstalledVerificationScript = {
  scriptPath: string;
  plan: VerificationScriptPlan;
  commands: ReturnType<typeof applyVerificationScriptPlan>["commands"];
  defaultVerificationCommandIds: string[];
  commitHint: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installVerificationScript(input: InstallVerificationScriptInput): Promise<InstalledVerificationScript> {
  const plan = planVerificationScript(input.preset, { subdirectory: input.subdirectory });
  const scriptPath = join(input.project.repoRoot, "verify.sh");
  if ((await exists(scriptPath)) && input.force !== true) throw new VerificationScriptExistsError(scriptPath, input.project.repoRoot);
  await writeFile(scriptPath, plan.script, "utf8");
  await chmod(scriptPath, 0o755);
  const settings = applyVerificationScriptPlan(input.project.settings, plan);
  return {
    scriptPath,
    plan,
    commands: settings.commands,
    defaultVerificationCommandIds: settings.defaultVerificationCommandIds,
    commitHint: "把它提交进仓库，验证才会生效：未提交的 verify.sh 不在 Run 的 worktree 里，而且它会让“工作区必须干净”的闸门挡住新的 Run。",
  };
}
