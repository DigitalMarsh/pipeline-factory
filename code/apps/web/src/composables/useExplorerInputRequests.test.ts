// @vitest-environment jsdom
/**
 * 测试职责：锁住结构化输入请求的**状态机**——落位规则、草稿取舍、提交的并发与失败分支。
 *
 * 设计说明：
 * 1. composable 不用生命周期钩子，直接在测试里调用即可（无需 `createApp`，无需组件）。
 *    **本文件需要 jsdom**：草稿读写走 `window.sessionStorage`，node 环境下
 *    `getSessionStorage()` 返回 null，草稿分支会全部变成 no-op 而**假绿**——
 *    这是本文件唯一必须用 jsdom 的理由（其余 composable 测试都是 node 环境）。
 * 2. 依赖以 `ref` 注入；`thread` 用**形状桩**（只读它的 `id`），`inputDialog` 用记录调用的桩。
 *    请求 fixture 则是**真形状**：本 composable 会读 `status` / `explorerPlanId` /
 *    `questions` / `id`，用桩会掩盖落位与过滤规则。
 * 3. `../api` 与 `element-plus` 都 mock。ElMessage 不是被测对象，但它承载了两条
 *    **用户可见的失败语义**（"已保留本次选择" / "请勿重复提交"），所以断言它。
 *
 * 维护提示：`setInputRequests` 的四条落位规则、`submitInput` 的失败分支、
 * 以及"草稿只在请求属于当前 thread + 当前需求时才落盘"这三处是本文件的重点。
 * 新加状态时请补到对应 describe 里，不要只测成功路径。
 */
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { ExplorerInputRequest, ExplorerThread, ExplorerTurn, ModelInputQuestion } from "../types";
import { explorerInputProgressDraftKey, saveExplorerInputProgressDraft } from "../utils/explorerInputProgressDraft";
import { useExplorerInputRequests, type ExplorerInputDialogHandle } from "./useExplorerInputRequests";

vi.mock("../api", () => ({
  api: { answerInput: vi.fn(), inputRequests: vi.fn(), cancelExplorerTurn: vi.fn() },
}));
vi.mock("element-plus", () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const scope = { projectId: "project-1", threadId: "explorer-1", explorerPlanId: "requirement-1" };

const question = (id: string, overrides: Partial<ModelInputQuestion> = {}): ModelInputQuestion => ({
  id,
  header: id,
  question: id,
  isOther: false,
  isSecret: false,
  options: null,
  ...overrides,
});

const request = (id: string, overrides: Partial<ExplorerInputRequest> = {}): ExplorerInputRequest => ({
  id,
  threadId: "explorer-1",
  localTurnId: `turn-${id}`,
  providerRequestId: id,
  providerThreadId: "provider-1",
  providerTurnId: "provider-turn-1",
  itemId: `item-${id}`,
  questions: [question(`q-${id}`)],
  isBlocking: true,
  status: "OPEN",
  createdAt: "2026-09-01T10:00:00.000Z",
  answeredAt: null,
  answeredBy: null,
  redactedAnswerSummary: null,
  explorerPlanId: "requirement-1",
  ...overrides,
});

const turnStub = { id: "turn-1" } as unknown as ExplorerTurn;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedDraft(item: ExplorerInputRequest, values: Record<string, string[]> = { [`q-${item.id}`]: ["A"] }) {
  saveExplorerInputProgressDraft(scope, item, { requestId: item.id, currentIndex: 0, values, otherValues: {} });
}

const draftKey = (item: ExplorerInputRequest) => explorerInputProgressDraftKey(scope, item.id);
const hasDraft = (item: ExplorerInputRequest) => window.sessionStorage.getItem(draftKey(item)) !== null;

function setup(options: { activeExplorerPlanId?: string | null; threadId?: string | null } = {}) {
  const projectId = ref("project-1");
  const thread = ref<ExplorerThread | null>(
    options.threadId === null ? null : ({ id: options.threadId ?? "explorer-1" } as unknown as ExplorerThread),
  );
  const activeExplorerPlanId = ref<string | null>(
    options.activeExplorerPlanId === undefined ? "requirement-1" : options.activeExplorerPlanId,
  );
  const inputDialog = ref<ExplorerInputDialogHandle | null>(null);
  const composable = useExplorerInputRequests({ projectId, thread, activeExplorerPlanId, inputDialog });
  return { ...composable, projectId, thread, activeExplorerPlanId, inputDialog };
}

/** 记录 `onSubmitted` / `onFailed` 调用的对话框桩。 */
function dialogStub(): { handle: ExplorerInputDialogHandle; submitted: () => number; failed: () => string[] } {
  const failed: string[] = [];
  let submitted = 0;
  return {
    handle: {
      onSubmitted: () => {
        submitted += 1;
      },
      onFailed: (message) => {
        failed.push(message);
      },
    },
    submitted: () => submitted,
    failed: () => failed,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.mocked(api.answerInput).mockReset();
  vi.mocked(api.inputRequests).mockReset();
  vi.mocked(api.cancelExplorerTurn).mockReset();
  vi.mocked(ElMessage.success).mockReset();
  vi.mocked(ElMessage.error).mockReset();
  vi.mocked(ElMessage.info).mockReset();
  vi.mocked(ElMessage.warning).mockReset();
});

describe("setInputRequests 的落位规则", () => {
  it("OPEN 落 pendingInput、RECOVERY_REQUIRED 落 recoveryInput，其余不落", () => {
    const s = setup();
    const open = request("r-open");
    const recovery = request("r-recovery", { status: "RECOVERY_REQUIRED" });

    s.setInputRequests([request("r-answered", { status: "ANSWERED" }), open, recovery]);

    expect(s.pendingInput.value?.id).toBe("r-open");
    expect(s.recoveryInput.value?.id).toBe("r-recovery");
    // 全表仍然原样保存——落位只是挑出"当前该显示谁"，不是过滤掉其余项。
    expect(s.inputRequests.value.map((item) => item.id)).toEqual(["r-answered", "r-open", "r-recovery"]);
  });

  it("没有 OPEN 也没有 RECOVERY_REQUIRED 时两个落点都为空", () => {
    const s = setup();
    s.setInputRequests([request("r-answered", { status: "ANSWERED" })]);

    expect(s.pendingInput.value).toBeNull();
    expect(s.recoveryInput.value).toBeNull();
  });

  it("不属于激活需求的请求不参与落位——多需求并发时不会串台", () => {
    const s = setup({ activeExplorerPlanId: "requirement-2" });
    s.setInputRequests([request("r-1"), request("r-2", { explorerPlanId: "requirement-1" })]);

    expect(s.pendingInput.value).toBeNull();
    expect(s.recoveryInput.value).toBeNull();
  });

  it("没有激活需求时（activePlanId 为空）不过滤——与 belongsToExplorerPlan 的既有语义一致", () => {
    const s = setup({ activeExplorerPlanId: null });
    s.setInputRequests([request("r-1"), request("r-2", { explorerPlanId: "requirement-9" })]);

    expect(s.pendingInput.value?.id).toBe("r-1");
  });

  it("inputCardRequest 的优先级是 pendingInput → 属于激活需求的 SUBMITTING → recoveryInput", () => {
    const s = setup();
    const recovery = request("r-recovery", { status: "RECOVERY_REQUIRED" });
    s.setInputRequests([recovery]);
    expect(s.inputCardRequest.value?.id).toBe("r-recovery");

    s.setInputRequests([request("r-submitting", { status: "SUBMITTING" }), recovery]);
    expect(s.inputCardRequest.value?.id).toBe("r-submitting");

    s.setInputRequests([request("r-open"), request("r-submitting", { status: "SUBMITTING" }), recovery]);
    expect(s.inputCardRequest.value?.id).toBe("r-open");
  });
});

describe("SSE 输入请求接缝", () => {
  it("按 payload requestId 落位，而不是把列表第一个 OPEN 当成答案目标", () => {
    const s = setup();
    const first = request("r-first");
    const targeted = request("r-targeted");

    s.adoptInputRequest("r-targeted", [first, targeted]);

    expect(s.pendingInput.value?.id).toBe("r-targeted");
    expect(s.inputDialogOpen.value).toBe(true);
  });

  it("普通刷新传 null 时沿用列表落位，并在没有 pending 时关闭对话框", () => {
    const s = setup();
    s.inputDialogOpen.value = true;
    s.adoptInputRequest(null, [request("r-done", { status: "ANSWERED" })]);

    expect(s.pendingInput.value).toBeNull();
    expect(s.inputDialogOpen.value).toBe(false);
  });
});

describe("草稿的载入与清理", () => {
  it("SUBMITTING 的请求会把已存的草稿载入 inputProgress", () => {
    const s = setup();
    const submitting = request("r-1", { status: "SUBMITTING" });
    seedDraft(submitting, { "q-r-1": ["A"] });

    s.setInputRequests([submitting]);

    expect(s.inputProgress.value).toEqual({ requestId: "r-1", currentIndex: 0, values: { "q-r-1": ["A"] }, otherValues: {} });
  });

  it("已终态（ANSWERED / CANCELLED）的请求会清掉自己的草稿，未终态的留着", () => {
    const s = setup();
    const answered = request("r-answered", { status: "ANSWERED" });
    const cancelled = request("r-cancelled", { status: "CANCELLED" });
    const stillOpen = request("r-open");
    for (const item of [answered, cancelled, stillOpen]) seedDraft(item);

    s.setInputRequests([answered, cancelled, stillOpen]);

    expect(hasDraft(answered)).toBe(false);
    expect(hasDraft(cancelled)).toBe(false);
    // 清理只针对终态；仍然 OPEN 的那张草稿必须留着。
    expect(hasDraft(stillOpen)).toBe(true);
  });

  it("缺 thread 或缺激活需求时既不被载入也不被清理（scope 为 null 的两个分支）", () => {
    const noPlan = setup({ activeExplorerPlanId: null });
    const submitting = request("r-1", { status: "SUBMITTING" });
    seedDraft(submitting);
    noPlan.setInputRequests([submitting]);
    expect(noPlan.inputProgress.value).toBeNull();
    expect(hasDraft(submitting)).toBe(true);

    const noThread = setup({ threadId: null });
    noThread.setInputRequests([submitting]);
    expect(noThread.inputProgress.value).toBeNull();
    expect(hasDraft(submitting)).toBe(true);
  });

  it("内存里已有的同一张请求的进度优先于 storage——不会被回读覆盖回旧值", () => {
    const s = setup();
    const open = request("r-1");
    seedDraft(open, { "q-r-1": ["旧值"] });
    s.setInputRequests([open]);
    s.updateInputProgress({ requestId: "r-1", currentIndex: 1, values: { "q-r-1": ["新值"] }, otherValues: {} });
    // 把 storage 退回旧值，制造"内存与 storage 分歧"——否则这条用例区分不了两条来源。
    seedDraft(open, { "q-r-1": ["旧值"] });

    s.setInputRequests([open]);

    expect(s.inputProgress.value?.values["q-r-1"]).toEqual(["新值"]);
  });
});

describe("updateInputProgress", () => {
  it("requestId 与 pendingInput 不符时整个忽略——这是防串台的那道门", () => {
    const s = setup();
    const open = request("r-1");
    s.setInputRequests([open]);
    const before = s.inputProgress.value;

    s.updateInputProgress({ requestId: "r-别的", currentIndex: 0, values: {}, otherValues: {} });

    expect(s.inputProgress.value).toBe(before);
    expect(hasDraft(open)).toBe(false);
  });

  it("相符时更新内存并落盘", () => {
    const s = setup();
    const open = request("r-1");
    s.setInputRequests([open]);

    s.updateInputProgress({ requestId: "r-1", currentIndex: 0, values: { "q-r-1": ["A"] }, otherValues: {} });

    expect(s.inputProgress.value?.values["q-r-1"]).toEqual(["A"]);
    expect(hasDraft(open)).toBe(true);
  });

  it("待答请求不在当前列表里时只更新内存、不落盘", () => {
    // 这个形态正是 composable 头里写明的**过渡态接缝**：SSE 处理器会直接给
    // `pendingInput` 赋值（按 payload 指定 requestId 落位），此时它可能还没进
    // `inputRequests`。落盘要连请求一起存（草稿按题目投影），所以只能跳过。
    const s = setup();
    const open = request("r-1");
    s.pendingInput.value = open;

    s.updateInputProgress({ requestId: "r-1", currentIndex: 0, values: { "q-r-1": ["A"] }, otherValues: {} });

    expect(s.inputProgress.value?.values["q-r-1"]).toEqual(["A"]);
    expect(hasDraft(open)).toBe(false);
  });
});

describe("submitInput", () => {
  it("没有待答请求 / 没有线程 / 没有激活需求时不发请求", async () => {
    const s = setup();
    await s.submitInput({ "q-r-1": { answers: ["A"] } });
    expect(api.answerInput).not.toHaveBeenCalled();

    const noThread = setup({ threadId: null });
    noThread.setInputRequests([request("r-1")]);
    await noThread.submitInput({ "q-r-1": { answers: ["A"] } });
    expect(api.answerInput).not.toHaveBeenCalled();

    const noPlan = setup({ activeExplorerPlanId: null });
    noPlan.setInputRequests([request("r-1")]);
    await noPlan.submitInput({ "q-r-1": { answers: ["A"] } });
    expect(api.answerInput).not.toHaveBeenCalled();
  });

  it("成功路径：立刻回调 onSubmitted，返回后落位、清草稿、复位在途标记", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    const open = request("r-1");
    s.setInputRequests([open]);
    s.updateInputProgress({ requestId: "r-1", currentIndex: 0, values: { "q-r-1": ["A"] }, otherValues: {} });
    const pending = deferred<Awaited<ReturnType<typeof api.answerInput>>>();
    vi.mocked(api.answerInput).mockReturnValue(pending.promise);

    const submission = s.submitInput({ "q-r-1": { answers: ["A"] } });

    // 请求还没回来：对话框已经关了，在途标记已经立起来。
    expect(dialog.submitted()).toBe(1);
    expect(s.inputAnswerInFlight.value).toBe("r-1");
    expect(api.answerInput).toHaveBeenCalledWith("project-1", "r-1", { "q-r-1": { answers: ["A"] } }, "answer-r-1");

    pending.resolve({ request: request("r-1", { status: "ANSWERED" }), turn: turnStub });
    await submission;

    expect(s.inputAnswerInFlight.value).toBeNull();
    expect(s.inputRequests.value[0]?.status).toBe("ANSWERED");
    // 已答的请求不再是 OPEN，落位自然清空；草稿也随之作废。
    expect(s.pendingInput.value).toBeNull();
    expect(s.inputProgress.value).toBeNull();
    expect(hasDraft(open)).toBe(false);
    expect(ElMessage.success).toHaveBeenCalledWith("选择已提交，Plan Explorer 将继续当前回合");
  });

  it("同一张请求在途时重复提交被吞掉", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    s.setInputRequests([request("r-1")]);
    const pending = deferred<Awaited<ReturnType<typeof api.answerInput>>>();
    vi.mocked(api.answerInput).mockReturnValue(pending.promise);

    const first = s.submitInput({ "q-r-1": { answers: ["A"] } });
    await s.submitInput({ "q-r-1": { answers: ["A"] } });

    expect(api.answerInput).toHaveBeenCalledTimes(1);
    pending.resolve({ request: request("r-1", { status: "ANSWERED" }), turn: turnStub });
    await first;
  });

  it("响应回来时线程或需求已切换 → 整个返回结果丢弃，不写任何状态", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    s.setInputRequests([request("r-1")]);
    const pending = deferred<Awaited<ReturnType<typeof api.answerInput>>>();
    vi.mocked(api.answerInput).mockReturnValue(pending.promise);

    const submission = s.submitInput({ "q-r-1": { answers: ["A"] } });
    s.thread.value = { id: "explorer-2" } as unknown as ExplorerThread;
    pending.resolve({ request: request("r-1", { status: "ANSWERED" }), turn: turnStub });
    await submission;

    expect(s.inputRequests.value[0]?.status).toBe("OPEN");
    expect(ElMessage.success).not.toHaveBeenCalled();
    expect(s.inputAnswerInFlight.value).toBeNull();
  });

  it("失败且服务端仍报这张请求待答：保留对话框与草稿并提示已保留", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    const open = request("r-1");
    s.setInputRequests([open]);
    s.updateInputProgress({ requestId: "r-1", currentIndex: 0, values: { "q-r-1": ["A"] }, otherValues: {} });
    vi.mocked(api.answerInput).mockRejectedValue(new Error("网络中断"));
    vi.mocked(api.inputRequests).mockResolvedValue({ items: [open] });

    await s.submitInput({ "q-r-1": { answers: ["A"] } });

    expect(api.inputRequests).toHaveBeenCalledWith("project-1", "explorer-1", "requirement-1");
    expect(dialog.failed()).toEqual(["网络中断"]);
    expect(s.inputDialogOpen.value).toBe(true);
    expect(s.inputProgress.value?.values["q-r-1"]).toEqual(["A"]);
    expect(hasDraft(open)).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith("网络中断，已保留本次选择");
    expect(s.inputAnswerInFlight.value).toBeNull();
  });

  it("失败且服务端已把这张请求变成终态：不再喊用户重试，改为提示勿重复提交", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    s.setInputRequests([request("r-1")]);
    vi.mocked(api.answerInput).mockRejectedValue(new Error("提交超时"));
    vi.mocked(api.inputRequests).mockResolvedValue({ items: [request("r-1", { status: "ANSWERED" })] });

    await s.submitInput({ "q-r-1": { answers: ["A"] } });

    expect(dialog.failed()).toEqual([]);
    expect(ElMessage.error).not.toHaveBeenCalled();
    expect(ElMessage.warning).toHaveBeenCalledWith("提交状态尚未确认；页面会继续显示已保存的选择，请勿重复提交");
  });

  it("失败且连回查都失败：按「什么都没确认」处理，保留本地草稿并提示已保留", async () => {
    const s = setup();
    const dialog = dialogStub();
    s.inputDialog.value = dialog.handle;
    s.setInputRequests([request("r-1")]);
    vi.mocked(api.answerInput).mockRejectedValue(new Error("提交失败"));
    vi.mocked(api.inputRequests).mockRejectedValue(new Error("回查也失败"));

    await s.submitInput({ "q-r-1": { answers: ["A"] } });

    expect(dialog.failed()).toEqual(["提交失败"]);
    expect(s.pendingInput.value?.id).toBe("r-1");
    expect(ElMessage.error).toHaveBeenCalledWith("提交失败，已保留本次选择");
  });
});

describe("cancelInput", () => {
  it("没有待答请求或没有线程时不动服务端", async () => {
    const s = setup();
    await s.cancelInput();
    expect(api.cancelExplorerTurn).not.toHaveBeenCalled();

    const noThread = setup({ threadId: null });
    noThread.setInputRequests([request("r-1")]);
    await noThread.cancelInput();
    expect(api.cancelExplorerTurn).not.toHaveBeenCalled();
  });

  it("成功时按本地 turn 取消并清空状态", async () => {
    const s = setup();
    const open = request("r-1");
    s.setInputRequests([open]);
    s.inputDialogOpen.value = true;
    vi.mocked(api.cancelExplorerTurn).mockResolvedValue({ turn: turnStub });

    await s.cancelInput();

    expect(api.cancelExplorerTurn).toHaveBeenCalledWith("project-1", "explorer-1", "turn-r-1", "user_cancelled");
    expect(s.inputDialogOpen.value).toBe(false);
    expect(s.pendingInput.value).toBeNull();
    expect(s.inputProgress.value).toBeNull();
    expect(ElMessage.info).toHaveBeenCalledWith("本轮已取消");
  });

  it("失败时状态保持原样并报错", async () => {
    const s = setup();
    s.setInputRequests([request("r-1")]);
    s.inputDialogOpen.value = true;
    vi.mocked(api.cancelExplorerTurn).mockRejectedValue(new Error("取消失败"));

    await s.cancelInput();

    expect(s.pendingInput.value?.id).toBe("r-1");
    expect(s.inputDialogOpen.value).toBe(true);
    expect(ElMessage.error).toHaveBeenCalledWith("取消失败");
  });
});

describe("resetInputState 与三个 label wrapper", () => {
  it("resetInputState 清空全部六个字段", () => {
    const s = setup();
    s.setInputRequests([request("r-1"), request("r-2", { status: "RECOVERY_REQUIRED" })]);
    s.inputProgress.value = { requestId: "r-1", currentIndex: 0, values: {}, otherValues: {} };
    s.inputDialogOpen.value = true;
    s.inputAnswerInFlight.value = "r-1";

    s.resetInputState();

    expect(s.inputRequests.value).toEqual([]);
    expect(s.pendingInput.value).toBeNull();
    expect(s.recoveryInput.value).toBeNull();
    expect(s.inputProgress.value).toBeNull();
    expect(s.inputDialogOpen.value).toBe(false);
    expect(s.inputAnswerInFlight.value).toBeNull();
  });
});
