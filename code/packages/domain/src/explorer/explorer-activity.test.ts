/**
 * 测试职责：验证 explorer-activity 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { projectExplorerActivity } from "./explorer-activity.js";
import type { AgentLoop, AgentLoopStep, ExplorerTurn } from "../index.js";

/**
 * 一份**当前形状**的方案。V1 扁平合同已经不再支持，所以"能解析出摘要"的夹具只能长这样：
 * 摘要字段在 `objective.goal` / `scope.includePaths` / `verification.commandIds` 之下。
 */
function planSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    title: "Personal information manager",
    artifact: { mode: "CONVERSATION" },
    objective: { goal: "Build a local single-user personal information manager", audience: ["本地用户"], acceptanceCriteria: ["User can create records", "Data is encrypted at rest"], outOfScope: [] },
    design: { technicalConstraints: [], dataSecurity: [], failureHandling: [] },
    scope: { includePaths: [], excludePaths: ["deploy/*"] },
    tasks: [{ id: "task-1", title: "Implement record management", dependencies: [] }],
    dependencies: [],
    conflicts: [],
    execution: {},
    verification: { mode: "PROJECT_DEFAULT" },
    merge: { strategy: "manual", requireHumanMerge: true },
    ...overrides,
  };
}

/** READY 协议块，正文是上面的方案。 */
function protocol(overrides: Record<string, unknown> = {}): string {
  return `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(planSpec(overrides))}</pipeline-factory-plan>`;
}

/** 一次 Explore 回合的 Loop 与 Turn；这几个用例只关心步骤，其余字段给固定值。 */
function explorerLoop(): AgentLoop {
  return { id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 0, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:05.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null };
}
function assistantTurn(status: ExplorerTurn["status"] = "COMPLETED"): ExplorerTurn {
  return { id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status, createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 };
}
function step(sequence: number, stepType: AgentLoopStep["stepType"], status: AgentLoopStep["status"], payload: Record<string, unknown>, callId: string | null, occurredAt: string): AgentLoopStep {
  return { loopId: "loop-1", sequence, stepType, status, callId, providerThreadId: null, providerTurnId: null, payload, occurredAt };
}
function providerStep(sequence: number, payload: Record<string, unknown>, occurredAt: string): AgentLoopStep {
  return step(sequence, "PROVIDER_ACTIVITY", "COMPLETED", payload, null, occurredAt);
}

describe("Explorer activity projection", () => {
  it("marks a text-bearing assistant activity completed when its turn is completed", () => {
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [{ loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "完成的回复" }, occurredAt: "2026-08-29T10:00:01.000Z" }],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ASSISTANT_MESSAGE", summary: "完成的回复", status: "COMPLETED" });
  });

  it("renders loop steps in chronological order and groups contiguous model deltas", () => {
    const items = projectExplorerActivity({
      turns: [
        { id: "user-1", threadId: "explorer-1", role: "user", content: "hello", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 },
        { id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "Hello", status: "COMPLETED", createdAt: "2026-08-29T10:00:01.000Z", sequence: 2 },
      ],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.500Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "Hel" }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "lo" }, occurredAt: "2026-08-29T10:00:01.100Z" },
        { loopId: "loop-1", sequence: 3, stepType: "TOOL_REQUESTED", status: "RUNNING", callId: "call-1", providerThreadId: null, providerTurnId: null, payload: { tool: "read_file", delegatedToProvider: true }, occurredAt: "2026-08-29T10:00:01.200Z" },
        { loopId: "loop-1", sequence: 4, stepType: "TOOL_COMPLETED", status: "COMPLETED", callId: "call-1", providerThreadId: null, providerTurnId: null, payload: { reason: "ok" }, occurredAt: "2026-08-29T10:00:01.300Z" },
        { loopId: "loop-1", sequence: 5, stepType: "GATE_CHECKED", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { action: "complete", reason: "MODEL_COMPLETED" }, occurredAt: "2026-08-29T10:00:01.400Z" },
      ],
    });

    // 一次工具调用只占一条：TOOL_REQUESTED 与 TOOL_COMPLETED 是同一件事的两端。
    // 门禁判定是 `complete`（一切正常）——不占位，见下面单独的那条用例。
    expect(items.map((item) => item.kind)).toEqual(["USER_MESSAGE", "ASSISTANT_MESSAGE", "TOOL_CALL"]);
    expect(items[1]?.summary).toBe("Hello");
    expect(items[2]).toMatchObject({ title: "read_file", status: "COMPLETED", details: { tool: "read_file", callId: "call-1", reason: "ok" } });
  });

  it("正文的落库粒度变化不改变活动投影的可见产出（写侧按「文本段」合并的等价性）", () => {
    // 这条是 agent-loop 把 MODEL_TEXT_DELTA 从"逐次刷新一条"改成"一个文本段一条"的等价性见证：
    // 同一段正文，旧形态是 3 条步骤、新形态是 1 条，投影出来的对话必须逐字段相同。
    // 该改动的依据就在这里——读取方合并 ASSISTANT_MESSAGE 的边界是"中间夹了别的步骤"，
    // 与写侧封段的边界是同一个，所以切成几条都不改变气泡。
    const turn: ExplorerTurn = { id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "Hello!", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 };
    const loop: AgentLoop = { id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 4, maxSteps: 40, startedAt: "2026-08-29T10:00:00.500Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null };
    const textStep = (sequence: number, text: string, occurredAt: string, providerItemId: string | null): AgentLoopStep => ({ loopId: "loop-1", sequence, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text, ...(providerItemId ? { providerItemId } : {}) }, occurredAt });
    const toolStep = (sequence: number, occurredAt: string): AgentLoopStep => ({ loopId: "loop-1", sequence, stepType: "TOOL_REQUESTED", status: "RUNNING", callId: "call-1", providerThreadId: null, providerTurnId: null, payload: { tool: "read_file", delegatedToProvider: true }, occurredAt });

    const fragmented = [
      textStep(1, "Hel", "2026-08-29T10:00:01.000Z", "item-1"),
      textStep(2, "lo", "2026-08-29T10:00:01.040Z", "item-1"),
      textStep(3, "!", "2026-08-29T10:00:01.080Z", null),
      toolStep(4, "2026-08-29T10:00:01.200Z"),
      textStep(5, "OK", "2026-08-29T10:00:01.400Z", "item-2"),
    ];
    // 合并后的形态：段首时间与段内最后一个非空 providerItemId 一起带走。
    const coalesced = [
      textStep(1, "Hello!", "2026-08-29T10:00:01.000Z", "item-1"),
      toolStep(2, "2026-08-29T10:00:01.200Z"),
      textStep(3, "OK", "2026-08-29T10:00:01.400Z", "item-2"),
    ];

    const visible = (steps: typeof fragmented) => projectExplorerActivity({ turns: [turn], loops: [loop], steps }).map(({ id: _id, ...item }) => item);
    expect(visible(coalesced)).toEqual(visible(fragmented));
    // 合并后仍然：一条正文一个气泡、时间取段首那条增量、内容取整段的拼接。
    expect(visible(coalesced).map((item) => [item.kind, item.title, item.occurredAt])).toEqual([
      ["ASSISTANT_MESSAGE", "Plan Explorer", "2026-08-29T10:00:01.000Z"],
      ["TOOL_CALL", "read_file", "2026-08-29T10:00:01.200Z"],
      ["ASSISTANT_MESSAGE", "Plan Explorer", "2026-08-29T10:00:01.400Z"],
    ]);
  });

  it("does not invent a description when a Provider activity carries no summary", () => {
    // 此前这里会补 "Provider activity started." / "completed."：它把「有没有摘要」这个可判定的事实，
    // 变成了一句要靠字符串识别才能认出的文案，而它本身没有告诉读者任何事。现在交空串。
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 2, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "PROVIDER_ACTIVITY", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { phase: "completed", itemId: "item-1", itemType: "reasoning" }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "PROVIDER_ACTIVITY", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { phase: "completed", itemId: "item-2", itemType: "commandExecution", title: "Command", summary: "pnpm test" }, occurredAt: "2026-08-29T10:00:02.000Z" },
      ],
    });

    const reasoning = items.find((item) => item.kind === "REASONING");
    const command = items.find((item) => item.kind === "COMMAND");
    expect(reasoning?.summary).toBe("");
    // Provider 给了摘要就照摆，只是截到 240 字。
    expect(command?.summary).toBe("pnpm test");
    expect(JSON.stringify(items)).not.toContain("Provider activity");
  });

  it("does not expose raw reasoning or sensitive answer text", () => {
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "WAITING_FOR_INPUT", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "WAITING_FOR_INPUT", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "INPUT_REQUIRED", status: "RUNNING", callId: null, providerThreadId: null, providerTurnId: null, payload: { requestId: "input-1", questions: [{ id: "secret", isSecret: true, question: "API key" }] }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "INPUT_RESOLVED", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { requestId: "input-1", answerCount: 1, answer: "do-not-display" }, occurredAt: "2026-08-29T10:00:02.000Z" },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["INPUT_REQUIRED", "INPUT_RESOLVED"]);
    expect(JSON.stringify(items)).not.toContain("do-not-display");
  });

  it("replaces the machine-readable plan protocol with a readable activity summary", () => {
    // 解析后的方案里 `verification.commandIds` 由 Factory 填；这里给一份带 id 的，好断言条数确实算进去了。
    const rawProtocol = protocol({ verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test"] } });
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [{ loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: rawProtocol }, occurredAt: "2026-08-29T10:00:01.000Z" }],
    });

    expect(items[0]?.summary).toContain("完整执行方案已生成：Personal information manager");
    expect(items[0]?.summary).not.toContain("pipeline-factory-plan");
    expect(items[0]?.summary).not.toContain("acceptanceCriteria");
    expect(items[0]?.details).toMatchObject({ planProtocol: true, status: "READY", title: "Personal information manager", taskCount: 1, verificationCount: 1 });
  });

  it("**当前契约同样渲染为完整方案**（回归：解析器只认 V1 时，每一份方案都显示「校验失败」）", () => {
    // 字段取自一次真实输出（需求5）。顶层没有 goal——这正是旧实现判它非法的原因。
    const artifact = {
      schemaVersion: 2,
      title: "需求5：修复现有项目添加任务时所属项目不合法",
      artifact: { mode: "REPOSITORY_FILE", path: "doc/需求5-任务归属修复方案.md" },
      objective: {
        goal: "修复现有项目详情中新增任务因未传递所属项目 ID 而被服务端判为不合法的问题",
        audience: ["项目使用者"],
        acceptanceCriteria: ["缺少项目 ID 时返回 400 VALIDATION_ERROR", "项目不存在时返回 404 NOT_FOUND"],
        outOfScope: ["不重构任务列表页"],
      },
      design: { technicalConstraints: [], dataSecurity: [], failureHandling: [] },
      scope: { includePaths: ["code/src/App.vue", "code/server/routes/tasks.js", "doc/**"], excludePaths: ["code/data/**", "node_modules/**"] },
      tasks: [{ id: "task-1", title: "新增项目级任务创建接口并迁移任务归属校验", dependencies: [] }],
      dependencies: [],
      conflicts: [],
      execution: {},
      verification: { mode: "PROJECT_DEFAULT" },
      merge: { strategy: "manual", requireHumanMerge: true },
    };
    const rawProtocol = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`;
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 1, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [{ loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: rawProtocol }, occurredAt: "2026-08-29T10:00:01.000Z" }],
    });

    expect(items[0]?.summary).toContain("完整执行方案已生成：需求5：修复现有项目添加任务时所属项目不合法");
    expect(items[0]?.summary).not.toContain("校验失败");
    expect(items[0]?.details).toMatchObject({
      planProtocol: true,
      status: "READY",
      goal: "修复现有项目详情中新增任务因未传递所属项目 ID 而被服务端判为不合法的问题",
      includeCount: 3,
      excludeCount: 2,
      taskCount: 1,
      acceptanceCount: 2,
      // 模型只声明 mode，命令 ID 由 Factory 解析——0 是正确值，不是"没解析出来"。
      verificationCount: 0,
    });
  });

  it("keeps the final plan text provider item ID when one turn has multiple assistant message segments", () => {
    const rawProtocol = protocol({ title: "Provider-bound plan", objective: { goal: "Bind the exact generated message", audience: ["开发者"], acceptanceCriteria: ["绑定到正确的那条消息"], outOfScope: [] } });
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 3, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:03.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "先分析一下。", providerItemId: "item-analysis" }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "TOOL_COMPLETED", status: "COMPLETED", callId: "call-1", providerThreadId: null, providerTurnId: null, payload: {}, occurredAt: "2026-08-29T10:00:02.000Z" },
        { loopId: "loop-1", sequence: 3, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: rawProtocol, providerItemId: "item-plan" }, occurredAt: "2026-08-29T10:00:03.000Z" },
      ],
    });

    const assistantMessages = items.filter((item) => item.kind === "ASSISTANT_MESSAGE");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.details).toMatchObject({ providerItemId: "item-analysis" });
    expect(assistantMessages[1]?.details).toMatchObject({ planProtocol: true, status: "READY", providerItemId: "item-plan" });
  });

  it("renders the latest parseable READY protocol instead of an earlier invalid block", () => {
    const earlier = "<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>{bad json}</pipeline-factory-plan>";
    const later = protocol({ title: "Latest plan", objective: { goal: "Use the latest valid protocol", audience: ["开发者"], acceptanceCriteria: ["取最新那份"], outOfScope: [] } });
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 2, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [{ loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: earlier + later }, occurredAt: "2026-08-29T10:00:01.000Z" }],
    });

    expect(items[0]?.summary).toContain("完整执行方案已生成：Latest plan");
    expect(items[0]?.details).toMatchObject({ title: "Latest plan", goal: "Use the latest valid protocol" });
  });

  /**
   * 下面两条**不是**在描述理想行为，而是在**钉住"产出依赖逐条增量"这个事实**。
   *
   * 背景：这两条路由每次轮询都要把整个 Plan 的所有 Loop 步骤读出来，其中绝大多数是
   *   MODEL_TEXT_DELTA（生产库 159,523 条事件里占三分之一）。看起来"正文在 turn.content 里
   *   已经拼好了，何必逐条读增量"，但下面两条用例正是那个想法不成立的地方——
   *   谁想按"只取最后一条增量"或"改读 turn.content"来优化，先让这两条变绿再说。
   */
  it("starts a new assistant bubble when a non-delta step sits between two delta runs", () => {
    const items = projectExplorerActivity({
      // content 就是两段增量的拼接——即使它完整存在，也分不出"应该是一个气泡还是两个"。
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "第一段第二段", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 3, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "第一段" }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "GATE_CHECKED", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { action: "continue", reason: "MODEL_CONTINUES" }, occurredAt: "2026-08-29T10:00:01.100Z" },
        { loopId: "loop-1", sequence: 3, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "第二段" }, occurredAt: "2026-08-29T10:00:01.200Z" },
      ],
    });

    const assistantMessages = items.filter((item) => item.kind === "ASSISTANT_MESSAGE");
    expect(assistantMessages.map((item) => item.summary)).toEqual(["第一段", "第二段"]);
  });

  it("takes a merged bubble's time from its first delta and providerItemId from its last non-null delta", () => {
    const items = projectExplorerActivity({
      turns: [{ id: "assistant-1", threadId: "explorer-1", role: "assistant", content: "Hello", status: "COMPLETED", createdAt: "2026-08-29T10:00:00.000Z", sequence: 1 }],
      loops: [{ id: "loop-1", ownerType: "explorer-turn", ownerId: "assistant-1", role: "explorer", mode: "provider-controlled", state: "COMPLETED", stepCount: 2, maxSteps: 40, startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:02.000Z", providerThreadId: null, providerTurnId: null, checkpointJson: null }],
      steps: [
        { loopId: "loop-1", sequence: 1, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "Hel", providerItemId: "item-first" }, occurredAt: "2026-08-29T10:00:01.000Z" },
        { loopId: "loop-1", sequence: 2, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", callId: null, providerThreadId: null, providerTurnId: null, payload: { text: "lo", providerItemId: "item-last" }, occurredAt: "2026-08-29T10:00:01.500Z" },
      ],
    });

    // 时间取第一条增量（不是最后一条）——它参与最终按 occurredAt 的排序，所以换成最后一条
    // 会改变这个气泡与其它活动的相对顺序。providerItemId 相反，取最后一条非空的。
    expect(items[0]?.occurredAt).toBe("2026-08-29T10:00:01.000Z");
    expect(items[0]?.details).toMatchObject({ providerItemId: "item-last" });
  });

  /**
   * 下面四条钉住本轮的**呈现判据**，依据是本机运行库的实测（见 docs/消息类型及事件状态机流程图.md §1）：
   * Provider 活动 1,737 行去重后是 873 个真实活动、门禁 90 条里 blocked 0 条、
   * 112 个 userMessage 与 29 个 plan 回声曾被渲染成工具行。
   */
  it("把一次调用的开始与结束合成一条，被拒与失败也落在这一条上", () => {
    const merged = projectExplorerActivity({
      turns: [assistantTurn()],
      loops: [explorerLoop()],
      steps: [
        step(1, "TOOL_REQUESTED", "RUNNING", { tool: "shell" }, "call-9", "2026-08-29T10:00:01.000Z"),
        step(2, "TOOL_DENIED", "DENIED", { reason: "策略不允许写仓库目录以外的文件。" }, "call-9", "2026-08-29T10:00:02.000Z"),
      ],
    });
    expect(merged.map((item) => item.kind)).toEqual(["TOOL_CALL"]);
    // 名字留住开始那一条的，原因覆盖成结束那一条的——两边各只说了一半。
    expect(merged[0]).toMatchObject({ title: "shell", status: "FAILED", details: { reason: "策略不允许写仓库目录以外的文件。" } });

    // TOOL_FAILED / TOOL_NEEDS_RECONCILIATION 此前**连一行都没有**（没有分支，静默掉了）。
    const failed = projectExplorerActivity({
      turns: [assistantTurn()],
      loops: [explorerLoop()],
      steps: [
        step(1, "TOOL_REQUESTED", "RUNNING", { tool: "pnpm" }, "call-8", "2026-08-29T10:00:01.000Z"),
        step(2, "TOOL_FAILED", "FAILED", { reason: "命令退出码 1" }, "call-8", "2026-08-29T10:00:02.000Z"),
      ],
    });
    expect(failed[0]).toMatchObject({ kind: "TOOL_CALL", title: "pnpm", status: "FAILED", details: { reason: "命令退出码 1" } });
  });

  it("回合结束后仍没有结束事件的调用标成状态未知，而不是一直进行中", () => {
    const items = projectExplorerActivity({
      turns: [assistantTurn("COMPLETED")],
      loops: [explorerLoop()],
      steps: [step(1, "TOOL_REQUESTED", "RUNNING", { tool: "pnpm" }, "call-7", "2026-08-29T10:00:01.000Z")],
    });
    expect(items[0]).toMatchObject({ kind: "TOOL_CALL", status: "UNKNOWN", details: { reason: "未记录调用的结束状态。" } });
  });

  it("只在拦下这一步时给门禁成行", () => {
    const steps = (action: string) => [step(1, "GATE_CHECKED", "COMPLETED", { action, reason: action === "blocked" ? "连续两步没有进展" : "MODEL_CONTINUES" }, null, "2026-08-29T10:00:01.000Z")];
    expect(projectExplorerActivity({ turns: [assistantTurn()], loops: [explorerLoop()], steps: steps("continue") })).toEqual([]);
    expect(projectExplorerActivity({ turns: [assistantTurn()], loops: [explorerLoop()], steps: steps("complete") })).toEqual([]);
    expect(projectExplorerActivity({ turns: [assistantTurn()], loops: [explorerLoop()], steps: steps("blocked") })[0]).toMatchObject({ kind: "GATE", status: "FAILED", summary: "连续两步没有进展" });
  });

  it("不把 Provider 的回声渲染成工具行，认不出来的仍然照实显示", () => {
    const items = projectExplorerActivity({
      turns: [assistantTurn()],
      loops: [explorerLoop()],
      steps: [
        providerStep(1, { phase: "completed", itemId: "item-user", itemType: "userMessage" }, "2026-08-29T10:00:01.000Z"),
        providerStep(2, { phase: "completed", itemId: "item-plan", itemType: "plan", summary: "# 整篇规划文档" }, "2026-08-29T10:00:02.000Z"),
        providerStep(3, { phase: "completed", itemId: "item-x", itemType: "somethingNew", summary: "说不上是什么" }, "2026-08-29T10:00:03.000Z"),
        providerStep(4, { phase: "completed", itemId: "item-cmd", itemType: "commandExecution", summary: "pnpm test" }, "2026-08-29T10:00:04.000Z"),
      ],
    });
    // 你那句话的回声归 PROVIDER_MESSAGE（呈现层把它标成 hidden，不占位），整篇规划的回声直接不产出
    // ——它们在时间线上已经有对应的东西（用户消息本身、那条助手正文）。
    expect(items.map((item) => item.kind)).toEqual(["PROVIDER_MESSAGE", "UNCLASSIFIED", "COMMAND"]);
    // 认不出来就说认不出来：标签摆 Provider 的原生 itemType，不编一个像样的类别名。
    expect(items[1]).toMatchObject({ details: { itemType: "somethingNew" }, summary: "说不上是什么" });
    expect(items[2]).toMatchObject({ title: "", summary: "pnpm test", status: "COMPLETED" });
  });
});
