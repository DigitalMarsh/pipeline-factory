/**
 * 模块职责：SSE 的**传输层** —— 打开一条 text/event-stream 通道，负责帧格式、心跳、可选轮询
 *   与关闭清理。此前这套样板在 server.ts 里复制了 6 份（workbench / agent-loop / run /
 *   explorer-thread / requirement-status / project-execution），差异只在业务侧。
 *
 * 只拥有传输层，**不拥有业务**：推什么内容、游标怎么推进、什么时候发 stream.ready、
 *   以及 Run SSE 的 telemetry.updated 节流，都由路由自己决定并留在路由里。把这些塞进本文件
 *   会让它从"帧格式的唯一出处"变成"6 个路由的业务汇合点"，那时候它就不可测了。
 *
 * 维护提示：
 *   1) **`reply.hijack()` 之后这条响应不再受 Fastify 管**：不写 content-length、不做
 *      keep-alive 协商、`reply.send()` 无效。所以本函数的调用方在它之后**不许再碰 reply**，
 *      也不许 `return reply.code(...).send(...)` —— 那些分支必须写在调用本函数之前。
 *   2) **access-control-allow-origin 是继承来的，不是硬编码的**：值取自 `@fastify/cors`
 *      在 onRequest 里算好的 header，于是 CORS 策略在全仓只有一处出处。cors 没算出值
 *      （典型情况：同源 GET，浏览器根本不发 Origin 头）时回落到 "*"，**这个回落只是为了
 *      保持抽函数前后逐字一致**；生产同源托管下它已经无用，确认后可单独一步删掉
 *      （见方案 P1 的"6 处手写 CORS 头"处置）。注意继承只能收窄、不会放宽：
 *      `origin: true` 算出的是请求方 Origin，比 `*` 更严。
 *   3) **心跳与轮询的定时器由本函数独占**：调用方不要再自己 setInterval，否则 close 时
 *      清理不到、连接泄漏。关闭清理只挂在 `request.raw.once("close")` 上（不用
 *      `reply.raw.on("close")`：hijack 后 raw 的 close 语义在 Fastify 版本间变过，
 *      而 request.raw 的 close 就是"客户端断开"本身）。
 *   4) **`onClose` 可以注册多个，按注册顺序执行**；订阅式通道路由（explorer-thread、
 *      requirement-status）用它来 unsubscribe，因为 unsubscribe 的句柄在 openSseChannel
 *      返回之后才拿得到。
 *   5) 帧格式：`id:` 行可省略（id 传 null，用于 telemetry.updated 这类不属于序列的推送）；
 *      `data:` 是单行 JSON —— **payload 里不要塞换行**，否则要按 SSE 规范拆成多行 data。
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** 心跳间隔：注释帧，防止中间代理把空闲连接掐掉。 */
export const SSE_HEARTBEAT_MS = 15_000;
/** 轮询式通道的默认推送间隔。 */
export const SSE_POLL_MS = 250;

export type SseChannelOptions = {
  /** 轮询式通道的推送函数。**省略即推送式通道**：由调用方在订阅回调里自己 send。 */
  poll?: (() => void) | undefined;
  pollIntervalMs?: number | undefined;
  heartbeatMs?: number | undefined;
};

export type SseChannel = {
  /** 写一帧 `id / event / data`。id 传 null 表示不带 id 行。 */
  send: (id: number | null, event: string, data: unknown) => void;
  /** 写握手帧 `stream.ready`。与普通帧同格式，断线重连才能靠 Last-Event-ID 对齐游标。 */
  ready: (id: number, data: unknown) => void;
  /** 写注释行（SSE 规范里以冒号开头的内容会被客户端忽略）。 */
  comment: (text: string) => void;
  /** 注册关闭时的清理动作（如取消订阅）。 */
  onClose: (handler: () => void) => void;
};

function frame(id: number | null, event: string, data: unknown): string {
  return `${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 打开 SSE 通道。返回后调用方**不得再使用 reply**（见维护提示 1）。 */
export function openSseChannel(request: FastifyRequest, reply: FastifyReply, options: SseChannelOptions = {}): SseChannel {
  const handlers: Array<() => void> = [];
  reply.hijack();
  const raw = reply.raw;
  const corsOrigin = reply.getHeader("access-control-allow-origin");
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": typeof corsOrigin === "string" && corsOrigin ? corsOrigin : "*",
  });

  const timers: Array<ReturnType<typeof setInterval>> = [];
  timers.push(setInterval(() => { raw.write(`: heartbeat ${Date.now()}\n\n`); }, options.heartbeatMs ?? SSE_HEARTBEAT_MS));
  if (options.poll) {
    const poll = options.poll;
    timers.push(setInterval(poll, options.pollIntervalMs ?? SSE_POLL_MS));
  }
  request.raw.once("close", () => {
    for (const timer of timers) clearInterval(timer);
    for (const handler of handlers) handler();
  });

  return {
    send: (id, event, data) => { raw.write(frame(id, event, data)); },
    ready: (id, data) => { raw.write(frame(id, "stream.ready", data)); },
    comment: (text) => { raw.write(`: ${text}\n\n`); },
    onClose: (handler) => { handlers.push(handler); },
  };
}
