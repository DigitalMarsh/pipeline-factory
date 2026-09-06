<script setup lang="ts">
type Requirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };
type Issue = { path: string; code: string; area: string; message: string };

const props = defineProps<{
  requirements: Requirement[];
  completed: string[];
  diagnostics: Issue[];
}>();

function issuesFor(label: string): Issue[] { return props.diagnostics.filter((issue) => issue.area === label); }
function stateFor(requirement: Requirement): "complete" | "invalid" | "pending" {
  if (issuesFor(requirement.label).length) return "invalid";
  return props.completed.includes(requirement.label) ? "complete" : "pending";
}
</script>

<template>
  <section class="explorer-plan-requirements" aria-labelledby="plan-requirements-title">
    <div class="plan-requirements-heading">
      <div><span class="eyebrow">PLAN REQUIREMENTS</span><h2 id="plan-requirements-title">启动前已声明的完整契约</h2></div>
      <span class="plan-requirements-note">模型必填项一次说明</span>
    </div>
    <div class="plan-requirements-grid" role="list">
      <article v-for="requirement in requirements" :key="requirement.key" :class="['plan-requirement-row', stateFor(requirement)]" role="listitem">
        <span class="plan-requirement-status" :aria-label="stateFor(requirement)">{{ stateFor(requirement) === 'complete' ? '✓' : stateFor(requirement) === 'invalid' ? '!' : '·' }}</span>
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
    <div class="plan-requirements-footer">
      <span><strong>产物模式：</strong>CONVERSATION 仅审阅；REPOSITORY_FILE 必须指定仓库相对路径。</span>
      <span><strong>Factory 专属：</strong>repository、Git 基线、验证 command IDs。</span>
    </div>
  </section>
</template>
