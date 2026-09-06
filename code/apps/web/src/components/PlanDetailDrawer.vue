<!--
  模块职责：展示 Plan 全量执行契约并承载编辑、确认和丢弃操作。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed } from "vue";
import { Close, DocumentChecked, Lock, Right } from "@element-plus/icons-vue";
import type { Plan, PlanTask } from "../types";
import { canDiscardPlan } from "../utils/planControls";

const props = defineProps<{ modelValue: boolean; plan: Plan | null; error?: string | null; revisions?: number[]; revisionDraftStatus?: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED" | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; confirm: []; discard: []; "keep-editing": [plan: Plan]; "select-revision": [revision: number] }>();
const planId = computed(() => props.plan?.planId ?? props.plan?.id ?? "—");
const canConfirm = computed(() => props.plan?.status === "DRAFT" && (!props.revisionDraftStatus || props.revisionDraftStatus === "READY_TO_CONFIRM"));
const canDiscard = computed(() => canDiscardPlan(props.plan?.status));
const contract = computed(() => props.plan?.contract);
const resolved = computed(() => props.plan?.resolvedContract);
const tasks = computed<PlanTask[]>(() => resolved.value?.tasks ?? contract.value?.tasks ?? props.plan?.tasks ?? []);
const artifact = computed(() => resolved.value?.artifact ?? props.plan?.generatedSpec?.artifact ?? (contract.value?.artifactMode ? { mode: contract.value.artifactMode, path: contract.value.artifactPath } : null));
// 操作按钮由服务端状态的只读投影驱动：Candidate 只允许确认或丢弃。
const statusTagType = computed(() => props.plan?.status === "DRAFT" || props.plan?.status === "MERGE_READY" ? "warning" : props.plan?.status === "DISCARDED" ? "danger" : "success");
const mergeRequest = computed(() => props.plan?.mergeRequest ?? null);
</script>

<template>
  <el-drawer :model-value="modelValue" direction="rtl" size="min(620px, 94vw)" :with-header="false" @update:model-value="emit('update:modelValue', $event)">
    <div class="drawer-shell" v-if="plan">
      <div class="drawer-header"><div><div class="eyebrow">FULL EXECUTION CONTRACT</div><h2>View full plan</h2></div><el-button text circle aria-label="Close" @click="emit('update:modelValue', false)"><Close /></el-button></div>
      <div class="drawer-plan-title"><div class="plan-file-icon"><DocumentChecked :size="22" /></div><div><h3>{{ plan.title }}</h3><p>{{ planId }} · Revision {{ plan.revision }}</p></div><el-tag :type="statusTagType" effect="light">{{ plan.status }}</el-tag></div>
      <section v-if="revisions?.length" class="contract-section"><div class="section-heading"><span>00</span><strong>Immutable revision history</strong></div><div class="candidate-actions"><el-button v-for="revision in revisions" :key="revision" size="small" :type="revision === plan.revision ? 'primary' : undefined" plain @click="emit('select-revision', revision)">View V{{ revision }}</el-button></div></section>
      <section class="contract-section"><div class="section-heading"><span>01</span><strong>Goal & acceptance</strong></div><p class="contract-goal">{{ resolved?.objective.goal ?? contract?.goal ?? plan.goal }}</p><ul class="check-list"><li v-for="item in (resolved?.objective.acceptanceCriteria ?? contract?.acceptanceCriteria ?? plan.acceptanceCriteria ?? [])" :key="item"><span>✓</span>{{ item }}</li></ul></section>
      <section class="contract-section"><div class="section-heading"><span>02</span><strong>Scope</strong></div><div class="scope-grid"><div><label>INCLUDE</label><code v-for="item in (resolved?.scope.includePaths ?? contract?.include ?? plan.include ?? [])" :key="item">{{ item }}</code></div><div><label>EXCLUDE</label><code v-for="item in (resolved?.scope.excludePaths ?? contract?.exclude ?? plan.exclude ?? [])" :key="item">{{ item }}</code></div></div></section>
      <section v-if="artifact" class="contract-section"><div class="section-heading"><span>02A</span><strong>Artifact mode</strong></div><div class="policy-grid"><div><label>MODE</label><strong>{{ artifact.mode === 'CONVERSATION' ? 'Conversation review only' : 'Repository file' }}</strong></div><div v-if="artifact.path"><label>PATH</label><code>{{ artifact.path }}</code></div></div></section>
      <section class="contract-section"><div class="section-heading"><span>03</span><strong>Tasks & dependencies</strong></div><div class="task-list"><div v-for="(task, index) in tasks" :key="task.id ?? task.title" class="task-row"><span class="task-number">{{ index + 1 }}</span><div><strong>{{ task.title }}</strong><small>{{ task.dependencies.length ? `Depends on ${task.dependencies.join(', ')}` : 'No dependencies' }}</small></div><el-tag size="small" effect="plain">{{ task.status }}</el-tag></div></div></section>
      <section v-if="resolved?.design" class="contract-section"><div class="section-heading"><span>03A</span><strong>Design constraints</strong></div><ul class="check-list"><li v-for="item in [...resolved.design.technicalConstraints, ...resolved.design.dataSecurity, ...resolved.design.failureHandling]" :key="item"><span>✓</span>{{ item }}</li></ul></section>
      <section v-if="mergeRequest?.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="contract-section merge-detected-section"><div class="section-heading"><span>03B</span><strong>Merge detection</strong><el-tag size="small" type="warning" effect="light">待人工确认</el-tag></div><p class="merge-detected-copy">已检测到目标分支包含此 Run 的 source commit。Plan 会在人工确认前保持 MERGE_READY。</p><div class="policy-grid"><div><label>SOURCE COMMIT</label><code>{{ mergeRequest.sourceCommit }}</code></div><div><label>TARGET</label><code>{{ mergeRequest.targetBranch }} · {{ mergeRequest.detectedTargetCommit }}</code></div></div><RouterLink v-if="plan.runId" class="merge-detected-link" :to="`/projects/${plan.projectId}/runs/${plan.runId}`">Open run to confirm</RouterLink></section>
      <section class="contract-section"><div class="section-heading"><span>04</span><strong>Execution policy</strong></div><div class="policy-grid"><div><label>FROZEN PROJECT</label><strong>{{ resolved?.repository.repoRoot ?? 'Legacy Plan' }} · config v{{ resolved?.repository.configVersion ?? '—' }}</strong></div><div><label>BASE</label><strong>{{ resolved?.repository.baseBranch ?? contract?.baseBranch }} · {{ resolved?.repository.baseCommit ?? contract?.baseCommit }}</strong></div><div><label>VERIFICATION</label><strong>{{ resolved?.verification.mode === 'NONE' ? '未配置自动验证（将记录为 SKIPPED）' : (resolved?.verification.commandIds ?? contract?.verificationCommandIds ?? plan.verificationCommands ?? []).join(' · ') }}</strong></div><div><label>REPAIR LIMIT</label><strong>{{ resolved?.execution.maxRepairAttempts ?? contract?.maxRepairAttempts }} attempts</strong></div></div></section>
      <section class="contract-section source-section"><div class="section-heading"><span>05</span><strong>Source evidence</strong></div><div class="source-row"><span>ExplorerThread</span><code>{{ plan.sourceExplorerThreadId }}</code></div><div class="source-row"><span>Contract</span><code>{{ resolved ? 'Resolved V2' : 'Legacy V1 · read only' }}</code></div></section>
      <div class="drawer-actions"><el-button v-if="canDiscard" type="danger" plain @click="emit('discard')">Discard plan</el-button><el-button v-if="!revisionDraftStatus && plan.status !== 'DISCARDED'" @click="emit('keep-editing', plan)">Keep editing V{{ plan.revision + 1 }}</el-button><el-button v-if="canConfirm" type="primary" @click="emit('confirm')">Confirm V{{ plan.revision }} <Right /></el-button><div v-else class="locked-action"><Lock :size="14" /> {{ revisionDraftStatus === 'EDITING' ? 'Revision draft is still being edited' : revisionDraftStatus === 'BASE_CHANGED' ? 'Default branch changed · rebase required' : plan.status === 'DISCARDED' ? 'Discarded · No further actions' : 'Historical contract is read only' }}</div></div>
    </div><div v-else-if="props.error" class="drawer-shell"><div class="settings-error">{{ props.error }}</div></div><div v-else class="drawer-shell"><p>正在加载完整 Plan…</p></div>
  </el-drawer>
</template>

<style scoped>
.merge-detected-section { padding: 14px; border: 1px solid #f0dfb7; border-radius: 7px; background: #fffaf0; }
.merge-detected-section .section-heading { margin-bottom: 8px; }
.merge-detected-copy { margin: 0 0 12px; color: #7c6a4b; font-size: 10px; line-height: 1.6; }
.merge-detected-section .policy-grid code { display: block; color: #6c5a3e; font: 10px ui-monospace, monospace; line-height: 1.5; word-break: break-all; }
.merge-detected-link { display: inline-flex; margin-top: 12px; color: #3478d4; font-size: 10px; font-weight: 600; }
</style>
