import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService } from "./index.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-revision-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "--allow-empty", "-m", "init"], { cwd: root });
  return root;
}

describe("PlanRevisionDraft", () => {
  it("keeps one planId while V1 becomes V2, V3 and V4 through idempotent drafts", () => {
    const root = repository();
    try {
      const store = new InMemoryPipelineStore();
      const projects = new ProjectService(store);
      const project = projects.create({ id: "project-1", name: "Revision", repoRoot: root, defaultBranch: "main", worktreeRoot: join(root, "worktrees") });
      const plans = new PlanService(store, projects);
      plans.registerThread({ id: "explorer-1", projectId: project.id, parentThreadId: null });
      const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-1", title: "Versioned plan" });
      plans.confirm(plan.id, "user");

      for (const revision of [1, 2, 3]) {
        const draft = plans.createRevisionDraft({ planId: plan.id, fromRevision: revision, explorerThreadId: "explorer-1", discardUnmergedRun: false, clientRequestId: `draft-${revision}` });
        expect(plans.createRevisionDraft({ planId: plan.id, fromRevision: revision, explorerThreadId: "explorer-1", discardUnmergedRun: false, clientRequestId: `retry-${revision}` }).draftId).toBe(draft.draftId);
        plans.updateRevisionDraftFromExplorer(draft.draftId, { title: `Versioned plan V${revision + 1}`, contract: draft.contract }, { sourceTurnId: `turn-${revision}`, providerThreadId: "provider", providerTurnId: `provider-turn-${revision}`, providerItemId: `item-${revision}` });
        expect(plans.confirmRevisionDraft(draft.draftId, "user")).toMatchObject({ id: plan.id, revision: revision + 1, status: "READY" });
      }
      expect(plans.listRevisions(plan.id).map((item) => item.revision)).toEqual([1, 2, 3, 4]);
      expect(store.listRevisionLifecycleProjections(project.id, plan.id).map((item) => item.revision)).toEqual([2, 3, 4]);
      expect(() => plans.createRevisionDraft({ planId: plan.id, fromRevision: 2, explorerThreadId: "explorer-1", discardUnmergedRun: false, clientRequestId: "restore" })).not.toThrow();
      expect(store.getRevisionDraft(store.listRevisionDrafts(plan.id).at(-1)!.draftId)).toMatchObject({ basedOnRevision: 2, targetRevision: 5 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
