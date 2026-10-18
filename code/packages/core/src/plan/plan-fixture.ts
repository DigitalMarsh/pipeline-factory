/**
 * 测试夹具：造一份**已解析契约**（`ResolvedPlanContract`）。
 *
 * 为什么需要它：契约现在是 CandidatePlan / Revision / Draft 的**必填事实**，而造一份真的要走
 * `resolvePlanContract`——那要求先有一个受管 Project 与一条**真实的 Git 基线**（建 Plan 时会跑
 * `git rev-parse`）。大量用例根本不关心契约内容（存储读写、线程删除、调度状态机），让它们各自
 * 配一个真仓库是纯粹的负担。
 *
 * 维护提示：
 *   1) 这是**测试夹具**，不是生产代码的入口。生产侧造契约只有一条路：Explorer 产出
 *      `generatedSpec` → `resolvePlanContract`。
 *   2) 默认值是"能跑通"的最小集合（一个任务、一条验证命令、manual 合并），**不是**任何产品的
 *      默认值——不要在断言里依赖它们出现，需要什么就在参数里显式写出来。
 *   3) `project` / `store` 与契约里的 `repository` 必须一致：`PlanService.confirm` 会拿库里的
 *      Project 比对 `repository.projectId` 与配置版本/哈希，对不上就判"绑定到了别的项目"或
 *      "配置已过期"。**因此凡是用例里那个 Project 已经注册过，就一定要把 `store` 传进来**
 *      （或直接把 `project` 给它）——手抄 configVersion/configHash 一定会过期。
 */
import { EXECUTOR_ROLE, EXECUTOR_TOOL_POLICY } from "./plan-spec.js";
import type { PlanArtifactMode, ResolvedPlanContract } from "./plan-spec.js";
import type { PipelineStore } from "../store/pipeline-store.js";
import type { Project } from "../project/project.js";

export type PlanFixtureProject = Pick<Project, "id" | "name" | "repoRoot" | "defaultBranch" | "configVersion" | "configHash">;

export type PlanFixtureOptions = {
  /**
   * 库（或任何能按 id 取 Project 的东西）：给了就按 `projectId` 查出 Project 并填进 `repository`。
   * 见维护提示 3——这是在"项目已注册"的用例上唯一省事的正确做法。
   */
  store?: Pick<PipelineStore, "getProject"> | undefined;
  /** 绑定到哪个 Project：给了就直接用它（优先于 `store` 查询）。 */
  project?: PlanFixtureProject | undefined;
  /** 契约的归属项目；缺省 "project-1"。 */
  projectId?: string | undefined;
  title?: string | undefined;
  /** 缺省与 `title` 相同（V1 兜底合同当年也是这么填的）。 */
  goal?: string | undefined;
  /** 现状与调查发现；缺省为空（夹具没有真勘察过仓库）。 */
  context?: string[] | undefined;
  acceptanceCriteria?: string[] | undefined;
  includePaths?: string[] | undefined;
  excludePaths?: string[] | undefined;
  tasks?: ResolvedPlanContract["tasks"] | undefined;
  dependencies?: string[] | undefined;
  /** 前置 CandidatePlan id；缺省为空（只有 `PlanService.setDependencies` 会写它）。 */
  dependsOnPlanIds?: string[] | undefined;
  conflicts?: string[] | undefined;
  artifact?: { mode?: PlanArtifactMode | undefined; path?: string | undefined } | undefined;
  verification?: { mode?: "PROJECT_DEFAULT" | "NONE" | undefined; commandIds?: string[] | undefined } | undefined;
  design?: Partial<ResolvedPlanContract["design"]> | undefined;
  execution?: Partial<ResolvedPlanContract["execution"]> | undefined;
  merge?: Partial<ResolvedPlanContract["merge"]> | undefined;
  repository?: Partial<ResolvedPlanContract["repository"]> | undefined;
};

export function planContractFixture(options: PlanFixtureOptions = {}): ResolvedPlanContract {
  const title = options.title ?? "Fixture plan";
  const projectId = options.projectId ?? "project-1";
  const project = options.project ?? options.store?.getProject(projectId);
  return {
    schemaVersion: 2,
    artifact: { mode: options.artifact?.mode ?? "REPOSITORY_FILE", path: options.artifact?.path },
    objective: {
      goal: options.goal ?? title,
      context: options.context,
      audience: [],
      acceptanceCriteria: options.acceptanceCriteria ?? ["works"],
      outOfScope: [],
    },
    design: {
      technicalConstraints: options.design?.technicalConstraints ?? [],
      dataSecurity: options.design?.dataSecurity ?? [],
      failureHandling: options.design?.failureHandling ?? [],
      risks: options.design?.risks,
    },
    conflicts: options.conflicts ?? [],
    repository: {
      projectId,
      name: project?.name ?? "Project",
      repoRoot: project?.repoRoot ?? "/repo/project",
      baseBranch: project?.defaultBranch ?? "main",
      baseCommit: "HEAD",
      configVersion: project?.configVersion ?? 1,
      configHash: project?.configHash ?? "fixture-config",
      ...options.repository,
    },
    scope: { includePaths: options.includePaths ?? ["src"], excludePaths: options.excludePaths ?? [".env*"] },
    tasks: options.tasks ?? [{ id: "task-1", title, dependencies: [], status: "READY" }],
    dependencies: options.dependencies ?? [],
    dependsOnPlanIds: options.dependsOnPlanIds ?? [],
    execution: {
      executorModelRole: options.execution?.executorModelRole ?? EXECUTOR_ROLE,
      toolPolicy: options.execution?.toolPolicy ?? EXECUTOR_TOOL_POLICY,
      maxRepairAttempts: options.execution?.maxRepairAttempts ?? 2,
    },
    verification: {
      mode: options.verification?.mode ?? "PROJECT_DEFAULT",
      commandIds: options.verification?.commandIds ?? ["project.test", "project.typecheck"],
    },
    merge: { strategy: options.merge?.strategy ?? "manual", requireHumanMerge: true },
  };
}
