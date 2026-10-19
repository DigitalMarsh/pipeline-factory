#!/usr/bin/env node
/**
 * Pipeline Factory 的命令行入口（发布物里的 `pipeline`）。
 *
 *   pipeline start|stop|restart|status|logs|update|version|config|help
 *
 * 设计目标：把"前台运行 + 记不住 --config 路径 + 自己找 PID"变成几条固定命令。
 *   - 安装根目录由脚本位置推导（`<root>/bin/pipeline` → `<root>`），也可以 PIPELINE_ROOT 指定；
 *   - 配置默认是 `<root>/config/pipeline-factory.config.json`，可用 --config / PIPELINE_CONFIG 覆盖；
 *   - PID 与日志固定放在 `<root>/var/`，与数据库、worktree、附件同处一地，备份/迁移只需搬 var。
 *
 * 维护提示：
 *   1) **stop 必须核对 PID 的命令行**：PID 会被系统回收，陈旧 pid 文件直接 kill 可能杀掉无关进程。
 *   2) **update 保留 config/ 与 var/**：升级只替换 app/web/bin/文档；数据库、附件、worktree 路径不变。
 *   3) 更新失败要能回滚：替换前把 app/web/bin 移到临时备份目录，任一步失败就搬回并尝试重启。
 *   4) 平台与构建机绑定：发布物不跨平台，update 只应在同一平台/架构上使用。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.PIPELINE_ROOT ?? resolve(HERE, ".."));
const APP_ENTRY = existsSync(join(ROOT, "app", "dist", "main.js"))
  ? join(ROOT, "app", "dist", "main.js")
  : join(ROOT, "apps", "api", "dist", "main.js");
const DEFAULT_CONFIG = join(ROOT, "config", "pipeline-factory.config.json");
const PID_FILE = join(ROOT, "var", "pipeline.pid");
const LOG_FILE = join(ROOT, "var", "pipeline.log");
const DEFAULT_UPDATE_REPO = process.env.PIPELINE_UPDATE_REPO ?? "DigitalMarsh/pipeline-factory";
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "start":
      await start(rest);
      return;
    case "stop":
      stop(rest);
      return;
    case "restart":
      stop(rest);
      await start(rest);
      return;
    case "status":
      await status(rest);
      return;
    case "logs":
      await logs(rest);
      return;
    case "update":
      await update(rest);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(version());
      return;
    case "config":
      console.log(configPath(rest));
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`未知命令：${command}\n\n${helpText()}`);
  }
}

async function start(args) {
  if (!existsSync(APP_ENTRY)) throw new Error(`找不到应用入口：${APP_ENTRY}（发布物不完整？）`);
  const config = configPath(args);
  if (!existsSync(config))
    throw new Error(`找不到配置文件：${config}\n先复制示例配置并修改：${join(ROOT, "config", "pipeline-factory.config.example.json")}`);
  // 健康检查要读**配置对象**（端口/host）；把路径字符串传进去会回落默认 4310，误把别的服务当成自己。
  let configData;
  try {
    configData = JSON.parse(readFileSync(config, "utf8"));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${config}（${error instanceof Error ? error.message : String(error)}）`, {
      cause: error,
    });
  }
  // 发布配置的 project.root 默认是 "../../"（相对 config/）——不编辑就启动会把用户主目录当成受管仓库。
  const projectRoot = resolve(dirname(config), configData.project?.root ?? "");
  if (projectRoot === homedir()) {
    console.warn(`警告：project.root 仍指向用户主目录（${projectRoot}）。请编辑 ${config} 指向真实代码仓库。`);
  }
  const running = readPid();
  if (running && isAlive(running)) {
    // pid 文件可能是陈旧的：PID 被系统回收后指向了无关进程。只有命令行走查属于本安装目录才认。
    if (ownsProcess(running)) {
      console.log(`Pipeline Factory 已在运行（PID ${running}）。`);
      return;
    }
    rmSync(PID_FILE, { force: true });
  }
  ensureVar();
  const out = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", APP_ENTRY, "--config", config], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  closeSync(out);
  child.unref();
  // spawn 失败（例如权限/解释器问题）会以 error 事件异步到达；没有监听器会变成未捕获异常。
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
    rmSync(PID_FILE, { force: true });
  });
  writeFileSync(PID_FILE, String(child.pid));
  const healthy = await waitForHealth(configData);
  if (spawnError) throw spawnError;
  if (!healthy) {
    console.error(`启动后 ${HEALTH_TIMEOUT_MS / 1000}s 内健康检查未通过。最近日志：`);
    printTail(30);
    console.error(`进程仍以 PID ${child.pid} 运行；需要时执行 pipeline stop。`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pipeline Factory 已启动（PID ${child.pid}）：${healthUrl(configData)}`);
}

function stop(_args) {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    console.log("Pipeline Factory 未在运行。");
    return;
  }
  if (!ownsProcess(pid)) {
    rmSync(PID_FILE, { force: true });
    throw new Error(`PID ${pid} 不属于本安装目录（${ROOT}）；已删除过期 pid 文件，未发送信号。`);
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isAlive(pid)) sleep(200);
  if (isAlive(pid)) {
    console.warn(`PID ${pid} 未在 ${STOP_TIMEOUT_MS / 1000}s 内退出，发送 SIGKILL。`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }
  rmSync(PID_FILE, { force: true });
  console.log("Pipeline Factory 已停止。");
}

async function status(args) {
  const pid = runningPid();
  const owned = pid !== null && ownsProcess(pid);
  const path = configPath(args);
  const exists = existsSync(path);
  const config = exists ? safeConfig(path) : null;
  console.log(`目录：${ROOT}`);
  console.log(`版本：${version()}`);
  console.log(`PID ：${owned ? pid : pid ? `${pid}（陈旧 pid 文件，不属于本安装）` : "未运行"}`);
  if (!exists) {
    console.log(`配置：${path}（不存在）`);
    return;
  }
  if (!config) {
    console.log(`配置：${path}（不是合法 JSON）`);
    return;
  }
  console.log(`配置：${path}`);
  const url = healthUrl(config);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    console.log(`健康：${response.status} ${JSON.stringify(body)}`);
  } catch (error) {
    console.log(`健康：不可达（${error instanceof Error ? error.message : String(error)}）`);
  }
}

async function logs(args) {
  ensureVar();
  if (!existsSync(LOG_FILE)) {
    console.log("还没有日志。");
    return;
  }
  const follow = args.includes("--follow") || args.includes("-f");
  printTail(200);
  if (!follow) return;
  let offset;
  try {
    offset = statSync(LOG_FILE).size;
  } catch {
    return;
  }
  for (;;) {
    await sleep(500);
    let size;
    try {
      size = statSync(LOG_FILE).size;
    } catch {
      return;
    }
    if (size <= offset) continue;
    const content = readFileSync(LOG_FILE).subarray(offset);
    process.stdout.write(content);
    offset = size;
  }
}

async function update(args) {
  const explicitSource = flag(args, "--file") ?? flag(args, "--from") ?? process.env.PIPELINE_UPDATE_URL ?? null;
  const noStart = args.includes("--no-start");
  const temp = mkdtempSync(join(tmpdir(), "pipeline-update-"));
  try {
    const archive = explicitSource ? await resolveUpdateSource(explicitSource, temp) : await resolveLatestRelease(temp);
    const newRoot = await extractRelease(archive, temp);
    const nextVersion = readVersion(newRoot);
    console.log(`准备更新：${version()} → ${nextVersion}`);
    stop([]);
    const backup = join(temp, "backup");
    mkdirSync(backup, { recursive: true });
    for (const entry of ["app", "web", "bin"]) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(backup, entry), { recursive: true });
    }
    try {
      for (const entry of ["app", "web", "bin"]) {
        rmSync(join(ROOT, entry), { recursive: true, force: true });
        cpSync(join(newRoot, entry), join(ROOT, entry), { recursive: true });
      }
      for (const entry of ["INSTALL.md", "RELEASE.md", "install.sh"]) {
        if (existsSync(join(newRoot, entry))) copyFileSync(join(newRoot, entry), join(ROOT, entry));
      }
      chmodSync(join(ROOT, "bin", "pipeline"), 0o755);
    } catch (error) {
      console.error(`更新失败，正在回滚：${error instanceof Error ? error.message : String(error)}`);
      for (const entry of ["app", "web", "bin"]) {
        rmSync(join(ROOT, entry), { recursive: true, force: true });
        if (existsSync(join(backup, entry))) cpSync(join(backup, entry), join(ROOT, entry), { recursive: true });
      }
      throw error;
    }
    console.log(`已更新到 ${nextVersion}。config/ 与 var/ 保持不动。`);
    if (!noStart) await start([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ─────────────────────────── 辅助 ───────────────────────────

function helpText() {
  return `用法：pipeline <命令>

  start     启动（后台，PID/日志在 var/）
  stop      停止
  restart   重启
  status    查看版本、PID 与健康检查
  logs      查看日志；-f/--follow 持续跟随
  update    升级：默认从 GitHub Releases 下载，或 --file <tar.gz|目录>
  version   打印版本
  config    打印当前配置文件路径

选项：--config <path>（或 PIPELINE_CONFIG）、--no-start（update 后不自动启动）`;
}

function printHelp() {
  console.log(helpText());
}

function ensureVar() {
  mkdirSync(join(ROOT, "var"), { recursive: true });
}

function configPath(args) {
  return resolve(flag(args, "--config") ?? process.env.PIPELINE_CONFIG ?? DEFAULT_CONFIG);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safeConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function healthUrl(config) {
  const host = config?.server?.host;
  const port = config?.server?.port ?? 4310;
  const probeHost = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${port}/health`;
}

async function waitForHealth(config) {
  const url = healthUrl(config);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function runningPid() {
  const pid = readPid();
  return pid && isAlive(pid) ? pid : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 只认命令行里包含本安装根目录/应用入口的进程，避免杀掉被回收的 PID。 */
function ownsProcess(pid) {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return command.includes(ROOT) || command.includes(APP_ENTRY);
  } catch {
    return false;
  }
}

function printTail(lines) {
  try {
    const content = readFileSync(LOG_FILE, "utf8").trimEnd().split("\n");
    console.log(content.slice(-lines).join("\n"));
  } catch {
    /* 没日志 */
  }
}

function version() {
  for (const path of [join(ROOT, "app", "package.json"), join(ROOT, "apps", "api", "package.json")]) {
    try {
      return JSON.parse(readFileSync(path, "utf8")).version ?? "0.0.0";
    } catch {
      /* 尝试下一处 */
    }
  }
  return "0.0.0";
}

async function resolveUpdateSource(source, temp) {
  if (existsSync(source)) {
    const stat = statSync(source);
    if (stat.isDirectory()) return source;
    return source;
  }
  if (!/^https?:\/\//i.test(source)) throw new Error(`更新来源不存在：${source}`);
  console.log(`下载 ${source}`);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const archive = join(temp, basename(new URL(source).pathname) || "pipeline-factory.tar.gz");
  writeFileSync(archive, bytes);
  return archive;
}

/**
 * 默认更新源：GitHub Releases 的**最新 release**。不能写死 `latest/download/pipeline-factory.tar.gz`：
 * 本项目发布物带版本号（`pipeline-factory-0.1.0.tar.gz`），写死文件名会 404。
 * 需要私有仓库时设置 GITHUB_TOKEN（只用于读取 release 元数据/资产）。
 */
async function resolveLatestRelease(temp) {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${DEFAULT_UPDATE_REPO}/releases/latest`, { headers });
  if (!response.ok) {
    throw new Error(
      `无法读取最新发布（HTTP ${response.status}）。可以用 --file <tar.gz> 或 --from <url> 指定发布物，` +
        `或设置 PIPELINE_UPDATE_URL 指向固定的发布物地址。`,
    );
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset =
    assets.find((candidate) => /^pipeline-factory-.*\.tar\.gz$/.test(candidate.name)) ??
    assets.find((candidate) => typeof candidate.name === "string" && candidate.name.endsWith(".tar.gz"));
  if (!asset?.browser_download_url) throw new Error("最新发布里没有 pipeline-factory-*.tar.gz 资产。");
  console.log(`最新发布：${release.tag_name ?? "?"} / ${asset.name}`);
  return resolveUpdateSource(asset.browser_download_url, temp);
}

async function extractRelease(source, temp) {
  if (statSync(source).isDirectory()) return source;
  const extracted = join(temp, "extracted");
  mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xzf", source, "-C", extracted]);
  const entries = execFileSync("ls", ["-1", extracted], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const root = entries.length === 1 && existsSync(join(extracted, entries[0], "app")) ? join(extracted, entries[0]) : extracted;
  if (!existsSync(join(root, "app", "dist", "main.js"))) throw new Error("更新包结构不正确：缺少 app/dist/main.js");
  return root;
}

function readVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "app", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
