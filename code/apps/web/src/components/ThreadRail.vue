<script setup lang="ts">
import { computed } from "vue";
import { ChatDotRound, CircleCheck, Clock, Connection, Files, Setting, Warning } from "@element-plus/icons-vue";
import type { ExplorerThread } from "../types";

const props = defineProps<{ thread: ExplorerThread | null; candidateCount?: number; dispatchedCount?: number; activeRunCount?: number; needsAttentionCount?: number }>();
const emit = defineEmits<{ "open-history": [] }>();
const explorerQuery = computed(() => props.thread ? `?explorerId=${encodeURIComponent(props.thread.id)}` : "");
</script>

<template>
  <aside class="thread-rail">
    <div class="rail-project">
      <div class="project-icon">PF</div>
      <div><strong>{{ thread?.projectId ?? "project-demo" }}</strong><small>Local workspace</small></div>
      <span class="chevron">⌄</span>
    </div>
    <div class="rail-label">EXPLORER THREAD</div>
    <div class="thread-identity">
      <div class="thread-icon"><Connection :size="16" /></div>
      <div class="thread-copy"><strong>{{ thread?.title ?? "探索线程" }}</strong><small>{{ thread?.id ?? "thread-demo" }}</small></div>
      <span class="live-dot" />
    </div>
    <div class="thread-meta"><span>{{ thread?.messageCount ?? 8 }} messages</span><span>Just now</span></div>
    <button class="thread-history-button" type="button" aria-label="Open Explorer history" @click="emit('open-history')"><Connection :size="14" /> Explorer history <span>›</span></button>
    <nav class="rail-nav" aria-label="ExplorerThread navigation">
      <RouterLink class="rail-link active" :to="`/projects/${thread?.projectId ?? 'project-demo'}/explorer${explorerQuery}`"><ChatDotRound :size="16" /> Conversation <span class="nav-count">{{ thread?.messageCount ?? 0 }}</span></RouterLink>
      <RouterLink class="rail-link" :to="`/projects/${thread?.projectId ?? 'project-demo'}/explorer${explorerQuery}#candidate`"><Files :size="16" /> Plan candidates <span class="nav-count">{{ candidateCount ?? 0 }}</span></RouterLink>
      <RouterLink class="rail-link" :to="`/projects/${thread?.projectId ?? 'project-demo'}/plans`"><CircleCheck :size="16" /> Dispatched plans <span class="nav-count muted-count">{{ dispatchedCount ?? 0 }}</span></RouterLink>
      <RouterLink class="rail-link" :to="`/projects/${thread?.projectId ?? 'project-demo'}/plans?status=IN_PROGRESS`"><Clock :size="16" /> Active runs <span class="nav-count muted-count">{{ activeRunCount ?? 0 }}</span></RouterLink>
      <RouterLink class="rail-link needs" :to="`/projects/${thread?.projectId ?? 'project-demo'}/plans?status=BLOCKED`"><Warning :size="16" /> Needs attention <span class="warning-count">{{ needsAttentionCount ?? 0 }}</span></RouterLink>
    </nav>
    <div class="rail-section">
      <div class="rail-section-title">THREAD MEMORY</div>
      <RouterLink class="rail-link subdued" :to="`/projects/${thread?.projectId ?? 'project-demo'}/explorer${explorerQuery}#successors`"><Connection :size="15" /> Successor threads <span>›</span></RouterLink>
      <RouterLink class="rail-link subdued" :to="`/projects/${thread?.projectId ?? 'project-demo'}/explorer${explorerQuery}#summary`"><Files :size="15" /> Context summary <span>›</span></RouterLink>
    </div>
    <div class="rail-bottom"><RouterLink :to="`/projects/${thread?.projectId ?? 'project-demo'}/settings/hooks`" class="rail-link subdued"><Setting :size="16" /> Project settings</RouterLink></div>
  </aside>
</template>
