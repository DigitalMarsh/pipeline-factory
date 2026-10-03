import { describe, expect, it } from "vitest";
import { activityIconKind, activityStatusLabel, EXPLORER_DISPLAY_MODES, explorerActivityLine, explorerDisplayMode, explorerDisplayTitle, formatTurnTime, inputStatusLabel } from "./explorerPresentation";
import type { ExplorerMessageType } from "./explorerPresentation";
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
    expect(inputStatusLabel(request("a", "OPEN"), null)).toBe("Waiting for answer");
    expect(inputStatusLabel(request("a", "SUBMITTING"), null)).toBe("Submitting");
    expect(inputStatusLabel(request("a", "ANSWERED"), null)).toBe("Answered");
    expect(inputStatusLabel(request("a", "CANCELLED"), null)).toBe("Cancelled");
    expect(inputStatusLabel(request("a", "RECOVERY_REQUIRED"), null)).toBe("Recovery required");
  });

  it("本地在途标记优先于服务端状态，且只对同一个请求生效", () => {
    // 提交后服务端仍是 OPEN，界面必须靠本地标记抢先显示 Submitting。
    expect(inputStatusLabel(request("in-flight", "OPEN"), "in-flight")).toBe("Submitting");
    expect(inputStatusLabel(request("other", "OPEN"), "in-flight")).toBe("Waiting for answer");
  });
});

describe("活动条目文案", () => {
  it("状态映射四档", () => {
    expect(activityStatusLabel({ status: "WAITING" })).toBe("Waiting");
    expect(activityStatusLabel({ status: "FAILED" })).toBe("Failed");
    expect(activityStatusLabel({ status: "RUNNING" })).toBe("Running");
    expect(activityStatusLabel({ status: "COMPLETED" })).toBe("Completed");
  });

  it("图标语义：拒绝与门禁是警告，完成与输入解决是成功，其余是信息", () => {
    expect(activityIconKind("TOOL_DENIED")).toBe("warning");
    expect(activityIconKind("GATE_CHECKED")).toBe("warning");
    expect(activityIconKind("TOOL_COMPLETED")).toBe("success");
    expect(activityIconKind("INPUT_RESOLVED")).toBe("success");
    expect(activityIconKind("REASONING_SUMMARY")).toBe("info");
    expect(activityIconKind("USER_MESSAGE")).toBe("info");
  });
});

describe("八类过程活动各摆什么", () => {
  it("工具开始：名字单独一格，正文不再重复工具名", () => {
    const line = explorerActivityLine(activity("TOOL_STARTED", { status: "RUNNING", summary: "read_file", details: { tool: "read_file", callId: "call-1" } }));

    expect(line).toEqual({ label: "Tool started", name: "read_file", reference: "call-1", body: "" });
  });

  it("工具开始：连工具名都没记下来时，正文兜住 Provider 给的说明", () => {
    const line = explorerActivityLine(activity("TOOL_STARTED", { summary: "Provider tool" }));

    expect(line).toEqual({ label: "Tool started", name: null, reference: null, body: "Provider tool" });
  });

  it("工具完成：只摆 reason，不摆「工具返回了结果」这句废话", () => {
    const bare = explorerActivityLine(activity("TOOL_COMPLETED", { summary: "The tool returned a result.", details: { callId: "call-2", reason: null } }));
    const explained = explorerActivityLine(activity("TOOL_COMPLETED", { summary: "The tool returned a result.", details: { callId: "call-2", reason: "命令退出码 1" } }));

    expect(bare).toEqual({ label: "Tool completed", name: null, reference: "call-2", body: "" });
    expect(explained.body).toBe("命令退出码 1");
  });

  it("工具被拒：原因进正文，它是这一行唯一要说的事", () => {
    const line = explorerActivityLine(activity("TOOL_DENIED", { status: "FAILED", summary: "The tool request was denied by policy.", details: { tool: "shell", callId: "call-3" } }));

    expect(line).toEqual({ label: "Tool denied", name: "shell", reference: "call-3", body: "The tool request was denied by policy." });
  });

  it("MCP：身份是 Server 给的 title，itemId 只进尾巴", () => {
    const line = explorerActivityLine(activity("MCP_ACTIVITY", { title: "mcpToolCall", summary: "MCP 工具已返回。", details: { itemId: "item-9", itemType: "mcpToolCall", providerControlled: true } }));

    expect(line).toEqual({ label: "MCP activity", name: "mcpToolCall", reference: "item-9", body: "MCP 工具已返回。" });
  });

  it("Provider 活动：名字在 title、真正跑了什么在 summary，一句都不丢", () => {
    // 同一个 kind 的两条来源。Provider 这一路没有 details.tool，丢掉 summary 这行就只剩个标签。
    const line = explorerActivityLine(activity("TOOL_COMPLETED", { title: "Command", summary: "pnpm --filter @pipeline-factory/web test", details: { itemId: "item-cmd-1", itemType: "commandExecution", providerControlled: true } }));

    expect(line).toEqual({ label: "Tool completed", name: "Command", reference: "item-cmd-1", body: "pnpm --filter @pipeline-factory/web test" });
  });

  it("Provider 推理流不摆标题——那只是类别名，摆出来和标签重复", () => {
    const line = explorerActivityLine(activity("REASONING_SUMMARY", { title: "Reasoning", summary: "对照 executionStream.ts 的呈现方式表", details: { itemId: "item-reason-1", itemType: "reasoning", providerControlled: true } }));

    expect(line).toEqual({ label: "Reasoning", name: null, reference: null, body: "对照 executionStream.ts 的呈现方式表" });
  });

  it("Provider 没给摘要的推理行退回标签，不留一个只有点和时间的空行", () => {
    // 投影层对"没摘要"交的是空串；推理行是纯文本行，空着就只剩一个点和时间。
    const line = explorerActivityLine(activity("REASONING_SUMMARY", { title: "reasoning", summary: "", details: { itemId: "item-reason-1", itemType: "reasoning", providerControlled: true } }));

    expect(line).toEqual({ label: "Reasoning", name: null, reference: null, body: "Reasoning" });
  });

  it("上下文压缩：摆的是消息条数，不是一句过程说明", () => {
    const line = explorerActivityLine(activity("CONTEXT_COMPACTED", { summary: "The loop saved a checkpoint before continuing.", details: { messageCount: 12 } }));

    expect(line).toEqual({ label: "Context checkpoint", name: null, reference: "12 messages", body: "" });
  });

  it("门禁：放行还是拦截是结论本身，占 name 那一格", () => {
    const line = explorerActivityLine(activity("GATE_CHECKED", { summary: "no progress", details: { action: "blocked" } }));

    expect(line).toEqual({ label: "Gate checked", name: "blocked", reference: null, body: "no progress" });
  });

  it("推理与轮次状态：只有正文，没有名字也没有尾巴", () => {
    expect(explorerActivityLine(activity("REASONING_SUMMARY", { summary: "Plan Explorer started step 3." }))).toEqual({ label: "Reasoning", name: null, reference: null, body: "Plan Explorer started step 3." });
    expect(explorerActivityLine(activity("TURN_STATUS", { status: "WAITING", summary: "Waiting for input" }))).toEqual({ label: "Turn status", name: null, reference: null, body: "Waiting for input" });
  });

  it("认不出来的活动回落成原字符串，不留白", () => {
    // 后端加了一种活动而这边还没跟上时，页面要能一眼看出来，而不是显示一张空卡片。
    const line = explorerActivityLine(activity("TOOL_SOMETHING" as ExplorerActivityKind, { summary: "新活动" }));

    expect(line).toEqual({ label: "TOOL_SOMETHING", name: null, reference: null, body: "新活动" });
  });

  it("details 里是空串或非字符串时，不留一格空的", () => {
    const line = explorerActivityLine(activity("TOOL_STARTED", { details: { tool: "   ", callId: 42 } }));

    expect(line.name).toBeNull();
    expect(line.reference).toBeNull();
  });
});

/**
 * 表里的键就是消息清单。活动 kind 是 SCREAMING_SNAKE，另外两类（输入卡 / 内嵌方案卡）
 * 是 kebab-case——靠这条形状差异把两类分开，不用再手抄一份 kind 清单。
 */
const activityTypes = (Object.keys(EXPLORER_DISPLAY_MODES) as ExplorerMessageType[]).filter((type): type is ExplorerActivityItem["kind"] => type === type.toUpperCase());

describe("探索会话的消息清单", () => {
  it("清单覆盖 12 类活动加投影产生的 2 类非活动消息", () => {
    // 数量钉住是有意的：新增一类消息就得回来改这里，顺带在表里做一次"怎么显示"的决定。
    // 类型层面 `Record<ExplorerMessageType, …>` 已经强制穷尽，这条锁的是"清单本身有多大"。
    expect(activityTypes).toHaveLength(12);
    expect(Object.keys(EXPLORER_DISPLAY_MODES)).toHaveLength(14);
    expect(EXPLORER_DISPLAY_MODES["input-request"]).toBe("card");
    expect(EXPLORER_DISPLAY_MODES["candidate-plan"]).toBe("card");
  });

  it("只有被人说的话、模型正文、方案与输入做成卡片", () => {
    expect(new Set(activityTypes.filter((type) => explorerDisplayMode(type) === "card"))).toEqual(new Set(["USER_MESSAGE", "ASSISTANT_MESSAGE"]));
  });

  it("被结构化输入卡取代的两类生命周期行不单独渲染", () => {
    // 投影层在存在输入卡时就已经不产出它们；漏到视图说明没有卡可点，那两行只会是死路。
    expect(activityTypes.filter((type) => explorerDisplayMode(type) === "hidden")).toEqual(["INPUT_REQUIRED", "INPUT_RESOLVED"]);
  });

  it("八类过程活动各归各的行，不再挤在同一档", () => {
    // 四类带调用身份的归工具行（靠标签和语调区分开始/完成/被拒/MCP）；其余四类各有各的形状。
    expect(new Set(activityTypes.filter((type) => explorerDisplayMode(type) === "tool"))).toEqual(new Set(["TOOL_STARTED", "TOOL_COMPLETED", "TOOL_DENIED", "MCP_ACTIVITY"]));
    expect(explorerDisplayMode("REASONING_SUMMARY")).toBe("reasoning");
    expect(explorerDisplayMode("CONTEXT_COMPACTED")).toBe("divider");
    expect(explorerDisplayMode("GATE_CHECKED")).toBe("gate");
    expect(explorerDisplayMode("TURN_STATUS")).toBe("turn-status");
  });

  it("每一类过程活动都有自己的标签，不回落成原字符串", () => {
    // 把某类活动从 hidden 改成有行型、却忘了在 ACTIVITY_LABELS 里补标签时，页面会直接显示
    // TOOL_STARTED 这种原始枚举值——这条断言在那次改动上拦住它。
    for (const type of activityTypes) {
      const mode = explorerDisplayMode(type);
      if (mode === "card" || mode === "hidden") continue;
      expect(explorerActivityLine(activity(type)).label).not.toBe(type);
    }
  });
});
