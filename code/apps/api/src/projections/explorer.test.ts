/**
 * 测试职责：锁住"这条探索线程实际用的 agent"的两个来源——**model 是记录**（最近一次探索回合的
 *   loop 启动事件）、**backend 是配置**（项目当前的探索配置）。这两条判据混起来就会让历史行说谎。
 *
 * 设计说明：`explorerThreadAgent` 的入参是 `Pick<PipelineStore, …>`，所以这里给一个极小的假 store
 *   就够了——不必造完整的线程 / 回合 / loop 夹具。
 */
import { describe, expect, it } from "vitest";
import { explorerThreadAgent } from "./explorer.js";

function fakeStore(options: {
  turns?: Array<{ id: string }>;
  loops?: Array<{ id: string; ownerId: string; startedAt: string | null }>;
  model?: string | null;
  backend?: string | null;
}) {
  const turns = options.turns ?? [{ id: "turn-1" }];
  const loops = options.loops ?? [{ id: "loop-1", ownerId: turns[0]?.id ?? "turn-1", startedAt: "2026-10-16T00:00:00.000Z" }];
  return {
    listTurns: () => turns,
    listAgentLoops: () => loops.map((loop) => ({ ...loop, ownerType: "explorer-turn" as const })),
    listEvents: ({ aggregateId, types }: { aggregateId?: string; types?: string[] }) =>
      loops.some((loop) => loop.id === aggregateId) && types?.includes("agent.loop.started") && options.model
        ? [{ type: "agent.loop.started", payload: { role: "explorer", model: options.model } }]
        : [],
    getProject: () => ({ settings: { models: { explorer: { backend: options.backend ?? null } } } }),
  } as never;
}

describe("explorerThreadAgent", () => {
  it("model 取最近一次探索回合的 loop 记录，backend 取项目配置", () => {
    const agent = explorerThreadAgent(fakeStore({ model: "gpt-5.6-luna", backend: "codex-app-server" }), {
      id: "explorer-1",
      projectId: "project-1",
    });

    expect(agent).toEqual({ model: "gpt-5.6-luna", backend: "codex-app-server" });
  });

  it("模型那一半取**最近**一次，不是第一条", () => {
    const store = fakeStore({
      turns: [{ id: "turn-1" }, { id: "turn-2" }],
      loops: [
        { id: "loop-old", ownerId: "turn-1", startedAt: "2026-10-01T00:00:00.000Z" },
        { id: "loop-new", ownerId: "turn-2", startedAt: "2026-10-15T00:00:00.000Z" },
      ],
      model: "gpt-5.6-luna",
      backend: "codex-app-server",
    });

    expect(explorerThreadAgent(store, { id: "explorer-1", projectId: "project-1" })?.model).toBe("gpt-5.6-luna");
  });

  it("没有 loop 记录时 model 是 null，但 backend 照样给（它是配置，不是记录）", () => {
    const agent = explorerThreadAgent(fakeStore({ turns: [], loops: [], backend: "claude-agent-sdk" }), {
      id: "explorer-1",
      projectId: "project-1",
    });

    expect(agent).toEqual({ model: null, backend: "claude-agent-sdk" });
  });

  it("两样都没有就是 null——界面留空，不是编一个值出来", () => {
    const agent = explorerThreadAgent(fakeStore({ turns: [], loops: [], model: null, backend: null }), {
      id: "explorer-1",
      projectId: "project-1",
    });

    expect(agent).toBeNull();
  });
});
