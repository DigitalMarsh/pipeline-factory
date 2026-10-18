<!--
  模块职责：呈现当前 ExplorerThread 的需求、Plan 状态和 Run 状态入口。
  维护提示：行数据由 ExplorerView 按当前线程投影，组件不加载其他线程内容。
-->
<script setup lang="ts">
import { Delete, Document, EditPen, Plus } from "@element-plus/icons-vue";
import type { ExplorerRequirementRow } from "../utils/explorerRequirementRows";
import { requirementStatusTagType } from "../utils/statusTag";

defineProps<{
  rows: ExplorerRequirementRow[];
  activeExplorerPlanId: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  add: [];
  /** 双击整行：打开右侧抽屉并落在「探索对话」页签。 */
  open: [explorerPlanId: string];
  select: [explorerPlanId: string];
  explore: [explorerPlanId: string];
  viewPlan: [explorerPlanId: string];
  openTask: [explorerPlanId: string];
  rename: [explorerPlanId: string];
  remove: [explorerPlanId: string];
}>();

/**
 * 双击行 = 打开这一行的探索对话。
 *
 * 行内的动作按钮（删除 / 重命名 / 方案状态 / 查看 Vn / 任务状态）要排除：在它们上面双击
 * 是"连点了两下按钮"，再顺手把抽屉打开等于替用户做了一个他没要求的动作。
 */
function onRowDoubleClick(event: MouseEvent, explorerPlanId: string): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-requirement-action="delete"], .requirement-rename-button, .requirement-status-button, .requirement-plan-link'))
    return;
  emit("open", explorerPlanId);
}
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
          title="双击打开探索对话"
          @dblclick="onRowDoubleClick($event, row.explorerPlan.id)"
        >
          <div class="requirement-cell requirement-name-cell" role="cell">
            <button
              class="requirement-name-button"
              type="button"
              :aria-current="row.explorerPlan.id === activeExplorerPlanId ? 'true' : undefined"
              @click="emit('select', row.explorerPlan.id)"
            >
              <span class="requirement-ordinal">{{ row.explorerPlan.ordinal }}</span>
              <span class="requirement-name-copy">
                <strong>{{ row.title }}</strong>
                <small>{{ row.explorerPlan.latestUserMessageSummary ?? "尚未开始探索" }}</small>
              </span>
            </button>
            <button
              class="requirement-rename-button"
              type="button"
              :aria-label="`重命名${row.title}`"
              :disabled="disabled"
              @click="emit('rename', row.explorerPlan.id)"
            >
              <EditPen :size="14" />
            </button>
            <!--
              「删除」不能像重命名那样只发个事件就走：它不可恢复（方案、Run、执行日志一起没），
              确认框与错误提示都在 ExplorerView 里——**能不能删也由服务端说了算**，
              前端不预判（预判就等于把"哪些 Run 状态算在跑"抄成第二份事实来源）。
            -->
            <button
              class="requirement-delete-button"
              type="button"
              data-requirement-action="delete"
              :aria-label="`删除${row.title}`"
              :disabled="disabled"
              @click="emit('remove', row.explorerPlan.id)"
            >
              <Delete :size="14" />
            </button>
          </div>
          <div class="requirement-cell" role="cell">
            <!--
              状态标签下面那行是**这条探索线程实际用的 agent**（后端取项目配置、模型取最近一次 loop
              的记录）。它和"任务状态"下面那行（那条 Run 执行线程的 telemetry）是两个不同的来源，
              所以分别在各自那一格里显示，而不是合成一行。
            -->
            <div class="requirement-status-stack">
              <button
                type="button"
                class="requirement-status-button"
                :aria-label="`${row.title}，Plan 状态：${row.planStatus.label}${row.planAgent ? `，探索 Agent：${row.planAgent}` : ''}，打开探索对话`"
                @click="emit('explore', row.explorerPlan.id)"
              >
                <el-tag size="small" effect="light" :type="requirementStatusTagType(row.planStatus.tone)">{{
                  row.planStatus.label
                }}</el-tag>
              </button>
              <span v-if="row.planAgent" class="requirement-agent" :title="row.planAgent">{{ row.planAgent }}</span>
            </div>
          </div>
          <div class="requirement-cell" role="cell">
            <button
              v-if="row.plan"
              class="requirement-plan-link"
              type="button"
              :aria-label="`查看 ${row.title} 的结构化 Plan，第 ${row.plan.revision} 版`"
              @click="emit('viewPlan', row.explorerPlan.id)"
            >
              <Document :size="15" /> 查看 V{{ row.plan.revision }}
            </button>
            <span v-else class="requirement-unavailable" aria-label="尚无结构化 Plan">—</span>
          </div>
          <div class="requirement-cell" role="cell">
            <div class="requirement-status-stack">
              <button
                v-if="row.taskStatus.label !== '—'"
                type="button"
                class="requirement-status-button"
                :aria-label="`${row.title}，任务状态：${row.taskStatus.label}${row.taskAgent ? `，执行 Agent：${row.taskAgent}` : ''}，打开 Run`"
                @click="emit('openTask', row.explorerPlan.id)"
              >
                <el-tag size="small" effect="light" :type="requirementStatusTagType(row.taskStatus.tone)">{{
                  row.taskStatus.label
                }}</el-tag>
              </button>
              <span v-else class="requirement-unavailable">—</span>
              <span v-if="row.taskAgent" class="requirement-agent" :title="row.taskAgent">{{ row.taskAgent }}</span>
            </div>
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
