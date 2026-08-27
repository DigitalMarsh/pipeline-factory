<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowRight, CircleCheck, Clock, Document, Search, Warning } from "@element-plus/icons-vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { Plan } from "../types";
import { planStatusForStat } from "../utils/planFilters";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? "project-demo"));
const plans = ref<Plan[]>([]);
const search = ref("");
const status = ref("all");
const loading = ref(true);
const error = ref<string | null>(null);
const statItems = [
  { key: "all", label: "All", icon: Document },
  { key: "queued", label: "Queued", icon: Clock },
  { key: "running", label: "Running", icon: ArrowRight },
  { key: "verifying", label: "Verifying", icon: CircleCheck },
  { key: "review", label: "Review", icon: Document },
  { key: "merged", label: "Merged", icon: CircleCheck },
  { key: "blocked", label: "Blocked", icon: Warning },
] as const;
const filtered = computed(() => plans.value.filter((plan) =>
  (status.value === "all" || plan.status === status.value) &&
  (!search.value || plan.title.toLowerCase().includes(search.value.toLowerCase()) || (plan.planId ?? plan.id ?? "").includes(search.value)),
));
const counts = computed(() => ({
  all: plans.value.length,
  queued: plans.value.filter((p) => p.status === "QUEUED").length,
  running: plans.value.filter((p) => p.status === "IN_PROGRESS").length,
  verifying: plans.value.filter((p) => p.status === "VERIFYING").length,
  review: plans.value.filter((p) => p.status === "MERGE_READY").length,
  merged: plans.value.filter((p) => p.status === "MERGED").length,
  blocked: plans.value.filter((p) => p.status === "BLOCKED").length,
}));

async function load() {
  loading.value = true;
  error.value = null;
  try { plans.value = (await api.plans(projectId.value)).items; }
  catch { plans.value = []; error.value = "API 未连接，暂无已下发计划"; }
  finally { loading.value = false; }
}

async function refreshPlanCenter() {
  await load();
  if (!error.value) ElMessage.success("Plan Center 已刷新");
}

function label(s: string) {
  return ({ QUEUED: "Queued", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Review", MERGED: "Merged", BLOCKED: "Blocked" } as Record<string, string>)[s] ?? s;
}

async function startRun(plan: Plan) {
  const planId = plan.planId ?? plan.id;
  if (!planId) return;
  try {
    const response = await api.startRun(planId);
    await router.push(`/projects/${projectId.value}/runs/${response.run.id}`);
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "Run 启动失败");
  }
}

const allowedQueryStatuses = new Set(["all", "QUEUED", "IN_PROGRESS", "VERIFYING", "MERGE_READY", "MERGED", "BLOCKED"]);
function syncQueryStatus(value: unknown) {
  const queryStatus = typeof value === "string" && allowedQueryStatuses.has(value) ? value : "all";
  status.value = queryStatus;
}

onMounted(() => { syncQueryStatus(route.query.status); void load(); });
</script>

<template>
  <div class="plan-center">
    <div class="page-title-row">
      <div><div class="eyebrow">PROJECT · PROJECT-DEMO</div><h1>Plan Center</h1><p>Every plan dispatched from the ExplorerThread lineage, with registry-backed status.</p></div>
      <el-button plain @click="refreshPlanCenter"><CircleCheck :size="15" /> Registry synced</el-button>
    </div>
    <div class="stat-grid">
      <button v-for="item in statItems" :key="item.key" class="stat-card" :class="{ selected: status === planStatusForStat(item.key) }" @click="status = planStatusForStat(item.key)">
        <component :is="item.icon" :size="16" /><span>{{ item.label }}</span><strong>{{ counts[item.key as keyof typeof counts] }}</strong>
      </button>
    </div>
    <div class="table-toolbar">
      <div class="table-search"><Search :size="16" /><input v-model="search" placeholder="Search plan title or ID" /></div>
      <el-select v-model="status" placeholder="Status" size="large" style="width: 170px"><el-option label="All statuses" value="all" /><el-option label="Queued" value="QUEUED" /><el-option label="Running" value="IN_PROGRESS" /><el-option label="Verifying" value="VERIFYING" /><el-option label="Review" value="MERGE_READY" /><el-option label="Merged" value="MERGED" /><el-option label="Blocked" value="BLOCKED" /></el-select>
      <el-button text @click="refreshPlanCenter">Refresh</el-button>
    </div>
    <div v-if="error" class="demo-notice"><Warning :size="14" /> {{ error }}</div>
    <div class="plans-table" v-loading="loading">
      <div class="table-head"><span>PLAN</span><span>STATUS</span><span>SOURCE THREAD</span><span>RUN</span><span>LAST EVENT</span><span /></div>
      <RouterLink v-for="plan in filtered" :key="plan.planId ?? plan.id ?? plan.title" :to="plan.runId ? `/projects/${projectId}/runs/${plan.runId}` : `/projects/${projectId}/explorer`" class="table-row">
        <div class="table-plan"><span class="mini-icon"><Document :size="15" /></span><div><strong>{{ plan.title }}</strong><small>{{ plan.planId ?? plan.id }} · Revision {{ plan.revision }}</small></div></div>
        <div><el-tag :type="plan.status === 'MERGED' ? 'success' : plan.status === 'BLOCKED' ? 'danger' : 'warning'" effect="light">{{ label(plan.status) }}</el-tag></div>
        <code>{{ plan.sourceExplorerThreadId }}</code><code>{{ plan.runId ?? "—" }}</code>
        <span class="event-time">{{ new Date(plan.lastEventAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span><el-button v-if="plan.status === 'QUEUED'" size="small" type="primary" @click.prevent.stop="startRun(plan)">Start run</el-button><ArrowRight v-else :size="16" class="row-arrow" />
      </RouterLink>
      <div v-if="!loading && filtered.length === 0" class="empty-state"><Document :size="32" /><h3>No dispatched plans</h3><p>Plans appear here after they are confirmed and enqueued from an ExplorerThread.</p><RouterLink :to="`/projects/${projectId}/explorer`">Open ExplorerThread <ArrowRight :size="14" /></RouterLink></div>
    </div>
  </div>
</template>
