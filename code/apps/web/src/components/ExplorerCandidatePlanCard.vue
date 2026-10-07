<script setup lang="ts">
/**
 * 模块职责：助手消息里**内嵌的候选方案卡**。
 *
 * 为什么单独成组件：它不是一行、也不是一条独立时间线条目——它是"这条助手消息产出的方案"，
 * 有自己的数据（`plan`）、自己的锚点（滚动导航要用）、自己的三个动作（查看 / 确认 / 入队）。
 * 这些跟"摆一行正文"没有任何关系，挤在助手消息那个分支里只会让两边都难读。
 *
 * 契约摘要只认当前形状（`resolvedContract`），没有它就退回 `generatedSpec`。
 */
import { computed } from "vue";
import { Check, CircleCheck, Promotion, Right, Warning, ArrowDown } from "@element-plus/icons-vue";
import type { Plan } from "../types";
import { isConversationArtifactPlan } from "../utils/explorerRequirementRows";
import { planStatusLabel } from "../utils/planStatus";
import { planAnchorId, planAnchorKey } from "../utils/planTimeline";

const props = defineProps<{
  plan: Plan;
  /** 这张卡是不是"当前这条需求正在用的那份候选方案"——决定给不给确认 / 入队按钮。 */
  isCandidate: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{ view: [plan: Plan]; confirm: [plan: Plan]; enqueue: [plan: Plan] }>();

const taskCount = computed(() => props.plan.resolvedContract?.tasks.length ?? props.plan.tasks?.length ?? 0);
const scopeCount = computed(() => props.plan.resolvedContract?.scope.includePaths.length ?? props.plan.include?.length ?? 0);
const verificationCount = computed(
  () => props.plan.resolvedContract?.verification.commandIds.length ?? props.plan.verificationCommands?.length ?? 0,
);
const goal = computed(
  () => props.plan.resolvedContract?.objective.goal ?? props.plan.goal ?? "从这条探索线程生成的一份完整、可审阅的执行契约。",
);
const statusText = computed(() => planStatusLabel(props.plan.status));
/** 对话产物（CONVERSATION）能确认、但不能入队执行——这一条要说在按钮上方，别让人确认完才发现。 */
const conversationArtifact = computed(() => isConversationArtifactPlan(props.plan));
</script>

<template>
  <div :id="planAnchorId(plan)" :data-nav-key="planAnchorKey(plan)" class="inline-plan-card">
    <div class="candidate-head">
      <div class="candidate-icon"><Promotion :size="19" /></div>
      <div>
        <div class="eyebrow">候选方案 · 第 {{ plan.revision }} 版</div>
        <h2>{{ plan.title }}</h2>
      </div>
      <el-tag type="warning" effect="light">{{ statusText }}</el-tag>
    </div>
    <p class="candidate-summary">{{ goal }}</p>
    <div class="candidate-stats">
      <div>
        <span>执行步骤</span><strong>{{ taskCount }}</strong>
      </div>
      <div>
        <span>范围条目</span><strong>{{ scopeCount }}</strong>
      </div>
      <div>
        <span>验证</span><strong>{{ verificationCount }} 项检查</strong>
      </div>
      <div><span>合并</span><strong class="risk-low">人工审阅</strong></div>
    </div>
    <p v-if="conversationArtifact" class="candidate-notice">
      <Warning :size="13" />对话产物（CONVERSATION）：确认后仍不能入队或启动 Run。要执行请在探索对话里改成“仓库文件”产物并确认新版本。
    </p>
    <div class="candidate-actions">
      <el-button v-if="isCandidate" @click="emit('view', plan)">查看方案 <Right :size="15" /></el-button>
      <el-button v-if="isCandidate && plan.status === 'DRAFT'" type="primary" :loading="busy" @click="emit('confirm', plan)"
        >确认方案 <Check :size="15"
      /></el-button>
      <el-button v-else-if="isCandidate && plan.status === 'READY'" type="primary" :loading="busy" @click="emit('enqueue', plan)"
        >入队方案 <ArrowDown :size="15"
      /></el-button>
      <span v-else class="confirmed-note"><CircleCheck :size="15" /> {{ statusText }}</span>
    </div>
  </div>
</template>
