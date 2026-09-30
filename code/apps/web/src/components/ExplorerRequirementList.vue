<!--
  模块职责：呈现当前 ExplorerThread 的需求、Plan 状态和 Run 状态入口。
  维护提示：行数据由 ExplorerView 按当前线程投影，组件不加载其他线程内容。
-->
<script setup lang="ts">
import { Document, EditPen, Plus } from "@element-plus/icons-vue";
import type { ExplorerRequirementRow } from "../utils/explorerRequirementRows";

defineProps<{
  rows: ExplorerRequirementRow[];
  activeExplorerPlanId: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  add: [];
  select: [explorerPlanId: string];
  explore: [explorerPlanId: string];
  viewPlan: [explorerPlanId: string];
  openTask: [explorerPlanId: string];
  rename: [explorerPlanId: string];
}>();
</script>

<template>
  <section class="requirement-list-panel" aria-labelledby="requirement-list-title">
    <header class="requirement-list-header">
      <div>
        <h2 id="requirement-list-title">需求清单</h2>
      </div>
      <el-button type="primary" :disabled="disabled" data-requirement-action="add" @click="emit('add')">
        <Plus :size="16" /> 新增需求
      </el-button>
    </header>

    <div v-if="rows.length" class="requirement-table-wrap">
      <div class="requirement-table" role="table" aria-label="当前探索线程的需求清单">
        <div class="requirement-table-head" role="row">
          <span role="columnheader">需求名称</span>
          <span role="columnheader">方案状态</span>
          <span role="columnheader">方案契约</span>
          <span role="columnheader">任务状态</span>
        </div>
        <article
          v-for="row in rows"
          :key="row.explorerPlan.id"
          :class="['requirement-table-row', { active: row.explorerPlan.id === activeExplorerPlanId }]"
          role="row"
          :data-explorer-plan-id="row.explorerPlan.id"
        >
          <div class="requirement-cell requirement-name-cell" role="cell">
            <button class="requirement-name-button" type="button" :aria-current="row.explorerPlan.id === activeExplorerPlanId ? 'true' : undefined" @click="emit('select', row.explorerPlan.id)">
              <span class="requirement-ordinal">{{ row.explorerPlan.ordinal }}</span>
              <span class="requirement-name-copy">
                <strong>{{ row.title }}</strong>
                <small>{{ row.explorerPlan.latestUserMessageSummary ?? '尚未开始探索' }}</small>
              </span>
            </button>
            <button class="requirement-rename-button" type="button" :aria-label="`重命名${row.title}`" :disabled="disabled" @click="emit('rename', row.explorerPlan.id)"><EditPen :size="14" /></button>
          </div>
          <div class="requirement-cell" role="cell">
            <button
              type="button"
              :class="['requirement-status-button', `tone-${row.planStatus.tone}`]"
              :aria-label="`${row.title}，Plan 状态：${row.planStatus.label}，打开探索对话`"
              @click="emit('explore', row.explorerPlan.id)"
            >{{ row.planStatus.label }}</button>
          </div>
          <div class="requirement-cell" role="cell">
            <button
              v-if="row.plan"
              class="requirement-plan-link"
              type="button"
              :aria-label="`查看 ${row.title} 的结构化 Plan，第 ${row.plan.revision} 版`"
              @click="emit('viewPlan', row.explorerPlan.id)"
            ><Document :size="15" /> 查看 V{{ row.plan.revision }}</button>
            <span v-else class="requirement-unavailable" aria-label="尚无结构化 Plan">—</span>
          </div>
          <div class="requirement-cell" role="cell">
            <button
              v-if="row.taskStatus.label !== '—'"
              type="button"
              :class="['requirement-status-button', `tone-${row.taskStatus.tone}`]"
              :aria-label="`${row.title}，任务状态：${row.taskStatus.label}，打开 Run`"
              @click="emit('openTask', row.explorerPlan.id)"
            >{{ row.taskStatus.label }}</button>
            <span v-else class="requirement-unavailable">—</span>
          </div>
        </article>
      </div>
    </div>
    <div v-else class="requirement-list-empty" data-requirement-empty>
      <div class="requirement-empty-mark"><Document :size="22" /></div>
      <strong>这个探索线程还没有需求</strong>
      <p>新增需求后，探索对话、结构化 Plan 和执行状态会归入同一条记录。</p>
    </div>
  </section>
</template>
