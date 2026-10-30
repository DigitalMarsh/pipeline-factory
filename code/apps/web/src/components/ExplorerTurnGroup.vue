<!--
  模块职责：探索时间线里的**一个回合块**——回合头（Plan Explorer · 状态 · 时间）+ 可见条目 +
  折叠的「过程 N 步」。

  为什么需要它：扁平时间线让正文、推理、工具调用看起来像三个平级的发言者；实际上它们都属于同一个
  回合（同一个 `turnId`）。这个块把层级显式化：正文是这一回合的产出，推理/工具是过程，收在折叠区里。

  维护提示：
  1. **失败与运行中的过程行不进折叠**（由 `groupExplorerTimeline` 分好）——失败不被折叠吃掉，
     live 内容留在外面；折叠区在回合运行中默认展开，结束后收起。
  2. 回合块本身不带 `data-nav-key`；锚点在每个子行上，`useTimelineScroll` 仍按行定位。
  3. 子行全部用 `ExplorerMessageRow` 的 `grouped` 模式渲染（无角色头像、无外层 gutter），
     层级由「回合头 → 内容列 → 过程行缩进」表达。
-->
<script setup lang="ts">
import { computed } from "vue";
import type { ExplorerActivityItem, Plan } from "../types";
import { assistantActivityLabel } from "../utils/explorerPresentation";
import { statusTagType } from "../utils/statusTag";
import { formatMessageTime } from "../utils/messageTime";
import type { ExplorerTurnBlock } from "../utils/explorerTurnGroups";
import type { ExplorerInputProgress } from "../utils/explorerInputProgressDraft";
import type { ExplorerTimelineItem } from "../utils/explorerTimeline";
import ExplorerMessageRow from "./ExplorerMessageRow.vue";

const props = defineProps<{
  block: ExplorerTurnBlock;
  planForItem: (item: ExplorerTimelineItem) => Plan | null;
  isCandidatePlan: (plan: Plan | null) => boolean;
  busy: boolean;
  pendingInputId: string | null;
  inputProgress: ExplorerInputProgress | null;
  inputAnswerInFlight: string | null;
}>();

const emit = defineEmits<{
  (event: "answer"): void;
  (event: "view-plan", plan: Plan): void;
  (event: "confirm-plan", plan: Plan): void;
  (event: "enqueue-plan", plan: Plan): void;
  (event: "retry", activity: ExplorerActivityItem): void;
}>();

const live = computed(() => props.block.status === "RUNNING" || props.block.status === "WAITING");
const statusLabel = computed(() => assistantActivityLabel({ status: props.block.status }));
const time = computed(() => formatMessageTime(props.block.occurredAt));
</script>

<template>
  <section class="chat-turn" :data-turn-id="block.turnId">
    <header class="chat-turn-head">
      <span class="chat-avatar chat-avatar-explorer" aria-hidden="true">探</span>
      <div class="chat-meta">
        <strong class="chat-author">Plan Explorer</strong>
        <el-tag size="small" effect="light" :type="statusTagType(block.status)">{{ statusLabel }}</el-tag>
        <time class="chat-time" :datetime="block.occurredAt">{{ time }}</time>
      </div>
    </header>
    <div class="chat-turn-body">
      <ExplorerMessageRow
        v-for="entry in block.visible"
        :key="entry.item.key"
        grouped
        :item="entry.item"
        :index="entry.index"
        :plan="planForItem(entry.item)"
        :is-candidate-plan="isCandidatePlan(planForItem(entry.item))"
        :busy="busy"
        :pending-input-id="pendingInputId"
        :input-progress="inputProgress"
        :input-answer-in-flight="inputAnswerInFlight"
        @answer="emit('answer')"
        @view-plan="emit('view-plan', $event)"
        @confirm-plan="emit('confirm-plan', $event)"
        @enqueue-plan="emit('enqueue-plan', $event)"
        @retry="emit('retry', $event)"
      />
      <details v-if="block.folded.length" class="chat-turn-fold" :open="live">
        <summary>过程 {{ block.folded.length }} 步</summary>
        <div class="chat-turn-fold-body">
          <ExplorerMessageRow
            v-for="entry in block.folded"
            :key="entry.item.key"
            grouped
            :item="entry.item"
            :index="entry.index"
            :plan="planForItem(entry.item)"
            :is-candidate-plan="isCandidatePlan(planForItem(entry.item))"
            :busy="busy"
            :pending-input-id="pendingInputId"
            :input-progress="inputProgress"
            :input-answer-in-flight="inputAnswerInFlight"
            @answer="emit('answer')"
            @view-plan="emit('view-plan', $event)"
            @confirm-plan="emit('confirm-plan', $event)"
            @enqueue-plan="emit('enqueue-plan', $event)"
            @retry="emit('retry', $event)"
          />
        </div>
      </details>
    </div>
  </section>
</template>
