/**
 * 测试职责：验证 API 单进程托管 Web 构建产物时，"哪类请求得到哪类响应"的分流契约。
 * 设计说明：用 mkdtemp 造一份最小 dist fixture，因此不依赖真实的 Web 构建产物，
 *   任何 checkout 上都能跑。`app.inject` 能驱动 @fastify/static 的磁盘读取，所以这里
 *   可以断言真实的 content-type 与 cache-control，而不是只测分支判定的纯函数。
 *   重点锁住三条防线——不存在的资源绝不能回 index.html（否则浏览器会把 HTML 当模块加载
 *   并报 MIME 错误）、/api/* 的 404 必须保持 JSON、根路径不能被判成"试图列目录"而返回 403。
 * 维护提示：改动 vite 的 base 时必须同步改这里的资源路径与 prefix 期望。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryConfig } from "./config.js";
import { registerWebHosting } from "./web-hosting.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * 造一份最小 dist：一个 index.html、一个带内容哈希的资源、一个未版本化的 favicon，
 * 以及 root 之外的诱饵文件。`outsideName` 必须返回给用例——否则穿越用例会指向一个
 * 不存在的路径，那样即使防护完全失效测试也会通过，变成一条假的绿灯。
 */
function createDistFixture(): { root: string; outsideName: string } {
  const root = mkdtempSync(join(tmpdir(), "pipeline-factory-web-dist-"));
  directories.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), '<!doctype html><div id="app"></div>');
  writeFileSync(join(root, "favicon.ico"), "icon");
  writeFileSync(join(root, "assets", "index-abc123.js"), "export default 1;");
  const outsideName = `outside-${directories.length}.js`;
  writeFileSync(join(dirname(root), outsideName), "secret");
  return { root, outsideName };
}

function createHostingApp(distPath: string): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/v4/projects", async () => ({ items: [] }));
  // 与 createApp 一致：业务路由先注册，静态托管最后接管未匹配请求。
  registerWebHosting(app, { server: { host: "127.0.0.1", port: 4310, serveWeb: true, webDistPath: distPath } } as unknown as FactoryConfig);
  return app;
}

describe("single-process web hosting", () => {
  it("serves index.html at the root and for client-side deep links", async () => {
    const app = createHostingApp(createDistFixture().root);

    // 这条同时锁住 index:["index.html"]：没有它时插件会把 "/" 判成试图列目录并返回 403，
    // 而 403 不会落到 notFoundHandler，SPA 直接打不开。
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain('<div id="app">');

    // createWebHistory 模式下深链在服务端没有任何对应文件，必须回落到 index.html。
    const deepLink = await app.inject({ method: "GET", url: "/projects/demo/explorer" });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers["content-type"]).toContain("text/html");
    expect(deepLink.headers["cache-control"]).toBe("no-cache");
  });

  it("serves hashed assets as immutable and keeps HEAD working without a wildcard route conflict", async () => {
    const app = createHostingApp(createDistFixture().root);

    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    // unversioned 文件不能永久缓存，否则换了图标用户永远看不到。
    const favicon = await app.inject({ method: "GET", url: "/favicon.ico" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["cache-control"]).toBe("no-cache");

    // 若用 app.get("/*") 做 fallback，这里会在启动期就抛 HEAD 路由冲突。
    expect((await app.inject({ method: "HEAD", url: "/" })).statusCode).toBe(200);
  });

  it("returns a real 404 for missing assets instead of falling back to index.html", async () => {
    const app = createHostingApp(createDistFixture().root);

    const missing = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
    // 这条断言是本模块最重要的防线：把 HTML 当 JS 返回会让浏览器报难以定位的 MIME 错误。
    expect(missing.headers["content-type"]).not.toContain("text/html");
    expect(missing.body).not.toContain('<div id="app">');
  });

  it("keeps the JSON contract for API paths and rejects non-GET methods", async () => {
    const app = createHostingApp(createDistFixture().root);

    const known = await app.inject({ method: "GET", url: "/api/v4/projects" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ items: [] });

    // /health 是真实路由，不该被 fallback 干扰。
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

    const unknownApi = await app.inject({ method: "GET", url: "/api/v4/does-not-exist" });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers["content-type"]).toContain("application/json");

    const posted = await app.inject({ method: "POST", url: "/projects/demo/explorer" });
    expect(posted.statusCode).toBe(404);
    expect(posted.headers["content-type"]).toContain("application/json");
  });

  it("refuses to serve files outside the dist root", async () => {
    const { root, outsideName } = createDistFixture();
    const app = createHostingApp(root);

    // 诱饵文件真实存在，所以这条用例证的是"穿越被拦"而不是"文件恰好不在"。
    const escaped = await app.inject({ method: "GET", url: `/%2e%2e%2f${outsideName}` });
    // 403 来自 @fastify/static 自己的越界防护，404 来自本模块的 notFoundHandler——
    // 插件版本变化可能改变走哪条路，两者都是合法拒绝，所以不锁死具体码，只锁"没漏出去"。
    expect([403, 404]).toContain(escaped.statusCode);
    expect(escaped.body).not.toContain("secret");
  });

  it("registers nothing when the build output is absent", async () => {
    const app = createHostingApp(join(tmpdir(), "pipeline-factory-missing-dist"));

    // 没有构建产物时应当只是 404，而不是抛错或返回 HTML——`pnpm build` 之前 dev 依然可用。
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
