/**
 * 测试职责：验证 SqlitePipelineStore 在**构造期**跑的两条历史数据修复。
 *
 * 为什么单独一个文件：这两条修复都是"打开老库时把已经损坏的事实改成可解释的状态"，它们的输入
 *   只能靠**绕过领域 API 直接改库**来构造（走 API 的路径根本产生不出这些行——这正是它们只在历史
 *   数据上生效的原因）。把它们和正常业务测试混在一起，会让读者以为那是正常可达的流程。
 *
 * 维护提示：
 *   1) 每条修复都必须先证明它**会**修，再证明它**幂等**（重开一次不重复处理）——修复逻辑写错最常见
 *      的两种失败就是"没生效"和"每次启动都改一遍并刷一条新事件"。
 *   2) 修 A 不要顺带断言 B。两条修复处理的是互斥的状态集合（见各自用例的注释）。
 *   3) 改库用独立的 DatabaseSync 连接：不借道 store 是为了绕开它的写入路径与校验，
 *      借道就构造不出"老库里的坏数据"这个前提。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ExplorerService, PlanService, ProjectService, SqlitePipelineStore } from "./index.js";

const openStores: SqlitePipelineStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 建一个临时库并造出 Project + ExplorerThread + 一个已确认的 CandidatePlan。 */
function seedConfirmedPlan() {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-startup-repair-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "factory.sqlite");
  const store = new SqlitePipelineStore(databasePath);
  openStores.push(store);

  const projects = new ProjectService(store);
  const project = projects.create({ id: "project-repair", name: "Repair Project", repoRoot: "/repo/repair", defaultBranch: "main", worktreeRoot: "/tmp/repair-worktrees" });
  const explorer = new ExplorerService(store).create({ projectId: project.id, title: "Repair Explorer" });
  const plans = new PlanService(store, projects);
  const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, title: "Repair plan" });
  plans.confirm(plan.id, "local-user");
  return { store, databasePath, project, explorer, planId: plan.id };
}

/** 用一条独立连接改库，模拟"老库里已经存在的坏数据"；不借道 store 是为了绕开它的写入校验。 */
function corrupt(databasePath: string, sql: string, ...parameters: Array<string | number>): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

describe("SqlitePipelineStore 构造期修复", () => {
  it("blocks a plan that reached a later state without any confirmation record", () => {
    // repairUnconfirmedProgressedPlans 的场景：确认记录（plan.confirmed / plan.revision.confirmed /
    // plan.configuration.revised 事件，或 confirmed_at）缺失，状态却已推进到 QUEUED 之后。
    const { store, databasePath, planId } = seedConfirmedPlan();
    // 把确认的**事实与事件**一起抹掉，只留下"已推进"的状态。
    corrupt(databasePath, "UPDATE candidate_plans SET confirmed_at = NULL, confirmed_by = NULL, status = 'QUEUED' WHERE id = ?", planId);
    corrupt(databasePath, "DELETE FROM domain_events WHERE aggregate_id = ? AND type IN ('plan.confirmed', 'plan.revision.confirmed', 'plan.configuration.revised')", planId);
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = new SqlitePipelineStore(databasePath);
    openStores.push(reopened);

    const repaired = reopened.getPlan(planId);
    expect(repaired?.status).toBe("BLOCKED");
    expect(repaired?.attentionReason).toMatch(/without a confirmation record/i);
  });

  it("blocks a plan whose source ExplorerThread no longer exists, and does not re-block it on restart", () => {
    // repairOrphanedPlans 的场景：Plan 已确认并进入后续状态，但来源 ExplorerThread 已不存在。
    // 这类 Plan 会被 savePlan 的投影守卫跳过（投影不写 → Plan Center 里"消失"），
    // 所以必须显式标成 BLOCKED，才不会只剩"看不见"这一种表现。
    const { store, databasePath, explorer, planId } = seedConfirmedPlan();
    expect(store.getPlan(planId)?.status).toBe("READY");
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    // 只删线程相关行（不经过 ExplorerService.delete —— 那条路径会连 Plan 一起级联删掉，
    // 留下的是"干净"状态，构造不出孤儿）。
    // 必须先删投影再删线程：plan_query_projection.source_explorer_thread_id 对 explorer_threads
    // 有外键，而这个外键恰恰是 candidate_plans 自己没有的那一条（索引表比事实表更严，
    // 就是 savePlan 那道守卫存在的原因）。
    corrupt(databasePath, "DELETE FROM plan_query_projection WHERE source_explorer_thread_id = ?", explorer.id);
    corrupt(databasePath, "DELETE FROM explorer_threads WHERE id = ?", explorer.id);

    const reopened = new SqlitePipelineStore(databasePath);
    openStores.push(reopened);

    const repaired = reopened.getPlan(planId);
    expect(repaired?.status).toBe("BLOCKED");
    expect(repaired?.attentionReason).toMatch(/source is missing/i);
    // 投影仍不写：修复的是**状态**，不是把孤儿塞回 Plan Center。
    expect(reopened.listPlanQueryProjection("project-repair")).toEqual([]);

    // 幂等：BLOCKED 已不在被修复的状态集合里，重开一次不应再产生一条 plan.status.changed。
    const sequenceAfterFirstRepair = reopened.getLastEventSequence(planId);
    reopened.close();
    openStores.splice(openStores.indexOf(reopened), 1);
    const reopenedAgain = new SqlitePipelineStore(databasePath);
    openStores.push(reopenedAgain);

    expect(reopenedAgain.getPlan(planId)?.status).toBe("BLOCKED");
    expect(reopenedAgain.getLastEventSequence(planId)).toBe(sequenceAfterFirstRepair);
  });
});
