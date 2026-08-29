import { describe, expect, it } from "vitest";
import { projectExplorerActivity } from "./explorer-activity.js";

describe("Explorer activity projection", () => {
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
});
