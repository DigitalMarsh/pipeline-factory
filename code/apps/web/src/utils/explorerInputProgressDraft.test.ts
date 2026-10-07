import { describe, expect, it } from "vitest";
import type { ExplorerInputRequest } from "../types";
import {
  clearExplorerInputProgressDraft,
  explorerInputProgressDraftKey,
  loadExplorerInputProgressDraft,
  saveExplorerInputProgressDraft,
} from "./explorerInputProgressDraft";

const scope = { projectId: "project-1", threadId: "explorer-1", explorerPlanId: "requirement-1" };
const request: ExplorerInputRequest = {
  id: "request-1",
  threadId: scope.threadId,
  explorerPlanId: scope.explorerPlanId,
  localTurnId: "turn-1",
  providerRequestId: "provider-request-1",
  providerThreadId: "provider-thread-1",
  providerTurnId: "provider-turn-1",
  itemId: "item-1",
  questions: [
    { id: "delivery", header: "交付方式", question: "如何交付？", isOther: false, isSecret: false, options: null },
    { id: "credential", header: "凭据", question: "输入凭据", isOther: true, isSecret: true, options: null },
  ],
  isBlocking: true,
  status: "OPEN",
  createdAt: "2026-09-27T00:00:00.000Z",
  answeredAt: null,
  answeredBy: null,
  redactedAnswerSummary: null,
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

describe("Explorer input progress drafts", () => {
  it("restores non-secret selections and never stores secret answers", () => {
    const storage = memoryStorage();
    saveExplorerInputProgressDraft(
      scope,
      request,
      {
        requestId: request.id,
        currentIndex: 1,
        values: { delivery: ["Markdown 文件"], credential: [] },
        otherValues: { credential: "private-token" },
      },
      storage,
    );

    const raw = storage.values.get(explorerInputProgressDraftKey(scope, request.id));
    expect(raw).toContain("Markdown 文件");
    expect(raw).not.toContain("private-token");
    expect(loadExplorerInputProgressDraft(scope, request, storage)).toEqual({
      requestId: request.id,
      currentIndex: 1,
      values: { delivery: ["Markdown 文件"] },
      otherValues: {},
    });
  });

  it("clamps the restored question index and clears a completed request draft", () => {
    const storage = memoryStorage();
    saveExplorerInputProgressDraft(
      scope,
      request,
      {
        requestId: request.id,
        currentIndex: 99,
        values: { delivery: ["Markdown 文件"] },
        otherValues: {},
      },
      storage,
    );
    expect(loadExplorerInputProgressDraft(scope, request, storage)?.currentIndex).toBe(1);

    clearExplorerInputProgressDraft(scope, request.id, storage);
    expect(loadExplorerInputProgressDraft(scope, request, storage)).toBeNull();
  });
});
