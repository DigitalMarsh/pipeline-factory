/**
 * 测试职责：安装包不携带 Claude Agent SDK 时，只有在真正使用 Claude 后端才报错，
 * 且错误信息能指向解决办法；Codex 等其他后端不受影响（模块能正常导入）。
 */
import { describe, expect, it } from "vitest";
import { ClaudeAgentSdkGateway } from "../index.js";
import type { ModelEvent } from "../index.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Claude Agent SDK loading", () => {
  it("fails the turn with a diagnosable error when the SDK is not installed", async () => {
    const gateway = new ClaudeAgentSdkGateway({
      roles: { explorer: { model: "claude-opus-5" }, executor: { model: "claude-opus-5" } },
      sdkPath: "/nonexistent/pipeline-factory/claude-agent-sdk.mjs",
    });

    const events = await collect(
      gateway.stream({
        role: "explorer",
        messages: [{ role: "user", content: "你好" }],
      }),
    );
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed && failed.type === "turn.failed" ? failed.error : "").toMatch(/CLAUDE_AGENT_SDK_UNAVAILABLE/);
    expect(failed && failed.type === "turn.failed" ? failed.error : "").toContain("sdkPath");
  });
});
