/**
 * 模块职责：执行会话的**补充要求输入框**——草稿、发送中标志、投递方式（排队 / 引导）、
 * 可用性与"为什么不可用"的文案，以及发送本身。
 *
 * 为什么单独抽出来：这几格看起来只是几条 ref，实际牵着一条**踩过坑的判据**（见维护提示 1）与
 * 一段带分支的提示文案，原先混在 `RunDetailView.vue` 的 ref 声明区与函数区两处。分法与探索侧一致
 * （探索侧的输入框在 `composables/useExplorerInputRequests.ts`）。
 *
 * 维护提示：
 * 1. **"能不能发"判的是 Run 的状态，不是线程的状态。** 执行一收尾线程就被置成 `COMPLETED`，
 *    于是按线程判会**恰好在最需要它的那一刻**禁用：执行完了、还没合并、想再让 Agent 补一轮
 *    （报障现场）。判据在 utils/runControls.ts 的 `canContinueRun`，与领域侧同源。
 * 2. **投递方式只在一轮还在跑时才有得选**：没在跑时"排队"与"引导"等价，不由用户选，
 *    交给服务端按实际状态定（`auto`）。所以模板在没跑时显示的是「Run 模式」那一行。
 * 3. 发送成功要**说清它到底发生了什么**：排队的要求还没到模型手里，和"已发送"不是一回事。
 */
import { computed, ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { ExecutionThread, Run } from "../types";
import { shouldSubmitComposer } from "../utils/composerKeyboard";
import { canContinueRun } from "../utils/runControls";

export type RunComposerDeps = {
  run: Ref<Run | null>;
  /** 别处的动作正在跑时，输入框一起禁用（同一个 Run 上的操作要互斥）。 */
  actionBusy: Ref<boolean>;
  setThread: (thread: ExecutionThread | null) => void;
  onError: (caught: unknown) => void;
};

export function useRunComposer(deps: RunComposerDeps) {
  const executionDraft = ref("");
  const sendingExecutionMessage = ref(false);
  /** 一轮还在跑时的投递方式；没在跑时它不参与，服务端按 `auto` 自己定。 */
  const executionGuidanceMode = ref<"steer" | "queue">("queue");

  const canSendExecutionMessage = computed(() => canContinueRun(deps.run.value?.status ?? ""));
  /** 还有一轮在跑吗——决定补充要求是"交给这一轮"还是"起新的一轮"。 */
  const executorLoopRunning = computed(() =>
    (deps.run.value?.agentLoops ?? []).some(
      (loop) => loop.role === "executor" && ["CREATED", "RUNNING", "WAITING_FOR_INPUT", "PAUSED"].includes(loop.state),
    ),
  );
  /** 输入框为什么不可用——空串表示可用。把框灰掉而不说原因，用户只会以为它坏了。 */
  const executionComposerDisabledReason = computed(() => {
    if (canSendExecutionMessage.value) return "";
    const status = deps.run.value?.status ?? "";
    if (status === "BLOCKED" || status === "NEEDS_PLAN_CHANGE") return "这个 Run 卡在计划上，请改计划（创建更新版本）而不是补充要求";
    if (status === "CANCELLED" || status === "STALE") return "这个 Run 已经结束";
    return status ? `Run 处于 ${status}，不接受补充要求` : "";
  });

  async function sendExecutionMessage(): Promise<void> {
    const content = executionDraft.value.trim();
    if (!deps.run.value || !canSendExecutionMessage.value || !content || deps.actionBusy.value) return;
    deps.actionBusy.value = true;
    sendingExecutionMessage.value = true;
    try {
      // 一轮还在跑时由用户选"引导 / 排队"；没在跑时两种等价，交给服务端按实际状态自己定（`auto`）。
      const result = await api.addRunGuidance(deps.run.value.id, content, executorLoopRunning.value ? executionGuidanceMode.value : "auto");
      deps.setThread(result.thread);
      if (result.run) deps.run.value = { ...deps.run.value, ...result.run };
      executionDraft.value = "";
      // 说清它到底发生了什么（见维护提示 3）。
      ElMessage.success(
        result.continued
          ? "已发送，执行线程重新开工"
          : result.guidance.status === "CONSUMED"
            ? "已发送到执行线程"
            : "已排队，等这一轮结束后自动开工",
      );
    } catch (caught) {
      deps.onError(caught);
    } finally {
      deps.actionBusy.value = false;
      sendingExecutionMessage.value = false;
    }
  }

  function handleExecutionComposerKeydown(event: KeyboardEvent): void {
    if (!shouldSubmitComposer(event)) return;
    event.preventDefault();
    void sendExecutionMessage();
  }

  return {
    executionDraft,
    sendingExecutionMessage,
    executionGuidanceMode,
    canSendExecutionMessage,
    executorLoopRunning,
    executionComposerDisabledReason,
    sendExecutionMessage,
    handleExecutionComposerKeydown,
  };
}
