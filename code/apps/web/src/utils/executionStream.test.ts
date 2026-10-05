/**
 * 测试职责：验证 executionStream 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { EXECUTION_DISPLAY_MODES, EXECUTION_ROW_KINDS, executionDisplayMode, projectExecutionJournal, type ExecutionPlanSnapshot } from "./executionStream";

describe("projectExecutionJournal", () => {
  const plan: ExecutionPlanSnapshot = {
    planId: "plan-1",
    revision: 2,
    occurredAt: "2026-08-30T06:59:59.000Z",
    goal: "完成中文介绍文档",
    acceptanceCriteria: ["正文完整"],
    includePaths: ["docs/guide.md"],
    excludePaths: ["src/protected.ts"],
    tasks: [{ id: "task-1", title: "创建文档", status: "READY", dependencies: [] }],
    verificationCommandIds: ["markdown-check"],
  };

  it("prepends the frozen Plan snapshot without changing journal order", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-08-30T07:00:00.000Z", payload: { planId: "plan-1", revision: 2 } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "开始执行" } },
      { sequence: 3, type: "USER_GUIDANCE", occurredAt: "2026-08-30T07:00:02.000Z", payload: { content: "保持范围不变" } },
    ], "COMPLETED", plan);

    expect(items[0]).toMatchObject({ kind: "plan", title: "已收到方案", sequence: 0, plan });
    expect(items.slice(1).map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(items[1]).toMatchObject({ kind: "activity", title: "Run 已创建" });
    expect(items[3]).toMatchObject({ kind: "user", content: "保持范围不变" });
  });

  it("merges model deltas and keeps user guidance and execution activity readable", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-08-30T07:00:00.000Z", payload: { planId: "plan-1", revision: 1 } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "正在读取" } },
      { sequence: 3, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.100Z", payload: { text: "计划" } },
      { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { event: "agent.model.completed", step: 1 } },
      { sequence: 5, type: "TOOL_CALL", occurredAt: "2026-08-30T07:00:03.000Z", payload: { action: "requested", tool: "read_file", callId: "call-1" } },
      { sequence: 6, type: "USER_GUIDANCE", occurredAt: "2026-08-30T07:00:04.000Z", payload: { content: "只修改批准范围内的文件" } },
      { sequence: 7, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:05.000Z", payload: { state: "BLOCKED", reason: "MAX_DURATION_EXCEEDED" } },
    ], "BLOCKED");

    expect(items).toHaveLength(6);
    expect(items[1]).toMatchObject({ kind: "model", role: "assistant", content: "正在读取计划", status: "COMPLETED" });
    expect(items[2]).toMatchObject({ kind: "activity", status: "COMPLETED", title: "模型轮次 · #1" });
    expect(items[3]).toMatchObject({ kind: "tool", status: "UNKNOWN", title: "工具调用", callId: "call-1" });
    expect(items[4]).toMatchObject({ kind: "user", role: "user", content: "只修改批准范围内的文件" });
    expect(items[5]).toMatchObject({ kind: "activity", status: "FAILED", title: "Run 已阻塞", detail: "MAX_DURATION_EXCEEDED" });
  });

  it("marks a trailing model message as running while the execution thread is active", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "仍在处理" } },
    ], "ACTIVE");

    expect(items).toEqual([expect.objectContaining({ kind: "model", content: "仍在处理", status: "RUNNING" })]);
  });

  it("turns the execution report protocol into a readable assistant message", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1", "task-2"], changedPaths: ["docs/guide.md"], report: "已完成内容与格式复核" })}</pipeline-factory-execution-report>` } },
      { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:01.000Z", payload: { action: "task-status", completedTaskIds: ["task-1", "task-2"] } },
    ], "BLOCKED");

    expect(items[0]).toMatchObject({ kind: "model", title: "执行报告", content: "已完成内容与格式复核\n\n已完成 2 个任务 · 改动 1 个文件" });
    expect(items.some((item) => item.detail.includes("<pipeline-factory-execution-report>"))).toBe(false);
  });

  it("shows model turns and context compaction while hiding empty continuation events", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:00.000Z", payload: { event: "agent.step.started", step: 1 } },
      { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:01.000Z", payload: { event: "agent.model.completed", step: 1 } },
      { sequence: 3, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { event: "agent.context.compacted", messageCount: 4 } },
      { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:03.000Z", payload: { event: "continue" } },
    ], "ACTIVE");

    expect(items).toEqual([
      expect.objectContaining({ title: "模型轮次 · #1", status: "COMPLETED", modelStep: 1 }),
      expect.objectContaining({ title: "上下文已压缩", status: "INFO" }),
    ]);
  });

  it("folds repeated reports with unchanged task progress into one card", () => {
    const report = (text: string, sequence: number) => ({ sequence, type: "MODEL_OUTPUT", occurredAt: `2026-08-30T07:00:0${sequence}.000Z`, payload: { text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1"], changedPaths: [], report: text })}</pipeline-factory-execution-report>` } });
    const items = projectExecutionJournal([report("第一轮完成", 1), { sequence: 2, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.000Z", payload: { action: "task-status", completedTaskIds: ["task-1"] } }, { sequence: 2.5, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:02.500Z", payload: { event: "agent.model.completed", step: 1 } }, report("没有新的可执行内容", 3), { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:04.000Z", payload: { action: "task-status", completedTaskIds: ["task-1"] } }], "BLOCKED");

    expect(items.filter((item) => item.title === "执行报告")).toHaveLength(1);
    expect(items.find((item) => item.title === "执行报告")?.repetitionCount).toBe(2);
  });

  it("does not leak an incomplete report protocol into the conversation", () => {
    const items = projectExecutionJournal([{ sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "<pipeline-factory-execution-report>{\"completedTaskIds\":[\"task-1\"]" } }], "ACTIVE");

    expect(items[0]).toMatchObject({ title: "执行报告", content: "执行报告仍在生成中。" });
  });

  it("动作类消息说清「做的是什么」：标题用 Provider 给的 summary", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "succeeded", summary: "npm install --ignore-scripts" } },
    ]);

    // 没有 summary 时卡片只能写「命令 · 已完成 · Provider reported success」——等于没说。
    expect(items[0]).toMatchObject({ title: "命令 · npm install --ignore-scripts", detail: "执行成功", messageType: "COMMAND" });
  });

  it("老事件没有 summary 时退回类别标签，不编造内容", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", providerStatus: "completed" } },
    ]);

    expect(items[0]).toMatchObject({ title: "命令", detail: "执行成功", messageType: "COMMAND" });
  });

  it("标题里的命令截断到可读长度，不把整行长命令铺出来", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "started", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "running", summary: `npm run ${"x".repeat(200)}` } },
    ]);

    expect(items[0]?.title.length).toBeLessThanOrEqual("命令 · ".length + 80);
    expect(items[0]?.title).toContain("…");
  });
});

describe("消息清单的呈现方式", () => {
  it("条目的形态只有五种，模板按形态选行组件", () => {
    // 18 个消息类型映射到这 5 种形态；`tool` 一条就承担命令 / 文件变更 / 工具调用 / MCP 调用四类。
    // 新增一种形态却没登记到 `EXECUTION_ROW_KINDS` 时，那边有编译期护栏会先红。
    expect(EXECUTION_ROW_KINDS).toEqual(["plan", "model", "user", "activity", "tool"]);
  });

  it("**呈现方式表是唯一落点**：卡片 / 一行 / 折叠 / 不显示，一眼看全", () => {
    expect(EXECUTION_DISPLAY_MODES.ASSISTANT_MESSAGE).toBe("prose");
    expect(EXECUTION_DISPLAY_MODES.MODEL_REPORT).toBe("prose");
    expect(EXECUTION_DISPLAY_MODES.PLAN).toBe("card");
    expect(EXECUTION_DISPLAY_MODES.COMMAND).toBe("line");
    expect(EXECUTION_DISPLAY_MODES.FILE_CHANGE).toBe("line");
    expect(EXECUTION_DISPLAY_MODES.TOOL_CALL).toBe("line");
    expect(EXECUTION_DISPLAY_MODES.MCP_CALL).toBe("line");
    expect(EXECUTION_DISPLAY_MODES.TASK_LIFECYCLE).toBe("line");
    expect(EXECUTION_DISPLAY_MODES.REASONING).toBe("folded");
    expect(EXECUTION_DISPLAY_MODES.GATE).toBe("folded");
    expect(EXECUTION_DISPLAY_MODES.PROVIDER_MESSAGE).toBe("hidden");
    expect(EXECUTION_DISPLAY_MODES.SESSION).toBe("hidden");
  });

  it("**异常类消息永远是卡片**：呈现方式怎么调，阻塞与恢复都不能被藏起来", () => {
    expect(EXECUTION_DISPLAY_MODES.RECOVERY).toBe("card");
    expect(EXECUTION_DISPLAY_MODES.USER_MESSAGE).toBe("text");

    const items = projectExecutionJournal([
      { sequence: 1, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:00.000Z", payload: { state: "BLOCKED", reason: "MAX_DURATION_EXCEEDED" } },
    ]);
    expect(items[0]).toMatchObject({ messageType: "RECOVERY", status: "FAILED" });
    expect(executionDisplayMode(items[0]!)).toBe("card");
  });

  it("**跨事件被切断的任务标记不会漏进正文**（回归：正文第一行曾是 `-progress>{...}`）", () => {
    const items = projectExecutionJournal([
      // 两条事件的 providerItemId 不同 → 投影成两张卡片，标记正好被切在中间。
      // 上一条的尾巴被"结尾未闭合"的规则削掉了，剩下的一半本会原样铺在下一条的正文里。
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "开始执行 <pipeline-factory-task", providerItemId: "item-a" } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: '-progress>{"taskId":"task-1","state":"started"}</pipeline-factory-task-progress>已完成第一步。', providerItemId: "item-b" } },
    ]);

    const bodies = items.filter((item) => item.kind === "model").map((item) => item.content).join("\n");
    expect(bodies).not.toContain("progress>");
    expect(bodies).not.toContain("taskId");
    expect(bodies).toContain("已完成第一步。");
  });

  it("**标记尾巴后面直接接正文时也只削尾巴**（实测形态：`factory-task-progress>` 后就是「开始执行…」）", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "开始执行 <pipeline-factory-task", providerItemId: "item-a" } },
      { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "actory-task-progress>\n开始执行 task-1：核对现有路由与校验链路。", providerItemId: "item-b" } },
    ]);

    const bodies = items.filter((item) => item.kind === "model").map((item) => item.content).join("\n");
    expect(bodies).not.toContain("progress>");
    expect(bodies).toContain("开始执行 task-1：核对现有路由与校验链路。");
  });

  it("普通正文不会被标记清理误伤", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "读取 src/App.vue 并在 100ms 内完成——这行没有标记。" } },
    ]);

    expect(items[0]?.content).toBe("读取 src/App.vue 并在 100ms 内完成——这行没有标记。");
  });

  it("失败原因翻成人话，但认不出来就原样显示（不猜意思）", () => {
    const exitCode = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "completed", itemId: "exec-1", providerItemId: "exec-1", itemType: "commandExecution", activityKind: "command", outcome: "failed", providerStatus: "failed", reason: "Provider command exited with code 1" } },
    ]);
    const unknown = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "completed", itemId: "exec-2", providerItemId: "exec-2", itemType: "commandExecution", activityKind: "command", outcome: "failed", providerStatus: "failed", reason: "workspace is not writable" } },
    ]);

    expect(exitCode[0]?.detail).toBe("命令退出码 1");
    expect(unknown[0]?.detail).toBe("workspace is not writable");
  });

  it("正文被清空时不产生空卡片（只剩标题与时间的卡片是纯噪音）", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "actory-task-progress>", providerItemId: "item-b" } },
    ]);

    expect(items.filter((item) => item.kind === "model")).toHaveLength(0);
  });

  it("认不出来的活动标成「未识别」，不伪装成已知类别", () => {
    const items = projectExecutionJournal([
      { sequence: 1, type: "PROVIDER_ACTIVITY", occurredAt: "2026-08-30T07:00:00.000Z", payload: { phase: "completed", itemId: "x-1", providerItemId: "x-1", itemType: "somethingBrandNew", activityKind: "other", outcome: "unknown" } },
    ]);

    expect(items[0]).toMatchObject({ messageType: "UNCLASSIFIED" });
    expect(executionDisplayMode(items[0]!)).toBe("folded");
  });
});
