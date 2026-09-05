<!--
  模块职责：提供 Project Execute 的 Plan/Run 工作区。
  维护提示：左侧历史、中央 Plan Inspector 和右侧 Policy/Memory/Evidence 保持固定分区。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowRight, Check, CircleCheck, Clock, Collection, Cpu, Document, FolderOpened, Lock, Refresh, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { Plan, PlanDispatchState, WorkbenchPlan, WorkbenchSnapshot } from "../types";
import { createProjectRequestScope } from "../utils/projectRoutes";
import { statusVisualFor } from "../utils/statusVisual";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const requestScope = createProjectRequestScope();
const snapshot = ref<WorkbenchSnapshot | null>(null);
const selectedPlanId = ref<string | null>(typeof route.query.plan === "string" ? route.query.plan : null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionBusy = ref(false);
const mobilePanel = ref<"history" | "inspector" | "context">("inspector");
let eventSource: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const plans = computed(() => snapshot.value?.plans ?? []);
const selectedPlan = computed<WorkbenchPlan | null>(() => plans.value.find((plan) => plan.planId === selectedPlanId.value) ?? plans.value[0] ?? null);
const selectedRun = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) return null;
  return snapshot.value?.runs.find((run) => run.id === plan.runId) ?? snapshot.value?.runs.find((run) => run.planId === plan.planId) ?? null;
});
const selectedProject = computed(() => {
  return snapshot.value?.projects.find((project) => project.id === projectId.value) ?? null;
});
const selectedDispatch = computed<PlanDispatchState | null>(() => selectedPlan.value?.dispatch ?? null);
const currentStatus = computed(() => statusVisualFor(selectedDispatch.value?.waitReason ?? selectedDispatch.value?.status ?? selectedPlan.value?.status ?? "EMPTY"));
const statusTagType = computed(() => currentStatus.value.tone === "neutral" ? "info" : currentStatus.value.tone);
const activeRunCount = computed(() => selectedProject.value?.summary.activeRunCount ?? snapshot.value?.runs.filter((run) => ["STARTING", "IN_PROGRESS", "VERIFYING"].includes(run.status)).length ?? 0);
const evidence = computed(() => (snapshot.value?.events ?? []).filter((event) => {
  const plan = selectedPlan.value;
  return !plan || event.aggregateId === plan.planId || event.aggregateId === selectedRun.value?.id;
}).slice(-8).reverse());
const pageTitle = "Execute";
const pageKicker = computed(() => "PROJECT · " + (selectedProject.value?.name ?? projectId.value));

function planStatus(plan: Plan | null) {
  return statusVisualFor(plan?.dispatch?.waitReason ?? plan?.dispatch?.status ?? plan?.status ?? "EMPTY");
}

async function load() {
  const scopeKey = projectId.value;
  const token = requestScope.begin(scopeKey);
  loading.value = true;
  error.value = null;
  try {
    const next = await api.workbench(projectId.value);
    if (!requestScope.isCurrent(token, scopeKey)) return;
    snapshot.value = next;
    if (!next.plans.some((plan) => plan.planId === selectedPlanId.value)) selectedPlanId.value = next.plans[0]?.planId ?? null;
  } catch (caught) {
    if (requestScope.isCurrent(token, scopeKey)) {
      error.value = caught instanceof Error ? caught.message : "Execute 加载失败";
      snapshot.value = null;
    }
  } finally {
    if (requestScope.isCurrent(token, scopeKey)) loading.value = false;
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; void load(); }, 80);
}

function connectEvents() {
  closeEvents();
  if (typeof EventSource === "undefined") return;
  const source = new EventSource(api.workbenchEventsUrl(projectId.value, snapshot.value?.cursor ?? 0));
  eventSource = source;
  source.addEventListener("plan.dispatch.state.changed", scheduleRefresh);
  source.addEventListener("stream.ready", () => undefined);
  source.addEventListener("error", () => undefined);
}

function closeEvents() {
  eventSource?.close();
  eventSource = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

function selectPlan(plan: WorkbenchPlan) {
  selectedPlanId.value = plan.planId;
  void router.replace({ query: { ...route.query, plan: plan.planId } });
}

async function enqueuePlan() {
  const plan = selectedPlan.value;
  if (!plan || plan.status !== "READY") return;
  actionBusy.value = true;
  try {
    await api.enqueuePlan(plan.planId);
    await load();
    ElMessage.success("Plan 已进入 Enqueued 阶段");
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "Plan 入队失败"); }
  finally { actionBusy.value = false; }
}

async function startPlanRun() {
  const plan = selectedPlan.value;
  if (!plan || plan.status !== "ENQUEUED") return;
  actionBusy.value = true;
  try {
    const result = await api.startPlanRun(plan.planId);
    await load();
    ElMessage.success(result.dispatch?.waitReason ? `Plan 已派发，正在等待：${result.dispatch.waitReason}` : "Plan 已进入 Dispatched 阶段");
  } catch (caught) { ElMessage.error(caught instanceof Error ? caught.message : "Start run 失败"); }
  finally { actionBusy.value = false; }
}

function openRun() {
  if (selectedRun.value) void router.push("/projects/" + selectedRun.value.projectId + "/runs/" + selectedRun.value.id);
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function eventLabel(type: string) { return type.replaceAll(".", " · ").replaceAll("_", " "); }

watch(projectId, () => {
  requestScope.invalidate();
  closeEvents();
  selectedPlanId.value = typeof route.query.plan === "string" ? route.query.plan : null;
  void load().then(connectEvents);
});
watch(() => route.query.plan, (value) => { if (typeof value === "string") selectedPlanId.value = value; });
onMounted(() => { void load().then(connectEvents); });
onBeforeUnmount(() => { requestScope.invalidate(); closeEvents(); });
</script>

<template>
  <div class="workbench-page">
    <header class="workbench-header">
      <div>
        <div class="eyebrow">{{ pageKicker }}</div>
        <h1>{{ pageTitle }}</h1>
        <p>自动调度、执行状态与证据集中在一个 Project workspace。</p>
      </div>
      <div class="workbench-header-actions">
        <span class="workbench-sync"><i /> Live replay · {{ snapshot?.cursor ?? 0 }}</span>
        <el-button plain @click="load"><Refresh :size="14" /> Refresh</el-button>
      </div>
    </header>

    <div v-if="error" class="workbench-alert danger"><Warning :size="15" /><span>{{ error }}</span><el-button text @click="load">Retry</el-button></div>

    <nav class="workbench-mobile-tabs" aria-label="Workbench panels">
      <button type="button" :class="{ active: mobilePanel === 'history' }" @click="mobilePanel = 'history'">History</button>
      <button type="button" :class="{ active: mobilePanel === 'inspector' }" @click="mobilePanel = 'inspector'">Inspector</button>
      <button type="button" :class="{ active: mobilePanel === 'context' }" @click="mobilePanel = 'context'">Context</button>
    </nav>

    <div class="workbench-layout" v-loading="loading">
      <aside class="workbench-history" :class="{ 'mobile-panel-hidden': mobilePanel !== 'history' }">
        <div class="workbench-panel-heading"><div><span class="eyebrow">HISTORY</span><h2>Project plans</h2></div><span class="history-count">{{ plans.length }}</span></div>
        <div class="history-list">
          <button v-for="plan in plans" :key="plan.planId" type="button" class="history-item" :class="{ selected: selectedPlan?.planId === plan.planId }" @click="selectPlan(plan)">
            <span class="history-icon"><Document :size="14" /></span><span class="history-copy"><strong>{{ plan.title }}</strong><small>{{ plan.planId }}</small><small>{{ relativeTime(plan.lastEventAt) }}</small></span><span class="history-status" :class="'tone-' + planStatus(plan).tone" :title="planStatus(plan).label" />
          </button>
          <div v-if="!loading && plans.length === 0" class="workbench-empty compact"><Collection :size="24" /><strong>No plans yet</strong><span>Confirmed plans will appear here.</span><RouterLink :to="'/projects/' + projectId + '/explorer'">Open Explorer <ArrowRight :size="13" /></RouterLink></div>
        </div>
      </aside>

      <main class="plan-inspector" :class="{ 'mobile-panel-hidden': mobilePanel !== 'inspector' }">
        <div v-if="selectedPlan" class="inspector-content">
          <div class="inspector-topline"><span class="eyebrow">PLAN INSPECTOR · REVISION {{ selectedPlan.revision }}</span><el-tag :type="statusTagType" effect="light">{{ currentStatus.label }}</el-tag></div>
          <div class="inspector-title"><span class="inspector-plan-icon"><Document :size="20" /></span><div><h2>{{ selectedPlan.title }}</h2><code>{{ selectedPlan.planId }}</code></div></div>
          <div class="inspector-summary"><span><Clock :size="14" /> Last event {{ relativeTime(selectedPlan.lastEventAt) }}</span><span><Cpu :size="14" /> Attempt {{ selectedDispatch?.attempt ?? 0 }}</span><span><FolderOpened :size="14" /> {{ selectedProject?.name ?? selectedPlan.projectId }}</span></div>
          <section class="inspector-section"><div class="inspector-section-heading"><span>01</span><strong>Goal & acceptance</strong></div><p class="inspector-goal">{{ selectedPlan.contract.goal }}</p><ul class="inspector-check-list"><li v-for="criterion in selectedPlan.contract.acceptanceCriteria" :key="criterion"><Check :size="13" />{{ criterion }}</li></ul></section>
          <section class="inspector-section"><div class="inspector-section-heading"><span>02</span><strong>Execution tasks</strong><small>{{ selectedPlan.contract.tasks.length }} tasks</small></div><div class="inspector-task-list"><div v-for="(task, index) in selectedPlan.contract.tasks" :key="task.id" class="inspector-task"><span>{{ index + 1 }}</span><div><strong>{{ task.title }}</strong><small>{{ task.status }}<template v-if="task.dependencies.length"> · depends on {{ task.dependencies.join(", ") }}</template></small></div></div></div></section>
          <section class="inspector-section"><div class="inspector-section-heading"><span>03</span><strong>Scope & verification</strong></div><div class="inspector-scope-grid"><div><label>INCLUDE</label><code v-for="item in selectedPlan.contract.include" :key="item">{{ item }}</code></div><div><label>EXCLUDE</label><code v-for="item in selectedPlan.contract.exclude" :key="item">{{ item }}</code><span v-if="selectedPlan.contract.exclude.length === 0" class="scope-empty">None</span></div><div><label>VERIFY</label><code v-for="item in selectedPlan.contract.verificationCommandIds" :key="item">{{ item }}</code></div><div><label>BASE BRANCH</label><code>{{ selectedPlan.contract.baseBranch }}</code></div><div><label>BASE COMMIT</label><code>{{ selectedPlan.contract.baseCommit }}</code></div><div><label>REPAIR LIMIT</label><code>{{ selectedPlan.contract.maxRepairAttempts }}</code></div></div></section>
          <div v-if="selectedDispatch?.lastError" class="workbench-alert warning"><Warning :size="14" /><span>{{ selectedDispatch.lastError }}</span></div>
          <div class="inspector-actions">
            <el-button v-if="selectedPlan.status === 'READY'" type="primary" :loading="actionBusy" @click="enqueuePlan">Enqueue plan <ArrowRight :size="14" /></el-button>
            <el-button v-else-if="selectedPlan.status === 'ENQUEUED'" type="primary" :loading="actionBusy" @click="startPlanRun">Start run <ArrowRight :size="14" /></el-button>
            <el-button v-if="selectedRun" plain @click="openRun">Open Run <ArrowRight :size="14" /></el-button>
            <span v-if="selectedPlan.status === 'DISPATCHED' && !selectedRun" class="action-note"><Clock :size="14" /> {{ currentStatus.label }}</span>
          </div>
        </div>
        <div v-else class="workbench-empty inspector-empty"><Document :size="35" /><strong>Select a Plan</strong><span>选择左侧历史项查看完整 Plan Inspector。</span></div>
      </main>

      <aside class="workbench-context" :class="{ 'mobile-panel-hidden': mobilePanel !== 'context' }">
        <div class="workbench-panel-heading"><div><span class="eyebrow">CONTEXT</span><h2>Evidence</h2></div><CircleCheck :size="17" class="context-ok" /></div>
        <section class="context-block"><div class="context-block-title"><Lock :size="14" /> Policy</div><div v-if="selectedPlan" class="context-facts"><div><span>Executor role</span><code>{{ selectedPlan.contract.executorModelRole }}</code></div><div><span>Tool policy</span><code>{{ selectedPlan.contract.toolPolicy }}</code></div><div><span>Merge</span><code>{{ selectedPlan.contract.mergeStrategy }} · human</code></div></div><div v-else class="context-muted">Select a Plan to inspect policy.</div></section>
        <section class="context-block"><div class="context-block-title"><Collection :size="14" /> Memory</div><div class="memory-card"><strong>{{ selectedProject?.name ?? "Workspace" }}</strong><span>{{ activeRunCount }} active Run{{ activeRunCount === 1 ? "" : "s" }}</span><span>{{ selectedProject?.summary.needsAttentionCount ?? 0 }} attention item{{ (selectedProject?.summary.needsAttentionCount ?? 0) === 1 ? "" : "s" }}</span></div></section>
        <section class="context-block evidence-block"><div class="context-block-title"><CircleCheck :size="14" /> Recent evidence <small>{{ evidence.length }}</small></div><div v-if="evidence.length" class="evidence-list"><div v-for="event in evidence" :key="event.id" class="evidence-item"><span class="evidence-dot" :class="{ success: event.type.includes('completed') || event.type.includes('confirmed') }" /><div><strong>{{ eventLabel(event.type) }}</strong><small>{{ relativeTime(event.occurredAt) }}</small></div></div></div><div v-else class="context-muted">No replayable evidence for this selection.</div></section>
        <div class="context-footer"><span class="live-dot" /> Event cursor {{ snapshot?.cursor ?? 0 }}<RouterLink :to="'/projects/' + projectId + '/settings?tab=commands'">Review policy <ArrowRight :size="13" /></RouterLink></div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.workbench-page { min-height: calc(100vh - 60px); padding: 30px 38px 40px; overflow-x: hidden; background: #f7f9fc; color: #1e2b3d; }
.workbench-mobile-tabs { display: none; }
.workbench-header { display: flex; justify-content: space-between; align-items: flex-end; max-width: 1380px; margin: 0 auto 22px; }
.workbench-header h1 { margin: 6px 0 5px; font-size: 26px; letter-spacing: -.05em; }.workbench-header p { margin: 0; color: #8490a2; font-size: 11px; }.workbench-header-actions { display: flex; align-items: center; gap: 12px; }.workbench-header-actions .el-button { font-size: 11px; }.workbench-sync { display: flex; align-items: center; gap: 6px; color: #72917f; font-size: 10px; }.workbench-sync i { width: 6px; height: 6px; border-radius: 50%; background: #42b77e; box-shadow: 0 0 0 4px #e3f5eb; }
.workbench-alert { display: flex; align-items: center; gap: 8px; max-width: 1380px; margin: 0 auto 12px; padding: 10px 12px; border: 1px solid #e6d9b8; border-radius: 7px; background: #fffaf0; color: #906e28; font-size: 11px; }.workbench-alert.danger { border-color: #f0cdd1; background: #fff6f7; color: #a84d59; }.workbench-alert .el-button { margin-left: auto; padding: 0; font-size: 10px; }
.workbench-layout { display: grid; grid-template-columns: 260px minmax(500px, 1fr) 280px; min-height: calc(100vh - 175px); max-width: 1380px; margin: auto; border: 1px solid #e1e7ef; border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 8px 28px rgba(30, 48, 78, .045); }
.workbench-history { min-width: 0; padding: 18px 12px; border-right: 1px solid #e8edf3; background: #fafbfd; }.workbench-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; padding: 0 7px 14px; border-bottom: 1px solid #e8edf3; }.workbench-panel-heading h2 { margin: 5px 0 0; color: #3b4a61; font-size: 14px; }.history-count { min-width: 22px; padding: 4px 6px; border-radius: 10px; background: #eaf1ff; color: #5277c7; font-size: 9px; text-align: center; }.history-list { display: grid; gap: 5px; padding-top: 12px; }.history-item, .workspace-project { display: flex; align-items: center; width: 100%; gap: 8px; padding: 9px 7px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: #607087; cursor: pointer; text-align: left; }.history-item:hover, .history-item.selected { border-color: #d8e3f8; background: #f1f6ff; }.history-icon { display: grid; place-items: center; width: 25px; height: 25px; flex: 0 0 25px; border-radius: 5px; background: #edf3ff; color: #5b80d9; }.history-copy { min-width: 0; flex: 1; }.history-copy strong, .history-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.history-copy strong { color: #4b5b72; font-size: 10px; }.history-copy small { margin-top: 3px; color: #9ba6b5; font-size: 8px; }.history-status { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: #a8b2c0; }.history-status.tone-info { background: #5684ed; }.history-status.tone-warning { background: #d5a33b; }.history-status.tone-success { background: #3db27d; }.history-status.tone-danger { background: #d65c67; }.workspace-project-list { display: grid; gap: 5px; padding: 12px 0 8px; border-bottom: 1px solid #e8edf3; }.workspace-project { padding: 7px; }.workspace-project > span:nth-child(2) { min-width: 0; flex: 1; }.workspace-project strong, .workspace-project small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.workspace-project strong { color: #52647e; font-size: 10px; }.workspace-project small { margin-top: 3px; color: #9da8b7; font-size: 8px; }.workspace-project-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; background: #edf3ff; color: #5a80dd; }
.plan-inspector { min-width: 0; padding: 25px 35px 30px; overflow: auto; }.inspector-content { max-width: 760px; margin: auto; }.inspector-topline { display: flex; align-items: center; justify-content: space-between; }.inspector-title { display: flex; align-items: center; gap: 12px; margin: 18px 0 10px; }.inspector-plan-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 9px; background: #eaf1ff; color: #4d7ce4; }.inspector-title h2 { margin: 0 0 5px; color: #26354b; font-size: 18px; letter-spacing: -.03em; }.inspector-title code, .inspector-scope-grid code, .context-facts code { color: #7185a7; font: 9px ui-monospace, monospace; }.inspector-summary { display: flex; flex-wrap: wrap; gap: 13px; padding: 11px 0 19px; border-bottom: 1px solid #edf0f4; color: #98a4b4; font-size: 9px; }.inspector-summary span { display: flex; align-items: center; gap: 5px; }.inspector-section { padding: 19px 0; border-bottom: 1px solid #edf0f4; }.inspector-section-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 11px; }.inspector-section-heading > span { color: #85a0dc; font-size: 9px; font-weight: 800; letter-spacing: .1em; }.inspector-section-heading strong { color: #56657b; font-size: 11px; }.inspector-section-heading small { margin-left: auto; color: #a3aebb; font-size: 9px; }.inspector-goal { margin: 0; color: #627188; font-size: 11px; line-height: 1.65; }.inspector-check-list { display: grid; gap: 6px; padding: 0; margin: 12px 0 0; list-style: none; }.inspector-check-list li { display: flex; align-items: flex-start; gap: 6px; color: #7a8798; font-size: 10px; line-height: 1.45; }.inspector-check-list svg { flex: 0 0 auto; margin-top: 1px; color: #38ad7c; }.inspector-task-list { display: grid; gap: 6px; }.inspector-task { display: flex; align-items: center; gap: 9px; padding: 9px; border: 1px solid #edf0f4; border-radius: 6px; }.inspector-task > span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #f0f4fa; color: #7890b1; font-size: 9px; }.inspector-task div { min-width: 0; }.inspector-task strong, .inspector-task small { display: block; }.inspector-task strong { color: #64748a; font-size: 10px; }.inspector-task small { margin-top: 3px; color: #a2adba; font-size: 9px; }.inspector-scope-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }.inspector-scope-grid label, .context-facts span { display: block; margin-bottom: 7px; color: #a3acb9; font-size: 8px; font-weight: 800; letter-spacing: .1em; }.inspector-scope-grid code { display: block; margin-bottom: 5px; padding: 5px 7px; border-radius: 3px; background: #f5f7fb; }.inspector-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 20px; }.inspector-actions .el-button { font-size: 10px; }.action-note { display: flex; align-items: center; gap: 5px; color: #a27b2b; font-size: 10px; }
.workbench-context { min-width: 0; padding: 18px 15px; border-left: 1px solid #e8edf3; background: #fbfcfe; }.context-ok { color: #42ad7c; }.context-block { padding: 19px 4px 0; }.context-block + .context-block { margin-top: 18px; padding-top: 18px; border-top: 1px solid #e8edf3; }.context-block-title { display: flex; align-items: center; gap: 7px; color: #63738a; font-size: 10px; font-weight: 800; }.context-block-title svg { color: #7796dd; }.context-block-title small { margin-left: auto; color: #a6b0bd; font-size: 9px; font-weight: 400; }.context-facts { display: grid; gap: 10px; margin-top: 13px; }.context-facts span { margin-bottom: 4px; letter-spacing: .04em; }.context-facts code { display: block; overflow: hidden; color: #6178a6; text-overflow: ellipsis; white-space: nowrap; }.context-muted { margin-top: 10px; color: #a3aebb; font-size: 9px; line-height: 1.5; }.memory-card { display: grid; gap: 7px; margin-top: 11px; padding: 11px; border: 1px solid #e2e9f2; border-radius: 7px; background: #fff; }.memory-card strong, .memory-card span { display: block; }.memory-card strong { color: #5c6c84; font-size: 10px; }.memory-card span { color: #9ba6b5; font-size: 9px; }.evidence-list { display: grid; gap: 10px; margin-top: 13px; }.evidence-item { display: flex; align-items: flex-start; gap: 7px; }.evidence-dot { width: 6px; height: 6px; flex: 0 0 6px; margin-top: 4px; border-radius: 50%; background: #d5a33b; }.evidence-dot.success { background: #43b27e; }.evidence-item strong, .evidence-item small { display: block; }.evidence-item strong { color: #697991; font-size: 9px; }.evidence-item small { margin-top: 3px; color: #a8b1bd; font-size: 8px; }.context-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 26px 4px 0; padding-top: 13px; border-top: 1px solid #e8edf3; color: #a0abb8; font-size: 9px; }.context-footer a { display: flex; align-items: center; gap: 4px; margin-left: auto; color: #5d7ed2; }.context-footer .live-dot { width: 5px; height: 5px; background: #42b27c; }
.scope-empty { display: block; color: #9ba6b5; font: 9px ui-monospace, monospace; }
@media (max-width: 1120px) { .workbench-page { padding: 25px 20px; }.workbench-layout { grid-template-columns: 230px minmax(0, 1fr); }.workbench-context { display: none; }.plan-inspector { padding-left: 25px; padding-right: 25px; } }
@media (max-width: 720px) { .workbench-page { padding: 20px 12px 28px; }.workbench-header { display: block; margin-bottom: 15px; }.workbench-header h1 { font-size: 23px; }.workbench-header p { max-width: 520px; line-height: 1.5; }.workbench-header-actions { justify-content: space-between; margin-top: 15px; }.workbench-mobile-tabs { display: flex; gap: 5px; margin: 0 0 10px; padding: 4px; border: 1px solid #e1e7ef; border-radius: 8px; background: #fff; }.workbench-mobile-tabs button { flex: 1; min-height: 32px; border: 0; border-radius: 5px; background: transparent; color: #8490a2; cursor: pointer; font-size: 10px; }.workbench-mobile-tabs button.active { background: #edf3ff; color: #4c76d3; font-weight: 700; }.workbench-layout { display: block; min-height: calc(100vh - 220px); overflow: visible; }.workbench-history, .plan-inspector, .workbench-context { display: none; border: 0; }.workbench-history:not(.mobile-panel-hidden), .plan-inspector:not(.mobile-panel-hidden), .workbench-context:not(.mobile-panel-hidden) { display: block; }.workbench-history { min-height: calc(100vh - 220px); padding: 15px 10px; }.plan-inspector { min-height: calc(100vh - 220px); padding: 20px 16px 25px; overflow: visible; }.workbench-context { min-height: calc(100vh - 220px); padding: 15px 16px 25px; }.inspector-scope-grid { grid-template-columns: 1fr; gap: 14px; }.inspector-title h2 { font-size: 16px; }.inspector-actions .el-button { max-width: 100%; } }
</style>
