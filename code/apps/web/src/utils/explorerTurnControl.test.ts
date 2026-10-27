/**
 * 测试职责：锁住"停止按钮指向哪一条回合"的取值规则。
 */
import { describe, expect, it } from "vitest";
import type { ExplorerTurn } from "../types";
import { stoppableExplorerTurn } from "./explorerTurnControl";

function turn(id: string, status: NonNullable<ExplorerTurn["status"]>, role: ExplorerTurn["role"] = "assistant"): ExplorerTurn {
  return { id, threadId: "thread-1", role, content: "", status, createdAt: "2026-10-27T10:00:00.000Z", sequence: 1 };
}

describe("可以停止的回合", () => {
  it("没有回合时是 null", () => {
    expect(stoppableExplorerTurn([])).toBeNull();
  });

  it("只有已结束的回合时是 null", () => {
    expect(stoppableExplorerTurn([turn("done", "COMPLETED"), turn("failed", "FAILED"), turn("cancelled", "CANCELLED")])).toBeNull();
  });

  it("进行中的助手回合就是停止目标", () => {
    expect(stoppableExplorerTurn([turn("done", "COMPLETED"), turn("running", "RUNNING")])?.id).toBe("running");
  });

  it("排队、暂停、等待输入都算（服务端都能取消）", () => {
    expect(stoppableExplorerTurn([turn("queued", "QUEUED")])?.id).toBe("queued");
    expect(stoppableExplorerTurn([turn("paused", "PAUSED")])?.id).toBe("paused");
    expect(stoppableExplorerTurn([turn("waiting", "WAITING_FOR_INPUT")])?.id).toBe("waiting");
  });

  it("正在跑的那一轮优先于排队的那一条", () => {
    expect(stoppableExplorerTurn([turn("running", "RUNNING"), turn("queued", "QUEUED")])?.id).toBe("running");
  });

  it("只有排队回合时，停止最新入队的一条", () => {
    expect(stoppableExplorerTurn([turn("queued-a", "QUEUED"), turn("queued-b", "QUEUED")])?.id).toBe("queued-b");
  });

  it("用户回合永远不是停止目标", () => {
    expect(stoppableExplorerTurn([turn("user", "RUNNING", "user")])).toBeNull();
  });

  it("缺状态的旧行跳过", () => {
    const { status: _status, ...legacy } = turn("legacy", "RUNNING");
    expect(stoppableExplorerTurn([legacy])).toBeNull();
  });
});
