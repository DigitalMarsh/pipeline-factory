<script setup lang="ts">
import { computed } from "vue";
import { Check, Right, Warning } from "@element-plus/icons-vue";
import type { Plan, ExecutionThreadSummary, PlanLifecycleEntry, PlanLifecycleStatus } from "../types";
import { fullLifecycleTime, lifecycleEntriesFor, lifecycleLabel, PLAN_LIFECYCLE_EXCEPTIONS, PLAN_LIFECYCLE_STEPS, formatLifecycleTime } from "../utils/planLifecycle";

const props = defineProps<{
  plan: Plan;
  executionThread?: ExecutionThreadSummary;
}>();

const emit = defineEmits<{
  select: [plan: Plan, event: MouseEvent];
  "view-details": [plan: Plan];
  "open-run": [plan: Plan];
}>();

const entries = computed(() => lifecycleEntriesFor(props.plan));
const thread = computed(() => props.executionThread ?? props.plan.executionThread ?? null);

const lifecycleNodes = computed(() => PLAN_LIFECYCLE_STEPS.map((step) => ({ ...step })));
const exceptionEntries = computed(() => entries.value.filter((entry) => PLAN_LIFECYCLE_EXCEPTIONS.some((exception) => exception.status === entry.status)));
const currentException = computed(() => exceptionEntries.value.find((entry) => entry.current) ?? exceptionEntries.value.at(-1) ?? null);
const exceptionLabel = computed(() => currentException.value ? lifecycleLabel(currentException.value.status) : "");
const exceptionMessage = computed(() => currentException.value ? exceptionReason(currentException.value) : "");
const hasRun = computed(() => Boolean(props.plan.runId ?? props.plan.dispatch?.runId ?? thread.value?.runId));

const lifecycleRows = computed(() => {
  const rows: Array<{
    nodes: typeof lifecycleNodes.value;
    reverse: boolean;
    style: Record<string, string>;
  }> = [];

  for (let index = 0; index < lifecycleNodes.value.length; index += 4) {
    const nodes = lifecycleNodes.value.slice(index, index + 4);
    const reverse = rows.length % 2 === 1;
    const firstColumn = reverse ? 4 - nodes.length : 0;
    const lastColumn = reverse ? 3 : nodes.length - 1;
    const turnColumn = reverse ? firstColumn : lastColumn;

    rows.push({
      nodes,
      reverse,
      style: {
        "--task-lifecycle-turn-position": `${(turnColumn + 0.5) * 25}%`,
      },
    });
  }

  return rows;
});

function entryFor(status: PlanLifecycleStatus): PlanLifecycleEntry | undefined {
  return entries.value.find((entry) => entry.status === status);
}

function stateFor(status: PlanLifecycleStatus): "complete" | "current" | "pending" {
  const entry = entryFor(status);
  if (!entry) return "pending";
  return entry.current ? "current" : "complete";
}

function connectorStyle(reverse: boolean, connectorIndex: number): Record<string, string> {
  const column = reverse ? 2 - connectorIndex : connectorIndex;
  return { left: `${(column + 0.5) * 25}%` };
}

function exceptionReason(entry: PlanLifecycleEntry): string {
  return entry.reason ?? props.plan.attentionReason ?? props.plan.dispatch?.lastError ?? lifecycleLabel(entry.status);
}

function displayTime(entry: PlanLifecycleEntry | undefined): string {
  return formatLifecycleTime(entry?.occurredAt);
}

</script>

<template>
  <article class="task-lifecycle-card context-plan-card-clickable" role="listitem" @click="emit('select', plan, $event)">
    <header class="task-lifecycle-card-head">
      <div class="task-lifecycle-card-heading">
        <div class="task-lifecycle-card-title-row">
          <strong class="task-lifecycle-card-title" :title="plan.title">{{ plan.title }}</strong>
          <span class="task-lifecycle-card-version">V{{ plan.revision }}</span>
        </div>
      </div>
    </header>

    <div class="task-lifecycle-timeline" role="list" aria-label="Plan lifecycle">
      <div
        v-for="(row, rowIndex) in lifecycleRows"
        :key="`lifecycle-row-${rowIndex}`"
        :class="['task-lifecycle-row', { 'task-lifecycle-row-reverse': row.reverse }]"
        :style="row.style"
      >
        <span
          v-for="(_step, connectorIndex) in row.nodes.slice(0, -1)"
          :key="`lifecycle-connector-${rowIndex}-${connectorIndex}`"
          class="task-lifecycle-row-connector"
          :style="connectorStyle(row.reverse, connectorIndex)"
          aria-hidden="true"
        >
          <span class="task-lifecycle-row-connector-arrow" />
        </span>
        <span v-if="rowIndex < lifecycleRows.length - 1" class="task-lifecycle-row-turn" aria-hidden="true">
          <span class="task-lifecycle-row-turn-arrow" />
        </span>
        <div
          v-for="step in row.nodes"
          :key="step.status"
          :class="['task-lifecycle-step', `task-lifecycle-step-${stateFor(step.status)}`]"
          role="listitem"
          :aria-label="`${step.label}: ${displayTime(entryFor(step.status))}`"
        >
          <span class="task-lifecycle-step-copy">
            <span class="task-lifecycle-step-label" :title="step.label">{{ step.label }}</span>
          </span>
          <span class="task-lifecycle-step-dot" aria-hidden="true"><Check v-if="stateFor(step.status) !== 'pending'" :size="10" /></span>
          <time class="task-lifecycle-step-time" :datetime="entryFor(step.status)?.occurredAt ?? undefined" :title="fullLifecycleTime(entryFor(step.status)?.occurredAt)">{{ displayTime(entryFor(step.status)) }}</time>
        </div>
      </div>
    </div>

    <section v-if="currentException" class="task-lifecycle-exception" role="alert" :aria-label="`${exceptionLabel}: ${exceptionMessage}`">
      <span class="task-lifecycle-exception-icon" aria-hidden="true"><Warning :size="15" /></span>
      <div class="task-lifecycle-exception-copy">
        <div class="task-lifecycle-exception-heading"><strong>{{ exceptionLabel }}</strong><span class="task-lifecycle-exception-current">CURRENT</span></div>
        <p :title="exceptionMessage">{{ exceptionMessage }}</p>
      </div>
    </section>

    <footer class="task-lifecycle-card-footer task-lifecycle-navigation">
      <button type="button" class="task-lifecycle-details" aria-label="查看任务详情" @click.stop="emit('view-details', plan)">View plan <Right :size="14" /></button>
      <div class="task-lifecycle-footer-actions">
        <slot name="actions" :plan="plan" />
      </div>
      <button v-if="hasRun" type="button" class="task-lifecycle-run" aria-label="查看运行" @click.stop="emit('open-run', plan)">View run <Right :size="14" /></button>
      <button v-else type="button" class="task-lifecycle-run task-lifecycle-run-disabled" aria-label="查看运行" title="尚未创建运行" disabled>View run <Right :size="14" /></button>
    </footer>
  </article>
</template>
