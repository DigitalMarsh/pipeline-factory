<!--
  模块职责：Worktree 详情里的「服务」区块 —— 读取该 worktree 的服务配置，启动 / 停止本应用管理的进程，
  查看尾部日志。对应 worktree-manage 的 ServiceRunnerPanel。

  维护提示：
    1) **只展示、只操作本应用启动的进程**。状态来自服务端内存，重启 API 后旧进程不在管理范围内，
       这时显示"未运行"是**正确**的——不要按端口去猜。
    2) 配置错误（JSON 坏了、serviceId 重复、缺少启动命令）直接显示在区块顶部：静默当成"没配服务"
       会让人反复检查一个其实存在的文件。
    3) 日志只在展开时才拉，并且展开期间每 3 秒刷新一次；收起或切换条目就停——长驻服务的日志
       不该在后台一直占用请求。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { WorktreeItem, WorktreeServiceLogEntry, WorktreeServices } from "../types";
import { worktreeServiceStatusLabel, worktreeServiceStatusTagType } from "../utils/worktreeStatus";

const props = withDefaults(
  defineProps<{
    projectId: string;
    item: WorktreeItem;
    /**
     * `runtime`：这个条目是当前执行目录目标，服务通过固定路径 `<runtime>/repo` 启动（端口/路径稳定），
     * 配置走 runtime 链；`worktree`：直接在这个 worktree 里起。
     */
    mode?: "worktree" | "runtime";
  }>(),
  { mode: "worktree" },
);
const isRuntime = () => props.mode === "runtime";

const snapshot = ref<WorktreeServices | null>(null);
const loading = ref(false);
const error = ref("");
const actionId = ref<string | null>(null);
const openLogsFor = ref<string | null>(null);
const logs = ref<WorktreeServiceLogEntry[]>([]);
const logsLoading = ref(false);
const logsError = ref("");
let generation = 0;
let logTimer: ReturnType<typeof setInterval> | null = null;

const commandOf = (service: WorktreeServices["services"][number]) => (service.argv ? service.argv.join(" ") : (service.shellCommand ?? ""));

const statesByService = computed(() => {
  const map = new Map<string, WorktreeServices["states"][number]>();
  for (const state of snapshot.value?.states ?? []) map.set(state.serviceId, state);
  return map;
});

async function load() {
  if (!props.item.hasWorktree) {
    snapshot.value = null;
    return;
  }
  const token = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const response = isRuntime()
      ? (await api.worktreeRuntime(props.projectId)).services
      : await api.worktreeServices(props.projectId, props.item.itemId);
    if (token === generation) snapshot.value = response;
  } catch (caught) {
    if (token === generation) error.value = caught instanceof Error ? caught.message : "服务配置读取失败";
  } finally {
    if (token === generation) loading.value = false;
  }
}

async function start(serviceId: string) {
  actionId.value = serviceId;
  try {
    if (isRuntime()) await api.startRuntimeService(props.projectId, serviceId);
    else await api.startWorktreeService(props.projectId, props.item.itemId, serviceId);
    ElMessage.success("服务已启动");
    await load();
    if (openLogsFor.value === serviceId) await loadLogs(serviceId);
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "服务启动失败");
  } finally {
    actionId.value = null;
  }
}

async function stop(serviceId: string) {
  actionId.value = serviceId;
  try {
    if (isRuntime()) await api.stopRuntimeService(props.projectId, serviceId);
    else await api.stopWorktreeService(props.projectId, props.item.itemId, serviceId);
    ElMessage.success("服务已停止");
    await load();
  } catch (caught) {
    ElMessage.error(caught instanceof Error ? caught.message : "服务停止失败");
  } finally {
    actionId.value = null;
  }
}

async function loadLogs(serviceId: string) {
  logsLoading.value = true;
  logsError.value = "";
  try {
    const response = isRuntime()
      ? await api.runtimeServiceLogs(props.projectId, serviceId)
      : await api.worktreeServiceLogs(props.projectId, props.item.itemId, serviceId);
    if (openLogsFor.value === serviceId) logs.value = response.items;
  } catch (caught) {
    if (openLogsFor.value === serviceId) logsError.value = caught instanceof Error ? caught.message : "日志读取失败";
  } finally {
    logsLoading.value = false;
  }
}

function stopLogTimer() {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

async function toggleLogs(serviceId: string) {
  stopLogTimer();
  if (openLogsFor.value === serviceId) {
    openLogsFor.value = null;
    return;
  }
  openLogsFor.value = serviceId;
  logs.value = [];
  await loadLogs(serviceId);
  logTimer = setInterval(() => void loadLogs(serviceId), 3_000);
}

watch(
  () => [props.item.itemId, props.mode] as const,
  () => {
    stopLogTimer();
    openLogsFor.value = null;
    logs.value = [];
    snapshot.value = null;
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(stopLogTimer);
</script>

<template>
  <section class="services-block" data-worktree-services>
    <header class="services-head">
      <h3>服务</h3>
      <button type="button" class="services-refresh" :disabled="loading || !props.item.hasWorktree" @click="load">刷新</button>
    </header>

    <p v-if="!props.item.hasWorktree" class="services-state">服务只能在 worktree 中运行；这条分支没有 worktree。</p>
    <p v-else-if="loading && !snapshot" class="services-state" role="status">正在读取服务配置…</p>
    <p v-else-if="error" class="services-state services-error" role="alert">{{ error }}</p>
    <template v-else-if="snapshot">
      <p v-if="snapshot.configError" class="services-state services-error" data-services-config-error>
        配置解析失败：{{ snapshot.configError }}
      </p>
      <p v-else-if="snapshot.configSource === 'runtime'" class="services-source" data-services-source>
        通过执行目录运行（配置来自 {{ snapshot.configPath }}；路径与端口跨分支固定）
      </p>
      <p v-else-if="snapshot.configSource === 'project-fallback'" class="services-source" data-services-source>
        使用项目兜底配置（这个 worktree 里没有 services.json）
      </p>
      <p v-else-if="!snapshot.configPath" class="services-state">
        没有服务配置。在 worktree 根目录放 `.pipeline-factory/services.json`（兼容 `.worktree-manage/services.json`）， 或在「项目设置 →
        Worktree」里配一份兜底。
      </p>
      <p v-else class="services-path" :title="snapshot.configPath">{{ snapshot.configPath }}</p>

      <ul v-if="snapshot.services.length" class="services-list">
        <li v-for="service in snapshot.services" :key="service.serviceId" :data-service-id="service.serviceId">
          <div class="service-row">
            <div class="service-copy">
              <strong>{{ service.name }}</strong>
              <small>{{ service.role }} · {{ service.workdir }}</small>
              <code :title="commandOf(service)">{{ commandOf(service) }}</code>
              <a v-if="service.healthUrl" :href="service.healthUrl" target="_blank" rel="noreferrer" class="service-health"
                >打开 {{ service.healthUrl }}</a
              >
            </div>
            <el-tag
              size="small"
              effect="light"
              :type="worktreeServiceStatusTagType(statesByService.get(service.serviceId)?.status ?? 'stopped')"
            >
              {{ worktreeServiceStatusLabel(statesByService.get(service.serviceId)?.status ?? "stopped") }}
            </el-tag>
          </div>
          <div class="service-actions">
            <el-button
              size="small"
              type="primary"
              :loading="actionId === service.serviceId"
              :disabled="!service.enabled || statesByService.get(service.serviceId)?.status === 'running'"
              data-service-start
              @click="start(service.serviceId)"
              >启动</el-button
            >
            <el-button
              size="small"
              :loading="actionId === service.serviceId"
              :disabled="statesByService.get(service.serviceId)?.status !== 'running'"
              data-service-stop
              @click="stop(service.serviceId)"
              >停止</el-button
            >
            <el-button size="small" text data-service-logs @click="toggleLogs(service.serviceId)">
              {{ openLogsFor === service.serviceId ? "收起日志" : "日志" }}
            </el-button>
          </div>
          <p v-if="!service.enabled" class="services-state">配置里 `enabled: false`，不能启动。</p>
          <p v-if="statesByService.get(service.serviceId)?.error" class="services-state services-error">
            {{ statesByService.get(service.serviceId)?.error }}
          </p>
          <div v-if="openLogsFor === service.serviceId" class="service-logs" data-service-log-panel>
            <p v-if="logsError" class="services-state services-error" role="alert">{{ logsError }}</p>
            <p v-else-if="logsLoading && !logs.length" class="services-state">正在读取日志…</p>
            <p v-else-if="!logs.length" class="services-state">还没有输出。</p>
            <pre v-else class="log-block">{{ logs.map((entry) => entry.text).join("\n") }}</pre>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.services-block {
  margin-top: 16px;
}
.services-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.services-head h3 {
  margin: 0;
  color: #52637e;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.services-refresh {
  border: 0;
  background: transparent;
  color: #7c8ba3;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}
.services-state {
  margin: 6px 0 0;
  color: #93a1b5;
  font-size: 11px;
  line-height: 1.6;
}
.services-error {
  color: #a94851;
}
.services-source {
  margin: 6px 0 0;
  color: #7c8ba3;
  font-size: 10px;
}
.services-path {
  margin: 6px 0 0;
  overflow: hidden;
  color: #93a1b5;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.services-list {
  display: grid;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.services-list li {
  padding: 8px 9px;
  border: 1px solid #eef1f5;
  border-radius: 8px;
  background: #fff;
}
.service-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.service-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.service-copy strong {
  color: #33425a;
  font-size: 12px;
}
.service-copy small {
  color: #93a1b5;
  font-size: 10px;
}
.service-copy code {
  overflow: hidden;
  color: #647794;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.service-health {
  overflow: hidden;
  color: #2c6cad;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.service-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.service-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.service-logs {
  margin-top: 8px;
}
.log-block {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  padding: 9px 10px;
  border-radius: 7px;
  background: #1e2b40;
  color: #d6e2f1;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
