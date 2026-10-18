/**
 * 测试职责：**图片输入**在模型层的三种原生传法，以及会话重建时图片路径不丢。
 *
 * 设计说明：三个后端各自断言"请求形状"，不启动真实进程、不访问网络：
 *   - Codex：`turn/start` 的 input 里出现 `{ type: "localImage", path }`；
 *   - Claude：只有带图时 prompt 才换成单条用户消息流，content 是 [text, image(base64)]；
 *   - OpenAI：用户消息 content 变成 `input_image` parts（data URL）；
 *   - 回放：带图的用户消息在 replay 文本里保留路径，而不是静默丢掉。
 *   图片文件用临时目录里的真实 PNG 字节，因为 Claude / OpenAI 的适配器会真的去读文件。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeAgentSdkGateway,
  CodexAppServerGateway,
  OpenAIModelGateway,
  type CodexAppServerSession,
  type CodexAppServerSessionFactory,
  type ModelEvent,
  type ModelRequest,
} from "../index.js";
import { latestUserImages, replayConversation } from "./provider-session.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function imageFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-image-"));
  directories.push(directory);
  const path = join(directory, "shot.png");
  writeFileSync(path, Buffer.from(PNG_BASE64, "base64"));
  return path;
}

function userRequest(content: string, images?: { path: string; mimeType: string }[]): ModelRequest {
  return { role: "executor", conversationId: "conv-1", messages: [{ role: "user", content, ...(images ? { images } : {}) }] };
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("provider image input", () => {
  it("sends Codex localImage items next to the text input", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const session: CodexAppServerSession = {
      startThread: async () => "codex-thread-1",
      resumeThread: async () => undefined,
      streamTurn: async function* (params) {
        calls.push({ method: "turn/start", params });
        yield* [] as Array<{ id?: string | number; method: string; params: Record<string, unknown> }>;
      },
      interrupt: async () => undefined,
      respond: async () => undefined,
      answerUserInput: async () => undefined,
      close: async () => undefined,
    };
    const factory: CodexAppServerSessionFactory = async () => session;
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      command: "codex",
      args: ["app-server", "--stdio"],
      sessionFactory: factory,
    });

    await collect(gateway.stream(userRequest("这张图哪里不对", [{ path: "/tmp/shot.png", mimeType: "image/png" }])));

    const turn = calls.find((call) => call.method === "turn/start")?.params as { input: unknown[] };
    expect(turn.input).toEqual([
      { type: "text", text: "这张图哪里不对" },
      { type: "localImage", path: "/tmp/shot.png" },
    ]);
  });

  it("keeps images when a continuation prompt is attached (Explorer plan boundary)", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const session: CodexAppServerSession = {
      startThread: async () => "codex-thread-1",
      resumeThread: async () => undefined,
      streamTurn: async function* (params) {
        calls.push({ method: "turn/start", params });
        yield* [] as Array<{ id?: string | number; method: string; params: Record<string, unknown> }>;
      },
      interrupt: async () => undefined,
      respond: async () => undefined,
      answerUserInput: async () => undefined,
      close: async () => undefined,
    };
    const factory: CodexAppServerSessionFactory = async () => session;
    const gateway = new CodexAppServerGateway({
      roles: { explorer: { model: "explorer-model" }, executor: { model: "executor-model" } },
      command: "codex",
      args: ["app-server", "--stdio"],
      sessionFactory: factory,
    });

    // Explorer 每轮都带 planBoundary 作为 continuationPrompt；它是附加指令而不是"没有新消息"，
    // 最新用户消息上的图片必须一起发出去——这正是实测里"模型看不见图"的根因。
    await collect(
      gateway.stream({
        ...userRequest("这张图哪里不对", [{ path: "/tmp/shot.png", mimeType: "image/png" }]),
        continuationPrompt: "[需求 18: 截图验证]\nUser message:\n这张图哪里不对",
      }),
    );

    const turn = calls.find((call) => call.method === "turn/start")?.params as { input: unknown[] };
    expect(turn.input).toEqual([
      { type: "text", text: "[需求 18: 截图验证]\nUser message:\n这张图哪里不对" },
      { type: "localImage", path: "/tmp/shot.png" },
    ]);
  });

  it("switches the Claude prompt to a single user-message stream only when images are present", async () => {
    const path = imageFile();
    const prompts: unknown[] = [];
    const script = async function* (): AsyncIterable<SDKMessage> {
      yield {
        type: "system",
        subtype: "init",
        session_id: "session-1",
        cwd: "/tmp/repo",
        tools: [],
        model: "claude-opus-5",
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        session_id: "session-1",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
        result: "done",
      } as unknown as SDKMessage;
    };
    const gateway = new ClaudeAgentSdkGateway({
      roles: { explorer: { model: "claude-opus-5" }, executor: { model: "claude-opus-5" } },
      sessionExists: async () => false,
      queryFactory: async ({ prompt }) => {
        prompts.push(prompt);
        return { stream: () => script(), interrupt: async () => undefined };
      },
    });

    await collect(gateway.stream(userRequest("看这张图", [{ path, mimeType: "image/png" }])));
    await collect(gateway.stream(userRequest("没有图")));
    await collect(
      gateway.stream({
        ...userRequest("看这张图", [{ path, mimeType: "image/png" }]),
        continuationPrompt: "本轮附加指令",
      }),
    );

    const withImage = prompts[0] as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages: Array<{ message: { content: unknown[] } }> = [];
    for await (const message of withImage) messages.push(message);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.content).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
    ]);
    expect(prompts[1]).toBe("没有图");

    // 有 continuationPrompt 时仍然走带图的消息流，正文是这条附加指令。
    const withBoundary = prompts[2] as AsyncIterable<{ message: { content: unknown[] } }>;
    const boundaryMessages: Array<{ message: { content: unknown[] } }> = [];
    for await (const message of withBoundary) boundaryMessages.push(message);
    expect(boundaryMessages[0]!.message.content).toEqual([
      { type: "text", text: "本轮附加指令" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
    ]);
  });

  it("maps OpenAI user messages with images to input_image parts", async () => {
    const path = imageFile();
    let body: Record<string, unknown> | undefined;
    const gateway = new OpenAIModelGateway({
      apiKey: "test-key",
      roles: { explorer: { model: "gpt-explorer" }, executor: { model: "gpt-executor" } },
      fetchFn: async (_url, init) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ id: "resp-1", output_text: "ok" }) };
      },
    });

    await collect(gateway.stream(userRequest("看图", [{ path, mimeType: "image/png" }])));

    const input = body?.input as Array<{ role: string; content: unknown }>;
    expect(input[0]!.content).toEqual([
      { type: "input_text", text: "看图" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` },
    ]);
  });

  it("keeps image paths in the replayed transcript instead of dropping them", () => {
    const replayed = replayConversation([
      { role: "user", content: "第一张图", images: [{ path: "/tmp/a.png", mimeType: "image/png" }] },
      { role: "assistant", content: "看到了" },
      { role: "user", content: "继续" },
    ]);

    expect(replayed).toContain("第一张图");
    expect(replayed).toContain("/tmp/a.png");
    expect(
      latestUserImages([
        { role: "user", content: "继续" },
        { role: "assistant", content: "好" },
      ]),
    ).toEqual([]);
  });
});
