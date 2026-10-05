import { describe, expect, it } from "vitest";
import { activityStatusLabel, assistantActivityLabel, EXPLORER_DISPLAY_MODES, EXPLORER_INLINE_MODES, EXPLORER_ROW_MODES, explorerActivityLine, explorerDisplayMode, explorerDisplayTitle, formatTurnTime, inputStatusLabel } from "./explorerPresentation";
import type { ExplorerMessageType } from "./explorerPresentation";
import { SHARED_MESSAGE_TYPES } from "./conversationTypes";
import type { ExplorerActivityItem, ExplorerActivityKind, ExplorerInputRequest } from "../types";

function request(id: string, status: ExplorerInputRequest["status"]): Pick<ExplorerInputRequest, "id" | "status"> {
  return { id, status };
}

function activity(kind: ExplorerActivityItem["kind"], overrides: Partial<ExplorerActivityItem> = {}): ExplorerActivityItem {
  return {
    id: `activity-${kind}`,
    explorerId: "explorer-1",
    turnId: "turn-1",
    sequence: 1,
    kind,
    status: "COMPLETED",
    title: kind,
    summary: "",
    details: null,
    occurredAt: "2026-09-28T14:05:00.000Z",
    ...overrides,
  };
}

describe("Explorer 展示映射", () => {
  it("把消息时间截到分钟", () => {
    // 用固定时区无关的断言：只验形状，不验具体时区偏移。
    expect(formatTurnTime("2026-09-28T14:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("线程没有标题时给出占位标题", () => {
    expect(explorerDisplayTitle(null)).toBe("探索线程");
    expect(explorerDisplayTitle({ title: "" } as never)).toBe("探索线程");
    expect(explorerDisplayTitle({ title: "改名后的线程" } as never)).toBe("改名后的线程");
  });
});

describe("输入请求状态文案", () => {
  it("五个状态各有文案，不回落成原字符串", () => {
    expect(inputStatusLabel(request("a", "OPEN"), null)).toBe("等待回答");
    expect(inputStatusLabel(request("a", "SUBMITTING"), null)).toBe("提交中");
    expect(inputStatusLabel(request("a", "ANSWERED"), null)).toBe("已回答");
    expect(inputStatusLabel(request("a", "CANCELLED"), null)).toBe("已取消");
    expect(inputStatusLabel(request("a", "RECOVERY_REQUIRED"), null)).toBe("需要恢复");
  });

  it("本地在途标记优先于服务端状态，且只对同一个请求生效", () => {
    // 提交后服务端仍是 OPEN，界面必须靠本地标记抢先显示"提交中"。
    expect(inputStatusLabel(request("in-flight", "OPEN"), "in-flight")).toBe("提交中");
    expect(inputStatusLabel(request("other", "OPEN"), "in-flight")).toBe("等待回答");
  });
});

describe("活动条目文案", () => {
  it("五档状态都有中文文案，与执行线程同一套词", () => {
    expect(activityStatusLabel({ status: "WAITING" })).toBe("等待中");
    expect(activityStatusLabel({ status: "FAILED" })).toBe("失败");
    expect(activityStatusLabel({ status: "RUNNING" })).toBe("进行中");
    expect(activityStatusLabel({ status: "COMPLETED" })).toBe("已完成");
    expect(activityStatusLabel({ status: "UNKNOWN" })).toBe("状态未知");
  });

  it("助手消息卡片把回合状态归成三档", () => {
    expect(assistantActivityLabel({ status: "RUNNING" })).toBe("进行中");
    expect(assistantActivityLabel({ status: "FAILED" })).toBe("失败");
    expect(assistantActivityLabel({ status: "COMPLETED" })).toBe("已完成");
    expect(assistantActivityLabel({ status: "WAITING" })).toBe("已完成");
  });

});

describe("各类过程活动各摆什么", () => {
  it("工具开始：名字单独一格，正文不再重复工具名", () => {
    const line = explorerActivityLine(activity("TOOL_CALL", { status: "RUNNING", title: "read_file", summary: "", details: { tool: "read_file", callId: "call-1" } }));

    expect(line).toEqual({ label: "工具调用", name: "read_file", reference: "call-1", body: "" });
  });

  it("没有工具名时把摘要顶上当名字，正文不重复同一句", () => {
    const line = explorerActivityLine(activity("COMMAND", { title: "", summary: "pnpm --filter @pipeline-factory/web test" }));

    expect(line).toEqual({ label: "命令", name: "pnpm --filter @pipeline-factory/web test", reference: null, body: "" });
  });

  it("结束那条：原因进正文，它是这一行唯一要说的事", () => {
    const bare = explorerActivityLine(activity("TOOL_CALL", { title: "read_file", summary: "", details: { callId: "call-2" } }));
    const explained = explorerActivityLine(activity("TOOL_CALL", { status: "FAILED", title: "shell", details: { callId: "call-3", reason: "策略不允许写仓库目录以外的文件。" } }));

    expect(bare).toEqual({ label: "工具调用", name: "read_file", reference: "call-2", body: "" });
    expect(explained).toEqual({ label: "工具调用", name: "shell", reference: "call-3", body: "策略不允许写仓库目录以外的文件。" });
  });

  it("没有开始记录的调用：名字与原因各就各位，原因不会被读成名字", () => {
    const line = explorerActivityLine(activity("TOOL_CALL", { status: "UNKNOWN", title: "", summary: "", details: { callId: "call-4", reason: "未记录调用的结束状态。" } }));

    expect(line).toEqual({ label: "工具调用", name: null, reference: "call-4", body: "未记录调用的结束状态。" });
  });

  it("MCP：身份是 Server 给的工具名，itemId 只进尾巴", () => {
    const line = explorerActivityLine(activity("MCP_CALL", { title: "github/create_issue", summary: "已创建 issue #42", details: { itemId: "item-9", itemType: "mcpToolCall", providerControlled: true } }));

    expect(line).toEqual({ label: "MCP 调用", name: "github/create_issue", reference: "item-9", body: "已创建 issue #42" });
  });

  it("Provider 活动：名字在 title、真正跑了什么在 summary，一句都不丢", () => {
    // 同一个 kind 的两条来源。Provider 这一路没有 details.tool，丢掉 summary 这行就只剩个标签。
    const line = explorerActivityLine(activity("COMMAND", { title: "Command", summary: "pnpm --filter @pipeline-factory/web test", details: { itemId: "item-cmd-1", itemType: "commandExecution", providerControlled: true } }));

    expect(line).toEqual({ label: "命令", name: "Command", reference: "item-cmd-1", body: "pnpm --filter @pipeline-factory/web test" });
  });

  it("Provider 推理流不摆标题——那只是类别名，摆出来和标签重复", () => {
    const line = explorerActivityLine(activity("REASONING", { title: "Reasoning", summary: "对照 executionStream.ts 的呈现方式表", details: { itemId: "item-reason-1", itemType: "reasoning", providerControlled: true } }));

    expect(line).toEqual({ label: "推理", name: null, reference: null, body: "对照 executionStream.ts 的呈现方式表" });
  });

  it("Provider 没给摘要的推理行退回标签，不留一个只有点和时间的空行", () => {
    // 投影层对"没摘要"交的是空串；推理行是纯文本行，空着就只剩一个点和时间。
    const line = explorerActivityLine(activity("REASONING", { title: "reasoning", summary: "", details: { itemId: "item-reason-1", itemType: "reasoning", providerControlled: true } }));

    expect(line).toEqual({ label: "推理", name: null, reference: null, body: "推理" });
  });

  it("上下文压缩：摆的是消息条数，不是一句过程说明", () => {
    const line = explorerActivityLine(activity("CONTEXT", { summary: "The loop saved a checkpoint before continuing.", details: { messageCount: 12 } }));

    expect(line).toEqual({ label: "Factory · 上下文压缩", name: null, reference: "12 条消息", body: "" });
  });

  it("门禁：拦截是结论本身，占 name 那一格", () => {
    const line = explorerActivityLine(activity("GATE", { status: "FAILED", summary: "连续两步没有进展", details: { action: "blocked" } }));

    expect(line).toEqual({ label: "Factory · 执行门禁", name: "blocked", reference: null, body: "连续两步没有进展" });
  });

  it("未识别：标签直接摆 Provider 的原生 itemType，不编一个像样的类别名", () => {
    const line = explorerActivityLine(activity("UNCLASSIFIED", { title: "somethingNew", summary: "说不上是什么", details: { itemId: "item-x", itemType: "somethingNew", providerControlled: true } }));

    expect(line).toEqual({ label: "somethingNew", name: null, reference: "item-x", body: "说不上是什么" });
  });

  it("推理与轮次状态：只有正文，没有名字也没有尾巴", () => {
    expect(explorerActivityLine(activity("REASONING", { summary: "Plan Explorer started step 3." }))).toEqual({ label: "推理", name: null, reference: null, body: "Plan Explorer started step 3." });
    expect(explorerActivityLine(activity("TURN_STATUS", { status: "WAITING", summary: "Waiting for input" }))).toEqual({ label: "Factory · 模型轮次", name: null, reference: null, body: "Waiting for input" });
  });

  it("认不出来的活动回落成原字符串，不留白", () => {
    // 后端加了一种活动而这边还没跟上时，页面要能一眼看出来，而不是显示一张空卡片。
    const line = explorerActivityLine(activity("TOOL_SOMETHING" as ExplorerActivityKind, { summary: "新活动" }));

    expect(line).toEqual({ label: "TOOL_SOMETHING", name: null, reference: null, body: "新活动" });
  });

  it("details 里是空串或非字符串时，不留一格空的", () => {
    const line = explorerActivityLine(activity("TOOL_CALL", { title: "", summary: "", details: { tool: "   ", callId: 42 } }));

    expect(line.name).toBeNull();
    expect(line.reference).toBeNull();
  });

  it("主标识过长时截断，不把整条命令行铺进一行", () => {
    const long = `/bin/zsh -lc "${"a".repeat(200)}"`;
    const line = explorerActivityLine(activity("COMMAND", { title: "", summary: long }));

    expect(line.name).toHaveLength(80);
    expect(line.name?.endsWith("…")).toBe(true);
  });
});

/** 清单里的键：15 类是活动条目的 kind，另两类（输入卡 / 内嵌方案卡）由投影或模板在别处产生。 */
const messageTypes = Object.keys(EXPLORER_DISPLAY_MODES) as ExplorerMessageType[];
const producedWithoutActivity = new Set<ExplorerMessageType>(["INPUT_REQUEST", "CANDIDATE_PLAN"]);
const activityTypes = messageTypes.filter((type): type is ExplorerActivityItem["kind"] => !producedWithoutActivity.has(type));

describe("探索会话的消息清单", () => {
  it("清单覆盖 13 类活动加投影产生的 2 类非活动消息", () => {
    // 数量钉住是有意的：新增一类消息就得回来改这里，顺带在表里做一次"怎么显示"的决定。
    // 类型层面 `Record<ExplorerMessageType, …>` 已经强制穷尽，这条锁的是"清单本身有多大"。
    expect(activityTypes).toHaveLength(13);
    expect(messageTypes).toHaveLength(15);
    expect(EXPLORER_DISPLAY_MODES.INPUT_REQUEST).toBe("card");
    expect(EXPLORER_DISPLAY_MODES.CANDIDATE_PLAN).toBe("card");
  });

  it("每一种呈现方式都有人渲染它：行型组件 或 内联分支，二选一", () => {
    // 新增一种 `ExplorerDisplayMode` 却没归到任何一边时，`explorerPresentation.ts` 里的编译期护栏会先红；
    // 这条是它的运行时孪生兄弟——两张清单合起来必须正好是全部取值。
    expect(new Set(Object.values(EXPLORER_DISPLAY_MODES))).toEqual(new Set([...EXPLORER_ROW_MODES, ...EXPLORER_INLINE_MODES]));
  });

  it("共用词表里的每一项，探索线程都有一行呈现方式", () => {
    // 这就是"两条对话线一致"的落地处：漏一项，`conversationTypes.ts` 的共用词表就名不副实。
    for (const shared of SHARED_MESSAGE_TYPES) expect(EXPLORER_DISPLAY_MODES[shared]).toBeDefined();
  });

  it("只有方案与结构化输入做成卡片；人说的话与模型的回复都是铺开的正文", () => {
    // 白底边框不承载任何信息：用户消息靠右带 `›`，助手回复靠左带一行 meta（状态 + 时间 + 内嵌方案卡）。
    expect(activityTypes.filter((type) => explorerDisplayMode(type) === "card")).toEqual([]);
    expect(explorerDisplayMode("USER_MESSAGE")).toBe("text");
    expect(explorerDisplayMode("ASSISTANT_MESSAGE")).toBe("prose");
    expect(explorerDisplayMode("INPUT_REQUEST")).toBe("card");
    expect(explorerDisplayMode("CANDIDATE_PLAN")).toBe("card");
  });

  it("内容在别处已经有的几类不单独渲染", () => {
    // 输入卡取代了那两条生命周期行；Provider 的回声与执行侧同名，同样标 hidden。
    expect(new Set(activityTypes.filter((type) => explorerDisplayMode(type) === "hidden"))).toEqual(new Set(["PROVIDER_MESSAGE", "SESSION"]));
  });

  it("四类调用同归调用行，其余四类各有各的形状", () => {
    // 一次调用只有一条（开始与结束在投影层已合并），所以这里比的是"哪四类算调用"。
    expect(new Set(activityTypes.filter((type) => explorerDisplayMode(type) === "tool"))).toEqual(new Set(["COMMAND", "FILE_CHANGE", "TOOL_CALL", "MCP_CALL"]));
    expect(explorerDisplayMode("REASONING")).toBe("reasoning");
    expect(explorerDisplayMode("CONTEXT")).toBe("divider");
    expect(explorerDisplayMode("GATE")).toBe("gate");
    expect(explorerDisplayMode("TURN_STATUS")).toBe("turn-status");
    expect(explorerDisplayMode("UNCLASSIFIED")).toBe("turn-status");
  });

  it("每一类过程活动都有自己的标签，不回落成原字符串", () => {
    // 把某类活动从 hidden 改成有行型、却忘了在 ACTIVITY_LABELS 里补标签时，页面会直接显示
    // TOOL_CALL 这种原始枚举值——这条断言在那次改动上拦住它。
    for (const type of activityTypes) {
      const mode = explorerDisplayMode(type);
      if (mode === "card" || mode === "text" || mode === "prose" || mode === "hidden") continue;
      expect(explorerActivityLine(activity(type)).label).not.toBe(type);
    }
  });
});
