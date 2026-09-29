/**
 * 模块职责：共享右侧抽屉的"Plan 详情"状态——抽屉开关与页签、当前展示的 Plan 版本、可切换的版本
 *   列表，以及把某个 Plan 的完整详情（冻结版本 + 调度/合并元数据）取回来的加载流程。
 *
 * 为什么单独抽出来：这一簇原先散在 ExplorerView.vue 的 ref 声明区与函数区两处，中间隔着近 400 行
 *   别的逻辑，读"抽屉里到底显示什么"要来回跳。而它有**三条写入链路**，这才是真正危险的地方：
 *   本文件的 openPlanDetail / selectPlanRevision、composable usePlanLifecycleActions（确认或入队之后
 *   要刷新详情并切到 plan 页签）、以及线程/项目切换时的重置。
 *
 * 维护提示：
 *   1) `detailRequestVersion` 是**请求代际**，不是节流：重开详情、切线程、切项目都会把它 +1，
 *      于是此前发出的请求回来时会被 `isCurrentDetailRequest()` 判为过期而丢弃。少了它，
 *      慢的那个请求会覆盖新线程的详情——这是本文件里唯一会**串数据**的并发问题。
 *   2) `detailPlan` 会先落一个"已知的 Plan"再被接口结果补全，所以它在加载完成前也不是空的。
 *      不要为了"还没加载完"再加一个 loading 标志——那会让抽屉在切换时闪空。
 *   3) 路由跳转（把 requirementTab=plan 写进 query）**不在本文件**：路由形状由视图决定，
 *      这里只通过 `onOpened` 通知"打开了"。与 usePlanLifecycleActions 处理 openRunView 的方式一致。
 *   4) 本文件是 P7 第三级从 ExplorerView.vue 抽出的，逻辑逐字未改。唯一的修正：
 *      `resetThreadState` 里本来把同一组抽屉重置**写了两遍**（第二遍还漏了 `detailLoadError`），
 *      现在只有 `resetDetailState` 一处——这正是"两处要保持同步"该被消掉的理由。
 */
import { computed, ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { Plan, PlanRevisionDraft } from "../types";
import { isConfirmedPlanRevision, resolvePlanVersionHistory } from "../utils/planVersionHistory";

/** 抽屉页签。放在这里而不是视图里：`drawerTab` 这个 ref 由本文件拥有，类型跟着它走。 */
export type SharedDrawerTab = "explorer" | "plan" | "task";

export type PlanDetailDrawerDeps = {
  projectId: Ref<string>;
  /** 项目作用域令牌：项目切换后旧请求的结果必须丢弃，见维护提示 1。 */
  projectScopeToken: () => number;
  revisionDraft: Ref<PlanRevisionDraft | null>;
  planFromRevisionDraft: (draft: PlanRevisionDraft) => Plan;
  /** 打开详情后通知视图同步 URL；路由形状不下沉到本文件。 */
  onOpened: (plan: Plan) => void;
  /** 当前是否只读（例如正在查看历史版本）：只读时不允许改前置 Plan。 */
  isReadOnly?: (() => boolean) | undefined;
};

export function usePlanDetailDrawer(deps: PlanDetailDrawerDeps) {
  const drawerOpen = ref(false);
  const drawerTab = ref<SharedDrawerTab>("explorer");
  const detailPlan = ref<Plan | null>(null);
  const detailRevisions = ref<number[]>([]);
  const detailConfirmedRevisions = ref<number[]>([]);
  const detailLatestRevision = ref<number | null>(null);
  const detailVersionSource = ref<"candidate" | "confirmed" | null>(null);
  const detailLoadError = ref<string | null>(null);
  let detailRequestVersion = 0;

  /** 线程或项目切换时调用；同时作废所有在途的详情请求（维护提示 1）。 */
  function resetDetailState(): void {
    detailRequestVersion += 1;
    drawerOpen.value = false;
    drawerTab.value = "explorer";
    detailPlan.value = null;
    detailRevisions.value = [];
    detailConfirmedRevisions.value = [];
    detailLatestRevision.value = null;
    detailVersionSource.value = null;
    detailLoadError.value = null;
    detailDependencyOptions.value = [];
    dependenciesSaving.value = false;
  }

  async function openPlanDetail(plan: Plan): Promise<void> {
    const planId = plan.id ?? plan.planId;
    if (!planId) return;
    const requestedProjectId = deps.projectId.value;
    const requestToken = deps.projectScopeToken();
    const requestVersion = ++detailRequestVersion;
    const isCurrentDetailRequest = () => requestVersion === detailRequestVersion && deps.projectId.value === requestedProjectId && deps.projectScopeToken() === requestToken;
    drawerTab.value = "plan";
    // 先把已经加载好的 Explorer/Plan 投影留在抽屉里，等详情接口补齐冻结版本与调度元数据。
    detailPlan.value = plan;
    detailRevisions.value = [];
    detailConfirmedRevisions.value = [];
    detailLatestRevision.value = plan.revision;
    detailVersionSource.value = plan.status === "DRAFT" ? "candidate" : "confirmed";
    detailLoadError.value = null;
    detailDependencyOptions.value = [];
    drawerOpen.value = true;
    deps.onOpened(plan);
    // 候选态才可能改依赖；依赖目录与详情并行加载，取不到不阻塞详情。
    if (plan.status === "DRAFT") void loadDependencyOptions(requestedProjectId, planId, requestToken);
    const currentRevisionDraft = deps.revisionDraft.value;
    if (currentRevisionDraft && planId === currentRevisionDraft.planId && currentRevisionDraft.status !== "CONFIRMED" && currentRevisionDraft.status !== "DISCARDED") {
      detailPlan.value = deps.planFromRevisionDraft(currentRevisionDraft);
      detailLatestRevision.value = currentRevisionDraft.targetRevision;
      try {
        const history = await api.planRevisions(planId);
        if (!isCurrentDetailRequest()) return;
        detailRevisions.value = history.items.map((item) => item.revision);
        detailConfirmedRevisions.value = history.items.map((item) => item.revision);
        detailLatestRevision.value = currentRevisionDraft.targetRevision;
        detailVersionSource.value = "confirmed";
      } catch {
        // The current mutable draft remains usable even if historical metadata is temporarily unavailable.
      }
      return;
    }
    const isCandidate = plan.status === "DRAFT";
    if (!isCandidate) {
      // Merge reconciliation can take longer than the read-only Plan fetch. Keep it
      // in the background so a slow scheduler never leaves the shared drawer loading.
      void api.reconcileProjectMerges(requestedProjectId).then((report) => {
        if (deps.projectId.value !== requestedProjectId || deps.projectScopeToken() !== requestToken) return;
        const diagnostic = plan.runId ? report.items.find((item) => item.runId === plan.runId && item.reason) : undefined;
        if (diagnostic?.reason) ElMessage.warning(`Merge 状态检测：${diagnostic.reason}`);
      }).catch((caught) => {
        if (deps.projectId.value === requestedProjectId && deps.projectScopeToken() === requestToken) {
          ElMessage.warning(`Merge 状态检测失败，已展示最近保存的状态：${caught instanceof Error ? caught.message : "暂不可用"}`);
        }
      });
    }
    try {
      const response = await api.getPlan(planId);
      if (!isCurrentDetailRequest()) return;
      const resolvedContract = response.revision?.resolvedContract ?? response.plan.resolvedContract ?? plan.resolvedContract;
      const generatedSpec = response.plan.generatedSpec ?? plan.generatedSpec;
      detailPlan.value = { ...plan, ...response.plan, ...(generatedSpec ? { generatedSpec } : {}), ...(resolvedContract ? { resolvedContract } : {}), dispatch: response.dispatch, mergeRequest: response.mergeRequest };
      detailLatestRevision.value = response.plan.revision;
      if (isCandidate) {
        detailVersionSource.value = "candidate";
        const history = await api.candidatePlanVersions(planId).catch(() => null);
        if (!isCurrentDetailRequest()) return;
        detailRevisions.value = history?.items.map((item) => item.revision) ?? [];
        detailConfirmedRevisions.value = [];
      } else {
        detailVersionSource.value = "confirmed";
        try {
          const [history, candidateHistory] = await Promise.all([api.planRevisions(planId), api.candidatePlanVersions(planId)]);
          if (!isCurrentDetailRequest()) return;
          const versions = resolvePlanVersionHistory(candidateHistory.items, history.items);
          detailRevisions.value = versions.revisions;
          detailConfirmedRevisions.value = versions.confirmedRevisions;
        } catch {
          // Current Plan remains readable when historical version metadata is unavailable.
        }
      }
    } catch (caught) {
      if (!isCurrentDetailRequest()) return;
      detailLoadError.value = caught instanceof Error ? `无法加载完整 Plan：${caught.message}` : "无法加载完整 Plan";
    }
  }

  async function selectPlanRevision(revisionNumber: number): Promise<void> {
    const current = detailPlan.value;
    const planId = current?.id ?? current?.planId;
    if (!current || !planId || current.revision === revisionNumber) return;
    const requestVersion = detailRequestVersion;
    detailLoadError.value = null;
    try {
      if (detailVersionSource.value === "candidate" || !isConfirmedPlanRevision(revisionNumber, detailConfirmedRevisions.value)) {
        const response = await api.getCandidatePlanVersion(planId, revisionNumber);
        if (requestVersion !== detailRequestVersion) return;
        detailPlan.value = response.version;
      } else {
        const response = await api.getPlanRevision(planId, revisionNumber);
        if (requestVersion !== detailRequestVersion) return;
        detailPlan.value = { ...current, revision: response.revision.revision, status: "READY", ...(response.revision.contract ? { contract: response.revision.contract } : {}), ...(response.revision.resolvedContract ? { resolvedContract: response.revision.resolvedContract } : {}) };
      }
    } catch (caught) {
      if (requestVersion !== detailRequestVersion) return;
      detailLoadError.value = caught instanceof Error ? `无法加载 V${revisionNumber}：${caught.message}` : `无法加载 V${revisionNumber}`;
    }
  }

  /**
   * 前置 Plan 的可选项：同项目里其他未丢弃的 Plan。只在**候选态**（还能改依赖）时加载。
   * 依赖是 Factory-owned 字段（模型不能填），所以候选清单必须由界面给出而不是模型自己报。
   */
  const detailDependencyOptions = ref<Array<{ id: string; title: string }>>([]);
  const dependenciesSaving = ref(false);
  const canEditDependencies = computed(() => !deps.isReadOnly?.() && detailPlan.value?.status === "DRAFT" && Boolean(detailPlan.value?.generatedSpec || detailPlan.value?.resolvedContract));

  async function loadDependencyOptions(projectId: string, planId: string, requestToken: number): Promise<void> {
    try {
      const response = await api.candidatePlans(projectId);
      if (deps.projectId.value !== projectId || deps.projectScopeToken() !== requestToken) return;
      detailDependencyOptions.value = response.items.flatMap((item) => {
        const id = item.id ?? item.planId;
        return id && id !== planId ? [{ id, title: item.title }] : [];
      });
    } catch {
      // 目录取不到不阻塞详情：依赖区退化成"暂时无法选择"，而不是整页报错。
      detailDependencyOptions.value = [];
    }
  }

  /** 保存前置 Plan；失败用 ElMessage 说明原因（不可逆的调度语义，不该静默失败）。 */
  async function saveDependencies(plan: Plan | null, planIds: string[]): Promise<void> {
    const planId = plan?.id ?? plan?.planId;
    if (!planId || dependenciesSaving.value) return;
    dependenciesSaving.value = true;
    try {
      const response = await api.updatePlanDependencies(planId, planIds);
      if (detailPlan.value && (detailPlan.value.id ?? detailPlan.value.planId) === planId) detailPlan.value = { ...detailPlan.value, ...response.plan };
      ElMessage.success("前置 Plan 已保存");
    } catch (caught) {
      ElMessage.error(caught instanceof Error ? `前置 Plan 保存失败：${caught.message}` : "前置 Plan 保存失败");
    } finally {
      dependenciesSaving.value = false;
    }
  }

  return {
    drawerOpen,
    drawerTab,
    detailPlan,
    detailRevisions,
    detailConfirmedRevisions,
    detailLatestRevision,
    detailVersionSource,
    detailLoadError,
    detailDependencyOptions,
    dependenciesSaving,
    canEditDependencies,
    openPlanDetail,
    selectPlanRevision,
    saveDependencies,
    resetDetailState,
  };
}
