#!/usr/bin/env node
/**
 * 模块职责：把 monorepo 打成**可分发的单进程产物** —— 一个目录（和同名 tar.gz），
 *   里面是 API 的运行时代码与依赖、Web 静态产物、示例配置与启动脚本。
 *
 * 为什么不用 `pnpm build` 就算了：构建产物只解决了"编译"，没有解决"发布物是什么形状"。
 *   这个仓库是本地优先的单进程应用（API 托管 Web），发布物必须能回答：
 *   依赖在哪、配置从哪读、版本号怎么查、数据库与附件放在哪。
 *
 * 产物布局：
 *   release/pipeline-factory-<version>/
 *     app/                 # pnpm deploy --prod 的结果：dist + 生产依赖（含 core/contracts）
 *     web/                 # apps/web/dist
 *     config/pipeline-factory.config.json   # 由 example 生成，serveWeb/webDistPath 已改好
 *     var/                 # 数据库、worktree、附件（运行时生成）
 *     bin/pipeline         # 命令行（start / stop / status / logs / update）
 *     install.sh           # 安装脚本
 *     RELEASE.md           # 部署前必须改的几项
 *
 * 维护提示：
 *   1) 先 build 再 deploy：`pnpm deploy` 复制的是**已构建**的 workspace 包；漏掉 build 会打出
 *      一个只有 src 的包。
 *   2) `--legacy` 是 pnpm 10+ 在未启用 `inject-workspace-packages` 时部署 workspace 的官方退路；
 *      去掉它会在 deploy 阶段直接报错。
 *   3) 生成配置时只改 `serveWeb` 与 `webDistPath` 两项。`project.root`、`codexAppServer.cwd`、
 *      `storage.*` 是与部署机器相关的路径，**不替用户猜**——写进 RELEASE.md 让他自己改。
 */
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(HERE, "..");
const RELEASE_ROOT = join(CODE_ROOT, "release");

main();

function main() {
  const version = JSON.parse(readFileSync(join(CODE_ROOT, "apps/api/package.json"), "utf8")).version ?? "0.0.0";
  const stageName = `pipeline-factory-${version}`;
  const stage = join(RELEASE_ROOT, stageName);

  console.log(`[package] version ${version}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  run("build contracts", "pnpm", ["--filter", "@pipeline-factory/contracts", "build"]);
  run("build core", "pnpm", ["--filter", "@pipeline-factory/core", "build"]);
  run("build api", "pnpm", ["--filter", "@pipeline-factory/api", "build"]);
  run("build web", "pnpm", ["--filter", "@pipeline-factory/web", "build"]);

  // 生产依赖 + api 包本体（dist / package.json / node_modules，含 workspace 的 core 与 contracts）。
  //
  // **在临时 workspace 副本里部署**，不碰当前仓库的 node_modules：
  //   pnpm 的 legacy deploy 会以 production/hoisted 语义重装一次 workspace（即使目标在仓库外），
  //   直接在主工作区跑会把开发依赖裁掉，需要事后重装恢复；中途失败还会留下半成品环境。
  //   副本只拷贝 manifests 与源码/构建产物（排除 node_modules），install --prod 后部署。
  const workspaceRoot = mkdtempSync(join(tmpdir(), "pipeline-factory-workspace-"));
  const deployRoot = mkdtempSync(join(tmpdir(), "pipeline-factory-deploy-"));
  try {
    for (const relative of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "apps/api",
      "apps/web",
      "packages/core",
      "packages/contracts",
      "scripts",
    ]) {
      cpSync(join(CODE_ROOT, relative), join(workspaceRoot, relative), {
        recursive: true,
        filter: (source) => !source.includes(`${sep}node_modules`),
      });
    }
    run("install package workspace", "pnpm", ["install", "--frozen-lockfile", "--prod", "--ignore-scripts"], {
      cwd: workspaceRoot,
    });
    // **hoisted**：默认 isolated 布局用指向临时目录的绝对符号链接，拷进发布物后会全部失效。
    run(
      "deploy api",
      "pnpm",
      ["--filter", "@pipeline-factory/api", "deploy", "--prod", "--legacy", "--config.nodeLinker=hoisted", join(deployRoot, "app")],
      { cwd: workspaceRoot },
    );
    cpSync(join(deployRoot, "app"), join(stage, "app"), { recursive: true });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(deployRoot, { recursive: true, force: true });
  }
  // 安装包**不携带 Claude Agent SDK**（体积主要来自平台二进制，且目标机器已有 Claude Code）。
  // 即便 lockfile 关系变化让某个 devDependency 漏进来，这里也把它清掉。
  rmSync(join(stage, "app", "node_modules", "@anthropic-ai"), { recursive: true, force: true });
  console.log("[package] Claude AGENT SDK 未打入安装包（运行时由目标机器提供）");

  cpSync(join(CODE_ROOT, "apps/web/dist"), join(stage, "web"), { recursive: true });
  mkdirSync(join(stage, "config"), { recursive: true });
  mkdirSync(join(stage, "var"), { recursive: true });
  mkdirSync(join(stage, "bin"), { recursive: true });

  const example = JSON.parse(readFileSync(join(CODE_ROOT, "config/pipeline-factory.config.example.json"), "utf8"));
  example.server = { ...example.server, serveWeb: true, webDistPath: "../web" };
  // 发布配置默认开启事件回收：example 里的 0（不回收）只适合"我想保留全部历史"的显式选择。
  example.storage = { ...example.storage, eventRetentionDays: 14 };
  writeFileSync(join(stage, "config/pipeline-factory.config.json"), `${JSON.stringify(example, null, 2)}\n`);

  copyFileSync(join(CODE_ROOT, "scripts", "pipeline.mjs"), join(stage, "bin", "pipeline"));
  chmodSync(join(stage, "bin", "pipeline"), 0o755);
  copyFileSync(join(CODE_ROOT, "..", "install.sh"), join(stage, "install.sh"));
  chmodSync(join(stage, "install.sh"), 0o755);
  writeFileSync(join(stage, "RELEASE.md"), releaseNotes(version));
  cpSync(join(CODE_ROOT, "..", "docs", "INSTALL.md"), join(stage, "INSTALL.md"));
  run("write tarball", "tar", ["-czf", join(RELEASE_ROOT, `${stageName}.tar.gz`), "-C", RELEASE_ROOT, stageName]);

  console.log(`\n[package] 完成：${stage}`);
  console.log(`[package] 压缩包：${join(RELEASE_ROOT, `${stageName}.tar.gz`)}`);
  console.log("[package] 安装：./install.sh，然后用 pipeline start");
}

function run(label, command, args, options = {}) {
  console.log(`[package] ${label}`);
  const result = spawnSync(command, args, { cwd: CODE_ROOT, stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`[package] ${label} 失败（exit ${result.status ?? "signal"}）`);
    process.exit(1);
  }
}

/**
 * 启动器：把 `--config` 的缺省值钉在发布物自己的 config 目录，并把 cwd 放到发布根目录——
 * 这样 `storage.*` / `project.root` 这些相对路径的解析与"用户在哪执行命令"无关。
 */
function releaseNotes(version) {
  return `# Pipeline Factory ${version} 发布物

完整的安装、升级与安全说明见仓库的 \`docs/INSTALL.md\`（发布物里也带一份 \`INSTALL.md\`）。

## 前置条件

- **Node.js ≥ 22.5**（SQLite 使用 \`node:sqlite\`）。
- 使用 Codex 后端：目标机器已安装并登录 \`codex\` CLI。
- 使用 Claude 后端：目标机器已安装 Claude Code，并让 Node 能解析
  \`@anthropic-ai/claude-agent-sdk\`（或用 \`model.claudeAgent.sdkPath\` 指向其入口）。
  **本安装包不包含 Claude Agent SDK**。

## 安装

\`\`\`bash
./install.sh
pipeline start
\`\`\`

安装脚本默认装到 \`~/.pipeline-factory\`，并把 \`pipeline\` 链接到 \`~/.local/bin\`。

## 启动与运维

\`\`\`bash
pipeline start|stop|restart|status
pipeline logs [-f]
pipeline update                 # 从 GitHub Releases 下载最新发布物
pipeline update --file x.tar.gz # 或从本地发布物升级
\`\`\`

默认监听 \`127.0.0.1:4310\`，同时提供 Web 页面与 \`/api/v4/*\`（配置里 \`server.serveWeb = true\`）。

## 部署前必须改的配置

生成的是示例配置，\`serveWeb\` / \`webDistPath\` / \`eventRetentionDays\` 已改好，其余与**部署机器**相关：

- \`project.root\`：Factory 管理的代码仓库根目录；相对的是 \`config/\` 目录。
- \`model.codexAppServer.cwd\`：Codex 子进程的 cwd，通常与 \`project.root\` 相同。
- \`storage.databasePath\` / \`storage.worktreeRoot\`：默认落在发布物的 \`var/\`。
- \`model.*\`：按实际使用的 agent 与模型改；Claude 侧凭据由 \`~/.claude/settings.json\` 或
  \`claudeAgent.authToken\` 提供。

## 版本与健康检查

\`\`\`bash
curl http://127.0.0.1:4310/health
\`\`\`

返回 \`appVersion\`（本发布物版本）、\`schemaVersion\`（SQLite 结构版本）与生效的模型后端。
`;
}
