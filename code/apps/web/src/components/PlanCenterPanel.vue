<!-- Compact, project-wide Plan Center for the Explorer context rail. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowRight, CircleCheck, Clock, Document, Refresh, Search, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import type { Plan, Project } from "../types";
import { canTerminateRun } from "../utils/runControls";
import { parseMissingRunCommands } from "../utils/runPrerequisites";

const props = defineProps<{ projectId: string; project: Project | null }>();
const emit = defineEmits<{ (event: "plans-changed"): void; (event: "configuration-revised"): void; (event: "configure-commands", projectId: string): void; (event: "view-plan", plan: Plan): void; (event: "count", value: number): void }>();
const plans = ref<Plan[]>([]);
const search = ref("");
const status = ref("all");
const loading = ref(false);
const error = ref<string | null>(null);
const reconciliationError = ref<string | null>(null);
const missingRunCommands = ref<string[]>([]);
const actionPlanId = ref<string | null>(null);

const filtered = computed(() => plans.value.filter((plan) =>
  (status.value === "all" || plan.status === status.value) &&
  (!search.value.trim() || `${plan.title} ${plan.planId ?? plan.id ?? ""}`.toLowerCase().includes(search.value.trim().toLowerCase())),
));

function label(statusValue: string): string {
  return ({ READY: "Confirmed", ENQUEUED: "Enqueued", DISPATCHED: "Dispatched", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Review", MERGED: "Merged", BLOCKED: "Blocked", NEEDS_PLAN_CHANGE: "Plan change required" } as Record<string, string>)[statusValue] ?? statusValue;
}

function tagType(plan: Plan): "success" | "warning" | "danger" | "primary" | "info" {
  if (plan.status === "MERGED") return "success";
  if (plan.status === "BLOCKED" || plan.status === "NEEDS_PLAN_CHANGE") return "danger";
  if (plan.status === "IN_PROGRESS" || plan.status === "VERIFYING") return "primary";
  return "warning";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sourceThreadPath(plan: Plan): string {
  return `/projects/${encodeURIComponent(plan.projectId)}/explorer?explorerId=${encodeURIComponent(plan.sourceExplorerThreadId)}&contextPanel=plan-center`;
}

function canTerminate(plan: Plan): boolean {
  return Boolean(plan.runId) && canTerminateRun(plan.status);
}

function configurationBlockedCommands(plan: Plan): string[] {
  if (plan.dispatch?.waitReason !== "NEEDS_CONFIGURATION") return [];
  return parseMissingRunCommands(plan.dispatch.lastError ?? "");
}

function canCreateConfigurationRevision(plan: Plan): boolean {
  const missingCommands = configurationBlockedCommands(plan);
  if (!missingCommands.length || !props.project) return false;
  const registered = new Set(props.project.settings.commands.map((command) => command.commandId));
  return missingCommands.every((commandId) => registered.has(commandId));
}

async function load(): Promise<void> {
  const requestedProjectId = props.projectId;
  if (!requestedProjectId) return;
  loading.value = true;
  error.value = null;
  reconciliationError.value = null;
  try {
    try {
      const report = await api.reconcileProjectMerges(requestedProjectId);
      const diagnostics = report.items.filter((item) => item.reason).map((item) => `${item.runId}: ${item.reason}`);
      if (diagnostics.length) reconciliationError.value = diagnostics.join("；");
    }
    catch (caught) { reconciliationError.value = caught instanceof Error ? caught.message : "Merge 状态检测暂不可用"; }
    const response = await api.plans(requestedProjectId);
    if (props.projectId !== requestedProjectId) return;
    plans.value = response.items;
    emit("count", response.items.length);
  } catch (caught) {
    if (props.projectId !== requestedProjectId) return;
    plans.value = [];
    emit("count", 0);
    error.value = caught instanceof Error ? caught.message : "Plan Center 加载失败";
  } finally {
    if (props.projectId === requestedProjectId) loading.value = false;
  }
}

async function startRun(plan: Plan): Promise<void> {
  const planId = plan.planId ?? plan.id;
  if (!planId || plan.status !== "ENQUEUED" || actionPlanId.value) return;
  actionPlanId.value = planId;
  missingRunCommands.value = [];
  try {
    const response = await (plan.revision > 1 ? api.startPlanRevisionRun(planId, plan.revision) : api.startPlanRun(planId));
    await load();
    emit("plans-changed");
    ElMessage.success(response.dispatch?.waitReason ? `Plan 已派发，正在等待：${response.dispatch.waitReason}` : "Plan 已派发到调度器");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Start run 失败";
    const missing = parseMissingRunCommands(message);
    if (missing.length) missingRunCommands.value = missing;
    else ElMessage.error(message);
  } finally {
    actionPlanId.value = null;
  }
}

async function terminateRun(plan: Plan): Promise<void> {
  if (!plan.runId || actionPlanId.value) return;
  try {
    await ElMessageBox.confirm(`Terminate run for “${plan.title}”?`, "Terminate run", { confirmButtonText: "Terminate", cancelButtonText: "Keep running", type: "warning" });
  } catch { return; }
  actionPlanId.value = plan.runId;
  try {
    await api.cancelRun(plan.runId, "user_requested");
    await load();
    emit("plans-changed");
    ElMessage.success("Run 已终止");
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "Run 终止失败");
  } finally {
    actionPlanId.value = null;
  }
}

async function reviseConfiguration(plan: Plan): Promise<void> {
  const planId = plan.planId ?? plan.id;
  if (!planId || plan.status !== "DISPATCHED" || plan.runId || plan.dispatch?.status !== "WAITING" || plan.dispatch.waitReason !== "NEEDS_CONFIGURATION" || !canCreateConfigurationRevision(plan) || actionPlanId.value) return;
  actionPlanId.value = planId;
  try {
    await api.revisePlanConfiguration(planId);
    await load();
    emit("plans-changed");
    emit("configuration-revised");
    ElMessage.success("已基于当前配置创建新 Revision，请重新 Enqueue 并 Start run");
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "Create updated revision 失败");
  } finally {
    actionPlanId.value = null;
  }
}

watch(() => props.projectId, () => { void load(); });
watch(() => props.project?.configVersion, () => { void load(); });
onMounted(() => { void load(); });
</script>

<template>
  <section class="plan-center-panel" aria-label="Plan Center">
    <div class="plan-center-toolbar">
      <label class="plan-center-search"><Search :size="14" /><input v-model="search" aria-label="Search project plans" placeholder="Search plans" /></label>
      <el-select v-model="status" size="small" aria-label="Filter plan status">
        <el-option label="All" value="all" />
        <el-option label="Confirmed" value="READY" />
        <el-option label="Enqueued" value="ENQUEUED" />
        <el-option label="Dispatched" value="DISPATCHED" />
        <el-option label="Running" value="IN_PROGRESS" />
        <el-option label="Review" value="MERGE_READY" />
        <el-option label="Merged" value="MERGED" />
        <el-option label="Blocked" value="BLOCKED" />
      </el-select>
      <el-button text circle aria-label="Refresh Plan Center" @click="load"><Refresh :size="15" /></el-button>
    </div>
    <div v-if="error" class="plan-center-notice"><Warning :size="14" />{{ error }}</div>
    <div v-if="reconciliationError" class="plan-center-notice"><Warning :size="14" />Merge 状态检测失败，已展示最近保存的状态：{{ reconciliationError }}</div>
    <div v-if="missingRunCommands.length" class="plan-center-notice"><Warning :size="14" />缺少验证命令：{{ missingRunCommands.join(", ") }}</div>
    <div v-loading="loading" class="plan-center-list">
      <article v-for="plan in filtered" :key="plan.planId ?? plan.id ?? plan.title" class="plan-center-card">
        <div class="plan-center-card-head"><span class="mini-icon"><Document :size="15" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Rev {{ plan.revision }}</small></div><el-tag size="small" :type="tagType(plan)" effect="light">{{ label(plan.status) }}</el-tag></div>
        <div class="plan-center-card-meta"><span>Source</span><RouterLink :to="sourceThreadPath(plan)" :aria-label="`Open source Explorer thread ${plan.sourceExplorerThreadId}`">{{ plan.sourceExplorerThreadId }} <ArrowRight :size="12" /></RouterLink></div>
        <div class="plan-center-card-meta"><span>Run</span><RouterLink v-if="plan.runId" :to="`/projects/${projectId}/runs/${plan.runId}`">{{ plan.runId }} <ArrowRight :size="12" /></RouterLink><span v-else>{{ plan.status === "ENQUEUED" ? "Ready to start" : plan.dispatch?.waitReason === "NEEDS_CONFIGURATION" ? "Needs configuration" : plan.dispatch?.waitReason ?? "—" }}</span></div>
        <div v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" class="plan-center-notice"><Warning :size="13" />Missing verification commands: {{ configurationBlockedCommands(plan).join(', ') }}</div>
        <div v-if="plan.mergeRequest?.status === 'OPEN' && plan.mergeRequest.detectedTargetCommit" class="plan-center-notice merge-detected-notice"><CircleCheck :size="13" />Merge detected · 已检测到外部合并，等待人工确认：{{ plan.mergeRequest.detectedTargetCommit }}</div>
        <div v-if="plan.attentionReason" class="plan-center-attention"><Warning :size="13" />{{ plan.attentionReason }}</div>
        <footer><span><Clock :size="12" />{{ formatTime(plan.lastEventAt) }}</span><div class="plan-center-actions"><el-button size="small" plain @click="emit('view-plan', plan)">View full plan</el-button><template v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'"><el-button size="small" plain @click="emit('configure-commands', plan.projectId)">Configure verification commands</el-button><el-button v-if="canCreateConfigurationRevision(plan)" size="small" type="primary" :loading="actionPlanId === (plan.planId ?? plan.id)" @click="reviseConfiguration(plan)">Create updated revision</el-button></template><el-button v-else-if="plan.status === 'ENQUEUED'" size="small" type="primary" :loading="actionPlanId === (plan.planId ?? plan.id)" @click="startRun(plan)">Start run <ArrowRight :size="13" /></el-button><el-button v-else-if="canTerminate(plan)" size="small" type="danger" plain :loading="actionPlanId === plan.runId" @click="terminateRun(plan)">Terminate</el-button></div></footer>
      </article>
      <div v-if="!loading && filtered.length === 0" class="context-empty"><CircleCheck :size="24" /><p>No project plans</p><small>Enqueued and later plans across this Project appear here.</small></div>
    </div>
  </section>
</template>

<style scoped>
.plan-center-panel { display: grid; gap: 12px; min-width: 0; }.plan-center-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 100px auto; gap: 7px; align-items: center; }.plan-center-search { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 8px; border: 1px solid #334764; border-radius: 6px; background: #13223a; color: #8fa5c3; }.plan-center-search input { width: 100%; min-width: 0; height: 29px; border: 0; outline: 0; background: transparent; color: #e8f1ff; font-size: 11px; }.plan-center-search input::placeholder { color: #7185a3; }.plan-center-toolbar :deep(.el-select__wrapper) { min-height: 30px; border: 1px solid #334764; background: #13223a; box-shadow: none; }.plan-center-toolbar :deep(.el-select__selected-item), .plan-center-toolbar :deep(.el-select__placeholder) { color: #bdd0ea; font-size: 10px; }.plan-center-toolbar :deep(.el-button) { color: #9fc8ff; }.plan-center-notice { display: flex; align-items: flex-start; gap: 6px; padding: 8px; border: 1px solid #765d38; border-radius: 6px; background: #2d2730; color: #f0cf8e; font-size: 10px; line-height: 1.45; }.plan-center-notice.merge-detected-notice { border-color: #3c6e55; background: #1d3a32; color: #b8eccd; }.plan-center-list { display: grid; gap: 8px; min-height: 110px; }.plan-center-card { display: grid; gap: 8px; padding: 10px; border: 1px solid #2d4260; border-radius: 8px; background: #14233a; }.plan-center-card-head { display: grid; grid-template-columns: 27px minmax(0, 1fr) auto; gap: 7px; align-items: center; }.plan-center-card-head .mini-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 6px; background: #234970; color: #9bd6ff; }.plan-center-card-head div { min-width: 0; }.plan-center-card-head strong, .plan-center-card-head small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.plan-center-card-head strong { color: #eff6ff; font-size: 12px; }.plan-center-card-head small { margin-top: 3px; color: #90a6c4; font: 9px ui-monospace, monospace; }.plan-center-card-meta { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; color: #a5b8d0; font-size: 10px; }.plan-center-card-meta > span:first-child { color: #7188a8; }.plan-center-card-meta code, .plan-center-card-meta a, .plan-center-card-meta > span:last-child { overflow: hidden; color: #b9dfff; text-overflow: ellipsis; white-space: nowrap; }.plan-center-card-meta a { display: inline-flex; align-items: center; gap: 2px; }.plan-center-attention { display: flex; gap: 5px; color: #f0b3b7; font-size: 10px; line-height: 1.4; }.plan-center-card footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid #293c58; color: #8ea4c0; font-size: 9px; }.plan-center-card footer > span { display: inline-flex; align-items: center; gap: 4px; }.plan-center-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }.plan-center-card footer :deep(.el-button) { font-size: 10px; }
</style>
