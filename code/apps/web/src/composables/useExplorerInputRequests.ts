/**
 * 模块职责：Plan Explorer 的**结构化输入请求**（模型反问、答案提交、草稿进度）。
 *
 * 这一整块是自洽的：`belongsToActivePlan` 与 `inputProgressScope` 全仓只被本文件的
 * 函数使用（已 `grep` 复核），所以它连同"属于激活需求"这个判据一起搬了进来，
 * 而不是把一个谓词留在视图里跨文件调用。
 *
 * 维护提示：
 * 1. **`inputDialog` 是模板 ref，必须留在视图。** `ref="inputDialog"` 要求它是
 *    `<script setup>` 的顶层绑定，所以以入参形式传进来——与 `useTimelineScroll`
 *    收 `timeline` ref 是同一条约定。
 * 2. **`pendingInput` / `recoveryInput` / `inputDialogOpen` / `setInputRequests`
 *    目前仍被视图的 SSE 处理器直接读写**（`turn.input_required` 事件要按 payload
 *    指定 requestId 落位，`setInputRequests` 的"取第一个 OPEN"规则不适用）。
 *    这是**过渡态形状**，不是要保留的设计：等 `useExplorerSse` 抽出时，
 *    这几个写入点应该收成一个具名方法（如 `adoptRequest(requestId, items)`），
 *    而不是继续暴露裸 ref。**在收成方法之前不要新增对它们的外部写入点。**
 * 3. **`activeExplorerPlanId` 收的是"已解析"的需求 id**，不是视图里那个原始
 *    `activeExplorerPlanId` ref。视图解析时会依次回退到
 *    `thread.activeExplorerPlanId` 与 `explorerPlans[0].id`，两条链路必须保持一致，
 *    否则会出现"输入请求属于 A、时间线过滤到 B"的错位。
 * 4. 提交失败时**保留对话框状态与本地草稿、不重复提交**（`inputAnswerInFlight` 兜住
 *    并发），这层语义在 `submitInput` 的 catch 分支里，不要简化成"失败就清空"。
 */
import { computed, ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { ExplorerInputRequest, ExplorerThread } from "../types";
import { belongsToExplorerPlan } from "../utils/explorerScope";
import { inputStatusLabel as inputStatusText } from "../utils/explorerPresentation";
import { inputAnswerDisplayLabels, inputAnswerDisplayText } from "../utils/explorerInput";
import { clearExplorerInputProgressDraft, loadExplorerInputProgressDraft, saveExplorerInputProgressDraft } from "../utils/explorerInputProgressDraft";
import type { ExplorerInputProgress, ExplorerInputProgressScope } from "../utils/explorerInputProgressDraft";

/** `ExplorerInputDialog` 暴露给父组件的两个回调；模板 ref 的类型写在这里以免视图与 composable 各写一份。 */
export type ExplorerInputDialogHandle = { onSubmitted: () => void; onFailed: (message: string) => void };

export type ExplorerInputRequestDeps = {
  projectId: Ref<string>;
  thread: Ref<ExplorerThread | null>;
  /** **已解析**的激活需求 id（见维护提示 3）。 */
  activeExplorerPlanId: Ref<string | null>;
  /** 模板 ref，留在视图（见维护提示 1）。 */
  inputDialog: Ref<ExplorerInputDialogHandle | null>;
};

export function useExplorerInputRequests(deps: ExplorerInputRequestDeps) {
  const pendingInput = ref<ExplorerInputRequest | null>(null);
  const recoveryInput = ref<ExplorerInputRequest | null>(null);
  const inputRequests = ref<ExplorerInputRequest[]>([]);
  const inputProgress = ref<ExplorerInputProgress | null>(null);
  const inputDialogOpen = ref(false);
  const inputAnswerInFlight = ref<string | null>(null);

  const inputCardRequest = computed(() => pendingInput.value ?? inputRequests.value.find((item) => belongsToActivePlan(item.explorerPlanId) && item.status === "SUBMITTING") ?? recoveryInput.value);

  function belongsToActivePlan(planId: string | null | undefined): boolean {
    return belongsToExplorerPlan(planId, deps.activeExplorerPlanId.value);
  }

  function inputProgressScope(): ExplorerInputProgressScope | null {
    const currentThread = deps.thread.value;
    const explorerPlanId = deps.activeExplorerPlanId.value;
    if (!currentThread || !explorerPlanId) return null;
    return { projectId: deps.projectId.value, threadId: currentThread.id, explorerPlanId };
  }

  function setInputRequests(items: ExplorerInputRequest[]) {
    const activeRequests = items.filter((item) => belongsToActivePlan(item.explorerPlanId));
    const nextPending = activeRequests.find((item) => item.status === "OPEN") ?? null;
    const nextRecovery = activeRequests.find((item) => item.status === "RECOVERY_REQUIRED") ?? null;
    const draftRequest = nextPending ?? activeRequests.find((item) => item.status === "SUBMITTING") ?? nextRecovery;
    const existingProgress = draftRequest && inputProgress.value?.requestId === draftRequest.id ? inputProgress.value : null;
    const scope = inputProgressScope();
    inputRequests.value = items;
    pendingInput.value = nextPending;
    recoveryInput.value = nextRecovery;
    inputProgress.value = draftRequest && scope ? existingProgress ?? loadExplorerInputProgressDraft(scope, draftRequest) : null;
    if (scope) {
      for (const request of activeRequests) {
        if (request.status === "ANSWERED" || request.status === "CANCELLED") {
          clearExplorerInputProgressDraft(scope, request.id);
        }
      }
    }
  }

  /**
   * SSE 的 `turn.input_required` 需要按事件 payload 指定的 requestId 落位，不能只取列表里的
   * 第一个 OPEN；普通刷新则传 null，沿用 `setInputRequests` 的自然落位。把这条过渡态接缝
   * 收成具名方法，避免 SSE 直接写 pending / recovery / dialog 三份内部状态。
   */
  function adoptInputRequest(requestId: string | null, items: ExplorerInputRequest[]): void {
    setInputRequests(items);
    if (requestId !== null) {
      pendingInput.value = items.find((item) => item.id === requestId) ?? null;
      recoveryInput.value = null;
      inputDialogOpen.value = Boolean(pendingInput.value?.isBlocking);
    }
    if (!pendingInput.value) inputDialogOpen.value = false;
  }

  /** 线程级复位；跨 composable 的总复位由视图的 `resetThreadState` 负责。 */
  function resetInputState(): void {
    inputRequests.value = [];
    pendingInput.value = null;
    recoveryInput.value = null;
    inputProgress.value = null;
    inputDialogOpen.value = false;
    inputAnswerInFlight.value = null;
  }

  /** 下面三个 wrapper 只负责把本地状态（草稿进度、在途标记）喂给 utils 里的纯函数。 */
  function inputAnswerLabelsFor(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string[] {
    return inputAnswerDisplayLabels(request, question, inputProgress.value);
  }

  function inputAnswerText(request: ExplorerInputRequest, question: ExplorerInputRequest["questions"][number]): string {
    return inputAnswerDisplayText(request, question, inputProgress.value, inputAnswerInFlight.value);
  }

  function inputStatusLabel(request: ExplorerInputRequest): string {
    return inputStatusText(request, inputAnswerInFlight.value);
  }

  async function openInputRequest() {
    if (!pendingInput.value) return;
    inputDialogOpen.value = true;
  }

  function updateInputProgress(progress: ExplorerInputProgress) {
    if (pendingInput.value?.id !== progress.requestId) return;
    inputProgress.value = progress;
    const scope = inputProgressScope();
    const request = inputRequests.value.find((item) => item.id === progress.requestId);
    if (scope && request) saveExplorerInputProgressDraft(scope, request, progress);
  }

  /** 提交结构化选择；失败时保留对话框状态，允许用户修正或重试而不丢答案。 */
  async function submitInput(answers: Record<string, { answers: string[] }>) {
    const request = pendingInput.value;
    const currentThread = deps.thread.value;
    const explorerPlanId = deps.activeExplorerPlanId.value;
    if (!request || !currentThread || !explorerPlanId || inputAnswerInFlight.value === request.id) return;
    const requestProjectId = deps.projectId.value;
    inputAnswerInFlight.value = request.id;
    const submission = api.answerInput(requestProjectId, request.id, answers, `answer-${request.id}`);
    // The API waits for the Provider to acknowledge the answer. Close the modal
    // immediately and show its saved draft/status in the timeline while that runs.
    deps.inputDialog.value?.onSubmitted();
    try {
      const response = await submission;
      if (deps.thread.value?.id !== currentThread.id || deps.activeExplorerPlanId.value !== explorerPlanId) return;
      setInputRequests([...inputRequests.value.filter((item) => item.id !== response.request.id), response.request]);
      inputProgress.value = null;
      ElMessage.success("选择已提交，Plan Explorer 将继续当前回合");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "提交选择失败，请重试";
      if (deps.thread.value?.id !== currentThread.id || deps.activeExplorerPlanId.value !== explorerPlanId) return;
      try {
        const current = await api.inputRequests(requestProjectId, currentThread.id, explorerPlanId);
        setInputRequests(current.items);
      } catch {
        // Keep the local draft and avoid inviting a duplicate submission when
        // the server cannot confirm whether it accepted the first request.
      }
      if (pendingInput.value?.id === request.id) {
        deps.inputDialog.value?.onFailed(message);
        inputDialogOpen.value = true;
        ElMessage.error(`${message}，已保留本次选择`);
      } else {
        ElMessage.warning("提交状态尚未确认；页面会继续显示已保存的选择，请勿重复提交");
      }
    } finally {
      if (inputAnswerInFlight.value === request.id) inputAnswerInFlight.value = null;
    }
  }

  async function cancelInput() {
    if (!pendingInput.value || !deps.thread.value) return;
    try {
      await api.cancelExplorerTurn(deps.projectId.value, deps.thread.value.id, pendingInput.value.localTurnId, "user_cancelled");
      inputDialogOpen.value = false;
      pendingInput.value = null;
      inputProgress.value = null;
      ElMessage.info("本轮已取消");
    } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "取消本轮失败"); }
  }

  return {
    pendingInput,
    recoveryInput,
    inputRequests,
    inputProgress,
    inputDialogOpen,
    inputAnswerInFlight,
    inputCardRequest,
    setInputRequests,
    adoptInputRequest,
    resetInputState,
    inputAnswerLabelsFor,
    inputAnswerText,
    inputStatusLabel,
    openInputRequest,
    updateInputProgress,
    submitInput,
    cancelInput,
  };
}
