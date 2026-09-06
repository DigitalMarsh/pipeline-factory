/**
 * 测试职责：验证 m1-model 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { OpenAIModelGateway, StubModelGateway, type ModelEvent } from "./index.js";

describe("ModelGateway", () => {
  it("keeps Explorer and Executor model roles separate and streams turn events", async () => {
    const gateway = new StubModelGateway({
      explorer: { model: "explorer-model", temperature: 0.1 },
      executor: { model: "executor-model", temperature: 0 },
    });
    const events: ModelEvent[] = [];
    for await (const event of gateway.stream({ role: "explorer", messages: [{ role: "user", content: "inspect" }] })) events.push(event);

    expect(gateway.configFor("explorer").model).toBe("explorer-model");
    expect(gateway.configFor("executor").model).toBe("executor-model");
    expect(gateway.capabilities("explorer")).toMatchObject({
      supportsStructuredUserInput: false,
      supportsToolCalls: false,
      supportedLoopModes: ["provider-controlled"],
    });
    expect(events).toEqual(expect.arrayContaining([{ type: "text.delta", text: "Stub Explorer response" }, { type: "turn.completed" }]));
  });

  it("honors cancellation before starting a model turn", async () => {
    const gateway = new StubModelGateway({ explorer: { model: "explorer-model" }, executor: { model: "executor-model" } });
    const controller = new AbortController();
    controller.abort();
    const events: ModelEvent[] = [];
    for await (const event of gateway.stream({ role: "executor", messages: [], signal: controller.signal })) events.push(event);
    expect(events).toEqual([{ type: "turn.cancelled" }]);
  });

  it("uses the configured role model when calling the OpenAI Responses API", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const gateway = new OpenAIModelGateway({
      apiKey: "test-key",
      roles: { explorer: { model: "gpt-explorer" }, executor: { model: "gpt-executor" } },
      fetchFn: async (_url, init) => {
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ id: "resp-1", output_text: "model response" }) };
      },
    });

    await expect(gateway.complete({ role: "executor", messages: [{ role: "user", content: "execute" }] })).resolves.toMatchObject({ text: "model response", requestId: "resp-1" });
    expect(requestBody).toMatchObject({ model: "gpt-executor", stream: false });
  });

  it("maps exact OpenAI Responses usage without estimating from text", async () => {
    const gateway = new OpenAIModelGateway({
      apiKey: "test-key",
      roles: { explorer: { model: "gpt-explorer" }, executor: { model: "gpt-executor" } },
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ id: "resp-usage", output_text: "long enough to never be used as an estimate", usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165, output_tokens_details: { reasoning_tokens: 17 } } }) }),
    });

    await expect(gateway.complete({ role: "executor", messages: [{ role: "user", content: "execute" }] })).resolves.toMatchObject({ usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 17, totalTokens: 165 } });
  });

  it("reports provider-controlled capability boundaries", () => {
    const gateway = new OpenAIModelGateway({ apiKey: "test-key", roles: { explorer: { model: "gpt-explorer" }, executor: { model: "gpt-executor" } } });
    expect(gateway.capabilities("executor")).toEqual({ supportsStructuredUserInput: false, supportsToolCalls: false, supportedLoopModes: ["provider-controlled"] });
  });
});
