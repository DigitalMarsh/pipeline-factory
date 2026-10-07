<!--
  模块职责：在 Explorer 当前上下文中编辑 Project 配置，不改变当前路由。
  维护提示：保持配置保存使用 expectedConfigVersion，避免覆盖其他设置入口的更新。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { CircleCheck, Connection, Delete, FolderOpened, InfoFilled, Plus, Setting, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import type { Project, ProjectSettings } from "../types";
import { createProjectRequestScope } from "../utils/projectRoutes";
import { backendOptions, backendLabel, backendSwitchAdjustment, endpointHint, modelOptionsFor, reasoningOptionsWith } from "../utils/modelCatalog";
import { useModelBackends } from "../composables/useModelBackends";

type CommandForm = { commandId: string; category: "verification" | "lifecycle" | "executor-tool"; description: string; enabled: boolean; timeoutMs: number; argv: string; environment: string; tags: string };
/** 模型角色的提交形状：`backend: null` 表达"清除覆盖、跟随全局"（见 domain 的 ModelRoleConfigInput）。 */
type ModelRolePayload = { model: string; backend: string | null; mode: string; loopMode: string; reasoningEffort?: string };
type ProjectSettingsPatch = Omit<ProjectSettings, "concurrency" | "models"> & { concurrency: Omit<ProjectSettings["concurrency"], "maxParallelRuns" | "maxAutoContinuationTurns">; models: { explorer: ModelRolePayload; executor: ModelRolePayload } };

/**
 * 页签的唯一清单：导航按钮与"能不能跳到某个页签"的判定共用它。
 * 判定不是多余的——`initialTab` 可能来自一条旧书签的 `?tab=`，取值不认时不能把 `activeTab`
 * 设成一个没有对应 section 的字符串（那会落到模板末尾的 `v-else`，显示"模型与工具"而导航上
 * 一个按钮都不高亮）。
 */
const SETTINGS_TABS = [
  { key: "general", label: "常规" },
  { key: "execution", label: "执行" },
  { key: "commands", label: "命令" },
  { key: "hooks", label: "钩子" },
  { key: "models", label: "模型与工具" },
] as const;

const props = defineProps<{ modelValue: boolean; projectId: string | null; initialTab?: string | null | undefined }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean]; saved: [project: Project] }>();
const requestScope = createProjectRequestScope();
const project = ref<Project | null>(null);
const loading = ref(false);
const saving = ref(false);
const validating = ref(false);
const saved = ref(false);
const error = ref<string | null>(null);
/** 只认清单里的页签：`initialTab` 来自一条可能已经过期的 `?tab=`。 */
function knownSettingsTab(value: string | null | undefined): string | null {
  return value && SETTINGS_TABS.some((item) => item.key === value) ? value : null;
}

const activeTab = ref(knownSettingsTab(props.initialTab) ?? "general");
/**
 * 只在**显式给了 `initialTab` 时**改当前页签（旧 `/projects/:id/settings?tab=` 链接重定向过来的
 * 那条路，见 router.ts 与 ExplorerView 的 consumeSettingsQuery）。没给就保持上次停留的页签——
 * 从左侧项目列表打开设置时不会有"每次都跳回常规"这种意外。
 *
 * 初始化与 watch 两处都要：真实流程里 `modelValue` 是 false → true，watch 会触发；但组件也可能
 * 一挂载就是打开的（不然 `initialTab` 会被无声忽略）。
 */
watch(() => props.modelValue, (open) => {
  const tab = knownSettingsTab(props.initialTab);
  if (open && tab) activeTab.value = tab;
});
const form = reactive({
  name: "", shortName: "", repoRoot: "", defaultBranch: "", worktreeRoot: "", configVersion: 0,
  defaultTimeoutMs: 120000, executionTimeoutMs: 1800000, maxRepairAttempts: 2, conflictScope: "declared" as "declared" | "overlap",
  explorerBackend: "", explorerModel: "gpt-5.6-luna", explorerReasoning: "", executorBackend: "", executorModel: "gpt-5.6-luna", executorReasoning: "",
  allowedMcpTools: "", allowedPluginTools: "", computerUseEnabled: false,
  startEnabled: false, startCommandId: "", startTimeoutMs: 120000, startMaxAttempts: 1, startBlocking: true, cleanupEnabled: false, cleanupCommandId: "", cleanupTimeoutMs: 120000, cleanupMaxAttempts: 1,
  commands: [] as CommandForm[], defaultVerificationCommandIds: [] as string[], defaultArtifactMode: "REPOSITORY_FILE" as "CONVERSATION" | "REPOSITORY_FILE",
});
const { catalog: modelCatalog, load: loadModelBackends } = useModelBackends();
const modelBackendOptions = computed(() => backendOptions(modelCatalog.value));
/** 空值表示"跟随全局"；此时下拉里的模型与推理强度该按全局那个后端来列，而不是留空。 */
const effectiveExplorerBackend = computed(() => form.explorerBackend || modelCatalog.value?.roles.explorer || "");
const effectiveExecutorBackend = computed(() => form.executorBackend || modelCatalog.value?.roles.executor || "");
const explorerModelOptions = computed(() => modelOptionsFor(modelCatalog.value, effectiveExplorerBackend.value, form.explorerModel));
const executorModelOptions = computed(() => modelOptionsFor(modelCatalog.value, effectiveExecutorBackend.value, form.executorModel));
const explorerReasoningOptions = computed(() => reasoningOptionsWith(modelCatalog.value, effectiveExplorerBackend.value, form.explorerReasoning));
const executorReasoningOptions = computed(() => reasoningOptionsWith(modelCatalog.value, effectiveExecutorBackend.value, form.executorReasoning));
const explorerBackendHint = computed(() => endpointHint(modelCatalog.value, effectiveExplorerBackend.value));
const executorBackendHint = computed(() => endpointHint(modelCatalog.value, effectiveExecutorBackend.value));
const explorerBackendFallbackLabel = computed(() => `跟随全局（${backendLabel(modelCatalog.value, modelCatalog.value?.roles.explorer)}）`);
const executorBackendFallbackLabel = computed(() => `跟随全局（${backendLabel(modelCatalog.value, modelCatalog.value?.roles.executor)}）`);

/**
 * 表单相对"上次载入 / 保存时的样子"有没有改动。
 *
 * **为什么必须有它**：这个对话框的页脚此前只有一颗「完成」，而保存按钮在**滚动区底部**
 * （模型与工具那一节的「保存项目配置」）。用户改完执行侧 Agent 直接点页脚那颗——那是**关掉对话框**，
 * 改动一个字都不会落库，而且**没有任何提示**。重开设置页看到还是旧值，现象就是
 * "我明明改成 Claude 了，怎么还是 codex"，反复试几次都一样。
 *
 * 现在有改动时页脚那颗变成「保存并关闭」，改动不会再被静默丢掉；
 * 没改动时它仍是「完成」（关掉一个没动过的表单不需要"保存"这个词）。
 */
const pristine = ref("");
function formSnapshot(): string {
  return JSON.stringify({ name: form.name, shortName: form.shortName, repoRoot: form.repoRoot, defaultBranch: form.defaultBranch, worktreeRoot: form.worktreeRoot, settings: settingsPayload() });
}
const dirty = computed(() => pristine.value !== "" && formSnapshot() !== pristine.value);

/** 页脚那颗按钮：有改动就先保存、成功才关；没改动就是单纯关掉。 */
async function finish(): Promise<void> {
  if (!dirty.value) return close();
  await save();
  if (!error.value) close();
}

/** 点遮罩 / Esc / 右上角 × 关掉时，有未保存改动先问一声（默认是 `:close-on-click-modal="false"`，遮罩不会关）。 */
async function handleBeforeClose(done: () => void): Promise<void> {
  if (!dirty.value) return done();
  try {
    await ElMessageBox.confirm("这个对话框里还有未保存的改动，关掉就没了。", "未保存的改动", { confirmButtonText: "保存并关闭", cancelButtonText: "放弃改动", distinguishCancelAndClose: true, type: "warning" });
  } catch (caught) {
    // 「放弃改动」与右上角 × 都走 here：两者都不保存。前者是明确的放弃，后者只是关窗——
    // 但对未保存的表单来说结果一样，不值得再分一档去烦用户。
    void caught;
    return done();
  }
  await save();
  done();
}

function setForm(value: Project) {
  const settings = value.settings;
  Object.assign(form, {
    name: value.name, shortName: value.shortName, repoRoot: value.repoRoot, defaultBranch: value.defaultBranch, worktreeRoot: value.worktreeRoot, configVersion: value.configVersion,
    defaultTimeoutMs: settings.concurrency.defaultTimeoutMs, executionTimeoutMs: settings.concurrency.executionTimeoutMs ?? 1800000, maxRepairAttempts: settings.concurrency.maxRepairAttempts, conflictScope: settings.concurrency.conflictScope ?? "declared",
    explorerModel: settings.models.explorer.model, explorerReasoning: settings.models.explorer.reasoningEffort ?? "", executorModel: settings.models.executor.model, executorReasoning: settings.models.executor.reasoningEffort ?? "",
    explorerBackend: settings.models.explorer.backend ?? "", executorBackend: settings.models.executor.backend ?? "",
    allowedMcpTools: settings.toolPolicy.allowedMcpTools.join(", "), allowedPluginTools: settings.toolPolicy.allowedPluginTools.join(", "), computerUseEnabled: settings.toolPolicy.computerUseEnabled,
    startEnabled: settings.hooks.start?.enabled !== false && Boolean(settings.hooks.start), startCommandId: settings.hooks.start?.commandId ?? "", startTimeoutMs: settings.hooks.start?.timeoutMs ?? 120000, startMaxAttempts: settings.hooks.start?.maxAttempts ?? 1, startBlocking: settings.hooks.start?.blocking !== false,
    cleanupEnabled: settings.hooks.cleanup?.enabled !== false && Boolean(settings.hooks.cleanup), cleanupCommandId: settings.hooks.cleanup?.commandId ?? "", cleanupTimeoutMs: settings.hooks.cleanup?.timeoutMs ?? 120000, cleanupMaxAttempts: settings.hooks.cleanup?.maxAttempts ?? 1,
    commands: settings.commands.filter((command) => command.category !== "unclassified").map((command) => ({ commandId: command.commandId, category: command.category ?? "verification", description: command.description ?? "", enabled: command.enabled !== false, timeoutMs: command.timeoutMs ?? settings.concurrency.defaultTimeoutMs, argv: command.argv.join(" "), environment: Object.entries(command.environment ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"), tags: (command.tags ?? []).join(", ") })),
    defaultVerificationCommandIds: [...(settings.defaultVerificationCommandIds ?? [])],
    defaultArtifactMode: settings.defaultArtifactMode ?? "REPOSITORY_FILE",
  });
  // 记下"载入时的样子"——页脚那颗按钮是否该变成「保存并关闭」全看它（见 `dirty`）。
  pristine.value = formSnapshot();
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

/**
 * 用户切换 Agent 之后，把**模型**（必要时还有推理强度）一起带过去。
 * 判据与理由见 `modelCatalog.backendSwitchAdjustment` 的注释——一句话：不这样做的话，
 * 存下去的就是"新后端 + 旧后端的模型 slug"，而域里的家族迁移**刻意跳过显式写了 backend 的项目**。
 */
function applyBackendSwitch(role: "explorer" | "executor"): void {
  const current = role === "explorer" ? { model: form.explorerModel, reasoningEffort: form.explorerReasoning } : { model: form.executorModel, reasoningEffort: form.executorReasoning };
  const backendId = role === "explorer" ? effectiveExplorerBackend.value : effectiveExecutorBackend.value;
  const adjustment = backendSwitchAdjustment(modelCatalog.value, backendId, current);
  if (adjustment.model) {
    if (role === "explorer") form.explorerModel = adjustment.model; else form.executorModel = adjustment.model;
  }
  if (adjustment.clearReasoningEffort) {
    if (role === "explorer") form.explorerReasoning = ""; else form.executorReasoning = "";
  }
}
function environmentValue(value: string) { return Object.fromEntries(value.split("\n").map((item) => item.trim()).filter(Boolean).map((item) => { const index = item.indexOf("="); return index < 1 ? [item, ""] : [item.slice(0, index), item.slice(index + 1)]; })); }

function settingsPayload(): ProjectSettingsPatch {
  const lifecycle = {
    ...(form.startCommandId ? { start: { commandId: form.startCommandId, enabled: form.startEnabled, timeoutMs: form.startTimeoutMs, maxAttempts: form.startMaxAttempts, blocking: form.startBlocking } } : {}),
    ...(form.cleanupCommandId ? { cleanup: { commandId: form.cleanupCommandId, enabled: form.cleanupEnabled, timeoutMs: form.cleanupTimeoutMs, maxAttempts: form.cleanupMaxAttempts } } : {}),
  };
  return {
    concurrency: { defaultTimeoutMs: form.defaultTimeoutMs, executionTimeoutMs: form.executionTimeoutMs, maxRepairAttempts: form.maxRepairAttempts, conflictScope: form.conflictScope },
    commands: form.commands.filter((command) => command.commandId.trim() && command.argv.trim()).map((command) => ({ commandId: command.commandId.trim(), category: command.category, ...(command.description.trim() ? { description: command.description.trim() } : {}), enabled: command.enabled, timeoutMs: command.timeoutMs, argv: command.argv.trim().split(/\s+/), environment: environmentValue(command.environment), tags: listValue(command.tags) })),
    defaultVerificationCommandIds: form.defaultVerificationCommandIds,
    defaultArtifactMode: form.defaultArtifactMode,
    hooks: lifecycle,
    models: { explorer: { model: form.explorerModel, backend: form.explorerBackend || null, mode: "plan", loopMode: "provider-controlled", ...(form.explorerReasoning ? { reasoningEffort: form.explorerReasoning } : {}) }, executor: { model: form.executorModel, backend: form.executorBackend || null, mode: "default", loopMode: "provider-controlled", ...(form.executorReasoning ? { reasoningEffort: form.executorReasoning } : {}) } },
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

function addCommand() { form.commands.push({ commandId: "", category: "verification", description: "", enabled: true, timeoutMs: form.defaultTimeoutMs, argv: "", environment: "", tags: "" }); }
function removeCommand(index: number) { form.commands.splice(index, 1); }
function close() { emit("update:modelValue", false); }
const statusText = computed(() => project.value?.status === "ARCHIVED" ? "Archived · read only" : `Config v${form.configVersion}`);

watch(() => [props.modelValue, props.projectId] as const, ([open]) => { if (open) { void load(); void loadModelBackends(); } }, { immediate: true });
onBeforeUnmount(() => requestScope.invalidate());
</script>

<template>
  <el-dialog :model-value="props.modelValue" class="project-settings-dialog" width="min(980px, calc(100vw - 24px))" :close-on-click-modal="false" :before-close="handleBeforeClose" destroy-on-close @update:model-value="emit('update:modelValue', $event)">
    <template #header><div class="settings-dialog-heading"><div><div class="eyebrow">项目设置</div><h1>{{ project?.name || '项目设置' }}</h1><p>{{ project?.repoRoot || '管理仓库、执行和模型配置' }}</p></div><div class="settings-heading-actions"><el-tag :type="project?.status === 'ACTIVE' ? 'success' : 'info'">{{ project?.status === 'ACTIVE' ? '启用中' : '已归档' }}</el-tag><span>{{ statusText }}</span></div></div></template>
    <div class="settings-dialog-body" v-loading="loading">
      <div v-if="error" class="settings-error"><Warning :size="15" /> {{ error }}</div>
      <div v-if="project" class="settings-shell">
        <nav class="settings-tabs" aria-label="项目设置"><button v-for="item in SETTINGS_TABS" :key="item.key" type="button" :class="{ active: activeTab === item.key }" @click="activeTab = item.key"><Setting v-if="item.key === 'general'" :size="14" /><Connection v-else-if="item.key === 'execution'" :size="14" /><FolderOpened v-else-if="item.key === 'commands'" :size="14" /><CircleCheck v-else :size="14" />{{ item.label }}</button></nav>
        <main class="settings-content">
          <section v-if="activeTab === 'general'" class="settings-section"><div class="section-title"><div><h2>项目标识</h2><p>Project 是 Factory 内部稳定实体，独立于 Provider Thread 和工作目录。</p></div></div><div class="settings-form-grid"><label>项目名称<input v-model="form.name" :disabled="project.status === 'ARCHIVED'" /></label><label>项目简称<input v-model="form.shortName" placeholder="例如：PF" :disabled="project.status === 'ARCHIVED'" /></label><label>项目 ID<input :value="project.id" disabled /></label><label class="wide">Git 仓库根目录<div class="input-with-button"><input v-model="form.repoRoot" :disabled="project.status === 'ARCHIVED'" /><el-button plain :loading="validating" :disabled="project.status === 'ARCHIVED'" @click="validateRepository">校验 Git</el-button></div></label><label>默认分支<input v-model="form.defaultBranch" :disabled="project.status === 'ARCHIVED'" /></label><label>Worktree 根目录<input v-model="form.worktreeRoot" :disabled="project.status === 'ARCHIVED'" /></label></div><div class="settings-notice"><InfoFilled :size="16" /><div><strong>目录边界</strong><p>Explorer 使用仓库根目录只读分析；Run 始终使用 Worktree 写入。仓库目录、Worktree 和分支修改需要没有运行中的 Run。</p></div></div></section>
          <section v-else-if="activeTab === 'execution'" class="settings-section"><div class="section-title"><div><h2>执行策略</h2><p>这些设置会在下一次 Plan Confirm 时冻结。</p></div></div><div class="settings-form-grid"><label>默认超时（毫秒）<input v-model.number="form.defaultTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>执行超时（毫秒）<input v-model.number="form.executionTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>最大修复次数<input v-model.number="form.maxRepairAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="0" max="20" /></label><label>冲突范围<select v-model="form.conflictScope" :disabled="project.status === 'ARCHIVED'"><option value="declared">只看声明的冲突键</option><option value="overlap">声明的键 + scope 重叠</option></select><small class="field-hint">scope 重叠会把同一个目录下不同文件的改动也串行——更保守，只在探索产出的冲突键不可靠时才开。</small></label><label class="wide">默认产物模式<select v-model="form.defaultArtifactMode" :disabled="project.status === 'ARCHIVED'"><option value="REPOSITORY_FILE">REPOSITORY_FILE · 产出仓库文件（可入队、可执行）</option><option value="CONVERSATION">CONVERSATION · 仅对话审阅（不能入队、不能起 Run）</option></select><small class="field-hint">探索产出 Plan 时按这个默认值走，不再为它逐次询问。只有需求本身就是"只要一份对话内的结论、不落盘"时才选 CONVERSATION——那种方案确认之后也入不了队。</small></label></div><div class="settings-notice"><InfoFilled :size="16" /><div><strong>快照策略</strong><p>已确认 Plan 和运行中的 Run 使用自己的 Project 配置快照；修改这里不会改变历史执行。</p></div></div></section>
          <section v-else-if="activeTab === 'commands'" class="settings-section"><div class="section-title"><div><h2>已登记命令</h2><p>命令使用固定 argv；仅启用的 verification 命令可加入自动验证默认集合。</p></div><el-button plain :disabled="project.status === 'ARCHIVED'" @click="addCommand"><Plus :size="14" /> 添加命令</el-button></div><div v-for="(command, index) in form.commands" :key="index" class="command-editor"><div class="command-editor-row"><label>命令 ID<input v-model="command.commandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.test" /></label><label>参数<input v-model="command.argv" :disabled="project.status === 'ARCHIVED'" placeholder="pnpm test" /></label><el-button text type="danger" :disabled="project.status === 'ARCHIVED'" aria-label="移除命令" @click="removeCommand(index)"><Delete :size="15" /></el-button></div><div class="settings-form-grid"><label>分类<select v-model="command.category"><option value="verification">验证</option><option value="lifecycle">生命周期</option><option value="executor-tool">执行侧工具</option></select></label><label>默认超时（毫秒）<input v-model.number="command.timeoutMs" type="number" min="1" /></label><label class="wide">描述<input v-model="command.description" placeholder="这条命令证明了什么、做了什么" /></label><label class="wide">验证标签<input v-model="command.tags" placeholder="unit, types, docs" title="Plan 的 verification.suites 只能用这里登记的 tag；留空表示这条命令不参与按 tag 选子集。" /></label><label class="toggle-field wide"><el-switch v-model="command.enabled" /> 已启用</label><label v-if="command.category === 'verification'" class="toggle-field wide"><el-checkbox v-model="form.defaultVerificationCommandIds" :label="command.commandId" :disabled="!command.enabled || !command.commandId.trim()">计入项目默认验证顺序</el-checkbox></label></div><label>环境变量白名单<input v-model="command.environment" :disabled="project.status === 'ARCHIVED'" placeholder="NODE_ENV=test&#10;PATH=/usr/local/bin:/usr/bin:/bin" /></label></div><div v-if="!form.commands.length" class="settings-empty"><FolderOpened :size="22" />还没有注册命令；空默认集合将在 Run 中记录为“未配置自动验证”。<el-button text type="primary" :disabled="project.status === 'ARCHIVED'" @click="addCommand">添加第一条命令</el-button></div></section>
          <section v-else-if="activeTab === 'hooks'" class="settings-section"><div class="section-title"><div><h2>生命周期钩子</h2><p>「启动钩子」在 Worktree 创建后、Executor 第一个回合前执行，它是 Worktree 的初始化入口——命令在「命令」页签登记（类别选「生命周期」），这里只按命令 ID 引用它。「清理钩子」在 Worktree 移除后执行。每次尝试都会进入审计。</p></div></div><div class="hook-editor"><div><h3>启动钩子</h3><p>初始化新的 Run Worktree。</p></div><el-switch v-model="form.startEnabled" :disabled="project.status === 'ARCHIVED'" /><div class="settings-form-grid"><label>命令 ID<input v-model="form.startCommandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.start" /></label><label>超时（毫秒）<input v-model.number="form.startTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>最大尝试次数<input v-model.number="form.startMaxAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="1" max="5" /></label></div><div class="hook-blocking"><el-checkbox v-model="form.startBlocking" :disabled="project.status === 'ARCHIVED'">失败时阻塞 Run</el-checkbox><p>关掉它，这条命令失败只记一条 HOOK_FAILED，Run 照常开始——适合建索引、预热缓存这类「失败只是慢一点」的初始化。装依赖这类失败会让产出不可信的，保持开启。</p></div></div><div class="hook-editor"><div><h3>清理钩子</h3><p>从稳定 Project 目录执行清理。</p></div><el-switch v-model="form.cleanupEnabled" :disabled="project.status === 'ARCHIVED'" /><div class="settings-form-grid"><label>命令 ID<input v-model="form.cleanupCommandId" :disabled="project.status === 'ARCHIVED'" placeholder="project.cleanup" /></label><label>超时（毫秒）<input v-model.number="form.cleanupTimeoutMs" :disabled="project.status === 'ARCHIVED'" type="number" min="1000" /></label><label>最大尝试次数<input v-model.number="form.cleanupMaxAttempts" :disabled="project.status === 'ARCHIVED'" type="number" min="1" max="5" /></label></div></div></section>
          <section v-else class="settings-section"><div class="section-title"><div><h2>模型与工具</h2><p>模型角色和工具白名单同样在 Plan Confirm 时冻结：已确认的 Plan 与正在跑的 Run 继续用它们冻结的那份，改动从**下一次 Plan Confirm** 起生效。</p></div></div><div class="settings-form-grid"><label>探索侧 Agent<select v-model="form.explorerBackend" :disabled="project.status === 'ARCHIVED'" @change="applyBackendSwitch('explorer')"><option value="">{{ explorerBackendFallbackLabel }}</option><option v-for="backend in modelBackendOptions" :key="backend.id" :value="backend.id">{{ backend.label }}</option></select><small v-if="explorerBackendHint" class="field-hint">{{ explorerBackendHint }}</small></label><label>探索侧模型<select v-model="form.explorerModel" :disabled="project.status === 'ARCHIVED'"><option v-for="model in explorerModelOptions" :key="model" :value="model">{{ model }}</option></select></label><label>探索侧推理强度<select v-model="form.explorerReasoning" :disabled="project.status === 'ARCHIVED'"><option value="">默认</option><option v-for="option in explorerReasoningOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><label>执行侧 Agent<select v-model="form.executorBackend" :disabled="project.status === 'ARCHIVED'" @change="applyBackendSwitch('executor')"><option value="">{{ executorBackendFallbackLabel }}</option><option v-for="backend in modelBackendOptions" :key="backend.id" :value="backend.id">{{ backend.label }}</option></select><small v-if="executorBackendHint" class="field-hint">{{ executorBackendHint }}</small></label><label>执行侧模型<select v-model="form.executorModel" :disabled="project.status === 'ARCHIVED'"><option v-for="model in executorModelOptions" :key="model" :value="model">{{ model }}</option></select></label><label>执行侧推理强度<select v-model="form.executorReasoning" :disabled="project.status === 'ARCHIVED'"><option value="">默认</option><option v-for="option in executorReasoningOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><label class="wide">允许的 MCP 工具<input v-model="form.allowedMcpTools" :disabled="project.status === 'ARCHIVED'" placeholder="mcp:docs:search, mcp:repo:list" /></label><label class="wide">允许的插件工具<input v-model="form.allowedPluginTools" :disabled="project.status === 'ARCHIVED'" placeholder="plugin:example:tool" /></label><label class="toggle-field wide"><el-switch v-model="form.computerUseEnabled" :disabled="project.status === 'ARCHIVED'" /> 允许 Computer Use</label></div></section>
          <div class="settings-footer"><span v-if="saved" class="saved-note"><CircleCheck :size="15" /> 已保存为配置 v{{ form.configVersion }}</span><el-button type="primary" :loading="saving" :disabled="project.status === 'ARCHIVED'" @click="save">保存项目配置</el-button></div>
        </main>
      </div>
    </div>
    <template #footer><div class="settings-dialog-footer"><el-button v-if="dirty" type="primary" :loading="saving" :disabled="project?.status === 'ARCHIVED'" @click="finish">保存并关闭</el-button><el-button v-else @click="close">完成</el-button></div></template>
  </el-dialog>
</template>

<style>
.project-settings-dialog .el-dialog__header { margin-right: 0; padding: 22px 26px 16px; border-bottom: 1px solid #edf0f4; }.project-settings-dialog .el-dialog__body { padding: 0 26px 8px; }.project-settings-dialog .el-dialog__footer { padding: 10px 26px 20px; border-top: 1px solid #edf0f4; }.project-settings-dialog .settings-dialog-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding-right: 26px; }.project-settings-dialog .settings-dialog-heading h1 { margin: 7px 0 4px; color: #1d2b40; font-size: 23px; letter-spacing: -.05em; }.project-settings-dialog .settings-dialog-heading p { margin: 0; overflow: hidden; max-width: 630px; color: #8290a2; font: 10px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }.project-settings-dialog .eyebrow { color: #8492a8; font-size: 10px; font-weight: 800; letter-spacing: .16em; }.project-settings-dialog .settings-heading-actions { display: flex; align-items: center; gap: 10px; color: #9aa6b5; font-size: 10px; }.project-settings-dialog .settings-dialog-body { min-height: 0; }.project-settings-dialog .settings-error { display: flex; align-items: center; gap: 8px; margin: 15px 0 0; padding: 10px 12px; border: 1px solid #f0d1d5; border-radius: 7px; background: #fff6f7; color: #a35560; font-size: 11px; }.project-settings-dialog .settings-shell { display: grid; grid-template-columns: 175px minmax(0, 1fr); max-height: min(62vh, 570px); min-height: 440px; margin-top: 15px; overflow: hidden; border: 1px solid #e1e7ef; border-radius: 9px; background: #fff; }.project-settings-dialog .settings-tabs { overflow-y: auto; padding: 11px 8px; border-right: 1px solid #edf0f4; background: #fbfcfe; }.project-settings-dialog .settings-tabs button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; margin-bottom: 3px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: #8693a5; cursor: pointer; font-size: 11px; text-align: left; }.project-settings-dialog .settings-tabs button:hover, .project-settings-dialog .settings-tabs button.active { background: #edf3ff; color: #4c76d3; font-weight: 700; }.project-settings-dialog .settings-content { min-width: 0; overflow-y: auto; padding: 24px 27px; }.project-settings-dialog .settings-section { min-height: 360px; }.project-settings-dialog .section-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }.project-settings-dialog .section-title h2 { margin: 0 0 5px; color: #3d4d65; font-size: 16px; }.project-settings-dialog .section-title p { margin: 0; color: #929eae; font-size: 10px; line-height: 1.5; }.project-settings-dialog .settings-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px 13px; }.project-settings-dialog .settings-form-grid label, .project-settings-dialog .command-editor label { display: block; color: #718097; font-size: 10px; font-weight: 700; }.project-settings-dialog .settings-form-grid input, .project-settings-dialog .command-editor input { display: block; width: 100%; height: 34px; margin-top: 7px; padding: 0 9px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; box-sizing: border-box; }.project-settings-dialog .settings-form-grid input:focus, .project-settings-dialog .command-editor input:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }.project-settings-dialog .settings-form-grid input:disabled { color: #a4afbc; background: #f5f7fa; }.project-settings-dialog .wide { grid-column: 1 / -1; }.project-settings-dialog .input-with-button { display: flex; gap: 8px; }.project-settings-dialog .input-with-button input { flex: 1; }.project-settings-dialog .input-with-button .el-button { margin-top: 7px; font-size: 10px; }.project-settings-dialog .settings-notice { display: flex; gap: 10px; margin-top: 24px; padding: 11px 12px; border: 1px solid #dbe7ff; border-radius: 7px; background: #f6f9ff; color: #7183a3; font-size: 10px; line-height: 1.55; }.project-settings-dialog .settings-notice svg { flex: 0 0 auto; color: #638be0; }.project-settings-dialog .settings-notice strong { display: block; margin-bottom: 3px; color: #506b9d; font-size: 10px; }.project-settings-dialog .settings-notice p { margin: 0; }.project-settings-dialog .command-editor { margin-bottom: 13px; padding: 13px; border: 1px solid #e5eaf1; border-radius: 8px; background: #fbfcfe; }.project-settings-dialog .command-editor-row { display: grid; grid-template-columns: 150px 1fr 30px; gap: 9px; align-items: end; margin-bottom: 12px; }.project-settings-dialog .command-editor-row .el-button { margin-bottom: 7px; }.project-settings-dialog .settings-empty { display: grid; justify-items: center; gap: 8px; padding: 38px; border: 1px dashed #dce4ed; border-radius: 8px; color: #a2adbb; font-size: 11px; }.project-settings-dialog .hook-editor { display: grid; grid-template-columns: 1fr auto; gap: 5px 18px; margin-bottom: 13px; padding: 15px; border: 1px solid #e5eaf1; border-radius: 8px; background: #fbfcfe; }.project-settings-dialog .hook-editor h3 { margin: 0 0 4px; color: #52627a; font-size: 12px; }.project-settings-dialog .hook-editor p { margin: 0; color: #95a1b0; font-size: 10px; }.project-settings-dialog .hook-editor .settings-form-grid { grid-column: 1 / -1; margin-top: 10px; }.project-settings-dialog .hook-blocking { grid-column: 1 / -1; margin-top: 11px; padding-top: 10px; border-top: 1px dashed #e5eaf1; }.project-settings-dialog .hook-blocking .el-checkbox { height: auto; }.project-settings-dialog .hook-blocking p { margin: 4px 0 0; color: #95a1b0; font-size: 10px; line-height: 1.5; }.project-settings-dialog .toggle-field { display: flex !important; align-items: center; gap: 10px; color: #61718a !important; }.project-settings-dialog .settings-footer { display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding-top: 17px; border-top: 1px solid #edf0f4; }.project-settings-dialog .settings-footer .el-button, .project-settings-dialog .settings-dialog-footer .el-button { font-size: 11px; }.project-settings-dialog .saved-note { display: flex; align-items: center; gap: 5px; color: #24a572; font-size: 10px; }.project-settings-dialog .settings-dialog-footer { display: flex; justify-content: flex-end; }
@media (max-width: 760px) { .project-settings-dialog .el-dialog__body { padding: 0 14px 8px; }.project-settings-dialog .el-dialog__footer { padding-left: 14px; padding-right: 14px; }.project-settings-dialog .settings-dialog-heading { display: block; padding-right: 20px; }.project-settings-dialog .settings-heading-actions { margin-top: 12px; }.project-settings-dialog .settings-shell { grid-template-columns: 1fr; max-height: 65vh; }.project-settings-dialog .settings-tabs { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid #edf0f4; }.project-settings-dialog .settings-tabs button { width: auto; min-width: max-content; }.project-settings-dialog .settings-form-grid { grid-template-columns: 1fr; }.project-settings-dialog .wide { grid-column: auto; }.project-settings-dialog .command-editor-row { grid-template-columns: 1fr; }.project-settings-dialog .hook-editor { grid-template-columns: 1fr; }.project-settings-dialog .hook-editor .el-switch { position: absolute; margin-top: -38px; margin-left: 250px; } }
.project-settings-dialog .settings-shell { height: min(54vh, 430px); max-height: min(54vh, 430px); min-height: 0; }
.project-settings-dialog .settings-form-grid select { display: block; width: 100%; height: 34px; margin-top: 7px; padding: 0 9px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; box-sizing: border-box; }.project-settings-dialog .settings-form-grid select:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }.project-settings-dialog .settings-form-grid select:disabled { color: #a4afbc; background: #f5f7fa; }.project-settings-dialog .field-hint { display: block; margin-top: 5px; color: #9aa6b5; font-size: 9px; font-weight: 500; line-height: 1.4; word-break: break-all; }
.project-settings-dialog .settings-form-grid select { display: block; width: 100%; height: 34px; margin-top: 7px; padding: 0 9px; border: 1px solid #dfe6ef; border-radius: 5px; outline: 0; color: #52627a; background: #fff; font-size: 11px; box-sizing: border-box; }.project-settings-dialog .settings-form-grid select:focus { border-color: #82a6ef; box-shadow: 0 0 0 2px #edf3ff; }.project-settings-dialog .settings-form-grid select:disabled { color: #a4afbc; background: #f5f7fa; }
</style>
