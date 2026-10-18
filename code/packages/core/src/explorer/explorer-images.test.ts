/**
 * 测试职责：**Explorer 回合把图片带进模型请求**——用户回合的附件必须在 `ModelRequest.messages`
 *   里以 `images` 出现，即使这一轮同时带了 `continuationPrompt`（planBoundary）。
 *
 * 为什么单独一条：模型层测试只验证"给了 images 就会发"，而这次实测的根因在服务层与
 *   Provider 条件的组合——Explorer 每轮都设置 continuationPrompt，Provider 曾因此把图丢掉。
 *   这条用例从 `startTurn` 一路走到 ModelGateway，锁住"附件 → 回合 → 请求"的完整链。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { ProjectService } from "../project/project.js";
import { ExplorerService } from "./service.js";
import { ExplorerThreadService } from "./thread-service.js";
import type { ModelEvent, ModelGateway, ModelRequest, ModelRole, ModelRoleConfig } from "../model/types.js";

function createModelRecorder(): { model: ModelGateway; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const roles: Record<ModelRole, ModelRoleConfig> = {
    explorer: { model: "test-explorer" },
    executor: { model: "test-executor" },
  };
  const model: ModelGateway = {
    stream: async function* (request): AsyncIterable<ModelEvent> {
      requests.push(request);
      yield { type: "turn.completed" };
    },
    answerUserInput: async () => undefined,
    cancel: async () => undefined,
    configFor: (role) => roles[role],
  };
  return { model, requests };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the model request");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("explorer turn images", () => {
  it("passes the user turn's attachments into the model request together with the plan boundary", async () => {
    const store = new InMemoryPipelineStore();
    new ProjectService(store).create({
      id: "project-1",
      name: "project-1",
      repoRoot: "/repo/project-1",
      defaultBranch: "main",
      worktreeRoot: "/tmp/project-1-worktrees",
    });
    const explorer = new ExplorerService(store);
    const thread = explorer.create({ projectId: "project-1" });
    const plan = store.listExplorerPlans(thread.id)[0]!;
    store.saveAttachment({
      id: "attachment-1",
      projectId: "project-1",
      ownerType: null,
      ownerId: null,
      fileName: "shot.png",
      mimeType: "image/png",
      byteSize: 70,
      relativePath: "attachments/project-1/attachment-1.png",
      createdAt: store.now(),
    });

    const { model, requests } = createModelRecorder();
    const service = new ExplorerThreadService(store, model, {
      attachmentPathFor: (attachment) => `/abs/${attachment.id}.png`,
    });

    await service.startTurn({
      threadId: thread.id,
      explorerPlanId: plan.id,
      content: "这张截图是什么颜色？",
      clientTurnId: "turn-1",
      attachmentIds: ["attachment-1"],
    });

    await waitFor(() => requests.length > 0);
    const request = requests[0]!;
    const userMessage = request.messages.find((message) => message.role === "user" && message.content === "这张截图是什么颜色？");
    expect(userMessage?.images).toEqual([{ path: "/abs/attachment-1.png", mimeType: "image/png" }]);
    // 这一轮确实带着 planBoundary——图片不能因为它的存在而被丢掉。
    expect(request.continuationPrompt).toContain("这张截图是什么颜色？");
  });
});
