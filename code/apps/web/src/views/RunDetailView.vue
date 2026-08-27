<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ArrowLeft, Check, CircleCheck, Clock, Document, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import type { ExecutionThread, MergeRequest, Run, VerificationRun } from "../types";
import { canPauseRun } from "../utils/runControls";

const route = useRoute();
const router = useRouter();
const run = ref<Run | null>(null);
const thread = ref<ExecutionThread | null>(null);
const verification = ref<VerificationRun | null>(null);
const mergeRequest = ref<MergeRequest | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const actionBusy = ref(false);
const guidance = ref("");
const sourceCommit = ref("");
const targetCommit = ref("");
async function load() {
  loading.value = true;
  error.value = null;
  try {
    const response = await api.run(String(route.params.runId));
    run.value = response.run;
    thread.value = response.executionThread;
    verification.value = response.verification;
    mergeRequest.value = response.mergeRequest;
    if (!sourceCommit.value) sourceCommit.value = response.run.baseCommit;
    if (!targetCommit.value) targetCommit.value = response.run.baseCommit;
  } catch { error.value = "Run 不存在或 API 尚未连接"; }
  finally { loading.value = false; }
}
function label(status: string) { return ({ IN_PROGRESS: "Running", VERIFYING: "Verifying", MERGE_READY: "Ready for review", BLOCKED: "Blocked", CANCELLED: "Cancelled" } as Record<string, string>)[status] ?? status; }
function notifyError(caught: unknown) { error.value = caught instanceof Error ? caught.message : "操作失败，请稍后重试"; }
async function togglePause() {
  if (!run.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const response = thread.value?.state === "PAUSED" ? await api.resumeRun(run.value.id) : await api.pauseRun(run.value.id);
    run.value = response.run;
    thread.value = response.thread;
  } catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function sendGuidance() {
  if (!run.value || !guidance.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { thread.value = (await api.addGuidance(run.value.id, guidance.value.trim())).thread; guidance.value = ""; ElMessage.success("已写入执行线程"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function verifyRun() {
  if (!run.value || actionBusy.value) return;
  actionBusy.value = true;
  try { verification.value = (await api.verifyRun(run.value.id)).verification; await load(); ElMessage.success("验证完成"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function createReview() {
  if (!run.value || !sourceCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { mergeRequest.value = (await api.createMergeRequest(run.value.id, sourceCommit.value.trim())).mergeRequest; await load(); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
async function confirmMerged() {
  if (!mergeRequest.value || !targetCommit.value.trim() || actionBusy.value) return;
  actionBusy.value = true;
  try { mergeRequest.value = (await api.confirmMerged(mergeRequest.value.id, targetCommit.value.trim())).mergeRequest; await load(); ElMessage.success("已确认合并到目标 Commit"); }
  catch (caught) { notifyError(caught); }
  finally { actionBusy.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="detail-page" v-loading="loading">
    <div class="detail-top"><el-button text @click="router.back()"><ArrowLeft :size="15" /> Back</el-button><span class="eyebrow">EXECUTION THREAD</span></div>
    <div v-if="error" class="demo-notice"><Warning :size="14" /> {{ error }}</div>
    <template v-if="run">
      <div class="detail-heading"><div><div class="eyebrow">RUN · {{ run.id }}</div><h1>Execution run</h1><p>Plan <code>{{ run.planId }}</code> · Revision {{ run.planRevision }} · <code>{{ run.branch }}</code></p></div><el-tag :type="run.status === 'BLOCKED' ? 'danger' : run.status === 'MERGE_READY' || run.status === 'MERGED' ? 'success' : 'warning'" effect="light">{{ label(run.status) }}</el-tag></div>
      <div class="run-facts"><div><span>WORKSPACE</span><code>{{ run.workspacePath ?? "Not created" }}</code></div><div><span>BASE COMMIT</span><code>{{ run.baseCommit }}</code></div><div><span>THREAD</span><code>{{ run.executionThreadId }}</code></div><div><span>STARTED</span><strong>{{ run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : "—" }}</strong></div></div>
      <section class="run-actions">
        <div class="action-toolbar">
          <div><div class="eyebrow">RUN CONTROL</div><h2>Execution controls</h2><p>Controls append facts to the ExecutionThread; they do not change the confirmed PlanRevision.</p></div>
          <div class="action-buttons"><el-button v-if="canPauseRun(run.status, thread?.state ?? '')" :loading="actionBusy" @click="togglePause"><VideoPlay v-if="thread?.state === 'PAUSED'" :size="14" /><VideoPause v-else :size="14" /> {{ thread?.state === 'PAUSED' ? 'Resume' : 'Pause' }}</el-button><el-button v-if="run.status === 'IN_PROGRESS'" type="primary" :loading="actionBusy" @click="verifyRun"><Check :size="14" /> Run verification</el-button></div>
        </div>
        <div v-if="run.status === 'IN_PROGRESS'" class="guidance-row"><el-input v-model="guidance" size="small" aria-label="User guidance" placeholder="Add in-scope guidance to the execution thread…" @keyup.enter="sendGuidance" /><el-button size="small" :disabled="!guidance.trim()" :loading="actionBusy" @click="sendGuidance">Add guidance</el-button></div>
      </section>
      <section v-if="verification || run.status === 'MERGE_READY'" class="evidence-card"><div class="evidence-heading"><div><div class="eyebrow">VERIFICATION RUN</div><h2>Deterministic checks</h2></div><el-tag :type="verification?.status === 'PASSED' ? 'success' : 'danger'" effect="light">{{ verification?.status ?? 'Not recorded' }}</el-tag></div><div v-if="verification" class="verification-summary"><span>{{ verification.commandResults.length }} command(s)</span><span>Repair attempts {{ verification.repairAttempts }}</span><span>{{ new Date(verification.completedAt).toLocaleString('zh-CN') }}</span></div><div v-if="verification?.commandResults.length" class="command-results"><div v-for="command in verification.commandResults" :key="command.commandId" class="command-result"><code>{{ command.commandId }}</code><span :class="command.result.exitCode === 0 ? 'result-pass' : 'result-fail'">exit {{ command.result.exitCode }}</span></div></div><div v-if="run.status === 'MERGE_READY' && !mergeRequest" class="review-form"><el-input v-model="sourceCommit" size="small" aria-label="Reviewed source commit" placeholder="Reviewed source commit" /><el-button type="primary" size="small" :loading="actionBusy" @click="createReview">Create review</el-button></div></section>
      <section v-if="mergeRequest" class="evidence-card merge-card"><div class="evidence-heading"><div><div class="eyebrow">MERGE REQUEST · {{ mergeRequest.id }}</div><h2>Human merge confirmation</h2></div><el-tag :type="mergeRequest.status === 'MERGED' ? 'success' : 'warning'" effect="light">{{ mergeRequest.status }}</el-tag></div><div class="verification-summary"><span>Source <code>{{ mergeRequest.sourceCommit }}</code></span><span>Target <code>{{ mergeRequest.targetBranch }}</code></span></div><div v-if="mergeRequest.status === 'OPEN'" class="review-form"><el-input v-model="targetCommit" size="small" aria-label="Target commit" placeholder="Actual target commit after manual merge" /><el-button type="primary" size="small" :loading="actionBusy" @click="confirmMerged">Confirm merged</el-button></div></section>
      <section class="journal-panel"><div class="journal-heading"><div><div class="eyebrow">EXECUTION JOURNAL</div><h2>What happened</h2></div><span>{{ thread?.journal.length ?? 0 }} entries</span></div><div v-if="thread?.journal.length" class="journal-list"><div v-for="entry in thread.journal" :key="entry.sequence" class="journal-entry"><div class="journal-icon" :class="{ success: entry.type.includes('COMPLETED') || entry.type === 'COMMIT', warning: entry.type.includes('FAILED') }"><CircleCheck v-if="entry.type.includes('COMPLETED') || entry.type === 'COMMIT'" :size="15" /><Warning v-else-if="entry.type.includes('FAILED')" :size="15" /><Clock v-else :size="15" /></div><div><div class="journal-meta"><strong>{{ entry.type }}</strong><span>{{ new Date(entry.occurredAt).toLocaleTimeString('zh-CN') }}</span></div><p>{{ JSON.stringify(entry.payload) }}</p></div></div></div><div v-else class="empty-state"><Document :size="28" /><h3>No journal entries</h3><p>The execution thread has not recorded activity yet.</p></div></section>
    </template>
  </div>
</template>
