<script setup lang="ts">
import { ref } from "vue";
import { Bell, FolderOpened, Help, Search } from "@element-plus/icons-vue";

const helpOpen = ref(false);
const notificationsOpen = ref(false);
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-mark"><span class="brand-dot" /> Pipeline Factory <small>v3</small></div>
      <div class="topbar-project"><FolderOpened :size="15" /> <span>project-demo</span><span class="project-live">● Active</span></div>
      <div class="topbar-actions">
        <div class="global-search"><Search :size="15" /><span>Search plans, runs, threads</span><kbd>⌘ K</kbd></div>
        <el-tooltip content="System healthy"><span class="system-health"><i /> Healthy</span></el-tooltip>
        <el-button text circle aria-label="Help" @click="helpOpen = true"><Help :size="17" /></el-button>
        <el-button text circle aria-label="Notifications" @click="notificationsOpen = true"><Bell :size="17" /></el-button>
        <div class="avatar">LS</div>
      </div>
    </header>
    <main class="page-frame"><router-view /></main>

    <el-drawer v-model="helpOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">PIPELINE FACTORY · HELP</div><h2>How this workspace works</h2></div><el-button text circle aria-label="Close help" @click="helpOpen = false">×</el-button></div>
        <div class="help-card"><strong>Explore first</strong><p>Use the ExplorerThread to inspect the repository and shape a CandidatePlan. Explorer remains read only until you confirm and enqueue the plan.</p></div>
        <div class="help-card"><strong>Follow execution</strong><p>Each dispatched plan gets its own Run and ExecutionThread. Pause, guide, verify and review the run from its detail page.</p></div>
        <div class="help-card"><strong>Need assistance?</strong><p>Use the project settings page to review lifecycle hooks and the Plan Center to find every dispatched plan.</p></div>
      </div>
    </el-drawer>

    <el-drawer v-model="notificationsOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">ACTIVITY CENTER</div><h2>Notifications</h2></div><el-button text circle aria-label="Close notifications" @click="notificationsOpen = false">×</el-button></div>
        <div class="notification-item"><span class="notification-dot success" /><div><strong>Factory is healthy</strong><p>API and web workspace are available.</p><small>Now</small></div></div>
        <div class="notification-item"><span class="notification-dot" /><div><strong>Explorer policy active</strong><p>Write, shell, test and commit tools are disabled in Plan Mode.</p><small>Now</small></div></div>
        <div class="notification-empty">No additional notifications.</div>
      </div>
    </el-drawer>
  </div>
</template>
