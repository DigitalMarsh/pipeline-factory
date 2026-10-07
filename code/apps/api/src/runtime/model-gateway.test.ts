/**
 * 测试职责：验证按角色路由的 ModelGateway —— 分派、请求覆盖、输入/取消的归属反查、
 *   端点指纹与生命周期释放。
 * 设计说明：子网关是**可观察的替身**（记录每次调用），因此不需要真实 CLI；配置层只提供
 *   `ResolvedModelBackend` 事实，不读文件。
 * 维护提示：新增一种"需要按归属反查后端"的调用时（例如未来的工具审批回调），
 *   在这里补一条"归属不明时的行为"断言——那正是最容易写成静默失败的地方。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCapabilities, ModelEvent, ModelGateway, ModelRequest } from "@pipeline-factory/domain";
import { loadFactoryConfig, type ResolvedModelBackend } from "../config.js";
import { createModelGateway, RoutingModelGateway } from "./model-gateway.js";

type FakeGateway = ModelGateway & {
  readonly label: string;
  readonly calls: string[];
  readonly answered: Array<string | number>;
  readonly cancelled: string[];
  readonly closed: string[];
  close(): Promise<void>;
};

/** 可观察替身：每次调用都记在自己身上，测试据此断言"这次调用落到了哪个后端"。 */
function fakeGateway(label: string, options: { capabilities?: ModelCapabilities; inputRequestId?: string } = {}): FakeGateway {
  const calls: string[] = [];
  const answered: Array<string | number> = [];
  const cancelled: string[] = [];
  const closed: string[] = [];
  const gateway: FakeGateway = {
    label,
    calls,
    answered,
    cancelled,
    closed,
    configFor: () => ({ model: `${label}-model` }),
    ...(options.capabilities ? { capabilities: () => options.capabilities! } : {}),
    describeEndpoint: () => ({
      backend: label,
      endpoint: `${label}-endpoint`,
      source: "config",
      cliVersion: null,
      credentialSource: null,
      providerModel: null,
    }),
    async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push("stream");
      if (options.inputRequestId)
        yield {
          type: "turn.input_required",
          request: { requestId: options.inputRequestId, threadId: "t", turnId: "turn", itemId: "item", questions: [], isBlocking: true },
        };
      yield { type: "turn.completed" };
    },
    async answerUserInput(input) {
      answered.push(input.requestId);
    },
    async cancel(request) {
      cancelled.push(request.conversationId);
    },
    async close() {
      closed.push("closed");
    },
  };
  return gateway;
}

function backend(id: string, kind = "codex-app-server"): ResolvedModelBackend {
  return { id, kind: kind as ResolvedModelBackend["kind"], source: "registry", models: [] };
}

function router(input: { explorer: string; executor: string; defaultBackendId?: string; gateways: FakeGateway[]; ids?: string[] }) {
  const byLabel = new Map(input.gateways.map((gateway) => [gateway.label, gateway]));
  const ids = input.ids ?? input.gateways.map((gateway) => gateway.label);
  return new RoutingModelGateway({
    backends: new Map(ids.map((id) => [id, backend(id)])),
    roleBackend: { explorer: input.explorer, executor: input.executor },
    defaultBackendId: input.defaultBackendId ?? input.explorer,
    create: (id) => {
      const gateway = byLabel.get(id);
      if (!gateway) throw new Error(`no fake for ${id}`);
      return gateway;
    },
  });
}

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("RoutingModelGateway", () => {
  it("sends each role to its own agent", async () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    await drain(gateway.stream({ role: "explorer", messages: [{ role: "user", content: "explore" }] }));
    await drain(gateway.stream({ role: "executor", messages: [{ role: "user", content: "execute" }] }));

    expect(codex.calls).toEqual(["stream"]);
    expect(claude.calls).toEqual(["stream"]);
  });

  it("lets a request-level config override the role default (Project override path)", async () => {
    const codex = fakeGateway("codex-app-server");
    const deepseek = fakeGateway("deepseek");
    const gateway = router({
      explorer: "codex-app-server",
      executor: "codex-app-server",
      gateways: [codex, deepseek],
      ids: ["codex-app-server", "deepseek"],
    });

    // 这正是 Project 覆盖的形态：executor 角色默认 codex，但项目把 backend 覆盖成 deepseek。
    await drain(
      gateway.stream({
        role: "executor",
        modelConfig: { model: "deepseek-chat", backend: "deepseek" },
        messages: [{ role: "user", content: "execute" }],
      }),
    );

    expect(codex.calls).toEqual([]);
    expect(deepseek.calls).toEqual(["stream"]);
  });

  it("answers structured input through the backend that asked", async () => {
    const codex = fakeGateway("codex-app-server", { inputRequestId: "req-1" });
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    await drain(gateway.stream({ role: "explorer", conversationId: "conv-1", messages: [{ role: "user", content: "x" }] }));
    await gateway.answerUserInput({ requestId: "req-1", answers: { q: { answers: ["a"] } } });

    expect(codex.answered).toEqual(["req-1"]);
    expect(claude.answered).toEqual([]);
  });

  it("refuses to answer an input request it never saw instead of silently dropping it", async () => {
    const codex = fakeGateway("codex-app-server");
    const gateway = router({ explorer: "codex-app-server", executor: "codex-app-server", gateways: [codex] });

    // 静默成功会让模型一直等输入，用户只看到"卡住"——所以这里必须是抛错。
    await expect(gateway.answerUserInput({ requestId: "unknown", answers: {} })).rejects.toThrow(
      /No model backend is known for input request unknown/,
    );
  });

  it("broadcasts an unrouted cancel to every instantiated backend", async () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    // 先让两个后端都被实例化，再取消一个没人认领的 conversation。
    await drain(gateway.stream({ role: "explorer", conversationId: "conv-explorer", messages: [{ role: "user", content: "x" }] }));
    await drain(gateway.stream({ role: "executor", conversationId: "conv-executor", messages: [{ role: "user", content: "x" }] }));
    await gateway.cancel({ conversationId: "conv-unknown", providerThreadId: "thread" });

    // 漏掉一次取消会留下还在跑的 Provider turn，所以宁可广播（各后端会忽略不认识的对象）。
    expect(codex.cancelled).toEqual(["conv-unknown"]);
    expect(claude.cancelled).toEqual(["conv-unknown"]);
  });

  it("routes a cancel to the owning backend once the conversation is known", async () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    await drain(gateway.stream({ role: "executor", conversationId: "conv-1", messages: [{ role: "user", content: "x" }] }));
    await gateway.cancel({ conversationId: "conv-1", providerThreadId: "thread" });

    expect(claude.cancelled).toEqual(["conv-1"]);
    expect(codex.cancelled).toEqual([]);
  });

  it("reports the effective backend and stays honest about a mixed process", async () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    expect(gateway.configFor("executor")).toMatchObject({ model: "claude-agent-sdk-model", backend: "claude-agent-sdk" });
    expect(gateway.describeEndpoint("explorer")).toMatchObject({ backend: "codex-app-server" });
    expect(gateway.describeEndpoint("executor")).toMatchObject({ backend: "claude-agent-sdk" });
    // 不传角色且两个角色指向不同后端：如实回答"混合"，而不是假装成某一个。
    expect(gateway.describeEndpoint()).toMatchObject({ backend: "mixed", endpoint: null });
  });

  /**
   * 与下面 `capabilities` 那条同源，也是同一个坑的第二次出现（它一直在传 config，describeEndpoint
   * 却只吃角色名）。Project 快照可以覆盖执行侧后端，而这份端点指纹会被写进 telemetry、最终显示在
   * 用量栏的 Agent 那一格——只吃角色名的话，覆盖了后端的项目会被记成**全局**角色默认的那个后端。
   * 现场：冻结配置与当前项目都写 claude-agent-sdk，Agent 那格却显示 Codex App Server，而模型那格
   * 显示 claude-opus-5（模型取自 effectiveModelConfig，覆盖当时就已经生效，所以它是对的）。
   */
  it("takes the endpoint fingerprint from the backend the Project will actually use", () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({
      explorer: "codex-app-server",
      executor: "codex-app-server",
      gateways: [codex, claude],
      ids: ["codex-app-server", "claude-agent-sdk"],
    });

    // 全局执行侧是 codex；这一份请求把它覆盖成 claude。
    expect(gateway.describeEndpoint("executor")).toMatchObject({ backend: "codex-app-server" });
    expect(gateway.describeEndpoint("executor", { model: "claude-opus-5", backend: "claude-agent-sdk" })).toMatchObject({
      backend: "claude-agent-sdk",
    });
    // 覆盖里没写 backend（"跟随全局"）时退回角色默认，不编一个。
    expect(gateway.describeEndpoint("executor", { model: "claude-opus-5" })).toMatchObject({ backend: "codex-app-server" });
    // 不传角色时那份覆盖配置**无从归属**（不知道它是给哪个角色的），一律按角色默认回答：
    // 这里两个角色都是 codex，所以答案是 codex，而不是被传进来的 claude 覆盖带跑。
    expect(gateway.describeEndpoint(undefined, { model: "claude-opus-5", backend: "claude-agent-sdk" })).toMatchObject({
      backend: "codex-app-server",
    });
  });

  it("takes capabilities from the backend the Project will actually use", () => {
    const codex = fakeGateway("codex-app-server", {
      capabilities: { supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] },
    });
    const deepseek = fakeGateway("deepseek", {
      capabilities: { supportsStructuredUserInput: true, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] },
    });
    const gateway = router({
      explorer: "codex-app-server",
      executor: "codex-app-server",
      gateways: [codex, deepseek],
      ids: ["codex-app-server", "deepseek"],
    });

    expect(gateway.capabilities("executor", { model: "x", backend: "deepseek" })).toMatchObject({
      supportedLoopModes: ["provider-controlled"],
    });
    expect(gateway.capabilities("executor")).toMatchObject({ supportedLoopModes: ["provider-controlled"] });
  });

  it("constructs a backend only when it is actually used, and releases every one it built", async () => {
    const codex = fakeGateway("codex-app-server");
    const claude = fakeGateway("claude-agent-sdk");
    const gateway = router({ explorer: "codex-app-server", executor: "claude-agent-sdk", gateways: [codex, claude] });

    expect(gateway.instantiatedBackends()).toEqual([]);
    await drain(gateway.stream({ role: "explorer", messages: [{ role: "user", content: "x" }] }));
    expect(gateway.instantiatedBackends()).toEqual(["codex-app-server"]);

    await gateway.close();
    expect(codex.closed).toEqual(["closed"]);
    // 从未用到的后端不需要释放，也不该被构造。
    expect(claude.closed).toEqual([]);
  });
});

/** 造一个临时配置文件并加载；用完即删（与 config.test.ts 的 fixture 策略一致）。 */
function loadTempConfig(raw: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-factory-gateway-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  try {
    return loadFactoryConfig(configPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("createModelGateway", () => {
  it("fails at construction when a role's backend is missing its required config block", () => {
    // 与引入多后端之前同一条立场：缺 codexAppServer 块要**起不来**。
    // 懒构造单独用会把这条错误推迟到第一次 /health 或第一个回合 —— 那正是这次要避免的回归。
    const config = loadTempConfig({ model: { backend: "codex-app-server" } });

    expect(() => createModelGateway(config)).toThrow(/model\.codexAppServer/);
  });

  it("keeps an unreferenced registry backend lazy so it cannot block startup", () => {
    // openai-responses 缺 apiKey，但没有任何角色指向它：允许起服务，只在真被用到时才失败。
    const config = loadTempConfig({
      model: {
        backend: "stub",
        backends: { "broken-openai": { kind: "openai-responses" } },
        roles: { explorer: { model: "stub-explorer" }, executor: { model: "stub-executor" } },
      },
    });

    const gateway = createModelGateway(config) as RoutingModelGateway;
    expect(gateway.instantiatedBackends()).toEqual(["stub"]);
    expect(() => gateway.configFor("executor")).not.toThrow();
  });

  it("reports the two roles' agents through configFor and the endpoint fingerprint", () => {
    const config = loadTempConfig({
      model: {
        backend: "codex-app-server",
        codexAppServer: { command: "codex", args: ["app-server", "--stdio"] },
        backends: { deepseek: { kind: "claude-agent-sdk", baseUrl: "https://api.deepseek.com/anthropic" } },
        roles: { explorer: { model: "gpt-5.6-sol" }, executor: { model: "deepseek-chat", backend: "deepseek" } },
      },
    });

    const gateway = createModelGateway(config);

    expect(gateway.configFor("explorer")).toMatchObject({ model: "gpt-5.6-sol", backend: "codex-app-server" });
    expect(gateway.configFor("executor")).toMatchObject({ model: "deepseek-chat", backend: "deepseek" });
    // 角色分派之后，端点指纹按角色各自回答；不传角色且两者不同 → 如实说"混合"。
    expect(gateway.describeEndpoint?.("explorer")).toMatchObject({ backend: "codex-app-server" });
    expect(gateway.describeEndpoint?.("executor")).toMatchObject({ backend: "claude-agent-sdk", endpoint: "api.deepseek.com" });
    expect(gateway.describeEndpoint?.()).toMatchObject({ backend: "mixed", endpoint: null });
  });
});
