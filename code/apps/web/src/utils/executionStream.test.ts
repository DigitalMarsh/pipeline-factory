/**
 * 测试职责：验证 executionStream 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import {
  EXECUTION_MESSAGE_WEIGHTS,
  EXECUTION_ROW_KINDS,
  executionMessageWeight,
  executionRowKind,
  foldsIntoProcess,
  projectExecutionJournal,
  type ExecutionPlanSnapshot,
} from "./executionStream";

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
    const items = projectExecutionJournal(
      [
        { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-08-30T07:00:00.000Z", payload: { planId: "plan-1", revision: 2 } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "开始执行" } },
        { sequence: 3, type: "USER_GUIDANCE", occurredAt: "2026-08-30T07:00:02.000Z", payload: { content: "保持范围不变" } },
      ],
      "COMPLETED",
      plan,
    );

    expect(items[0]).toMatchObject({ kind: "plan", title: "已收到方案", sequence: 0, plan });
    expect(items.slice(1).map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(items[1]).toMatchObject({ kind: "activity", title: "Run 已创建" });
    expect(items[3]).toMatchObject({ kind: "user", content: "保持范围不变" });
  });

  it("merges model deltas and keeps user guidance and execution activity readable", () => {
    const items = projectExecutionJournal(
      [
        { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-08-30T07:00:00.000Z", payload: { planId: "plan-1", revision: 1 } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.000Z", payload: { text: "正在读取" } },
        { sequence: 3, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:01.100Z", payload: { text: "计划" } },
        {
          sequence: 4,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:02.000Z",
          payload: { event: "agent.model.completed", step: 1 },
        },
        {
          sequence: 5,
          type: "TOOL_CALL",
          occurredAt: "2026-08-30T07:00:03.000Z",
          payload: { action: "requested", tool: "read_file", callId: "call-1" },
        },
        { sequence: 6, type: "USER_GUIDANCE", occurredAt: "2026-08-30T07:00:04.000Z", payload: { content: "只修改批准范围内的文件" } },
        {
          sequence: 7,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:05.000Z",
          payload: { state: "BLOCKED", reason: "MAX_DURATION_EXCEEDED" },
        },
      ],
      "BLOCKED",
    );

    expect(items).toHaveLength(6);
    expect(items[1]).toMatchObject({ kind: "model", role: "assistant", content: "正在读取计划", status: "COMPLETED" });
    expect(items[2]).toMatchObject({ kind: "activity", status: "COMPLETED", title: "模型轮次 · #1" });
    expect(items[3]).toMatchObject({ kind: "tool", status: "UNKNOWN", title: "工具调用", callId: "call-1" });
    expect(items[4]).toMatchObject({ kind: "user", role: "user", content: "只修改批准范围内的文件" });
    expect(items[5]).toMatchObject({ kind: "activity", status: "FAILED", title: "Run 已阻塞", detail: "MAX_DURATION_EXCEEDED" });
  });

  it("marks a trailing model message as running while the execution thread is active", () => {
    const items = projectExecutionJournal(
      [{ sequence: 1, type: "MODEL_OUTPUT", occurredAt: "2026-08-30T07:00:00.000Z", payload: { text: "仍在处理" } }],
      "ACTIVE",
    );

    expect(items).toEqual([expect.objectContaining({ kind: "model", content: "仍在处理", status: "RUNNING" })]);
  });

  /**
   * 回归：**补充轮不会把上一轮的条目重新标成「进行中」**。
   *
   * `modelStep` 是每个 Loop 各自从 1 数的，补充要求起的那一轮又从第 1 步开始；而"乐观标 RUNNING"
   * 那段只比步号，于是第一轮 `modelStep === 1` 的条目被现标成进行中——用户报的正是这个
   * （投一条补充要求之后，上一轮做完的执行说明与执行报告都变成了「进行中」）。
   */
  it("does not re-mark the previous round as running when a continuation round starts", () => {
    const at = "2026-08-30T07:00:00.000Z";
    const items = projectExecutionJournal(
      [
        { sequence: 1, type: "TASK_PROGRESS", occurredAt: at, payload: { event: "agent.step.started", modelStep: 1, loopId: "loop-1" } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: at, payload: { text: "第一轮做完了", modelStep: 1, loopId: "loop-1" } },
        { sequence: 3, type: "TASK_PROGRESS", occurredAt: at, payload: { event: "agent.model.completed", modelStep: 1, loopId: "loop-1" } },
        { sequence: 4, type: "TASK_PROGRESS", occurredAt: at, payload: { action: "continuation" } },
        { sequence: 5, type: "TASK_PROGRESS", occurredAt: at, payload: { event: "agent.step.started", modelStep: 1, loopId: "loop-2" } },
      ],
      "ACTIVE",
    );

    // 第一轮那条正文仍然是「已完成」——它属于 loop-1，而此刻在跑的是 loop-2 的第 1 步。
    const firstRound = items.find((item) => item.kind === "model");
    expect(firstRound).toMatchObject({ content: "第一轮做完了", status: "COMPLETED", loopId: "loop-1" });
  });

  it("turns the execution report protocol into a readable assistant message", () => {
    const items = projectExecutionJournal(
      [
        {
          sequence: 1,
          type: "MODEL_OUTPUT",
          occurredAt: "2026-08-30T07:00:00.000Z",
          payload: {
            text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1", "task-2"], changedPaths: ["docs/guide.md"], report: "已完成内容与格式复核" })}</pipeline-factory-execution-report>`,
          },
        },
        {
          sequence: 2,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:01.000Z",
          payload: { action: "task-status", completedTaskIds: ["task-1", "task-2"] },
        },
      ],
      "BLOCKED",
    );

    expect(items[0]).toMatchObject({
      kind: "model",
      title: "执行报告",
      content: "已完成内容与格式复核\n\n已完成 2 个任务 · 改动 1 个文件",
    });
    expect(items.some((item) => item.detail.includes("<pipeline-factory-execution-report>"))).toBe(false);
  });

  it("shows model turns and context compaction while hiding empty continuation events", () => {
    const items = projectExecutionJournal(
      [
        { sequence: 1, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:00.000Z", payload: { event: "agent.step.started", step: 1 } },
        {
          sequence: 2,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:01.000Z",
          payload: { event: "agent.model.completed", step: 1 },
        },
        {
          sequence: 3,
          type: "TASK_PROGRESS",
          // **这里刻意用旧名**：库里几十条老 Run 的 journal 存的还是 `agent.context.compacted`，
          // 按游标重放时它们照样得渲染成"续跑检查点"，不能因为改了名就静默消失。
          occurredAt: "2026-08-30T07:00:02.000Z",
          payload: { event: "agent.context.compacted", messageCount: 4 },
        },
        { sequence: 4, type: "TASK_PROGRESS", occurredAt: "2026-08-30T07:00:03.000Z", payload: { event: "continue" } },
      ],
      "ACTIVE",
    );

    expect(items).toEqual([
      expect.objectContaining({ title: "模型轮次 · #1", status: "COMPLETED", modelStep: 1 }),
      expect.objectContaining({ title: "续跑检查点", status: "INFO" }),
    ]);
  });

  it("新名字（agent.loop.checkpointed）走同一条渲染", () => {
    const items = projectExecutionJournal(
      [
        {
          sequence: 1,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:01.000Z",
          payload: { event: "agent.loop.checkpointed", messageCount: 4 },
        },
      ],
      "ACTIVE",
    );

    expect(items).toEqual([expect.objectContaining({ title: "续跑检查点", status: "INFO", messageType: "CONTEXT" })]);
  });

  it("folds repeated reports with unchanged task progress into one card", () => {
    const report = (text: string, sequence: number) => ({
      sequence,
      type: "MODEL_OUTPUT",
      occurredAt: `2026-08-30T07:00:0${sequence}.000Z`,
      payload: {
        text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1"], changedPaths: [], report: text })}</pipeline-factory-execution-report>`,
      },
    });
    const items = projectExecutionJournal(
      [
        report("第一轮完成", 1),
        {
          sequence: 2,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:02.000Z",
          payload: { action: "task-status", completedTaskIds: ["task-1"] },
        },
        {
          sequence: 2.5,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:02.500Z",
          payload: { event: "agent.model.completed", step: 1 },
        },
        report("没有新的可执行内容", 3),
        {
          sequence: 4,
          type: "TASK_PROGRESS",
          occurredAt: "2026-08-30T07:00:04.000Z",
          payload: { action: "task-status", completedTaskIds: ["task-1"] },
        },
      ],
      "BLOCKED",
    );

    expect(items.filter((item) => item.title === "执行报告")).toHaveLength(1);
    expect(items.find((item) => item.title === "执行报告")?.repetitionCount).toBe(2);
  });

  /**
   * **合并不跨轮。** 那段合并是为了把"同一轮里反复重报同一份进度"折成一条；而补充要求会为同一个 Run
   * 起**新的一轮**，新一轮的第一份报告数字往往与上一轮完全相同（任务没变、文件也还没改），于是它会被
   * 并进**上一轮**那一行：内容被覆盖、序号与时间被改写成新的——看上去就是"那一行又在执行了"（实测观感）。
   */
  it("**不把补充要求那一轮的报告并进上一轮那一行**", () => {
    const reportWithLoop = (text: string, sequence: number, loopId: string) => ({
      sequence,
      type: "MODEL_OUTPUT",
      occurredAt: `2026-08-30T08:00:0${sequence}.000Z`,
      payload: {
        loopId,
        text: `<pipeline-factory-execution-report>${JSON.stringify({ completedTaskIds: ["task-1"], changedPaths: [], report: text })}</pipeline-factory-execution-report>`,
      },
    });
    // 报告是在 `agent.model.completed` 那一刻渲染出来的，所以每一轮都要给它一个边界。
    const completed = (sequence: number) => ({
      sequence,
      type: "TASK_PROGRESS",
      occurredAt: `2026-08-30T08:00:0${sequence}.000Z`,
      payload: { event: "agent.model.completed", step: 1 },
    });

    const items = projectExecutionJournal(
      [
        reportWithLoop("第一轮完成", 1, "agent-loop-1"),
        completed(1.5),
        reportWithLoop("补充要求那一轮", 2, "agent-loop-2"),
        completed(2.5),
      ],
      "IN_PROGRESS",
    );

    const reports = items.filter((item) => item.title === "执行报告");
    expect(reports).toHaveLength(2);
    expect(reports[0]?.content).toContain("第一轮完成");
    expect(reports[1]?.content).toContain("补充要求那一轮");
  });

  it("does not leak an incomplete report protocol into the conversation", () => {
    const items = projectExecutionJournal(
      [
        {
          sequence: 1,
          type: "MODEL_OUTPUT",
          occurredAt: "2026-08-30T07:00:00.000Z",
          payload: { text: '<pipeline-factory-execution-report>{"completedTaskIds":["task-1"]' },
        },
      ],
      "ACTIVE",
    );

    expect(items[0]).toMatchObject({ title: "执行报告", content: "执行报告仍在生成中。" });
  });

  it("动作类消息说清「做的是什么」：标题用 Provider 给的 summary", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "completed",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "succeeded",
          summary: "npm install --ignore-scripts",
        },
      },
    ]);

    // 没有 summary 时卡片只能写「命令 · 已完成 · Provider reported success」——等于没说。
    expect(items[0]).toMatchObject({ title: "命令 · npm install --ignore-scripts", detail: "执行成功", messageType: "COMMAND" });
  });

  it("老事件没有 summary 时退回类别标签，不编造内容", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "completed",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          providerStatus: "completed",
        },
      },
    ]);

    expect(items[0]).toMatchObject({ title: "命令", detail: "执行成功", messageType: "COMMAND" });
  });

  it("标题里的命令截断到可读长度，不把整行长命令铺出来", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "started",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "running",
          summary: `npm run ${"x".repeat(200)}`,
        },
      },
    ]);

    expect(items[0]?.title.length).toBeLessThanOrEqual("命令 · ".length + 80);
    expect(items[0]?.title).toContain("…");
  });
});

describe("消息清单的权重", () => {
  it("条目的形态只有七种，模板按形态选行组件", () => {
    // 28 个消息类型映射到这 7 种形态；`tool` 一条就承担命令 / 文件变更 / 工具调用 / MCP /
    // 子代理 / 联网搜索 / 生成图片七类。新增一种形态却没登记到 `EXECUTION_ROW_KINDS` 时，
    // 那边有编译期护栏会先红。
    expect(EXECUTION_ROW_KINDS).toEqual(["plan", "model", "user", "divider", "reasoning", "activity", "tool"]);
    // 形态由消息类型算出来，且只有一处定义——投影不再自己挑 `kind`。
    expect(executionRowKind("CONTEXT")).toBe("divider");
    expect(executionRowKind("REASONING")).toBe("reasoning");
    expect(executionRowKind("COMMAND")).toBe("tool");
    expect(executionRowKind("MCP_CALL")).toBe("tool");
    expect(executionRowKind("SUBAGENT")).toBe("tool");
    expect(executionRowKind("RUN_ACTIVITY")).toBe("activity");
  });

  it("**权重表是唯一落点**：常驻 / 过程 / 不显示，一眼看全", () => {
    expect(EXECUTION_MESSAGE_WEIGHTS.ASSISTANT_MESSAGE).toBe("answer");
    expect(EXECUTION_MESSAGE_WEIGHTS.MODEL_REPORT).toBe("answer");
    expect(EXECUTION_MESSAGE_WEIGHTS.PLAN).toBe("answer");
    expect(EXECUTION_MESSAGE_WEIGHTS.USER_MESSAGE).toBe("answer");
    expect(EXECUTION_MESSAGE_WEIGHTS.COMMAND).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.FILE_CHANGE).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.TOOL_CALL).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.MCP_CALL).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.SUBAGENT).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.REASONING).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.GATE).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.CONTEXT).toBe("process");
    expect(EXECUTION_MESSAGE_WEIGHTS.PROVIDER_MESSAGE).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.SESSION).toBe("hidden");
    // ④ 一律不进会话正文——归宿是 Run 头的「Provider 运行事实」。
    expect(EXECUTION_MESSAGE_WEIGHTS.PROVIDER_COMPACTION).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.PERMISSION_DENIED).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.RATE_LIMIT).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.PROVIDER_RETRY).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.BACKGROUND_TASK).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.HOOK).toBe("hidden");
    expect(EXECUTION_MESSAGE_WEIGHTS.PROVIDER_WARNING).toBe("hidden");
  });

  it("**异常类消息永远是常驻**：权重怎么调，阻塞与恢复都不能被藏起来", () => {
    expect(EXECUTION_MESSAGE_WEIGHTS.RECOVERY).toBe("answer");

    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "TASK_PROGRESS",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: { state: "BLOCKED", reason: "MAX_DURATION_EXCEEDED" },
      },
    ]);
    expect(items[0]).toMatchObject({ messageType: "RECOVERY", status: "FAILED" });
    expect(executionMessageWeight(items[0]!)).toBe("answer");
  });

  it("`phase` 决定一段正文是「过程」还是「结论」，**拿不到就当结论**（不折判不准的正文）", () => {
    const base = {
      id: "x",
      kind: "model",
      role: "assistant",
      title: "执行说明",
      content: "",
      detail: "",
      status: "COMPLETED",
      occurredAt: "2026-08-30T07:00:00.000Z",
      sequence: 1,
      messageType: "ASSISTANT_MESSAGE",
    } as const;

    expect(executionMessageWeight({ ...base, phase: "commentary" })).toBe("process");
    expect(executionMessageWeight({ ...base, phase: "final_answer" })).toBe("answer");
    // Provider 不保证给 phase（Codex schema 原话：treat None as "phase unknown"）——
    // 把判不准的正文折起来，等于把可能重要的内容藏了。
    expect(executionMessageWeight({ ...base })).toBe("answer");
    // 报告协议本身就是终答，不受 phase 影响。
    expect(executionMessageWeight({ ...base, messageType: "MODEL_REPORT", phase: "commentary" })).toBe("answer");
  });

  it("折起来的四条判据：过程、已跑完、不是失败、**不是分隔行**", () => {
    const item = {
      id: "x",
      kind: "tool",
      role: "system",
      title: "命令 · pnpm test",
      content: "",
      detail: "",
      status: "COMPLETED",
      occurredAt: "2026-08-30T07:00:00.000Z",
      sequence: 1,
      messageType: "COMMAND",
    } as const;

    expect(foldsIntoProcess(item, { stepRunning: false })).toBe(true);
    // 还在跑：照 OpenClaw，live 内容留在日志外面。
    expect(foldsIntoProcess(item, { stepRunning: true })).toBe(false);
    // 失败**永远可见**——`Worked for … · 2 个失败` 这一行的意思是"失败的条目还在外面"。
    expect(foldsIntoProcess({ ...item, status: "FAILED" }, { stepRunning: false })).toBe(false);
    // 结论与隐藏项从不折。
    expect(foldsIntoProcess({ ...item, messageType: "ASSISTANT_MESSAGE" }, { stepRunning: false })).toBe(false);
    expect(foldsIntoProcess({ ...item, messageType: "PROVIDER_MESSAGE" }, { stepRunning: false })).toBe(false);
    // **分隔行永远不折**：它的权重是 `process`（过程的一部分），可它同时是边界——
    // 折进「N 条过程记录」里，"这一轮从这儿换了一轮"就看不见了。形态与权重是两个轴，
    // 只在形态上改（改成 divider）是改不动的。
    expect(foldsIntoProcess({ ...item, kind: "divider", messageType: "CONTEXT" }, { stepRunning: false })).toBe(false);
  });

  it("**跨事件被切断的任务标记不会漏进正文**（回归：正文第一行曾是 `-progress>{...}`）", () => {
    const items = projectExecutionJournal([
      // 两条事件的 providerItemId 不同 → 投影成两张卡片，标记正好被切在中间。
      // 上一条的尾巴被"结尾未闭合"的规则削掉了，剩下的一半本会原样铺在下一条的正文里。
      {
        sequence: 1,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: { text: "开始执行 <pipeline-factory-task", providerItemId: "item-a" },
      },
      {
        sequence: 2,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:01.000Z",
        payload: {
          text: '-progress>{"taskId":"task-1","state":"started"}</pipeline-factory-task-progress>已完成第一步。',
          providerItemId: "item-b",
        },
      },
    ]);

    const bodies = items
      .filter((item) => item.kind === "model")
      .map((item) => item.content)
      .join("\n");
    expect(bodies).not.toContain("progress>");
    expect(bodies).not.toContain("taskId");
    expect(bodies).toContain("已完成第一步。");
  });

  it("**标记尾巴后面直接接正文时也只削尾巴**（实测形态：`factory-task-progress>` 后就是「开始执行…」）", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: { text: "开始执行 <pipeline-factory-task", providerItemId: "item-a" },
      },
      {
        sequence: 2,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:01.000Z",
        payload: { text: "actory-task-progress>\n开始执行 task-1：核对现有路由与校验链路。", providerItemId: "item-b" },
      },
    ]);

    const bodies = items
      .filter((item) => item.kind === "model")
      .map((item) => item.content)
      .join("\n");
    expect(bodies).not.toContain("progress>");
    expect(bodies).toContain("开始执行 task-1：核对现有路由与校验链路。");
  });

  it("普通正文不会被标记清理误伤", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: { text: "读取 src/App.vue 并在 100ms 内完成——这行没有标记。" },
      },
    ]);

    expect(items[0]?.content).toBe("读取 src/App.vue 并在 100ms 内完成——这行没有标记。");
  });

  it("失败原因翻成人话，但认不出来就原样显示（不猜意思）", () => {
    const exitCode = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "completed",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "failed",
          providerStatus: "failed",
          reason: "Provider command exited with code 1",
        },
      },
    ]);
    const unknown = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "completed",
          itemId: "exec-2",
          providerItemId: "exec-2",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "failed",
          providerStatus: "failed",
          reason: "workspace is not writable",
        },
      },
    ]);

    expect(exitCode[0]?.detail).toBe("命令退出码 1");
    expect(unknown[0]?.detail).toBe("workspace is not writable");
  });

  it("正文被清空时不产生空卡片（只剩标题与时间的卡片是纯噪音）", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: { text: "actory-task-progress>", providerItemId: "item-b" },
      },
    ]);

    expect(items.filter((item) => item.kind === "model")).toHaveLength(0);
  });

  it("认不出来的活动标成「未识别」，不伪装成已知类别", () => {
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: "2026-08-30T07:00:00.000Z",
        payload: {
          phase: "completed",
          itemId: "x-1",
          providerItemId: "x-1",
          itemType: "somethingBrandNew",
          activityKind: "other",
          outcome: "unknown",
        },
      },
    ]);

    expect(items[0]).toMatchObject({ messageType: "UNCLASSIFIED" });
    // 它是"过程"而不是"结论"——但**认不出来这件事本身可见**（折叠头会写"N 条未识别"）。
    expect(executionMessageWeight(items[0]!)).toBe("process");
  });
});

/**
 * 结构化载荷的搬运。这一组的两条都是**跑真实 Run 时抓到的**，不是想出来的边界。
 */
describe("动作的结构化载荷", () => {
  const at = "2026-10-07T09:20:00.000Z";

  it("**载荷跟着后到的那一条走**：命令的 stdout 只有结束事件才有", () => {
    // 实测：一次真实 Run 里两行命令**都没有**「显示结果」，而同一轮的 `fileChange` 有——
    // 因为条目的形态是 `started` 先建出来的，而 `output` / `exitCode` 只在 `completed` 那条上。
    // 合并不搬这几个字段，journal 里躺着完整 stdout，界面上却连按钮都不出现。
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: at,
        payload: {
          phase: "started",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "running",
        },
      },
      {
        sequence: 2,
        type: "PROVIDER_ACTIVITY",
        occurredAt: at,
        payload: {
          phase: "completed",
          itemId: "exec-1",
          providerItemId: "exec-1",
          itemType: "commandExecution",
          activityKind: "command",
          outcome: "succeeded",
          output: "pwd\n/repo",
          exitCode: 0,
          durationMs: 12,
        },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ output: "pwd\n/repo", exitCode: 0, durationMs: 12, status: "COMPLETED" });
  });

  it("先到的那一条已经有载荷时不会被后来的空值抹掉", () => {
    // `fileChange` 的 `changes` 在 started 那条上就带着了；结束那条没有再给一遍。
    const items = projectExecutionJournal([
      {
        sequence: 1,
        type: "PROVIDER_ACTIVITY",
        occurredAt: at,
        payload: {
          phase: "started",
          itemId: "fc-1",
          providerItemId: "fc-1",
          itemType: "fileChange",
          activityKind: "file-change",
          outcome: "running",
          result: [{ path: "README.md" }],
        },
      },
      {
        sequence: 2,
        type: "PROVIDER_ACTIVITY",
        occurredAt: at,
        payload: {
          phase: "completed",
          itemId: "fc-1",
          providerItemId: "fc-1",
          itemType: "fileChange",
          activityKind: "file-change",
          outcome: "succeeded",
        },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.result).toEqual([{ path: "README.md" }]);
  });
});

/**
 * **补充要求那一轮不属于任何计划任务。**
 *
 * 这一组用例盯着一个实测出来的错法：**`modelStep` 是每个 Loop 各自从 1 数的**，而"哪一步属于哪个
 * 任务"那张映射表此前只按 `modelStep` 存（整条日志一起建）。于是补充轮的第 1 步撞上第一轮的第 1 步，
 * 整轮 23 条——连你那句「你补充了要求」——都被算进了某个已完成任务的分组里，看起来像"这个步骤又在跑"。
 */
describe("补充要求那一轮的归属", () => {
  const plan: ExecutionPlanSnapshot = {
    planId: "plan-1",
    revision: 1,
    occurredAt: "2026-10-07T14:48:00.000Z",
    goal: "注入 project_id",
    acceptanceCriteria: ["任务归属于当前项目"],
    includePaths: ["code/src"],
    excludePaths: [],
    tasks: [
      { id: "task-1", title: "改组件", status: "READY", dependencies: [] },
      { id: "task-2", title: "验证行为", status: "READY", dependencies: [] },
    ],
    verificationCommandIds: [],
  };

  /** 与真实那次一样：第一轮 loop-1 用 modelStep 1 做 task-1，补充轮 loop-2 **又从 1 开始数**。 */
  function journal() {
    return [
      {
        sequence: 1,
        type: "TASK_PROGRESS",
        occurredAt: "2026-10-07T14:49:35.000Z",
        payload: { action: "task-lifecycle", taskId: "task-1", state: "IN_PROGRESS", loopId: "loop-1", modelStep: 1 },
      },
      {
        sequence: 2,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-10-07T14:49:40.000Z",
        payload: { text: "第一轮的正文", loopId: "loop-1", modelStep: 1 },
      },
      {
        sequence: 3,
        type: "USER_GUIDANCE",
        occurredAt: "2026-10-07T15:18:06.000Z",
        payload: { content: "生成修改摘要，并 commit", runId: "run-1", guidanceId: "guidance-1", delivery: "QUEUE", status: "PENDING" },
      },
      {
        sequence: 4,
        type: "TASK_PROGRESS",
        occurredAt: "2026-10-07T15:18:06.100Z",
        payload: {
          action: "continuation",
          guidanceIds: ["guidance-1"],
          consumedAt: "2026-10-07T15:18:06.100Z",
          completedTaskIds: ["task-1", "task-2"],
          tasksUnchanged: true,
        },
      },
      {
        sequence: 5,
        type: "TASK_PROGRESS",
        occurredAt: "2026-10-07T15:18:06.200Z",
        payload: { action: "executor_loop_created", loopId: "loop-2" },
      },
      {
        sequence: 6,
        type: "MODEL_OUTPUT",
        occurredAt: "2026-10-07T15:18:53.000Z",
        payload: { text: "补充那一轮的正文", loopId: "loop-2", modelStep: 1 },
      },
      {
        sequence: 7,
        type: "TASK_PROGRESS",
        occurredAt: "2026-10-07T15:19:50.000Z",
        payload: { action: "task-status", completedTaskIds: ["task-1", "task-2"], loopId: "loop-2", modelStep: 1, taskId: "task-2" },
      },
    ];
  }

  it("第一轮的条目照旧归到它的任务；**补充轮的条目一条都不归**", () => {
    const items = projectExecutionJournal(journal(), "COMPLETED", plan);
    const firstRound = items.find((item) => item.content.includes("第一轮的正文"));
    const continuationRound = items.find((item) => item.content.includes("补充那一轮的正文"));

    expect(firstRound).toMatchObject({ taskId: "task-1" });
    expect(continuationRound).toMatchObject({ continuation: true });
    expect(continuationRound?.taskId).toBeUndefined();
  });

  it("**补充轮自己带了 taskId 也不认**：那是写侧按「当时活跃的任务」盖的戳", () => {
    // 上面第 7 条就带着 `taskId: "task-2"`（真实日志里也是）——它说的是"写这条时正在做哪个任务"，
    // 不是"这条属于那个任务"。补偿：**任何标了 continuation 的条目都不带 taskId**（这一条足以
    // 覆盖全部条目类型，不必逐个 messageType 列）。
    const items = projectExecutionJournal(journal(), "COMPLETED", plan);
    const continuationItems = items.filter((item) => item.continuation);
    expect(continuationItems.length).toBeGreaterThan(0);
    expect(continuationItems.filter((item) => item.taskId !== undefined)).toEqual([]);
  });

  it("「你补充了要求」那句本身也属于这一轮、不属于任何任务", () => {
    const items = projectExecutionJournal(journal(), "COMPLETED", plan);
    const guidance = items.find((item) => item.messageType === "USER_MESSAGE");
    expect(guidance).toMatchObject({ continuation: true, content: "生成修改摘要，并 commit" });
    expect(guidance?.taskId).toBeUndefined();
  });

  it("`continuation` 标记本身不占一行（此前它掉进兜底，显示成「未识别」）", () => {
    const items = projectExecutionJournal(journal(), "COMPLETED", plan);
    // 标记只是个写侧的账：内容里不该有任何一条把它的载荷漏出来。
    expect(items.filter((item) => JSON.stringify(item).includes("tasksUnchanged"))).toEqual([]);
    expect(items.filter((item) => item.messageType === "UNCLASSIFIED")).toEqual([]);
  });
});

/**
 * **两轮补充各自成组。** 这个错法很隐蔽：那句「你补充了要求」的日志**不带 loopId**，投影会顺手把它
 * 归给"上一个 Loop"——正好是它要离开的那一轮。实测第二句补充因此落进了第一组（组头还是第一句话）。
 */
describe("补充要求有两轮时", () => {
  const plan: ExecutionPlanSnapshot = {
    planId: "plan-1",
    revision: 1,
    occurredAt: "2026-10-07T14:48:00.000Z",
    goal: "",
    acceptanceCriteria: [],
    includePaths: [],
    excludePaths: [],
    tasks: [{ id: "task-1", title: "改组件", status: "READY", dependencies: [] }],
    verificationCommandIds: [],
  };

  it("**第二句落在第二轮**，而且它不带那个继承来的 loopId", () => {
    const items = projectExecutionJournal(
      [
        {
          sequence: 1,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T14:49:35.000Z",
          payload: { action: "task-lifecycle", taskId: "task-1", state: "IN_PROGRESS", loopId: "loop-1", modelStep: 1 },
        },
        {
          sequence: 2,
          type: "USER_GUIDANCE",
          occurredAt: "2026-10-07T15:18:06.000Z",
          payload: { content: "第一句补充", delivery: "QUEUE", status: "PENDING" },
        },
        {
          sequence: 3,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T15:18:06.100Z",
          payload: { action: "continuation", guidanceIds: ["g-1"] },
        },
        {
          sequence: 4,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T15:18:06.200Z",
          payload: { action: "executor_loop_created", loopId: "loop-2" },
        },
        {
          sequence: 5,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T15:18:06.300Z",
          payload: { event: "agent.step.started", loopId: "loop-2", modelStep: 1 },
        },
        {
          sequence: 6,
          type: "USER_GUIDANCE",
          occurredAt: "2026-10-07T16:00:00.000Z",
          payload: { content: "第二句补充", delivery: "QUEUE", status: "PENDING" },
        },
        {
          sequence: 7,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T16:00:00.100Z",
          payload: { action: "continuation", guidanceIds: ["g-2"] },
        },
        {
          sequence: 8,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T16:00:00.200Z",
          payload: { action: "executor_loop_created", loopId: "loop-3" },
        },
        {
          sequence: 9,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T16:00:00.300Z",
          payload: { event: "agent.step.started", loopId: "loop-3", modelStep: 1 },
        },
      ],
      "COMPLETED",
      plan,
    );

    const guidance = items.filter((item) => item.messageType === "USER_MESSAGE");
    expect(guidance.map((item) => [item.content, item.continuationRound, item.loopId])).toEqual([
      ["第一句补充", 1, undefined],
      ["第二句补充", 2, undefined],
    ]);
    // 每一轮的 loop 各自一号，不互相串。
    expect(items.find((item) => item.loopId === "loop-2")?.continuationRound).toBe(1);
    expect(items.find((item) => item.loopId === "loop-3")?.continuationRound).toBe(2);
  });

  it("`STEER` 那句**不搬出来**：它插进的是正在跑的那一轮，属于那个步骤的现场", () => {
    const items = projectExecutionJournal(
      [
        {
          sequence: 1,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T14:49:35.000Z",
          payload: { action: "task-lifecycle", taskId: "task-1", state: "IN_PROGRESS", loopId: "loop-1", modelStep: 1 },
        },
        // 那一轮正在跑（有 modelStep）时插进来的——它继承的 loopId/modelStep 就是**那个步骤**的。
        {
          sequence: 2,
          type: "TASK_PROGRESS",
          occurredAt: "2026-10-07T14:49:36.000Z",
          payload: { event: "agent.step.started", loopId: "loop-1", modelStep: 1 },
        },
        {
          sequence: 3,
          type: "USER_GUIDANCE",
          occurredAt: "2026-10-07T14:50:00.000Z",
          payload: { content: "插一句", delivery: "STEER", status: "PENDING" },
        },
      ],
      "COMPLETED",
      plan,
    );

    const guidance = items.find((item) => item.messageType === "USER_MESSAGE");
    expect(guidance?.continuation).toBeUndefined();
    expect(guidance?.taskId).toBe("task-1");
  });
});
