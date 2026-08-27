import { describe, expect, it } from "vitest";
import { ExplorerThreadService, InMemoryPipelineStore, StubModelGateway, type ModelGateway } from "./index.js";

describe("ExplorerThread", () => {
  it("persists user and assistant turns while keeping one logical thread", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const service = new ExplorerThreadService(store, new StubModelGateway({ explorer: { model: "explorer" }, executor: { model: "executor" } }));
    const turn = await service.send("thread-1", "Help me refine the plan");

    expect(turn.assistant.content).toBe("Stub Explorer response");
    expect(store.listTurns("thread-1").map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(store.getThread("thread-1")).toMatchObject({ messageCount: 2, state: "ACTIVE" });
  });

  it("persists an explicit failed assistant turn instead of a blank response", async () => {
    const store = new InMemoryPipelineStore();
    store.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    const model: ModelGateway = {
      configFor: () => ({ model: "gpt-5.6-luna" }),
      async *stream() {
        yield { type: "turn.failed", error: "Codex rejected the configured model" };
      },
    };

    const turn = await new ExplorerThreadService(store, model).send("thread-1", "hello");

    expect(turn.assistant).toMatchObject({
      role: "assistant",
      status: "FAILED",
      error: "Codex rejected the configured model",
      content: "模型调用失败：Codex rejected the configured model",
    });
    expect(store.listTurns("thread-1")[1]?.content).not.toBe("");
    expect(store.listEvents().at(-1)).toMatchObject({ type: "explorer.turn.failed" });
  });
});
