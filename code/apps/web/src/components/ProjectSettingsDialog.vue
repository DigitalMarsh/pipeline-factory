<!--
  模块职责：在 Explorer 当前上下文中编辑 Project 配置，不改变当前路由。
  维护提示：保持配置保存使用 expectedConfigVersion，避免覆盖其他设置入口的更新。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { CircleCheck, Connection, Delete, FolderOpened, InfoFilled, Plus, Setting, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { Project, ProjectSettings } from "../types";
import { createProjectRequestScope } from "../utils/projectRoutes";

type CommandForm = { commandId: string; category: "verification" | "lifecycle" | "executor-tool"; description: string; enabled: boolean; timeoutMs: number; argv: string; environment: string };
type ProjectSettingsPatch = Omit<ProjectSettings, "concurrency"> & { concurrency: Omit<ProjectSettings["concurrency"], "maxAutoContinuationTurns"> };

const props = defineProps<{ modelValue: boolean; projectId: string | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [project: Project] }>();
const requestScope = createProjectRequestScope();
const project = ref<Project | null>(null);
const loading = ref(false);
const saving = ref(false);
const validating = ref(false);
const saved = ref(false);
const error = ref<string | null>(null);
const activeTab = ref("general");
const form = reactive({
  name: "", shortName: "", repoRoot: "", defaultBranch: "", worktreeRoot: "", configVersion: 0,
  maxParallelRuns: 2, defaultTimeoutMs: 120000, executionTimeoutMs: 1800000, maxRepairAttempts: 2,
  explorerModel: "gpt-5.6-luna", explorerReasoning: "", executorModel: "gpt-5.6-luna", executorReasoning: "",
  allowedMcpTools: "", allowedPluginTools: "", computerUseEnabled: false,
  startEnabled: false, startCommandId: "", startTimeoutMs: 120000, startMaxAttempts: 1, cleanupEnabled: false, cleanupCommandId: "", cleanupTimeoutMs: 120000, cleanupMaxAttempts: 1,
  commands: [] as CommandForm[], defaultVerificationCommandIds: [] as string[],
});

function setForm(value: Project) {
  const settings = value.settings;
  Object.assign(form, {
    name: value.name, shortName: value.shortName, repoRoot: value.repoRoot, defaultBranch: value.defaultBranch, worktreeRoot: value.worktreeRoot, configVersion: value.configVersion,
    maxParallelRuns: settings.concurrency.maxParallelRuns, defaultTimeoutMs: settings.concurrency.defaultTimeoutMs, executionTimeoutMs: settings.concurrency.executionTimeoutMs ?? 1800000, maxRepairAttempts: settings.concurrency.maxRepairAttempts,
    explorerModel: settings.models.explorer.model, explorerReasoning: settings.models.explorer.reasoningEffort ?? "", executorModel: settings.models.executor.model, executorReasoning: settings.models.executor.reasoningEffort ?? "",
    allowedMcpTools: settings.toolPolicy.allowedMcpTools.join(", "), allowedPluginTools: settings.toolPolicy.allowedPluginTools.join(", "), computerUseEnabled: settings.toolPolicy.computerUseEnabled,
    startEnabled: settings.hooks.start?.enabled !== false && Boolean(settings.hooks.start), startCommandId: settings.hooks.start?.commandId ?? "", startTimeoutMs: settings.hooks.start?.timeoutMs ?? 120000, startMaxAttempts: settings.hooks.start?.maxAttempts ?? 1,
    cleanupEnabled: settings.hooks.cleanup?.enabled !== false && Boolean(settings.hooks.cleanup), cleanupCommandId: settings.hooks.cleanup?.commandId ?? "", cleanupTimeoutMs: settings.hooks.cleanup?.timeoutMs ?? 120000, cleanupMaxAttempts: settings.hooks.cleanup?.maxAttempts ?? 1,
    commands: settings.commands.filter((command) => command.category !== "unclassified").map((command) => ({ commandId: command.commandId, category: command.category ?? "verification", description: command.description ?? "", enabled: command.enabled !== false, timeoutMs: command.timeoutMs ?? settings.concurrency.defaultTimeoutMs, argv: command.argv.join(" "), environment: Object.entries(command.environment ?? {}).map(([key, value]) => `${key}=${value}`).join("\n") })),
    defaultVerificationCommandIds: [...(settings.defaultVerificationCommandIds ?? [])],
  });
}

async function load() {
  const requestProjectId = props.projectId;
  if (!props.modelValue || !requestProjectId) return;
  const requestToken = requestScope.begin(requestProjectId);
  project.value = null;
  loading.value = true;
  error.value = null;
  saved.value = false;
  try {
    const response = await api.project(requestProjectId);
    if (!props.modelValue || props.projectId !== requestProjectId || !requestScope.isCurrent(requestToken, requestProjectId)) return;
    project.value = response.project;
    setForm(response.project);
  } catch (caught) {
    if (!props.modelValue || props.projectId !== requestProjectId || !requestScope.isCurrent(requestToken, requestProjectId)) return;
    error.value = caught instanceof Error ? caught.message : "Project 加载失败";
  } finally {
    if (requestScope.isCurrent(requestToken, requestProjectId)) loading.value = false;
  }
}

function listValue(value: string) { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function environmentValue(value: string) { return Object.fromEntries(value.split("\n").map((item) => item.trim()).filter(Boolean).map((item) => { const index = item.indexOf("="); return index < 1 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)]; })); }

function settingsPayload(): ProjectSettingsPatch {
  const lifecycle = {
    ...(form.startCommandId ? { start: { commandId: form.startCommandId, enabled: form.startEnabled, timeoutMs: form.startTimeoutMs, maxAttempts: form.startMaxAttempts } } : {}),
    ...(form.cleanupCommandId ? { cleanup: { commandId: form.cleanupCommandId, enabled: form.cleanupEnabled, timeoutMs: form.cleanupTimeoutMs, maxAttempts: form.cleanupMaxAttempts } } : {}),
  };
  return {
    concurrency: { maxParallelRuns: form.maxParallelRuns, defaultTimeoutMs: form.defaultTimeoutMs, executionTimeoutMs: form.executionTimeoutMs, maxRepairAttempts: form.maxRepairAttempts },
    commands: form.commands.filter((command) => command.commandId.trim() && command.argv.trim()).map((command) => ({ commandId: command.commandId.trim(), category: command.category, ...(command.description.trim() ? { description: command.description.trim() } : {}), enabled: command.enabled, timeoutMs: command.timeoutMs, argv: command.argv.trim().split(/\s+/), environment: environmentValue(command.environment) })),
    defaultVerificationCommandIds: form.defaultVerificationCommandIds,
    hooks: lifecycle,
    models: { explorer: { model: form.explorerModel, mode: "plan", loopMode: "provider-controlled", ...(form.explorerReasoning ? { reasoningEffort: form.explorerReasoning } : {}) }, executor: { model: form.executorModel, mode: "default", loopMode: "provider-controlled", ...(form.executorReasoning ? { reasoningEffort: form.executorReasoning } : {}) } },
    toolPolicy: { allowedMcpTools: listValue(form.allowedMcpTools), allowedPluginTools: listValue(form.allowedPluginTools), computerUseEnabled: form.computerUseEnabled },
  };
}

async function save() {
  if (!project.value) return;
  saving.value = true;
  saved.value = false;
  error.value = null;
  try {
    const response = await api.updateProject(project.value.id, { name: form.name, shortName: form.shortName, repoRoot: form.repoRoot, defaultBranch: form.defaultBranch, worktreeRoot: form.worktreeRoot, expectedConfigVersion: form.configVersion, settings: settingsPayload() });
    project.value = response.project;
    setForm(response.project);
    saved.value = true;
    emit("saved", response.project);
    ElMessage.success("Project 配置已保存");
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Project 配置保存失败";
    ElMessage.error(error.value);
  } finally {
    saving.value = false;
  }
}

async function validateRepository() {
  if (!props.projectId) return;
  validating.value = true;
  error.value = null;
  try {
    const response = await api.validateRepository(props.projectId, form.repoRoot);
    form.repoRoot = response.repoRoot;
    if (!form.defaultBranch) form.defaultBranch = response.defaultBranch;
    ElMessage.success(`Git 仓库校验通过 · ${response.defaultBranch}`);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "Git 仓库校验失败";
    ElMessage.error(error.value);
  } finally {
    validating.value = false;
  }
}

function addCommand() { form.commands.push({ commandId: "", category: "verification", description: "", enabled: true, timeoutMs: form.defaultTimeoutMs, argv: "", environment: "" }); }
function removeCommand(index: number) { form.commands.splice(index, 1); }
function close() { emit("update:modelValue", false); }
const statusText = computed(() => project.value?.status === "ARCHIVED" ? "Archived · read only" : `Config v${form.configVersion}`);

watch(() => [props.modelValue, props.projectId] as const, ([open]) => { if (open) void load(); }, { immediate: true });
onBeforeUnmount(() => requestScope.invalidate());
</script>

<template>
  <el-dialog :model-value="props.modelValue" class="project-settings-dialog" width="min(980px, calc(100vw - 24px))" :close-on-click-modal="false" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <template #header><div class="settings-dialog-heading"><div><div class="eyebrow">PROJECT SETTINGS</div><h1>{{ project?.name || 'Project settings' }}</h1><p>{{ project?.repoRoot || '管理仓库、执行和模型配置' }}</p></div><div class="settings-heading-actions"><el-tag :type="project?.status === 'ACTIVE' ? 'success' : 'info'">{{ project?.status === 'ACTIVE' ? 'Active' : 'Archived' }}</el-tag><span>{{ statusText }}</span></div></div></template>
    <div class="settings-dialog-body" v-loading="loading">
      <div v-if="error" class="settings-error"><Warning :size="15" /> {{ error }}</div>
      <div v-if="project" class="settings-shell">
        <nav class="settings-tabs" aria-label="Project settings"><button v-for="item in [{ key: 'general', label: 'General' }, { key: 'execution', label: 'Execution' }, { key: 'commands', label: 'Commands' }, { key: 'hooks', label: 'Hooks' }, { key: 'models', label: 'Models & Tools' }]" :key="item.key" type="button" :class="{ active: activeTab === item.key }" @click="activeTab = item.key"><Setting v-if="item.key === 'general'" :size="14" /><Connection v-else-if="item.key === 'execution'" :size="14" /><FolderOpened v-else-if="item.key === 'commands'" :size="14" /><CircleCheck v-else :size="14" />{{ item.label }}</button></nav>
        <main class="settings-content">
          <section v-if="activeTab === 'general'" class="settings-section"><div class="section-title"><div><h2>Project identity</h2><p>Project 是 Factory 内部稳定实体，独立于 Provider Thread 和工作目录。</p></div></div><div class="settings-form-grid"><label>Project name<input v-model="form.name" :disabled="project.status === 'ARCHIVED'" /></label><label>Project short name<input v-model="form.shortName" placeholder="例如：PF" :disabled="project.status === 'ARCHIVED'" /></label><label>Project ID<input :value="project.id" disabled /></label><label class="wide">Git repository root<div class="input-with-button"><input v-model="form.repoRoot" :disabled="project.status === 'ARCHIVED'" /><el-button plain :loading="validating" :disabled="project.status === 'ARCHIVED'" @click="validateRepository">Validate Git</el-button></div></label><label>Default branch<input v-model="form.defaultBranch" :disabled="project.status === 'ARCHIVED'" /></label><label>Worktree root<input v-model="form.worktreeRoot" :disabled="project.status === 'ARCHIVED'" /></label></div><div class="settings-notice"><InfoFilled :size="16" /><div><strong>目录边界</strong><p>Explorer 使用仓库根目录只读分析；Run 始终使用 Worktree 写入。仓库目录、Worktree 和分支修改需要没有运行中的 Run。</p></div></div></section>
          <section v-else-if="activeTab === 'execution'" class="settings-section"><div class="section-title"><div><h2>Execution policy</h2><p>这些设置会在下一次 Plan Confirm 时冻结。</p></div></div><div class="settings-form-grid"><label>Max parallel runs<input v-model.number="form.maxParallelRuns" :disabled="project.status === 'ARCHIVED'" type="number" min="1" max="32" /></label><label>Default timeout (ms)<input v-model.number="form.defaultTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>Execution timeout (ms)<input v-model.number="form.executionTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>Max repair attempts<input v-model.number="form.maxRepairAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="0" max="20" /></label></div><div class="settings-notice"><InfoFilled :size="16" /><div><strong>快照策略</strong><p>已确认 Plan 和运行中的 Run 使用自己的 Project 配置快照；修改这里不会改变历史执行。</p></div></div></section>
          <section v-else-if="activeTab === 'commands'" class="settings-section"><div class="section-title"><div><h2>Registered commands</h2><p>命令使用固定 argv；仅启用的 verification 命令可加入自动验证默认集合。</p></div><el-button plain :disabled="project.status === 'ARCHIVED'" @click="addCommand"><Plus :size="14" /> Add command</el-button></div><div v-for="(command, index) in form.commands" :key="index" class="command-editor"><div class="command-editor-row"><label>Command ID<input v-model="command.commandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.test" /></label><label>Arguments<input v-model="command.argv" :disabled="project.status === 'ARCHIVED'" placeholder="pnpm test" /></label><el-button text type="danger" :disabled="project.status === 'ARCHIVED'" aria-label="Remove command" @click="removeCommand(index)"><Delete :size="15" /></el-button></div><div class="settings-form-grid"><label>Category<select v-model="command.category"><option value="verification">Verification</option><option value="lifecycle">Lifecycle</option><option value="executor-tool">Executor tool</option></select></label><label>Default timeout (ms)<input v-model.number="command.timeoutMs" type="number" min="1" /></label><label class="wide">Description<input v-model="command.description" placeholder="What this command proves or does" /></label><label class="toggle-field wide"><el-switch v-model="command.enabled" /> Enabled</label><label v-if="command.category === 'verification'" class="toggle-field wide"><el-checkbox v-model="form.defaultVerificationCommandIds" :label="command.commandId" :disabled="!command.enabled || !command.commandId.trim()">Use in project default verification order</el-checkbox></label></div><label>Environment allowlist<input v-model="command.environment" :disabled="project.status === 'ARCHIVED'" placeholder="NODE_ENV=test&#10;PATH=/usr/local/bin:/usr/bin:/bin" /></label></div><div v-if="!form.commands.length" class="settings-empty"><FolderOpened :size="22" />还没有注册命令；空默认集合将在 Run 中记录为“未配置自动验证”。<el-button text type="primary" :disabled="project.status === 'ARCHIVED'" @click="addCommand">添加第一条命令</el-button></div></section>
          <section v-else-if="activeTab === 'hooks'" class="settings-section"><div class="section-title"><div><h2>Lifecycle hooks</h2><p>Start 在 Worktree 创建后执行，Cleanup 在 Worktree 移除后执行；每次尝试都会进入审计。</p></div></div><div class="hook-editor"><div><h3>Start hook</h3><p>初始化新的 Run Worktree。</p></div><el-switch v-model="form.startEnabled" :disabled="project.status === 'ARCHIVED'" /><div class="settings-form-grid"><label>Command ID<input v-model="form.startCommandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.start" /></label><label>Timeout (ms)<input v-model.number="form.startTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>Max attempts<input v-model.number="form.startMaxAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="1" max="5" /></label></div></div><div class="hook-editor"><div><h3>Cleanup hook</h3><p>从稳定 Project 目录执行清理。</p></div><el-switch v-model="form.cleanupEnabled" :disabled="project.status === 'ARCHIVED'" /><div class="settings-form-grid"><label>Command ID<input v-model="form.cleanupCommandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.cleanup" /></label><label>Timeout (ms)<input v-model.number="form.cleanupTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>Max attempts<input v-model.number="form.cleanupMaxAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="1" max="5" /></label></div></div></section>
          <section v-else class="settings-section"><div class="section-title"><div><h2>Models & tools</h2><p>模型角色和工具白名单同样在 Plan Confirm 时冻结。</p></div></div><div class="settings-form-grid"><label>Explorer model<input v-model="form.explorerModel" :disabled="project.status === 'ARCHIVED'" /></label><label>Explorer reasoning<input v-model="form.explorerReasoning" :disabled="project.status === 'ARCHIVED'" placeholder="low / medium / high" /></label><label>Executor model<input v-model="form.executorModel" :disabled="project.status === 'ARCHIVED'" /></label><label>Executor reasoning<input v-model="form.executorReasoning" :disabled="project.status === 'ARCHIVED'" placeholder="low / medium / high" /></label><label class="wide">Allowed MCP tools<input v-model="form.allowedMcpTools" :disabled="project.status === 'ARCHIVED'" placeholder="mcp:docs:search, mcp:repo:list" /></label><label class="wide">Allowed plugin tools<input v-model="form.allowedPluginTools" :disabled="project.status === 'ARCHIVED'" placeholder="plugin:example:tool" /></label><label class="toggle-field wide"><el-switch v-model="form.computerUseEnabled" :disabled="project.status === 'ARCHIVED'" /> Allow Computer Use</label></div></section>
          <div class="settings-footer"><span v-if="saved" class="saved-note"><CircleCheck :size="15" /> Saved as config v{{ form.configVersion }}</span><el-button type="primary" :loading="saving" :disabled="project.status === 'ARCHIVED'" @click="save">Save Project configuration</el-button></div>
        </main>
      </div>
    </div>
    <template #footer><div class="settings-dialog-footer"><el-button @click="close">Done</el-button></div></template>
  </el-dialog>
</template>

<style>
.project-settings-dialog .el-dialog__header { margin-right: 0; padding: 22px 26px 16px; border-bottom: 1px solid #edf0f4; }.project-settings-dialog .el-dialog__body { padding: 0 26px 8px; }.project-settings-dialog .el-dialog__footer { padding: 10px 26px 20px; border-top: 1px solid #edf0f4; }.project-settings-dialog .settings-dialog-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding-right: 26px; }.project-settings-dialog .settings-dialog-heading h1 { margin: 7px 0 4px; color: #1d2b40; font-size: 23px; letter-spacing: -.05em; }.project-settings-dialog .settings-dialog-heading p { margin: 0; overflow: hidden; max-width: 630px; color: #8290a2; font: 10px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }.project-settings-dialog .eyebrow { color: #8492a8; font-size: 10px; font-weight: 800; letter-spacing: .16em; }.project-settings-dialog .settings-heading-actions { display: flex; align-items: center; gap: 10px; color: #9aa6b5; font-size: 10px; }.project-settings-dialog .settings-dialog-body { min-height: 0; }.project-settings-dialog .settings-error { display: flex; align-items: center; gap: 8px; margin: 15px 0 0; padding: 10px 12px; border: 1px solid #f0d1d5; border-radius: 7px; background: #fff6f7; color: #a35560; font-size: 11px; }.project-settings-dialog .settings-shell { display: grid; grid-template-columns: 175px minmax(0, 1fr); max-height: min(62vh, 570px); min-height: 440px; margin-top: 15px; overflow: hidden; border: 1px solid #e1e7ef; border-radius: 9px; background: #fff; }.project-settings-dialog .settings-tabs { overflow-y: auto; padding: 11px 8px; border-right: 1px solid #edf0f4; background: #fbfcfe; }.project-settings-dialog .settings-tabs button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; margin-bottom: 3px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: #8693a5; cursor: pointer; font-size: 11px; text-align: left; }.project-settings-dialog .settings-tabs button:hover, .project-settings-dialog .settings-tabs button.active { background: #edf3ff; color: #4c76d3; font-weight: 700; }.project-settings-dialog .settings-content { min-width: 0; overflow-y: auto; padding: 24px 27px; }.project-settings-dialog .settings-section { min-height: 360px; }.project-settings-dialog .section-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }.project-settings-dialog .section-title h2 { margin: 0 0 5px; color: #3d4d65; font-size: 16px; }.project-settings-dialog .section-title p { margin: 0; color: #929eae; font-size: 10px; line-height: 1.5; }.project-settings-dialog .settings-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px 13px; }.project-settings-dialog .settings-form-grid label, .project-settings-dialog .command-editor label { display: block; color: #718097; font-size: 10px; font-weight: 700; }.project-settings-dialog .settings-form-grid input, .project-settings-dialog .command-editor input { display: block; width: 100%; height: 34px; margin-top: 7px; padding: 0 9px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; box-sizing: border-box; }.project-settings-dialog .settings-form-grid input:focus, .project-settings-dialog .command-editor input:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }.project-settings-dialog .settings-form-grid input:disabled { color: #a4afbc; background: #f5f7fa; }.project-settings-dialog .wide { grid-column: 1 / -1; }.project-settings-dialog .input-with-button { display: flex; gap: 8px; }.project-settings-dialog .input-with-button input { flex: 1; }.project-settings-dialog .input-with-button .el-button { margin-top: 7px; font-size: 10px; }.project-settings-dialog .settings-notice { display: flex; gap: 10px; margin-top: 24px; padding: 11px 12px; border: 1px solid #dbe7ff; border-radius: 7px; background: #f6f9ff; color: #7183a3; font-size: 10px; line-height: 1.55; }.project-settings-dialog .settings-notice svg { flex: 0 0 auto; color: #638be0; }.project-settings-dialog .settings-notice strong { display: block; margin-bottom: 3px; color: #506b9d; font-size: 10px; }.project-settings-dialog .settings-notice p { margin: 0; }.project-settings-dialog .command-editor { margin-bottom: 13px; padding: 13px; border: 1px solid #e5eaf1; border-radius: 8px; background: #fbfcfe; }.project-settings-dialog .command-editor-row { display: grid; grid-template-columns: 150px 1fr 30px; gap: 9px; align-items: end; margin-bottom: 12px; }.project-settings-dialog .command-editor-row .el-button { margin-bottom: 7px; }.project-settings-dialog .settings-empty { display: grid; justify-items: center; gap: 8px; padding: 38px; border: 1px dashed #dce4ed; border-radius: 8px; color: #a2adbb; font-size: 11px; }.project-settings-dialog .hook-editor { display: grid; grid-template-columns: 1fr auto; gap: 5px 18px; margin-bottom: 13px; padding: 15px; border: 1px solid #e5eaf1; border-radius: 8px; background: #fbfcfe; }.project-settings-dialog .hook-editor h3 { margin: 0 0 4px; color: #52627a; font-size: 12px; }.project-settings-dialog .hook-editor p { margin: 0; color: #95a1b0; font-size: 10px; }.project-settings-dialog .hook-editor .settings-form-grid { grid-column: 1 / -1; margin-top: 10px; }.project-settings-dialog .toggle-field { display: flex !important; align-items: center; gap: 10px; color: #61718a !important; }.project-settings-dialog .settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding-top: 17px; border-top: 1px solid #edf0f4; }.project-settings-dialog .settings-footer .el-button, .project-settings-dialog .settings-dialog-footer .el-button { font-size: 11px; }.project-settings-dialog .saved-note { display: flex; align-items: center; gap: 5px; color: #24a572; font-size: 10px; }.project-settings-dialog .settings-dialog-footer { display: flex; justify-content: flex-end; }
@media (max-width: 760px) { .project-settings-dialog .el-dialog__body { padding: 0 14px 8px; }.project-settings-dialog .el-dialog__footer { padding-left: 14px; padding-right: 14px; }.project-settings-dialog .settings-dialog-heading { display: block; padding-right: 20px; }.project-settings-dialog .settings-heading-actions { margin-top: 12px; }.project-settings-dialog .settings-shell { grid-template-columns: 1fr; max-height: 65vh; }.project-settings-dialog .settings-tabs { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid #edf0f4; }.project-settings-dialog .settings-tabs button { width: auto; min-width: max-content; }.project-settings-dialog .settings-form-grid { grid-template-columns: 1fr; }.project-settings-dialog .wide { grid-column: auto; }.project-settings-dialog .command-editor-row { grid-template-columns: 1fr; }.project-settings-dialog .hook-editor { grid-template-columns: 1fr; }.project-settings-dialog .hook-editor .el-switch { position: absolute; margin-top: -38px; margin-left: 250px; } }
.project-settings-dialog .settings-shell { height: min(54vh, 430px); max-height: min(54vh, 430px); min-height: 0; }
</style>
