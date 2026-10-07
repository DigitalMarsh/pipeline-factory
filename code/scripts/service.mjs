#!/usr/bin/env node
/**
 * 模块职责：用一条命令管理本项目的运行时进程，替代原先散落在 git root 的 5 个 bash 脚本
 *   （startApi / startWeb / stopApi / stopWeb / status）。
 *
 * 为什么要搬进 code/scripts：那 5 个脚本编排的正是 code/ 里的服务，却放在 code/ 之外，
 *   导致 code/ 无法自洽描述"这个项目怎么跑起来"。搬进来之后 code/ 是自闭环的。
 *
 * 两种模式（对应 P1 的单进程托管）：
 *   - dev ：API(dev, tsx + node --watch) + Web(vite dev server)，两个进程、两个 PID、互不影响。
 *           前端同源由 vite proxy 提供。这是原 bash 脚本的语义。
 *           API 带热重载，监听范围是"已加载的源码模块"：改 apps/api/src 或 packages/domain/src
 *           都会自动重启。domain 能直接跑源码，是因为 dev 脚本开了 --conditions=pipeline-dev，
 *           命中 packages/domain/package.json 的 exports 条件 → src/index.ts；prod 不传这个条件，
 *           仍走 dist。**因此 domain 的改动在 dev 下不需要重新构建，也不存在 dist 陈旧的问题。**
 *   - prod：只有 API 一个进程。它按 config 的 server.serveWeb 直接把 apps/web/dist
 *           托管在同一端口上，前端同源由 @fastify/static 提供（见 apps/api/src/web-hosting.ts）。
 *
 * PID 与日志沿用 git root 的 .runtime/（已被 .gitignore 忽略），因此新脚本与旧 bash 脚本
 *   在过渡期可以互相接管对方的进程，IDE 里写死的路径也不会失效。
 *
 * 维护提示：
 *   1) 端口与 serveWeb 从 config 读取而不是硬编码——否则改了 config 的端口后，
 *      这里会去探测一个没人监听的端口，报出"未就绪"这种误导性的结论。
 *   2) 停止前必须核对 PID 对应的命令行。PID 会被系统回收，陈旧 PID 文件直接 kill
 *      可能杀掉一个完全无关的进程；核对失败时保留 PID 文件并报错，不静默清理。
 *   3) 健康检查用 fetch + AbortSignal.timeout(1000)，与旧脚本的 curl --max-time 1 等价，
 *      但不依赖系统是否装了 curl。
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = resolve(HERE, "..");
const GIT_ROOT = resolve(CODE_ROOT, "..");
const RUNTIME_ROOT = join(GIT_ROOT, ".runtime");
const CONFIG_PATH = join(CODE_ROOT, "config", "pipeline-factory.config.json");

const API_PID_FILE = join(RUNTIME_ROOT, "api.pid");
const WEB_PID_FILE = join(RUNTIME_ROOT, "web.pid");
const MODE_FILE = join(RUNTIME_ROOT, "mode");
const API_LOG = join(RUNTIME_ROOT, "api.log");
const WEB_LOG = join(RUNTIME_ROOT, "web.log");

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;

/** 端口等参数一律以 config 为准；解析失败时退回默认值，让 status 仍能给出有用信息。 */
const config = readJson(CONFIG_PATH);
const API_PORT = config?.server?.port ?? 4310;
const WEB_PORT = config?.web?.port ?? 5173;
const SERVE_WEB = config?.server?.serveWeb === true;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** 归属校验用的命令行特征。命中任一即认为是本项目的进程。 */
const API_MARKERS = [/@pipeline-factory\/api/, /apps\/api/, /src\/main\.ts/, /dist\/main\.js/];
const WEB_MARKERS = [/@pipeline-factory\/web/, /apps\/web/, /vite/];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const mode = readModeFlag(rest);
  const only = readOnlyFlag(rest);

  switch (command) {
    case "start":
      process.exitCode = (await start(mode, only)) ? 0 : 1;
      return;
    case "stop":
      process.exitCode = (await stop(only)) ? 0 : 1;
      return;
    case "status":
      process.exitCode = (await status()) ? 0 : 1;
      return;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

function usage() {
  console.log(`用法：
  node scripts/service.mjs start [--mode dev|prod] [--only api|web]
  node scripts/service.mjs stop [--only api|web]
  node scripts/service.mjs status

dev  ：API(${API_PORT}) + Web(${WEB_PORT})，前端同源由 vite proxy 提供。
prod ：仅 API(${API_PORT})，同时托管 apps/web/dist（需先 pnpm build）。
--only：只操作其中一个进程；dev 下"停一个不影响另一个"就是靠它保留的。`);
}

function readModeFlag(args) {
  const index = args.indexOf("--mode");
  if (index < 0) return "dev";
  const value = args[index + 1];
  if (value !== "dev" && value !== "prod") throw new Error(`--mode 只接受 dev 或 prod，收到: ${value ?? "(空)"}`);
  return value;
}

function readOnlyFlag(args) {
  const index = args.indexOf("--only");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value !== "api" && value !== "web") throw new Error(`--only 只接受 api 或 web，收到: ${value ?? "(空)"}`);
  return value;
}

// ---------------------------------------------------------------- start

async function start(mode, only) {
  if (only === "web" && mode === "prod") {
    console.error("--only web 在 prod 模式下没有意义：前端由 API 同端口托管，不存在独立的 Web 进程。");
    return false;
  }
  if (mode === "prod") {
    // 把"构建产物缺失"从"启动后页面 404"提前到启动期——这是原 bash 脚本没有的前置检查。
    if (!existsSync(join(CODE_ROOT, "apps/api/dist/main.js"))) {
      console.error("启动失败：apps/api/dist/main.js 不存在，请先执行 pnpm build");
      return false;
    }
    if (SERVE_WEB && !existsSync(join(CODE_ROOT, "apps/web/dist/index.html"))) {
      console.error("启动失败：config 里 serveWeb=true 但 apps/web/dist/index.html 不存在，请先执行 pnpm build");
      return false;
    }
  }

  if (only !== "web") {
    const apiReady = await startApi(mode);
    if (!apiReady) return false;
  }

  if (mode === "prod") {
    // prod 模式下 Web 不是独立进程，由 API 同端口托管；这里确认它真的托管上了，
    // 否则"启动成功"是假的——用户会打开一个 404 页面。
    if (SERVE_WEB && !(await servesWebUi())) {
      // 最常见的原因是 4310 上已经跑着一个**旧的 dev 模式 API**——它健康检查通过因而被复用，
      // 但那个进程是在 serveWeb 生效之前启动的，配置不会热加载。所以这里要明确指向重启。
      console.error(`API 已就绪但尚未托管 Web 页面：${API_URL}/ 未返回 text/html。`);
      console.error("若该端口上已有一个旧进程（例如 dev 模式启动的），请先 pnpm stop 再重新 pnpm start；");
      console.error("否则请确认 config 的 server.serveWeb 与 server.webDistPath 指向构建产物。");
      return false;
    }
    writeMode("prod");
    return true;
  }

  if (only !== "api") {
    const webReady = await startWeb();
    if (!webReady) return false;
  }

  writeMode("dev");
  if (only !== "api") {
    // dev 下 API 仍按 config 的 serveWeb 决定是否顺带托管构建产物，这不会干扰 5173 的开发流程，
    // 但容易让人误以为改代码不生效——所以显式提示。
    console.log(
      `注意：开发请访问 ${WEB_URL}（vite dev server）。${API_URL} 是 API 端口${SERVE_WEB ? "，若已构建也会托管一份构建产物" : ""}。`,
    );
  }
  return true;
}

async function startApi(mode) {
  // 端口上的健康服务优先于 PID 文件：这样由旧的 bash 脚本或 IDE 启动的进程
  // 不会被误报为"未启动"，并且能把真实 PID 回填进 PID 文件。
  if (await fetchOk(`${API_URL}/health`)) {
    const detected = listeningPid(API_PORT);
    if (detected) writePidFile(API_PID_FILE, detected);
    report("API 已在运行", detected, `${API_URL}`, API_LOG);
    return true;
  }

  const recorded = readPidFile(API_PID_FILE);
  if (recorded && isAlive(recorded)) {
    if (await waitFor(() => fetchOk(`${API_URL}/health`), READY_TIMEOUT_MS)) {
      report("API 已启动", recorded, `${API_URL}`, API_LOG);
      return true;
    }
    console.error(`API 进程仍在运行但未就绪，未重复启动（PID: ${recorded}）。日志: ${API_LOG}`);
    return false;
  }
  if (recorded) rmSync(API_PID_FILE, { force: true });

  const occupied = listeningPid(API_PORT);
  if (occupied) {
    console.error(`API 启动失败：端口 ${API_PORT} 已被 PID ${occupied} 占用，但健康检查未通过`);
    return false;
  }

  const pid = spawnDetached(
    mode === "prod"
      ? [process.execPath, [join(CODE_ROOT, "apps/api/dist/main.js"), "--config", CONFIG_PATH], join(CODE_ROOT, "apps/api")]
      : ["pnpm", ["--filter", "@pipeline-factory/api", "dev", "--", "--config", CONFIG_PATH], CODE_ROOT],
    API_LOG,
  );
  writePidFile(API_PID_FILE, pid);
  return await awaitReady("API", pid, `${API_URL}/health`, API_URL, API_LOG);
}

async function startWeb() {
  if (await fetchOk(`${WEB_URL}/`)) {
    const detected = listeningPid(WEB_PORT);
    if (detected) writePidFile(WEB_PID_FILE, detected);
    report("Web 已在运行", detected, `${WEB_URL}`, WEB_LOG);
    return true;
  }

  const recorded = readPidFile(WEB_PID_FILE);
  if (recorded && isAlive(recorded)) {
    if (await waitFor(() => fetchOk(`${WEB_URL}/`), READY_TIMEOUT_MS)) {
      report("Web 已启动", recorded, `${WEB_URL}`, WEB_LOG);
      return true;
    }
    console.error(`Web 进程仍在运行但未就绪，未重复启动（PID: ${recorded}）。日志: ${WEB_LOG}`);
    return false;
  }
  if (recorded) rmSync(WEB_PID_FILE, { force: true });

  const occupied = listeningPid(WEB_PORT);
  if (occupied) {
    console.error(`Web 启动失败：端口 ${WEB_PORT} 已被 PID ${occupied} 占用，但页面检查未通过`);
    return false;
  }

  const pid = spawnDetached(["pnpm", ["--filter", "@pipeline-factory/web", "dev"], CODE_ROOT], WEB_LOG);
  writePidFile(WEB_PID_FILE, pid);
  return await awaitReady("Web", pid, `${WEB_URL}/`, WEB_URL, WEB_LOG);
}

/** 等到健康检查通过；进程提前退出时立刻失败，并把日志尾部打出来，不用等人去翻文件。 */
async function awaitReady(label, pid, url, displayUrl, logFile) {
  const ready = await waitFor(
    () => fetchOk(url),
    READY_TIMEOUT_MS,
    () => isAlive(pid),
  );
  if (ready) {
    report(`${label} 已启动`, pid, displayUrl, logFile);
    return true;
  }
  rmSync(label === "API" ? API_PID_FILE : WEB_PID_FILE, { force: true });
  console.error(`${label} 启动失败或未在 30 秒内就绪，请查看日志: ${logFile}`);
  console.error(tailLines(logFile, 30));
  return false;
}

// ---------------------------------------------------------------- stop

async function stop(only) {
  const results = [
    only === "web" ? true : stopService("API", API_PID_FILE, API_MARKERS, API_PORT),
    only === "api" ? true : stopService("Web", WEB_PID_FILE, WEB_MARKERS, WEB_PORT),
  ];
  const stopped = results.every(Boolean);
  // 只有整体停止时才清除模式记录：--only 停掉一个之后另一个可能还在跑，模式依然成立。
  if (stopped && !only) rmSync(MODE_FILE, { force: true });
  return stopped;
}

function stopService(label, pidFile, markers, port) {
  if (!existsSync(pidFile)) {
    console.log(`${label} 未运行（没有 PID 文件）`);
    return true;
  }

  const pid = readPidFile(pidFile);
  if (!pid) {
    rmSync(pidFile, { force: true });
    console.log(`已清理无效的 ${label} PID 文件`);
    return true;
  }

  if (!isAlive(pid)) {
    rmSync(pidFile, { force: true });
    console.log(`${label} 已停止`);
    return true;
  }

  const command = commandOf(pid);
  if (!markers.some((marker) => marker.test(command))) {
    // 保留 PID 文件而不静默清理：这里最可能的解释是 PID 被系统回收了，
    // 需要人看一眼再决定，不是脚本能替用户判断的事。
    console.error(`${label} PID 文件指向了其他进程，未执行停止操作: ${pid}`);
    console.error(`  实际命令: ${command || "(读取失败)"}`);
    return false;
  }

  killProcessTree(pid);
  if (!waitForSync(() => !isAlive(pid), STOP_TIMEOUT_MS)) {
    console.error(`${label} 未能在 5 秒内停止，请检查进程: ${pid}`);
    return false;
  }

  rmSync(pidFile, { force: true });
  const lingering = listeningPid(port);
  if (lingering) {
    // 父进程没了但端口还被占，说明有子进程脱离了进程组——这种情况必须报出来，
    // 否则下一次 start 会撞上"端口被占用但健康检查失败"。
    console.error(`${label} 的父进程已退出，但端口 ${port} 仍被 PID ${lingering} 占用`);
    return false;
  }
  console.log(`${label} 已停止`);
  return true;
}

// ---------------------------------------------------------------- status

async function status() {
  const mode = readMode();
  const apiHealthy = await fetchOk(`${API_URL}/health`);
  let ok = describe("API", API_PID_FILE, `${API_URL}/health`, API_PORT, apiHealthy);

  if (apiHealthy && SERVE_WEB) {
    // 只看 /health 无法区分"单进程托管生效"与"API 单独在跑"，这一项才是托管的可信信号。
    const serving = await servesWebUi();
    console.log(`  单进程托管: ${serving ? `已启用（GET / → 200 text/html）` : "未生效（GET / 未返回 text/html）"}`);
    if (mode === "prod" && !serving) ok = false;
  }

  if (mode === "prod") {
    // prod 下 Web 不是独立进程，检查 5173 只会得到噪声。
    return ok;
  }

  const webHealthy = await fetchOk(`${WEB_URL}/`);
  // dev 下 Web 是必需的一环：只报 API 正常会让"忘了起前端"看起来像成功。
  return describe("Web", WEB_PID_FILE, `${WEB_URL}/`, WEB_PORT, webHealthy) && ok;
}

function describe(label, pidFile, url, port, healthy) {
  const recorded = readPidFile(pidFile);
  const alive = recorded !== null && isAlive(recorded);
  const listener = listeningPid(port);

  if (healthy) {
    const identity = alive ? `PID: ${recorded}` : listener ? `端口进程 PID: ${listener}，PID 文件已过期` : "PID 文件不可用";
    console.log(`${label}: 正常（${identity}，地址: ${url}）`);
    return true;
  }

  if (!existsSync(pidFile)) {
    if (listener) {
      console.log(`${label}: 端口已被 PID ${listener} 占用但健康检查失败（地址: ${url}）`);
      return false;
    }
    console.log(`${label}: 已停止（没有 PID 文件）`);
    return false;
  }
  if (recorded === null) {
    console.log(`${label}: PID 无效（PID 文件内容不是数字）`);
    return false;
  }
  if (!alive) {
    console.log(
      listener ? `${label}: PID 文件已过期，端口仍由 PID ${listener} 占用但健康检查失败` : `${label}: 已停止（PID ${recorded} 不存在）`,
    );
    return false;
  }
  console.log(`${label}: 进程运行但未就绪（PID: ${recorded}，健康检查失败）`);
  return false;
}

/** prod 模式的关键判据：根路径返回 200 且是 HTML，说明构建产物真的被托管了。 */
async function servesWebUi() {
  try {
    const response = await fetch(`${API_URL}/`, { signal: AbortSignal.timeout(1000) });
    return response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- helpers

async function fetchOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, alive) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (alive && !alive()) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
  }
}

function waitForSync(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    sleepSync(100);
  }
  return check();
}

/** 同步小睡：停止流程本身是同步的，用 Atomics.wait 避免把整条链路改成 async。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listeningPid(port) {
  try {
    // lsof 在无匹配时以非零码退出，被下面的 catch 吞掉，语义正好是"没有监听者"。
    const output = execFileSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = output
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    return first && /^\d+$/.test(first) ? Number(first) : null;
  } catch {
    return null;
  }
}

function commandOf(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 停止整棵进程树，且不误伤别人：
 *   - 本脚本 detach 启动的进程本身就是进程组组长，负 PID 一次带走 pnpm → node/tsx → vite 整棵树，最干净。
 *   - 旧 bash 脚本启动的进程不是组长。此时**绝不能**用负 PID——PID 被系统回收后，那个进程组号
 *     可能已经属于别的进程树，-pid 会打到无关进程上。所以退回逐层递归，先子后父，
 *     否则父进程一退出，pnpm/node/vite 就变成孤儿继续占着端口。
 */
function killProcessTree(pid) {
  if (pgidOf(pid) === pid) {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      /* 落到递归分支 */
    }
  }
  for (const child of childPids(pid)) killProcessTree(child);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已经退出 */
  }
}

function pgidOf(pid) {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d+$/.test(output) ? Number(output) : null;
  } catch {
    return null;
  }
}

function childPids(pid) {
  try {
    // pgrep 在无匹配时以非零码退出，被 catch 吞掉，语义正好是"没有子进程"。
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return [];
  }
}

function spawnDetached([command, args, cwd], logFile) {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return child.pid;
  } finally {
    // 子进程已经 dup 了自己的那份描述符，父进程这份必须关掉，否则长跑的命令行会一直持有日志句柄。
    closeSync(fd);
  }
}

function readPidFile(file) {
  const text = readText(file)?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : null;
}

function writePidFile(file, pid) {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  writeFileSync(file, `${pid}\n`);
}

function readMode() {
  const mode = readText(MODE_FILE)?.trim();
  // 没有 mode 文件说明进程是旧的 bash 脚本启动的——按 dev 处理，因为那是旧脚本唯一的语义。
  return mode === "prod" ? "prod" : "dev";
}

function writeMode(mode) {
  mkdirSync(RUNTIME_ROOT, { recursive: true });
  writeFileSync(MODE_FILE, `${mode}\n`);
}

function report(message, pid, url, logFile) {
  console.log(`${message}，PID: ${pid ?? "未知"}`);
  console.log(`地址: ${url}`);
  console.log(`日志: ${logFile}`);
}

function tailLines(file, count) {
  const text = readText(file);
  return text ? text.split("\n").slice(-count).join("\n") : "(日志为空)";
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file) {
  const text = readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
