/**
 * 测试职责：钉住 Plan 落盘的两条硬要求——**只在确认时写**、**每版一个文件不覆盖**，
 *   以及落盘路径确实被记进了 Revision（而不是让页面去推算一个会随配置漂移的位置）。
 *
 * 为什么"不覆盖"值得单独测：V2 覆盖 V1 是那种上线很久才被发现的问题——空间上完全正常，
 *   只是历史凭空消失了。用文件系统的真实行为断言，比断言函数调用可靠。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanService } from "./service.js";
import { planDocumentFileName, renderPlanDocument, writePlanDocument } from "./plan-archive.js";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { ProjectService } from "../project/project.js";
import type { ResolvedPlanContract } from "./plan-spec.js";
import { planContractFixture } from "./plan-fixture.js";

/** 契约只有 `resolvedContract` 一份（V1 扁平镜像已经删掉）。 */
const resolvedContract: ResolvedPlanContract = {
  schemaVersion: 2,
  artifact: { mode: "REPOSITORY_FILE", path: "src/views/GanttView.vue" },
  objective: { goal: "在项目详情页展示甘特图", audience: ["项目成员"], acceptanceCriteria: ["能按日期排布"], outOfScope: ["不改后端数据模型"] },
  design: { technicalConstraints: ["复用现有 Vue 组件边界"], dataSecurity: ["不新增敏感数据"], failureHandling: ["数据缺失时显示空状态"] },
  conflicts: [],
  repository: { projectId: "project-1", name: "Project", repoRoot: "/repo", baseBranch: "main", baseCommit: "abc123", configVersion: 1, configHash: "sha256:config" },
  scope: { includePaths: ["src/views/**"], excludePaths: [] },
  tasks: [{ id: "task-1", title: "实现时间轴", dependencies: [], status: "READY" }],
  dependencies: [],
  dependsOnPlanIds: [],
  execution: { executorModelRole: "executor", toolPolicy: "executor-scoped-write", maxRepairAttempts: 2 },
  verification: { mode: "PROJECT_DEFAULT", commandIds: ["project.verify"] },
  merge: { strategy: "manual", requireHumanMerge: true },
};

const document = {
  planId: "plan-1",
  revision: 1,
  title: "为项目添加甘特图",
  resolvedContract,
  artifactHash: "sha256:deadbeef",
  confirmedBy: "local-user",
  confirmedAt: "2026-10-01T10:00:00.000Z",
};

describe("Plan 文档渲染", () => {
  it("把契约里人要看的东西都写出来", () => {
    const markdown = renderPlanDocument(document);

    expect(markdown).toContain("# 为项目添加甘特图");
    expect(markdown).toContain("在项目详情页展示甘特图");
    expect(markdown).toContain("能按日期排布");
    expect(markdown).toContain("实现时间轴");
    expect(markdown).toContain("`project.verify`");
    expect(markdown).toContain("`src/views/GanttView.vue`");
    expect(markdown).toContain("main @ abc123");
    expect(markdown).toContain("sha256:deadbeef");
  });

  it("空字段写'（未声明）'而不是留白，避免被当成渲染坏了", () => {
    const markdown = renderPlanDocument({ ...document, resolvedContract: { ...resolvedContract, objective: { ...resolvedContract.objective, acceptanceCriteria: [] }, scope: { includePaths: [], excludePaths: [] }, tasks: [], design: { ...resolvedContract.design, technicalConstraints: [], dataSecurity: [], failureHandling: [] }, verification: { mode: "NONE", commandIds: [] } } });

    expect(markdown).toContain("（未声明）");
  });

  it("当前形状的文档写出现状、每步文件变更和风险", () => {
    const markdown = renderPlanDocument({
      ...document,
      resolvedContract: {
        ...resolvedContract,
        objective: { ...resolvedContract.objective, context: ["现有详情页只有列表视图，日期数据已由 API 返回。"] },
        design: { ...resolvedContract.design, risks: ["旧浏览器样式兼容风险；失败时保留原列表视图。"] },
        tasks: [{ id: "task-1", title: "实现时间轴", dependencies: [], status: "READY", changes: [{ path: "src/views/GanttView.vue", action: "create", detail: "新增甘特图视图并复用详情页布局。" }] }],
      },
    });

    expect(markdown).toContain("## 现状与发现");
    expect(markdown).toContain("现有详情页只有列表视图");
    expect(markdown).toContain("新建");
    expect(markdown).toContain("src/views/GanttView.vue");
    expect(markdown).toContain("新增甘特图视图并复用详情页布局");
    expect(markdown).toContain("## 风险与回滚");
    expect(markdown).toContain("旧浏览器样式兼容风险");
  });

  it("文件名的形态是 <planId>-v<revision>.md", () => {
    expect(planDocumentFileName("plan-abc", 3)).toBe("plan-abc-v3.md");
  });
});

describe("Plan 落盘", () => {
  let directory: string;
  beforeEach(() => { directory = join(mkdtempSync(join(tmpdir(), "plan-archive-")), "docs", "pipeline", "plans"); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it("目录不存在时自动创建（含多级）", () => {
    expect(existsSync(directory)).toBe(false);
    const file = writePlanDocument({ ...document, directory });

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("# 为项目添加甘特图");
  });

  it("**每版一个文件**：v2 不会覆盖 v1", () => {
    writePlanDocument({ ...document, directory });
    writePlanDocument({ ...document, revision: 2, title: "第二版", directory });

    expect(readdirSync(directory).sort()).toEqual(["plan-1-v1.md", "plan-1-v2.md"]);
    expect(readFileSync(join(directory, "plan-1-v1.md"), "utf8")).toContain("# 为项目添加甘特图");
  });

  it("同一版重复写是幂等的（确认会被重试，不该产生垃圾文件）", () => {
    writePlanDocument({ ...document, directory });
    writePlanDocument({ ...document, directory });

    expect(readdirSync(directory)).toEqual(["plan-1-v1.md"]);
  });
});

describe("确认时的落盘（PlanService）", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "plan-confirm-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function setup(withArchive: boolean) {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Archive Project", repoRoot: root, defaultBranch: "main", worktreeRoot: join(root, "worktrees") });
    const directory = join(root, "docs", "pipeline", "plans");
    const plans = withArchive ? new PlanService(store, projects, undefined, () => directory) : new PlanService(store, projects);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "落盘方案",
      resolvedContract: planContractFixture({ store, projectId: "project-1", title: "落盘方案" }) });
    return { plans, plan, directory };
  }

  it("确认后文件落盘，且路径被记进 Revision", () => {
    const { plans, plan, directory } = setup(true);
    const confirmed = plans.confirm(plan.id, "local-user");
    const revision = plans.listRevisions(confirmed.id)[0];

    expect(revision?.planDocumentPath).toBe(join(directory, `${plan.id}-v1.md`));
    expect(existsSync(revision?.planDocumentPath ?? "")).toBe(true);
  });

  it("未注入目录解析器时不落盘，也不写一个假路径", () => {
    const { plans, plan } = setup(false);
    const confirmed = plans.confirm(plan.id, "local-user");
    const revision = plans.listRevisions(confirmed.id)[0];

    expect(revision?.planDocumentPath).toBeUndefined();
  });
});
