<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import type { CodexRateLimitsStatus } from "../types";
import { formatRateLimit } from "../utils/explorerStatus";

const props = withDefaults(defineProps<{
  model: string;
  context: string;
  contextNote?: string;
}>(), {
  contextNote: "",
});

const rateLimitStatus = ref<CodexRateLimitsStatus | null>(null);
const rateLimitLoading = ref(false);

const rateLimits = computed(() => ({
  fiveHour: formatRateLimit(rateLimitStatus.value?.fiveHour ?? null),
  sevenDay: formatRateLimit(rateLimitStatus.value?.sevenDay ?? null),
  fiveHourResetAt: rateLimitStatus.value?.fiveHour?.resetAt ?? null,
  sevenDayResetAt: rateLimitStatus.value?.sevenDay?.resetAt ?? null,
}));
const rateLimitNote = computed(() => rateLimitStatus.value?.available
  ? "数据来自 Codex App Server 的精确窗口。"
  : rateLimitStatus.value?.reason ?? "当前服务未提供 Codex 速率限制遥测。");

async function loadRateLimits(): Promise<void> {
  if (rateLimitLoading.value) return;
  rateLimitLoading.value = true;
  try {
    rateLimitStatus.value = (await api.codexRateLimits()).rateLimits;
  } catch {
    rateLimitStatus.value = null;
  } finally {
    rateLimitLoading.value = false;
  }
}

function limitValue(limit: { remaining: string; reset: string; resetAt?: string | null }): { remaining: string; reset: string; resetAt?: string | null } {
  return rateLimitLoading.value ? { remaining: "加载中…", reset: "", resetAt: null } : limit;
}

onMounted(() => { void loadRateLimits(); });
</script>

<template>
  <div class="provider-usage-footer" aria-label="模型、上下文与限额信息">
    <span class="provider-usage-fact">
      <small>MODEL</small>
      <strong :title="props.model">{{ props.model }}</strong>
    </span>
    <span class="provider-usage-fact">
      <small>CONTEXT</small>
      <strong :title="props.context">{{ props.context }}</strong>
      <em v-if="props.contextNote">{{ props.contextNote }}</em>
    </span>
    <div class="provider-usage-limits" :title="rateLimitNote" aria-label="Codex usage limits">
      <span class="provider-usage-limit">
        <small>5 小时限额</small>
        <strong>{{ limitValue(rateLimits.fiveHour).remaining }}</strong>
        <time v-if="limitValue(rateLimits.fiveHour).reset" :datetime="rateLimits.fiveHourResetAt ?? undefined" :title="rateLimits.fiveHourResetAt ?? undefined">{{ limitValue(rateLimits.fiveHour).reset }}</time>
      </span>
      <span class="provider-usage-limit">
        <small>7 天限额</small>
        <strong>{{ limitValue(rateLimits.sevenDay).remaining }}</strong>
        <time v-if="limitValue(rateLimits.sevenDay).reset" :datetime="rateLimits.sevenDayResetAt ?? undefined" :title="rateLimits.sevenDayResetAt ?? undefined">{{ limitValue(rateLimits.sevenDay).reset }}</time>
      </span>
    </div>
  </div>
</template>
