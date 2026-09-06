/**
 * 测试职责：验证 explorer-title 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import {
  ExplorerService,
  ExplorerThreadService,
  InMemoryPipelineStore,
  ProjectService,
  type ExplorerTitleGenerator,
  type ModelEvent,
  type ModelGateway,
  type ModelRequest,
} from "./index.js";
import { composeExplorerTitle, normalizeExplorerTitle, placeholderExplorerTitle } from "./explorer-title.js";

function model(): ModelGateway {
  return {
    configFor: () => ({ model: "test-model" }),
    async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
      yield { type: "text.delta", text: "Stub response" };
      yield { type: "turn.completed" };
    },
    async answerUserInput() { return undefined; },
    async cancel() { return undefined; },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

function createProject(store: InMemoryPipelineStore, id: string, shortName: string): void {
  new ProjectService(store).create({
    id,
    name: `Project ${id}`,
    shortName,
    repoRoot: `/workspace/${id}`,
    defaultBranch: "main",
    worktreeRoot: `/workspace/${id}/.worktrees`,
  });
}

describe("Explorer title rules", () => {
  it("formats the creation timestamp and model title into the visible name", () => {
    const createdAt = "2026-08-29T05:45:15.000Z";

    expect(placeholderExplorerTitle(createdAt)).toBe("探索-20260829-13:45:15");
    expect(placeholderExplorerTitle(createdAt, "P1")).toBe("P1-20260829-13:45:15");
    expect(composeExplorerTitle(createdAt, "订单取消流程优化")).toBe("20260829-13:45:15-订单取消流程优化");
  });

  it("uses each new Explorer project's short name for its placeholder", () => {
    const store = new InMemoryPipelineStore();
    createProject(store, "project-1", "P1");
    createProject(store, "project-2", "P2");

    const first = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-09-05T01:19:20.000Z" });
    const second = new ExplorerService(store).create({ projectId: "project-2", createdAt: "2026-09-05T01:19:20.000Z" });

    expect(first.title).toBe("P1-20260905-09:19:20");
    expect(second.title).toBe("P2-20260905-09:19:20");
  });

  it("normalizes a model response into a short single-line title", () => {
    expect(normalizeExplorerTitle("```text\n\"订单取消流程优化。\"\n```"))
      .toBe("订单取消流程优化");
    expect(normalizeExplorerTitle("**“订单取消流程优化”**。"))
      .toBe("订单取消流程优化");
    expect(normalizeExplorerTitle("   ")).toBeNull();
  });

  it("generates a title after the first user message and persists it once", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-08-29T05:45:15.000Z" });
    let calls = 0;
    const titleGenerator: ExplorerTitleGenerator = { generate: async () => { calls += 1; return "订单取消流程优化"; } };
    const service = new ExplorerThreadService(store, model(), { titleGenerator });
    const events: string[] = [];
    service.subscribeEvents(explorer.id, (event) => events.push(event.type));

    await service.startTurn({ threadId: explorer.id, content: "请优化订单取消流程", clientTurnId: "turn-1" });
    await waitFor(() => store.getThread(explorer.id)?.titleStatus === "GENERATED");
    expect(store.getThread(explorer.id)).toMatchObject({ title: "20260829-13:45:15-订单取消流程优化", titleSource: "AUTO" });
    expect(events).toContain("explorer.title.updated");

    await service.backfillTitles();
    expect(calls).toBe(1);
  });

  it("keeps the placeholder when title generation fails without failing exploration", async () => {
    const store = new InMemoryPipelineStore();
    createProject(store, "project-1", "P1");
    const explorer = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-08-29T05:45:15.000Z" });
    const titleGenerator: ExplorerTitleGenerator = { generate: async () => { throw new Error("title unavailable"); } };
    const service = new ExplorerThreadService(store, model(), { titleGenerator });

    await service.startTurn({ threadId: explorer.id, content: "请分析登录问题", clientTurnId: "turn-1" });
    await waitFor(() => store.getThread(explorer.id)?.titleStatus === "FAILED");
    expect(store.getThread(explorer.id)).toMatchObject({ title: "P1-20260829-13:45:15", titleSource: "AUTO" });
  });

  it("does not overwrite a manual rename while model generation is pending", async () => {
    const store = new InMemoryPipelineStore();
    const explorer = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-08-29T05:45:15.000Z" });
    let resolveTitle!: (title: string) => void;
    const titleGenerator: ExplorerTitleGenerator = { generate: () => new Promise((resolve) => { resolveTitle = resolve; }) };
    const service = new ExplorerThreadService(store, model(), { titleGenerator });

    await service.startTurn({ threadId: explorer.id, content: "请优化订单流程", clientTurnId: "turn-1" });
    await waitFor(() => store.getThread(explorer.id)?.titleStatus === "GENERATING");
    new ExplorerService(store).rename(explorer.id, "我手动命名的探索");
    resolveTitle("订单流程优化");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.getThread(explorer.id)).toMatchObject({ title: "我手动命名的探索", titleSource: "MANUAL" });
  });

  it("backfills default historical titles while preserving custom titles", async () => {
    const store = new InMemoryPipelineStore();
    const oldDefault = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-08-28T05:45:15.000Z" });
    store.saveTurn({ id: "old-user", threadId: oldDefault.id, role: "user", content: "请增加个人信息管理", status: "COMPLETED", createdAt: "2026-08-28T05:46:00.000Z", sequence: 1 });
    const empty = new ExplorerService(store).create({ projectId: "project-1", createdAt: "2026-08-28T05:47:15.000Z" });
    createProject(store, "project-1", "P1");
    const custom = new ExplorerService(store).create({ projectId: "project-1", title: "我保留的名称", createdAt: "2026-08-28T05:48:15.000Z" });
    store.saveTurn({ id: "custom-user", threadId: custom.id, role: "user", content: "不应覆盖", status: "COMPLETED", createdAt: "2026-08-28T05:49:00.000Z", sequence: 1 });
    const titleGenerator: ExplorerTitleGenerator = { generate: async ({ content }) => content === "请增加个人信息管理" ? "个人信息管理" : "不应被使用" };
    const service = new ExplorerThreadService(store, model(), { titleGenerator });

    await service.backfillTitles();
    await waitFor(() => store.getThread(oldDefault.id)?.titleStatus === "GENERATED");

    expect(store.getThread(oldDefault.id)?.title).toBe("20260828-13:45:15-个人信息管理");
    expect(store.getThread(empty.id)).toMatchObject({ title: "探索-20260828-13:47:15", titleStatus: "PLACEHOLDER" });
    expect(store.getThread(custom.id)).toMatchObject({ title: "我保留的名称", titleSource: "MANUAL" });
  });
});
