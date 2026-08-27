<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ArrowDown, Check, CircleCheck, InfoFilled, MoreFilled, Promotion, Refresh, Right, VideoPause, VideoPlay } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { ExplorerThread, ExplorerTurn, Plan } from "../types";
import PlanDetailDrawer from "../components/PlanDetailDrawer.vue";
import ExplorerPolicyDrawer from "../components/ExplorerPolicyDrawer.vue";
import ThreadRail from "../components/ThreadRail.vue";
import { scrollTimelineToLatest } from "../utils/scrollTimeline";
import { optional } from "../utils/optional";
import { closePolicyPanel, openPolicyPanel } from "../utils/policyPanel";

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId ?? "project-demo"));
const thread = ref<ExplorerThread | null>(null);
const candidate = ref<Plan | null>(null);
const dispatched = ref<Plan[]>([]);
const turns = ref<ExplorerTurn[]>([]);
const draft = ref("");
const drawerOpen = ref(false);
const policyOpen = ref(false);
const moreOpen = ref(false);
const explorerPaused = ref(false);
const memoryPanel = ref<"summary" | "successors" | null>(null);
const candidateEmptyOpen = ref(false);
const candidateTitle = ref("New Explorer plan");
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref(false);
const timeline = ref<HTMLElement | null>(null);

const fallbackThread: ExplorerThread = { id: "thread-demo", projectId: "project-demo", parentThreadId: null, state: "ACTIVE", messageCount: 8, summaryRef: null, lastActivityAt: new Date().toISOString() };
const fallbackPlan: Plan = { id: "plan-demo-1", title: "Build ExplorerThread workspace", revision: 1, status: "DRAFT", projectId: "project-demo", sourceExplorerThreadId: "thread-demo", queuedAt: null, runId: null, lastEventAt: new Date().toISOString(), attentionReason: null };
const candidateCount = computed(() => candidate.value ? 1 : 0);
const dispatchedCount = computed(() => dispatched.value.length);
const activeRunCount = computed(() => dispatched.value.filter((plan) => plan.status === "IN_PROGRESS" || plan.status === "VERIFYING").length);
const needsAttentionCount = computed(() => dispatched.value.filter((plan) => plan.status === "BLOCKED" || Boolean(plan.attentionReason)).length);

function setPolicyOpen(value: boolean) {
  policyOpen.value = value ? openPolicyPanel(policyOpen.value) : closePolicyPanel(policyOpen.value);
}

function toggleExplorerPause() {
  explorerPaused.value = !explorerPaused.value;
  ElMessage.info(explorerPaused.value ? "ExplorerThread 已暂停" : "ExplorerThread 已恢复");
}

async function refreshThread() {
  await load();
  if (!error.value) ElMessage.success("ExplorerThread 已刷新");
}

function turnContent(turn: ExplorerTurn): string {
  if (turn.content.trim()) return turn.content;
  return turn.status === "FAILED" ? `模型调用失败：${turn.error ?? "未知错误"}` : "模型未返回内容";
}

function syncHashPanel(hash: string) {
  if (hash === "#candidate" && candidate.value) drawerOpen.value = true;
  if (hash === "#candidate" && !candidate.value) candidateEmptyOpen.value = true;
  if (hash === "#summary") memoryPanel.value = "summary";
  if (hash === "#successors") memoryPanel.value = "successors";
}

async function closeCandidateEmpty() {
  candidateEmptyOpen.value = false;
  if (route.hash === "#candidate") await router.replace({ hash: "" });
}

function setCandidateEmptyOpen(open: boolean) {
  if (!open) void closeCandidateEmpty();
}

async function createCandidate() {
  const title = candidateTitle.value.trim();
  if (!title || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    candidate.value = (await api.createCandidate(projectId.value, title)).plan;
    await closeCandidateEmpty();
    drawerOpen.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? `候选计划创建失败：${caught.message}` : "候选计划创建失败";
  } finally {
    busy.value = false;
  }
}

async function closeMemoryPanel() {
  memoryPanel.value = null;
  if (route.hash) await router.replace({ hash: "" });
}

function setMemoryPanelOpen(open: boolean) {
  if (!open) void closeMemoryPanel();
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [threadResponse, plansResponse, turnsResponse, candidateResponse] = await Promise.all([
      api.thread(projectId.value),
      api.plans(projectId.value),
      api.turns(projectId.value),
      optional(() => api.candidate(projectId.value)),
    ]);
    thread.value = threadResponse.thread;
    candidate.value = candidateResponse?.plan ?? null;
    dispatched.value = plansResponse.items;
    turns.value = turnsResponse.items;
  } catch (caught) {
    thread.value = fallbackThread;
    candidate.value = fallbackPlan;
    dispatched.value = [];
    turns.value = [];
    error.value = caught instanceof Error ? "API 未连接，当前显示本地演示数据" : "API 未连接，当前显示本地演示数据";
  } finally {
    loading.value = false;
  }
}

async function sendTurn() {
  const content = draft.value.trim();
  if (!content || busy.value) return;
  busy.value = true;
  try {
    const response = await api.sendTurn(projectId.value, content);
    turns.value = [...turns.value, response.turn.user, response.turn.assistant];
    if (thread.value) thread.value = { ...thread.value, messageCount: thread.value.messageCount + 2, lastActivityAt: response.turn.assistant.createdAt };
  } catch {
    const now = new Date().toISOString();
    turns.value = [...turns.value, { id: `local-${Date.now()}`, threadId: thread.value?.id ?? "thread-demo", role: "user", content, createdAt: now, sequence: turns.value.length + 1 }, { id: `local-assistant-${Date.now()}`, threadId: thread.value?.id ?? "thread-demo", role: "assistant", content: "本地演示模式：API 未连接，消息未提交到服务端。", createdAt: now, sequence: turns.value.length + 2 }];
  } finally {
    draft.value = "";
    busy.value = false;
    await nextTick();
    if (timeline.value) scrollTimelineToLatest(timeline.value);
  }
}

async function confirmPlan() {
  if (!candidate.value || !candidate.value.id && !candidate.value.planId || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId!;
  busy.value = true;
  try { candidate.value = (await api.confirm(id)).plan; } catch (caught) { error.value = caught instanceof Error ? `Confirm plan 失败：${caught.message}` : "Confirm plan 失败"; } finally { busy.value = false; }
}

async function enqueuePlan() {
  if (!candidate.value || candidate.value.status !== "READY" || busy.value) return;
  const id = candidate.value.id ?? candidate.value.planId!;
  busy.value = true;
  try {
    const queuedPlan = (await api.enqueue(id)).plan;
    dispatched.value = [queuedPlan, ...dispatched.value];
    candidate.value = null;
    drawerOpen.value = false;
  } catch (caught) {
    error.value = caught instanceof Error ? `Enqueue plan 失败：${caught.message}` : "Enqueue plan 失败";
  }
  busy.value = false;
}

function statusLabel(status: string) { return ({ DRAFT: "Candidate", READY: "Confirmed", QUEUED: "Queued", IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGED: "Merged" } as Record<string, string>)[status] ?? status; }
watch(() => route.hash, syncHashPanel);
watch(candidate, () => syncHashPanel(route.hash));
onMounted(() => { void load(); syncHashPanel(route.hash); });
</script>

<template>
  <div class="console-layout">
    <ThreadRail :thread="thread" :candidate-count="candidateCount" :dispatched-count="dispatchedCount" :active-run-count="activeRunCount" :needs-attention-count="needsAttentionCount" />
    <section class="conversation-column">
      <div class="conversation-header"><div><div class="eyebrow"><span class="mode-dot" /> PLAN MODE · READ ONLY</div><h1>ExplorerThread</h1><p>Shape the work before anything changes in the repository.</p></div><div class="conversation-tools"><el-button circle plain :aria-label="explorerPaused ? 'Resume' : 'Pause'" @click="toggleExplorerPause"><VideoPlay v-if="explorerPaused" :size="16" /><VideoPause v-else :size="16" /></el-button><el-popover v-model:visible="moreOpen" placement="bottom-end" :width="250" trigger="click"><template #reference><el-button circle plain aria-label="More"><MoreFilled :size="16" /></el-button></template><div class="thread-more-menu"><div class="eyebrow">THREAD ACTIONS</div><p>Manage read-only exploration without changing the repository.</p><el-button text @click="setPolicyOpen(true); moreOpen = false">View policy</el-button><el-button text @click="moreOpen = false; refreshThread()">Refresh thread</el-button></div></el-popover></div></div>
      <div class="thread-banner"><InfoFilled :size="16" /><span>Explorer can inspect the repository and Git history. Write, shell, test and commit tools are disabled until a plan is confirmed and dispatched.</span><el-button text aria-label="View Explorer policy" @click="setPolicyOpen(true)">View policy <Right :size="14" /></el-button></div>
      <div v-if="explorerPaused" class="demo-notice pause-notice"><VideoPause :size="14" /> ExplorerThread is paused. New turns are disabled until you resume the thread.<el-button text @click="toggleExplorerPause">Resume</el-button></div>
      <div v-if="error" class="demo-notice"><Refresh :size="14" /> {{ error }} <el-button text @click="load">Retry</el-button></div>
      <div ref="timeline" class="timeline" v-loading="loading">
        <div class="timeline-day">TODAY · 10:42</div>
        <article class="message-card user-message"><div class="message-avatar user-avatar">LS</div><div class="message-body"><div class="message-meta"><strong>You</strong><span>10:42</span></div><p>We need an ExplorerThread-first workspace where I can review the full plan before sending it to execution.</p></div></article>
        <article class="message-card assistant-message"><div class="message-avatar agent-avatar"><span class="brand-dot" /></div><div class="message-body"><div class="message-meta"><strong>Plan Explorer</strong><span class="agent-chip">Read only</span><span>10:42</span></div><p>I mapped the thread model, the confirmation boundary and the plan projection. I found one design that meets the scope without changing execution permissions.</p><div class="insight-row"><span><Check :size="13" /> Scope checked</span><span><Check :size="13" /> Dependencies checked</span><span><Check :size="13" /> Verification defined</span></div></div></article>
        <div class="timeline-marker"><span>PLAN CANDIDATE GENERATED</span></div>
        <article class="candidate-card" v-if="candidate"><div class="candidate-head"><div class="candidate-icon"><Promotion :size="19" /></div><div><div class="eyebrow">CANDIDATE PLAN · REVISION {{ candidate.revision }}</div><h2>{{ candidate.title }}</h2></div><el-tag type="warning" effect="light">{{ statusLabel(candidate.status) }}</el-tag></div><p class="candidate-summary">A focused, reviewable slice for the Factory console with separate confirm and enqueue boundaries.</p><div class="candidate-stats"><div><span>Tasks</span><strong>6</strong></div><div><span>Files in scope</span><strong>12</strong></div><div><span>Verification</span><strong>4 checks</strong></div><div><span>Risk</span><strong class="risk-low">Low</strong></div></div><div class="candidate-actions"><el-button @click="drawerOpen = true">View full plan <Right :size="15" /></el-button><el-button v-if="candidate.status === 'DRAFT'" type="primary" :loading="busy" @click="confirmPlan">Confirm plan <Check :size="15" /></el-button><el-button v-else-if="candidate.status === 'READY'" type="primary" :loading="busy" @click="enqueuePlan">Enqueue plan <ArrowDown :size="15" /></el-button><span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusLabel(candidate.status) }}</span></div></article>
        <div class="timeline-marker"><span>THREAD READY FOR YOUR NEXT TURN</span></div>
        <template v-for="turn in turns" :key="turn.id">
          <article :class="['message-card', turn.role === 'user' ? 'user-message' : 'assistant-message', turn.status === 'FAILED' ? 'failed-message' : '']"><div :class="['message-avatar', turn.role === 'user' ? 'user-avatar' : 'agent-avatar']">{{ turn.role === 'user' ? 'LS' : '' }}<span v-if="turn.role === 'assistant'" class="brand-dot" /></div><div class="message-body"><div class="message-meta"><strong>{{ turn.role === 'user' ? 'You' : 'Plan Explorer' }}</strong><span v-if="turn.role === 'assistant'" class="agent-chip">{{ turn.status === 'FAILED' ? 'Failed' : 'Read only' }}</span><span>{{ new Date(turn.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span></div><p>{{ turnContent(turn) }}</p></div></article>
        </template>
      </div>
      <div class="composer"><div class="composer-input"><input v-model="draft" :disabled="explorerPaused" aria-label="Explorer message" placeholder="Continue exploring or ask for a change…" @keydown.enter.prevent="sendTurn" /><span class="composer-mode">Plan Mode</span></div><div class="composer-footer"><span><InfoFilled :size="14" /> Explorer has read-only access</span><el-button type="primary" :loading="busy" :disabled="!draft.trim() || explorerPaused" @click="sendTurn">Send <Right :size="14" /></el-button></div></div>
    </section>
    <aside class="context-panel"><div class="context-header"><div><div class="eyebrow">THREAD CONTEXT</div><h2>Working set</h2></div><el-button text circle aria-label="Refresh" @click="refreshThread"><Refresh :size="16" /></el-button></div><div class="context-section"><div class="context-section-title">CURRENT CANDIDATE <span>{{ candidateCount }}</span></div><div class="mini-plan" v-if="candidate" @click="drawerOpen = true"><div class="mini-plan-title"><span class="mini-icon"><Promotion :size="14" /></span><strong>{{ candidate.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="warning" effect="light">{{ statusLabel(candidate.status) }}</el-tag><span>Rev {{ candidate.revision }}</span></div><div class="mini-plan-link">View full plan <Right :size="13" /></div></div><div v-else class="context-empty compact"><CircleCheck :size="20" /><p>No candidate plan</p><small>Use Plan candidates to create a reviewable plan.</small></div></div><div class="context-section"><div class="context-section-title">DISPATCHED PLANS <span>{{ dispatched.length }}</span></div><div v-if="dispatched.length === 0" class="context-empty"><CircleCheck :size="20" /><p>No plans dispatched from this thread yet.</p><small>Confirmed plans will appear here and remain queryable even when the model is offline.</small></div><div v-else v-for="plan in dispatched" :key="plan.planId ?? plan.id" class="mini-plan dispatched"><div class="mini-plan-title"><span class="mini-icon success"><CircleCheck :size="14" /></span><strong>{{ plan.title }}</strong></div><div class="mini-plan-meta"><el-tag size="small" type="success" effect="light">{{ statusLabel(plan.status) }}</el-tag><span>Rev {{ plan.revision }}</span></div></div></div><div class="context-section context-memory"><div class="context-section-title">THREAD MEMORY</div><div class="memory-row"><span class="memory-icon">◎</span><div><strong>Context summary</strong><small>Updated just now</small></div><Right :size="14" /></div><div class="memory-row"><span class="memory-icon">↗</span><div><strong>Successor threads</strong><small>None yet</small></div><Right :size="14" /></div></div></aside>
    <PlanDetailDrawer v-model="drawerOpen" :plan="candidate" @confirm="confirmPlan" @enqueue="enqueuePlan" />
    <ExplorerPolicyDrawer :model-value="policyOpen" @update:model-value="setPolicyOpen" />
    <el-drawer :model-value="candidateEmptyOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false" @update:model-value="setCandidateEmptyOpen">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">PLAN CANDIDATES</div><h2>No candidate plan</h2></div><el-button text circle aria-label="Close candidate plans" @click="closeCandidateEmpty">×</el-button></div>
        <div class="help-card"><strong>Shape a new execution contract</strong><p>This ExplorerThread has no unconfirmed CandidatePlan yet. Create one here, then review the full contract before confirming it.</p></div>
        <label class="candidate-create-label">Plan title<input v-model="candidateTitle" aria-label="Candidate plan title" placeholder="Plan title" @keydown.enter.prevent="createCandidate" /></label>
        <el-button type="primary" :loading="busy" :disabled="!candidateTitle.trim()" @click="createCandidate">Create candidate plan <Right /></el-button>
      </div>
    </el-drawer>
    <el-drawer :model-value="memoryPanel !== null" direction="rtl" size="min(430px, 92vw)" :with-header="false" @update:model-value="setMemoryPanelOpen">
      <div class="global-drawer-shell" v-if="memoryPanel">
        <div class="drawer-header"><div><div class="eyebrow">THREAD MEMORY</div><h2>{{ memoryPanel === "summary" ? "Context summary" : "Successor threads" }}</h2></div><el-button text circle aria-label="Close thread memory" @click="closeMemoryPanel">×</el-button></div>
        <div class="help-card" v-if="memoryPanel === 'summary'"><strong>Current ExplorerThread memory</strong><p>The thread keeps the project context, confirmed boundaries and recent exploration turns available to the Plan Explorer.</p><p class="memory-detail">Thread: {{ thread?.id ?? "thread-demo" }}<br />Messages: {{ thread?.messageCount ?? 0 }}<br />Last activity: {{ thread?.lastActivityAt ? new Date(thread.lastActivityAt).toLocaleString('zh-CN') : "—" }}</p></div>
        <div class="help-card" v-else><strong>No successor thread yet</strong><p>This ExplorerThread remains the active project thread. A successor will appear here when context compression creates one, while preserving the parent thread lineage.</p></div>
        <el-button type="primary" @click="closeMemoryPanel">Done <Right /></el-button>
      </div>
    </el-drawer>
  </div>
</template>
