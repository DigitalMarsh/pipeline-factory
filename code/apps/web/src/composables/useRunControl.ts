/**
 * 模块职责：Run Control 的**动作接线**——暂停 / 恢复 / 终止 / 验证 / 创建 Merge request / 确认合并，
 * 以及它们的忙碌标志、终止确认框的状态、确认框里两个 commit 输入。
 *
 * 为什么单独抽出来：这一簇原先住在 `RunDetailView.vue` 里，与加载、SSE、会话分组、输入框混在一个
 * 1133 行的文件中——而它自己有完整的"忙时不许重入 + 失败往哪写 + 成功后重载"三段式，每加一个动作都在
 * 同一个文件里再抄一遍。视图现在只负责**摆按钮与接线**（`@run-action` / `@create-review` / …）。
 *
 * 维护提示：
 * 1. **确认与执行分家**：`terminateRun` 只开确认框，真正的终止在 `confirmTerminateRun`。
 *    终止失败留在**框里**（`terminateError`），不浮到页面级提示——用户正对着这个框，
 *    关掉它才看得到页面。
 * 2. **动作的取值只有一处**（`RunControlAction` / `LoopControlAction`，utils/runControls.ts）：
 *    状态卡发什么、这里就处理什么，两处各写一份字面量联合时漏改一处是静默的。
 * 3. **路由不下沉到本文件**：终止成功后视图该"关抽屉"还是"回方案列表"，由视图通过 `onTerminated`
 *    决定（内嵌与独立页两种形态的差别是路由形状，不是控制逻辑）。
 * 4. 每个动作成功后都 `reload()`：Run 的状态、线程、验证与合并请求都可能被这一个动作改掉，
 *    只回填自己那一格会留下半旧的数据。
 */
import { ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { AgentLoop, ExecutionThread, MergeRequest, Run, VerificationRun } from "../types";
import { canTerminateRun, type LoopControlAction, type RunControlAction } from "../utils/runControls";

export type RunControlDeps = {
  run: Ref<Run | null>;
  thread: Ref<ExecutionThread | null>;
  /** **最新**那一条执行 Loop（不是第一条）——补充要求会为同一个 Run 起新一轮。 */
  executorLoop: Ref<AgentLoop | null>;
  verification: Ref<VerificationRun | null>;
  mergeRequest: Ref<MergeRequest | null>;
  /** 用服务端返回的线程替换当前线程（同时推进 SSE 游标，见视图的 `setExecutionThread`）。 */
  setThread: (thread: ExecutionThread | null) => void;
  /** 重新拉一遍 Run / 线程 / 验证 / 合并请求。 */
  reload: () => Promise<void>;
  /** 失败往哪写（视图的页面级错误条）。 */
  onError: (caught: unknown) => void;
  /** 终止成功之后；视图决定是关抽屉还是回列表。 */
  onTerminated: () => void | Promise<void>;
};

export function useRunControl(deps: RunControlDeps) {
  const actionBusy = ref(false);
  /** 「终止 Run」的确认框：开没开 + 它自己的错误（见维护提示 1）。 */
  const terminateOpen = ref(false);
  const terminateError = ref<string | null>(null);
  const sourceCommit = ref("");
  const targetCommit = ref("");

  async function controlExecutorLoop(action: LoopControlAction) {
    if (!deps.executorLoop.value || actionBusy.value) return;
    actionBusy.value = true;
    try {
      if (action === "pause") await api.pauseAgentLoop(deps.executorLoop.value.id, "user_requested");
      if (action === "resume") await api.resumeAgentLoop(deps.executorLoop.value.id);
      if (action === "cancel") await api.cancelAgentLoop(deps.executorLoop.value.id, "user_requested");
      await deps.reload();
    } catch (caught) {
      deps.onError(caught);
    } finally {
      actionBusy.value = false;
    }
  }

  async function togglePause() {
    if (!deps.run.value || actionBusy.value) return;
    actionBusy.value = true;
    try {
      const response =
        deps.thread.value?.state === "PAUSED" ? await api.resumeRun(deps.run.value.id) : await api.pauseRun(deps.run.value.id);
      deps.run.value = response.run;
      deps.setThread(response.thread);
    } catch (caught) {
      deps.onError(caught);
    } finally {
      actionBusy.value = false;
    }
  }

  /**
   * 终止前要求二次确认。服务端会同步取消关联 AgentLoop 并执行 cleanup。
   *
   * 确认框的文案原来是英文（"Terminate this run? …"），而这个页面上别处都是中文——顺手统一了。
   */
  function terminateRun(): void {
    if (!deps.run.value || actionBusy.value || !canTerminateRun(deps.run.value.status)) return;
    terminateError.value = null;
    terminateOpen.value = true;
  }

  /** 确认框里按下「终止」之后才走这里——**对话框只负责问，终止是这一步的事**。 */
  async function confirmTerminateRun(): Promise<void> {
    const target = deps.run.value;
    if (!target || actionBusy.value) return;
    actionBusy.value = true;
    terminateError.value = null;
    try {
      await api.cancelRun(target.id, "user_requested");
      terminateOpen.value = false;
      ElMessage.success("Run 已终止");
      await deps.onTerminated();
    } catch (caught) {
      // 失败留在框里而不是浮到页面上（见维护提示 1）。
      terminateError.value = caught instanceof Error ? `终止失败：${caught.message}` : "终止失败";
    } finally {
      actionBusy.value = false;
    }
  }

  /** 触发脱离模型会话的确定性验证，结果落入 VerificationRun 后再更新页面。 */
  async function verifyRun() {
    if (!deps.run.value || actionBusy.value) return;
    actionBusy.value = true;
    try {
      deps.verification.value = (await api.verifyRun(deps.run.value.id)).verification;
      await deps.reload();
      ElMessage.success("验证完成");
    } catch (caught) {
      deps.onError(caught);
    } finally {
      actionBusy.value = false;
    }
  }

  async function createReview() {
    if (!deps.run.value || !sourceCommit.value.trim() || actionBusy.value) return;
    actionBusy.value = true;
    try {
      deps.mergeRequest.value = (await api.createMergeRequest(deps.run.value.id, sourceCommit.value.trim())).mergeRequest;
      await deps.reload();
    } catch (caught) {
      deps.onError(caught);
    } finally {
      actionBusy.value = false;
    }
  }

  async function confirmMerged() {
    if (!deps.mergeRequest.value || !targetCommit.value.trim() || actionBusy.value) return;
    actionBusy.value = true;
    try {
      deps.mergeRequest.value = (await api.confirmMerged(deps.mergeRequest.value.id, targetCommit.value.trim())).mergeRequest;
      await deps.reload();
      ElMessage.success("已确认合并到目标 Commit");
    } catch (caught) {
      deps.onError(caught);
    } finally {
      actionBusy.value = false;
    }
  }

  async function handleRunAction(action: RunControlAction): Promise<void> {
    // 终止现在只是"开确认框"，不再是"问完顺手做掉"——真正的终止在 confirmTerminateRun 里。
    if (action === "terminate") terminateRun();
    if (action === "pause" || action === "resume") await togglePause();
    if (action === "verify") await verifyRun();
  }

  async function handleLoopAction(action: LoopControlAction): Promise<void> {
    await controlExecutorLoop(action);
  }

  function updateSourceCommit(value: string): void {
    sourceCommit.value = value;
  }

  function updateTargetCommit(value: string): void {
    targetCommit.value = value;
  }

  return {
    actionBusy,
    terminateOpen,
    terminateError,
    sourceCommit,
    targetCommit,
    // 只导出视图真正用到的（`run-action` / `loop-action` 两个入口 + 确认框 + 两个 commit 输入）：
    // 细分的 pause / resume / verify / terminate 由 `handleRunAction` 内部转，
    // 再导出一次就是"声明了没有调用方"的那种空转。
    handleRunAction,
    handleLoopAction,
    createReview,
    confirmMerged,
    confirmTerminateRun,
    updateSourceCommit,
    updateTargetCommit,
  };
}
