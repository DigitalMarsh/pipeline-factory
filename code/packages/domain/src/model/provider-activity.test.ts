/**
 * 测试职责：钉住"同一种逻辑活动，无论由哪个 agent 执行，都得到同一个类别与同一个成败"。
 *
 * 为什么单独写这个文件：这条等价性是整个中立词表的**唯一目的**。两个 Provider 的原生词表完全不通用
 *   （Codex：commandExecution/completed；Claude：tool_use/tool_result/succeeded），此前 UI 各自
 *   正则猜标签、各自维护成败白名单，于是同一个动作换个 agent 就换个名字，而 Codex 的成功词
 *   `completed` 不在成功白名单里——全库 343 条"状态未知"、0 条成功。这里逐对断言，防止两边再次分叉。
 */
import { describe, expect, it } from "vitest";
import {
  activityOutcome,
  classifyClaudeActivity,
  classifyCodexActivity,
  isOutcomeFreeKind,
  isRuntimeAlertKind,
  isRuntimeKind,
} from "./provider-activity.js";

describe("provider 活动的中立词表", () => {
  it("同一条命令：两个 Provider 给出同一个类别与同一个成败", () => {
    const codex = classifyCodexActivity({ itemType: "commandExecution", phase: "completed", status: "completed" });
    const claude = classifyClaudeActivity({ itemType: "tool_result", phase: "completed", status: "succeeded", toolName: "Bash" });

    expect(codex).toEqual({ activityKind: "command", outcome: "succeeded" });
    expect(claude).toEqual(codex);
  });

  it("同一条失败的命令：两个 Provider 都给 failed", () => {
    const codex = classifyCodexActivity({
      itemType: "commandExecution",
      phase: "completed",
      status: "failed",
      error: "Provider command exited with code 1",
    });
    const claude = classifyClaudeActivity({
      itemType: "tool_result",
      phase: "completed",
      status: "failed",
      toolName: "Bash",
      error: "exit 1",
    });

    expect(codex).toEqual({ activityKind: "command", outcome: "failed" });
    expect(claude).toEqual(codex);
  });

  it("同一次文件修改：两个 Provider 都归到 file-change", () => {
    const codex = classifyCodexActivity({ itemType: "fileChange", phase: "completed", status: "completed" });
    const claude = classifyClaudeActivity({ itemType: "tool_result", phase: "completed", status: "succeeded", toolName: "Edit" });

    expect(codex).toEqual({ activityKind: "file-change", outcome: "succeeded" });
    expect(claude).toEqual(codex);
  });

  it("**Codex 的 completed 就是成功** —— 这条曾经缺失，是全库 0 条成功的直接原因", () => {
    expect(activityOutcome({ kind: "command", phase: "completed", status: "completed" })).toBe("succeeded");
    // 反过来：没有证据时不能猜成功。
    expect(activityOutcome({ kind: "command", phase: "completed" })).toBe("unknown");
    expect(activityOutcome({ kind: "command", phase: "started" })).toBe("running");
  });

  it("没有成败概念的类别返回 not-applicable，而不是 unknown", () => {
    // 推理流 / 用户消息 / 会话重建：给它们挂状态标签是噪音（全库 210/343 条属于这一类）。
    expect(classifyCodexActivity({ itemType: "reasoning", phase: "completed" })).toEqual({
      activityKind: "reasoning",
      outcome: "not-applicable",
    });
    expect(classifyCodexActivity({ itemType: "userMessage", phase: "completed" })).toEqual({
      activityKind: "message",
      outcome: "not-applicable",
    });
    expect(classifyCodexActivity({ itemType: "providerSession", phase: "completed" })).toEqual({
      activityKind: "session",
      outcome: "not-applicable",
    });
    expect(classifyClaudeActivity({ itemType: "providerSession", phase: "completed" })).toEqual({
      activityKind: "session",
      outcome: "not-applicable",
    });

    expect(isOutcomeFreeKind("reasoning")).toBe(true);
    expect(isOutcomeFreeKind("command")).toBe(false);
  });

  it("Claude 的 tool_use 与它的 tool_result 归到同一类别（否则投影合并时会闪变）", () => {
    const started = classifyClaudeActivity({ itemType: "tool_use", phase: "started", status: "started", toolName: "Bash" });
    const completed = classifyClaudeActivity({ itemType: "tool_result", phase: "completed", status: "succeeded", toolName: "Bash" });

    expect(started.activityKind).toBe(completed.activityKind);
    expect(started.outcome).toBe("running");
    expect(completed.outcome).toBe("succeeded");
  });

  it("MCP 调用先于 tool 判定，不被后者抢走", () => {
    expect(classifyCodexActivity({ itemType: "mcpToolCall", phase: "started" }).activityKind).toBe("mcp");
    expect(classifyClaudeActivity({ itemType: "tool_use", phase: "started", toolName: "mcp__files__read" }).activityKind).toBe("mcp");
    expect(classifyClaudeActivity({ itemType: "tool_use", phase: "started", toolName: "Read" }).activityKind).toBe("tool");
  });

  it("认不出的类别落到 other，而不是伪装成某个已知类别", () => {
    expect(classifyCodexActivity({ itemType: "somethingBrandNew", phase: "completed" }).activityKind).toBe("other");
  });
});

describe("四组类别与它们各自该有的归宿", () => {
  it("**Codex 明确拒绝掉的命令是 failed，不是 unknown** —— `declined` 曾漏在失败词表外", () => {
    // Codex 的 CommandExecutionStatus 是 inProgress / completed / failed / **declined**。
    // 词表里漏了最后一个，于是"Provider 说这条命令被拒了"被显示成「状态未知」——
    // 而"被拒"与"没记录到"是两句完全不同的话。
    expect(activityOutcome({ kind: "command", phase: "completed", status: "declined" })).toBe("failed");
    expect(classifyCodexActivity({ itemType: "commandExecution", phase: "completed", status: "declined" })).toEqual({
      activityKind: "command",
      outcome: "failed",
    });
    // Claude 侧的同一个事实拼作 permission_denied，两条词表必须落在同一格。
    expect(classifyClaudeActivity({ itemType: "permission_denied", phase: "completed", status: "denied" }).outcome).toBe("failed");
  });

  it("Codex 的 18 种 ThreadItem 每一种都有归宿，没有一种落进 other", () => {
    // 实测：本机库里 `plan`（58 条）与 `contextCompaction`（3 条）此前都落进 other，
    // 界面上显示成「未识别」——整篇规划文档与"上下文压缩发生在此处"被标成了认不出来的东西。
    const kinds = [
      "userMessage",
      "hookPrompt",
      "agentMessage",
      "plan",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "imageView",
      "imageGeneration",
      "sleep",
      "contextCompaction",
      "enteredReviewMode",
      "exitedReviewMode",
    ];
    const unknown = kinds.filter((itemType) => classifyCodexActivity({ itemType, phase: "completed" }).activityKind === "other");
    // `sleep` 是唯一一个还没定归宿的（等待既不是动作也不是运行事实）——记在这里，别让它悄悄变多。
    expect(unknown).toEqual(["sleep"]);

    expect(classifyCodexActivity({ itemType: "plan", phase: "completed" }).activityKind).toBe("message");
    expect(classifyCodexActivity({ itemType: "contextCompaction", phase: "completed" }).activityKind).toBe("compaction");
    expect(classifyCodexActivity({ itemType: "collabAgentToolCall", phase: "completed" }).activityKind).toBe("subagent");
    expect(classifyCodexActivity({ itemType: "subAgentActivity", phase: "completed" }).activityKind).toBe("subagent");
    expect(classifyCodexActivity({ itemType: "webSearch", phase: "completed" }).activityKind).toBe("search");
    expect(classifyCodexActivity({ itemType: "imageGeneration", phase: "completed" }).activityKind).toBe("media");
    expect(classifyCodexActivity({ itemType: "enteredReviewMode", phase: "completed" }).activityKind).toBe("review");
    expect(classifyCodexActivity({ itemType: "hookPrompt", phase: "completed" }).activityKind).toBe("hook");
  });

  it("Claude 的工具名也能分出子代理与联网搜索，不只是笼统的 tool", () => {
    expect(classifyClaudeActivity({ itemType: "tool_use", phase: "started", toolName: "Task" }).activityKind).toBe("subagent");
    expect(classifyClaudeActivity({ itemType: "tool_use", phase: "started", toolName: "WebSearch" }).activityKind).toBe("search");
    expect(classifyClaudeActivity({ itemType: "tool_use", phase: "started", toolName: "Read" }).activityKind).toBe("tool");
  });

  it("**④「Provider 说的」是一条可判定的判据**，不是各处白名单", () => {
    // 消费方（执行会话投影、Run 头诊断区）都问 isRuntimeKind，加一类不会漏一处。
    const runtime = ["session", "compaction", "hook", "task", "rate-limit", "retry", "permission", "warning", "review"] as const;
    for (const kind of runtime) expect(isRuntimeKind(kind)).toBe(true);
    const notRuntime = ["command", "file-change", "tool", "mcp", "search", "media", "subagent", "reasoning", "message", "other"] as const;
    for (const kind of notRuntime) expect(isRuntimeKind(kind)).toBe(false);

    // 需要浮到眼前的只是其中一部分：额度、重试、权限、告警、评审。
    expect(runtime.filter(isRuntimeAlertKind)).toEqual(["rate-limit", "retry", "permission", "warning", "review"]);
  });

  it("④ 里没有成败概念的那几类不画状态标签，钩子 / 子任务 / 权限被拒照常判成败", () => {
    for (const kind of ["compaction", "rate-limit", "retry", "warning", "review", "session"] as const) {
      expect(isOutcomeFreeKind(kind)).toBe(true);
    }
    // 钩子挂了、子任务失败了、权限被拒了——这三件事本身就是结论，不能被静默成"信息"。
    expect(classifyClaudeActivity({ itemType: "hook_response", phase: "completed", status: "failed", error: "exit 1" }).outcome).toBe(
      "failed",
    );
    expect(classifyClaudeActivity({ itemType: "task_notification", phase: "completed", status: "failed" }).outcome).toBe("failed");
    expect(isOutcomeFreeKind("hook")).toBe(false);
    expect(isOutcomeFreeKind("task")).toBe(false);
    expect(isOutcomeFreeKind("permission")).toBe(false);
  });
});
