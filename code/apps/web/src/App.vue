<!--
  模块职责：提供控制台根布局和全局导航容器。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Bell, Help, Search } from "@element-plus/icons-vue";
import { api } from "./api";
import { projectModuleForPath } from "./utils/projectRoutes";
import { apiHealthVisual, classifyApiHealth, type ApiHealthState } from "./utils/apiHealth";

const helpOpen = ref(false);
const notificationsOpen = ref(false);
const apiHealthState = ref<ApiHealthState>("checking");
const apiHealthInFlight = ref(false);
let apiHealthTimer: ReturnType<typeof setInterval> | null = null;

const apiHealth = computed(() => apiHealthVisual(apiHealthState.value));

async function checkApiHealth(): Promise<void> {
  if (apiHealthInFlight.value) return;
  apiHealthInFlight.value = true;
  apiHealthState.value = "checking";
  try {
    apiHealthState.value = classifyApiHealth(await api.health());
  } catch {
    apiHealthState.value = "unavailable";
  } finally {
    apiHealthInFlight.value = false;
  }
}

function workspaceViewKey(viewRoute: { path: string; params: Record<string, unknown> }): string {
  const projectId = typeof viewRoute.params.projectId === "string" ? viewRoute.params.projectId : "catalog";
  const module = projectModuleForPath(viewRoute.path);
  return module === "explore" ? module : module ? `${module}:${projectId}` : viewRoute.path;
}

onMounted(() => {
  void checkApiHealth();
  apiHealthTimer = setInterval(() => { void checkApiHealth(); }, 15_000);
});

onUnmounted(() => {
  if (apiHealthTimer !== null) clearInterval(apiHealthTimer);
});

</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-mark"><span class="brand-dot" /> Pipeline Factory <small>v4</small></div>
      <div class="topbar-actions">
        <div class="global-search"><Search :size="15" /><span>搜索方案、Run、线程</span><kbd>⌘ K</kbd></div>
        <el-tooltip :content="apiHealth.tooltip">
          <button type="button" class="system-health" :class="`system-health-${apiHealth.tone}`" aria-label="刷新 API 健康状态" :aria-busy="apiHealthState === 'checking'" :disabled="apiHealthInFlight" @click="checkApiHealth">
            <i /> {{ apiHealth.label }}
          </button>
        </el-tooltip>
        <el-button text circle aria-label="Help" @click="helpOpen = true"><Help :size="17" /></el-button>
        <el-button text circle aria-label="Notifications" @click="notificationsOpen = true"><Bell :size="17" /></el-button>
        <div class="avatar">LS</div>
      </div>
    </header>
    <main class="page-frame"><router-view v-slot="{ Component, route: viewRoute }"><component :is="Component" :key="workspaceViewKey(viewRoute)" /></router-view></main>

    <el-drawer v-model="helpOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">PIPELINE FACTORY · 帮助</div><h2>这个工作区怎么用</h2></div><el-button text circle aria-label="关闭帮助" @click="helpOpen = false">×</el-button></div>
        <div class="help-card"><strong>先探索</strong><p>用探索线程读懂仓库、把候选方案定下来；在你确认并入队之前，探索始终只读。</p></div>
        <div class="help-card"><strong>跟踪执行</strong><p>每个派发出去的方案都有自己的 Run 与 ExecutionThread。暂停、补充要求、验证与审阅都在 Run 详情页上做。</p></div>
        <div class="help-card"><strong>需要帮助？</strong><p>在项目设置页里查看生命周期钩子，在计划中心里找到每一个已派发的方案。</p></div>
      </div>
    </el-drawer>

    <el-drawer v-model="notificationsOpen" direction="rtl" size="min(430px, 92vw)" :with-header="false">
      <div class="global-drawer-shell">
        <div class="drawer-header"><div><div class="eyebrow">活动中心</div><h2>通知</h2></div><el-button text circle aria-label="关闭通知" @click="notificationsOpen = false">×</el-button></div>
        <div class="notification-item"><span class="notification-dot" :class="`notification-dot-${apiHealth.tone}`" /><div><strong>{{ apiHealth.label }}</strong><p>{{ apiHealth.tooltip }}</p><small>实时</small></div></div>
        <div class="notification-item"><span class="notification-dot" /><div><strong>探索策略已生效</strong><p>Plan 模式下，写文件、shell、测试与提交工具都是关闭的。</p><small>刚刚</small></div></div>
        <div class="notification-empty">没有更多通知。</div>
      </div>
    </el-drawer>
  </div>
</template>
