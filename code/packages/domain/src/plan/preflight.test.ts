/**
 * 测试职责：钉住派发前预检的**边界**——哪些情况阻断、哪些只警告、哪些根本不查。
 *
 * 为什么边界是重点：这道闸门拦的是"计划要处理的文件根本不存在"（全库阻塞原因里最大的一类）。
 *   放宽了它没有价值，收紧了它会拦住正常计划——"新建一个组件"、"在空目录里搭工程"都会被误伤。
 *   每一条规则都在这里配上正面与反面的用例，避免后续改动悄悄挪动那条线。
 */
import { describe, expect, it } from "vitest";
import { PlanService } from "./service.js";
import { createLocalPlanPreflightInspector } from "./preflight.js";
import { InMemoryPipelineStore } from "../store/in-memory-store.js";
import { ProjectService } from "../project/project.js";
import type { CommandResult } from "../platform/commands.js";

/** 假 git：`objects` 里登记"在 commit 上存在的路径"，`status` 是工作区输出。 */
function fakeGit(input: { objects?: string[]; status?: string; statusExitCode?: number; isRepo?: boolean; batchExitCode?: number } = {}) {
  const objects = new Set(input.objects ?? []);
  return (args: string[], _cwd?: string, stdin?: string): CommandResult => {
    if (args[0] === "rev-parse") return { exitCode: input.isRepo === false ? 128 : 0, stdout: "", stderr: "" };
    if (args[0] === "status") return { exitCode: input.statusExitCode ?? 0, stdout: input.status ?? "", stderr: "" };
    // 如实模拟 `cat-file --batch-check`：按 stdin 的行、**顺序一一对应**地输出；
    // 不存在的以 ` missing` 结尾。假的实现与真命令形状不一致，测试就会测到假的东西。
    if (args[0] === "cat-file" && args[1] === "--batch-check") {
      if (input.batchExitCode !== undefined && input.batchExitCode !== 0) return { exitCode: input.batchExitCode, stdout: "", stderr: "boom" };
      const lines = (stdin ?? "").split("\n").filter(Boolean).map((spec) => {
        const path = spec.slice(spec.indexOf(":") + 1);
        return objects.has(path) ? `${"a".repeat(40)} blob 1` : `${spec} missing`;
      });
      return { exitCode: 0, stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

const base = { repoRoot: "/repo", baseCommit: "abc123" };

describe("Plan 预检的判定边界", () => {
  it("include 里的具体文件不存在 → 阻断，并指明是哪些", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit({ objects: ["src/exists.ts"] }) });
    const result = inspect({ ...base, includePaths: ["src/exists.ts", "code/personal-site/index.html"] });

    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]?.code).toBe("PATH_MISSING");
    expect(result.blocking[0]?.paths).toEqual(["code/personal-site/index.html"]);
    // 提示里必须给出出路，否则用户只会反复重新生成同样的计划。
    expect(result.blocking[0]?.message).toContain("**");
  });

  it("**通配范围不查** —— 范围内的东西可以新建，查它必然误伤", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit() });
    const result = inspect({ ...base, includePaths: ["code/personal-site/**", "src/**/*.ts", "docs/*"] });

    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("不带扩展名的目录路径不查（无法区分文件与目录，宁可放过）", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit() });
    expect(inspect({ ...base, includePaths: ["src", "code/app"] }).blocking).toEqual([]);
  });

  it("**产物路径缺失只警告**：产物天然可能是要新建的文件", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit() });
    const result = inspect({ ...base, includePaths: ["src/views/**", "src/views/GanttView.vue"], artifactPath: "src/views/GanttView.vue" });

    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toContain("ARTIFACT_MISSING");
  });

  it("产物路径已在 include 里时不会被重复判定", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit() });
    const result = inspect({ ...base, includePaths: ["src/views/GanttView.vue"], artifactPath: "src/views/GanttView.vue" });

    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["ARTIFACT_MISSING"]);
  });

  it("绝对路径与 .. 不是'仓库里的路径'，不去问 git", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit() });
    expect(inspect({ ...base, includePaths: ["/etc/passwd", "../outside.ts"] }).blocking).toEqual([]);
  });

  it("工作区不干净 → 只警告（硬闸门在建 worktree 时），并列出文件", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit({ status: " M src/a.ts\n?? src/b.ts\n" }) });
    const result = inspect({ ...base, includePaths: ["src/**"] });

    expect(result.blocking).toEqual([]);
    expect(result.warnings[0]?.code).toBe("WORKING_TREE_DIRTY");
    expect(result.warnings[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("仓库读不到时不做任何路径判断 —— '查不出来'不等于'不存在'", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit({ isRepo: false }) });
    const result = inspect({ ...base, includePaths: ["src/missing.ts"] });

    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["INSPECTION_UNAVAILABLE"]);
  });

  it("批量查询本身失败时也不阻断 —— 一次失败的 git 调用不该让每个 Plan 都非法", () => {
    const inspect = createLocalPlanPreflightInspector({ runGit: fakeGit({ batchExitCode: 1 }) });
    const result = inspect({ ...base, includePaths: ["src/missing.ts"] });

    expect(result.blocking).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toContain("INSPECTION_UNAVAILABLE");
  });

  it("多个路径**只 spawn 一次** git（回归：曾经每个路径一次进程，全卡在事件循环上）", () => {
    const calls: string[][] = [];
    const runGit = (args: string[], _cwd?: string, stdin?: string): CommandResult => {
      calls.push(args);
      if (args[0] === "cat-file") {
        const stdout = (stdin ?? "").split("\n").filter(Boolean).map((spec) => `${spec} missing`).join("\n");
        return { exitCode: 0, stdout, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    createLocalPlanPreflightInspector({ runGit })({ ...base, includePaths: ["a.ts", "b.ts", "c.ts"], artifactPath: "d.ts" });

    expect(calls.filter((args) => args[0] === "cat-file")).toHaveLength(1);
  });
});

describe("确认闸门", () => {
  function setup(inspector = createLocalPlanPreflightInspector({ runGit: fakeGit() })) {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Preflight Project", repoRoot: "/repo", defaultBranch: "main", worktreeRoot: "/tmp/worktrees" });
    const plans = new PlanService(store, projects, inspector);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Preflight plan" });
    return { plans, plan };
  }

  it("阻断级问题让确认失败，且错误码可被路由识别", () => {
    const { plans, plan } = setup(() => ({ blocking: [{ severity: "blocking", code: "PATH_MISSING", message: "计划要处理的文件在基线里不存在：src/missing.ts", paths: ["src/missing.ts"] }], warnings: [] }));

    expect(() => plans.confirm(plan.id, "user-1")).toThrow(/^PLAN_PREFLIGHT_FAILED:/);
    // 失败必须是**没有冻结**：Revision 不可回滚，冻结了再抛错就会留下一个"确认了一半"的 Plan。
    expect(plans.get(plan.id).status).toBe("DRAFT");
    expect(plans.listRevisions(plan.id)).toHaveLength(0);
  });

  it("只有警告时确认照常通过", () => {
    const { plans, plan } = setup(() => ({ blocking: [], warnings: [{ severity: "warning", code: "WORKING_TREE_DIRTY", message: "受管工程有 1 个未提交改动", paths: ["src/a.ts"] }] }));

    expect(plans.confirm(plan.id, "user-1").status).toBe("READY");
  });

  it("没有 inspector 时不做检查（测试与未配置的调用方）", () => {
    const store = new InMemoryPipelineStore();
    const projects = new ProjectService(store);
    projects.create({ id: "project-1", name: "Plain Project", repoRoot: "/repo", defaultBranch: "main", worktreeRoot: "/tmp/worktrees" });
    const plans = new PlanService(store, projects);
    const plan = plans.createCandidatePlan({ projectId: "project-1", sourceExplorerThreadId: "thread-1", title: "Plain plan" });

    expect(plans.confirm(plan.id, "user-1").status).toBe("READY");
  });
});
