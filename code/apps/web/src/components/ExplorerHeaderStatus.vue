<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CircleCheck, InfoFilled, Refresh, VideoPause, VideoPlay } from "@element-plus/icons-vue";
import type { AgentLoop, ExplorerThread } from "../types";
import ExplorerPlanRequirements from "./ExplorerPlanRequirements.vue";

type Requirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };
type Issue = { path: string; code: string; area: string; message: string };

const props = defineProps<{
  requirements: Requirement[];
  completed: string[];
  diagnostics: Issue[];
  progress: ExplorerThread["exploration"];
  agentLoop: AgentLoop | null;
  agentLoopLabel: string;
  agentLoopGateLabel: string | null;
  agentLoopTerminalLabel: string | null;
  agentLoopCompletionLabel: string | null;
  threadId: string;
  paused: boolean;
}>();

const emit = defineEmits<{ (event: "toggle-pause"): void }>();

type StatusCard = "requirements" | "provider-loop" | "exploration";

const activeCard = ref<StatusCard | null>(null);
const requirementsOpen = computed({
  get: () => activeCard.value === "requirements",
  set: (visible: boolean) => updateCardVisibility("requirements", visible),
});
const providerLoopOpen = computed({
  get: () => activeCard.value === "provider-loop",
  set: (visible: boolean) => updateCardVisibility("provider-loop", visible),
});
const explorationOpen = computed({
  get: () => activeCard.value === "exploration",
  set: (visible: boolean) => updateCardVisibility("exploration", visible),
});
const diagnosticsByArea = computed(() => new Set(props.diagnostics.map((issue) => issue.area)));

function requirementState(requirement: Requirement): "complete" | "invalid" | "pending" {
  if (diagnosticsByArea.value.has(requirement.label)) return "invalid";
  return props.completed.includes(requirement.label) ? "complete" : "pending";
}

const completedCount = computed(() => props.requirements.filter((requirement) => requirementState(requirement) === "complete").length);
const invalidCount = computed(() => props.requirements.filter((requirement) => requirementState(requirement) === "invalid").length);
const pendingCount = computed(() => props.requirements.filter((requirement) => requirementState(requirement) === "pending").length);
const requirementSummary = computed(() => {
  if (invalidCount.value) return `${invalidCount.value} 项需修正`;
  if (pendingCount.value) return `${completedCount.value}/${props.requirements.length} 项已完成`;
  return `${completedCount.value}/${props.requirements.length} 项已满足`;
});
const requirementMeta = computed(() => invalidCount.value ? `问题 ${props.diagnostics.length}` : pendingCount.value ? `待补齐 ${pendingCount.value}` : "全部完成");
const loopSummary = computed(() => props.agentLoop?.state === "PAUSED" ? "Paused" : props.agentLoopLabel);
const loopMeta = computed(() => props.agentLoop ? `Turns ${props.agentLoop.stepCount}/${props.agentLoop.maxSteps}` : "等待启动");
const progressSummary = computed(() => props.progress.status === "READY" ? "Plan ready" : props.progress.lastAssessedTurnId ? "Exploring" : "未评估");
const progressMeta = computed(() => props.progress.status === "READY" ? "完整方案已生成" : props.progress.missing.length ? `待确认 ${props.progress.missing.length} 项` : "等待首轮评估");
const loopTone = computed(() => {
  if (!props.agentLoop) return "neutral";
  if (["FAILED", "BLOCKED", "RECOVERING", "NEEDS_RECONCILIATION", "CANCELLED"].includes(props.agentLoop.state)) return "danger";
  if (props.agentLoop.state === "COMPLETED") return "success";
  return "active";
});

function updateCardVisibility(card: StatusCard, visible: boolean): void {
  if (visible) {
    activeCard.value = card;
    return;
  }
  if (activeCard.value === card) activeCard.value = null;
}

function toggleCard(card: StatusCard): void {
  updateCardVisibility(card, activeCard.value !== card);
}

watch(() => props.threadId, () => {
  activeCard.value = null;
});
</script>

<template>
  <div class="explorer-header-status">
    <div class="explorer-header-status-cards">
      <el-popover
        v-model:visible="requirementsOpen"
        placement="bottom-start"
        :width="520"
        trigger="click"
        popper-class="explorer-header-status-popper"
        :teleported="true"
      >
        <template #reference>
          <button
            class="explorer-header-status-trigger"
            data-status-card="requirements"
            type="button"
            aria-label="查看需求契约详情"
            aria-controls="explorer-header-requirements-details"
            :aria-expanded="requirementsOpen"
            @keydown.enter.prevent="toggleCard('requirements')"
            @keydown.space.prevent="toggleCard('requirements')"
          >
            <span :class="['explorer-header-status-card', { invalid: diagnostics.length, pending: pendingCount }]">
              <span class="header-status-card-label">REQUIREMENTS</span>
              <strong class="header-status-card-value">{{ requirementSummary }}</strong>
              <small class="header-status-card-meta">{{ requirementMeta }}</small>
            </span>
          </button>
        </template>

        <section id="explorer-header-requirements-details" class="explorer-header-status-details" aria-label="需求契约详情">
          <div class="explorer-header-status-details-heading">
            <div>
              <span class="eyebrow">PLAN REQUIREMENTS</span>
              <strong>启动前已声明的完整契约</strong>
            </div>
            <InfoFilled :size="15" aria-hidden="true" />
          </div>

          <ExplorerPlanRequirements
            v-if="requirements.length"
            :requirements="requirements"
            :completed="completed"
            :diagnostics="diagnostics"
            initially-expanded
          />
          <div v-else class="explorer-header-status-empty" role="status">
            <strong>暂无需求契约</strong>
            <span>当前线程还没有可展示的启动前需求。</span>
          </div>
        </section>
      </el-popover>

      <el-popover
        v-model:visible="providerLoopOpen"
        placement="bottom"
        :width="520"
        trigger="click"
        popper-class="explorer-header-status-popper"
        :teleported="true"
      >
        <template #reference>
          <button
            class="explorer-header-status-trigger"
            data-status-card="provider-loop"
            type="button"
            aria-label="查看 Provider Loop 状态"
            aria-controls="explorer-header-provider-loop-details"
            :aria-expanded="providerLoopOpen"
            @keydown.enter.prevent="toggleCard('provider-loop')"
            @keydown.space.prevent="toggleCard('provider-loop')"
          >
            <span :class="['explorer-header-status-card', `tone-${loopTone}`]">
              <span class="header-status-card-label">PROVIDER LOOP</span>
              <strong class="header-status-card-value">{{ loopSummary }}</strong>
              <small class="header-status-card-meta">{{ loopMeta }}</small>
            </span>
          </button>
        </template>

        <section id="explorer-header-provider-loop-details" class="explorer-header-status-details" aria-label="Provider Loop 状态详情">
          <div class="explorer-header-status-details-heading">
            <div>
              <span class="eyebrow">PROVIDER LOOP</span>
              <strong>Provider Loop 运行状态</strong>
            </div>
            <InfoFilled :size="15" aria-hidden="true" />
          </div>

          <div v-if="agentLoop" class="agent-loop-strip" role="status">
            <div class="agent-loop-summary">
              <span class="eyebrow">EXPLORER PROVIDER TURN LOOP</span>
              <strong>{{ agentLoopLabel }}</strong>
            </div>
            <span class="agent-loop-budget">Provider Turns {{ agentLoop.stepCount }} / {{ agentLoop.maxSteps }} · Activities {{ agentLoop.diagnostics?.providerActivityCount ?? 0 }}</span>
            <div v-if="agentLoopGateLabel || agentLoopTerminalLabel || agentLoopCompletionLabel" class="agent-loop-status">
              <span v-if="agentLoopGateLabel" class="agent-loop-diagnostic">{{ agentLoopGateLabel }}</span>
              <span v-if="agentLoopTerminalLabel" class="agent-loop-terminal">{{ agentLoopTerminalLabel }}</span>
              <span v-if="agentLoopCompletionLabel" class="agent-loop-complete">{{ agentLoopCompletionLabel }}</span>
            </div>
            <el-button v-if="agentLoop.state === 'RUNNING' || agentLoop.state === 'PAUSED'" class="agent-loop-action" size="small" plain @click="emit('toggle-pause')">
              <VideoPlay v-if="paused" :size="14" />
              <VideoPause v-else :size="14" />
              {{ paused ? 'Resume loop' : 'Pause loop' }}
            </el-button>
          </div>
          <div v-else class="explorer-header-status-empty" role="status">
            <strong>暂无活动 Provider Loop</strong>
            <span>当前没有正在运行或等待恢复的 Provider Loop。</span>
          </div>
        </section>
      </el-popover>

      <el-popover
        v-model:visible="explorationOpen"
        placement="bottom-end"
        :width="520"
        trigger="click"
        popper-class="explorer-header-status-popper"
        :teleported="true"
      >
        <template #reference>
          <button
            class="explorer-header-status-trigger"
            data-status-card="exploration"
            type="button"
            aria-label="查看探索进度详情"
            aria-controls="explorer-header-exploration-details"
            :aria-expanded="explorationOpen"
            @keydown.enter.prevent="toggleCard('exploration')"
            @keydown.space.prevent="toggleCard('exploration')"
          >
            <span :class="['explorer-header-status-card', { ready: progress.status === 'READY' }]">
              <span class="header-status-card-label">EXPLORATION</span>
              <strong class="header-status-card-value">{{ progressSummary }}</strong>
              <small class="header-status-card-meta">{{ progressMeta }}</small>
            </span>
          </button>
        </template>

        <section id="explorer-header-exploration-details" class="explorer-header-status-details" aria-label="探索进度详情">
          <div class="explorer-header-status-details-heading">
            <div>
              <span class="eyebrow">EXPLORATION</span>
              <strong>Explorer 探索进度</strong>
            </div>
            <InfoFilled :size="15" aria-hidden="true" />
          </div>

          <div v-if="progress.status === 'INCOMPLETE' && progress.lastAssessedTurnId" class="exploration-progress exploration-progress-incomplete" role="status">
            <Refresh :size="15" />
            <div>
              <strong>方案仍在探索中</strong>
              <span>本轮结束不代表设计完成，Explorer 正在继续确认：{{ progress.missing.join('、') }}</span>
            </div>
          </div>
          <div v-else-if="progress.status === 'READY'" class="exploration-progress exploration-progress-ready" role="status">
            <CircleCheck :size="15" />
            <div>
              <strong>完整设计方案已生成</strong>
              <span>请在生成它的 assistant 消息内查看完整契约，确认后再下发执行。</span>
            </div>
          </div>
          <div v-else class="explorer-header-status-empty" role="status">
            <strong>等待首轮评估</strong>
            <span>Explorer 尚未完成本线程的第一轮需求评估。</span>
          </div>
        </section>
      </el-popover>
    </div>
  </div>
</template>
