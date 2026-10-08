/**
 * 测试职责：锁住执行会话的**分组与折叠**——哪个组的条目该是哪些、折叠区里放谁、
 * 组头与折叠标题上那几个数是怎么算的。这一簇此前只被 `RunDetailView.test.ts` 的源码断言覆盖
 * （"这段代码还在不在"），行为一条都没测过；搬进 utils 之后补上。
 *
 * 设计说明：纯函数、无 DOM、无响应式——线程状态由参数传，所以"这一步还在跑吗"可以直接摆出来测。
 *
 * 维护提示：`continuation` 那一组的关键判据是投影打上的 `item.continuation`（不是 loopId、不是 taskId）；
 * 改分组语义时，`projectExecutionJournal` 的收尾那一段与这里要一起看。
 */
import { describe, expect, it } from "vitest";
import type { ExecutionTask } from "../types";
import type { ExecutionStreamItem } from "./executionStream";
import {
  buildExecutionConversation,
  continuationHeading,
  failedCount,
  foldedItems,
  isRunActivity,
  stepDuration,
  taskGroupEmptyNote,
  unclassifiedCount,
  visibleItems,
} from "./executionConversation";

function item(patch: Partial<ExecutionStreamItem> & Pick<ExecutionStreamItem, "id" | "kind" | "messageType">): ExecutionStreamItem {
  return {
    role: "assistant",
    title: patch.id,
    content: "",
    detail: "",
    status: "COMPLETED",
    occurredAt: "2026-10-08T00:00:00.000Z",
    sequence: 1,
    ...patch,
  } as ExecutionStreamItem;
}

function task(id: string, patch: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id,
    title: `步骤 ${id}`,
    status: "DONE",
    evidenceSequence: null,
    blockedReason: null,
    startedAt: null,
    completedAt: null,
    ...patch,
  } as ExecutionTask;
}

/** 一条"该折起来的过程记录"：过程权重 + 已完成 + 不是失败。 */
const processLine = (id: string, patch: Partial<ExecutionStreamItem> = {}) =>
  item({ id, kind: "tool", messageType: "TOOL_CALL", status: "COMPLETED", ...patch });

describe("buildExecutionConversation", () => {
  it("组的顺序：冻结方案 → 各计划任务（按任务顺序）→ 补充要求那一轮 → 未归属", () => {
    const messages = [
      item({ id: "plan", kind: "plan", messageType: "PLAN" }),
      item({ id: "t1", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-1" }),
      item({ id: "t2", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-2" }),
      item({
        id: "g",
        kind: "user",
        messageType: "USER_MESSAGE",
        role: "user",
        content: "再补一条",
        continuation: true,
        continuationRound: 1,
      }),
      item({ id: "orphan", kind: "model", messageType: "ASSISTANT_MESSAGE" }),
    ];

    const groups = buildExecutionConversation(messages, [task("task-1"), task("task-2")]);

    expect(groups.map((group) => group.kind)).toEqual(["plan", "task", "task", "continuation", "unattributed"]);
    expect(groups.map((group) => group.id)).toEqual(["plan", "task-task-1", "task-task-2", "continuation-1", "unattributed"]);
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(["t1"]);
    expect(groups[3]?.items.map((entry) => entry.id)).toEqual(["g"]);
  });

  it("**补充轮一条都不进任务组、也不进未归属**（同一条消息渲染两次是实测过的）", () => {
    const messages = [
      item({ id: "t1", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-1" }),
      item({ id: "g", kind: "user", messageType: "USER_MESSAGE", role: "user", continuation: true, continuationRound: 1 }),
      item({ id: "g-work", kind: "tool", messageType: "TOOL_CALL", continuation: true, continuationRound: 1 }),
    ];

    const groups = buildExecutionConversation(messages, [task("task-1")]);

    expect(groups.find((group) => group.kind === "task")?.items.map((entry) => entry.id)).toEqual(["t1"]);
    expect(groups.find((group) => group.kind === "continuation")?.items.map((entry) => entry.id)).toEqual(["g", "g-work"]);
    expect(groups.find((group) => group.kind === "unattributed")).toBeUndefined();
  });

  it("**一轮补充一组**：两轮各写自己那句话，编号按顺序", () => {
    const messages = [
      item({
        id: "g1",
        kind: "user",
        messageType: "USER_MESSAGE",
        role: "user",
        content: "第一句",
        continuation: true,
        continuationRound: 1,
      }),
      item({ id: "w1", kind: "model", messageType: "ASSISTANT_MESSAGE", continuation: true, continuationRound: 1 }),
      item({
        id: "g2",
        kind: "user",
        messageType: "USER_MESSAGE",
        role: "user",
        content: "第二句",
        continuation: true,
        continuationRound: 2,
      }),
    ];

    const groups = buildExecutionConversation(messages, []);
    const rounds = groups.filter((group) => group.kind === "continuation");

    expect(rounds.map((group) => group.id)).toEqual(["continuation-1", "continuation-2"]);
    expect(continuationHeading(rounds[0]!)).toBe("第一句");
    expect(continuationHeading(rounds[1]!)).toBe("第二句");
  });

  it("Run 级活动不留在会话里，由顶部运行上下文卡承载", () => {
    const messages = [
      item({ id: "run-created", kind: "activity", messageType: "RUN_ACTIVITY" }),
      item({ id: "t1", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-1" }),
    ];

    const groups = buildExecutionConversation(messages, [task("task-1")]);

    expect(groups.some((group) => group.items.some((entry) => entry.id === "run-created"))).toBe(false);
    expect(isRunActivity(item({ id: "x", kind: "activity", messageType: "RUN_ACTIVITY" }))).toBe(true);
    // 补充轮同样没有 taskId，但它不是 Run 级活动——不排就会被吸进那张卡。
    expect(isRunActivity(item({ id: "y", kind: "activity", messageType: "RUN_ACTIVITY", continuation: true }))).toBe(false);
  });

  it("**连续的空步骤折成一行**；中间夹着有内容的步骤时分开显示", () => {
    const messages = [item({ id: "t2", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-2" })];

    const groups = buildExecutionConversation(messages, [task("task-1"), task("task-2"), task("task-3")]);

    // 首尾两个空步骤各折一行、中间那个有内容的没有被并进去：
    // "跳过第 1 步先做第 2 步"这件事看得出来，而空步骤不占三张卡。
    expect(groups.map((group) => group.kind)).toEqual(["pending", "task", "pending"]);
    expect(groups[0]?.tasks?.map((entry) => entry.id)).toEqual(["task-1"]);
    expect(groups[2]?.tasks?.map((entry) => entry.id)).toEqual(["task-3"]);
  });
});

describe("折叠与计数", () => {
  const group = buildExecutionConversation(
    [
      item({ id: "done", kind: "model", messageType: "ASSISTANT_MESSAGE", taskId: "task-1", content: "结论" }),
      processLine("ok", { taskId: "task-1" }),
      processLine("bad", { taskId: "task-1", status: "FAILED" }),
      item({ id: "weird", kind: "activity", messageType: "UNCLASSIFIED", taskId: "task-1", status: "INFO" }),
      item({ id: "compact", kind: "activity", messageType: "PROVIDER_COMPACTION", taskId: "task-1" }),
    ],
    [task("task-1", { status: "DONE" })],
  ).find((entry) => entry.kind === "task")!;

  it("折的是**过程**且这一步已跑完；失败留在外面，`hidden` 两条路径都不进", () => {
    expect(foldedItems(group, "COMPLETED").map((entry) => entry.id)).toEqual(["ok", "weird"]);
    // `hidden` 的那条不是内容，是 Provider 的机制回显——既不折也不显示。
    expect(visibleItems(group, "COMPLETED").map((entry) => entry.id)).toEqual(["done", "bad"]);
  });

  it("**这一步还在跑就一条都不折**（任务自己的状态说了算，不看线程）", () => {
    const running = buildExecutionConversation([processLine("ok", { taskId: "task-1" })], [task("task-1", { status: "IN_PROGRESS" })]).find(
      (entry) => entry.kind === "task",
    )!;

    // 线程还是 ACTIVE，但任务已经 DONE → 照折；反过来任务是 IN_PROGRESS → 一条都不折。
    expect(foldedItems(group, "ACTIVE").map((entry) => entry.id)).toEqual(["ok", "weird"]);
    expect(foldedItems(running, "COMPLETED")).toEqual([]);
    expect(visibleItems(running, "COMPLETED").map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("**没有任务归属的组看线程状态**：Run 还活着就宁可多显示一行", () => {
    const orphan = buildExecutionConversation([processLine("ok")], []).find((entry) => entry.kind === "unattributed")!;

    expect(foldedItems(orphan, "ACTIVE")).toEqual([]);
    expect(foldedItems(orphan, "COMPLETED").map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("失败数与未识别数只数**没被折进去**的那些（它们要写在折叠标题上）", () => {
    expect(failedCount(group, "COMPLETED")).toBe(1);
    // "认不出来"的那条确实被折了，而**数量写在折叠标题上**——这件事本身不能悄悄藏掉。
    expect(unclassifiedCount(group, "COMPLETED")).toBe(1);
  });
});

describe("组头的几个数", () => {
  it("用时取任务自己的生命周期事实；拿不到就**不编**（返回 null 让那一格消失）", () => {
    const group = buildExecutionConversation([], [task("task-1")])[0]!;
    expect(stepDuration({ ...group, task: task("task-1") })).toBeNull();
    expect(
      stepDuration({ ...group, task: task("task-1", { startedAt: "2026-10-08T00:00:00.000Z", completedAt: "2026-10-08T00:02:03.000Z" }) }),
    ).toBe("2 分 3 秒");
    // 只有开始没有完成（还在跑）：同样不显示，而不是按"到现在"估一个。
    expect(stepDuration({ ...group, task: task("task-1", { startedAt: "2026-10-08T00:00:00.000Z" }) })).toBeNull();
  });

  it("补充要求那一组的标题写你补的那句话，长了就截断", () => {
    const long = "把执行会话里那些没有归属的条目全部重新归一遍，并且把每一组的过程记录按时间顺序重新排好，再跑一次验证";
    const group = buildExecutionConversation(
      [item({ id: "g", kind: "user", messageType: "USER_MESSAGE", role: "user", content: long, continuation: true, continuationRound: 1 })],
      [],
    )[0]!;

    expect(continuationHeading(group)).toBe(`${long.slice(0, 44)}…`);
    // 这一组里没有你说的那句话时不留空组头（`STEER` 那种条目可能先到）。
    const withoutPrompt = buildExecutionConversation(
      [item({ id: "w", kind: "model", messageType: "ASSISTANT_MESSAGE", continuation: true, continuationRound: 1 })],
      [],
    )[0]!;
    expect(continuationHeading(withoutPrompt)).toBe("这一轮");
  });

  it("空步骤那一行按**为什么空**分四种说法", () => {
    expect(taskGroupEmptyNote(task("t", { status: "PENDING" }))).toBe("尚无结构化进度事件表明此任务已开始。");
    expect(taskGroupEmptyNote(task("t", { status: "UNKNOWN" }))).toBe("此任务的执行状态和关联会话未记录。");
    expect(taskGroupEmptyNote(task("t", { status: "BLOCKED", blockedReason: "等上游合并" }))).toBe("等上游合并");
    expect(taskGroupEmptyNote(task("t", { status: "BLOCKED" }))).toBe("阻塞原因未记录。");
    expect(taskGroupEmptyNote(task("t", { status: "IN_PROGRESS" }))).toBe("此任务暂未关联到已记录的执行消息。");
  });
});
