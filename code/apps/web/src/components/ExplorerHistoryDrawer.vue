<!--
  模块职责：展示 ExplorerThread 历史并处理线程切换入口。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed } from "vue";
import { ChatDotRound, CircleCheck, Connection, Plus, Right, Warning } from "@element-plus/icons-vue";
import type { ExplorerThread } from "../types";

const props = defineProps<{
  modelValue: boolean;
  explorers: ExplorerThread[];
  currentId: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  select: [explorerId: string];
  create: [];
  archive: [explorerId: string];
  activate: [explorerId: string];
}>();

const activeExplorers = computed(() => props.explorers.filter((item) => item.state !== "ARCHIVED"));
const archivedExplorers = computed(() => props.explorers.filter((item) => item.state === "ARCHIVED"));

function close() {
  emit("update:modelValue", false);
}

/** 选择线程后由父视图重新加载全部 Project-scoped 数据。 */
function select(explorerId: string) {
  emit("select", explorerId);
  close();
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function displayTitle(item: ExplorerThread) {
  return item.title || "探索线程";
}
</script>

<template>
  <el-drawer :model-value="modelValue" direction="ltr" size="min(390px, 92vw)" :with-header="false" @update:model-value="emit('update:modelValue', $event)">
    <div class="explorer-history-shell">
      <div class="drawer-header">
        <div>
          <div class="eyebrow">EXPLORER WORKSPACES</div>
          <h2>探索记录</h2>
          <p class="drawer-subtitle">每个新 Explorer 都从干净上下文开始。</p>
        </div>
        <el-button text circle aria-label="Close explorer history" @click="close">×</el-button>
      </div>

      <el-button class="history-create" type="primary" @click="emit('create')"><Plus :size="15" /> 新建 Explorer</el-button>

      <section class="explorer-history-section">
        <div class="history-section-title"><span>当前与历史</span><strong>{{ activeExplorers.length }}</strong></div>
        <div v-for="item in activeExplorers" :key="item.id" :class="['explorer-history-item', { active: item.id === currentId }]">
          <span class="history-item-icon"><Connection :size="15" /></span>
          <button class="history-item-select" type="button" @click="select(item.id)"><span class="history-item-copy"><strong>{{ displayTitle(item) }}</strong><small>{{ item.id }} · {{ item.messageCount }} messages</small><small>{{ formatTime(item.lastActivityAt) }}</small></span></button>
          <span v-if="item.state === 'WAITING_FOR_INPUT'" class="history-item-status waiting"><Warning :size="13" /></span>
          <span v-else-if="item.id === currentId" class="history-item-status current"><CircleCheck :size="13" /></span>
          <Right :size="14" />
          <button class="history-item-action" type="button" aria-label="Archive Explorer" @click.stop="emit('archive', item.id)">Archive</button>
        </div>
        <div v-if="!activeExplorers.length" class="history-empty"><ChatDotRound :size="22" /><strong>还没有探索记录</strong><span>创建一个 Explorer 开始全新的需求探索。</span></div>
      </section>

      <section v-if="archivedExplorers.length" class="explorer-history-section archived-history-section">
        <div class="history-section-title"><span>已归档</span><strong>{{ archivedExplorers.length }}</strong></div>
        <div v-for="item in archivedExplorers" :key="item.id" class="explorer-history-item archived">
          <span class="history-item-icon"><Connection :size="15" /></span>
          <button class="history-item-select" type="button" @click="select(item.id)"><span class="history-item-copy"><strong>{{ displayTitle(item) }}</strong><small>{{ item.id }} · {{ item.messageCount }} messages</small><small>{{ formatTime(item.lastActivityAt) }}</small></span></button>
          <Right :size="14" />
          <button class="history-item-action" type="button" aria-label="Activate Explorer" @click.stop="emit('activate', item.id)">Activate</button>
        </div>
      </section>
    </div>
  </el-drawer>
</template>
