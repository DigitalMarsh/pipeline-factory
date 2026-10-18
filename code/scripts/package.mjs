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
 *     bin/pipeline-factory # 启动器（--config 缺省指向 config/…）
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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  run("build core", "pnpm", ["--filter", "@pipeline-factory/core", "build"]);
  run("build contracts", "pnpm", ["--filter", "@pipeline-factory/contracts", "build"]);
  run("build api", "pnpm", ["--filter", "@pipeline-factory/api", "build"]);
  run("build web", "pnpm", ["--filter", "@pipeline-factory/web", "build"]);

  // 生产依赖 + api 包本体（dist / package.json / node_modules，含 workspace 的 core 与 contracts）。
  // **deploy 目标必须放在 workspace 之外**：pnpm 的 legacy deploy 会在目标目录跑一次
  // `pnpm install --production`，目标若在仓库内（release/ 下），它会向上找到 pnpm-workspace.yaml
  // 并把**根** node_modules 当成生产安装来裁剪（无 TTY 时直接中止）。先部署到临时目录再拷回来。
  const deployRoot = mkdtempSync(join(tmpdir(), "pipeline-factory-deploy-"));
  try {
    // **hoisted**：默认的 isolated 布局用指向临时目录的绝对符号链接，拷进发布物后会全部失效；
    // hoisted 产出真实目录，发布物可以整个搬走。（pnpm 会因此把根 node_modules 记成 hoisted，
    // 下面的 restore 步骤会切回 isolated。）
    run("deploy api", "pnpm", [
      "--filter",
      "@pipeline-factory/api",
      "deploy",
      "--prod",
      "--legacy",
      "--config.nodeLinker=hoisted",
      join(deployRoot, "app"),
    ]);
    cpSync(join(deployRoot, "app"), join(stage, "app"), { recursive: true });
  } finally {
    rmSync(deployRoot, { recursive: true, force: true });
  }
  // deploy 会以 production/hoisted 语义重装一次 **根** node_modules（pnpm 的行为，即使目标在 workspace 外）。
  // 不恢复的话，打包后第一次 `pnpm build/test` 会要求一次无 TTY 的安装，且开发目录会变成 hoisted。
  run("restore dev dependencies", "pnpm", ["install", "--config.production=false", "--config.nodeLinker=isolated"], {
    env: { ...process.env, CI: "true" },
  });

  cpSync(join(CODE_ROOT, "apps/web/dist"), join(stage, "web"), { recursive: true });
  mkdirSync(join(stage, "config"), { recursive: true });
  mkdirSync(join(stage, "var"), { recursive: true });
  mkdirSync(join(stage, "bin"), { recursive: true });

  const example = JSON.parse(readFileSync(join(CODE_ROOT, "config/pipeline-factory.config.example.json"), "utf8"));
  example.server = { ...example.server, serveWeb: true, webDistPath: "../web" };
  writeFileSync(join(stage, "config/pipeline-factory.config.json"), `${JSON.stringify(example, null, 2)}\n`);

  writeFileSync(join(stage, "bin/pipeline-factory"), launcherSource());
  chmodSync(join(stage, "bin/pipeline-factory"), 0o755);
  writeFileSync(join(stage, "RELEASE.md"), releaseNotes(version));
  run("write tarball", "tar", ["-czf", join(RELEASE_ROOT, `${stageName}.tar.gz`), "-C", RELEASE_ROOT, stageName]);

  console.log(`\n[package] 完成：${stage}`);
  console.log(`[package] 压缩包：${join(RELEASE_ROOT, `${stageName}.tar.gz`)}`);
  console.log("[package] 启动：bin/pipeline-factory --config config/pipeline-factory.config.json");
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
function launcherSource() {
  const paths = [
    'import { spawn } from "node:child_process";',
    'import { dirname, join, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
  ];
  return `#!/usr/bin/env node
// 由 scripts/package.mjs 生成：发布物启动器。不要手改，改生成器。
${paths.join("\n")}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const config = configIndex >= 0
  ? resolve(args[configIndex + 1])
  : join(root, "config", "pipeline-factory.config.json");
const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", join(root, "app", "dist", "main.js"), "--config", config],
  { stdio: "inherit", cwd: root, env: process.env },
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;
}

function releaseNotes(version) {
  return `# Pipeline Factory ${version} 发布物

## 启动

\`\`\`bash
bin/pipeline-factory --config config/pipeline-factory.config.json
\`\`\`

默认监听 \`127.0.0.1:4310\`，同时提供 Web 页面与 \`/api/v4/*\`（配置里 \`server.serveWeb = true\`）。

## 部署前必须改的配置

生成的是示例配置的两个值已改好（\`serveWeb\` / \`webDistPath\`），其余与**部署机器**相关：

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
