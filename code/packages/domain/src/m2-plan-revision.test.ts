/**
 * 测试职责：验证 m2-plan-revision 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService } from "./index.js";

describe("PlanRevisionV2", () => {
  it("freezes the execution contract and records a stable artifact hash on confirmation", () => {
    const service = new PlanService(new InMemoryPipelineStore());
    const candidate = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Freeze this plan" });
    service.confirm(candidate.id, "user-1");

    const revision = service.getRevision(candidate.id, 1);
    expect(revision).toMatchObject({ planId: candidate.id, revision: 1, confirmedBy: "user-1", artifactHash: expect.stringMatching(/^sha256:/) });
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.contract)).toBe(true);
    expect(service.enqueue(candidate.id).revision).toBe(1);
  });
});
