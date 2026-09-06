import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, VerificationService, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2, type PlanRevisionV2, type ProjectExecutionSnapshot, type Run } from "./index.js";

const spec = {
  schemaVersion: 2 as const,
  title: "ProjectTest documentation update",
  artifact: { mode: "REPOSITORY_FILE" as const, path: "docs/vue-usage.md" },
  objective: { goal: "Document the selected feature", audience: ["Vue developers"], acceptanceCriteria: ["The guide is updated"], outOfScope: ["No runtime changes"] },
  design: { technicalConstraints: ["Use Markdown"], dataSecurity: ["No personal data"], failureHandling: ["Keep existing docs when validation fails"] },
  scope: { includePaths: ["docs/vue-usage.md"], excludePaths: ["dist/**"] },
  tasks: [{ id: "docs", title: "Update guide", dependencies: [], status: "READY" as const }],
  dependencies: [], conflicts: [], execution: {}, verification: { mode: "PROJECT_DEFAULT" as const }, merge: { strategy: "manual" as const, requireHumanMerge: true as const },
};

function snapshot(defaultVerificationCommandIds: string[] = []): ProjectExecutionSnapshot {
  return { projectId: "project-test", name: "ProjectTest", shortName: "PT", repoRoot: "/repo/projecttest", defaultBranch: "main", worktreeRoot: "/tmp/worktrees", configVersion: 3, configHash: "sha256:config", settings: { concurrency: { maxParallelRuns: 1, defaultTimeoutMs: 1_000, executionTimeoutMs: 1_000, maxAutoContinuationTurns: 0, maxRepairAttempts: 2 }, commands: [{ commandId: "project.test", category: "verification", enabled: true, argv: ["pnpm", "test"] }], defaultVerificationCommandIds, hooks: {}, models: { explorer: { model: "test" }, executor: { model: "test" } }, toolPolicy: { allowedMcpTools: [], allowedPluginTools: [], computerUseEnabled: false } } };
}

describe("Plan V2 resolution", () => {
  it("derives Project verification order and never accepts model command ids", () => {
    const contract = resolvePlanContractV2(spec, snapshot(["project.test"]), { baseBranch: "main", baseCommit: "a".repeat(40) });
    expect(contract).toMatchObject({ schemaVersion: 2, repository: { projectId: "project-test", configVersion: 3 }, scope: { includePaths: ["docs/vue-usage.md"] }, verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test"] } });
    expect(() => parseGeneratedPlanSpecV2({ ...spec, verificationCommandIds: ["docs.file-and-section-check"] })).toThrow(/只能由 Factory/i);
  });

  it("rejects absolute and traversal scopes and resolves an empty Project set to NONE", () => {
    expect(() => parseGeneratedPlanSpecV2({ ...spec, scope: { includePaths: ["/tmp/escape"], excludePaths: [] } })).toThrow(/项目根相对路径/i);
    expect(() => parseGeneratedPlanSpecV2({ ...spec, scope: { includePaths: ["../escape"], excludePaths: [] } })).toThrow(/项目根相对路径/i);
    expect(resolvePlanContractV2(spec, snapshot(), { baseBranch: "main", baseCommit: "b".repeat(40) }).verification).toEqual({ mode: "NONE", commandIds: [] });
  });

  it("collects every invalid field and supports review-only conversation artifacts", () => {
    const issues = validateGeneratedPlanSpecV2({ ...spec, artifact: { mode: "REPOSITORY_FILE" }, scope: { includePaths: [], excludePaths: [] }, objective: { ...spec.objective, audience: [] }, design: { ...spec.design, dataSecurity: [] } });
    expect(issues.map((item) => item.path)).toEqual(expect.arrayContaining(["artifact.path", "scope.includePaths", "objective.audience", "design.dataSecurity"]));
    expect(parseGeneratedPlanSpecV2({ ...spec, artifact: { mode: "CONVERSATION" }, scope: { includePaths: [], excludePaths: [] }, verification: { mode: "NONE" } })).toMatchObject({ artifact: { mode: "CONVERSATION" }, scope: { includePaths: [] } });
    expect(validateGeneratedPlanSpecV2({ ...spec, artifact: { mode: "CONVERSATION" }, scope: { includePaths: ["docs/vue-usage.md"], excludePaths: [] }, verification: { mode: "PROJECT_DEFAULT" } }).map((item) => item.path)).toEqual(expect.arrayContaining(["scope.includePaths", "verification.mode"]));
  });

  it("records empty default verification as SKIPPED and allows review", async () => {
    const store = new InMemoryPipelineStore();
    const resolvedContract = resolvePlanContractV2(spec, snapshot(), { baseBranch: "main", baseCommit: "c".repeat(40) });
    const revision: PlanRevisionV2 = { planId: "plan-v2", revision: 1, contract: { goal: "x", acceptanceCriteria: ["x"], include: ["docs/vue-usage.md"], exclude: [], baseBranch: "main", baseCommit: "c".repeat(40), tasks: [{ id: "docs", title: "Update", dependencies: [], status: "READY" }], conflictKeys: [], executorModelRole: "executor", toolPolicy: "executor-scoped-write", verificationCommandIds: [], maxRepairAttempts: 2, mergeStrategy: "manual", requireHumanMerge: true }, resolvedContract, artifactHash: "sha256:test", confirmedBy: "tester", confirmedAt: store.now(), sourceExplorerThreadId: "explorer" };
    const run: Run = { id: "run-v2", projectId: "project-test", planId: "plan-v2", planRevision: 1, status: "READY_FOR_VERIFY", branch: "factory/run-v2", workspacePath: "/tmp/run-v2", baseCommit: "c".repeat(40), executionThreadId: "execution", createdAt: store.now(), startedAt: store.now() };
    await expect(new VerificationService(store).verify(run, revision, async () => ({ exitCode: 1, stdout: "", stderr: "must not run" }))).resolves.toMatchObject({ status: "SKIPPED", reason: "NO_PROJECT_VERIFICATION_COMMANDS", commandResults: [] });
    expect(run.status).toBe("MERGE_READY");
  });
});
