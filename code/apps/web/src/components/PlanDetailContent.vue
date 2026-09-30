<!-- PlanDetailDrawer 的结构化 Plan 正文，可放入共享抽屉。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Close, DocumentChecked, Lock, Right } from "@element-plus/icons-vue";
import type { Plan, PlanTask } from "../types";
import { canDiscardPlan } from "../utils/planControls";

const props = defineProps<{ plan: Plan | null; error?: string | null | undefined; revisions?: number[] | undefined; revisionDraftStatus?: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED" | null | undefined; readOnly?: boolean | undefined; dependencyOptions?: Array<{ id: string; title: string }> | undefined; canEditDependencies?: boolean | undefined; dependenciesSaving?: boolean | undefined }>();
const emit = defineEmits<{ close: []; confirm: []; discard: []; "keep-editing": [plan: Plan]; "select-revision": [revision: number]; "update-dependencies": [planIds: string[]] }>();
const planId = computed(() => props.plan?.planId ?? props.plan?.id ?? "—");
const canConfirm = computed(() => !props.readOnly && props.plan?.status === "DRAFT" && (!props.revisionDraftStatus || props.revisionDraftStatus === "READY_TO_CONFIRM"));
const canDiscard = computed(() => !props.readOnly && canDiscardPlan(props.plan?.status));
const contract = computed(() => props.plan?.contract);
const resolved = computed(() => props.plan?.resolvedContract);
const generated = computed(() => props.plan?.generatedSpec);
const tasks = computed<PlanTask[]>(() => (resolved.value?.tasks ?? generated.value?.tasks ?? contract.value?.tasks ?? props.plan?.tasks ?? []).map((task) => ({ ...task, status: task.status ?? "PENDING" })));
const artifact = computed(() => resolved.value?.artifact ?? generated.value?.artifact ?? (contract.value?.artifactMode ? { mode: contract.value.artifactMode, path: contract.value.artifactPath } : null));
const designConstraints = computed(() => resolved.value?.design ?? generated.value?.design ?? null);
const audiences = computed(() => resolved.value?.objective.audience ?? generated.value?.objective.audience ?? []);
const outOfScope = computed(() => resolved.value?.objective.outOfScope ?? generated.value?.objective.outOfScope ?? []);
const includePaths = computed(() => resolved.value?.scope.includePaths ?? generated.value?.scope.includePaths ?? contract.value?.include ?? props.plan?.include ?? []);
const excludePaths = computed(() => resolved.value?.scope.excludePaths ?? generated.value?.scope.excludePaths ?? contract.value?.exclude ?? props.plan?.exclude ?? []);
const conflicts = computed(() => resolved.value?.conflicts ?? generated.value?.conflicts ?? contract.value?.conflictKeys ?? []);
/**
 * 前置 Plan 的可选项与当前值。**这是唯一能设置依赖的入口**：模型不知道 plan id，所以
 * `dependsOnPlanIds` 只能由人从同项目的 Plan 里挑——它决定 dispatch 时是否因
 * WAITING_DEPENDENCY 排队（要求前置 Plan 达到 MERGED）。
 */
const dependencyCandidates = computed(() => (props.dependencyOptions ?? []).filter((option) => option.id !== planId.value));
const confirmedDependencies = computed(() => contract.value?.dependsOnPlanIds ?? []);
const dependencySelection = ref<string[]>([...confirmedDependencies.value]);
const dependencyDirty = computed(() => {
  const current = [...dependencySelection.value].sort();
  const saved = [...confirmedDependencies.value].sort();
  return current.length !== saved.length || current.some((value, index) => value !== saved[index]);
});
watch(confirmedDependencies, (values) => { dependencySelection.value = [...values]; }, { deep: true });
function toggleDependency(planId: string, checked: boolean): void {
  dependencySelection.value = checked ? [...new Set([...dependencySelection.value, planId])] : dependencySelection.value.filter((value) => value !== planId);
}
function saveDependencies(): void { emit("update-dependencies", [...dependencySelection.value]); }
function runPath(plan: Plan): string {
  const query = new URLSearchParams({ explorerId: plan.sourceExplorerThreadId, contextPanel: "plan-center", runId: plan.runId ?? "" });
  if (plan.explorerPlanId) query.set("explorerPlanId", plan.explorerPlanId);
  return `/projects/${encodeURIComponent(plan.projectId)}/explorer?${query.toString()}`;
}
// 操作按钮由服务端状态的只读投影驱动：Candidate 只允许确认或丢弃。
const statusTagType = computed(() => props.plan?.status === "DRAFT" || props.plan?.status === "MERGE_READY" ? "warning" : props.plan?.status === "DISCARDED" ? "danger" : "success");
const mergeRequest = computed(() => props.plan?.mergeRequest ?? null);
</script>

<template>
  <div class="plan-detail-content">
    <div class="drawer-shell" v-if="plan">
      <div class="drawer-header"><div><div class="eyebrow">FULL EXECUTION CONTRACT</div><h2>View full plan</h2></div><el-button text circle aria-label="Close" @click="emit('close')"><Close /></el-button></div>
      <div class="drawer-plan-title"><div class="plan-file-icon"><DocumentChecked :size="22" /></div><div><h3>{{ plan.title }}</h3><p>{{ planId }} · Revision {{ plan.revision }}</p></div><el-tag :type="statusTagType" effect="light">{{ plan.status }}</el-tag></div>
      <div v-if="props.error" class="settings-error" role="status">{{ props.error }}，当前显示已加载的计划内容。</div>
      <section v-if="revisions?.length" class="contract-section"><div class="section-heading"><span>00</span><strong>Plan version history · previous versions are read only</strong></div><div class="candidate-actions"><el-button v-for="revision in revisions" :key="revision" size="small" :type="revision === plan.revision ? 'primary' : undefined" plain @click="emit('select-revision', revision)">View V{{ revision }}</el-button></div></section>
      <section class="contract-section"><div class="section-heading"><span>01</span><strong>Goal & acceptance</strong></div><p class="contract-goal">{{ resolved?.objective.goal ?? generated?.objective.goal ?? contract?.goal ?? plan.goal }}</p><ul class="check-list"><li v-for="item in (resolved?.objective.acceptanceCriteria ?? generated?.objective.acceptanceCriteria ?? contract?.acceptanceCriteria ?? plan.acceptanceCriteria ?? [])" :key="item"><span>✓</span>{{ item }}</li></ul></section>
      <section v-if="audiences.length || outOfScope.length" class="contract-section"><div class="section-heading"><span>01A</span><strong>Audience & out of scope</strong></div><div class="scope-grid"><div v-if="audiences.length"><label>AUDIENCE</label><code v-for="item in audiences" :key="item">{{ item }}</code></div><div v-if="outOfScope.length"><label>OUT OF SCOPE</label><code v-for="item in outOfScope" :key="item">{{ item }}</code></div></div></section>
      <section class="contract-section"><div class="section-heading"><span>02</span><strong>Scope</strong></div><div class="scope-grid"><div><label>INCLUDE</label><code v-for="item in includePaths" :key="item">{{ item }}</code></div><div><label>EXCLUDE</label><code v-for="item in excludePaths" :key="item">{{ item }}</code></div></div></section>
      <section v-if="artifact" class="contract-section"><div class="section-heading"><span>02A</span><strong>Artifact mode</strong></div><div class="policy-grid"><div><label>MODE</label><strong>{{ artifact.mode === 'CONVERSATION' ? 'Conversation review only' : 'Repository file' }}</strong></div><div v-if="artifact.path"><label>PATH</label><code>{{ artifact.path }}</code></div></div></section>
      <section class="contract-section"><div class="section-heading"><span>03</span><strong>执行步骤与依赖</strong></div><div class="task-list"><div v-for="(task, index) in tasks" :key="task.id ?? task.title" class="task-row"><span class="task-number">{{ index + 1 }}</span><div><strong>{{ task.title }}</strong><small>{{ task.dependencies.length ? `Depends on ${task.dependencies.join(', ')}` : 'No dependencies' }}</small></div><el-tag size="small" effect="plain">{{ task.status ?? 'PENDING' }}</el-tag></div></div><div v-if="(resolved?.dependencies ?? generated?.dependencies ?? []).length" class="source-row"><span>Plan prerequisites</span><code>{{ (resolved?.dependencies ?? generated?.dependencies ?? []).join(' · ') }}</code></div></section>
      <section v-if="designConstraints" class="contract-section"><div class="section-heading"><span>03A</span><strong>Design constraints</strong></div><ul class="check-list"><li v-for="item in [...designConstraints.technicalConstraints, ...designConstraints.dataSecurity, ...designConstraints.failureHandling]" :key="item"><span>✓</span>{{ item }}</li></ul></section>
      <section v-if="conflicts.length" class="contract-section"><div class="section-heading"><span>03B</span><strong>Conflicts</strong></div><ul class="check-list"><li v-for="item in conflicts" :key="item"><span>·</span>{{ item }}</li></ul><p class="section-note">冲突键是<strong>模型声明的语义键</strong>：dispatcher 会用它与在跑 Run 的冲突键取交集，命中则排队（WAITING_CONFLICT）。</p></section>
      <section v-if="canEditDependencies || confirmedDependencies.length" class="contract-section"><div class="section-heading"><span>03C</span><strong>Prerequisite plans</strong></div>
        <ul v-if="!canEditDependencies" class="check-list"><li v-for="id in confirmedDependencies" :key="id"><span>·</span>{{ dependencyCandidates.find((option) => option.id === id)?.title ?? id }}</li></ul>
        <template v-else>
          <p class="section-note">前置 Plan 达到 MERGED 之前，这个 Plan 派发时会停在 WAITING_DEPENDENCY。只能从本项目已有的 Plan 里选；确认后随 Revision 冻结。</p>
          <div v-if="dependencyCandidates.length" class="dependency-list">
            <label v-for="option in dependencyCandidates" :key="option.id" class="dependency-option"><input type="checkbox" :checked="dependencySelection.includes(option.id)" :disabled="dependenciesSaving" @change="toggleDependency(option.id, ($event.target as HTMLInputElement).checked)" /><span>{{ option.title }}</span><code>{{ option.id }}</code></label>
          </div>
          <p v-else class="section-note">本项目还没有其他 Plan 可作为前置。</p>
          <div class="dependency-actions"><el-button size="small" type="primary" :loading="dependenciesSaving" :disabled="!dependencyDirty || dependenciesSaving" @click="saveDependencies">保存前置 Plan</el-button></div>
        </template>
      </section>
      <section v-if="mergeRequest?.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="contract-section merge-detected-section"><div class="section-heading"><span>03B</span><strong>Merge detection</strong><el-tag size="small" type="warning" effect="light">待人工确认</el-tag></div><p class="merge-detected-copy">已检测到目标分支包含此 Run 的 source commit。Plan 会在人工确认前保持 MERGE_READY。</p><div class="policy-grid"><div><label>SOURCE COMMIT</label><code>{{ mergeRequest.sourceCommit }}</code></div><div><label>TARGET</label><code>{{ mergeRequest.targetBranch }} · {{ mergeRequest.detectedTargetCommit }}</code></div></div><RouterLink v-if="plan.runId" class="merge-detected-link" :to="runPath(plan)">Open run to confirm</RouterLink></section>
      <section class="contract-section"><div class="section-heading"><span>04</span><strong>Execution policy</strong></div><div class="policy-grid"><div><label>FROZEN PROJECT</label><strong>{{ resolved?.repository.repoRoot ?? 'Not frozen' }} · config v{{ resolved?.repository.configVersion ?? '—' }}</strong></div><div><label>BASE</label><strong>{{ resolved?.repository.baseBranch ?? contract?.baseBranch ?? '—' }} · {{ resolved?.repository.baseCommit ?? contract?.baseCommit ?? '—' }}</strong></div><div><label>VERIFICATION</label><em v-if="generated?.verification.suites?.length" class="policy-note">按 tag 选子集：{{ generated.verification.suites.join(" · ") }}</em><strong>{{ resolved?.verification.mode === 'NONE' || generated?.verification.mode === 'NONE' ? '未配置自动验证（将记录为 SKIPPED）' : (resolved?.verification.commandIds ?? contract?.verificationCommandIds ?? plan.verificationCommands ?? []).join(' · ') || (generated?.verification ? '项目默认验证命令' : '—') }}</strong></div><div><label>EXECUTOR</label><strong>{{ resolved?.execution.executorModelRole ?? contract?.executorModelRole ?? '—' }} · Factory 固定</strong></div><div><label>TOOL POLICY</label><strong>{{ resolved?.execution.toolPolicy ?? contract?.toolPolicy ?? '—' }} · Factory 固定</strong></div><div><label>REPAIR LIMIT</label><strong>{{ resolved?.execution.maxRepairAttempts ?? generated?.execution.maxRepairAttempts ?? contract?.maxRepairAttempts ?? '—' }} attempts</strong></div><div><label>MERGE</label><strong>{{ resolved?.merge.strategy ?? generated?.merge.strategy ?? contract?.mergeStrategy ?? '—' }} · {{ (resolved?.merge.requireHumanMerge ?? generated?.merge.requireHumanMerge ?? contract?.requireHumanMerge) ? 'human review required' : '—' }}</strong></div></div></section>
      <section class="contract-section source-section"><div class="section-heading"><span>05</span><strong>Source evidence</strong></div><div class="source-row"><span>ExplorerThread</span><code>{{ plan.sourceExplorerThreadId }}</code></div><div class="source-row"><span>Contract</span><code>{{ resolved ? 'Resolved V2' : generated ? 'Generated V2' : 'Legacy V1 · read only' }}</code></div></section>
      <div v-if="readOnly" class="drawer-readonly-note" role="status"><Lock :size="14" /><span>执行线程使用此冻结 Revision；Plan 生命周期操作已在此处隐藏。</span></div>
      <div v-else class="drawer-actions"><el-button v-if="canDiscard" type="danger" plain @click="emit('discard')">Discard plan</el-button><el-button v-if="!readOnly && !revisionDraftStatus && plan.status !== 'DISCARDED'" @click="emit('keep-editing', plan)">{{ plan.status === 'DRAFT' ? 'Edit this Plan' : `Continue editing V${plan.revision + 1}` }}</el-button><el-button v-if="canConfirm" type="primary" @click="emit('confirm')">Confirm V{{ plan.revision }} <Right /></el-button><div v-if="readOnly || (!canConfirm && !revisionDraftStatus)" class="locked-action"><Lock :size="14" /> {{ plan.status === 'DISCARDED' ? 'Discarded · No further actions' : 'Historical contract is read only' }}</div><div v-else-if="revisionDraftStatus" class="locked-action"><Lock :size="14" /> {{ revisionDraftStatus === 'EDITING' ? 'Revision draft is still being edited' : revisionDraftStatus === 'BASE_CHANGED' ? 'Default branch changed · rebase required' : 'Revision is ready to confirm' }}</div></div>
    </div><div v-else-if="props.error" class="drawer-shell"><div class="settings-error">{{ props.error }}</div></div><div v-else class="drawer-shell"><p>正在加载完整 Plan…</p></div>
  </div>
</template>

<style scoped>
.drawer-readonly-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 15px; padding: 11px 12px; border: 1px solid #dfe7f2; border-radius: 7px; background: #f7faff; color: #6c7f9b; font-size: 10px; line-height: 1.5; }
.drawer-readonly-note svg { flex: 0 0 auto; margin-top: 1px; color: #7c96bd; }
.merge-detected-section { padding: 14px; border: 1px solid #f0dfb7; border-radius: 7px; background: #fffaf0; }
.merge-detected-section .section-heading { margin-bottom: 8px; }
.merge-detected-copy { margin: 0 0 12px; color: #7c6a4b; font-size: 10px; line-height: 1.6; }
.merge-detected-section .policy-grid code { display: block; color: #6c5a3e; font: 10px ui-monospace, monospace; line-height: 1.5; word-break: break-all; }
.merge-detected-link { display: inline-flex; margin-top: 12px; color: #3478d4; font-size: 10px; font-weight: 600; }
</style>
