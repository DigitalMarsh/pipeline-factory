/**
 * 模块职责：Plan Explorer 的**生命周期写操作**——确认、入队、启动 Run、丢弃、
 * 基于当前配置创建新 Revision，以及 Plan Center 的配置修订回调。
 *
 * 维护提示：
 * 1. 这些动作共用视图的 `busy` / `error` / drawer 状态与 `refreshPlanProjection`；
 *    它们一起搬是为了让每个写操作都保留同一套"写入 → 刷新投影 → 更新抽屉"语义，
 *    不要把其中一个动作重新塞回视图。
 * 2. `confirmPlan` 有两条不同协议：有 `revisionDraft` 时确认草稿，否则确认当前
 *    Candidate Plan；两条分支的提示文案、失败状态与刷新时机都必须分别保留。
 *    **确认哪一版由调用方传入的 Plan 决定**（缺省才是 `candidate`）：已确认 Plan 上挂着
 *    修订草稿时，工作区投影只把 DRAFT 的 Plan 当候选，`candidate` 就是 `null`——
 *    那时若还固定读 `candidate`，抽屉里的 "Confirm V2" 会静默失效。`discardPlan` 同此。
 * 3. `enqueuePlan` / `startPlanRun` 的 Revision 分支必须按 `revision > 1` 选择 API，
 *    普通 V1 则走无 revision 的旧端点；这是后端路由的真实契约，不要用一个端点硬合并。
 * 4. `isConversationArtifactPlan` 既有前置守卫，也有服务端失败码兜底：前者给用户即时反馈，
 *    后者覆盖服务端在状态竞争窗口内才发现产物不可执行的情况，两条都要留。
 * 5. `openRunView` / `selectedRequirementPlan` 以回调与 getter 注入，避免把路由、需求清单
 *    和 drawer 的组合根依赖带进 composable；动作本身只关心"打开哪个 Run"。
 */
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import type { ExplorerPlan, ExplorerThread, Plan, PlanRevisionDraft, Project, Run } from "../types";
import { isConversationArtifactPlan } from "../utils/explorerRequirementRows";
import { canCreateConfigurationRevision } from "../utils/runPrerequisites";
import { planIdentity } from "../utils/planTimeline";
import type { Ref } from "vue";

export type PlanLifecycleActionsDeps = {
  projectId: Ref<string>;
  project: Ref<Project | null>;
  thread: Ref<ExplorerThread | null>;
  activeExplorerPlan: Ref<ExplorerPlan | null>;
  selectedRequirementPlan: Ref<Plan | null>;
  candidate: Ref<Plan | null>;
  revisionDraft: Ref<PlanRevisionDraft | null>;
  detailPlan: Ref<Plan | null>;
  enqueued: Ref<Plan[]>;
  projectRuns: Ref<Run[]>;
  busy: Ref<boolean>;
  error: Ref<string | null>;
  drawerOpen: Ref<boolean>;
  drawerTab: Ref<"explorer" | "plan" | "task">;
  contextPanel: Ref<string>;
  refreshPlanProjection: () => Promise<void>;
  openRunView: (runId: string, explorerId?: string | null, explorerPlanId?: string | null) => Promise<void>;
};

export function usePlanLifecycleActions(deps: PlanLifecycleActionsDeps) {
  /**
   * 确认哪一版：抽屉传它当前显示的那份 Plan（V1 候选，或已确认 Plan 上的 V2 修订草稿），
   * 时间线内联卡片传卡片自己那份；都不传才回落到 `candidate`（见文件头维护提示 2）。
   */
  async function confirmPlan(plan: Plan | null = deps.candidate.value) {
    const id = plan?.id ?? plan?.planId;
    if (!plan || !id || deps.busy.value) return;
    const activeDraft = deps.revisionDraft.value;
    if (activeDraft && activeDraft.planId === id) {
      if (activeDraft.status !== "READY_TO_CONFIRM") {
        ElMessage.info(activeDraft.status === "BASE_CHANGED" ? "默认分支已变，确认前需要先给这份修订草稿 rebase。" : "继续探索，等这份修订草稿可以确认。");
        return;
      }
      deps.busy.value = true;
      try {
        const response = await api.confirmRevisionDraft(id, activeDraft.draftId);
        deps.drawerTab.value = "plan";
        deps.drawerOpen.value = true;
        await deps.refreshPlanProjection();
        deps.detailPlan.value = response.plan;
        ElMessage.success(`修订 V${activeDraft.targetRevision} 已确认 · ${response.confirmation?.stage ?? "FROZEN"}`);
      } catch (caught) {
        deps.error.value = caught instanceof Error ? `确认修订失败：${caught.message}` : "确认修订失败";
      } finally {
        deps.busy.value = false;
      }
      return;
    }
    deps.busy.value = true;
    try {
      const response = await api.confirmPlan(id, plan.revision);
      await deps.refreshPlanProjection();
      if (response.plan.status === "DRAFT") {
        const failure = response.dispatch?.lastError ?? "Plan 校验未通过";
        deps.error.value = `确认停在 ${response.confirmation.stage}：${failure}`;
        ElMessage.error(deps.error.value);
        return;
      }
      deps.drawerTab.value = "plan";
      deps.drawerOpen.value = true;
      deps.detailPlan.value = response.plan;
      const runText = response.run ? ` · Run ${response.run.id}` : "";
      const issueText = response.dispatch?.lastError ? ` · ${response.dispatch.lastError}` : "";
      ElMessage.success(`Plan 已确认 · ${response.confirmation.stage}${runText}${issueText}`);
    } catch (caught) {
      deps.error.value = caught instanceof Error ? `确认方案失败：${caught.message}` : "确认方案失败";
    } finally {
      deps.busy.value = false;
    }
  }

  async function enqueuePlan(plan: Plan | null = deps.candidate.value) {
    if (!plan || plan.status !== "READY" || deps.busy.value) return;
    if (isConversationArtifactPlan(plan)) {
      ElMessage.error("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
      return;
    }
    const id = plan.id ?? plan.planId;
    if (!id) return;
    deps.busy.value = true;
    try {
      const enqueuedPlan = (await (plan.revision > 1 ? api.enqueuePlanRevision(id, plan.revision) : api.enqueuePlan(id))).plan;
      deps.enqueued.value = [enqueuedPlan, ...deps.enqueued.value.filter((item) => planIdentity(item) !== planIdentity(enqueuedPlan))];
      deps.candidate.value = null;
      await deps.refreshPlanProjection();
      deps.drawerTab.value = "task";
      deps.drawerOpen.value = true;
      ElMessage.success("Plan 已入队");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      if (message === "CONVERSATION_ARTIFACT_NOT_EXECUTABLE") {
        ElMessage.error("此 Plan 是对话产物，不能入队执行。请在探索对话中修订为仓库文件产物并确认新版本。");
      } else {
        deps.error.value = message ? `入队方案失败：${message}` : "入队方案失败";
      }
    } finally {
      deps.busy.value = false;
    }
  }

  async function startPlanRun(plan: Plan): Promise<void> {
    const id = plan.id ?? plan.planId;
    if (!id || plan.status !== "ENQUEUED" || deps.busy.value) return;
    deps.busy.value = true;
    deps.error.value = null;
    try {
      const result = await (plan.revision > 1 ? api.startPlanRevisionRun(id, plan.revision) : api.startPlanRun(id));
      await deps.refreshPlanProjection();
      deps.drawerTab.value = "task";
      deps.drawerOpen.value = true;
      const runId = result.run?.id ?? deps.selectedRequirementPlan.value?.runId ?? deps.selectedRequirementPlan.value?.dispatch?.runId;
      if (result.run) deps.projectRuns.value = [result.run, ...deps.projectRuns.value.filter((run) => run.id !== result.run!.id)];
      if (runId) await deps.openRunView(runId, deps.thread.value?.id, deps.activeExplorerPlan.value?.id);
      ElMessage.success(result.dispatch?.waitReason ? `Plan 已派发，正在等待：${result.dispatch.waitReason}` : "Plan 已派发");
    } catch (caught) {
      deps.error.value = caught instanceof Error ? `启动 Run 失败：${caught.message}` : "启动 Run 失败";
      ElMessage.error(deps.error.value);
    } finally {
      deps.busy.value = false;
    }
  }

  async function revisePlanConfiguration(plan: Plan): Promise<void> {
    const id = plan.id ?? plan.planId;
    if (!id || plan.status !== "DISPATCHED" || plan.runId || plan.dispatch?.status !== "WAITING" || plan.dispatch.waitReason !== "NEEDS_CONFIGURATION" || !canCreateConfigurationRevision(plan, deps.project.value) || deps.busy.value) return;
    deps.busy.value = true;
    deps.error.value = null;
    try {
      await api.revisePlanConfiguration(id);
      await deps.refreshPlanProjection();
      deps.contextPanel.value = "confirmed";
      ElMessage.success("已基于当前配置创建新 Revision，请重新入队并启动 Run");
    } catch (caught) {
      deps.error.value = caught instanceof Error ? `创建新修订失败：${caught.message}` : "创建新修订失败";
      ElMessage.error(deps.error.value);
    } finally {
      deps.busy.value = false;
    }
  }

  function handlePlanCenterConfigurationRevised(): void {
    void deps.refreshPlanProjection();
    deps.contextPanel.value = "confirmed";
  }

  async function discardPlan(plan: Plan | null = deps.candidate.value) {
    if (!plan || plan.status !== "DRAFT" || deps.busy.value) return;
    const id = plan.id ?? plan.planId;
    if (!id) return;
    const activeDraft = deps.revisionDraft.value;
    if (activeDraft && activeDraft.planId === id) {
      try {
        await ElMessageBox.confirm(`丢弃修订 V${activeDraft.targetRevision}？已确认的 V${activeDraft.basedOnRevision} 保持不变。`, "丢弃修订草稿", { confirmButtonText: "丢弃修订", cancelButtonText: "继续编辑", type: "warning" });
      } catch { return; }
      deps.busy.value = true;
      try {
        await api.discardRevisionDraft(id, activeDraft.draftId);
        deps.drawerOpen.value = false;
        await deps.refreshPlanProjection();
        ElMessage.success(`修订 V${activeDraft.targetRevision} 已丢弃`);
      } catch (caught) {
        deps.error.value = caught instanceof Error ? `丢弃修订失败：${caught.message}` : "丢弃修订失败";
      } finally {
        deps.busy.value = false;
      }
      return;
    }
    try {
      await ElMessageBox.confirm(`丢弃「${plan.title}」？这个方案会保留为已丢弃，且不能再确认、入队或启动。`, "丢弃方案", { confirmButtonText: "丢弃方案", cancelButtonText: "继续编辑", type: "warning" });
    } catch {
      return;
    }
    deps.busy.value = true;
    deps.error.value = null;
    try {
      await api.discardPlan(id);
      if ((deps.candidate.value?.id ?? deps.candidate.value?.planId) === id) deps.candidate.value = null;
      deps.drawerOpen.value = false;
      await deps.refreshPlanProjection();
      ElMessage.success("方案已丢弃");
    } catch (caught) {
      deps.error.value = caught instanceof Error ? `丢弃方案失败：${caught.message}` : "丢弃方案失败";
      ElMessage.error(deps.error.value);
    } finally {
      deps.busy.value = false;
    }
  }

  return { confirmPlan, enqueuePlan, startPlanRun, revisePlanConfiguration, handlePlanCenterConfigurationRevised, discardPlan };
}
