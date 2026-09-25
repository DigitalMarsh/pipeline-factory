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
const emit = defineEmits<{ (event: "plans-changed"): void; (event: "configuration-revised"): void; (event: "configure-commands", projectId: string): void; (event: "view-plan", plan: Plan): void; (event: "open-run", plan: Plan): void; (event: "count", value: number): void }>();
const candidates = ref<Plan[]>([]);
const tasks = ref<Plan[]>([]);
const search = ref("");
const section = ref<"plans" | "tasks">("plans");
const taskStatus = ref<"all" | "pending" | "running" | "completed" | "attention">("all");
const loading = ref(false);
const error = ref<string | null>(null);
const reconciliationError = ref<string | null>(null);
const missingRunCommands = ref<string[]>([]);
const actionPlanId = ref<string | null>(null);

const filtered = computed(() => {
  const source = section.value === "plans" ? candidates.value : tasks.value;
  return source.filter((plan) => {
    const category = plan.status === "MERGED" ? "completed"
      : ["IN_PROGRESS", "VERIFYING"].includes(plan.status) || ["RUNNING", "VERIFYING"].includes(plan.dispatch?.status ?? "") ? "running"
        : ["MERGE_READY", "BLOCKED", "NEEDS_PLAN_CHANGE"].includes(plan.status) || ["NEEDS_REVIEW", "BLOCKED"].includes(plan.dispatch?.status ?? "") ? "attention"
          : "pending";
    return (section.value === "plans" || taskStatus.value === "all" || category === taskStatus.value) &&
      (!search.value.trim() || `${plan.title} ${plan.planId ?? plan.id ?? ""}`.toLowerCase().includes(search.value.trim().toLowerCase()));
  });
});

function label(statusValue: string): string {
  return ({ DRAFT: "待确认", READY: "待执行", ENQUEUED: "待执行", DISPATCHED: "待执行", QUEUED: "待执行", IN_PROGRESS: "执行中", VERIFYING: "执行中", MERGE_READY: "待处理 · 待审阅", MERGED: "已完成 · 已合并", BLOCKED: "待处理 · 受阻", NEEDS_PLAN_CHANGE: "待处理 · 需要调整" } as Record<string, string>)[statusValue] ?? statusValue;
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
    const [candidateResponse, taskResponse] = await Promise.all([api.candidatePlans(requestedProjectId), api.projectTasks(requestedProjectId)]);
    if (props.projectId !== requestedProjectId) return;
    candidates.value = candidateResponse.items;
    tasks.value = taskResponse.items;
    emit("count", candidateResponse.items.length + taskResponse.items.length);
  } catch (caught) {
    if (props.projectId !== requestedProjectId) return;
    candidates.value = [];
    tasks.value = [];
    emit("count", 0);
    error.value = caught instanceof Error ? caught.message : "计划中心加载失败";
  } finally {
    if (props.projectId === requestedProjectId) loading.value = false;
  }
}

async function confirmCandidate(plan: Plan): Promise<void> {
  const planId = plan.planId ?? plan.id;
  if (!planId || plan.status !== "DRAFT" || actionPlanId.value) return;
  actionPlanId.value = planId;
  try {
    const response = await api.confirmPlan(planId, plan.revision);
    await load();
    emit("plans-changed");
    const detail = `${response.confirmation.stage}${response.dispatch?.lastError ? ` · ${response.dispatch.lastError}` : ""}`;
    if (response.confirmation.retryable && !response.run && response.dispatch?.lastError) ElMessage.warning(`Plan 确认需要重试 · ${detail}`);
    else ElMessage.success(response.confirmation.stage === "RUN_STARTED" ? `已启动 Run ${response.run?.id ?? ""}` : `Plan 已确认 · ${detail}`);
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "Plan 确认失败");
  } finally {
    actionPlanId.value = null;
  }
}

async function retryDispatch(plan: Plan): Promise<void> {
  const planId = plan.planId ?? plan.id;
  if (!planId || !plan.dispatch?.automatic || plan.runId || plan.dispatch.runId || actionPlanId.value) return;
  actionPlanId.value = planId;
  try {
    const response = await api.confirmPlan(planId, plan.revision);
    await load();
    emit("plans-changed");
    ElMessage.success(`派发阶段：${response.confirmation.stage}`);
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "Plan 派发重试失败");
  } finally {
    actionPlanId.value = null;
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
  <section class="plan-center-panel" aria-label="项目 Plan 与任务中心">
    <div class="plan-center-sections" role="tablist" aria-label="项目工作项">
      <button type="button" role="tab" :aria-selected="section === 'plans'" :class="{ active: section === 'plans' }" @click="section = 'plans'">待确认 Plans <span>{{ candidates.length }}</span></button>
      <button type="button" role="tab" :aria-selected="section === 'tasks'" :class="{ active: section === 'tasks' }" @click="section = 'tasks'">任务 <span>{{ tasks.length }}</span></button>
    </div>
    <div class="plan-center-toolbar">
      <label class="plan-center-search"><Search :size="14" /><input v-model="search" aria-label="Search project work items" :placeholder="section === 'plans' ? 'Search pending Plans' : 'Search tasks'" /></label>
      <el-select v-if="section === 'tasks'" v-model="taskStatus" size="small" aria-label="Filter task status">
        <el-option label="全部" value="all" /><el-option label="待执行" value="pending" /><el-option label="执行中" value="running" /><el-option label="已完成" value="completed" /><el-option label="待处理" value="attention" />
      </el-select>
      <span v-else class="plan-center-scope-label">仅待确认</span>
      <el-button text circle aria-label="刷新计划中心" @click="load"><Refresh :size="15" /></el-button>
    </div>
    <div v-if="error" class="plan-center-notice"><Warning :size="14" />{{ error }}</div>
    <div v-if="reconciliationError" class="plan-center-notice"><Warning :size="14" />Merge 状态检测失败，已展示最近保存的状态：{{ reconciliationError }}</div>
    <div v-if="missingRunCommands.length" class="plan-center-notice"><Warning :size="14" />缺少验证命令：{{ missingRunCommands.join(", ") }}</div>
    <div v-loading="loading" class="plan-center-list">
      <article v-for="plan in filtered" :key="plan.planId ?? plan.id ?? plan.title" class="plan-center-card">
        <div class="plan-center-card-head"><span class="mini-icon"><Document :size="15" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Rev {{ plan.revision }}</small></div><el-tag size="small" :type="tagType(plan)" effect="light">{{ label(plan.status) }}</el-tag></div>
        <div class="plan-center-card-meta"><span>Source</span><RouterLink :to="sourceThreadPath(plan)" :aria-label="`Open source Explorer thread ${plan.sourceExplorerThreadId}`">{{ plan.sourceExplorerThreadId }} <ArrowRight :size="12" /></RouterLink></div>
        <div class="plan-center-card-meta"><span>{{ section === 'plans' ? '确认阶段' : 'Run' }}</span><button v-if="plan.runId" type="button" class="plan-center-run-link" @click="emit('open-run', plan)">{{ plan.runId }} <ArrowRight :size="12" /></button><span v-else-if="section === 'plans'">{{ plan.dispatch?.phase ?? "等待确认" }}{{ plan.dispatch?.attempt ? ` · 第 ${plan.dispatch.attempt} 次` : "" }}</span><span v-else>{{ plan.dispatch?.waitReason === "NEEDS_CONFIGURATION" ? "Needs configuration" : plan.dispatch?.waitReason ?? plan.dispatch?.phase ?? "—" }}</span></div>
        <div v-if="plan.dispatch?.lastError" class="plan-center-notice"><Warning :size="13" />{{ plan.dispatch.lastError }}</div>
        <div v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" class="plan-center-notice"><Warning :size="13" />Missing verification commands: {{ configurationBlockedCommands(plan).join(', ') }}</div>
        <div v-if="plan.mergeRequest?.status === 'OPEN' && plan.mergeRequest.detectedTargetCommit" class="plan-center-notice merge-detected-notice"><CircleCheck :size="13" />Merge detected · 已检测到外部合并，等待人工确认：{{ plan.mergeRequest.detectedTargetCommit }}</div>
        <div v-if="plan.attentionReason" class="plan-center-attention"><Warning :size="13" />{{ plan.attentionReason }}</div>
        <footer><span><Clock :size="12" />{{ formatTime(plan.lastEventAt) }}</span><div class="plan-center-actions"><el-button size="small" plain @click="emit('view-plan', plan)">View full plan</el-button><el-button v-if="section === 'plans'" size="small" type="primary" :loading="actionPlanId === (plan.planId ?? plan.id)" @click="confirmCandidate(plan)">{{ plan.dispatch?.phase === 'VALIDATION_FAILED' ? 'Retry confirmation' : 'Confirm and start' }} <ArrowRight :size="13" /></el-button><template v-else><el-button v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION'" size="small" plain @click="emit('configure-commands', plan.projectId)">Configure verification commands</el-button><el-button v-if="plan.dispatch?.waitReason === 'NEEDS_CONFIGURATION' && canCreateConfigurationRevision(plan)" size="small" type="primary" :loading="actionPlanId === (plan.planId ?? plan.id)" @click="reviseConfiguration(plan)">Create updated revision</el-button><el-button v-if="plan.dispatch?.automatic && !plan.runId && !plan.dispatch.runId && ['VALIDATION_FAILED', 'ENQUEUE_FAILED', 'DISPATCH_FAILED', 'RUN_START_FAILED', 'WAITING'].includes(plan.dispatch.phase ?? '')" size="small" type="primary" plain :loading="actionPlanId === (plan.planId ?? plan.id)" @click="retryDispatch(plan)">Retry dispatch</el-button><el-button v-else-if="plan.status === 'ENQUEUED'" size="small" type="primary" :loading="actionPlanId === (plan.planId ?? plan.id)" @click="startRun(plan)">Start run <ArrowRight :size="13" /></el-button><el-button v-else-if="canTerminate(plan)" size="small" type="danger" plain :loading="actionPlanId === plan.runId" @click="terminateRun(plan)">Terminate</el-button></template></div></footer>
      </article>
      <div v-if="!loading && filtered.length === 0" class="context-empty"><CircleCheck :size="24" /><p>{{ section === 'plans' ? '没有待确认 Plan' : '没有匹配的任务' }}</p><small>{{ section === 'plans' ? '完整方案生成后会出现在这里。' : '已确认 Plan 按执行与人工合并状态归类。' }}</small></div>
    </div>
  </section>
</template>

<style scoped>
.plan-center-panel { display: grid; gap: 12px; min-width: 0; }.plan-center-sections { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 3px; border: 1px solid #2d4260; border-radius: 8px; background: #101d31; }.plan-center-sections button { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 31px; border: 0; border-radius: 6px; background: transparent; color: #8fa5c3; font-size: 10px; cursor: pointer; }.plan-center-sections button.active { background: #213b5d; color: #e9f4ff; }.plan-center-sections span { padding: 1px 5px; border-radius: 10px; background: #13223a; font-size: 9px; }.plan-center-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 100px auto; gap: 7px; align-items: center; }.plan-center-search { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 8px; border: 1px solid #334764; border-radius: 6px; background: #13223a; color: #8fa5c3; }.plan-center-search input { width: 100%; min-width: 0; height: 29px; border: 0; outline: 0; background: transparent; color: #e8f1ff; font-size: 11px; }.plan-center-search input::placeholder { color: #7185a3; }.plan-center-toolbar :deep(.el-select__wrapper) { min-height: 30px; border: 1px solid #334764; background: #13223a; box-shadow: none; }.plan-center-toolbar :deep(.el-select__selected-item), .plan-center-toolbar :deep(.el-select__placeholder) { color: #bdd0ea; font-size: 10px; }.plan-center-toolbar :deep(.el-button) { color: #9fc8ff; }.plan-center-scope-label { color: #8fa5c3; font-size: 10px; text-align: center; }.plan-center-notice { display: flex; align-items: flex-start; gap: 6px; padding: 8px; border: 1px solid #765d38; border-radius: 6px; background: #2d2730; color: #f0cf8e; font-size: 10px; line-height: 1.45; }.plan-center-notice.merge-detected-notice { border-color: #3c6e55; background: #1d3a32; color: #b8eccd; }.plan-center-list { display: grid; gap: 8px; min-height: 110px; }.plan-center-card { display: grid; gap: 8px; padding: 10px; border: 1px solid #2d4260; border-radius: 8px; background: #14233a; }.plan-center-card-head { display: grid; grid-template-columns: 27px minmax(0, 1fr) auto; gap: 7px; align-items: center; }.plan-center-card-head .mini-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 6px; background: #234970; color: #9bd6ff; }.plan-center-card-head div { min-width: 0; }.plan-center-card-head strong, .plan-center-card-head small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.plan-center-card-head strong { color: #eff6ff; font-size: 12px; }.plan-center-card-head small { margin-top: 3px; color: #90a6c4; font: 9px ui-monospace, monospace; }.plan-center-card-meta { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; color: #a5b8d0; font-size: 10px; }.plan-center-card-meta > span:first-child { color: #7188a8; }.plan-center-card-meta code, .plan-center-card-meta a, .plan-center-card-meta > span:last-child { overflow: hidden; color: #b9dfff; text-overflow: ellipsis; white-space: nowrap; }.plan-center-card-meta a { display: inline-flex; align-items: center; gap: 2px; }.plan-center-attention { display: flex; gap: 5px; color: #f0b3b7; font-size: 10px; line-height: 1.4; }.plan-center-card footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid #293c58; color: #8ea4c0; font-size: 9px; }.plan-center-card footer > span { display: inline-flex; align-items: center; gap: 4px; }.plan-center-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }.plan-center-card footer :deep(.el-button) { font-size: 10px; }
.plan-center-run-link { display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: transparent; color: #b9dfff; cursor: pointer; font: inherit; text-align: left; }
.plan-center-run-link:hover, .plan-center-run-link:focus-visible { color: #fff; outline: 0; }
</style>
