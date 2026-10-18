/**
 * 测试职责：本机控制面的来源边界 —— CORS 不再反射任意 Origin、Host 头限制在回环、
 *   非回环监听必须带 Bearer token。
 *
 * 设计说明：两条路径分别验证：
 *   1) 无配置的测试实例（回环默认）：恶意 Origin / 非回环 Host 被 403；
 *   2) 非回环配置：config schema 拒绝无 token 的配置，带 token 时 /health 豁免、其余接口 401/200。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPipelineStore } from "@pipeline-factory/core";
import { loadFactoryConfig } from "./config.js";
import { createApp } from "./server.js";
import { allowedBrowserOrigins, isAllowedLoopbackHostHeader, isAllowedOrigin, isLoopbackHost } from "./security.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-security-"));
  directories.push(directory);
  return directory;
}

function writeConfig(directory: string, server: Record<string, unknown>): string {
  const path = join(directory, "pipeline-factory.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      server,
      storage: { databasePath: join(directory, "db.sqlite"), worktreeRoot: join(directory, "worktrees") },
      project: { root: directory },
      model: { backend: "stub" },
    }),
  );
  return path;
}

describe("loopback and origin helpers", () => {
  it("recognizes loopback hosts, including IPv4-mapped IPv6", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.2", "evil.example", "localhost.evil.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("accepts only loopback Host headers", () => {
    expect(isAllowedLoopbackHostHeader("127.0.0.1:4310")).toBe(true);
    expect(isAllowedLoopbackHostHeader("localhost:5173")).toBe(true);
    expect(isAllowedLoopbackHostHeader("[::1]:4310")).toBe(true);
    expect(isAllowedLoopbackHostHeader("evil.example:4310")).toBe(false);
    expect(isAllowedLoopbackHostHeader(undefined)).toBe(false);
  });

  it("allows loopback origins on any port plus explicitly configured origins", () => {
    const allowed = allowedBrowserOrigins({ serverPort: 4310, webPort: 5173, extra: ["https://factory.example"] });
    expect(isAllowedOrigin("http://localhost:5199", allowed)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4310", allowed)).toBe(true);
    expect(isAllowedOrigin("https://factory.example/", allowed)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });
});

describe("request guards", () => {
  it("rejects a foreign browser Origin without reflecting it in CORS", async () => {
    const app = createApp({ store: new InMemoryPipelineStore(), seed: false });
    apps.push(app);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v4/projects",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    const write = await app.inject({
      method: "POST",
      url: "/api/v4/projects",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(write.statusCode).toBe(403);
    expect((write.json() as { code: string }).code).toBe("ORIGIN_FORBIDDEN");
  });

  it("keeps loopback dev origins working and rejects a non-loopback Host", async () => {
    const app = createApp({ store: new InMemoryPipelineStore(), seed: false });
    apps.push(app);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v4/projects",
      headers: {
        origin: "http://localhost:5199",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5199");

    const rebound = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example" } });
    expect(rebound.statusCode).toBe(403);
    expect((rebound.json() as { code: string }).code).toBe("HOST_FORBIDDEN");
  });

  it("refuses a non-loopback listen without a token and enforces it when present", async () => {
    const directory = tempDirectory();
    const withoutToken = writeConfig(directory, { host: "0.0.0.0", port: 4399 });
    expect(() => loadFactoryConfig(withoutToken)).toThrow(/authToken/);

    const withToken = writeConfig(directory, { host: "0.0.0.0", port: 4399, authToken: "0123456789abcdef" });
    const app = createApp({ config: loadFactoryConfig(withToken), seed: false });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v4/model-backends" })).statusCode).toBe(401);
    const authorized = await app.inject({
      method: "GET",
      url: "/api/v4/model-backends",
      headers: { authorization: "Bearer 0123456789abcdef" },
    });
    expect(authorized.statusCode).toBe(200);
  });
});
