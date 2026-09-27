/**
 * 模块职责：让 API 进程同时托管 Web 构建产物，使生产环境只需一个进程、一个端口
 *   就能提供前端页面与 /api/v4/* 接口。
 *
 * 为什么必须同源：前端 SSE 用 new EventSource(相对路径)，而 EventSource 不能自定义
 *   header，只有页面与 API 同源才工作；router 用 createWebHistory（HTML5 history），
 *   深链也必须由服务端 fallback 兜住。开发期这份同源由 vite proxy 提供，生产期由本模块提供。
 *
 * 分工：真实文件由 @fastify/static 的 wildcard 路由直接服务（含 HEAD），缓存策略通过它的
 *   setHeaders 钩子按路径区分；只有"没有匹配到任何文件"的请求才落到本模块的 notFoundHandler，
 *   在那里做 SPA fallback 与 API 的 JSON 404。
 *
 * 维护提示（三个反直觉的坑，都是实测踩出来的）：
 *   1) 不要用 wildcard:false。它并不是"不注册路由"，而是**在启动时枚举 root 下每个文件、
 *      为每个文件注册一条 HEAD/GET 路由**。那样真实资源永远走不到 notFoundHandler，
 *      写在那里的缓存策略会变成对真实资源无效的死代码，且新增文件必须重启才可见。
 *   2) 不要用 app.get("/*") 做 SPA fallback。它会与插件自带的 HEAD 路由冲突，
 *      启动期直接抛 "Method 'HEAD' already declared for route '/*'"。
 *   3) vite 的 base 必须与这里的 prefix 一致（当前都是 "/"）。改成子路径时必须同步改 prefix
 *      与 ASSETS_DIRECTORY，否则资源请求会拿到 index.html 并以错误的 MIME 加载。
 */
import { existsSync } from "node:fs";
import { extname, join, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { FactoryConfig } from "./config.js";

/**
 * 缓存策略：vite 产物里只有 assets/ 下的文件带内容哈希，内容变了文件名就变，可以永久缓存；
 * 其余（index.html、favicon.ico 等未版本化文件）必须每次回源校验，否则换了用户也看不到。
 */
const ASSETS_DIRECTORY = "assets";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";

/**
 * 注册静态托管。构建产物不存在时**只告警不注册**——这样全新 clone 上还没执行
 * `pnpm build` 时，`serveWeb: true` 也不会把开发流程炸掉，只是页面 404。
 */
export function registerWebHosting(app: FastifyInstance, config: FactoryConfig): void {
  const root = config.server.webDistPath;
  if (!existsSync(join(root, "index.html"))) {
    app.log.warn(`serveWeb is enabled but ${join(root, "index.html")} does not exist; run the web build first. Skipping static hosting.`);
    return;
  }

  const assetsRoot = join(root, ASSETS_DIRECTORY);
  void app.register(fastifyStatic, {
    root,
    prefix: "/",
    // 让 "/" 与 "/projects/demo/execute" 这类目录请求由插件直接回 index.html；
    // 用 index:false 时插件会把 "/" 判成"试图列目录"并返回 403，而 403 不会落到 notFoundHandler。
    index: ["index.html"],
    // 关掉插件自带的整目录统一缓存头，改为按路径区分，否则 assets 与 index.html 只能二选一。
    cacheControl: false,
    setHeaders: (response, filePath) => {
      response.setHeader("cache-control", filePath.startsWith(assetsRoot + sep) ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    },
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = pathnameOf(request.url);

    // 1) 非 GET/HEAD 的未匹配请求一律 JSON 404，绝不返回 HTML。
    if (request.method !== "GET" && request.method !== "HEAD") return sendJsonNotFound(reply);

    // 2) API 的 JSON 契约不能被 SPA fallback 污染，否则前端把 HTML 当 JSON 解析会得到
    //    难以定位的语法错误，而不是一个明确的 404。
    if (pathname.startsWith("/api/") || pathname === "/health") return sendJsonNotFound(reply);

    // 3) 带扩展名的一律当作资源请求，且**必然找不到**——root 下真实存在的文件已经被插件
    //    的 wildcard 路由抢先服务了，能落到这里就说明磁盘上没有它。所以直接真 404，绝不回 index.html。
    //    这是"MIME 报错"的防线：把 HTML 当成 .js 返回，浏览器会报难以定位的模块加载错误。
    if (extname(pathname)) return sendJsonNotFound(reply);

    // 4) 其余是前端路由深链，交给 index.html，由客户端 router 接管。
    return reply.sendFile("index.html");
  });
}

/** 去掉 query 并解码，使 %2e%2e%2f 这类编码穿越在下一步的路径校验里无处可藏。 */
function pathnameOf(url: string): string {
  const raw = url.split("?", 1)[0] ?? url;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sendJsonNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ code: "NOT_FOUND", error: "Not found" });
}
