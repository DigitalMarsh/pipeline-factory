/**
 * 测试职责：Project 配置版本与指纹的**边界**——哪些设置变化该推进 `configVersion`，哪些不该。
 *
 * 为什么值得单独钉：`PlanService.confirm` 以"配置版本或指纹变了"判方案过期。如果一条纯界面
 * 偏好（Worktree 清单的默认范围）也算执行配置，那么"忽略一条分支"就会把正在走的方案打成过期
 * ——降噪操作把工作打断，而且报错说的是"请重新生成方案"，根本指不到真正的原因。
 */
import { describe, expect, it } from "vitest";
import { InMemoryPipelineStore } from "./store/in-memory-store.js";
import { ProjectService } from "./project/project.js";

function setup() {
  const store = new InMemoryPipelineStore();
  const projects = new ProjectService(store);
  const project = projects.create({
    id: "project-1",
    name: "project-1",
    repoRoot: "/repo/project-1",
    defaultBranch: "main",
    worktreeRoot: "/worktrees/project-1",
  });
  return { store, projects, project };
}

describe("Worktree 范围与执行配置的分界", () => {
  it("只有 worktree 范围变化时：版本、指纹不变，也没多出一份修订", () => {
    const { store, projects, project } = setup();

    const updated = projects.update(project.id, {
      settings: { worktree: { ignoredBranches: ["noise/branch"], filterMode: "patterns", branchPatterns: ["factory/*"] } },
      expectedConfigVersion: project.configVersion,
    });

    expect(updated.configVersion).toBe(project.configVersion);
    expect(updated.configHash).toBe(project.configHash);
    expect(updated.settings.worktree?.ignoredBranches).toEqual(["noise/branch"]);
    // 创建时写了一份修订；同版本不再追加。
    expect(store.listProjectConfigRevisions(project.id)).toHaveLength(1);
  });

  it("影响执行的设置仍然推进版本与指纹", () => {
    const { projects, project } = setup();

    const updated = projects.update(project.id, {
      settings: { concurrency: { maxParallelRuns: 3 } },
      expectedConfigVersion: project.configVersion,
    });

    expect(updated.configVersion).toBe(project.configVersion + 1);
    expect(updated.configHash).not.toBe(project.configHash);
  });

  it("范围模式与列表一起保存时，后续读取仍是同一份值", () => {
    const { projects, project } = setup();
    projects.update(project.id, { settings: { worktree: { includeDetachedWorktrees: false } } });
    const reloaded = projects.get(project.id);

    expect(reloaded.settings.worktree).toMatchObject({
      filterMode: "all",
      includeDetachedWorktrees: false,
      ignoredBranches: [],
      branchPatterns: [],
    });
  });
});
