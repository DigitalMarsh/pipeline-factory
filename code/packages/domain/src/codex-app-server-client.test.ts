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
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "server-request-id", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [], isBlocking: true, autoResolutionMs: null } })}\n`);
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
