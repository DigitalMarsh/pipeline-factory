/**
 * 测试职责：以真实 HTTP（监听 127.0.0.1:0）验证 SSE 路由在传输层抽出为 http/sse.ts 之后
 *   仍然按原格式推送，并且 CORS 头的继承行为符合预期。
 *
 * 设计说明：**不能用 `app.inject`** —— SSE 处理器 hijack 之后永不 end，inject 的 Promise
 *   永不 resolve（已实测挂起）。所以这里真听端口、用 node:http 读前几帧后断开。
 *   分工：帧格式与心跳/轮询节拍的单元级锁定在 http/sse.test.ts；本文件只验证"路由仍然接得通"
 *   与真实 HTTP 下的响应头，两种形态各覆盖一条 —— 轮询式（runs/events）与订阅式
 *   （explorer-thread/events）。**这两种形态的差别正是 openSseChannel 的 poll 选项与
 *   onClose 订阅清理，所以必须各测一条。**
 *
 * 维护提示：新增 SSE 路由时在下面各形态里补一条；改动 openSseChannel 的选项语义时同步本文件。
 *   另有 `有限读取` 一组：它锁的不是帧格式，而是"这条路由不许做无界事件读取"——
 *   SSE 是轮询式的，缺 limit 的 listEvents 会每 250ms 把整张事件表读一遍。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { ExplorerService, InMemoryPipelineStore, ProjectService, type PipelineStore } from "@pipeline-factory/domain";
import { createApp } from "./server.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

/** 真听端口 + 读帧比纯 inject 慢，放宽到 15s：读帧自身的超时是 1.5s，断言失败要能抢在测试超时之前。 */
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * 记录每次 listEvents 的入参。用子类而不是 Proxy：这里要断言的是"路由传了什么参数"，
 * 子类重写能保持完整类型，Proxy 会让 this 绑定的问题混进来。
 */
class RecordingStore extends InMemoryPipelineStore {
  readonly listEventCalls: Array<Parameters<PipelineStore["listEvents"]>[0]> = [];
  override listEvents(options?: Parameters<PipelineStore["listEvents"]>[0]) {
    this.listEventCalls.push(options);
    return super.listEvents(options);
  }
}

async function listen(app: Awaited<ReturnType<typeof createApp>>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo | null;
  if (!address) throw new Error("SSE 测试无法获取监听端口");
  return address.port;
}

type SseResponse = { status: number | undefined; headers: Record<string, string | string[] | undefined>; frames: string[] };

/**
 * 读到 `stream.ready` 帧即断开返回。
 * **默认带 `accept: text/event-stream`**：runs/events 与 agent-loop 路由用 accept 头（或
 * `format=sse`）区分 SSE 与 JSON 两个分支，不带就会拿到 JSON 而永远等不到握手帧 —— 真实的
 * EventSource 也总是带这个头。
 * 超时（1.5s，明显短于 vitest 的 5s 默认超时）则按已收到的内容返回，让断言直接失败而不是挂住。
 */
function readSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: IncomingMessage, buffer: string, timer: NodeJS.Timeout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.destroy();
      resolve({
        status: response.statusCode,
        headers: response.headers,
        frames: buffer.split("\n\n").filter((frame) => frame.trim() !== ""),
      });
    };
    const request = httpGet({ host: "127.0.0.1", port, path, headers: { accept: "text/event-stream", ...headers } }, (response) => {
      let buffer = "";
      response.setEncoding("utf8");
      const timer = setTimeout(() => finish(response, buffer, timer), 1500);
      response.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("event: stream.ready")) finish(response, buffer, timer);
      });
    });
    // 客户端 destroy 会让请求侧发 ECONNRESET；那时结果已经 resolve，吞掉即可。
    request.on("error", () => undefined);
  });
}

async function seedProject(store: InMemoryPipelineStore): Promise<void> {
  await new ProjectService(store).create({
    id: "project-1",
    name: "project-1",
    repoRoot: "/repo/project-1",
    defaultBranch: "main",
    worktreeRoot: "/tmp/project-1-worktrees",
    settings: { commands: [] },
  });
}

describe("SSE 路由（真实 HTTP）", () => {
  it("轮询式：runs/events 先回放 journal 帧，再发 stream.ready", async () => {
    const store = new InMemoryPipelineStore();
    store.saveRun({
      id: "run-sse",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "b",
      workspacePath: "/tmp/ws",
      baseCommit: "abc",
      executionThreadId: "thread-sse",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    store.saveExecutionThread({
      id: "thread-sse",
      runId: "run-sse",
      state: "ACTIVE",
      journal: [{ sequence: 1, type: "RUN_CREATED", occurredAt: store.now(), payload: { planId: "plan-1" } }],
    });
    const app = createApp({ store, seed: false });
    apps.push(app);
    const port = await listen(app);

    const response = await readSse(port, "/api/v4/runs/run-sse/events");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.frames[0]).toMatch(/^id: 1\nevent: journal\.entry\ndata: /);
    const entry = JSON.parse(response.frames[0]!.split("data: ")[1]!) as { sequence: number; type: string; runId: string };
    expect(entry).toMatchObject({ sequence: 1, type: "RUN_CREATED", runId: "run-sse" });
    expect(response.frames.at(-1)).toMatch(/^id: 1\nevent: stream\.ready\ndata: \{"afterSequence":1/);
  });

  it("订阅式：explorer-thread/events 先重放已有事件帧，再发 stream.ready", async () => {
    const store = new InMemoryPipelineStore();
    await seedProject(store);
    const explorer = new ExplorerService(store);
    const thread = explorer.create({ projectId: "project-1" });
    const plan = explorer.createPlan(thread.id);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const port = await listen(app);

    const response = await readSse(
      port,
      `/api/v4/projects/project-1/explorer-thread/events?threadId=${thread.id}&explorerPlanId=${plan.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    // subscribeEvents 会**同步重放** afterSequence 之后的事件，所以握手帧之前有帧是正常的。
    const ready = response.frames.at(-1)!;
    expect(ready).toMatch(/^id: \d+\nevent: stream\.ready\ndata: /);
    expect(JSON.parse(ready.split("data: ")[1]!)).toMatchObject({ explorerPlanId: plan.id });
    // 重放的 explorer.* 事件会被剥掉前缀；本 Plan 的那条必须在握手帧之前到达。
    expect(response.frames.length).toBeGreaterThan(1);
    expect(response.frames[0]).toMatch(/^id: \d+\nevent: plan\.created\ndata: /);
    expect(JSON.parse(response.frames[0]!.split("data: ")[1]!)).toMatchObject({ explorerPlanId: plan.id });
  });

  it("CORS 头继承 @fastify/cors 的判定：带 Origin 时反射该 Origin，不带时回落到 *", async () => {
    const store = new InMemoryPipelineStore();
    store.saveRun({
      id: "run-cors",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "b",
      workspacePath: "/tmp/ws",
      baseCommit: "abc",
      executionThreadId: "thread-cors",
      createdAt: store.now(),
      startedAt: store.now(),
    });
    store.saveExecutionThread({ id: "thread-cors", runId: "run-cors", state: "ACTIVE", journal: [] });
    const app = createApp({ store, seed: false });
    apps.push(app);
    const port = await listen(app);

    const crossOrigin = await readSse(port, "/api/v4/runs/run-cors/events", { origin: "http://localhost:5173" });
    expect(crossOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const sameOrigin = await readSse(port, "/api/v4/runs/run-cors/events");
    expect(sameOrigin.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("SSE 路由的事件读取必须是有界的", () => {
  /**
   * 断言方式说明：这里锁的是"路由传了什么参数"，不是"发了几帧"。
   * 无界读取的症状不是多发帧——Workbench 会把不属于本项目的帧全过滤掉，帧数完全正常，
   * 代价全在服务端（整张事件表读进内存 + 逐条 JSON.parse）。所以只有查入参才抓得住它。
   */
  it("workbench/events 每一次 listEvents 都带 limit，且首次连接取尾部窗口", async () => {
    const store = new RecordingStore();
    await seedProject(store);
    const app = createApp({ store, seed: false });
    apps.push(app);
    const port = await listen(app);

    const response = await readSse(port, "/api/v4/workbench/events?projectId=project-1&format=sse");

    expect(response.status).toBe(200);
    expect(response.frames.at(-1)).toMatch(/^id: \d+\nevent: stream\.ready\ndata: /);
    expect(store.listEventCalls.length).toBeGreaterThan(0);
    for (const call of store.listEventCalls) expect(call?.limit).toEqual(expect.any(Number));
    expect(store.listEventCalls[0]).toMatchObject({ limitFrom: "tail" });
  });

  it("agent-loops/:loopId/events 每一次 listEvents 都带 limit，且首次连接取尾部窗口", async () => {
    const store = new RecordingStore();
    store.saveAgentLoop({
      id: "loop-sse",
      ownerType: "run",
      ownerId: "run-sse",
      role: "executor",
      mode: "provider-controlled",
      state: "RUNNING",
      stepCount: 0,
      maxSteps: 4,
      startedAt: store.now(),
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });
    store.appendEvent({ type: "agent.loop.started", aggregateId: "loop-sse", payload: { role: "executor" } });
    store.appendEvent({ type: "agent.step.gate_checked", aggregateId: "loop-sse", payload: { action: "continue" } });
    const app = createApp({ store, seed: false });
    apps.push(app);
    const port = await listen(app);

    const response = await readSse(port, "/api/v4/agent-loops/loop-sse/events");

    expect(response.status).toBe(200);
    expect(response.frames.at(-1)).toMatch(/^id: \d+\nevent: stream\.ready\ndata: /);
    expect(store.listEventCalls.length).toBeGreaterThan(0);
    for (const call of store.listEventCalls) expect(call?.limit).toEqual(expect.any(Number));
    expect(store.listEventCalls[0]).toMatchObject({ limitFrom: "tail", aggregateId: "loop-sse" });
  });
});
