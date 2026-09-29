<script setup lang="ts">
import PlanDetailContent from "./PlanDetailContent.vue";
import type { Plan } from "../types";

const props = defineProps<{ modelValue: boolean; plan: Plan | null; error?: string | null; revisions?: number[]; revisionDraftStatus?: "EDITING" | "READY_TO_CONFIRM" | "CONFIRMED" | "DISCARDED" | "BASE_CHANGED" | null; readOnly?: boolean; dependencyOptions?: Array<{ id: string; title: string }>; canEditDependencies?: boolean; dependenciesSaving?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; confirm: []; discard: []; "keep-editing": [plan: Plan]; "select-revision": [revision: number]; "update-dependencies": [planIds: string[]] }>();
</script>

<template>
  <el-drawer :model-value="props.modelValue" direction="rtl" size="min(620px, 94vw)" :with-header="false" @update:model-value="emit('update:modelValue', $event)">
    <PlanDetailContent :plan="props.plan" :error="props.error" :revisions="props.revisions" :revision-draft-status="props.revisionDraftStatus" :read-only="props.readOnly" :dependency-options="props.dependencyOptions" :can-edit-dependencies="props.canEditDependencies" :dependencies-saving="props.dependenciesSaving" @close="emit('update:modelValue', false)" @confirm="emit('confirm')" @discard="emit('discard')" @keep-editing="emit('keep-editing', $event)" @select-revision="emit('select-revision', $event)" @update-dependencies="emit('update-dependencies', $event)" />
  </el-drawer>
</template>
