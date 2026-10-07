#!/usr/bin/env node
/**
 * 模块职责：把本仓库的 git 钩子指到 `code/scripts/git-hooks/`。
 *
 * 为什么不是 husky：本仓的 **git 根在上一级**（`pipeline-factory/`），而工作区与 package.json 在
 * `code/`。husky 要求 `.git` 就在它运行的那个目录里——`pnpm exec husky` 会直接报
 * ".git can't be found"，连 `--help` 都到不了。在不动仓库结构的前提下它用不了，所以这里只做 husky
 * 真正必要的那一件事：设 `core.hooksPath`。
 *
 * 维护提示：
 *   1) 在 `prepare` 里调用，所以 `pnpm install` 之后**新克隆的仓库自动就有钩子**——不必让每个人
 *      记得手敲一遍 git config。
 *   2) 幂等：已经是这个值就什么都不做，也不打印噪声。
 *   3) 不在 git 仓库里（例如从 tarball 解出来的目录）时**静默跳过**，不让安装失败：那种场景下没有
 *      钩子可言，而"装不上依赖"是更糟的失败。
 *   4) `core.hooksPath` 的相对路径是**相对工作区根**的（钩子就是在那儿被执行的），所以这里算的是
 *      从 git 根到钩子目录的相对路径，而不是写死一个 `code/...`。
 */
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args) {
  return execFileSync("git", args, { cwd: CODE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** 读一个**可能不存在**的配置：`git config --get` 在键不存在时以 1 退出，那是"没有"，不是失败。 */
function readConfig(key) {
  try {
    return git(["config", "--local", "--get", key]);
  } catch {
    return "";
  }
}

let gitRoot;
try {
  gitRoot = git(["rev-parse", "--show-toplevel"]);
} catch {
  console.log("[git-hooks] 不在 git 仓库里，跳过（没有钩子可装）。");
  process.exit(0);
}

const hooksPath = relative(gitRoot, join(CODE_ROOT, "scripts", "git-hooks"));
if (readConfig("core.hooksPath") === hooksPath) process.exit(0);

execFileSync("git", ["config", "--local", "core.hooksPath", hooksPath], { cwd: gitRoot, stdio: "inherit" });
console.log(`[git-hooks] core.hooksPath → ${hooksPath}（提交前会自动排版并修可自动修的 lint 问题）`);
