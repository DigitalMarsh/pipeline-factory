/**
 * 测试职责：验证 SqlitePipelineStore 在**构造期**对历史数据做的事——两条修复，以及事件回收。
 *
 * 为什么单独一个文件：这些都是"打开库的那一刻就改变了历史数据"，它们的输入只能靠**绕过领域 API
 *   直接改库**来构造（走 API 的路径根本产生不出这些行——这正是它们只在历史数据上生效的原因）。
 *   把它们和正常业务测试混在一起，会让读者以为那是正常可达的流程。
 *
 * 维护提示：
 *   1) 每条修复都必须先证明它**会**修，再证明它**幂等**（重开一次不重复处理）——修复逻辑写错最常见
 *      的两种失败就是"没生效"和"每次启动都改一遍并刷一条新事件"。
 *   2) 修 A 不要顺带断言 B。两条修复处理的是互斥的状态集合（见各自用例的注释）。
 *   3) 改库用独立的 DatabaseSync 连接：不借道 store 是为了绕开它的写入路径与校验，
 *      借道就构造不出"老库里的坏数据"这个前提。
 *   4) 事件回收（第三组用例）与那两条修复的区别：修复是**纠正**，回收是**删除**，且默认关闭。
 *      它不要求幂等（删过的行第二次本来就不在），但要求**只动白名单内的类型**——
 *      那条断言比"删掉了该删的"更重要。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ExplorerService, PlanService, ProjectService, SqlitePipelineStore } from "./index.js";
import { planContractFixture } from "./plan/plan-fixture.js";

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
  const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, title: "Repair plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Repair plan" }) });
  plans.confirm(plan.id, "local-user");
  return { store, databasePath, project, explorer, planId: plan.id };
}

/** 用一条独立连接改库，模拟"老库里已经存在的坏数据"；不借道 store 是为了绕开它的写入校验。 */
/**
 * 绕开 store 直接对库跑一条 SQL。**唯一**的写库通道——走 store 就构造不出"老库里的坏数据"这个前提。
 * 名字不叫 corrupt：本文件里它多数时候确实是在制造损坏，但事件回收那组用例只是用它塞一条旧事件，
 * 用 corrupt 会让那句读起来像在"制造损坏"。
 */
function runRawSql(databasePath: string, sql: string, ...parameters: Array<string | number>): void {
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
    runRawSql(databasePath, "UPDATE candidate_plans SET confirmed_at = NULL, confirmed_by = NULL, status = 'QUEUED' WHERE id = ?", planId);
    runRawSql(databasePath, "DELETE FROM domain_events WHERE aggregate_id = ? AND type IN ('plan.confirmed', 'plan.revision.confirmed', 'plan.configuration.revised')", planId);
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
    runRawSql(databasePath, "DELETE FROM plan_query_projection WHERE source_explorer_thread_id = ?", explorer.id);
    runRawSql(databasePath, "DELETE FROM explorer_threads WHERE id = ?", explorer.id);

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

describe("构造期的事件回收", () => {
  it("prunes only aged high-frequency events, and only when retention is enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "pipeline-retention-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    // 先让 store 把 schema 建出来，再直接往事件表塞"过去的事件"——appendEvent 的 occurredAt
    // 由存储层生成，调用方造不出两周前的行，所以这一步必须绕过 store。
    new SqlitePipelineStore(databasePath).close();
    runRawSql(databasePath, "INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)", "aged-delta", 1, "explorer.turn.text.delta", "thread-aged", "2020-01-01T00:00:00.000Z", "{}");
    runRawSql(databasePath, "INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)", "aged-plan", 2, "plan.confirmed", "plan-aged", "2020-01-01T00:00:00.000Z", "{}");

    // 不配置回收（缺省）：一条都不动。这是这条用例的一半价值——回收默认是关的。
    const plain = new SqlitePipelineStore(databasePath);
    openStores.push(plain);
    expect(plain.listEvents({}).map((event) => event.id)).toEqual(["aged-delta", "aged-plan"]);
    plain.close();
    openStores.splice(openStores.indexOf(plain), 1);

    const pruning = new SqlitePipelineStore(databasePath, { retention: { retentionDays: 14, minPerAggregate: 0 } });
    openStores.push(pruning);

    // 只删白名单里的那条。plan.confirmed 是状态机的输入，无论多旧都不动——
    // 这条断言比"删掉了该删的"更重要。
    expect(pruning.listEvents({}).map((event) => event.id)).toEqual(["aged-plan"]);
    // 序号不退：回收删掉了尾部行，新事件仍要拿到比历史更大的号，
    // 否则已连接的客户端会拿它当游标把新事件整段跳过。
    expect(pruning.appendEvent({ type: "plan.enqueued", aggregateId: "plan-aged", payload: {} }).sequence).toBeGreaterThan(2);
  });
});
