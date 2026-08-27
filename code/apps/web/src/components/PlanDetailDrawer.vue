<script setup lang="ts">
import { computed } from "vue";
import { Close, DocumentChecked, Lock, Right } from "@element-plus/icons-vue";
import type { Plan } from "../types";

const props = defineProps<{ modelValue: boolean; plan: Plan | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; confirm: []; enqueue: [] }>();
const planId = computed(() => props.plan?.planId ?? props.plan?.id ?? "—");
const canConfirm = computed(() => props.plan?.status === "DRAFT");
const canEnqueue = computed(() => props.plan?.status === "READY");
</script>

<template>
  <el-drawer :model-value="modelValue" direction="rtl" size="min(620px, 94vw)" :with-header="false" @update:model-value="emit('update:modelValue', $event)">
    <div class="drawer-shell" v-if="plan">
      <div class="drawer-header"><div><div class="eyebrow">FULL EXECUTION CONTRACT</div><h2>View full plan</h2></div><el-button text circle aria-label="Close" @click="emit('update:modelValue', false)"><Close /></el-button></div>
      <div class="drawer-plan-title"><div class="plan-file-icon"><DocumentChecked :size="22" /></div><div><h3>{{ plan.title }}</h3><p>{{ planId }} · Revision {{ plan.revision }}</p></div><el-tag :type="plan.status === 'DRAFT' ? 'warning' : 'success'" effect="light">{{ plan.status }}</el-tag></div>
      <section class="contract-section"><div class="section-heading"><span>01</span><strong>Goal & acceptance</strong></div><p class="contract-goal">{{ plan.goal ?? "Create an ExplorerThread-first workspace that makes plan confirmation and execution status visible." }}</p><ul class="check-list"><li v-for="item in (plan.acceptanceCriteria ?? ['Confirm and enqueue remain separate actions', 'Thread plan projection stays queryable offline', 'Full plan keeps scope and verification evidence'])" :key="item"><span>✓</span>{{ item }}</li></ul></section>
      <section class="contract-section"><div class="section-heading"><span>02</span><strong>Scope</strong></div><div class="scope-grid"><div><label>INCLUDE</label><code v-for="item in (plan.include ?? ['apps/*', 'packages/domain/*'])" :key="item">{{ item }}</code></div><div><label>EXCLUDE</label><code v-for="item in (plan.exclude ?? ['.env*', 'dist/'])" :key="item">{{ item }}</code></div></div></section>
      <section class="contract-section"><div class="section-heading"><span>03</span><strong>Tasks & dependencies</strong></div><div class="task-list"><div v-for="(task, index) in (plan.tasks ?? [{ title: 'Implement ExplorerThread workspace', status: 'ready', dependencies: [] }, { title: 'Expose plan query projection', status: 'pending', dependencies: ['Task 1'] }])" :key="task.title" class="task-row"><span class="task-number">{{ index + 1 }}</span><div><strong>{{ task.title }}</strong><small>{{ task.dependencies.length ? `Depends on ${task.dependencies.join(', ')}` : 'No dependencies' }}</small></div><el-tag size="small" effect="plain">{{ task.status }}</el-tag></div></div></section>
      <section class="contract-section"><div class="section-heading"><span>04</span><strong>Execution policy</strong></div><div class="policy-grid"><div><label>BASE</label><strong>main · HEAD</strong></div><div><label>VERIFICATION</label><strong>{{ (plan.verificationCommands ?? ['pnpm test', 'pnpm typecheck']).join(' · ') }}</strong></div><div><label>TOOL POLICY</label><strong>{{ plan.toolPolicy ?? 'Executor / scoped write' }}</strong></div><div><label>REPAIR LIMIT</label><strong>2 attempts</strong></div></div></section>
      <section class="contract-section source-section"><div class="section-heading"><span>05</span><strong>Source evidence</strong></div><div class="source-row"><span>ExplorerThread</span><code>{{ plan.sourceExplorerThreadId }}</code></div><div class="source-row"><span>Artifact hash</span><code>sha256:9f3e…b812</code></div></section>
      <div class="drawer-actions"><el-button @click="emit('update:modelValue', false)">Keep editing</el-button><el-button v-if="canConfirm" type="primary" @click="emit('confirm')">Confirm plan <Right /></el-button><el-button v-else-if="canEnqueue" type="primary" @click="emit('enqueue')">Enqueue plan <Right /></el-button><div v-else class="locked-action"><Lock :size="14" /> {{ plan.status === 'QUEUED' ? 'Already dispatched' : 'Read only' }}</div></div>
    </div>
  </el-drawer>
</template>
