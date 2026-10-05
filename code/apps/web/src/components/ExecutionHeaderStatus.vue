<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, CircleCheck, InfoFilled, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue";
import type { AgentLoop, AgentLoopStep, ExecutionTask, ExecutionTelemetry, MergeRequest, Run, VerificationRun } from "../types";
import type { ExecutionStreamItem } from "../utils/executionStream";
import { formatExecutionDuration, formatTokenSummary, telemetryModel, telemetryReasoning, usageDetailRows } from "../utils/executionTelemetry";
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
  taskCounts: { completed: number; total: number; blocked: number; active: number; unknown?: number };
  /** 没有归属于任何执行步骤的 Run 级事件（Run 创建、生命周期钩子、验证、门禁等）。
   *  它们原先混在执行会话末尾的一个「未关联执行步骤」分组里，读起来像报错，且时序颠倒
   *  （Run created 永远最早发生、却永远排在最后）。改由 RUN CONTEXT 卡片承载。 */
  runActivity: ExecutionStreamItem[];
  selectedTaskId: string | null;
  executorLoop: AgentLoop | null;
  executorSteps: AgentLoopStep[];
  loopStatusLabel: string;
  verification: VerificationRun | null;
  mergeRequest: MergeRequest | null;
  actionBusy: boolean;
  sourceCommit: string;
  targetCommit: string;
}>();

const emit = defineEmits<{
  (event: "focus-task", task: ExecutionTask): void;
  (event: "run-action", action: RunAction): void;
  (event: "loop-action", action: LoopAction): void;
  (event: "create-review"): void;
  (event: "confirm-merged"): void;
  (event: "open-plan"): void;
  (event: "update:source-commit", value: string): void;
  (event: "update:target-commit", value: string): void;
}>();

const activeCard = ref<StatusCard | null>(null);
const executionDuration = computed(() => formatExecutionDuration(props.telemetry, props.telemetryNow));
const executionTokenSummary = computed(() => formatTokenSummary(props.telemetry?.usage));
const executionTelemetryModel = computed(() => telemetryModel(props.telemetry));
const executionTelemetryReasoning = computed(() => telemetryReasoning(props.telemetry));
const executionUsageRows = computed(() => usageDetailRows(props.telemetry?.usage));
const verificationStatusSummary = computed(() => verificationSummary(props.verification));
const hasControls = computed(() => hasRunControlActions(props.run.status, props.threadState));
/**
 * REVIEW 卡的状态。**这是第五套状态机**（Run 审阅阶段），取值与 Plan 生命周期、
 * Agent Loop、消息条目都对不上号，所以它自己一张表；`tone` 与文案在同一处算出来，
 * 模板里不再拿中文串作文案键去比（那样改一个词就会静默丢掉配色）。
 */
const review = computed<{ label: string; tone: "ready" | "blocked" | "pending"; description: string }>(() => {
  if (props.mergeRequest?.status === "MERGED") return { label: "已合并", tone: "ready", description: "已完成人工合并确认，当前 Run 已进入完成状态。" };
  if (props.mergeRequest?.status === "OPEN") return { label: "等待合并", tone: "ready", description: "Merge request 已创建，等待人工合并并确认目标 Commit。" };
  if (props.verification?.status === "FAILED" || props.verification?.status === "BLOCKED") return { label: "需要处理", tone: "blocked", description: "验证或执行存在异常，请先查看证据和阻塞原因。" };
  if (props.verification?.status === "PASSED" || props.run.status === "MERGE_READY") return { label: "待人工审阅", tone: "ready", description: "执行和验证已完成，等待人工审阅或创建 Merge request。" };
  if (["IN_PROGRESS", "STARTING", "VERIFYING"].includes(props.run.status)) return { label: "进行中", tone: "pending", description: "执行线程仍在运行，完成后会进入验证和人工审阅阶段。" };
  if (props.run.status === "READY_FOR_VERIFY") return { label: "等待验证", tone: "pending", description: "执行已完成，等待启动或完成确定性验证。" };
  return { label: "尚未开始", tone: "pending", description: "当前 Run 尚未产生可供审阅的 Verification 或 Merge 证据。" };
});
const reviewStatus = computed(() => review.value.label);
const reviewStatusDescription = computed(() => review.value.description);

/** 验证结果与合并请求状态的文案：这两格此前直接把 `PASSED` / `OPEN` 这样的枚举值端给用户看。 */
const verificationStatusText = computed(() => verificationSummary(props.verification) ?? "未记录");
const mergeRequestStatusText = computed(() => (props.mergeRequest?.status === "MERGED" ? "已合并" : props.mergeRequest ? "等待合并" : ""));
const contextOpen = computed({ get: () => isOpen("context"), set: (visible: boolean) => setCardVisibility("context", visible) });
const telemetryOpen = computed({ get: () => isOpen("telemetry"), set: (visible: boolean) => setCardVisibility("telemetry", visible) });
const progressOpen = computed({ get: () => isOpen("progress"), set: (visible: boolean) => setCardVisibility("progress", visible) });
const loopOpen = computed({ get: () => isOpen("loop"), set: (visible: boolean) => setCardVisibility("loop", visible) });
const controlsOpen = computed({ get: () => isOpen("controls"), set: (visible: boolean) => setCardVisibility("controls", visible) });
const reviewOpen = computed({ get: () => isOpen("review"), set: (visible: boolean) => setCardVisibility("review", visible) });
/** 有 Run 级活动失败（如 HOOK_FAILED）时卡片要变色——否则失败只藏在弹层里，不点开就看不见。 */
const runActivityFailed = computed(() => props.runActivity.some((item) => item.status === "FAILED"));
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
  <div class="execution-header-status" aria-label="执行运行详情">
    <div class="execution-header-status-cards">
      <el-popover v-model:visible="contextOpen" placement="bottom-start" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="context" type="button" aria-label="查看运行上下文详情" aria-controls="execution-header-context-details" :aria-expanded="isOpen('context')" @keydown.enter.prevent="toggleCard('context')" @keydown.space.prevent="toggleCard('context')">
            <span :class="['execution-header-status-card', { blocked: runActivityFailed }]">
              <span class="header-status-card-label">运行上下文</span>
              <strong class="header-status-card-value">第 {{ run.planRevision }} 版</strong>
              <small class="header-status-card-meta">{{ runActivityFailed ? "有 Run 级活动失败" : run.branch }}</small>
            </span>
          </button>
        </template>
        <section id="execution-header-context-details" class="execution-header-status-details" aria-label="Run context 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">运行上下文</span><strong>执行线程上下文</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <div class="execution-context-grid">
            <div><span>工作区</span><code>{{ run.workspacePath ?? "未创建" }}</code></div>
            <div><span>基线提交</span><code>{{ run.baseCommit }}</code></div>
            <div><span>线程</span><code>{{ run.executionThreadId }}</code></div>
            <div><span>开始时间</span><strong>{{ formatStartedAt(run.startedAt) }}</strong></div>
          </div>
          <div v-if="runActivity.length" class="run-activity-block">
            <div class="evidence-heading"><div><span class="eyebrow">Run 级活动</span><strong>Run 级活动</strong></div><span class="run-activity-count">{{ runActivity.length }} 条</span></div>
            <p class="execution-header-status-description">Run 的创建、生命周期钩子与验证等事件，属于整个 Run，不归属于任何单个执行步骤。</p>
            <ol class="run-activity-list">
              <li v-for="item in runActivity" :key="item.id" :class="['run-activity-item', `tone-${item.status.toLowerCase()}`]">
                <span class="run-activity-time">{{ new Date(item.occurredAt).toLocaleTimeString("zh-CN") }}</span>
                <strong>{{ item.title }}</strong>
                <small v-if="item.detail">{{ item.detail }}</small>
              </li>
            </ol>
          </div>
          <div class="execution-header-detail-footer"><span>Plan {{ run.planId }} · 第 {{ run.planRevision }} 版</span><el-button size="small" @click="openPlan">查看方案</el-button></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="telemetryOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="telemetry" type="button" aria-label="查看执行遥测详情" aria-controls="execution-header-telemetry-details" :aria-expanded="isOpen('telemetry')" @keydown.enter.prevent="toggleCard('telemetry')" @keydown.space.prevent="toggleCard('telemetry')">
            <span class="execution-header-status-card"><span class="header-status-card-label">执行</span><strong class="header-status-card-value">{{ executionTelemetryModel }}</strong><small class="header-status-card-meta">{{ executionDuration }} · {{ executionTokenSummary }}</small></span>
          </button>
        </template>
        <section id="execution-header-telemetry-details" class="execution-header-status-details" aria-label="执行遥测详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">执行遥测</span><strong>执行遥测</strong></div><span class="telemetry-source">{{ telemetry?.usageSource === "provider" ? "Provider 精确值" : "Token 未记录" }}</span></div>
          <div class="execution-telemetry-grid execution-telemetry-grid-compact">
            <div class="execution-telemetry-card"><span>模型</span><strong>{{ executionTelemetryModel }}</strong><small>实际生效模型</small></div>
            <div class="execution-telemetry-card"><span>推理</span><strong>{{ executionTelemetryReasoning }}</strong><small>冻结的推理等级</small></div>
            <div class="execution-telemetry-card"><span>已用 token</span><strong>{{ executionTokenSummary }}</strong><small>{{ telemetry?.usageSource === "provider" ? "下方显示输入 / 输出 / 推理 / 总量" : "Provider 未返回精确 usage" }}</small></div>
            <div class="execution-telemetry-card"><span>执行时长</span><strong>{{ executionDuration }}</strong><small>{{ executorLoop?.state === "RUNNING" || executorLoop?.state === "PAUSED" ? "实时 wall-clock" : "Executor Loop wall-clock" }}</small></div>
          </div>
          <div v-if="executionUsageRows.length" class="telemetry-detail-grid telemetry-detail-grid-compact"><div v-for="row in executionUsageRows" :key="row.label"><span>{{ row.label }}</span><strong>{{ row.value }}</strong></div></div>
          <div class="execution-header-detail-footer"><span>模型消息、工具 / MCP 调用和错误显示在执行会话中。</span></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="progressOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="progress" type="button" aria-label="查看 方案进度 详情" aria-controls="execution-header-progress-details" :aria-expanded="isOpen('progress')" @keydown.enter.prevent="toggleCard('progress')" @keydown.space.prevent="toggleCard('progress')">
            <span :class="['execution-header-status-card', { ready: taskCounts.total > 0 && taskCounts.completed === taskCounts.total, blocked: taskCounts.blocked > 0 }]"><span class="header-status-card-label">方案进度</span><strong class="header-status-card-value">已完成 {{ taskCounts.completed }}/{{ taskCounts.total }}</strong><small class="header-status-card-meta">{{ taskCounts.blocked ? `已阻塞 ${taskCounts.blocked}` : taskCounts.active ? `进行中 ${taskCounts.active}` : taskCounts.unknown ? `状态未知 ${taskCounts.unknown}` : "任务执行步骤" }}</small></span>
          </button>
        </template>
        <section id="execution-header-progress-details" class="execution-header-status-details" aria-label="方案进度 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">执行步骤</span><strong>方案进度</strong></div><span>已完成 {{ taskCounts.completed }}/{{ taskCounts.total }} 个任务</span></div>
          <div class="execution-progress-track" aria-hidden="true"><span :style="{ width: `${taskCounts.total ? Math.round((taskCounts.completed / taskCounts.total) * 100) : 0}%` }" /></div>
          <div v-if="tasks.length" class="execution-task-list">
            <button v-for="(task, index) in tasks" :key="task.id" type="button" :class="['execution-task', `execution-task-${task.status.toLowerCase()}`, { selected: selectedTaskId === task.id }]" :aria-label="`${task.title}, ${executionTaskStatusLabel(task.status)}`" @click="focusTask(task)">
              <span class="execution-task-marker"><CircleCheck v-if="task.status === 'DONE'" :size="14" /><Warning v-else-if="task.status === 'BLOCKED'" :size="14" /><span v-else-if="task.status === 'IN_PROGRESS'" class="execution-task-pulse" /><span v-else class="execution-task-number">{{ index + 1 }}</span></span>
              <span class="execution-task-copy"><strong>{{ task.title }}</strong><small v-if="task.status === 'BLOCKED' && task.blockedReason">{{ task.blockedReason }}</small><small v-else-if="task.status === 'PENDING' && taskDependencyCount(task)">等待 {{ taskDependencyCount(task) }} 个前置任务</small><small v-else-if="task.status === 'PENDING'">尚未开始</small></span>
              <el-tag size="small" effect="light" :type="executionTaskStatusType(task.status)">{{ executionTaskStatusLabel(task.status) }}</el-tag>
            </button>
          </div>
          <div v-else class="explorer-header-status-empty" role="status"><strong>暂无执行步骤</strong><span>当前 Run 没有可展示的执行步骤。</span></div>
          <div v-if="verificationStatusSummary" class="execution-steps-evidence"><span class="execution-evidence-dot" :class="{ failed: verification?.status === 'FAILED' || verification?.status === 'BLOCKED' }" /> {{ verificationStatusSummary }}</div>
        </section>
      </el-popover>

      <el-popover v-model:visible="loopOpen" placement="bottom-start" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="loop" type="button" aria-label="查看 Executor Agent Loop 详情" aria-controls="execution-header-loop-details" :aria-expanded="isOpen('loop')" @keydown.enter.prevent="toggleCard('loop')" @keydown.space.prevent="toggleCard('loop')">
            <span :class="['execution-header-status-card', `tone-${loopTone}`]"><span class="header-status-card-label">Agent 循环</span><strong class="header-status-card-value">{{ executorLoop ? loopStatusLabel : "尚未开始" }}</strong><small class="header-status-card-meta">{{ executorLoop ? `${executorLoop.stepCount}/${executorLoop.maxSteps} 步` : "等待启动" }}</small></span>
          </button>
        </template>
        <section id="execution-header-loop-details" class="execution-header-status-details" aria-label="Executor Agent Loop 详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">Executor Agent 循环</span><strong>{{ executorLoop ? loopStatusLabel : "无活动 Loop" }}</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <div v-if="executorLoop" class="agent-loop-strip" role="status"><div class="agent-loop-summary"><span class="eyebrow">Executor Agent 循环</span><strong>{{ executorLoop.mode }}</strong></div><span class="agent-loop-budget">{{ executorLoop.stepCount }} / {{ executorLoop.maxSteps }} 个循环步骤</span><div v-if="executorSteps.length" class="loop-step-list"><span v-for="step in executorSteps.slice(-4)" :key="`${step.loopId}-${step.sequence}`" class="loop-step"><strong>#{{ step.sequence }}</strong> {{ step.stepType }}</span></div><div class="loop-detail-actions"><el-button v-if="executorLoop.state === 'RUNNING'" size="small" :loading="actionBusy" @click="emit('loop-action', 'pause')"><VideoPause :size="14" /> 暂停 Loop</el-button><el-button v-if="executorLoop.state === 'PAUSED'" size="small" :loading="actionBusy" @click="emit('loop-action', 'resume')"><VideoPlay :size="14" /> 恢复 Loop</el-button><el-button v-if="['RUNNING', 'PAUSED', 'RECOVERING', 'WAITING_FOR_INPUT'].includes(executorLoop.state)" size="small" type="danger" plain :loading="actionBusy" @click="emit('loop-action', 'cancel')">取消 Loop</el-button></div></div>
          <div v-else class="explorer-header-status-empty" role="status"><strong>暂无 Executor Agent Loop</strong><span>当前 Run 没有正在运行或等待恢复的 Agent Loop。</span></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="controlsOpen" placement="bottom" :width="560" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="controls" type="button" aria-label="查看 运行控制详情" aria-controls="execution-header-controls-details" :aria-expanded="isOpen('controls')" @keydown.enter.prevent="toggleCard('controls')" @keydown.space.prevent="toggleCard('controls')">
            <span :class="['execution-header-status-card', { ready: hasControls }]" ><span class="header-status-card-label">运行控制</span><strong class="header-status-card-value">{{ hasControls ? "有可用操作" : "无可用操作" }}</strong><small class="header-status-card-meta">{{ hasControls ? "可执行操作" : "当前状态无需操作" }}</small></span>
          </button>
        </template>
        <section id="execution-header-controls-details" class="execution-header-status-details" aria-label="运行控制详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">运行控制</span><strong>执行控制</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <p class="execution-header-status-description">控制命令只是往 ExecutionThread 追加事实；它们不会改动已确认的 PlanRevision。</p>
          <div v-if="hasControls" class="action-buttons execution-header-action-buttons"><el-button v-if="canTerminateRun(run.status)" type="danger" plain :loading="actionBusy" @click="emit('run-action', 'terminate')">终止 Run</el-button><el-button v-if="canPauseRun(run.status, threadState)" :loading="actionBusy" @click="emit('run-action', threadState === 'PAUSED' ? 'resume' : 'pause')"><VideoPlay v-if="threadState === 'PAUSED'" :size="14" /><VideoPause v-else :size="14" /> {{ threadState === 'PAUSED' ? '恢复' : '暂停' }}</el-button><el-button v-if="run.status === 'IN_PROGRESS' || run.status === 'READY_FOR_VERIFY'" type="primary" :loading="actionBusy" @click="emit('run-action', 'verify')"><Check :size="14" /> 运行验证</el-button></div>
          <div v-else class="execution-no-action" role="status"><strong>当前状态无需操作</strong><span>Run 当前状态不提供可执行的控制命令。</span></div>
        </section>
      </el-popover>

      <el-popover v-model:visible="reviewOpen" placement="bottom-end" :width="600" trigger="click" popper-class="execution-header-status-popper" :teleported="true">
        <template #reference>
          <button class="execution-header-status-trigger" data-status-card="review" type="button" aria-label="查看 验证与人工合并确认详情" aria-controls="execution-header-review-details" :aria-expanded="isOpen('review')" @keydown.enter.prevent="toggleCard('review')" @keydown.space.prevent="toggleCard('review')">
            <span :class="['execution-header-status-card', { ready: review.tone === 'ready', blocked: review.tone === 'blocked' }]" ><span class="header-status-card-label">审阅</span><strong class="header-status-card-value">{{ reviewStatus }}</strong><small class="header-status-card-meta">{{ mergeRequest ? mergeRequestStatusText : verificationStatusSummary ?? "等待验证" }}</small></span>
          </button>
        </template>
        <section id="execution-header-review-details" class="execution-header-status-details" aria-label="验证与人工合并确认详情">
          <div class="execution-header-status-details-heading"><div><span class="eyebrow">审阅与合并</span><strong>验证与人工合并确认</strong></div><InfoFilled :size="15" aria-hidden="true" /></div>
          <p class="execution-header-status-description">{{ reviewStatusDescription }}</p>
          <div class="review-context-grid"><div><span>执行分支</span><code>{{ run.branch }}</code></div><div><span>基线提交</span><code>{{ run.baseCommit }}</code></div></div>
          <div v-if="verification || run.status === 'MERGE_READY'" class="review-detail-block"><div class="evidence-heading"><div><span class="eyebrow">验证运行</span><strong>确定性检查</strong></div><el-tag :type="verification?.status === 'PASSED' ? 'success' : 'danger'" effect="light">{{ verificationStatusText }}</el-tag></div><div v-if="verification" class="verification-summary"><span>{{ verification.commandResults.length }} 条命令</span><span>修复尝试 {{ verification.repairAttempts }} 次</span><span>{{ new Date(verification.completedAt).toLocaleString('zh-CN') }}</span></div><div v-if="verification?.commandResults.length" class="command-results"><div v-for="command in verification.commandResults" :key="command.commandId" class="command-result"><code>{{ command.commandId }}</code><span :class="command.result.exitCode === 0 ? 'result-pass' : 'result-fail'">exit {{ command.result.exitCode }}</span></div></div><div v-if="run.status === 'MERGE_READY' && !mergeRequest" class="review-form"><el-input :model-value="sourceCommit" size="small" aria-label="已审阅的源提交" placeholder="已审阅的源提交" @update:model-value="emit('update:source-commit', $event)" /><el-button type="primary" size="small" :loading="actionBusy" @click="emit('create-review')">创建审阅</el-button></div></div>
          <div v-if="mergeRequest" class="review-detail-block merge-card"><div class="evidence-heading"><div><span class="eyebrow">合并请求 · {{ mergeRequest.id }}</span><strong>人工合并确认</strong></div><el-tag :type="mergeRequest.status === 'MERGED' ? 'success' : 'warning'" effect="light">{{ mergeRequestStatusText }}</el-tag></div><div class="verification-summary"><span>源 <code>{{ mergeRequest.sourceCommit }}</code></span><span>目标 <code>{{ mergeRequest.targetBranch }}</code></span><span v-if="mergeRequest.detectedTargetCommit">已检测到 <code>{{ mergeRequest.detectedTargetCommit }}</code></span></div><p v-if="mergeRequest.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="merge-detected-banner"><strong>检测到合并</strong> · 已检测到目标分支包含 source commit；请确认后将 Plan 更新为「已合并」。</p><div v-if="mergeRequest.status === 'OPEN'" class="review-form"><el-input :model-value="targetCommit" size="small" aria-label="目标提交" placeholder="人工合并后的实际目标提交" @update:model-value="emit('update:target-commit', $event)" /><el-button type="primary" size="small" :loading="actionBusy" @click="emit('confirm-merged')">确认已合并</el-button></div></div>
          <div v-if="!verification && !mergeRequest && run.status !== 'MERGE_READY'" class="explorer-header-status-empty" role="status"><strong>暂无 Review 证据</strong><span>验证完成或创建 Merge request 后，相关详情会显示在这里。</span></div>
        </section>
      </el-popover>
    </div>
  </div>
</template>

<script lang="ts">
export default { inheritAttrs: false };
</script>
