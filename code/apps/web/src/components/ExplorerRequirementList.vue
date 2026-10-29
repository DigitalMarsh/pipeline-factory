<!--
  模块职责：呈现当前 ExplorerThread 的需求、Plan 状态和 Run 状态入口。
  维护提示：行数据由 ExplorerView 按当前线程投影，组件不加载其他线程内容。

  交互约定（2026-10 易用性调整）：
  1) **单击需求名就是打开探索对话**——不再要求双击；双击是隐藏手势，第一次用的人找不到。
  2) 重命名 / 删除常显（低强调 + hover 提亮），命中区 ≥28px；只在 hover 出现意味着触屏永远看不到。
  3) 失败的需求给一个「查看并重试」主操作，而不是让用户自己猜状态标签可以点。
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { Delete, Document, EditPen, Plus } from "@element-plus/icons-vue";
import type { ExplorerRequirementRow } from "../utils/explorerRequirementRows";
import { requirementStatusTagType } from "../utils/statusTag";

const props = defineProps<{
  rows: ExplorerRequirementRow[];
  activeExplorerPlanId: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  add: [];
  /** 打开一条需求的探索对话（单击行、方案状态按钮、失败行的「查看并重试」都走这里）。 */
  explore: [explorerPlanId: string];
  viewPlan: [explorerPlanId: string];
  openTask: [explorerPlanId: string];
  rename: [explorerPlanId: string];
  remove: [explorerPlanId: string];
}>();

/** 列表内筛选：需求多起来之后，肉眼在四列里找一条太慢。 */
const filter = ref("");
const visibleRows = computed(() => {
  const keyword = filter.value.trim().toLowerCase();
  if (!keyword) return props.rows;
  return props.rows.filter((row) =>
    [row.title, row.explorerPlan.latestUserMessageSummary ?? "", row.planStatus.label, row.planAgent ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(keyword),
  );
});
</script>

<template>
  <section class="requirement-list-panel" aria-labelledby="requirement-list-title">
    <header class="requirement-list-header">
      <div>
        <h2 id="requirement-list-title">需求清单</h2>
      </div>
      <div class="requirement-list-tools">
        <input v-model="filter" class="requirement-filter" type="search" placeholder="筛选需求…" aria-label="筛选需求" />
        <el-button type="primary" :disabled="disabled" data-requirement-action="add" @click="emit('add')">
          <Plus :size="16" /> 新增需求
        </el-button>
      </div>
    </header>

    <div v-if="visibleRows.length" class="requirement-table-wrap">
      <div class="requirement-table" role="table" aria-label="当前探索线程的需求清单">
        <div class="requirement-table-head" role="row">
          <span role="columnheader">需求名称</span>
          <span role="columnheader">方案状态</span>
          <span role="columnheader">方案契约</span>
          <span role="columnheader">任务状态</span>
        </div>
        <article
          v-for="row in visibleRows"
          :key="row.explorerPlan.id"
          :class="['requirement-table-row', { active: row.explorerPlan.id === activeExplorerPlanId }]"
          role="row"
          :data-explorer-plan-id="row.explorerPlan.id"
        >
          <div class="requirement-cell requirement-name-cell" role="cell">
            <button
              class="requirement-name-button"
              type="button"
              :aria-current="row.explorerPlan.id === activeExplorerPlanId ? 'true' : undefined"
              @click="emit('explore', row.explorerPlan.id)"
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
              <!-- 失败的行需要有主操作：状态标签可以点这件事，不写出来没人知道。 -->
              <button
                v-if="row.planStatus.tone === 'danger'"
                type="button"
                class="requirement-retry-action"
                data-requirement-action="retry"
                :aria-label="`查看并重试${row.title}`"
                @click="emit('explore', row.explorerPlan.id)"
              >
                查看并重试
              </button>
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
    <div v-if="rows.length && !visibleRows.length" class="requirement-list-empty" data-requirement-empty>
      <div class="requirement-empty-mark"><Document :size="22" /></div>
      <strong>没有匹配的需求</strong>
      <p>换个关键词试试，或清除筛选查看全部 {{ rows.length }} 条需求。</p>
      <button type="button" class="requirement-empty-reset" @click="filter = ''">清除筛选</button>
    </div>
    <div v-else-if="!rows.length" class="requirement-list-empty" data-requirement-empty>
      <div class="requirement-empty-mark"><Document :size="22" /></div>
      <strong>这个探索线程还没有需求</strong>
      <p>新增需求后，探索对话、结构化 Plan 和执行状态会归入同一条记录。</p>
    </div>
  </section>
</template>
