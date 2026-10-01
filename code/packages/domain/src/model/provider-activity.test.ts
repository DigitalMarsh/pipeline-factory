/**
 * 测试职责：钉住"同一种逻辑活动，无论由哪个 agent 执行，都得到同一个类别与同一个成败"。
 *
 * 为什么单独写这个文件：这条等价性是整个中立词表的**唯一目的**。两个 Provider 的原生词表完全不通用
 *   （Codex：commandExecution/completed；Claude：tool_use/tool_result/succeeded），此前 UI 各自
 *   正则猜标签、各自维护成败白名单，于是同一个动作换个 agent 就换个名字，而 Codex 的成功词
 *   `completed` 不在成功白名单里——全库 343 条"状态未知"、0 条成功。这里逐对断言，防止两边再次分叉。
 */
import { describe, expect, it } from "vitest";
import { activityOutcome, classifyClaudeActivity, classifyCodexActivity, isOutcomeFreeKind } from "./provider-activity.js";

describe("provider 活动的中立词表", () => {
  it("同一条命令：两个 Provider 给出同一个类别与同一个成败", () => {
    const codex = classifyCodexActivity({ itemType: "commandExecution", phase: "completed", status: "completed" });
    const claude = classifyClaudeActivity({ itemType: "tool_result", phase: "completed", status: "succeeded", toolName: "Bash" });

    expect(codex).toEqual({ activityKind: "command", outcome: "succeeded" });
    expect(claude).toEqual(codex);
  });

  it("同一条失败的命令：两个 Provider 都给 failed", () => {
    const codex = classifyCodexActivity({ itemType: "commandExecution", phase: "completed", status: "failed", error: "Provider command exited with code 1" });
    const claude = classifyClaudeActivity({ itemType: "tool_result", phase: "completed", status: "failed", toolName: "Bash", error: "exit 1" });

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
    // 推理流 / 用户消息 / 会话重建：给它们挂状态 chip 是噪音（全库 210/343 条属于这一类）。
    expect(classifyCodexActivity({ itemType: "reasoning", phase: "completed" })).toEqual({ activityKind: "reasoning", outcome: "not-applicable" });
    expect(classifyCodexActivity({ itemType: "userMessage", phase: "completed" })).toEqual({ activityKind: "message", outcome: "not-applicable" });
    expect(classifyCodexActivity({ itemType: "providerSession", phase: "completed" })).toEqual({ activityKind: "session", outcome: "not-applicable" });
    expect(classifyClaudeActivity({ itemType: "providerSession", phase: "completed" })).toEqual({ activityKind: "session", outcome: "not-applicable" });

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
