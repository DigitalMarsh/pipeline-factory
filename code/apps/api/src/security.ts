/**
 * 模块职责：本机控制面的**来源边界** —— 判断监听地址是否回环、允许哪些浏览器 Origin、
 *   以及 Host 头是否可信。由 config（启动期校验）与 server（请求期守卫）共用。
 *
 * 为什么需要它：这个 API 能力等同于"本机 shell + 文件系统 + Git"（创建项目、派发 Run、
 *   执行仓库命令）。仅绑定 127.0.0.1 **不能**阻止恶意网页：浏览器可以访问回环地址，
 *   只要 API 的 CORS 反射任意 Origin，网页就能读响应、发预检并执行写操作。
 *   这里把"谁可以说话"收成一处，CORS 与请求守卫都读同一份判据。
 *
 * 维护提示：
 *   1) **回环判定是字符串级的**，不解析 DNS：`127.0.0.1`、`::1`、`localhost` 及其 IPv6 映射。
 *      新增监听形态（例如 unix socket）时在这里显式列出，不要用"不是 0.0.0.0 就算本机"。
 *   2) 允许的 Origin 只包含**回环 + 已配置的额外来源**；不要为了开发方便退回 `origin: true`。
 *   3) Host 头守卫只在本机监听时启用：远程监听由 authToken 负责，Host 可以是机器名/IP。
 */
import { isIP } from "node:net";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

/** 监听地址是否为回环（含 `::ffff:127.0.0.1` 这类 IPv4 映射）。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
  if (normalized === "::ffff:127.0.0.1") return true;
  // `127.0.0.0/8` 都是回环；`isIP` 返回 4 表示 IPv4。
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

/** 解析 `host[:port]` 里的主机名；IPv6 形如 `[::1]:4310`。 */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : null;
  }
  const colon = value.indexOf(":");
  return (colon >= 0 ? value.slice(0, colon) : value) || null;
}

/**
 * 本机监听时可信的 Host 头：只接受回环主机名。**防 DNS rebinding**：
 * 攻击者把 evil.example 解析到 127.0.0.1 后，浏览器发出的 Host 仍是 evil.example，
 * 此时请求必须被拒绝，不能只看来源 IP。
 */
export function isAllowedLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && isLoopbackHost(hostname);
}

/** 浏览器侧允许的 Origin：回环 API/Web 端口 + 配置里的额外来源（去重、稳定顺序）。 */
export function allowedBrowserOrigins(input: { serverPort: number; webPort: number; extra?: readonly string[] }): Set<string> {
  const origins = new Set<string>();
  for (const port of new Set([input.serverPort, input.webPort])) {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) origins.add(`http://${host}:${port}`);
  }
  for (const origin of input.extra ?? []) {
    const trimmed = origin.trim().replace(/\/+$/, "");
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

/**
 * Origin 是否允许：**回环来源（任意端口，开发工具常用随机端口）** + 配置的额外来源。
 *
 * 允许回环的任意端口是有意的：Vite / 预览工具会换端口，而它们都在本机；
 * 关键边界是"非本机来源一律拒绝"，不是把端口写死。没有 Origin（同源 GET / 非浏览器客户端）视为允许。
 */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return true;
  const normalized = origin.trim().replace(/\/+$/, "");
  if (allowed.has(normalized)) return true;
  try {
    return isLoopbackHost(new URL(normalized).hostname);
  } catch {
    return false;
  }
}
