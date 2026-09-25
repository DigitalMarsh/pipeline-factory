/**
 * 测试职责：验证 m2-plan-revision 模块的业务场景、异常分支和回归约束。
 * 设计说明：fixture 只构造本测试需要的持久化事实，边界行为优先于实现细节。
 * 维护提示：业务状态、错误条件或公共契约变化时，应同步调整对应场景。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService } from "./index.js";

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

  it("keeps immutable candidate snapshots and confirms only the latest generated version", () => {
    const store = new InMemoryPipelineStore();
    new ProjectService(store).create({ id: "project-1", name: "Project", repoRoot: "/repo/project", defaultBranch: "main", worktreeRoot: "/tmp/project-worktrees" });
    const service = new PlanService(store);
    const thread = service.registerThread({ id: "candidate-history-thread", projectId: "project-1", parentThreadId: null });
    const requirement = store.listExplorerPlans(thread.id)[0]!;
    const candidate = service.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: thread.id, explorerPlanId: requirement.id, title: "Plan V1" });
    const source = { sourceTurnId: "turn-2", providerThreadId: null, providerTurnId: null, providerItemId: null };
    const second = service.reviseCandidate(candidate.id, { title: "Plan V2", contract: { ...candidate.contract, goal: "Second goal" } }, source);
    const third = service.reviseCandidate(candidate.id, { title: "Plan V3", contract: { ...second.contract, goal: "Third goal" } }, { ...source, sourceTurnId: "turn-3" });

    expect(store.listCandidateVersions(candidate.id).map((version) => [version.revision, version.title, version.contract.goal])).toEqual([
      [1, "Plan V1", "Plan V1"], [2, "Plan V2", "Second goal"], [3, "Plan V3", "Third goal"],
    ]);
    expect(() => service.confirm(candidate.id, "user-1", 2)).toThrow("REVISION_NOT_LATEST");
    expect(service.confirm(candidate.id, "user-1", 3)).toMatchObject({ revision: 3, status: "READY" });
    expect(store.listCandidateVersions(candidate.id)[0]).toMatchObject({ revision: 1, title: "Plan V1", status: "DRAFT" });
    expect(() => service.reviseCandidate(candidate.id, { title: "Must stay read only", contract: third.contract }, source)).toThrow("Only an unconfirmed Plan can be edited");
  });
});
