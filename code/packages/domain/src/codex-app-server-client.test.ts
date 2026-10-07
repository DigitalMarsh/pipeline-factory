/**
 * 测试职责：验证 codex-app-server-client 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, type CodexSpawnProcess } from "./index.js";

describe("CodexAppServerClient", () => {
  it("performs initialize, sends JSON-RPC requests, and routes streamed notifications to a turn", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => true,
    });
    const requests: string[] = [];
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id: string; method: string };
      requests.push(request.method);
      const response = (result: unknown) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      if (request.method === "initialize") response({ serverInfo: { name: "codex", version: "test" } });
      if (request.method === "thread/start") response({ thread: { id: "thread-1" } });
      if (request.method === "turn/start") {
        response({ turn: { id: "turn-1", status: "inProgress" } });
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } })}\n`);
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })}\n`);
      }
    });
    const spawnProcess: CodexSpawnProcess = () => child as unknown as ReturnType<CodexSpawnProcess>;
    const client = new CodexAppServerClient({ command: "codex", args: ["app-server", "--stdio"], cwd: "/tmp", startupTimeoutMs: 5000, requestTimeoutMs: 5000, clientName: "test", clientVersion: "1.0.0", spawnProcess });

    await expect(client.startThread({ model: "gpt-5", cwd: "/tmp/project", sandbox: "read-only", approvalPolicy: "never" })).resolves.toBe("thread-1");
    const events = [];
    for await (const event of client.streamTurn({ threadId: "thread-1", input: [{ type: "text", text: "inspect" }], model: "gpt-5" })) events.push(event);

    expect(requests).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(events).toEqual([
      { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
    ]);
    await client.close();
  });

  it("routes interleaved notifications for concurrent provider threads to their own streams", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
    let threadNumber = 0;
    let turnNumber = 0;
    stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id: string; method: string; params?: { threadId?: string } };
      const respond = (result: unknown) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      if (request.method === "initialize") respond({});
      if (request.method === "thread/start") respond({ thread: { id: `provider-thread-${++threadNumber}` } });
      if (request.method === "turn/start") {
        const threadId = request.params?.threadId ?? "";
        const turnId = `provider-turn-${++turnNumber}`;
        respond({ turn: { id: turnId, status: "inProgress" } });
        setImmediate(() => {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId, delta: threadId } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`);
        });
      }
    });
    const client = new CodexAppServerClient({ command: "codex", args: ["app-server"], cwd: "/tmp", startupTimeoutMs: 5000, requestTimeoutMs: 5000, clientName: "test", clientVersion: "1.0.0", spawnProcess: () => child as unknown as ReturnType<CodexSpawnProcess> });
    const firstThread = await client.startThread({ model: "gpt-5", cwd: "/tmp/project", sandbox: "read-only", approvalPolicy: "never" });
    const secondThread = await client.startThread({ model: "gpt-5", cwd: "/tmp/project", sandbox: "read-only", approvalPolicy: "never" });
    const collect = async (threadId: string) => {
      const events = [];
      for await (const event of client.streamTurn({ threadId, input: [{ type: "text", text: threadId }], model: "gpt-5" })) events.push(event);
      return events;
    };

    const [firstEvents, secondEvents] = await Promise.all([collect(firstThread), collect(secondThread)]);

    expect(firstEvents).toEqual([
      { method: "item/agentMessage/delta", params: { threadId: firstThread, turnId: "provider-turn-1", delta: firstThread } },
      { method: "turn/completed", params: { threadId: firstThread, turn: { id: "provider-turn-1", status: "completed" } } },
    ]);
    expect(secondEvents).toEqual([
      { method: "item/agentMessage/delta", params: { threadId: secondThread, turnId: "provider-turn-2", delta: secondThread } },
      { method: "turn/completed", params: { threadId: secondThread, turn: { id: "provider-turn-2", status: "completed" } } },
    ]);
    await client.close();
  });

  it("preserves a server request id and responds to item/tool/requestUserInput", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => true });
    const writes: Array<Record<string, unknown>> = [];
    stdin.on("data", (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString()) as Record<string, unknown>;
      writes.push(message);
      if (message.method === "initialize") stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
      if (message.method === "thread/start") stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } })}\n`);
      if (message.method === "turn/start") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } })}\n`);
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "server-request-id", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [], isBlocking: true } })}\n`);
      }
    });
    const client = new CodexAppServerClient({ command: "codex", args: ["app-server"], cwd: "/tmp", startupTimeoutMs: 5000, requestTimeoutMs: 5000, clientName: "test", clientVersion: "1.0.0", spawnProcess: () => child as unknown as ReturnType<CodexSpawnProcess> });
    await client.startThread({ model: "gpt-5", cwd: "/tmp/project", sandbox: "read-only", approvalPolicy: "never" });
    const stream = client.streamTurn({ threadId: "thread-1", input: [{ type: "text", text: "inspect" }], model: "gpt-5" });
    const event = await stream[Symbol.asyncIterator]().next();
    expect(event.value).toMatchObject({ id: "server-request-id", method: "item/tool/requestUserInput" });
    await client.answerUserInput("server-request-id", { answers: {} });
    expect(writes.at(-1)).toMatchObject({ id: "server-request-id", result: { answers: {} } });
    expect(writes[0]).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    await client.close();
  });
});
