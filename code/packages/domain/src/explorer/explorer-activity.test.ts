/**
 * 测试职责：验证 explorer-activity 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { projectExplorerActivity } from "./explorer-activity.js";

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

    expect(items.map((item) => item.kind)).toEqual(["USER_MESSAGE", "ASSISTANT_MESSAGE", "TOOL_STARTED", "TOOL_COMPLETED", "GATE_CHECKED"]);
    expect(items[1]?.summary).toBe("Hello");
    expect(items[2]).toMatchObject({ title: "Tool running", details: { tool: "read_file", callId: "call-1" } });
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

    const reasoning = items.find((item) => item.kind === "REASONING_SUMMARY");
    const command = items.find((item) => item.kind === "TOOL_COMPLETED");
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
    const artifact = {
      title: "Personal information manager",
      goal: "Build a local single-user personal information manager",
      acceptanceCriteria: ["User can create records", "Data is encrypted at rest"],
      include: ["apps/web", "apps/api"],
      exclude: ["deploy/*"],
      tasks: [{ id: "task-1", title: "Implement record management", dependencies: [], status: "READY" }],
      verificationCommandIds: ["project.test"],
    };
    const rawProtocol = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`;
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
    const artifact = { title: "Provider-bound plan", goal: "Bind the exact generated message" };
    const rawProtocol = `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`;
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
    const later = "<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>" + JSON.stringify({ title: "Latest plan", goal: "Use the latest valid protocol" }) + "</pipeline-factory-plan>";
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
});
