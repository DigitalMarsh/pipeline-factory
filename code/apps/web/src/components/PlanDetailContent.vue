<!-- PlanDetailDrawer 的结构化 Plan 正文，可放入共享抽屉。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Close, DocumentChecked, Lock, Right, Warning } from "@element-plus/icons-vue";
import type { Plan, PlanTask } from "../types";
import { canDiscardPlan } from "../utils/planControls";
import { isConversationArtifactPlan } from "../utils/explorerRequirementRows";
import { planStatusLabel } from "../utils/planStatus";
import { statusVisualFor } from "../utils/statusVisual";

const props = defineProps<{
  plan: Plan | null;
  error?: string | null | undefined;
  revisions?: number[] | undefined;
  revisionDraftStatus?: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED" | null | undefined;
  readOnly?: boolean | undefined;
  dependencyOptions?: Array<{ id: string; title: string }> | undefined;
  canEditDependencies?: boolean | undefined;
  dependenciesSaving?: boolean | undefined;
  verificationSuiteOptions?: string[] | undefined;
  canEditVerificationSuites?: boolean | undefined;
  verificationSuitesSaving?: boolean | undefined;
}>();
const emit = defineEmits<{
  close: [];
  confirm: [];
  discard: [];
  "keep-editing": [plan: Plan];
  "select-revision": [revision: number];
  "update-dependencies": [planIds: string[]];
  "update-verification-suites": [suites: string[]];
}>();
const planId = computed(() => props.plan?.planId ?? props.plan?.id ?? "—");
const canConfirm = computed(
  () =>
    !props.readOnly && props.plan?.status === "DRAFT" && (!props.revisionDraftStatus || props.revisionDraftStatus === "READY_TO_CONFIRM"),
);
/**
 * 对话产物（CONVERSATION）的**确认是终点而不是起点**：它是合法契约、也允许确认，
 * 但确认后既不能入队也不能启动 Run（服务端抛 CONVERSATION_ARTIFACT_NOT_EXECUTABLE）。
 * 所以在确认按钮上方明说一次，别让人确认完、切到 Run 页签才发现。
 */
const conversationArtifact = computed(() => isConversationArtifactPlan(props.plan));
const canDiscard = computed(() => !props.readOnly && canDiscardPlan(props.plan?.status));
const resolved = computed(() => props.plan?.resolvedContract);
const generated = computed(() => props.plan?.generatedSpec);
const tasks = computed<PlanTask[]>(() =>
  (resolved.value?.tasks ?? generated.value?.tasks ?? props.plan?.tasks ?? []).map((task) => ({
    ...task,
    status: task.status ?? "PENDING",
  })),
);
const artifact = computed(() => resolved.value?.artifact ?? generated.value?.artifact ?? null);
const designConstraints = computed(() => resolved.value?.design ?? generated.value?.design ?? null);
const contextFindings = computed(() => resolved.value?.objective.context ?? generated.value?.objective.context ?? []);
const risks = computed(() => resolved.value?.design?.risks ?? generated.value?.design?.risks ?? []);
const audiences = computed(() => resolved.value?.objective.audience ?? generated.value?.objective.audience ?? []);
const outOfScope = computed(() => resolved.value?.objective.outOfScope ?? generated.value?.objective.outOfScope ?? []);
const includePaths = computed(() => resolved.value?.scope.includePaths ?? generated.value?.scope.includePaths ?? props.plan?.include ?? []);
const excludePaths = computed(() => resolved.value?.scope.excludePaths ?? generated.value?.scope.excludePaths ?? props.plan?.exclude ?? []);
const conflicts = computed(() => resolved.value?.conflicts ?? generated.value?.conflicts ?? []);
/**
 * 前置 Plan 的可选项与当前值。**这是唯一能设置依赖的入口**：模型不知道 plan id，所以
 * `dependsOnPlanIds` 只能由人从同项目的 Plan 里挑——它决定 dispatch 时是否因
 * WAITING_DEPENDENCY 排队（要求前置 Plan 达到 MERGED）。
 */
const dependencyCandidates = computed(() => (props.dependencyOptions ?? []).filter((option) => option.id !== planId.value));
const confirmedDependencies = computed(() => resolved.value?.dependsOnPlanIds ?? []);
const dependencySelection = ref<string[]>([...confirmedDependencies.value]);
const dependencyDirty = computed(() => {
  const current = [...dependencySelection.value].sort();
  const saved = [...confirmedDependencies.value].sort();
  return current.length !== saved.length || current.some((value, index) => value !== saved[index]);
});
watch(
  confirmedDependencies,
  (values) => {
    dependencySelection.value = [...values];
  },
  { deep: true },
);
function toggleDependency(planId: string, checked: boolean): void {
  dependencySelection.value = checked
    ? [...new Set([...dependencySelection.value, planId])]
    : dependencySelection.value.filter((value) => value !== planId);
}
function saveDependencies(): void {
  emit("update-dependencies", [...dependencySelection.value]);
}

/**
 * 验证子集：勾选项只能来自**本项目已登记的 tag 词表**（props.verificationSuiteOptions），
 * 命令 ID 依旧由 Factory 解析。不勾 = 回到项目默认验证集。当前值来自 generatedSpec（请求过的词表），
 * 而 resolvedContract 里的 commandIds 是解析结果——两者在 VERIFICATION 那格里一起显示，便于对照。
 */
const requestedSuites = computed(() => generated.value?.verification.suites ?? []);
const suiteSelection = ref<string[]>([...requestedSuites.value]);
const suiteDirty = computed(() => {
  const current = [...suiteSelection.value].sort();
  const saved = [...requestedSuites.value].sort();
  return current.length !== saved.length || current.some((value, index) => value !== saved[index]);
});
watch(
  requestedSuites,
  (values) => {
    suiteSelection.value = [...values];
  },
  { deep: true },
);
function toggleSuite(suite: string, checked: boolean): void {
  suiteSelection.value = checked ? [...new Set([...suiteSelection.value, suite])] : suiteSelection.value.filter((value) => value !== suite);
}
function saveVerificationSuites(): void {
  emit("update-verification-suites", [...suiteSelection.value]);
}
function changeActionLabel(action: "create" | "modify" | "delete"): string {
  return action === "create" ? "新建" : action === "delete" ? "删除" : "修改";
}
function changeActionType(action: "create" | "modify" | "delete"): "success" | "danger" | "warning" {
  return action === "create" ? "success" : action === "delete" ? "danger" : "warning";
}
function runPath(plan: Plan): string {
  const query = new URLSearchParams({ explorerId: plan.sourceExplorerThreadId, contextPanel: "plan-center", runId: plan.runId ?? "" });
  if (plan.explorerPlanId) query.set("explorerPlanId", plan.explorerPlanId);
  return `/projects/${encodeURIComponent(plan.projectId)}/explorer?${query.toString()}`;
}
/**
 * 操作按钮由服务端状态的只读投影驱动：草稿只允许确认或丢弃。
 * 标签的文案与语气色都从共用表取（`planStatusLabel` / `statusVisualFor`）——
 * 这里此前自己写了一份三元的语气色，并且**直接把 `plan.status` 这个枚举值渲染给用户看**，
 * 于是抽屉里显示的是 `DRAFT`、候选卡上显示的是另一套英文词。
 */
const planStatusText = computed(() => planStatusLabel(props.plan?.status ?? ""));
const statusTagType = computed(() => statusVisualFor(props.plan?.status ?? "").tone);
const mergeRequest = computed(() => props.plan?.mergeRequest ?? null);
</script>

<template>
  <div class="plan-detail-content">
    <div v-if="plan" class="drawer-shell">
      <div class="drawer-header">
        <div>
          <div class="eyebrow">完整执行契约</div>
          <h2>查看方案</h2>
        </div>
        <el-button text circle aria-label="Close" @click="emit('close')"><Close /></el-button>
      </div>
      <div class="drawer-plan-title">
        <div class="plan-file-icon"><DocumentChecked :size="22" /></div>
        <div>
          <h3>{{ plan.title }}</h3>
          <p>{{ planId }} · Revision {{ plan.revision }}</p>
        </div>
        <el-tag :type="statusTagType" effect="light">{{ planStatusText }}</el-tag>
      </div>
      <div v-if="props.error" class="settings-error" role="status">{{ props.error }}，当前显示已加载的计划内容。</div>
      <section v-if="revisions?.length" class="contract-section">
        <div class="section-heading"><span>00</span><strong>方案版本历史 · 历史版本只读</strong></div>
        <div class="candidate-actions">
          <el-button
            v-for="revision in revisions"
            :key="revision"
            size="small"
            :type="revision === plan.revision ? 'primary' : undefined"
            plain
            @click="emit('select-revision', revision)"
            >查看 V{{ revision }}</el-button
          >
        </div>
      </section>
      <section class="contract-section">
        <div class="section-heading"><span>01</span><strong>目标与验收</strong></div>
        <p class="contract-goal">{{ resolved?.objective.goal ?? generated?.objective.goal ?? plan.goal }}</p>
        <ul class="check-list">
          <li
            v-for="item in resolved?.objective.acceptanceCriteria ??
            generated?.objective.acceptanceCriteria ??
            plan.acceptanceCriteria ??
            []"
            :key="item"
          >
            <span>✓</span>{{ item }}
          </li>
        </ul>
      </section>
      <section v-if="audiences.length || outOfScope.length" class="contract-section">
        <div class="section-heading"><span>01A</span><strong>受众与范围外</strong></div>
        <div class="scope-grid">
          <div v-if="audiences.length">
            <label>受众</label><code v-for="item in audiences" :key="item">{{ item }}</code>
          </div>
          <div v-if="outOfScope.length">
            <label>范围外</label><code v-for="item in outOfScope" :key="item">{{ item }}</code>
          </div>
        </div>
      </section>
      <section v-if="contextFindings.length" class="contract-section">
        <div class="section-heading"><span>01B</span><strong>现状与发现</strong></div>
        <ul class="check-list">
          <li v-for="item in contextFindings" :key="item"><span>·</span>{{ item }}</li>
        </ul>
      </section>
      <section class="contract-section">
        <div class="section-heading"><span>02</span><strong>范围</strong></div>
        <div class="scope-grid">
          <div>
            <label>包含</label><code v-for="item in includePaths" :key="item">{{ item }}</code>
          </div>
          <div>
            <label>排除</label><code v-for="item in excludePaths" :key="item">{{ item }}</code>
          </div>
        </div>
      </section>
      <section v-if="artifact" class="contract-section">
        <div class="section-heading"><span>02A</span><strong>产物模式</strong></div>
        <div class="policy-grid">
          <div>
            <label>模式</label><strong>{{ artifact.mode === "CONVERSATION" ? "仅对话审阅" : "仓库文件" }}</strong>
          </div>
          <div v-if="artifact.path">
            <label>路径</label><code>{{ artifact.path }}</code>
          </div>
        </div>
      </section>
      <section class="contract-section">
        <div class="section-heading"><span>03</span><strong>执行步骤与依赖</strong></div>
        <div class="task-list">
          <div v-for="(task, index) in tasks" :key="task.id ?? task.title" class="task-row">
            <span class="task-number">{{ index + 1 }}</span>
            <div class="task-copy">
              <strong>{{ task.title }}</strong
              ><small>{{ task.dependencies.length ? `依赖 ${task.dependencies.join("、")}` : "无依赖" }}</small>
              <div v-if="task.changes?.length" class="task-changes">
                <div v-for="change in task.changes" :key="`${change.action}-${change.path}`" class="task-change">
                  <el-tag size="small" effect="light" :type="changeActionType(change.action)">{{ changeActionLabel(change.action) }}</el-tag
                  ><code>{{ change.path }}</code
                  ><span>{{ change.detail }}</span>
                </div>
              </div>
            </div>
            <el-tag size="small" effect="plain">{{ task.status ?? "PENDING" }}</el-tag>
          </div>
        </div>
        <div v-if="(resolved?.dependencies ?? generated?.dependencies ?? []).length" class="source-row">
          <span>方案前置条件</span><code>{{ (resolved?.dependencies ?? generated?.dependencies ?? []).join(" · ") }}</code>
        </div>
      </section>
      <section v-if="designConstraints || risks.length" class="contract-section">
        <div class="section-heading"><span>03A</span><strong>技术方案与风险</strong></div>
        <ul v-if="designConstraints" class="check-list">
          <li
            v-for="item in [
              ...designConstraints.technicalConstraints,
              ...designConstraints.dataSecurity,
              ...designConstraints.failureHandling,
            ]"
            :key="item"
          >
            <span>✓</span>{{ item }}
          </li>
        </ul>
        <div v-if="risks.length" class="risk-list">
          <strong>风险与回滚</strong>
          <ul class="check-list">
            <li v-for="item in risks" :key="item"><span>!</span>{{ item }}</li>
          </ul>
        </div>
      </section>
      <section v-if="conflicts.length" class="contract-section">
        <div class="section-heading"><span>03B</span><strong>冲突</strong></div>
        <ul class="check-list">
          <li v-for="item in conflicts" :key="item"><span>·</span>{{ item }}</li>
        </ul>
        <p class="section-note">
          冲突键是<strong>模型声明的语义键</strong>：dispatcher 会用它与在跑 Run 的冲突键取交集，命中则排队（WAITING_CONFLICT）。
        </p>
      </section>
      <section v-if="canEditDependencies || confirmedDependencies.length" class="contract-section">
        <div class="section-heading"><span>03C</span><strong>前置方案</strong></div>
        <ul v-if="!canEditDependencies" class="check-list">
          <li v-for="id in confirmedDependencies" :key="id">
            <span>·</span>{{ dependencyCandidates.find((option) => option.id === id)?.title ?? id }}
          </li>
        </ul>
        <template v-else>
          <p class="section-note">
            前置 Plan 达到 MERGED 之前，这个 Plan 派发时会停在 WAITING_DEPENDENCY。只能从本项目已有的 Plan 里选；确认后随 Revision 冻结。
          </p>
          <div v-if="dependencyCandidates.length" class="dependency-list">
            <label v-for="option in dependencyCandidates" :key="option.id" class="dependency-option"
              ><input
                type="checkbox"
                :checked="dependencySelection.includes(option.id)"
                :disabled="dependenciesSaving"
                @change="toggleDependency(option.id, ($event.target as HTMLInputElement).checked)"
              /><span>{{ option.title }}</span
              ><code>{{ option.id }}</code></label
            >
          </div>
          <p v-else class="section-note">本项目还没有其他 Plan 可作为前置。</p>
          <div class="dependency-actions">
            <el-button
              size="small"
              type="primary"
              :loading="dependenciesSaving"
              :disabled="!dependencyDirty || dependenciesSaving"
              @click="saveDependencies"
              >保存前置 Plan</el-button
            >
          </div>
        </template>
      </section>
      <section v-if="canEditVerificationSuites || requestedSuites.length" class="contract-section">
        <div class="section-heading"><span>03D</span><strong>验证子集</strong></div>
        <ul v-if="!canEditVerificationSuites" class="check-list">
          <li v-for="suite in requestedSuites" :key="suite"><span>·</span>{{ suite }}</li>
        </ul>
        <template v-else>
          <p class="section-note">
            按 tag 选验证子集：勾选后只会跑本项目<strong>命中这些 tag 的默认验证命令</strong>；命令 ID 由 Factory
            解析，模型与这里都只声明"要哪一类验证"。全不勾 = 跑项目默认全集。
          </p>
          <div v-if="verificationSuiteOptions?.length" class="dependency-list">
            <label v-for="suite in verificationSuiteOptions" :key="suite" class="dependency-option"
              ><input
                type="checkbox"
                :checked="suiteSelection.includes(suite)"
                :disabled="verificationSuitesSaving"
                @change="toggleSuite(suite, ($event.target as HTMLInputElement).checked)"
              /><span>{{ suite }}</span></label
            >
          </div>
          <p v-else class="section-note">
            本项目还没有登记任何验证 tag（在 Project 设置的命令里加 <code>tags</code> 之后才能按 tag 选子集）。
          </p>
          <div class="dependency-actions">
            <el-button
              size="small"
              type="primary"
              :loading="verificationSuitesSaving"
              :disabled="!suiteDirty || verificationSuitesSaving"
              @click="saveVerificationSuites"
              >保存验证子集</el-button
            >
          </div>
        </template>
      </section>
      <section v-if="mergeRequest?.status === 'OPEN' && mergeRequest.detectedTargetCommit" class="contract-section merge-detected-section">
        <div class="section-heading">
          <span>03E</span><strong>合并检测</strong><el-tag size="small" type="warning" effect="light">待人工确认</el-tag>
        </div>
        <p class="merge-detected-copy">已检测到目标分支包含此 Run 的 source commit。Plan 会在人工确认前保持「待合并」。</p>
        <div class="policy-grid">
          <div>
            <label>源提交</label><code>{{ mergeRequest.sourceCommit }}</code>
          </div>
          <div>
            <label>目标</label><code>{{ mergeRequest.targetBranch }} · {{ mergeRequest.detectedTargetCommit }}</code>
          </div>
        </div>
        <RouterLink v-if="plan.runId" class="merge-detected-link" :to="runPath(plan)">打开 Run 确认</RouterLink>
      </section>
      <section class="contract-section">
        <div class="section-heading"><span>04</span><strong>执行策略</strong></div>
        <div class="policy-grid">
          <div>
            <label>冻结项目</label
            ><strong>{{ resolved?.repository.repoRoot ?? "未冻结" }} · config v{{ resolved?.repository.configVersion ?? "—" }}</strong>
          </div>
          <div>
            <label>基线</label><strong>{{ resolved?.repository.baseBranch ?? "—" }} · {{ resolved?.repository.baseCommit ?? "—" }}</strong>
          </div>
          <div>
            <label>验证</label
            ><em v-if="generated?.verification.suites?.length" class="policy-note"
              >按 tag 选子集：{{ generated.verification.suites.join(" · ") }}</em
            ><strong>{{
              resolved?.verification.mode === "NONE" || generated?.verification.mode === "NONE"
                ? "未配置自动验证（将记录为 SKIPPED）"
                : (resolved?.verification.commandIds ?? plan.verificationCommands ?? []).join(" · ") ||
                  (generated?.verification ? "项目默认验证命令" : "—")
            }}</strong>
          </div>
          <div>
            <label>Executor</label><strong>{{ resolved?.execution.executorModelRole ?? "—" }} · Factory 固定</strong>
          </div>
          <div>
            <label>工具策略</label><strong>{{ resolved?.execution.toolPolicy ?? "—" }} · Factory 固定</strong>
          </div>
          <div>
            <label>修复上限</label
            ><strong>{{ resolved?.execution.maxRepairAttempts ?? generated?.execution.maxRepairAttempts ?? "—" }} 次</strong>
          </div>
          <div>
            <label>合并</label
            ><strong
              >{{ resolved?.merge.strategy ?? generated?.merge.strategy ?? "—" }} ·
              {{ (resolved?.merge.requireHumanMerge ?? generated?.merge.requireHumanMerge) ? "需人工审阅" : "—" }}</strong
            >
          </div>
        </div>
      </section>
      <section class="contract-section source-section">
        <div class="section-heading"><span>05</span><strong>源证据</strong></div>
        <div class="source-row">
          <span>ExplorerThread</span><code>{{ plan.sourceExplorerThreadId }}</code>
        </div>
        <div class="source-row">
          <span>契约</span><code>{{ resolved ? "已解析契约" : generated ? "生成的方案" : "—" }}</code>
        </div>
      </section>
      <div v-if="!readOnly && canConfirm && conversationArtifact" class="drawer-confirm-warning" role="status">
        <Warning :size="14" /><span
          ><strong>此 Plan 是对话产物（CONVERSATION）。</strong>确认后仍不能入队或启动
          Run，执行线程也不会产生仓库改动。要执行请在探索对话里改成“仓库文件”产物（REPOSITORY_FILE），确认新版本。</span
        >
      </div>
      <div v-if="readOnly" class="drawer-readonly-note" role="status">
        <Lock :size="14" /><span>执行线程使用此冻结 Revision；Plan 生命周期操作已在此处隐藏。</span>
      </div>
      <div v-else class="drawer-actions">
        <el-button v-if="canDiscard" type="danger" plain @click="emit('discard')">丢弃方案</el-button
        ><el-button v-if="!readOnly && !revisionDraftStatus && plan.status !== 'DISCARDED'" @click="emit('keep-editing', plan)">{{
          plan.status === "DRAFT" ? "编辑此方案" : `继续编辑 V${plan.revision + 1}`
        }}</el-button
        ><el-button v-if="canConfirm" type="primary" @click="emit('confirm')">确认 V{{ plan.revision }} <Right /></el-button>
        <div v-if="readOnly || (!canConfirm && !revisionDraftStatus)" class="locked-action">
          <Lock :size="14" /> {{ plan.status === "DISCARDED" ? "已丢弃 · 不再有可用操作" : "历史契约只读" }}
        </div>
        <div v-else-if="revisionDraftStatus" class="locked-action">
          <Lock :size="14" />
          {{
            revisionDraftStatus === "EDITING"
              ? "Revision draft is still being edited"
              : revisionDraftStatus === "BASE_CHANGED"
                ? "默认分支 changed · rebase required"
                : "Revision is ready to confirm"
          }}
        </div>
      </div>
    </div>
    <div v-else-if="props.error" class="drawer-shell">
      <div class="settings-error">{{ props.error }}</div>
    </div>
    <div v-else class="drawer-shell"><p>正在加载完整 Plan…</p></div>
  </div>
</template>

<style scoped>
.drawer-readonly-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 15px;
  padding: 11px 12px;
  border: 1px solid #dfe7f2;
  border-radius: 7px;
  background: #f7faff;
  color: #6c7f9b;
  font-size: 10px;
  line-height: 1.5;
}
.drawer-readonly-note svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: #7c96bd;
}
.drawer-confirm-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 15px;
  padding: 11px 12px;
  border: 1px solid #f0dfb7;
  border-radius: 7px;
  background: #fffaf0;
  color: #7c6a4b;
  font-size: 10px;
  line-height: 1.6;
}
.drawer-confirm-warning svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: #c99a3f;
}
.drawer-confirm-warning strong {
  color: #a5761f;
}
.merge-detected-section {
  padding: 14px;
  border: 1px solid #f0dfb7;
  border-radius: 7px;
  background: #fffaf0;
}
.merge-detected-section .section-heading {
  margin-bottom: 8px;
}
.merge-detected-copy {
  margin: 0 0 12px;
  color: #7c6a4b;
  font-size: 10px;
  line-height: 1.6;
}
.merge-detected-section .policy-grid code {
  display: block;
  color: #6c5a3e;
  font:
    10px ui-monospace,
    monospace;
  line-height: 1.5;
  word-break: break-all;
}
.merge-detected-link {
  display: inline-flex;
  margin-top: 12px;
  color: #3478d4;
  font-size: 10px;
  font-weight: 600;
}
</style>
