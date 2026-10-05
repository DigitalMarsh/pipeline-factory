<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CircleCheck, Warning } from "@element-plus/icons-vue";

type Requirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };
type Issue = { path: string; code: string; area: string; message: string };

const props = defineProps<{
  requirements: Requirement[];
  completed: string[];
  diagnostics: Issue[];
  initiallyExpanded?: boolean;
}>();

const expanded = ref(props.initiallyExpanded ?? props.diagnostics.length > 0);
const userToggled = ref(false);
const detailsId = "plan-requirements-details";

const diagnosticsByArea = computed(() => {
  const grouped = new Map<string, Issue[]>();
  for (const issue of props.diagnostics) grouped.set(issue.area, [...(grouped.get(issue.area) ?? []), issue]);
  return grouped;
});

const completedCount = computed(() => props.requirements.filter((requirement) => stateFor(requirement) === "complete").length);
const invalidCount = computed(() => props.requirements.filter((requirement) => stateFor(requirement) === "invalid").length);
const pendingCount = computed(() => props.requirements.filter((requirement) => stateFor(requirement) === "pending").length);
const issueCount = computed(() => props.diagnostics.length);
const completionSummary = computed(() => {
  if (invalidCount.value) return `${invalidCount.value} 项需修正`;
  if (pendingCount.value) return `${completedCount.value}/${props.requirements.length} 项已完成`;
  return `${completedCount.value}/${props.requirements.length} 项已满足`;
});

function issuesFor(label: string): Issue[] { return diagnosticsByArea.value.get(label) ?? []; }
function stateFor(requirement: Requirement): "complete" | "invalid" | "pending" {
  if (issuesFor(requirement.label).length) return "invalid";
  return props.completed.includes(requirement.label) ? "complete" : "pending";
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
  userToggled.value = true;
}

watch(() => props.diagnostics.length, (count, previousCount) => {
  if (count > 0 && previousCount === 0 && !userToggled.value) expanded.value = true;
});
</script>

<template>
  <section :class="['explorer-plan-requirements', { expanded, 'has-diagnostics': issueCount > 0 }]" aria-labelledby="plan-requirements-title">
    <div class="plan-requirements-summary">
      <button
        class="plan-requirements-toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        @click="toggleExpanded"
        @keydown.enter.prevent="toggleExpanded"
        @keydown.space.prevent="toggleExpanded"
      >
        <span class="plan-requirements-summary-copy">
          <span class="eyebrow">方案必填项</span>
          <span class="plan-requirements-title-row">
            <strong id="plan-requirements-title" class="plan-requirements-title">启动前已声明的完整契约</strong>
            <small class="plan-requirements-note">模型必填项一次说明</small>
          </span>
        </span>
        <span class="plan-requirements-summary-meta">
          <el-tag size="small" effect="light" type="success">{{ completionSummary }}</el-tag>
          <el-tag v-if="pendingCount" size="small" effect="light" type="warning">待补齐 {{ pendingCount }}</el-tag>
          <el-tag v-if="issueCount" size="small" effect="light" type="danger">问题 {{ issueCount }}</el-tag>
          <span class="plan-requirements-toggle-label">{{ expanded ? '收起详情' : '展开详情' }}</span>
          <span class="plan-requirements-toggle-icon" aria-hidden="true">{{ expanded ? '−' : '+' }}</span>
        </span>
      </button>
    </div>
    <div v-show="expanded" :id="detailsId" class="plan-requirements-details" role="region" aria-labelledby="plan-requirements-title">
      <div class="plan-requirements-grid" role="list">
        <article v-for="requirement in requirements" :key="requirement.key" :class="['plan-requirement-row', stateFor(requirement)]" role="listitem">
          <span class="plan-requirement-status" :aria-label="stateFor(requirement)"><CircleCheck v-if="stateFor(requirement) === 'complete'" :size="11" /><Warning v-else-if="stateFor(requirement) === 'invalid'" :size="11" /><span v-else class="plan-requirement-dot" /></span>
          <div>
            <strong>{{ requirement.label }}</strong>
            <small>必填：{{ requirement.requiredFields.join('、') }}</small>
            <small v-if="requirement.optionalFields.length">可由 Factory 补全：{{ requirement.optionalFields.join('、') }}</small>
            <ul v-if="issuesFor(requirement.label).length" class="plan-requirement-issues">
              <li v-for="item in issuesFor(requirement.label)" :key="`${item.path}:${item.message}`"><code>{{ item.path }}</code>：{{ item.message }}</li>
            </ul>
          </div>
        </article>
      </div>
    </div>
    <div class="plan-requirements-footer">
      <span><strong>产物模式：</strong>CONVERSATION 仅审阅；REPOSITORY_FILE 必须指定仓库相对路径。</span>
      <span><strong>Factory 专属：</strong>repository、Git 基线、验证 command IDs。</span>
    </div>
  </section>
</template>
