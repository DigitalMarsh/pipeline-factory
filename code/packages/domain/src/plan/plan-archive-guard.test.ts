/**
 * 测试职责：Factory 自己的**计划留档目录**是执行者的禁区。
 *
 * 事故（2026-10-11，project4）：Explorer 把 `docs/pipeline/plans/**` 写成了方案的 `artifact.path`
 * 与改动目标，Executor 于是在留档目录里创建了一个与 Factory **同名同路径**的文件
 * （`plan-<id>-v<rev>.md`），提交后随合并进了主干——Factory 自己的留档被一份执行报告顶掉。
 *
 * 两道闸门都在 `PlanService.confirm`（唯一必经点）：
 *   1) 指向留档目录的方案**被拒绝**（`PLAN_ARCHIVE_PATH_FORBIDDEN`），且不留下任何 Revision；
 *   2) 其余方案照常放行，但留档目录**永远并进 `scope.excludePaths`**——执行者的系统提示与
 *      工作区范围检查都读它，"宽范围（`docs/**`）扫进来"也因此写不进去。
 *
 * 没有注入落盘目录时（测试与不落盘的部署）整步跳过，行为与改动前逐字相同。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryPipelineStore, PlanService, ProjectService } from "../index.js";
import { planContractFixture } from "./plan-fixture.js";

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { planDirectory?: boolean; git?: boolean } = {}) {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  const repoRoot = mkdtempSync(join(tmpdir(), "pipeline-plan-archive-"));
  temporaryRoots.push(repoRoot);
  if (options.git) {
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Pipeline Test", "-c", "user.email=pipeline@test", "commit", "--allow-empty", "-m", "init"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  }
  projects.create({ id: "project-1", name: "Project", repoRoot, defaultBranch: "main", worktreeRoot: join(repoRoot, "worktrees") });
  const service =
    options.planDirectory === false
      ? new PlanService(store, projects)
      : new PlanService(store, projects, undefined, (root: string) => join(root, "docs/pipeline/plans"));
  return { store, service, repoRoot };
}

describe("计划留档目录的保护", () => {
  it("把留档目录当产出目录的方案在确认时被拒绝，且不留 Revision", () => {
    const { store, service } = setup();
    const candidate = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Write into the archive",
      resolvedContract: planContractFixture({
        store,
        projectId: "project-1",
        artifact: { mode: "REPOSITORY_FILE", path: "docs/pipeline/plans/**" },
        tasks: [
          {
            id: "task-1",
            title: "Write it",
            dependencies: [],
            status: "READY",
            changes: [{ path: "docs/pipeline/plans/**", action: "create", detail: "写一份方案副本" }],
          },
        ],
      }),
    });

    expect(() => service.confirm(candidate.id, "user-1")).toThrow(/PLAN_ARCHIVE_PATH_FORBIDDEN/);
    expect(store.listRevisions(candidate.id)).toHaveLength(0);
  });

  it("只改留档目录里的一个文件也算指向（不必是目录本身）", () => {
    const { store, service } = setup();
    const candidate = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Touch one archived plan",
      resolvedContract: planContractFixture({
        store,
        projectId: "project-1",
        artifact: { mode: "REPOSITORY_FILE", path: "docs/guide.md" },
        tasks: [
          {
            id: "task-1",
            title: "Edit",
            dependencies: [],
            status: "READY",
            changes: [{ path: "docs/pipeline/plans/plan-existing-v1.md", action: "modify", detail: "改一行" }],
          },
        ],
      }),
    });

    expect(() => service.confirm(candidate.id, "user-1")).toThrow(/PLAN_ARCHIVE_PATH_FORBIDDEN/);
  });

  it("宽范围照常放行，但留档目录永远并进执行侧的排除路径（冻结契约里也有）", () => {
    const { store, service, repoRoot } = setup();
    const candidate = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "Work under docs",
      resolvedContract: planContractFixture({
        store,
        projectId: "project-1",
        artifact: { mode: "REPOSITORY_FILE", path: "docs/guide.md" },
        includePaths: ["docs/**"],
        excludePaths: [".env*"],
      }),
    });

    const confirmed = service.confirm(candidate.id, "user-1");
    expect(confirmed.resolvedContract.scope.excludePaths).toEqual([".env*", "docs/pipeline/plans/**"]);
    expect(store.getRevision(candidate.id, 1)?.resolvedContract.scope.excludePaths).toEqual([".env*", "docs/pipeline/plans/**"]);
    // 确认时的落盘照常发生：留档目录里仍然是 Factory 自己写的那一份。
    expect(readdirSync(join(repoRoot, "docs/pipeline/plans"))).toHaveLength(1);
  });

  it("没有落盘目录配置时整步跳过（不拒绝、不追加排除）", () => {
    const { store, service } = setup({ planDirectory: false });
    const candidate = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "thread-1",
      title: "No archive configured",
      resolvedContract: planContractFixture({
        store,
        projectId: "project-1",
        artifact: { mode: "REPOSITORY_FILE", path: "docs/pipeline/plans/**" },
      }),
    });

    const confirmed = service.confirm(candidate.id, "user-1");
    expect(confirmed.resolvedContract.scope.excludePaths).not.toContain("docs/pipeline/plans/**");
  });

  /**
   * 修订草稿是**第二条冻结路径**。不在这里拦，"改一版再确认"就是绕过确认闸门的后门——
   * `confirmRevisionDraft` 里那句"与 confirm 同一道闸门"的注释，说的正是同一条教训。
   */
  it("修订草稿确认走同一道闸门", () => {
    const { store, service } = setup({ git: true });
    service.registerThread({ id: "explorer-1", projectId: "project-1", parentThreadId: null });
    const plan = service.createCandidatePlan({
      projectId: "project-1",
      sourceExplorerThreadId: "explorer-1",
      title: "Base plan",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "Base plan" }),
    });
    service.confirm(plan.id, "user");

    const draftFor = (label: string, artifactPath: string) => {
      const draft = service.createRevisionDraft({
        planId: plan.id,
        fromRevision: 1,
        explorerThreadId: "explorer-1",
        discardUnmergedRun: false,
        clientRequestId: `draft-${label}`,
      });
      service.updateRevisionDraftFromExplorer(
        draft.draftId,
        {
          title: `Revision ${label}`,
          resolvedContract: planContractFixture({
            store,
            projectId: "project-1",
            title: `Revision ${label}`,
            artifact: { mode: "REPOSITORY_FILE", path: artifactPath },
          }),
        },
        { sourceTurnId: "turn-1", providerThreadId: "provider", providerTurnId: "provider-turn", providerItemId: "item" },
      );
      return draft;
    };

    expect(() => service.confirmRevisionDraft(draftFor("bad", "docs/pipeline/plans/**").draftId, "user")).toThrow(
      /PLAN_ARCHIVE_PATH_FORBIDDEN/,
    );

    service.confirmRevisionDraft(draftFor("good", "docs/guide.md").draftId, "user");
    expect(store.listRevisions(plan.id).at(-1)?.resolvedContract.scope.excludePaths).toContain("docs/pipeline/plans/**");
  });
});
