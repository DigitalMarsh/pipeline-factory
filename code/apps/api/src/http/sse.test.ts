/**
 * 测试职责：锁定 SSE 传输层的对外行为 —— 帧格式、响应头（含 CORS 头继承）、心跳与轮询节拍、
 *   以及客户端断开后的清理。
 * 设计说明：用假的 request/reply 直接驱动 openSseChannel，不经过 HTTP。**这是唯一能测 SSE 的
 *   层**：server.test.ts 里的 `app.inject` 对 hijack 后的响应永不 resolve（SSE 不会 end），
 *   所以 130 处 inject 对 SSE 分支是零覆盖；路由级的真实覆盖另见 server-sse.test.ts（真听端口）。
 * 维护提示：帧格式或响应头变化时同步本文件的断言；新增节拍参数时应补 fake timer 用例。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openSseChannel, SSE_HEARTBEAT_MS, SSE_POLL_MS } from "./sse.js";

type Harness = {
  request: FastifyRequest;
  reply: FastifyReply;
  close: () => void;
  written: string[];
  headers: () => Record<string, unknown>;
  hijacked: () => boolean;
};

function harness(computedCorsOrigin?: string): Harness {
  const written: string[] = [];
  let headers: Record<string, unknown> = {};
  let hijacked = false;
  const raw = {
    writeHead: (_status: number, value: Record<string, unknown>) => { headers = value; return raw; },
    write: (chunk: string) => { written.push(chunk); return true; },
  };
  const emitter = new EventEmitter();
  const request = { raw: emitter } as unknown as FastifyRequest;
  const reply = {
    raw,
    hijack: () => { hijacked = true; },
    getHeader: () => computedCorsOrigin,
  } as unknown as FastifyReply;
  return { request, reply, close: () => { emitter.emit("close"); }, written, headers: () => headers, hijacked: () => hijacked };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("openSseChannel", () => {
  it("劫持响应并写 text/event-stream 头", () => {
    const h = harness();
    openSseChannel(h.request, h.reply);
    expect(h.hijacked()).toBe(true);
    expect(h.headers()).toMatchObject({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    h.close();
  });

  it("按 id / event / data 三行写帧，并以空行结尾", () => {
    const h = harness();
    const sse = openSseChannel(h.request, h.reply);
    sse.send(7, "journal.entry", { runId: "run-1", text: "执行中" });
    expect(h.written).toEqual(['id: 7\nevent: journal.entry\ndata: {"runId":"run-1","text":"执行中"}\n\n']);
    h.close();
  });

  it("id 传 null 时不写 id 行（telemetry.updated 这类不属于序列的推送）", () => {
    const h = harness();
    const sse = openSseChannel(h.request, h.reply);
    sse.send(null, "telemetry.updated", { runId: "run-1" });
    expect(h.written).toEqual(['event: telemetry.updated\ndata: {"runId":"run-1"}\n\n']);
    h.close();
  });

  it("ready 写 stream.ready 帧，与普通帧同格式", () => {
    const h = harness();
    const sse = openSseChannel(h.request, h.reply);
    sse.ready(3, { afterSequence: 3 });
    expect(h.written).toEqual(['id: 3\nevent: stream.ready\ndata: {"afterSequence":3}\n\n']);
    h.close();
  });

  it("CORS 头继承 @fastify/cors 算出的值；未算出时回落到 *", () => {
    const inherited = harness("https://app.example");
    openSseChannel(inherited.request, inherited.reply);
    expect(inherited.headers()["access-control-allow-origin"]).toBe("https://app.example");
    inherited.close();

    const absent = harness();
    openSseChannel(absent.request, absent.reply);
    expect(absent.headers()["access-control-allow-origin"]).toBe("*");
    absent.close();
  });

  it("心跳按 SSE_HEARTBEAT_MS 写注释帧", () => {
    const h = harness();
    openSseChannel(h.request, h.reply);
    expect(h.written).toEqual([]);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toMatch(/^: heartbeat \d+\n\n$/);
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
    expect(h.written).toHaveLength(2);
    h.close();
  });

  it("传入 poll 时按 SSE_POLL_MS 调用；不传则完全不轮询", () => {
    const poll = vi.fn();
    const polling = harness();
    openSseChannel(polling.request, polling.reply, { poll });
    vi.advanceTimersByTime(SSE_POLL_MS * 3);
    expect(poll).toHaveBeenCalledTimes(3);
    polling.close();

    const push = vi.fn();
    const pushOnly = harness();
    openSseChannel(pushOnly.request, pushOnly.reply, { pollIntervalMs: 1 });
    vi.advanceTimersByTime(1000);
    expect(push).not.toHaveBeenCalled();
    pushOnly.close();
  });

  it("客户端断开后停掉全部定时器并依次执行 onClose", () => {
    const poll = vi.fn();
    const order: string[] = [];
    const h = harness();
    const sse = openSseChannel(h.request, h.reply, { poll });
    sse.onClose(() => { order.push("first"); });
    sse.onClose(() => { order.push("second"); });
    vi.advanceTimersByTime(SSE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    h.close();
    expect(order).toEqual(["first", "second"]);
    const afterClose = h.written.length;
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(h.written).toHaveLength(afterClose);
  });
});
