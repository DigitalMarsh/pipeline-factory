import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService, VerificationService, assessPlanCompletion, parseGeneratedPlanSpecV2, resolvePlanContractV2, validateGeneratedPlanSpecV2, type PlanRevisionV2, type ProjectExecutionSnapshot, type Run } from "../index.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-plan-dependencies-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "--allow-empty", "-m", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

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
  it("accepts historical V2 specs without the new detail fields", () => {
    expect(() => parseGeneratedPlanSpecV2(spec)).not.toThrow();
    const contract = resolvePlanContractV2(spec, snapshot(["project.test"]), { baseBranch: "main", baseCommit: "a".repeat(40) });
    expect(contract).toMatchObject({ schemaVersion: 2, tasks: [{ id: "docs" }] });
  });

  it("requires the new detail fields at the Explorer completion gate", () => {
    const protocol = (artifact: unknown) => `<pipeline-factory-plan-status>READY</pipeline-factory-plan-status><pipeline-factory-plan>${JSON.stringify(artifact)}</pipeline-factory-plan>`;
    const incomplete = assessPlanCompletion(protocol(spec));
    expect(incomplete.status).toBe("INCOMPLETE");
    expect(incomplete.diagnostics.map((item) => item.path)).toEqual(expect.arrayContaining(["objective.context", "design.risks", "tasks[0].changes"]));

    const detailed = { ...spec, objective: { ...spec.objective, context: ["Existing docs entrypoint is the current source of truth."] }, design: { ...spec.design, risks: ["Keep the previous docs section intact if validation fails."] }, tasks: [{ ...spec.tasks[0]!, changes: [{ path: "docs/vue-usage.md", action: "modify" as const, detail: "Update the usage example without changing the runtime API." }] }] };
    const complete = assessPlanCompletion(protocol(detailed));
    expect(complete.status).toBe("READY");
  });

  it("validates task change records when they are present", () => {
    const invalid = validateGeneratedPlanSpecV2({ ...spec, tasks: [{ ...spec.tasks[0], changes: [{ path: "../escape", action: "rename", detail: "bad" }] }] });
    expect(invalid.map((item) => item.path)).toEqual(expect.arrayContaining(["tasks[0].changes[0].path", "tasks[0].changes[0].action"]));
  });
  it("derives Project verification order and never accepts model command ids", () => {
    const contract = resolvePlanContractV2(spec, snapshot(["project.test"]), { baseBranch: "main", baseCommit: "a".repeat(40) });
    expect(contract).toMatchObject({ schemaVersion: 2, repository: { projectId: "project-test", configVersion: 3 }, scope: { includePaths: ["docs/vue-usage.md"] }, verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.test"] } });
    expect(() => parseGeneratedPlanSpecV2({ ...spec, verificationCommandIds: ["docs.file-and-section-check"] })).toThrow(/只能由 Factory/i);
  });

  it("keeps natural-language prerequisites as technical constraints, separate from plan dependencies", () => {
    const root = repository();
    try {
      const store = new InMemoryPipelineStore();
      const projects = new ProjectService(store);
      const project = projects.create({ id: "project-prerequisites", name: "Prerequisites", repoRoot: root, defaultBranch: "main", worktreeRoot: join(root, "worktrees") });
      const plans = new PlanService(store, projects);
      const generatedSpec = { ...spec, dependencies: ["Node.js 22 or compatible version", "pnpm"] };
      const candidate = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-prerequisites", title: generatedSpec.title, generatedSpec });

      expect(candidate.contract.dependsOnPlanIds).toEqual([]);
      expect(candidate.resolvedContract?.dependencies).toEqual(generatedSpec.dependencies);
      expect(candidate.resolvedContract?.design.technicalConstraints).toEqual(expect.arrayContaining(generatedSpec.dependencies));

      // 旧实现会在 confirm 时把这些自然语言先决条件从 dependsOnPlanIds 里"顺手删掉"。
      // 那条启发式同时会删掉**用户显式设置的**依赖（id 恰好出现在先决条件里就会中招），
      // 现在只做校验、不动数据：以下写法会因引用未知 Plan 而明确失败。
      store.updatePlan({ ...candidate, contract: { ...candidate.contract, dependsOnPlanIds: generatedSpec.dependencies } });
      expect(() => plans.confirm(candidate.id, "user-1")).toThrow(/unknown plan/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a human set prerequisite plans but never the model", () => {
    const root = repository();
    try {
      const store = new InMemoryPipelineStore();
      const projects = new ProjectService(store);
      const project = projects.create({ id: "project-deps", name: "Deps", repoRoot: root, defaultBranch: "main", worktreeRoot: join(root, "worktrees") });
      const plans = new PlanService(store, projects);
      const upstream = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-deps", title: "Upstream", generatedSpec: { ...spec, title: "Upstream" } });
      const downstream = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-deps", title: "Downstream", generatedSpec: { ...spec, title: "Downstream" } });

      // 模型给出的 dependencies 是自然语言先决条件，**不是** plan id；依赖只能由人设置。
      expect(downstream.contract.dependsOnPlanIds).toEqual([]);
      const withDependency = plans.setDependencies(downstream.id, [upstream.id], "user-1");
      expect(withDependency.contract.dependsOnPlanIds).toEqual([upstream.id]);
      // 依赖随 Revision 冻结：confirm 后不能再改。
      const confirmed = plans.confirm(downstream.id, "user-1");
      expect(confirmed.contract.dependsOnPlanIds).toEqual([upstream.id]);
      expect(plans.getRevision(downstream.id, 1)?.contract.dependsOnPlanIds).toEqual([upstream.id]);
      expect(() => plans.setDependencies(downstream.id, [], "user-1")).toThrow(/cannot change from READY/);

      // 引用未知 Plan 会被拒绝，而不是留到 dispatch 时才变成等一个不存在的依赖。
      const other = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-deps", title: "Other", generatedSpec: { ...spec, title: "Other" } });
      expect(() => plans.setDependencies(other.id, ["plan-does-not-exist"], "user-1")).toThrow(/unknown plan/i);
      // 自环也被拒绝。
      expect(() => plans.setDependencies(other.id, [other.id], "user-1")).toThrow(/cannot depend on itself/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("Plan V2 verification suites", () => {
  /** 三条默认验证命令各自带 tag，外加一条**不在默认集合里**的 lint 命令。 */
  function taggedSnapshot(defaultVerificationCommandIds = ["project.test", "project.typecheck", "docs.validate"]): ProjectExecutionSnapshot {
    return {
      projectId: "project-tags", name: "Tags", shortName: "T", repoRoot: "/repo/tags", defaultBranch: "main", worktreeRoot: "/tmp/tags-worktrees", configVersion: 1, configHash: "sha256:tags",
      settings: {
        concurrency: { maxParallelRuns: 1, defaultTimeoutMs: 1_000, executionTimeoutMs: 1_000, maxAutoContinuationTurns: 0, maxRepairAttempts: 2 },
        commands: [
          { commandId: "project.test", category: "verification", enabled: true, argv: ["pnpm", "test"], tags: ["unit"] },
          { commandId: "project.typecheck", category: "verification", enabled: true, argv: ["pnpm", "typecheck"], tags: ["types"] },
          { commandId: "docs.validate", category: "verification", enabled: true, argv: ["pnpm", "docs:check"], tags: ["docs"] },
          { commandId: "project.lint", category: "verification", enabled: true, argv: ["pnpm", "lint"], tags: ["lint"] },
        ],
        defaultVerificationCommandIds,
        hooks: {},
        models: { explorer: { model: "test" }, executor: { model: "test" } },
        toolPolicy: { allowedMcpTools: [], allowedPluginTools: [], computerUseEnabled: false },
      },
    };
  }

  const baseline = { baseBranch: "main", baseCommit: "a".repeat(40) };

  it("keeps the full default set when the Plan declares no suites", () => {
    expect(resolvePlanContractV2(spec, taggedSnapshot(), baseline).verification).toEqual({ mode: "PROJECT_DEFAULT", commandIds: ["project.test", "project.typecheck", "docs.validate"] });
  });

  it("resolves requested tags into a subset of the Project default commands, in default order", () => {
    const single = resolvePlanContractV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["docs"] } }, taggedSnapshot(), baseline);
    expect(single.verification).toEqual({ mode: "PROJECT_DEFAULT", commandIds: ["docs.validate"] });

    const multiple = resolvePlanContractV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["types", "unit"] } }, taggedSnapshot(), baseline);
    // 顺序跟项目默认集合，不跟 Plan 里写的顺序——命令执行顺序是 Project 的配置。
    expect(multiple.verification.commandIds).toEqual(["project.test", "project.typecheck"]);
  });

  it("rejects tags the Project never declared instead of silently running something else", () => {
    expect(() => resolvePlanContractV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["documentation"] } }, taggedSnapshot(), baseline))
      .toThrow(/not declared by this Project: documentation.*Declared tags: docs, lint, types, unit/s);
  });

  it("rejects a declared tag that matches none of the default commands", () => {
    // lint 是已登记 tag，但那条命令不在默认集合里：命中为空必须报错，而不是退化成"空验证集"。
    expect(() => resolvePlanContractV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["lint"] } }, taggedSnapshot(), baseline))
      .toThrow(/match none of the Project default verification commands/);
  });

  it("validates the suites shape and its conflict with mode NONE", () => {
    expect(validateGeneratedPlanSpecV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: [] } })).toEqual([expect.objectContaining({ path: "verification.suites", code: "INVALID" })]);
    expect(validateGeneratedPlanSpecV2({ ...spec, verification: { mode: "NONE", suites: ["docs"] } })).toEqual([expect.objectContaining({ path: "verification.suites", code: "MODE_CONFLICT" })]);
    expect(validateGeneratedPlanSpecV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["docs", ""] } })).toEqual([expect.objectContaining({ path: "verification.suites", code: "INVALID" })]);
    expect(validateGeneratedPlanSpecV2({ ...spec, verification: { mode: "PROJECT_DEFAULT", suites: ["docs"] } })).toEqual([]);
  });

  it("lets a human re-pick the verification subset on a candidate and re-resolves the command ids", () => {
    const root = repository();
    try {
      const store = new InMemoryPipelineStore();
      const projects = new ProjectService(store);
      const project = projects.create({
        id: "project-suite-edit", name: "Suite edit", repoRoot: root, defaultBranch: "main", worktreeRoot: join(root, "worktrees"),
        settings: {
          commands: [
            { commandId: "project.test", category: "verification", enabled: true, argv: ["true"], tags: ["unit"] },
            { commandId: "docs.validate", category: "verification", enabled: true, argv: ["true"], tags: ["docs"] },
          ],
          defaultVerificationCommandIds: ["project.test", "docs.validate"],
        },
      });
      const plans = new PlanService(store, projects);
      const candidate = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: "explorer-suite-edit", title: spec.title, generatedSpec: spec });
      // 生成时没声明 suites → 项目默认全集。
      expect(candidate.resolvedContract?.verification.commandIds).toEqual(["project.test", "docs.validate"]);

      // 人选了 docs → 只跑命中该 tag 的命令；V1 投影（contract）跟着一起更新，两处不能分叉。
      const narrowed = plans.setVerificationSuites(candidate.id, ["docs"], "reviewer");
      expect(narrowed.generatedSpec?.verification).toEqual({ mode: "PROJECT_DEFAULT", suites: ["docs"] });
      expect(narrowed.resolvedContract?.verification.commandIds).toEqual(["docs.validate"]);
      expect(narrowed.contract.verificationCommandIds).toEqual(["docs.validate"]);
      expect(store.listEvents({ types: ["plan.verification.suites.updated"] })).toHaveLength(1);

      // 空数组 = 回到项目默认全集（不是"什么都不跑"）。
      expect(plans.setVerificationSuites(candidate.id, [], "reviewer").resolvedContract?.verification.commandIds).toEqual(["project.test", "docs.validate"]);
      // 未登记的 tag 仍然被拒绝，理由与生成路径一致。
      expect(() => plans.setVerificationSuites(candidate.id, ["nope"], "reviewer")).toThrow(/not declared by this Project/);
      // 确认之后不能再改（与依赖同一条规则：确认即冻结）。
      plans.confirm(candidate.id, "reviewer");
      expect(() => plans.setVerificationSuites(candidate.id, ["docs"], "reviewer")).toThrow(/cannot change from READY/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
