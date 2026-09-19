<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, CircleCheck, InfoFilled, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue";
import type { AgentLoop, AgentLoopStep, ExecutionTask, ExecutionTelemetry, MergeRequest, Run, VerificationRun } from "../types";
import { formatExecutionDuration, formatTokenSummary, telemetryModel, telemetryReasoning } from "../utils/executionTelemetry";
import { executionTaskStatusLabel, executionTaskStatusType, verificationSummary } from "../utils/executionTasks";
import { canPauseRun, canTerminateRun, hasRunControlActions } from "../utils/runControls";

type StatusCard = "context" | "telemetry" | "progress" | "loop" | "controls" | "review";
type RunAction = "terminate" | "pause" | "resume" | "verify";
type LoopAction = "pause" | "resume" | "cancel";

const props = defineProps<{
  run: Run;
  threadState: string;
  telemetry: ExecutionTelemetry | null;
  telemetryNow: number;
  tasks: ExecutionTask[];
  taskCounts: { completed: number; total: number; blocked: number; active: number };
  selectedTaskId: string | null;
  executorLoop: AgentLoop | null;
  executorSteps: AgentLoopStep[];
  loopStatusLabel: string;
  verification: VerificationRun | null;
  mergeRequest: MergeRequest | null;
  actionBusy: boolean;
  sourceCommit: string;
  targetCommit: string;
  diagnosticsCount: { journal: number; tools: number; steps: number };
}>();

const emit = defineEmits<{
  (event: "focus-task", task: ExecutionTask): void;
  (event: "run-action", action: RunAction): void;
  (event: "loop-action", action: LoopAction): void;
  (event: "create-review"): void;
  (event: "confirm-merged"): void;
  (event: "open-plan"): void;
  (event: "open-diagnostics"): void;
  (event: "update:source-commit", value: string): void;
  (event: "update:target-commit", value: string): void;
}>();

const activeCard = ref<StatusCard | null>(null);
const executionDuration = computed(() => formatExecutionDuration(props.telemetry, props.telemetryNow));
const executionTokenSummary = computed(() => formatTokenSummary(props.telemetry?.usage));
const executionTelemetryModel = computed(() => telemetryModel(props.telemetry));
const executionTelemetryReasoning = computed(() => telemetryReasoning(props.telemetry));
const verificationStatusSummary = computed(() => verificationSummary(props.verification));
const hasControls = computed(() => hasRunControlActions(props.run.status, props.threadState));
const reviewStatus = computed(() => {
  if (props.mergeRequest?.status === "MERGED") return "Merged";
  if (props.mergeRequest?.status === "OPEN") return "Awaiting merge";
  if (props.verification?.status === "FAILED" || props.verification?.status === "BLOCKED") return "Needs attention";
  if (props.verification?.status === "PASSED" || props.run.status === "MERGE_READY") return "Ready for review";
  if (["IN_PROGRESS", "STARTING", "VERIFYING"].includes(props.run.status)) return "In progress";
  if (props.run.status === "READY_FOR_VERIFY") return "Verification pending";
  return "Not started";
});
const reviewStatusDescription = computed(() => {
  if (reviewStatus.value === "Merged") return "已完成人工合并确认，当前 Run 已进入完成状态。";
  if (reviewStatus.value === "Awaiting merge") return "Merge request 已创建，等待人工合并并确认目标 Commit。";
  if (reviewStatus.value === "Needs attention") return "验证或执行存在异常，请先查看证据和阻塞原因。";
  if (reviewStatus.value === "Ready for review") return "执行和验证已完成，等待人工审阅或创建 Merge request。";
  if (reviewStatus.value === "Verification pending") return "执行已完成，等待启动或完成确定性验证。";
  if (reviewStatus.value === "In progress") return "执行线程仍在运行，完成后会进入验证和人工审阅阶段。";
  return "当前 Run 尚未产生可供审阅的 Verification 或 Merge 证据。";
});
const contextOpen = computed({ get: () => isOpen("context"), set: (visible: boolean) => setCardVisibility("context", visible) });
const telemetryOpen = computed({ get: () => isOpen("telemetry"), set: (visible: boolean) => setCardVisibility("telemetry", visible) });
const progressOpen = computed({ get: () => isOpen("progress"), set: (visible: boolean) => setCardVisibility("progress", visible) });
const loopOpen = computed({ get: () => isOpen("loop"), set: (visible: boolean) => setCardVisibility("loop", visible) });
const controlsOpen = computed({ get: () => isOpen("controls"), set: (visible: boolean) => setCardVisibility("controls", visible) });
const reviewOpen = computed({ get: () => isOpen("review"), set: (visible: boolean) => setCardVisibility("review", visible) });
const loopTone = computed(() => {
  if (!props.executorLoop) return "neutral";
  if (["FAILED", "BLOCKED", "RECOVERING", "NEEDS_RECONCILIATION", "CANCELLED"].includes(props.executorLoop.state)) return "danger";
  if (props.executorLoop.state === "COMPLETED") return "success";
  return "active";
});

function isOpen(card: StatusCard): boolean {
  return activeCard.value === card;
}

function toggleCard(card: StatusCard): void {
  activeCard.value = activeCard.value === card ? null : card;
}

function setCardVisibility(card: StatusCard, visible: boolean): void {
  if (visible) activeCard.value = card;
  else if (activeCard.value === card) activeCard.value = null;
}

function focusTask(task: ExecutionTask): void {
  activeCard.value = null;
  emit("focus-task", task);
}

function openPlan(): void {
  activeCard.value = null;
  emit("open-plan");
}

function taskDependencyCount(task: ExecutionTask): number {
  const completedIds = new Set(props.tasks.filter((candidate) => candidate.status === "DONE").map((candidate) => candidate.id));
  return task.dependencies.filter((dependency) => !completedIds.has(dependency)).length;
}

function formatStartedAt(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

watch(() => props.run.id, () => {
  activeCard.value = null;
});
</script>

<template>
  <div class="execution-header-status" aria-label="Execution run details">
    <div class="execution-header-status-cards">
      <el-popover v-model:visible="contextOpen" placement="bottom-start" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="context" type="button" aria-label="查看 Run context 详情" aria-controls="execution-header-context-details" :aria-expanded="isOpen('context')" @keydown.enter.prevent="toggleCard('context')" @keydown.space.prevent="toggleCard('context')">
            <span class="execution-header-status-card">
              <span class="header-status-card-label">RUN CONTEXT</span>
              <strong class="header-status-card-value">Revision {{ run.planRevision }}</strong>
              <small class="header-status-card-meta">{{ run.branch }}</small>
            </span>
          </button>
        </template>
        <section id="execution-header-context-details" class="execution-header-status-details" aria-label="Run context 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">RUN CONTEXT</span><strong>执行线程上下文</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <div class="execution-context-grid">
            <div><span>WORKSPACE</span><code>{{ run.workspacePath ?? "Not created" }}</code></div>
            <div><span>BASE COMMIT</span><code>{{ run.baseCommit }}</code></div>
            <div><span>THREAD</span><code>{{ run.executionThreadId }}</code></div>
            <div><span>STARTED</span><strong>{{ formatStartedAt(run.startedAt) }}</strong></div>
          </div>
          <div class="execution-header-detail-footer"><span>Plan {{ run.planId }} · Revision {{ run.planRevision }}</span><el-button size="small" @click="openPlan">View plan</el-button></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="telemetryOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="telemetry" type="button" aria-label="查看执行遥测详情" aria-controls="execution-header-telemetry-details" :aria-expanded="isOpen('telemetry')" @keydown.enter.prevent="toggleCard('telemetry')" @keydown.space.prevent="toggleCard('telemetry')">
            <span class="execution-header-status-card"><span class="header-status-card-label">EXECUTION</span><strong class="header-status-card-value">{{ executionTelemetryModel }}</strong><small class="header-status-card-meta">{{ executionDuration }} · {{ executionTokenSummary }}</small></span>
          </button>
        </template>
        <section id="execution-header-telemetry-details" class="execution-header-status-details" aria-label="执行遥测详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">EXECUTION TELEMETRY</span><strong>执行遥测</strong></div><span class="telemetry-source">{{ telemetry?.usageSource === "provider" ? "Provider 精确值" : "Token 未记录" }}</span></div>
          <div class="execution-telemetry-grid execution-telemetry-grid-compact">
            <div class="execution-telemetry-card"><span>MODEL</span><strong>{{ executionTelemetryModel }}</strong><small>实际生效模型</small></div>
            <div class="execution-telemetry-card"><span>REASONING</span><strong>{{ executionTelemetryReasoning }}</strong><small>冻结的推理等级</small></div>
            <div class="execution-telemetry-card"><span>TOKENS USED</span><strong>{{ executionTokenSummary }}</strong><small>{{ telemetry?.usageSource === "provider" ? "输入 / 输出 / 推理 / 总量可在诊断中查看" : "Provider 未返回精确 usage" }}</small></div>
            <div class="execution-telemetry-card"><span>EXECUTION TIME</span><strong>{{ executionDuration }}</strong><small>{{ executorLoop?.state === "RUNNING" || executorLoop?.state === "PAUSED" ? "实时 wall-clock" : "Executor Loop wall-clock" }}</small></div>
          </div>
          <div class="execution-header-detail-footer"><span>{{ diagnosticsCount.journal }} journal entries · {{ diagnosticsCount.tools }} tool calls · {{ diagnosticsCount.steps }} loop steps</span><el-button size="small" @click="emit('open-diagnostics')">Open diagnostics</el-button></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="progressOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="progress" type="button" aria-label="查看 Plan progress 详情" aria-controls="execution-header-progress-details" :aria-expanded="isOpen('progress')" @keydown.enter.prevent="toggleCard('progress')" @keydown.space.prevent="toggleCard('progress')">
            <span :class="['execution-header-status-card', { ready: taskCounts.total > 0 && taskCounts.completed === taskCounts.total, blocked: taskCounts.blocked > 0 }]"><span class="header-status-card-label">PLAN PROGRESS</span><strong class="header-status-card-value">{{ taskCounts.completed }}/{{ taskCounts.total }} completed</strong><small class="header-status-card-meta">{{ taskCounts.blocked ? `${taskCounts.blocked} blocked` : taskCounts.active ? `${taskCounts.active} active` : "Execution steps" }}</small></span>
          </button>
        </template>
        <section id="execution-header-progress-details" class="execution-header-status-details" aria-label="Plan progress 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">EXECUTION STEPS</span><strong>Plan progress</strong></div><span>{{ taskCounts.completed }} of {{ taskCounts.total }} tasks completed</span></div>
          <div class="execution-progress-track" aria-hidden="true"><span :style="{ width: `${taskCounts.total ? Math.round((taskCounts.completed / taskCounts.total) * 100) : 0}%` }" /></div>
          <div v-if="tasks.length" class="execution-task-list">
            <button v-for="(task, index) in tasks" :key="task.id" type="button" :class="['execution-task', `execution-task-${task.status.toLowerCase()}`, { selected: selectedTaskId === task.id }]" :aria-label="`${task.title}, ${executionTaskStatusLabel(task.status)}`" @click="focusTask(task)">
              <span class="execution-task-marker"><CircleCheck v-if="task.status === 'DONE'" :size="14" /><Warning v-else-if="task.status === 'BLOCKED'" :size="14" /><span v-else-if="task.status === 'IN_PROGRESS'" class="execution-task-pulse" /><span v-else class="execution-task-number">{{ index + 1 }}</span></span>
              <span class="execution-task-copy"><strong>{{ task.title }}</strong><small v-if="task.status === 'BLOCKED' && task.blockedReason">{{ task.blockedReason }}</small><small v-else-if="task.status === 'PENDING' && taskDependencyCount(task)">Waiting for {{ taskDependencyCount(task) }} prerequisite(s)</small><small v-else-if="task.status === 'PENDING'">Not reached yet</small></span>
              <el-tag size="small" effect="light" :type="executionTaskStatusType(task.status)">{{ executionTaskStatusLabel(task.status) }}</el-tag>
            </button>
          </div>
          <div v-else class="explorer-header-status-empty" role="status"><strong>暂无执行任务</strong><span>当前 Run 没有可展示的 Plan task。</span></div>
          <div v-if="verificationStatusSummary" class="execution-steps-evidence"><span class="execution-evidence-dot" :class="{ failed: verification?.status === 'FAILED' || verification?.status === 'BLOCKED' }" /> {{ verificationStatusSummary }}</div>
        </section>
      </el-popover>

      <el-popover v-model:visible="loopOpen" placement="bottom-start" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="loop" type="button" aria-label="查看 Executor Agent Loop 详情" aria-controls="execution-header-loop-details" :aria-expanded="isOpen('loop')" @keydown.enter.prevent="toggleCard('loop')" @keydown.space.prevent="toggleCard('loop')">
            <span :class="['execution-header-status-card', `tone-${loopTone}`]"><span class="header-status-card-label">AGENT LOOP</span><strong class="header-status-card-value">{{ executorLoop ? loopStatusLabel : "Not started" }}</strong><small class="header-status-card-meta">{{ executorLoop ? `${executorLoop.stepCount}/${executorLoop.maxSteps} steps` : "等待启动" }}</small></span>
          </button>
        </template>
        <section id="execution-header-loop-details" class="execution-header-status-details" aria-label="Executor Agent Loop 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">EXECUTOR AGENT LOOP</span><strong>{{ executorLoop ? loopStatusLabel : "No loop" }}</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <div v-if="executorLoop" class="agent-loop-strip" role="status"><div class="agent-loop-summary"><span class="eyebrow">EXECUTOR AGENT LOOP</span><strong>{{ executorLoop.mode }}</strong></div><span class="agent-loop-budget">{{ executorLoop.stepCount }} / {{ executorLoop.maxSteps }} loop steps</span><div v-if="executorSteps.length" class="loop-step-list"><span v-for="step in executorSteps.slice(-4)" :key="`${step.loopId}-${step.sequence}`" class="loop-step"><strong>#{{ step.sequence }}</strong> {{ step.stepType }}</span></div><div class="loop-detail-actions"><el-button v-if="executorLoop.state === 'RUNNING'" size="small" :loading="actionBusy" @click="emit('loop-action', 'pause')"><VideoPause :size="14" /> Pause loop</el-button><el-button v-if="executorLoop.state === 'PAUSED'" size="small" :loading="actionBusy" @click="emit('loop-action', 'resume')"><VideoPlay :size="14" /> Resume loop</el-button><el-button v-if="['RUNNING', 'PAUSED', 'RECOVERING', 'WAITING_FOR_INPUT'].includes(executorLoop.state)" size="small" type="danger" plain :loading="actionBusy" @click="emit('loop-action', 'cancel')">Cancel loop</el-button></div></div>
          <div v-else class="explorer-header-status-empty" role="status"><strong>暂无 Executor Agent Loop</strong><span>当前 Run 没有正在运行或等待恢复的 Agent Loop。</span></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="controlsOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="controls" type="button" aria-label="查看 Run Control 详情" aria-controls="execution-header-controls-details" :aria-expanded="isOpen('controls')" @keydown.enter.prevent="toggleCard('controls')" @keydown.space.prevent="toggleCard('controls')">
            <span :class="['execution-header-status-card', { ready: hasControls }]" ><span class="header-status-card-label">RUN CONTROL</span><strong class="header-status-card-value">{{ hasControls ? "Action available" : "No action" }}</strong><small class="header-status-card-meta">{{ hasControls ? "可执行操作" : "当前状态无需操作" }}</small></span>
          </button>
        </template>
        <section id="execution-header-controls-details" class="execution-header-status-details" aria-label="Run Control 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">RUN CONTROL</span><strong>Execution controls</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <p class="execution-header-status-description">Controls append facts to the ExecutionThread; they do not change the confirmed PlanRevision.</p>
          <div v-if="hasControls" class="action-buttons execution-header-action-buttons"><el-button v-if="canTerminateRun(run.status)" type="danger" plain :loading="actionBusy" @click="emit('run-action', 'terminate')">Terminate run</el-button><el-button v-if="canPauseRun(run.status, threadState)" :loading="actionBusy" @click="emit('run-action', threadState === 'PAUSED' ? 'resume' : 'pause')"><VideoPlay v-if="threadState === 'PAUSED'" :size="14" /><VideoPause v-else :size="14" /> {{ threadState === 'PAUSED' ? 'Resume' : 'Pause' }}</el-button><el-button v-if="run.status === 'IN_PROGRESS' || run.status === 'READY_FOR_VERIFY'" type="primary" :loading="actionBusy" @click="emit('run-action', 'verify')"><Check :size="14" /> Run verification</el-button></div>
          <div v-else class="execution-no-action" role="status"><strong>当前状态无需操作</strong><span>Run 当前状态不提供可执行的控制命令。</span></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="reviewOpen" placement="bottom-end" :width="600" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="review" type="button" aria-label="查看 Verification 和 Human merge confirmation 详情" aria-controls="execution-header-review-details" :aria-expanded="isOpen('review')" @keydown.enter.prevent="toggleCard('review')" @keydown.space.prevent="toggleCard('review')">
            <span :class="['execution-header-status-card', { ready: reviewStatus === 'Ready for review' || reviewStatus === 'Merged', blocked: reviewStatus === 'Needs attention' }]" ><span class="header-status-card-label">REVIEW</span><strong class="header-status-card-value">{{ reviewStatus }}</strong><small class="header-status-card-meta">{{ mergeRequest ? `Merge ${mergeRequest.status}` : verificationStatusSummary ?? "Verification pending" }}</small></span>
          </button>
        </template>
        <section id="execution-header-review-details" class="execution-header-status-details" aria-label="Verification 和 Human merge confirmation 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">REVIEW &amp; MERGE</span><strong>Verification and Human merge confirmation</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <p class="execution-header-status-description">{{ reviewStatusDescription }}</p>
          <div class="review-context-grid"><div><span>EXECUTION BRANCH</span><code>{{ run.branch }}</code></div><div><span>BASE COMMIT</span><code>{{ run.baseCommit }}</code></div></div>
          <div v-if="verification || run.status === 'MERGE_READY'" class="review-detail-block"><div class="evidence-heading"><div><span class="eyebrow">VERIFICATION RUN</span><strong>Deterministic checks</strong></div><el-tag :type="verification?.status === 'PASSED' ? 'success' : 'danger'" effect="light">{{ verification?.status ?? 'Not recorded' }}</el-tag></div><div v-if="verification" class="verification-summary"><span>{{ verification.commandResults.length }} command(s)</span><span>Repair attempts {{ verification.repairAttempts }}</span><span>{{ new Date(verification.completedAt).toLocaleString('zh-CN') }}</span></div><div v-if="verification?.commandResults.length" class="command-results"><div v-for="command in verification.commandResults" :key="command.commandId" class="command-result"><code>{{ command.commandId }}</code><span :class="command.result.exitCode === 0 ? 'result-pass' : 'result-fail'">exit {{ command.result.exitCode }}</span></div></div><div v-if="run.status === 'MERGE_READY' && !mergeRequest" class="review-form"><el-input :model-value="sourceCommit" size="small" aria-label="Reviewed source commit" placeholder="Reviewed source commit" @update:model-value="emit('update:source-commit', $event)" /><el-button type="primary" size="small" :loading="actionBusy" @click="emit('create-review')">Create review</el-button></div></div>
          <div v-if="mergeRequest" class="review-detail-block merge-card"><div class="evidence-heading"><div><span class="eyebrow">MERGE REQUEST · {{ mergeRequest.id }}</span><strong>Human merge confirmation</strong></div><el-tag :type="mergeRequest.status === 'MERGED' ? 'success' : 'warning'" effect="light">{{ mergeRequest.status }}</el-tag></div><div class="verification-summary"><span>Source <code>{{ mergeRequest.sourceCommit }}</code></span><span>Target <code>{{ mergeRequest.targetBranch }}</code></span><span v-if="mergeRequest.detectedTargetCommit">Detected <code>{{ mergeRequest.detectedTargetCommit }}</code></span></div><p v-if="mergeRequest.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="merge-detected-banner"><strong>Merge detected</strong> · 已检测到目标分支包含 source commit；请确认后将 Plan 更新为 MERGED。</p><div v-if="mergeRequest.status === 'OPEN'" class="review-form"><el-input :model-value="targetCommit" size="small" aria-label="Target commit" placeholder="Actual target commit after manual merge" @update:model-value="emit('update:target-commit', $event)" /><el-button type="primary" size="small" :loading="actionBusy" @click="emit('confirm-merged')">Confirm merged</el-button></div></div>
          <div v-if="!verification && !mergeRequest && run.status !== 'MERGE_READY'" class="explorer-header-status-empty" role="status"><strong>暂无 Review 证据</strong><span>验证完成或创建 Merge request 后，相关详情会显示在这里。</span></div>
        </section>
      </el-popover>
    </div>
  </div>
</template>

<script lang="ts">
export default { inheritAttrs: false };
</script>
