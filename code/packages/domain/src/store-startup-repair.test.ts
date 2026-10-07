/**
 * 测试职责：验证 SqlitePipelineStore 在**构造期**对历史数据做的事——一条回填、两条修复，以及事件回收。
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
 *   3b) **回填与修复不是一回事**：回填（`backfillPlanDependencyIds`）补的是"新增的必填字段在
 *      老行里没有"，改完的数据仍然是好的；修复改的是状态本身。回填的用例在下面单独一组。
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
  const project = projects.create({
    id: "project-repair",
    name: "Repair Project",
    repoRoot: "/repo/repair",
    defaultBranch: "main",
    worktreeRoot: "/tmp/repair-worktrees",
  });
  const explorer = new ExplorerService(store).create({ projectId: project.id, title: "Repair Explorer" });
  const plans = new PlanService(store, projects);
  const plan = plans.createCandidatePlan({
    projectId: project.id,
    sourceExplorerThreadId: explorer.id,
    title: "Repair plan",
    resolvedContract: planContractFixture({ store, projectId: project.id, title: "Repair plan" }),
  });
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

/** 读一张表的列名（同样是绕开 store）：给"这一列到底还在不在"这类断言用。 */
function runRawSqlColumnNames(databasePath: string, table: string): string[] {
  const database = new DatabaseSync(databasePath);
  try {
    return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  } finally {
    database.close();
  }
}

/** 用一条独立连接读一行（同样是绕开 store），只给"回填前/后库里到底写了什么"这类断言用。 */
function runRawSqlQuery(databasePath: string, sql: string, ...parameters: Array<string | number>): Record<string, unknown> {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(sql).get(...parameters) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

describe("SqlitePipelineStore 构造期回填", () => {
  it("给本轮之前落库的契约补上 dependsOnPlanIds", () => {
    // backfillPlanDependencyIds 的场景：字段是随"删掉 V1 镜像"一起加进 ResolvedPlanContract 的，
    // 老库里那 21 份契约都没有这个键。读点虽然都写了 `?? []`，但类型说它必填——
    // 让数据对得上，比要求未来每个读点都记得兜底可靠。
    const { store, databasePath, planId } = seedConfirmedPlan();
    runRawSql(
      databasePath,
      "UPDATE candidate_plans SET resolved_contract_json = json_remove(resolved_contract_json, '$.dependsOnPlanIds') WHERE id = ?",
      planId,
    );
    runRawSql(
      databasePath,
      "UPDATE plan_revisions SET resolved_contract_json = json_remove(resolved_contract_json, '$.dependsOnPlanIds') WHERE plan_id = ?",
      planId,
    );
    expect(
      JSON.parse(
        String(runRawSqlQuery(databasePath, "SELECT resolved_contract_json AS value FROM candidate_plans WHERE id = ?", planId).value),
      ),
    ).not.toHaveProperty("dependsOnPlanIds");
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = new SqlitePipelineStore(databasePath);
    openStores.push(reopened);

    expect(reopened.getPlan(planId)?.resolvedContract.dependsOnPlanIds).toEqual([]);
    expect(reopened.getRevision(planId, 1)?.resolvedContract.dependsOnPlanIds).toEqual([]);
    // 只补缺键的行：已经有人设过依赖的（非空）不能被这次回填抹平。
    expect(
      JSON.parse(
        String(runRawSqlQuery(databasePath, "SELECT resolved_contract_json AS value FROM plan_revisions WHERE plan_id = ?", planId).value),
      ),
    ).toHaveProperty("dependsOnPlanIds", []);
  });

  it("把历史里逐次刷新的正文碎片压实成段，且读数不变", () => {
    // compactTextStreams 的场景：写侧曾经按 160 字符阈值或 40ms 定时器逐次落库，实测碎片中位 2 个字符。
    // 压实规则与读取方逐字相同（连续的同类正文 = 一段），所以**正文总量守恒、非文本步骤一条不动**。
    const directory = mkdtempSync(join(tmpdir(), "pipeline-compact-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const seeded = new SqlitePipelineStore(databasePath);
    const loop = seeded.saveAgentLoop({
      id: "loop-1",
      ownerType: "run",
      ownerId: "run-1",
      role: "executor",
      mode: "provider-controlled",
      state: "RUNNING",
      stepCount: 0,
      maxSteps: 40,
      startedAt: seeded.now(),
      completedAt: null,
      providerThreadId: null,
      providerTurnId: null,
      checkpointJson: null,
    });
    seeded.appendAgentLoopStep({
      loopId: loop.id,
      stepType: "MODEL_TEXT_DELTA",
      status: "COMPLETED",
      payload: { text: "好", providerItemId: "item-1" },
    });
    seeded.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "的" } });
    seeded.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "，我" } });
    seeded.appendAgentLoopStep({ loopId: loop.id, stepType: "PROVIDER_ACTIVITY", status: "COMPLETED", payload: { itemId: "activity-1" } });
    seeded.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "看" } });
    seeded.appendAgentLoopStep({ loopId: loop.id, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "一下" } });
    seeded.saveRun({
      id: "run-1",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-1",
      workspacePath: "/tmp/run-1",
      baseCommit: "abc",
      executionThreadId: "thread-1",
      createdAt: seeded.now(),
      startedAt: null,
    });
    seeded.saveExecutionThread({ id: "thread-1", runId: "run-1", state: "ACTIVE", journal: [] });
    for (const text of ["He", "llo", " world"])
      seeded.appendExecutionJournal({
        executionThreadId: "thread-1",
        runId: "run-1",
        type: "MODEL_OUTPUT",
        payload: { text, modelStep: 1, providerItemId: "item-1" },
      });
    // 事件里那两簇带内层序号的碎片按**内层序号**并段，正文一字不丢。
    // 刻意在中间插一条别的事件：真实的事件流就是交错的（每 40ms 一次刷新同时写两种事件），
    // 所以判据只能是内层序号，不能是事件序号相邻——那一条在真实库上匹配数是 0。
    for (const [index, text] of ["你", "好", "呀"].entries()) {
      seeded.appendEvent({
        type: "agent.step.model_text_delta",
        aggregateId: "loop-1",
        payload: { text, providerItemId: "item-1", sequence: index + 1 },
      });
      seeded.appendEvent({ type: "agent.model.text.delta", aggregateId: "loop-1", payload: { text } });
    }
    // 两簇"另有副本"的事件：副本验得过就删，验不过就留。
    seeded.saveThread({ id: "thread-1", projectId: "project-1", parentThreadId: null });
    seeded.saveTurn({
      id: "turn-ok",
      threadId: "thread-1",
      role: "assistant",
      content: "第一句",
      status: "COMPLETED",
      createdAt: seeded.now(),
      sequence: 1,
    });
    // 被取消的回合：content 被替换成提示语，模型原始输出只在这批事件里 —— 副本不成立，必须留。
    seeded.saveTurn({
      id: "turn-cancelled",
      threadId: "thread-1",
      role: "assistant",
      content: "本轮已取消",
      status: "CANCELLED",
      createdAt: seeded.now(),
      sequence: 2,
    });
    for (const text of ["第一", "句"])
      seeded.appendEvent({
        type: "explorer.turn.text.delta",
        aggregateId: "thread-1",
        payload: { turnId: "turn-ok", explorerPlanId: "plan-1", loopId: "loop-1", text },
      });
    for (const text of ["模型说了一半"])
      seeded.appendEvent({
        type: "explorer.turn.text.delta",
        aggregateId: "thread-1",
        payload: { turnId: "turn-cancelled", explorerPlanId: "plan-1", loopId: "loop-1", text },
      });
    // journal 镜像：内层序号连续 → 并段；不连续 → 不并。
    for (const [index, text] of ["He", "llo"].entries())
      seeded.appendEvent({
        type: "run.executor.event",
        aggregateId: "run-1",
        payload: {
          executionThreadId: "thread-1",
          type: "MODEL_OUTPUT",
          sequence: index + 1,
          occurredAt: seeded.now(),
          text,
          modelStep: 1,
          providerItemId: "item-1",
        },
      });
    seeded.appendEvent({
      type: "run.executor.event",
      aggregateId: "run-1",
      payload: {
        executionThreadId: "thread-1",
        type: "MODEL_OUTPUT",
        sequence: 9,
        occurredAt: seeded.now(),
        text: "!",
        modelStep: 1,
        providerItemId: "item-1",
      },
    });
    seeded.close();

    const reopened = new SqlitePipelineStore(databasePath);
    openStores.push(reopened);

    const steps = reopened.listAgentLoopSteps("loop-1");
    // 两段连续正文各并成一条，段首的 sequence 保留；中间那条 PROVIDER_ACTIVITY 一条不动。
    expect(steps.filter((step) => step.stepType === "MODEL_TEXT_DELTA").map((step) => [step.sequence, step.payload.text])).toEqual([
      [1, "好的，我"],
      [5, "看一下"],
    ]);
    expect(steps.map((step) => step.stepType)).toEqual(["MODEL_TEXT_DELTA", "PROVIDER_ACTIVITY", "MODEL_TEXT_DELTA"]);
    expect(steps[0]!.payload.providerItemId).toBe("item-1");
    // journal 同理；正文总量守恒。
    const journal = reopened.getExecutionThread("thread-1")!.journal;
    expect(journal.map((entry) => entry.payload.text)).toEqual(["Hello world"]);
    expect(journal.map((entry) => entry.sequence)).toEqual([1]);

    // 事件里带内层序号的两簇按内层序号并段，正文一字不丢。
    expect(reopened.listEvents({ types: ["agent.step.model_text_delta"] }).map((event) => event.payload.text)).toEqual(["你好呀"]);
    expect(reopened.listEvents({ types: ["run.executor.event"] }).map((event) => event.payload.text)).toEqual(["Hello", "!"]);
    // "另有副本"的两簇：步骤表覆盖得住的那簇删掉；探索回合里副本对得上的删、对不上的（取消的回合）留着。
    expect(reopened.listEvents({ types: ["agent.model.text.delta"] })).toEqual([]);
    expect(reopened.listEvents({ types: ["explorer.turn.text.delta"] }).map((event) => [event.payload.turnId, event.payload.text])).toEqual(
      [["turn-cancelled", "模型说了一半"]],
    );

    // 幂等：再开一次没有任何可合并的相邻行。
    reopened.close();
    openStores.splice(openStores.indexOf(reopened), 1);
    const again = new SqlitePipelineStore(databasePath);
    openStores.push(again);
    expect(again.listAgentLoopSteps("loop-1").map((step) => step.sequence)).toEqual(steps.map((step) => step.sequence));
    expect(again.getExecutionThread("thread-1")!.journal.map((entry) => entry.sequence)).toEqual([1]);
  });

  it("把只存在整体快照里的历史 journal 搬进执行日志表", () => {
    // backfillJournalRowsFromSnapshot 的场景：`execution_threads.journal_json` 是这份 journal 的
    // 第二份副本，读路径早已改读 execution_journal 表，所以那条列被丢掉了。
    // 老库里"只有快照、表里没有行"的线程必须先搬进表，否则丢列就等于删数据。
    const directory = mkdtempSync(join(tmpdir(), "pipeline-journal-backfill-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "factory.sqlite");
    const seeded = new SqlitePipelineStore(databasePath);
    seeded.saveRun({
      id: "run-legacy",
      projectId: "project-1",
      planId: "plan-1",
      planRevision: 1,
      status: "IN_PROGRESS",
      branch: "factory/run-legacy",
      workspacePath: "/tmp/run-legacy",
      baseCommit: "abc",
      executionThreadId: "thread-legacy",
      createdAt: seeded.now(),
      startedAt: null,
    });
    seeded.saveExecutionThread({
      id: "thread-legacy",
      runId: "run-legacy",
      state: "ACTIVE",
      journal: [
        { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-09-01T10:00:00.000Z", payload: { planId: "plan-1" } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-09-01T10:00:01.000Z", payload: { text: "hello" } },
      ],
    });
    seeded.close();

    // 把列加回去并只留快照，回到"老库"的形态。
    runRawSql(databasePath, "ALTER TABLE execution_threads ADD COLUMN journal_json TEXT");
    runRawSql(
      databasePath,
      "UPDATE execution_threads SET journal_json = ? WHERE id = ?",
      JSON.stringify([
        { sequence: 1, type: "RUN_CREATED", occurredAt: "2026-09-01T10:00:00.000Z", payload: { planId: "plan-1" } },
        { sequence: 2, type: "MODEL_OUTPUT", occurredAt: "2026-09-01T10:00:01.000Z", payload: { text: "hello" } },
      ]),
      "thread-legacy",
    );
    runRawSql(databasePath, "DELETE FROM execution_journal WHERE execution_thread_id = ?", "thread-legacy");

    const reopened = new SqlitePipelineStore(databasePath);
    openStores.push(reopened);

    expect(reopened.getExecutionThread("thread-legacy")?.journal.map((entry) => entry.sequence)).toEqual([1, 2]);
    // 搬完之后那条快照列就没了：留着一个与表会分叉的副本，是"两份事实"的经典来源。
    expect(runRawSqlColumnNames(databasePath, "execution_threads")).not.toContain("journal_json");
  });
});

describe("SqlitePipelineStore 构造期修复", () => {
  it("blocks a plan that reached a later state without any confirmation record", () => {
    // repairUnconfirmedProgressedPlans 的场景：确认记录（plan.confirmed / plan.revision.confirmed /
    // plan.configuration.revised 事件，或 confirmed_at）缺失，状态却已推进到 QUEUED 之后。
    const { store, databasePath, planId } = seedConfirmedPlan();
    // 把确认的**事实与事件**一起抹掉，只留下"已推进"的状态。
    runRawSql(databasePath, "UPDATE candidate_plans SET confirmed_at = NULL, confirmed_by = NULL, status = 'QUEUED' WHERE id = ?", planId);
    runRawSql(
      databasePath,
      "DELETE FROM domain_events WHERE aggregate_id = ? AND type IN ('plan.confirmed', 'plan.revision.confirmed', 'plan.configuration.revised')",
      planId,
    );
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
    runRawSql(
      databasePath,
      "INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      "aged-delta",
      1,
      "explorer.turn.text.delta",
      "thread-aged",
      "2020-01-01T00:00:00.000Z",
      "{}",
    );
    runRawSql(
      databasePath,
      "INSERT INTO domain_events (id, sequence, type, aggregate_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      "aged-plan",
      2,
      "plan.confirmed",
      "plan-aged",
      "2020-01-01T00:00:00.000Z",
      "{}",
    );

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
