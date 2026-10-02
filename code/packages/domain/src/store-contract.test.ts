/**
 * 测试职责：PipelineStore 的**跨实现契约**套件 —— 同一批断言在 InMemoryPipelineStore 与
 *   SqlitePipelineStore 上各跑一遍，锁住"两种存储对同一份业务代码给出相同的事实与事件语义"。
 *
 * 为什么需要它：PipelineStore 是 91 个成员（89 个必选 + subscribeEvents / runInTransaction）的端口，
 *   **生产用 SQLite，而绝大多数领域测试用内存实现**——在本次建立套件之前，同时跑两者的只有
 *   store-event-query.test.ts 的 listEvents 过滤用例与 explorer-delete.test.ts 的级联删除用例。
 *   其余方法一旦两侧分叉，只会在生产上以"字段读不出来"或"查询少一条"的形式暴露，测试看不见。
 *
 * 覆盖按风险排序，只挑**生产写路径**（见各 describe 的标题）。不是"把所有方法都测一遍"：
 *   无差别覆盖会让本文件变成第二份实现，反而没人读。
 *
 * 为什么本文件自带 helper 而不抽成 store/store-contract.ts：index.ts 的模块可达性约定要求
 *   非测试模块必须落进"barrel 直接转发"或"只被 src 内相对 import"两类之一，**孤立模块算死代码**
 *   （该文件模块头明确写了"孤立模块 0 个"）。抽成非测试模块会正好落进被禁止的第三类。
 *   代价是 store-event-query.test.ts / explorer-delete.test.ts 各自保留一份小 helper —— 那是有意的，
 *   不要为了消重把它们改成互相 import（本仓没有跨测试文件 import 的先例）。
 *
 * 维护提示：
 *   1) `PORT_METHOD_NAMES` 的完整性由 tsc 保证（见下面的 AssertNever）。新增端口方法时**先在
 *      这里加一行**再补两侧实现——顺序反了要等到运行时才发现。
 *   2) 只比较**公共方法表面**。TS 的 private 是编译期概念，私有助手一样挂在 prototype 上，
 *      运行时无法区分，所以本套件不断言"某实现没有多余私有方法"。它断言的是风险更高的那一侧：
 *      端口里的每个必选方法在两侧都真的存在（少一个就是生产上的 `x is not a function`）。
 *   3) 断言的是**两侧相对彼此**的行为，不是绝对数值。凡涉及 id / 时间 / 序号的断言都要写成
 *      "与另一实现相同的关系"，否则会把实现细节当契约钉死。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planContractFixture } from "./plan/plan-fixture.js";
import {
  ExplorerService,
  InMemoryPipelineStore,
  PlanService,
  ProjectService,
  SqlitePipelineStore,
  type DomainEvent,
  type PipelineStore,
  type ToolCallResult,
} from "./index.js";

// ─────────────────────────── 端口方法清单（tsc 保证完整） ───────────────────────────

/** 端口里**必选**的方法：两个实现都必须提供。 */
const REQUIRED_PORT_METHOD_NAMES = [
  "now", "nextId",
  "saveThread", "getThread", "listThreads", "updateThread",
  "saveExplorerPlan", "getExplorerPlan", "listExplorerPlans", "updateExplorerPlan",
  "saveProject", "getProject", "listProjects", "updateProject",
  "saveProjectExecutionThread", "getProjectExecutionThread", "updateProjectExecutionThread",
  "saveProjectExecutionMessage", "getProjectExecutionMessageByClientTurnId", "listProjectExecutionMessages", "updateProjectExecutionMessage",
  "saveProjectConfigRevision", "listProjectConfigRevisions",
  "saveTurn", "updateTurn", "listTurns",
  "saveInputRequest", "getInputRequest", "listInputRequests", "updateInputRequest",
  "savePlan", "getPlan", "listPlans", "updatePlan",
  "saveCandidateVersion", "listCandidateVersions",
  "saveDispatchState", "deleteDispatchState", "getDispatchState", "listDispatchStates",
  "saveRevision", "getRevision", "listRevisions",
  "saveRevisionDraft", "getRevisionDraft", "listRevisionDrafts", "updateRevisionDraft",
  "saveChangeProposal", "getChangeProposal", "listChangeProposals", "updateChangeProposal",
  "saveRun", "getRun", "listRuns",
  "saveExecutionThread", "getExecutionThread", "appendExecutionJournal",
  "saveHookExecution", "listHookExecutions",
  "savePlanQueryProjection", "listPlanQueryProjection",
  "saveVerificationRun", "getVerificationRun", "listVerificationRuns",
  "saveMergeRequest", "getMergeRequest", "findMergeRequestByRun", "listMergeRequests", "updateMergeRequest",
  "saveAgentLoop", "getAgentLoop", "listAgentLoops", "updateAgentLoop",
  "appendAgentLoopStep", "listAgentLoopSteps", "getLastAgentLoopStepSequence", "recoverAgentLoops",
  "saveToolCall", "getToolCall", "listToolCalls", "updateToolCall",
  "appendEvent", "listEvents", "getLastEventSequence", "pruneEvents",
  "deleteExplorerCascade",
  "getIdempotency", "saveIdempotency",
] as const satisfies readonly (keyof PipelineStore)[];

/** 端口里**可选**的方法：按端口注释，两侧不必都提供（当前 subscribeEvents 两侧都有、runInTransaction 只有 SQLite）。 */
const OPTIONAL_PORT_METHOD_NAMES = ["subscribeEvents", "runInTransaction"] as const satisfies readonly (keyof PipelineStore)[];

/** 漏写一个端口方法就在这里编译不过：清单必须与 keyof PipelineStore 完全一致。 */
type AssertNever<Value extends never> = Value;
type UnlistedPortMembers = Exclude<keyof PipelineStore, (typeof REQUIRED_PORT_METHOD_NAMES)[number] | (typeof OPTIONAL_PORT_METHOD_NAMES)[number]>;
const portMethodListIsComplete: AssertNever<UnlistedPortMembers> extends never ? true : never = true;
void portMethodListIsComplete;

// ─────────────────────────── 两种实现的夹具 ───────────────────────────

const openStores: Array<{ close(): void }> = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function memoryStore(): PipelineStore {
  return new InMemoryPipelineStore();
}

function sqliteStore(): PipelineStore {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-store-contract-"));
  temporaryDirectories.push(directory);
  const store = new SqlitePipelineStore(join(directory, "factory.sqlite"));
  openStores.push(store);
  return store;
}

/** 同一组断言在两个实现上各跑一次。两侧行为不一致时，失败的期望值会直接暴露是哪一侧偏了。 */
function assertBothStores(assertion: (store: PipelineStore, kind: "memory" | "sqlite") => void): void {
  assertion(memoryStore(), "memory");
  assertion(sqliteStore(), "sqlite");
}

/** Project + ExplorerThread + 一个已绑定的 Project，满足 savePlan 的投影前提。 */
function seedProjectScope(store: PipelineStore) {
  const projects = new ProjectService(store);
  const project = projects.create({ id: "contract-project", name: "Contract Project", repoRoot: "/repo/contract", defaultBranch: "main", worktreeRoot: "/tmp/contract-worktrees" });
  const explorers = new ExplorerService(store);
  const explorer = explorers.create({ projectId: project.id, title: "Contract Explorer" });
  const explorerPlanId = store.listExplorerPlans(explorer.id)[0]!.id;
  return { projects, project, explorer, explorerPlanId, plans: new PlanService(store, projects) };
}

// ─────────────────────────── 1. 公共方法表面 ───────────────────────────

describe("store contract: 公共方法表面", () => {
  it("exposes every required port method on both implementations", () => {
    assertBothStores((store, kind) => {
      const missing = REQUIRED_PORT_METHOD_NAMES.filter((name) => typeof (store as unknown as Record<string, unknown>)[name] !== "function");
      expect(missing, `${kind} store is missing port methods`).toEqual([]);
    });
  });

  it("keeps subscribeEvents on both implementations because the scheduler subscribes through the port", () => {
    assertBothStores((store) => {
      expect(typeof store.subscribeEvents).toBe("function");
    });
  });

  it("provides runInTransaction only where the port says it is optional", () => {
    // 端口注释 4：SQLite 提供它以保证启动恢复与级联删除的原子性，内存实现不需要。
    // 这条断言把"可选"钉成事实，避免将来有人误以为两侧都该有而给内存实现补一个假的。
    expect(typeof memoryStore().runInTransaction).toBe("undefined");
    expect(typeof sqliteStore().runInTransaction).toBe("function");
  });
});

// ─────────────────────────── 2. 事件追加与查询 ───────────────────────────

describe("store contract: 事件追加与查询", () => {
  it("assigns an id, a timestamp and a strictly increasing sequence on append", () => {
    assertBothStores((store) => {
      const first = store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: { revision: 1 } });
      const second = store.appendEvent({ type: "plan.enqueued", aggregateId: "plan-a", payload: { revision: 1 } });

      expect(first.id).toBeTruthy();
      expect(second.id).not.toBe(first.id);
      expect(second.sequence).toBeGreaterThan(first.sequence);
      expect(Number.isNaN(Date.parse(first.occurredAt))).toBe(false);
      expect(store.getLastEventSequence()).toBe(second.sequence);
    });
  });

  it("scopes getLastEventSequence to an aggregate when asked", () => {
    assertBothStores((store) => {
      store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: {} });
      store.appendEvent({ type: "plan.enqueued", aggregateId: "plan-b", payload: {} });

      expect(store.getLastEventSequence("plan-a")).toBeLessThan(store.getLastEventSequence("plan-b"));
      expect(store.getLastEventSequence("plan-missing")).toBe(0);
    });
  });

  it("redacts sensitive keys and values identically in both implementations", () => {
    // 脱敏发生在 appendEvent 内部（见 store/sqlite-store.ts 模块头 4），是**存储层**的职责。
    // 两个实现漂移的话，同一份业务代码会在一种存储下泄露凭据，另一种不会。
    assertBothStores((store) => {
      const event = store.appendEvent({
        type: "agent.step.tool_requested",
        aggregateId: "loop-a",
        payload: {
          apiKey: "sk-secret-value",
          nested: { authorization: "Bearer abc.def" },
          message: "contact me at person@example.com",
          safe: "kept",
        },
      });

      expect(event.payload.apiKey).toBe("[REDACTED]");
      expect((event.payload.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
      expect(event.payload.message).toBe("contact me at [REDACTED_EMAIL]");
      expect(event.payload.safe).toBe("kept");
    });
  });

  it("delivers appended events to port subscribers", () => {
    assertBothStores((store) => {
      const seen: DomainEvent[] = [];
      const unsubscribe = store.subscribeEvents?.((event) => seen.push(event));
      store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: {} });
      unsubscribe?.();

      expect(seen.map((event) => event.type)).toEqual(["plan.confirmed"]);
    });
  });
});

// ─────────────────────────── 2b. 事件回收 ───────────────────────────

/**
 * 回收是唯一会**删除已持久化数据**的端口方法，两个实现在同一份数据上删出的结果必须一样。
 * SQLite 侧用一条带窗口函数的 DELETE 表达规则，内存侧用 store/event-retention.ts 的纯函数——
 * 两套机制表达同一条规格，所以这一节就是那条规格的执行版本。
 *
 * 时间点由入参给：appendEvent 的 occurredAt 由存储层生成，调用方造不出"过去的事件"，
 * 所以测试用"很远的将来 / 很远的过去"两个 cutoff 来表达"全删 / 全留"。
 */
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const FAR_PAST = "2000-01-01T00:00:00.000Z";

describe("store contract: 事件回收", () => {
  it("deletes nothing when the cutoff is in the past", () => {
    assertBothStores((store) => {
      store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "thread-a", payload: { text: "a" } });
      store.appendEvent({ type: "agent.step.model_text_delta", aggregateId: "loop-a", payload: { text: "b" } });

      expect(store.pruneEvents({ cutoff: FAR_PAST, minPerAggregate: 0 })).toEqual({ deleted: 0 });
      expect(store.listEvents({})).toHaveLength(2);
    });
  });

  it("never deletes event types outside the prunable whitelist", () => {
    // 这条是整件事的安全底线：白名单之外的每一条都可能是状态机的输入。
    assertBothStores((store) => {
      store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: {} });
      store.appendEvent({ type: "verification.completed", aggregateId: "run-a", payload: {} });
      store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "thread-a", payload: { text: "gone" } });

      expect(store.pruneEvents({ cutoff: FAR_FUTURE, minPerAggregate: 0 })).toEqual({ deleted: 1 });
      expect(store.listEvents({}).map((event) => event.type)).toEqual(["plan.confirmed", "verification.completed"]);
    });
  });

  it("keeps the newest minPerAggregate prunable events per aggregate", () => {
    assertBothStores((store) => {
      for (const text of ["一", "二", "三"]) store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "thread-a", payload: { text } });
      for (const text of ["甲", "乙"]) store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "thread-b", payload: { text } });

      // thread-a 有 3 条、保底 2 → 只删最旧的一条；thread-b 只有 2 条 → 一条都不删。
      expect(store.pruneEvents({ cutoff: FAR_FUTURE, minPerAggregate: 2 })).toEqual({ deleted: 1 });
      expect(store.listEvents({ aggregateId: "thread-a" }).map((event) => event.payload.text)).toEqual(["二", "三"]);
      expect(store.listEvents({ aggregateId: "thread-b" })).toHaveLength(2);
    });
  });

  it("never prunes run.executor.event, not even its MODEL_OUTPUT payloads", () => {
    // 这条曾经是反过来的：MODEL_OUTPUT 的 run.executor.event 进过白名单，依据是"它是
    // execution_journal 的镜像"。在真实库上逐行验证后发现那条依据不成立——历史行的载荷没有
    // `sequence` 字段无法与 journal 关联，且绝大多数属于**已删除的 run**（journal 与
    // execution_thread 一起没了），事件是那段输出的唯一记录。此处按新规则钉死：
    // 这个类型无论载荷是什么都不回收。
    assertBothStores((store) => {
      store.appendEvent({ type: "run.executor.event", aggregateId: "run-a", payload: { type: "MODEL_OUTPUT", text: "token" } });
      store.appendEvent({ type: "run.executor.event", aggregateId: "run-a", payload: { type: "TOOL_CALLED", tool: "read_file" } });

      expect(store.pruneEvents({ cutoff: FAR_FUTURE, minPerAggregate: 0 })).toEqual({ deleted: 0 });
      expect(store.listEvents({})).toHaveLength(2);
    });
  });

  it("does not rewind the event sequence: later appends still get a higher number", () => {
    // 回收只摘行，不动序号高水位。序号退回会让后续事件与已存在的行撞号
    // （SQLite 上 domain_events.sequence 是 UNIQUE），也会让 Last-Event-ID 回放错乱。
    assertBothStores((store) => {
      store.appendEvent({ type: "explorer.turn.text.delta", aggregateId: "thread-a", payload: {} });
      const before = store.getLastEventSequence();
      store.pruneEvents({ cutoff: FAR_FUTURE, minPerAggregate: 0 });

      expect(store.appendEvent({ type: "plan.confirmed", aggregateId: "plan-a", payload: {} }).sequence).toBeGreaterThan(before);
      expect(store.getLastEventSequence()).toBeGreaterThan(before);
    });
  });
});

// ─────────────────────────── 3. Agent Loop 步骤 ───────────────────────────

describe("store contract: Agent Loop 步骤", () => {
  function seedLoop(store: PipelineStore): string {
    store.saveAgentLoop({ id: "loop-contract", ownerType: "explorer-turn", ownerId: "turn-1", role: "explorer", mode: "provider-controlled", state: "RUNNING", stepCount: 0, maxSteps: 8, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });
    return "loop-contract";
  }

  it("assigns a contiguous per-loop step sequence and reports the last one", () => {
    assertBothStores((store) => {
      const loopId = seedLoop(store);
      const first = store.appendAgentLoopStep({ loopId, stepType: "MODEL_STARTED", status: "RUNNING", payload: { role: "explorer" } });
      const second = store.appendAgentLoopStep({ loopId, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "hello" } });

      expect(second.sequence).toBe(first.sequence + 1);
      expect(store.getLastAgentLoopStepSequence(loopId)).toBe(second.sequence);
      expect(store.getLastAgentLoopStepSequence("loop-missing")).toBe(0);
    });
  });

  it("round-trips the step payload and preserves append order", () => {
    assertBothStores((store) => {
      const loopId = seedLoop(store);
      store.appendAgentLoopStep({ loopId, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "先分析", providerItemId: "item-1" } });
      store.appendAgentLoopStep({ loopId, stepType: "GATE_CHECKED", status: "COMPLETED", payload: { action: "blocked", reason: "incomplete" } });

      const steps = store.listAgentLoopSteps(loopId);

      expect(steps.map((step) => step.stepType)).toEqual(["MODEL_TEXT_DELTA", "GATE_CHECKED"]);
      expect(steps[0]?.payload).toMatchObject({ text: "先分析", providerItemId: "item-1" });
      expect(steps[1]?.payload).toMatchObject({ action: "blocked", reason: "incomplete" });
    });
  });

  it("filters steps by type in the store rather than at the call site", () => {
    // 这是 loopDiagnostics 把"读取整个 Loop 历史"降为"读取少量相关步骤"的手段（见 projections/agent-loop.ts）。
    assertBothStores((store) => {
      const loopId = seedLoop(store);
      store.appendAgentLoopStep({ loopId, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "a" } });
      store.appendAgentLoopStep({ loopId, stepType: "PROVIDER_ACTIVITY", status: "COMPLETED", payload: { activityId: "act-1" } });
      store.appendAgentLoopStep({ loopId, stepType: "MODEL_TEXT_DELTA", status: "COMPLETED", payload: { text: "b" } });

      expect(store.listAgentLoopSteps(loopId, { stepTypes: ["PROVIDER_ACTIVITY"] }).map((step) => step.stepType)).toEqual(["PROVIDER_ACTIVITY"]);
      expect(store.listAgentLoopSteps(loopId, { stepTypes: [] })).toEqual([]);
    });
  });

  it("keeps steps of different loops apart", () => {
    assertBothStores((store) => {
      const first = seedLoop(store);
      store.saveAgentLoop({ id: "loop-other", ownerType: "explorer-turn", ownerId: "turn-2", role: "explorer", mode: "provider-controlled", state: "RUNNING", stepCount: 0, maxSteps: 8, startedAt: store.now(), completedAt: null, providerThreadId: null, providerTurnId: null, checkpointJson: null });
      store.appendAgentLoopStep({ loopId: first, stepType: "MODEL_STARTED", status: "RUNNING", payload: {} });
      store.appendAgentLoopStep({ loopId: "loop-other", stepType: "MODEL_STARTED", status: "RUNNING", payload: {} });

      expect(store.listAgentLoopSteps(first)).toHaveLength(1);
      expect(store.listAgentLoopSteps("loop-other")).toHaveLength(1);
    });
  });
});

// ─────────────────────────── 4. Plan 与查询投影 ───────────────────────────

describe("store contract: Plan 与查询投影", () => {
  it("writes a Plan Center query projection whenever a Plan is saved", () => {
    // 投影与事实的双写是 query.ts 模块头警告的漂移点，所以把"保存 Plan 必产生可查投影"钉住。
    assertBothStores((store) => {
      const { project, explorer, explorerPlanId, plans } = seedProjectScope(store);
      const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "Contract plan",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Contract plan" }) });

      const rows = store.listPlanQueryProjection(project.id);

      expect(rows.map((row) => row.planId)).toEqual([plan.id]);
      expect(rows[0]?.title).toBe("Contract plan");
    });
  });

  it("refreshes the query projection when the Plan is updated", () => {
    assertBothStores((store) => {
      const { project, explorer, explorerPlanId, plans } = seedProjectScope(store);
      const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "Before",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Before" }) });
      store.updatePlan({ ...store.getPlan(plan.id)!, title: "After" });

      expect(store.listPlanQueryProjection(project.id)[0]?.title).toBe("After");
    });
  });

  it("round-trips revised Plan versions through saveCandidateVersion", () => {
    assertBothStores((store) => {
      const { project, explorer, explorerPlanId, plans } = seedProjectScope(store);
      const plan = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "Versioned",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Versioned" }) });
      store.saveCandidateVersion({ ...store.getPlan(plan.id)!, revision: 2 });
      store.saveCandidateVersion({ ...store.getPlan(plan.id)!, revision: 3 });

      expect(store.listCandidateVersions(plan.id).map((version) => version.revision).sort()).toEqual([1, 2, 3]);
    });
  });

  it("keeps dispatch state per Plan and removes only the named one", () => {
    assertBothStores((store) => {
      const { project, explorer, explorerPlanId, plans } = seedProjectScope(store);
      const first = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "First",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "First" }) });
      const second = plans.createCandidatePlan({ projectId: project.id, sourceExplorerThreadId: explorer.id, explorerPlanId, title: "Second",
      resolvedContract: planContractFixture({ store, projectId: project.id, title: "Second" }) });
      const state = { planId: first.id, projectId: project.id, status: "QUEUED", waitReason: null, queuedAt: store.now(), runId: null, attempt: 1, updatedAt: store.now(), lastError: null } as const;
      store.saveDispatchState(state);
      store.saveDispatchState({ ...state, planId: second.id });

      store.deleteDispatchState(first.id);

      expect(store.getDispatchState(first.id)).toBeUndefined();
      expect(store.getDispatchState(second.id)).toBeDefined();
      expect(store.listDispatchStates(project.id)).toHaveLength(1);
    });
  });
});

// ─────────────────────────── 5. Run / 合并状态 ───────────────────────────

describe("store contract: Run 与合并状态", () => {
  it("finds a MergeRequest by its Run and keeps the update visible", () => {
    assertBothStores((store) => {
      store.saveMergeRequest({ id: "merge-1", runId: "run-1", planId: "plan-1", sourceCommit: "abc", targetBranch: "main", status: "OPEN", humanConfirmationRequired: true, createdAt: store.now(), mergedAt: null });
      expect(store.findMergeRequestByRun("run-1")?.id).toBe("merge-1");
      expect(store.findMergeRequestByRun("run-missing")).toBeUndefined();

      store.updateMergeRequest({ ...store.getMergeRequest("merge-1")!, status: "MERGED", mergedAt: store.now() });

      expect(store.getMergeRequest("merge-1")?.status).toBe("MERGED");
    });
  });

  it("appends execution journal entries with a contiguous per-run sequence", () => {
    // 必须先建 Run：execution_journal.run_id 在 SQLite 上有外键，内存实现不做校验。
    // 这个差异是有意的（内存是宽松的测试替身），但正因如此，夹具必须建出真实的前置事实——
    // 否则这组断言在内存上过、在 SQLite 上抛 FOREIGN KEY，等于把替身的宽松当成契约。
    assertBothStores((store) => {
      store.saveRun({ id: "run-1", projectId: "project-1", planId: "plan-1", planRevision: 1, status: "IN_PROGRESS", branch: "factory/run-1", workspacePath: "/tmp/run-1", baseCommit: "HEAD", executionThreadId: "thread-1", createdAt: store.now(), startedAt: store.now() });
      store.saveExecutionThread({ id: "thread-1", runId: "run-1", state: "ACTIVE", journal: [] });
      const first = store.appendExecutionJournal({ executionThreadId: "thread-1", runId: "run-1", type: "RUN_CREATED", payload: {} });
      const second = store.appendExecutionJournal({ executionThreadId: "thread-1", runId: "run-1", type: "MODEL_OUTPUT", payload: { text: "hi" } });

      expect(second.sequence).toBe(first.sequence + 1);
      expect(second.payload).toMatchObject({ text: "hi" });
    });
  });

  it("round-trips persisted tool calls", () => {
    assertBothStores((store) => {
      store.saveToolCall({ callId: "call-1", loopId: "loop-1", role: "explorer", tool: "read_file", status: "PENDING", inputHash: "sha256:abc", result: null, startedAt: store.now(), completedAt: null });

      expect(store.getToolCall("call-1")?.status).toBe("PENDING");

      const outcome: ToolCallResult = { callId: "call-1", allowed: true, status: "SUCCEEDED", reason: null, result: { content: "file body" }, audited: true };
      store.updateToolCall({ ...store.getToolCall("call-1")!, status: "SUCCEEDED", result: outcome, completedAt: store.now() });

      expect(store.getToolCall("call-1")?.status).toBe("SUCCEEDED");
      expect(store.getToolCall("call-1")?.result?.result).toMatchObject({ content: "file body" });
      expect(store.listToolCalls("loop-1")).toHaveLength(1);
    });
  });

  it("round-trips verification runs keyed by Run, including the SKIPPED reason", () => {
    // reason 曾经只存在于内存实现：SQLite 的 verification_runs 建表语句漏了该列，
    // 于是生产上 NO_PROJECT_VERIFICATION_COMMANDS 永远读不出来，而内存测试全绿。
    // 这条断言就是那次漂移的守卫——两侧都必须把 reason 存下来并原样读回。
    assertBothStores((store) => {
      store.saveVerificationRun({ id: "verify-1", runId: "run-1", status: "SKIPPED", repairAttempts: 0, commandResults: [], reason: "NO_PROJECT_VERIFICATION_COMMANDS", completedAt: store.now() });
      store.saveVerificationRun({ id: "verify-2", runId: "run-2", status: "PASSED", repairAttempts: 0, commandResults: [], completedAt: store.now() });

      expect(store.getVerificationRun("run-1")?.reason).toBe("NO_PROJECT_VERIFICATION_COMMANDS");
      expect(store.listVerificationRuns("run-1")).toHaveLength(1);
      // 没有 reason 的行不能补出默认值："未记录"与"已记录为未配置验证命令"是两件事。
      expect(store.getVerificationRun("run-2")?.reason).toBeUndefined();
    });
  });
});

// ─────────────────────────── 6. 幂等与事务 ───────────────────────────

describe("store contract: 幂等与事务", () => {
  it("stores idempotency results per scope and never lets a later write replace the first", () => {
    // 端口注释 6：首次写入生效。这不是实现细节，而是幂等契约本身——
    // 重放同一个 clientTurnId 必须拿到**原来**那条结果，否则"重试"会返回一个不同的业务事实。
    assertBothStores((store) => {
      store.saveIdempotency("turn", "key-1", { turnId: "turn-1" });

      expect(store.getIdempotency("turn", "key-1")).toEqual({ turnId: "turn-1" });
      expect(store.getIdempotency("turn", "key-other")).toBeUndefined();
      expect(store.getIdempotency("other-scope", "key-1")).toBeUndefined();

      store.saveIdempotency("turn", "key-1", { turnId: "turn-2" });

      expect(store.getIdempotency("turn", "key-1")).toEqual({ turnId: "turn-1" });
    });
  });

  it("commits a SQLite transaction body and rolls back one that throws", () => {
    // 端口注释 4：runInTransaction 是启动恢复与级联删除原子性的唯一保证，只在 SQLite 上存在。
    // 回滚方向是重点——SQLite 默认 autocommit，若事务体抛错后没回滚，级联删除会只完成一半。
    const store = sqliteStore();
    store.runInTransaction?.(() => {
      store.saveIdempotency("turn", "committed", { ok: true });
    });
    expect(store.getIdempotency("turn", "committed")).toEqual({ ok: true });

    expect(() => store.runInTransaction?.(() => {
      store.saveIdempotency("turn", "rolled-back", { ok: true });
      throw new Error("transaction body failed");
    })).toThrow(/transaction body failed/);

    expect(store.getIdempotency("turn", "rolled-back")).toBeUndefined();
  });
});
