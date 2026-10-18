<!--
  模块职责：项目视角的 Worktree 管理面板 —— 盘点仓库里的全部分支 / worktree，展示它们的状态，
  提供合并预览、执行合并、冲突续做/中止，以及已合并 worktree 的清理。

  维护提示：
    1) **这个面板是唯一会真的改写受管仓库 Git 状态的界面**。所有判据都来自服务端
       （`item.mergeable` / `item.cleanupable` / `preview.canConfirm`），这里只负责展示与二次确认；
       不要在前端"顺便"放宽任何一条——服务端在 `merge` / `cleanup` 里会把同一条判据再跑一次。
    2) **合并进行中的横幅必须排在表格之前**。repoRoot 停在冲突态会挡住后续 Plan 确认与 Run 派发
       （工作区干净检查），把提示藏进表格下面等于让人自己去发现"为什么什么都点不动"。
    3) 合并 / 清理成功后**重新拉清单**，不本地推断状态：`merged_clean`、ahead/behind、worktree
       是否存在都以 Git 为准，本地拼出来的那行很容易与下一次刷新不一致。
    4) 页面进入时不自动刷新合并预览，只拉清单；预览要跑 `merge-tree`，每次进页面都跑一遍是浪费。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { CopyDocument, Refresh, Warning } from "@element-plus/icons-vue";
import { api } from "../api";
import type { Project, WorktreeInventory, WorktreeItem, WorktreeMergePreview, WorktreeMergeResult, WorktreeRuntimeInfo } from "../types";
import {
  cleanupDisabledReason,
  matchesWorktreeFilters,
  mergeDisabledReason,
  worktreeKindLabel,
  worktreeKindTagType,
  worktreeMergeRelationLabel,
  worktreeMergeRelationTagType,
  worktreeRunStatusLabel,
  worktreeSourceLabel,
  formatWorktreeTime,
  sortWorktreeItems,
  toggleIgnoredBranch,
  worktreeStatusLabel,
  worktreeStatusTagType,
  type WorktreeKindFilter,
  type WorktreeSortDirection,
  type WorktreeSortKey,
  type WorktreeStatusFilter,
} from "../utils/worktreeStatus";
import WorktreeMergePreviewDialog from "./WorktreeMergePreviewDialog.vue";
import WorktreeMergeResultDialog from "./WorktreeMergeResultDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WorktreeLogDialog from "./WorktreeLogDialog.vue";
import WorktreeServicesPanel from "./WorktreeServicesPanel.vue";

const props = defineProps<{ projectId: string; project: Project | null }>();
/**
 * 「在项目设置中配置」：范围（模式 / 忽略 / detached）是**项目属性**，编排放项目设置页的
 * Worktree 页签里。面板只保留"这一次怎么看"的开关，不在两处各放一套编辑器。
 */
const emit = defineEmits<{ "open-settings": [tab: string] }>();

const inventory = ref<WorktreeInventory | null>(null);
const loading = ref(false);
const error = ref("");
const statusFilter = ref<WorktreeStatusFilter>("all");
const kindFilter = ref<WorktreeKindFilter>("all");
const selectedItemId = ref<string | null>(null);

const previewVisible = ref(false);
const preview = ref<WorktreeMergePreview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
const mergeBusy = ref(false);

const resultVisible = ref(false);
const mergeResult = ref<WorktreeMergeResult | null>(null);
const mergeActionBusy = ref<"continue" | "abort" | null>(null);
const mergeActionError = ref("");

const cleanupTarget = ref<WorktreeItem | null>(null);
const cleanupBusy = ref(false);
const cleanupError = ref("");

/** 是否越过项目范围看全量（服务端 `includeFiltered`）。 */
const includeFiltered = ref(false);
const sortKey = ref<WorktreeSortKey>("time");
const sortDirection = ref<WorktreeSortDirection>("desc");
const scopeBusy = ref(false);
const scopeError = ref("");
const logOpen = ref(false);
const logRef = ref("");

/** 执行目录（合并前验证的固定路径）。`null` 表示还没读到（或本实例不支持）。 */
const runtime = ref<WorktreeRuntimeInfo | null>(null);
const runtimeBusy = ref(false);
const runtimeError = ref("");
const runtimeClearOpen = ref(false);

/** 当前选中的条目是不是执行目录目标：是的话服务走 runtime 接口（路径/端口固定）。 */
const isRuntimeTarget = computed(() => Boolean(selectedItem.value && runtime.value?.current?.itemId === selectedItem.value.itemId));
const runtimeServicesMode = computed<"worktree" | "runtime">(() => (isRuntimeTarget.value ? "runtime" : "worktree"));

let requestGeneration = 0;
let eventSource: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const statusFilters: Array<{ key: WorktreeStatusFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "unmerged", label: "未合并" },
  { key: "conflict", label: "冲突" },
  { key: "cleanup", label: "可清理" },
  { key: "no-updates", label: "无更新" },
];
const kindFilters: Array<{ key: WorktreeKindFilter; label: string }> = [
  { key: "all", label: "全部类型" },
  { key: "worktree", label: "Worktree" },
  { key: "local", label: "本地分支" },
  { key: "detached", label: "Detached" },
];

const sortOptions: Array<{ key: WorktreeSortKey; label: string }> = [
  { key: "time", label: "时间" },
  { key: "name", label: "名称" },
  { key: "ahead", label: "Ahead" },
];

const items = computed(() => inventory.value?.items ?? []);
const filteredItems = computed(() =>
  sortWorktreeItems(
    items.value.filter((item) => matchesWorktreeFilters(item, { status: statusFilter.value, kind: kindFilter.value })),
    { key: sortKey.value, direction: sortDirection.value },
  ),
);
const selectedItem = computed(() => items.value.find((item) => item.itemId === selectedItemId.value) ?? null);
/**
 * 清理确认框的文案必须按 kind 分：三种清理对象做的事不一样（删目录+分支 / 只删分支 / 只删目录），
 * 一律写"删除 worktree 与分支"会让"只删一条已合并分支"看起来比实际危险，也会让 detached 那条
 * 显得会丢提交。
 */
const cleanupMessage = computed(() => {
  const item = cleanupTarget.value;
  if (!item) return "";
  if (item.kind === "local_branch") return `将删除本地分支 ${item.branch}（这条分支没有 worktree）。`;
  if (item.kind === "detached_worktree") return `将删除 detached worktree 目录 ${item.effectivePath}（它的提交仍被本地分支包含）。`;
  return `将删除 ${item.branch} 的 worktree 目录，并删除这条本地分支。`;
});
const cleanupHeading = computed(() => {
  const item = cleanupTarget.value;
  if (item?.kind === "local_branch") return "删除已合并的本地分支";
  if (item?.kind === "detached_worktree") return "删除 detached worktree 目录";
  return "删除 worktree 与分支";
});
const cleanupDetails = computed(() => {
  const item = cleanupTarget.value;
  if (item?.kind === "local_branch")
    return ["只有已合并到主分支的分支会走到这一步", "分支用 git branch -d 删除（未合并时 git 会拒绝）", "没有 worktree 目录需要删除"];
  if (item?.kind === "detached_worktree")
    return ["这个 worktree 的 HEAD 已被某个本地分支包含，删除不会丢提交", "worktree 目录会被 git worktree remove 删除", "不删除任何分支"];
  return [
    "只有「已提交已合并」且工作区干净的分支会走到这一步",
    "worktree 目录会被 git worktree remove 删除",
    "分支用 git branch -d 删除（未合并时 git 会拒绝）",
  ];
});

/** 兜底服务配置的指纹：变化时强制重挂服务区块，让它重新读配置。 */
const servicesConfigKey = computed(() => JSON.stringify(props.project?.settings?.worktreeServices ?? null));

/** 范围摘要：让"为什么少了几条"在面板上直接可见，而不用去设置页翻。 */
const scopeSummary = computed(() => {
  const filter = inventory.value?.filter;
  if (!filter) return "";
  const parts: string[] = [];
  parts.push(filter.filterMode === "patterns" ? `模式 ${filter.branchPatterns.join("、") || "（空）"}` : "全部分支");
  if (filter.ignoredBranches.length > 0) parts.push(`忽略 ${filter.ignoredBranches.length} 条`);
  if (!filter.includeDetachedWorktrees) parts.push("不含 detached");
  return `范围：${parts.join(" · ")}`;
});

const mergeableCount = computed(() => items.value.filter((item) => item.mergeable).length);
const cleanupableCount = computed(() => items.value.filter((item) => item.cleanupable).length);
const mergeInProgress = computed(() => inventory.value?.mergeInProgress ?? null);

async function load() {
  const projectId = props.projectId;
  const generation = ++requestGeneration;
  loading.value = true;
  error.value = "";
  try {
    const [next, runtimeResponse] = await Promise.all([
      api.worktrees(projectId, { includeFiltered: includeFiltered.value }),
      // 执行目录读失败不该让整张清单挂掉：它是附加信息，降级成"未读到"。
      api.worktreeRuntime(projectId).catch(() => null),
    ]);
    if (generation !== requestGeneration || projectId !== props.projectId) return;
    inventory.value = next;
    runtime.value = runtimeResponse?.runtime ?? null;
    if (selectedItemId.value && !next.items.some((item) => item.itemId === selectedItemId.value)) {
      selectedItemId.value = null;
    }
  } catch (caught) {
    if (generation !== requestGeneration) return;
    error.value = caught instanceof Error ? caught.message : "Worktree 清单加载失败";
    inventory.value = null;
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

/**
 * 把某个 worktree 设为执行目录。`startServices` 为真时（「切换并启动」）依次启动所有启用的服务，
 * 任一失败即停在那一条并报错——不要"部分启动成功却当成功"。
 */
async function switchRuntime(item: WorktreeItem, startServices = false) {
  if (runtimeBusy.value) return;
  runtimeBusy.value = true;
  runtimeError.value = "";
  try {
    const response = await api.switchWorktreeRuntime(props.projectId, item.itemId);
    runtime.value = response.runtime;
    if (startServices) {
      for (const service of (response.services?.services ?? []).filter((entry) => entry.enabled)) {
        try {
          await api.startRuntimeService(props.projectId, service.serviceId);
        } catch (caught) {
          runtimeError.value = `服务 ${service.name} 启动失败：${caught instanceof Error ? caught.message : String(caught)}`;
          break;
        }
      }
    }
    ElMessage.success(response.stoppedServices > 0 ? `已切换执行目录（先停掉 ${response.stoppedServices} 个服务）` : "已切换执行目录");
    await load();
  } catch (caught) {
    runtimeError.value = caught instanceof Error ? caught.message : "执行目录切换失败";
  } finally {
    runtimeBusy.value = false;
  }
}

async function clearRuntime() {
  if (runtimeBusy.value) return;
  runtimeBusy.value = true;
  runtimeError.value = "";
  try {
    const response = await api.clearWorktreeRuntime(props.projectId);
    runtimeClearOpen.value = false;
    ElMessage.success(response.cleared ? "执行目录已清空" : "执行目录本来就是空的");
    await load();
  } catch (caught) {
    runtimeError.value = caught instanceof Error ? caught.message : "执行目录清空失败";
    runtimeClearOpen.value = false;
  } finally {
    runtimeBusy.value = false;
  }
}

function selectItem(item: WorktreeItem) {
  selectedItemId.value = item.itemId;
}

async function openPreview(item: WorktreeItem) {
  if (!item.mergeable) {
    ElMessage.warning(mergeDisabledReason(item) || "这条分支当前不能合并。");
    return;
  }
  preview.value = null;
  previewError.value = "";
  previewVisible.value = true;
  previewLoading.value = true;
  try {
    const response = await api.previewWorktreeMerge(props.projectId, item.itemId);
    preview.value = response.preview;
  } catch (caught) {
    previewError.value = caught instanceof Error ? caught.message : "合并预览加载失败";
  } finally {
    previewLoading.value = false;
  }
}

async function confirmMerge() {
  const target = preview.value;
  if (!target || !target.canConfirm || mergeBusy.value) return;
  mergeBusy.value = true;
  previewError.value = "";
  try {
    const response = await api.mergeWorktree(props.projectId, {
      itemId: target.itemId,
      expectedBranchHead: target.expectedBranchHead,
      expectedBaseHead: target.expectedBaseHead,
    });
    previewVisible.value = false;
    mergeResult.value = response.result;
    resultVisible.value = true;
    await load();
  } catch (caught) {
    previewError.value = caught instanceof Error ? caught.message : "合并失败";
  } finally {
    mergeBusy.value = false;
  }
}

async function continueMerge() {
  if (mergeActionBusy.value) return;
  mergeActionBusy.value = "continue";
  mergeActionError.value = "";
  try {
    const response = await api.continueWorktreeMerge(props.projectId);
    mergeResult.value = response.result;
    resultVisible.value = true;
    await load();
  } catch (caught) {
    mergeActionError.value = caught instanceof Error ? caught.message : "继续合并失败";
  } finally {
    mergeActionBusy.value = null;
  }
}

async function abortMerge() {
  if (mergeActionBusy.value) return;
  mergeActionBusy.value = "abort";
  mergeActionError.value = "";
  try {
    const response = await api.abortWorktreeMerge(props.projectId);
    mergeResult.value = response.result;
    resultVisible.value = true;
    await load();
  } catch (caught) {
    mergeActionError.value = caught instanceof Error ? caught.message : "中止合并失败";
  } finally {
    mergeActionBusy.value = null;
  }
}

function askCleanup(item: WorktreeItem) {
  cleanupTarget.value = item;
  cleanupError.value = "";
}

async function confirmCleanup() {
  const target = cleanupTarget.value;
  if (!target || cleanupBusy.value) return;
  cleanupBusy.value = true;
  cleanupError.value = "";
  try {
    const response = await api.cleanupWorktree(props.projectId, {
      itemId: target.itemId,
      expectedBranchHead: target.lastCommit,
    });
    cleanupTarget.value = null;
    const stopped = response.stoppedServices ?? 0;
    if (response.result.branchDeleted && !response.result.cleanupHookNeedsAttention && stopped === 0)
      ElMessage.success(response.result.message);
    else ElMessage.warning(stopped > 0 ? `${response.result.message}（已先停掉 ${stopped} 个服务）` : response.result.message);
    await load();
  } catch (caught) {
    cleanupError.value = caught instanceof Error ? caught.message : "清理失败";
  } finally {
    cleanupBusy.value = false;
  }
}

async function copy(text: string | null | undefined) {
  if (!text) return;
  try {
    await navigator.clipboard?.writeText(text);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择文本。");
  }
}

function factorySummary(item: WorktreeItem): string {
  if (!item.factory) return "手动分支";
  return `${worktreeSourceLabel(item.factory)} · ${worktreeRunStatusLabel(item.factory.runStatus)}`;
}

/**
 * 自动刷新：服务端事件流只推 "type + sequence"，这里防抖 400ms 后重拉清单。
 * **不做本地增量更新**——合并/清理会同时改 ahead/behind、worktree 是否存在、Factory 联动，
 * 本地拼出来的那一行很容易与下一次刷新不一致（同维护提示 3）。
 */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void load();
  }, 400);
}

function closeEvents() {
  eventSource?.close();
  eventSource = null;
}

function connectEvents() {
  closeEvents();
  if (typeof EventSource === "undefined") return; // jsdom / 不支持 SSE 的环境
  const source = new EventSource(api.worktreeEventsUrl(props.projectId));
  source.addEventListener("worktree", () => scheduleRefresh());
  // EventSource 自己会重连；不要在这里 close，否则断线后就再也不刷新了。
  source.onerror = () => undefined;
  /**
   * **断线期间发生的事件不会补推**（服务端不重放，只给新的）。所以重连成功后补一次刷新；
   * 首次连接除外——那一次与 `onMounted` 的 `load()` 重复，白跑一遍扫仓库。
   */
  let firstOpen = true;
  source.onopen = () => {
    if (firstOpen) {
      firstOpen = false;
      return;
    }
    scheduleRefresh();
  };
  eventSource = source;
}

/** 忽略 / 取消忽略一条分支（写进项目设置，跨浏览器一致）。 */
async function toggleIgnore(item: WorktreeItem) {
  if (!item.branch) {
    ElMessage.warning("detached worktree 没有分支名，不能忽略。");
    return;
  }
  if (scopeBusy.value) return;
  scopeBusy.value = true;
  scopeError.value = "";
  try {
    const current = inventory.value?.filter.ignoredBranches ?? [];
    await api.updateProject(props.projectId, {
      settings: { worktree: { ignoredBranches: toggleIgnoredBranch(current, item.branch, !item.isIgnored) } },
    });
    ElMessage.success(item.isIgnored ? "已取消忽略" : "已忽略这条分支");
    await load();
  } catch (caught) {
    scopeError.value = caught instanceof Error ? caught.message : "忽略状态保存失败";
  } finally {
    scopeBusy.value = false;
  }
}

function openLog(item: WorktreeItem) {
  const ref = item.branch ?? item.lastCommit;
  if (!ref) {
    ElMessage.warning("这一项没有可查看的提交。");
    return;
  }
  logRef.value = ref;
  logOpen.value = true;
}

/**
 * 范围改在项目设置页保存之后，面板要重新拉一次：`project` 是父组件传下来的，设置保存成功会更新它，
 * 但清单不会自己变。只对 worktree 这一段做比较，别的设置变化不触发重新扫仓库。
 */
watch(
  () => JSON.stringify(props.project?.settings?.worktree ?? null),
  () => {
    void load();
  },
);

watch(
  () => props.projectId,
  () => {
    selectedItemId.value = null;
    inventory.value = null;
    void load();
    connectEvents();
  },
);

onMounted(() => {
  void load();
  connectEvents();
});

onBeforeUnmount(() => {
  closeEvents();
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <section class="worktrees-panel" aria-label="Worktree 管理" data-worktrees-panel>
    <header class="worktrees-header">
      <div class="worktrees-heading">
        <p class="worktrees-eyebrow">Worktree 管理</p>
        <h1>{{ props.project?.name ?? "项目" }}</h1>
        <p class="worktrees-subtitle">
          <span>{{ inventory?.repoRoot ?? props.project?.repoRoot ?? "加载中…" }}</span>
          <span v-if="inventory"
            >主分支 <code>{{ inventory.baseBranch }}</code></span
          >
          <span v-if="inventory"
            >当前分支 <code>{{ inventory.currentBranch ?? "detached" }}</code></span
          >
        </p>
      </div>
      <div class="worktrees-header-actions">
        <span class="worktrees-count" data-worktrees-summary> {{ mergeableCount }} 项可合并 · {{ cleanupableCount }} 项可清理 </span>
        <el-button :icon="Refresh" :loading="loading" data-worktrees-refresh @click="load">刷新</el-button>
      </div>
    </header>

    <p v-if="error" class="worktrees-error" role="alert">
      <Warning :size="15" />{{ error }}
      <button type="button" @click="load">重试</button>
    </p>

    <section v-if="mergeInProgress" class="merge-banner" role="alert" data-merge-in-progress>
      <div class="merge-banner-copy">
        <strong>仓库里有进行中的 {{ mergeInProgress.kind === "merge" ? "合并" : mergeInProgress.kind }}</strong>
        <p>
          当前分支 <code>{{ mergeInProgress.currentBranch ?? "detached" }}</code>
          <template v-if="mergeInProgress.mergeHead"
            >，MERGE_HEAD <code>{{ mergeInProgress.mergeHead.slice(0, 12) }}</code></template
          >。
          <template v-if="mergeInProgress.kind === 'merge'">解决冲突后继续，或直接中止。</template>
          <template v-else>请先在 Git 里完成或中止这次操作，再回到这里刷新。</template>
        </p>
        <ul v-if="mergeInProgress.conflictFiles.length" class="merge-banner-files">
          <li v-for="file in mergeInProgress.conflictFiles" :key="file">
            <code>{{ file }}</code>
          </li>
        </ul>
        <p v-if="mergeActionError" class="merge-banner-error">{{ mergeActionError }}</p>
      </div>
      <div v-if="mergeInProgress.kind === 'merge'" class="merge-banner-actions">
        <el-button type="primary" :loading="mergeActionBusy === 'continue'" data-merge-continue @click="continueMerge">
          继续合并
        </el-button>
        <el-button :loading="mergeActionBusy === 'abort'" data-merge-abort @click="abortMerge">中止合并</el-button>
      </div>
    </section>

    <section v-if="runtime" class="runtime-bar" data-worktree-runtime>
      <div class="runtime-copy">
        <strong>执行目录</strong>
        <code class="runtime-path" :title="runtime.path">{{ runtime.path }}</code>
        <span v-if="runtime.current" class="runtime-current" data-runtime-current>
          当前 → <strong>{{ runtime.current.displayName }}</strong>
        </span>
        <span v-else-if="runtime.link?.isSymlink && !runtime.link.exists" class="runtime-warn">目标已失效</span>
        <span v-else class="runtime-empty">尚未切换</span>
      </div>
      <div class="runtime-actions">
        <el-button v-if="runtime.link?.isSymlink" size="small" :loading="runtimeBusy" data-runtime-clear @click="runtimeClearOpen = true">
          清空
        </el-button>
      </div>
    </section>
    <p v-if="runtimeError" class="runtime-error" data-runtime-error role="alert">{{ runtimeError }}</p>

    <ul v-if="inventory?.warnings.length" class="worktrees-warnings" data-worktrees-warnings>
      <li v-for="warning in inventory.warnings" :key="warning">{{ warning }}</li>
    </ul>

    <div class="worktrees-toolbar">
      <div class="filter-group" role="group" aria-label="按状态筛选">
        <button
          v-for="entry in statusFilters"
          :key="entry.key"
          type="button"
          :class="{ active: statusFilter === entry.key }"
          :data-worktree-status-filter="entry.key"
          @click="statusFilter = entry.key"
        >
          {{ entry.label }}
        </button>
      </div>
      <div class="filter-group" role="group" aria-label="按类型筛选">
        <button
          v-for="entry in kindFilters"
          :key="entry.key"
          type="button"
          :class="{ active: kindFilter === entry.key }"
          :data-worktree-kind-filter="entry.key"
          @click="kindFilter = entry.key"
        >
          {{ entry.label }}
        </button>
      </div>
      <div class="filter-group" role="group" aria-label="排序">
        <button
          v-for="entry in sortOptions"
          :key="entry.key"
          type="button"
          :class="{ active: sortKey === entry.key }"
          :data-worktree-sort="entry.key"
          @click="sortKey = entry.key"
        >
          {{ entry.label }}
        </button>
        <button type="button" data-worktree-sort-direction @click="sortDirection = sortDirection === 'desc' ? 'asc' : 'desc'">
          {{ sortDirection === "desc" ? "倒序" : "正序" }}
        </button>
      </div>
      <span class="scope-summary" data-worktree-scope-summary>{{ scopeSummary }}</span>
      <button type="button" class="scope-toggle" data-worktree-open-settings @click="emit('open-settings', 'worktree')">
        在项目设置中配置
      </button>
      <!--
        条件必须包含 `includeFiltered`：勾上"显示被过滤的项"之后若过滤数归零（比如刚把忽略清空），
        只按 `filteredOutCount > 0` 渲染会让按钮消失，于是再也切不回范围视图（浏览器实测踩过）。
      -->
      <button
        v-if="inventory && (includeFiltered || inventory.filteredOutCount > 0)"
        type="button"
        class="scope-toggle"
        :class="{ active: includeFiltered }"
        data-worktree-include-filtered
        @click="
          includeFiltered = !includeFiltered;
          load();
        "
      >
        {{ includeFiltered ? "只看项目范围" : `显示被过滤的 ${inventory.filteredOutCount} 项` }}
      </button>
      <span class="toolbar-count" data-worktrees-visible-count>{{ filteredItems.length }} / {{ items.length }} 项</span>
    </div>

    <div class="worktrees-body">
      <div class="worktrees-table-wrap">
        <div v-if="loading && !inventory" class="worktrees-state" role="status" data-worktrees-state="loading">
          正在扫描分支与 worktree…
        </div>
        <div v-else-if="!filteredItems.length" class="worktrees-state" data-worktrees-state="empty">
          <strong>没有匹配的分支或 worktree</strong>
          <span>调整筛选条件，或点「刷新」重新扫描当前项目。</span>
        </div>
        <table v-else class="worktrees-table">
          <thead>
            <tr>
              <th scope="col" class="col-status">状态</th>
              <th scope="col" class="col-branch">分支 / Detached</th>
              <th scope="col" class="col-kind">类型</th>
              <th scope="col" class="num col-count">Ahead</th>
              <th scope="col" class="num col-count">Behind</th>
              <th scope="col" class="col-relation">合并关系</th>
              <th scope="col" class="col-time">最近提交</th>
              <th scope="col" class="col-source">来源</th>
              <th scope="col" class="actions col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in filteredItems"
              :key="item.itemId"
              :class="{ selected: item.itemId === selectedItemId, base: item.isBaseBranch }"
              :data-worktree-item="item.itemId"
              role="button"
              tabindex="0"
              :aria-label="`${item.displayName}：${worktreeStatusLabel(item.status)}`"
              :aria-pressed="item.itemId === selectedItemId"
              @click="selectItem(item)"
              @keydown.enter.prevent="selectItem(item)"
              @keydown.space.prevent="selectItem(item)"
            >
              <td class="col-status">
                <el-tag size="small" effect="light" :type="worktreeStatusTagType(item.status)" data-worktree-status>
                  {{ worktreeStatusLabel(item.status) }}
                </el-tag>
              </td>
              <td class="col-branch">
                <span class="cell-branch" :title="item.displayName">{{ item.displayName }}</span>
                <el-tag v-if="item.isBaseBranch" size="small" effect="plain" type="primary">主分支</el-tag>
                <el-tag v-if="item.missing" size="small" effect="plain" type="danger">目录缺失</el-tag>
              </td>
              <td class="col-kind">
                <el-tag size="small" effect="plain" :type="worktreeKindTagType(item.kind)">{{ worktreeKindLabel(item.kind) }}</el-tag>
              </td>
              <td class="num col-count">{{ item.aheadCount }}</td>
              <td class="num col-count col-behind">{{ item.behindCount }}</td>
              <td class="cell-relation col-relation">{{ worktreeMergeRelationLabel(item.mergeRelation) }}</td>
              <td class="cell-time col-time">{{ formatWorktreeTime(item.lastCommitAt) }}</td>
              <td class="cell-source col-source">{{ factorySummary(item) }}</td>
              <td class="actions" @click.stop>
                <div class="row-actions">
                  <el-button size="small" type="primary" :disabled="!item.mergeable" data-worktree-preview @click="openPreview(item)">
                    预览合并
                  </el-button>
                  <el-button
                    size="small"
                    :disabled="!item.cleanupable"
                    :title="cleanupDisabledReason(item)"
                    data-worktree-cleanup
                    @click="askCleanup(item)"
                    >清理</el-button
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="inventory?.truncated" class="worktrees-truncated">分支数量超过上限，清单只列出了前一部分。</p>
      </div>

      <aside v-if="selectedItem" class="worktrees-detail" data-worktree-detail>
        <div class="detail-head">
          <el-tag size="small" effect="light" :type="worktreeStatusTagType(selectedItem.status)">
            {{ worktreeStatusLabel(selectedItem.status) }}
          </el-tag>
          <el-tag size="small" effect="plain" :type="worktreeMergeRelationTagType(selectedItem.mergeRelation)">
            {{ worktreeMergeRelationLabel(selectedItem.mergeRelation) }}
          </el-tag>
          <h2>{{ selectedItem.displayName }}</h2>
          <p class="detail-path" :title="selectedItem.effectivePath">{{ selectedItem.effectivePath }}</p>
          <div class="detail-copy-actions">
            <el-button v-if="selectedItem.branch" size="small" :icon="CopyDocument" @click="copy(selectedItem.branch)">
              复制分支
            </el-button>
            <el-button size="small" :icon="CopyDocument" @click="copy(selectedItem.effectivePath)">复制路径</el-button>
            <el-button size="small" data-worktree-log-open @click="openLog(selectedItem)">提交历史</el-button>
          </div>
          <div v-if="selectedItem.hasWorktree" class="detail-runtime-actions">
            <el-button
              size="small"
              type="primary"
              :disabled="isRuntimeTarget || selectedItem.missing"
              :loading="runtimeBusy"
              data-runtime-switch
              @click="switchRuntime(selectedItem)"
            >
              {{ isRuntimeTarget ? "当前执行目录" : "设为执行目录" }}
            </el-button>
            <el-button
              v-if="!isRuntimeTarget"
              size="small"
              :disabled="selectedItem.missing"
              :loading="runtimeBusy"
              data-runtime-switch-start
              @click="switchRuntime(selectedItem, true)"
              >切换并启动</el-button
            >
          </div>
          <div v-if="selectedItem.branch && !selectedItem.isBaseBranch" class="detail-tag-actions">
            <el-button size="small" :loading="scopeBusy" data-worktree-toggle-ignore @click="toggleIgnore(selectedItem)">
              {{ selectedItem.isIgnored ? "取消忽略" : "忽略这条分支" }}
            </el-button>
          </div>
        </div>

        <dl class="detail-facts">
          <div>
            <dt>类型</dt>
            <dd>{{ worktreeKindLabel(selectedItem.kind) }}</dd>
          </div>
          <div>
            <dt>是否 worktree</dt>
            <dd>{{ selectedItem.hasWorktree ? "是" : "否" }}</dd>
          </div>
          <div>
            <dt>工作区</dt>
            <dd>{{ selectedItem.gitDirtyState }}</dd>
          </div>
          <div>
            <dt>Ahead / Behind</dt>
            <dd>{{ selectedItem.aheadCount }} / {{ selectedItem.behindCount }}</dd>
          </div>
          <div>
            <dt>提交</dt>
            <dd>
              <code>{{ selectedItem.lastCommit ?? "—" }}</code>
            </dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{{ factorySummary(selectedItem) }}</dd>
          </div>
        </dl>

        <div v-if="selectedItem.conflictFiles.length" class="detail-block" data-worktree-conflicts>
          <h3>冲突文件</h3>
          <ul>
            <li v-for="file in selectedItem.conflictFiles" :key="file">
              <code>{{ file }}</code>
            </li>
          </ul>
        </div>

        <div v-if="selectedItem.blockers.length" class="detail-block" data-worktree-blockers>
          <h3>为什么不能合并</h3>
          <ul class="detail-reasons">
            <li v-for="reason in selectedItem.blockers" :key="reason">{{ reason }}</li>
          </ul>
        </div>

        <div v-if="selectedItem.cleanupBlockers.length" class="detail-block">
          <h3>为什么不能清理</h3>
          <ul class="detail-reasons">
            <li v-for="reason in selectedItem.cleanupBlockers" :key="reason">{{ reason }}</li>
          </ul>
        </div>

        <!--
          `:key` 绑兜底配置：在「项目设置 → Worktree」里改完兜底服务后，这个区块要重新读配置。
          服务面板自己只监听 itemId（选择别的条目才刷新），改配置不会触发它。
        -->
        <WorktreeServicesPanel
          v-if="selectedItem.hasWorktree"
          :key="`${servicesConfigKey}:${runtimeServicesMode}`"
          :project-id="props.projectId"
          :item="selectedItem"
          :mode="runtimeServicesMode"
        />
      </aside>
    </div>

    <WorktreeMergePreviewDialog
      v-model="previewVisible"
      :preview="preview"
      :busy="mergeBusy"
      :error="previewLoading ? null : previewError"
      @confirm="confirmMerge"
    />
    <p v-if="previewLoading" class="preview-loading" role="status">正在生成合并预览…</p>

    <WorktreeMergeResultDialog v-model="resultVisible" :result="mergeResult" />
    <WorktreeLogDialog v-model="logOpen" :project-id="props.projectId" :target="logRef" :title="logRef" />

    <ConfirmDialog
      :model-value="runtimeClearOpen"
      eyebrow="执行目录"
      heading="清空执行目录"
      message="将停止通过执行目录启动的服务，并删除 repo 链接。"
      :details="['只删除符号链接，不会删除任何 worktree 或分支', '由本应用启动的 runtime 服务会被停掉']"
      confirm-label="清空"
      cancel-label="取消"
      tone="primary"
      :busy="runtimeBusy"
      @update:model-value="runtimeClearOpen = $event"
      @confirm="clearRuntime"
    />

    <ConfirmDialog
      :model-value="Boolean(cleanupTarget)"
      eyebrow="清理"
      :heading="cleanupHeading"
      :message="cleanupMessage"
      :details="cleanupDetails"
      confirm-label="确认清理"
      cancel-label="取消"
      :busy="cleanupBusy"
      :error="cleanupError"
      @update:model-value="cleanupTarget = $event ? cleanupTarget : null"
      @confirm="confirmCleanup"
    />
  </section>
</template>

<style scoped>
/* 与「项目执行线程」同一套外壳：左栏 + 满宽中间列，右栏上下文面板在这个模式下没有意义。 */
:global(.console-layout.project-worktrees-mode) {
  grid-template-columns: minmax(250px, 330px) minmax(0, 1fr) !important;
}
:global(.console-layout.project-worktrees-mode > .context-panel-shell) {
  display: none !important;
}
.worktrees-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: #fff;
  color: #1d293b;
}
.worktrees-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 25px clamp(20px, 4vw, 48px) 18px;
  border-bottom: 1px solid #e7ecf3;
}
.worktrees-eyebrow {
  margin: 0 0 7px;
  color: #8796ad;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.worktrees-header h1 {
  margin: 0;
  color: #1e2b40;
  font-size: 26px;
  letter-spacing: -0.04em;
}
.worktrees-subtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 8px 0 0;
  color: #7d8ca3;
  font-size: 12px;
}
/* 仓库路径可能很长：单行省略，别让它把标题区撑成三行（矮视口下这直接吃掉表格的高度）。 */
.worktrees-subtitle span {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worktrees-subtitle code {
  color: #4d6483;
}
.worktrees-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
}
.worktrees-count {
  color: #7c8ba3;
  font-size: 11px;
  white-space: nowrap;
}
.worktrees-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px clamp(20px, 4vw, 48px) 0;
  padding: 10px 12px;
  border: 1px solid #f0d0d3;
  border-radius: 8px;
  background: #fff7f7;
  color: #a94851;
  font-size: 12px;
}
.worktrees-error button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #8e4a50;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.merge-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 14px clamp(20px, 4vw, 48px) 0;
  padding: 14px 16px;
  border: 1px solid #f2d9a8;
  border-radius: 10px;
  background: #fffbf1;
}
.merge-banner strong {
  color: #8a6a22;
  font-size: 13px;
}
.merge-banner-copy p {
  margin: 6px 0 0;
  color: #8a6a22;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.merge-banner-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
}
.merge-banner-files code {
  padding: 2px 6px;
  border-radius: 4px;
  background: #f7ecd5;
  color: #7a5c18;
}
.merge-banner-error {
  color: #a94851 !important;
}
.merge-banner-actions {
  display: flex;
  flex: none;
  gap: 8px;
}
.runtime-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px clamp(20px, 4vw, 48px) 0;
  padding: 10px 14px;
  border: 1px solid #e3e9f1;
  border-radius: 10px;
  background: #fbfcfe;
}
.runtime-copy {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  color: #52637e;
  font-size: 11px;
}
.runtime-path {
  overflow: hidden;
  max-width: 42vw;
  color: #7c8ba3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runtime-current strong {
  color: #2c6cad;
}
.runtime-empty,
.runtime-warn {
  color: #93a1b5;
}
.runtime-warn {
  color: #8a6a22;
}
.runtime-actions {
  flex: none;
}
.runtime-error {
  margin: 8px clamp(20px, 4vw, 48px) 0;
  color: #a94851;
  font-size: 11px;
}
.worktrees-warnings {
  display: grid;
  gap: 4px;
  margin: 12px clamp(20px, 4vw, 48px) 0;
  padding: 0;
  list-style: none;
  color: #8a6a22;
  font-size: 11px;
  line-height: 1.6;
}
.scope-summary {
  color: #93a1b5;
  font-size: 10px;
  white-space: nowrap;
}
.scope-toggle {
  padding: 5px 10px;
  border: 1px solid #e3e9f1;
  border-radius: 999px;
  background: #fff;
  color: #6b7c94;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.scope-toggle.active {
  border-color: #bfd7f1;
  background: #eef5fd;
  color: #2c6cad;
  font-weight: 700;
}
.worktrees-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px clamp(20px, 4vw, 48px) 12px;
}
.filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.filter-group button {
  padding: 5px 10px;
  border: 1px solid #e3e9f1;
  border-radius: 999px;
  background: #fff;
  color: #6b7c94;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.filter-group button.active {
  border-color: #bfd7f1;
  background: #eef5fd;
  color: #2c6cad;
  font-weight: 700;
}
.toolbar-count {
  margin-left: auto;
  color: #93a1b5;
  font-size: 11px;
}
.worktrees-body {
  display: flex;
  flex: 1 1 auto;
  /*
   * **给表格一个下限**。标题区 + 筛选条在窄视口能占到 350px 以上；不设下限时 flex 会把
   * `.worktrees-body` 压到 1px（实测 639×427 下就是 20px 的可视区），表格看起来"点了没反应"。
   * 宁可让最底下被裁掉一点，也要保证表格本身能滚、能点。
   */
  min-height: 200px;
  gap: 0;
  border-top: 1px solid #eef1f5;
}
.worktrees-table-wrap {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 0 clamp(12px, 2vw, 24px) 20px;
}
.worktrees-state {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #8c9bb1;
  font-size: 12px;
  text-align: center;
}
.worktrees-state strong {
  color: #33425a;
  font-size: 15px;
}
.worktrees-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}
/*
 * **列宽用固定布局 + 百分比**，而不是让内容撑开：分支名可以很长（`factory/20261008-210238-…`），
 * 一旦按内容撑，表格在 1440 宽、右侧还开着详情时就会横向溢出，把「状态」那一列挤到视野外
 * （实测截图里就是这样）。路径不单列——它在详情面板里，而且在同一个仓库里这一列几乎每行相同。
 */
.worktrees-table .col-status {
  width: 12%;
}
.worktrees-table .col-branch {
  width: 25%;
}
.worktrees-table .col-kind {
  width: 9%;
}
.worktrees-table .col-count {
  width: 6%;
}
.worktrees-table .col-relation {
  width: 11%;
}
.worktrees-table .col-time {
  width: 11%;
}
.worktrees-table .col-source {
  width: 14%;
}
.worktrees-table .col-actions {
  width: 16%;
}
.worktrees-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 8px;
  border-bottom: 1px solid #e3e9f1;
  background: #fff;
  color: #8796ad;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-align: left;
  white-space: nowrap;
}
.worktrees-table td {
  padding: 9px 8px;
  border-bottom: 1px solid #f1f4f8;
  color: #40506a;
  vertical-align: middle;
}
.worktrees-table tbody tr {
  cursor: pointer;
}
.worktrees-table tbody tr:hover {
  background: #f8fafd;
}
.worktrees-table tbody tr.selected {
  background: #eef5fd;
}
.worktrees-table tbody tr.base {
  background: #fbfcfe;
}
/*
 * 分支名可能很长（`factory/20261008-210238-add-task-handoff-status`）。**单行省略**而不是折行：
 * 折行会让一行涨到几百像素高（窄屏实测 677px），整张表失去可读性；完整名字在 title 与详情面板里。
 */
.cell-branch {
  display: block;
  overflow: hidden;
  color: #26364d;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-time,
.cell-relation,
.cell-source {
  overflow: hidden;
  color: #7c8ba3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worktrees-table .num {
  text-align: right;
  white-space: nowrap;
}
.worktrees-table .actions {
  text-align: right;
  white-space: normal;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.row-actions :deep(.el-button) {
  margin-left: 0;
}
.worktrees-truncated {
  margin: 12px 0 0;
  color: #8a6a22;
  font-size: 11px;
}
.worktrees-detail {
  flex: 0 0 min(340px, 34vw);
  min-width: 260px;
  overflow: auto;
  border-left: 1px solid #eef1f5;
  padding: 20px 20px 26px;
  background: #fbfcfe;
}
.detail-head h2 {
  margin: 10px 0 4px;
  color: #1e2b40;
  font-size: 17px;
  overflow-wrap: anywhere;
}
.detail-path {
  margin: 0 0 10px;
  color: #7c8ba3;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.detail-copy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.detail-tag-actions {
  margin-top: 6px;
}
.detail-runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.detail-facts {
  display: grid;
  gap: 6px;
  margin: 16px 0 0;
}
.detail-facts div {
  display: flex;
  gap: 10px;
  font-size: 11px;
  line-height: 1.6;
}
.detail-facts dt {
  flex: 0 0 96px;
  color: #8b99ae;
}
.detail-facts dd {
  margin: 0;
  color: #33425a;
  overflow-wrap: anywhere;
}
.detail-block {
  margin-top: 16px;
}
.detail-block h3 {
  margin: 0 0 7px;
  color: #52637e;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.detail-block ul {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.detail-reasons li {
  padding: 6px 9px;
  border: 1px solid #f0e2c8;
  border-radius: 6px;
  background: #fffbf2;
  color: #8a6a22;
  line-height: 1.55;
}
.preview-loading {
  margin: 0;
  padding: 8px 0 0;
  color: #93a1b5;
  font-size: 11px;
  text-align: center;
}
/*
 * 窄屏分级收列：先去掉信息量最低的「类型」与「合并关系」（详情面板里都有），
 * 再把 Behind 收掉；剩下的列宽按新的百分比重算，避免固定布局下内容挤成一列一个字。
 */
@media (max-width: 1180px) {
  .worktrees-table .col-time {
    display: none;
  }
}
@media (max-width: 1100px) {
  .worktrees-table .col-kind,
  .worktrees-table .col-relation {
    display: none;
  }
  .worktrees-table .col-status {
    width: 15%;
  }
  .worktrees-table .col-branch {
    width: 35%;
  }
  .worktrees-table .col-count {
    width: 7%;
  }
  .worktrees-table .col-source {
    width: 20%;
  }
  .worktrees-table .col-actions {
    width: 16%;
  }
}
@media (max-width: 900px) {
  .worktrees-header {
    padding: 18px 16px 14px;
  }
  .worktrees-header h1 {
    font-size: 21px;
  }
  .scope-summary {
    color: #93a1b5;
    font-size: 10px;
    white-space: nowrap;
  }
  .scope-toggle {
    padding: 5px 10px;
    border: 1px solid #e3e9f1;
    border-radius: 999px;
    background: #fff;
    color: #6b7c94;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .scope-toggle.active {
    border-color: #bfd7f1;
    background: #eef5fd;
    color: #2c6cad;
    font-weight: 700;
  }
  .scope-panel {
    display: grid;
    gap: 8px;
    margin: 0 clamp(20px, 4vw, 48px) 4px;
    padding: 12px 14px;
    border: 1px solid #e3e9f1;
    border-radius: 10px;
    background: #fbfcfe;
  }
  .scope-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    color: #52637e;
    font-size: 11px;
  }
  .scope-row select,
  .scope-patterns textarea {
    margin-left: 6px;
    padding: 4px 6px;
    border: 1px solid #dce4ee;
    border-radius: 6px;
    background: #fff;
    color: #33425a;
    font: inherit;
    font-size: 11px;
  }
  .scope-checkbox {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .scope-patterns {
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: #52637e;
    font-size: 11px;
  }
  .scope-patterns textarea {
    width: 100%;
    margin-left: 0;
    resize: vertical;
  }
  .scope-hint {
    margin: 0;
    color: #93a1b5;
    font-size: 10px;
    line-height: 1.6;
  }
  .scope-error {
    margin: 0;
    color: #a94851;
    font-size: 11px;
  }
  .scope-actions {
    display: flex;
    justify-content: flex-end;
  }
  .worktrees-toolbar {
    gap: 8px;
    padding: 10px 16px;
  }
  .filter-group button {
    padding: 4px 8px;
    font-size: 10px;
  }
  .worktrees-body {
    flex-direction: column;
  }
  .worktrees-detail {
    flex: none;
    border-left: 0;
    border-top: 1px solid #eef1f5;
  }
  .worktrees-table .col-behind {
    display: none;
  }
  .worktrees-table .col-status {
    width: 17%;
  }
  .worktrees-table .col-branch {
    width: 40%;
  }
  .worktrees-table .col-count {
    width: 8%;
  }
  .worktrees-table .col-source {
    width: 18%;
  }
  .worktrees-table .col-actions {
    width: 17%;
  }
}
</style>
