#!/usr/bin/env node
/**
 * 模块职责：构建**可发布到 npm 的单包** `pipeline-factory`。
 *
 *   npm install -g pipeline-factory
 *   pipeline start
 *
 * 为什么单独做 npm 包而不是发布 monorepo 的四个包：
 *   - 用户只需要一个全局命令，不想理解 core/contracts/api/web 的分层；
 *   - 内部的 core/contracts 被 esbuild **打进 dist/main.js**，不发布为独立 npm 包；
 *   - 第三方运行时依赖（fastify / zod）留在 package.json，由 npm 正常安装；
 *   - Claude Agent SDK 是 optional peer（不随 npm install 拉取），由目标机器提供。
 *
 * 产物布局（npm-package/）：
 *   dist/main.js        # API（含 core/contracts），esbuild 单文件
 *   web/                # 前端静态产物
 *   bin/pipeline.mjs    # CLI（start/stop/status/logs/update）
 *   config/             # 配置示例（首次启动时复制到 ~/.pipeline-factory/config）
 *   package.json / README.md / INSTALL.md
 *
 * 维护提示：
 *   1) `--alias:@pipeline-factory/<pkg>=./packages/<pkg>/src/index.ts` 必须在 `--packages=external` 之前生效，
 *      否则 workspace 包会被当成外部依赖留下来（npm 上并不存在这些包）。
 *   2) **不要**把 @anthropic-ai/claude-agent-sdk 写进 dependencies：安装包约定不携带 SDK。
 *   3) 用户数据目录是 ~/.pipeline-factory（PIPELINE_HOME 可改），与 npm 包目录分离，
 *      这样 npm 升级/切换 Node 版本都不会动数据库与配置。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(HERE, "..");
const STAGE = join(CODE_ROOT, "npm-package");
const RELEASE_DIR = join(CODE_ROOT, "release");

const api = JSON.parse(readFileSync(join(CODE_ROOT, "apps/api/package.json"), "utf8"));
const core = JSON.parse(readFileSync(join(CODE_ROOT, "packages/core/package.json"), "utf8"));
const version = api.version ?? "0.0.0";

main();

function main() {
  console.log(`[npm] 构建 pipeline-factory@${version}`);
  run("build contracts", "pnpm", ["--filter", "@pipeline-factory/contracts", "build"]);
  run("build core", "pnpm", ["--filter", "@pipeline-factory/core", "build"]);
  run("build web", "pnpm", ["--filter", "@pipeline-factory/web", "build"]);

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, "dist"), { recursive: true });
  mkdirSync(join(STAGE, "bin"), { recursive: true });
  mkdirSync(join(STAGE, "config"), { recursive: true });

  // 单文件 API：core/contracts 源码内联；fastify/zod/node:sqlite 保持外部。
  run("bundle api", "pnpm", [
    "exec",
    "esbuild",
    "apps/api/src/main.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    `--outfile=${join(STAGE, "dist", "main.js")}`,
    "--packages=external",
    "--alias:@pipeline-factory/core=./packages/core/src/index.ts",
    "--alias:@pipeline-factory/contracts=./packages/contracts/src/index.ts",
    "--log-level=warning",
  ]);

  cpSync(join(CODE_ROOT, "apps/web/dist"), join(STAGE, "web"), { recursive: true });
  copyFileSync(join(CODE_ROOT, "scripts", "pipeline.mjs"), join(STAGE, "bin", "pipeline.mjs"));
  chmodSync(join(STAGE, "bin", "pipeline.mjs"), 0o755);
  copyFileSync(join(CODE_ROOT, "config/pipeline-factory.config.example.json"), join(STAGE, "config/pipeline-factory.config.example.json"));
  copyFileSync(join(CODE_ROOT, "..", "docs", "INSTALL.md"), join(STAGE, "INSTALL.md"));
  writeFileSync(join(STAGE, "README.md"), packageReadme(version));

  writeFileSync(
    join(STAGE, "package.json"),
    `${JSON.stringify(
      {
        name: "pipeline-factory",
        version,
        description: "Local-first requirement → plan → run → verify → merge pipeline for coding agents",
        type: "module",
        bin: { pipeline: "bin/pipeline.mjs" },
        files: ["dist", "web", "bin", "config", "README.md", "INSTALL.md"],
        engines: { node: ">=22.5.0" },
        repository: { type: "git", url: "git+https://github.com/DigitalMarsh/pipeline-factory.git" },
        homepage: "https://github.com/DigitalMarsh/pipeline-factory",
        bugs: { url: "https://github.com/DigitalMarsh/pipeline-factory/issues" },
        license: "UNLICENSED",
        keywords: ["pipeline", "coding-agent", "codex", "claude", "worktree"],
        dependencies: {
          "@fastify/cors": api.dependencies["@fastify/cors"],
          "@fastify/static": api.dependencies["@fastify/static"],
          fastify: api.dependencies.fastify,
          zod: api.dependencies.zod,
        },
        peerDependencies: { "@anthropic-ai/claude-agent-sdk": core.devDependencies["@anthropic-ai/claude-agent-sdk"] },
        peerDependenciesMeta: { "@anthropic-ai/claude-agent-sdk": { optional: true } },
      },
      null,
      2,
    )}\n`,
  );

  mkdirSync(RELEASE_DIR, { recursive: true });
  run("npm pack", "npm", ["pack", "--pack-destination", RELEASE_DIR], { cwd: STAGE });
  console.log(`\n[npm] 完成：${STAGE}`);
  console.log(`[npm] 本地安装测试：npm install -g ${join(RELEASE_DIR, `pipeline-factory-${version}.tgz`)}`);
  console.log("[npm] 发布：npm publish  （在 npm-package/ 内，需要先 npm login）");
}

function run(label, command, args, options = {}) {
  console.log(`[npm] ${label}`);
  try {
    execFileSync(command, args, { cwd: CODE_ROOT, stdio: "inherit", ...options });
  } catch (error) {
    console.error(`[npm] ${label} 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function packageReadme(version) {
  return `# pipeline-factory ${version}

Local-first pipeline: Explorer conversation → Plan contract → Run in a Git worktree → verify → merge.

## Install

\`\`\`bash
npm install -g pipeline-factory
pipeline start
\`\`\`

Requires **Node.js ≥ 22.5** and Git. Data (SQLite, attachments, worktrees) lives in
\`~/.pipeline-factory\`; configuration is created on first start at
\`~/.pipeline-factory/config/pipeline-factory.config.json\`.

\`\`\`bash
pipeline status
pipeline logs -f
pipeline stop
pipeline update     # npm install -g pipeline-factory@latest
\`\`\`

## Model backends

- Codex: install and log in to the \`codex\` CLI.
- Claude: install Claude Code **and** make \`@anthropic-ai/claude-agent-sdk\` resolvable
  (global install, or set \`model.claudeAgent.sdkPath\` to its entry file). The npm package
  does **not** bundle the SDK.

Full guide: see \`INSTALL.md\` in this package.
`;
}
