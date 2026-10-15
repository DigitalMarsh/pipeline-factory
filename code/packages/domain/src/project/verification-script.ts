/**
 * 模块职责：验证脚本（`verify.sh`）的两套预设 —— Vue/Vite 前端与 Java/Maven 后端 ——
 *   以及它们要注册的命令定义。
 *
 * 为什么是"一个脚本 + 两条命令"而不是"每条检查一条命令"（决策与对照见 CHANGELOG 那一轮）：
 *   脚本把**怎么跑**收进一个文件（每个项目只改它 ✓），命令仍然分档（`hygiene` / `full`），
 *   于是 `verification.suites` 按 tag 挑子集的能力还在。
 *
 * 三条硬约束，改模板前先读：
 *   1) **`argv` 里每个元素都不能含空格**。设置页那一栏是"一行文本 ↔ argv"编辑的，
 *      `./verify.sh`、`--fast` 都不含空格，正好绕开它。（引号切分已在 web 的 `utils/commandArgs.ts`
 *      修好，但模板没必要去试探那条路。）
 *   2) **脚本要能独立跑**：它进仓库、由人维护，工厂只负责 `bash -c ./verify.sh` 与读退出码。
 *      所以每一步都要自己 `echo` —— 工厂那边只看到一条命令的结果，定位靠脚本自己的输出。
 *   3) **不要往仓库里写东西**：worktree 是干净检出，验证跑完紧接着就是自动提交，
 *      脚本留下的任何改动都会被一起提交进去。（`npm ci` 而不是 `npm install`，就是这条。）
 */
import type { RegisteredCommandDefinition } from "../platform/commands.js";
import type { ProjectSettings } from "./project.js";

export type VerificationScriptPreset = "vue-vite" | "maven";

/**
 * 目标脚本已存在，而调用方没有显式要求覆盖。
 *
 * 单独一个错误类型是为了让路由把它映射成 **409 + 一个 code**：`verify.sh` 是人维护的文件，
 * 覆盖它等于删掉他写的检查——"已存在"要说清楚，而不是静默覆盖或 500。
 */
export class VerificationScriptExistsError extends Error {
  constructor(
    readonly scriptPath: string,
    readonly repoRoot: string,
  ) {
    super(`VERIFICATION_SCRIPT_EXISTS: ${scriptPath} 已存在，没有覆盖它`);
    this.name = "VerificationScriptExistsError";
  }
}

export type VerificationScriptOptions = {
  /** 工程所在目录（相对仓库根）。默认 `.`——仓库根就是工程根。 */
  subdirectory?: string | undefined;
};

export type VerificationScriptPlan = {
  preset: VerificationScriptPreset;
  label: string;
  /** 给界面看的一句话：这个预设会怎么验证。 */
  summary: string;
  /** 脚本内容（含 shebang；写入时要 `chmod +x`，因为命令用的是 `./verify.sh`）。 */
  script: string;
  /** 要注册的命令；`defaultVerificationCommandIds` 的顺序即它们的执行顺序。 */
  commands: RegisteredCommandDefinition[];
  defaultVerificationCommandIds: string[];
};

/** 两个预设共用的两条命令：便宜的"卫生检查"在前，全量脚本在后（失败快、也便于按 tag 挑子集）。 */
function verifyCommands(timeoutMs: number): RegisteredCommandDefinition[] {
  return [
    {
      commandId: "project.hygiene",
      category: "verification",
      description: "空白错误与冲突标记检查（秒级，不构建）",
      enabled: true,
      timeoutMs: 60_000,
      argv: ["git", "diff", "--check"],
      environment: {},
      tags: ["hygiene"],
    },
    {
      commandId: "project.verify",
      category: "verification",
      description: "verify.sh：这个项目自己的验证脚本（全量）",
      enabled: true,
      timeoutMs,
      argv: ["bash", "-c", "./verify.sh"],
      environment: {},
      tags: ["full"],
    },
  ];
}

const VUE_SCRIPT = (directory: string) => `#!/usr/bin/env bash
# Pipeline Factory 的验证脚本（Vue + Vite）
#
# 谁跑它：Run 成功收尾之前，工厂在**这个 Run 的 worktree** 里执行 \`bash -c ./verify.sh\`。
#   退出码 0 = 这次 Run 验证通过（进 MERGE_READY）；非 0 = 验证失败。
# 为什么要装依赖：worktree 是干净检出，**没有 node_modules**（这和 Java 不一样——
#   Maven 的依赖缓存在用户级的 ~/.m2，那边不用装）。
# 手动跑：./verify.sh --fast   只构建，跳过类型检查与测试
set -euo pipefail

# 前端工程所在目录（相对仓库根）。改这一行就能换子目录。
DIR="${directory}"
FAST=0
[ "\${1:-}" = "--fast" ] && FAST=1

cd "$DIR"

echo "== 安装依赖（npm ci：按 lockfile 装，不会改 package-lock.json）=="
npm ci --no-audit --no-fund

echo "== 构建 =="
npm run build

if [ "$FAST" = "1" ]; then
  echo "== --fast：跳过类型检查与测试 =="
  exit 0
fi

# package.json 里有这个 script 才跑——不同前后端的脚手架不一样。
has_script() { node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null; }
if has_script typecheck; then
  echo "== 类型检查 =="
  npm run typecheck
fi
if has_script test; then
  echo "== 测试 =="
  npm run test
fi

echo "== 验证通过 =="
`;

const MAVEN_SCRIPT = (directory: string) => `#!/usr/bin/env bash
# Pipeline Factory 的验证脚本（Java + Maven）
#
# 谁跑它：Run 成功收尾之前，工厂在**这个 Run 的 worktree** 里执行 \`bash -c ./verify.sh\`。
#   退出码 0 = 这次 Run 验证通过（进 MERGE_READY）；非 0 = 验证失败。
# 依赖不用装：Maven 的本地仓库在用户级的 ~/.m2，worktree 直接用（这和前端不一样）。
# 手动跑：./verify.sh --fast   只编译，跳过测试
set -euo pipefail

# 工程所在目录（含 pom.xml，相对仓库根）。多模块工程指到根那个 pom 的目录就行。
DIR="${directory}"
FAST=0
[ "\${1:-}" = "--fast" ] && FAST=1

cd "$DIR"

# 有 wrapper 就用它：Maven 版本随仓库走，不受这台机器装了什么影响。
MVN="./mvnw"
[ -x "$MVN" ] || MVN="mvn"

if [ "$FAST" = "1" ]; then
  echo "== 编译（--fast，跳过测试）=="
  "$MVN" -B -q -DskipTests compile
else
  echo "== 编译 + 测试 =="
  "$MVN" -B -q test
fi

echo "== 验证通过 =="
`;

/** 预设清单（界面上的下拉框用它）；`label`/`summary` 是给人看的两句话。 */
export const VERIFICATION_SCRIPT_PRESETS: ReadonlyArray<{
  preset: VerificationScriptPreset;
  label: string;
  summary: string;
}> = [
  {
    preset: "vue-vite",
    label: "Vue + Vite 前端",
    summary: "npm ci → vite build（有 typecheck / test 就一起跑）；依赖必须在 worktree 里现装",
  },
  { preset: "maven", label: "Java + Maven 后端", summary: "mvn test（有 ./mvnw 就用 wrapper）；依赖走用户级 ~/.m2，不用装" },
];

/**
 * 渲染一个预设：脚本内容 + 要注册的命令 + 默认验证集。
 *
 * 纯函数、不碰文件系统——写盘在 `apps/api` 那一侧（`runtime/verification-script.ts`），
 * 这样模板与"注册什么"这两件事可以被单测直接钉住。
 */
export function planVerificationScript(preset: VerificationScriptPreset, options: VerificationScriptOptions = {}): VerificationScriptPlan {
  const directory = options.subdirectory?.trim() || ".";
  const presetMeta = VERIFICATION_SCRIPT_PRESETS.find((item) => item.preset === preset);
  if (!presetMeta) throw new Error(`Unknown verification script preset: ${preset}`);
  const script = preset === "vue-vite" ? VUE_SCRIPT(directory) : MAVEN_SCRIPT(directory);
  const commands = verifyCommands(preset === "vue-vite" ? 600_000 : 900_000);
  return {
    preset,
    label: presetMeta.label,
    summary: presetMeta.summary,
    script,
    commands,
    defaultVerificationCommandIds: commands.map((command) => command.commandId),
  };
}

/**
 * 把一份预设并进项目设置，返回**只有这两格的**新值（其余设置原样不动）。
 *
 * 两条约定：**命令按 id 就地替换**（重复点同一个按钮不该在列表里堆出两条同名命令），
 * **默认验证集按预设顺序前置**（便宜的卫生检查永远先跑、也永远先失败）。
 */
export function applyVerificationScriptPlan(
  settings: ProjectSettings,
  plan: VerificationScriptPlan,
): { commands: RegisteredCommandDefinition[]; defaultVerificationCommandIds: string[] } {
  const incoming = new Map(plan.commands.map((command) => [command.commandId, command]));
  const commands = settings.commands.map((command) => incoming.get(command.commandId) ?? command);
  for (const command of plan.commands) {
    if (!commands.some((item) => item.commandId === command.commandId)) commands.push(command);
  }
  const ordered = plan.defaultVerificationCommandIds;
  const rest = settings.defaultVerificationCommandIds.filter((commandId) => !ordered.includes(commandId));
  return { commands, defaultVerificationCommandIds: [...ordered, ...rest] };
}
