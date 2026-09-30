<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowUp, CircleClose, Connection, Refresh, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import type { Project, ProjectExecutionEvent, ProjectExecutionMessage, ProjectExecutionThreadSnapshot } from "../types";
import MarkdownMessage from "./MarkdownMessage.vue";
import { backendLabel, modelOptionsFor, reasoningOptionsWith } from "../utils/modelCatalog";
import { useModelBackends } from "../composables/useModelBackends";

const props = defineProps<{ projectId: string; project: Project | null }>();
const snapshot = ref<ProjectExecutionThreadSnapshot | null>(null);
const messages = ref<ProjectExecutionMessage[]>([]);
const events = ref<ProjectExecutionEvent[]>([]);
const draft = ref("");
const loading = ref(true);
const sending = ref(false);
const savingPreferences = ref(false);
const connectionError = ref("");
const streamConnected = ref(false);
const modelSelection = ref("");
const reasoningSelection = ref("");
const timeline = ref<HTMLElement | null>(null);
let source: EventSource | null = null;
let requestGeneration = 0;

const activeAssistant = computed(() => messages.value.find((message) => message.role === "assistant" && ["RUNNING", "QUEUED", "WAITING_FOR_INPUT"].includes(message.status)) ?? null);
const queuedCount = computed(() => messages.value.filter((message) => message.role === "assistant" && message.status === "QUEUED").length);
const canSend = computed(() => Boolean(props.project && props.project.status === "ACTIVE" && draft.value.trim() && !sending.value));
const effectiveModel = computed(() => modelSelection.value || snapshot.value?.defaultModel || "");
const effectiveReasoningEffort = computed(() => reasoningSelection.value || snapshot.value?.defaultReasoningEffort || "default");
/**
 * 这些模型与档位来自**该项目的 executor 后端**，不是一份全局清单：换个 agent 之后能选的东西就变了。
 * 已保存的覆盖值始终并入选项，否则用户看不到自己配了什么、也没法清掉它。
 */
const { catalog: modelCatalog, load: loadModelBackends } = useModelBackends();
const executorBackend = computed(() => snapshot.value?.backend ?? "");
const executorBackendLabel = computed(() => backendLabel(modelCatalog.value, executorBackend.value));
const executorModelOptions = computed(() => modelOptionsFor(modelCatalog.value, executorBackend.value, ...(snapshot.value?.modelOptions ?? [])));
const executorReasoningOptions = computed(() => reasoningOptionsWith(modelCatalog.value, executorBackend.value, reasoningSelection.value));

function closeEvents() {
  source?.close();
  source = null;
  streamConnected.value = false;
}

function connectEvents(projectId: string, afterSequence: number) {
  closeEvents();
  const next = new EventSource(api.projectExecutionEventsUrl(projectId, afterSequence));
  source = next;
  next.onopen = () => { streamConnected.value = true; connectionError.value = ""; };
  next.onerror = () => { streamConnected.value = false; };
  next.addEventListener("project.execution", (rawEvent) => {
    if (projectId !== props.projectId) return;
    try {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as { sequence: number; type: string; payload: Record<string, unknown> };
      applyEvent(event);
    } catch { /* Ignore a malformed event and allow EventSource to replay after reconnect. */ }
  });
}

function applyEvent(event: { sequence: number; type: string; payload: Record<string, unknown> }) {
  const payload = event.payload;
  const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
  if (event.type === "project.execution.turn.text.delta" && messageId) {
    const current = messages.value.find((message) => message.id === messageId);
    if (current && typeof payload.content === "string") current.content = payload.content;
  } else if (event.type === "project.execution.turn.started" && messageId) {
    updateMessage(messageId, { status: "RUNNING", model: typeof payload.model === "string" ? payload.model : null, reasoningEffort: typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : null });
  } else if (event.type === "project.execution.turn.accepted" && typeof payload.assistantMessageId === "string") {
    updateMessage(payload.assistantMessageId, { status: payload.status === "QUEUED" ? "QUEUED" : "RUNNING" });
  } else if (event.type === "project.execution.turn.completed" && messageId) {
    updateMessage(messageId, { status: "COMPLETED", error: null });
  } else if (event.type === "project.execution.turn.failed" && messageId) {
    updateMessage(messageId, { status: payload.recoveryRequired === true ? "RECOVERY_REQUIRED" : "FAILED", error: typeof payload.error === "string" ? payload.error : "执行失败" });
  } else if (event.type === "project.execution.turn.cancelled" && messageId) {
    updateMessage(messageId, { status: "CANCELLED", error: null });
  } else if (event.type === "project.execution.turn.activity") {
    events.value.push({ id: `event-${event.sequence}`, sequence: event.sequence, type: event.type, aggregateId: snapshot.value?.thread.id ?? "", occurredAt: new Date().toISOString(), payload });
  }
  if (snapshot.value) snapshot.value.lastEventSequence = Math.max(snapshot.value.lastEventSequence, event.sequence);
  void scrollToLatest();
}

function updateMessage(id: string, patch: Partial<ProjectExecutionMessage>) {
  const message = messages.value.find((item) => item.id === id);
  if (message) Object.assign(message, patch);
}

async function load() {
  const projectId = props.projectId;
  const generation = ++requestGeneration;
  if (snapshot.value && snapshot.value.thread.projectId !== projectId) {
    snapshot.value = null;
    messages.value = [];
    events.value = [];
    modelSelection.value = "";
    reasoningSelection.value = "";
  }
  closeEvents();
  loading.value = true;
  connectionError.value = "";
  try {
    const result = await api.projectExecutionThread(projectId);
    if (generation !== requestGeneration || projectId !== props.projectId) return;
    snapshot.value = result;
    messages.value = result.messages;
    events.value = result.events.filter((event) => event.type === "project.execution.turn.activity");
    modelSelection.value = result.thread.modelOverride ?? "";
    reasoningSelection.value = result.thread.reasoningEffortOverride ?? "";
    connectEvents(projectId, result.lastEventSequence);
    await scrollToLatest();
  } catch (error) {
    if (generation !== requestGeneration) return;
    connectionError.value = error instanceof Error ? error.message : "项目执行线程加载失败";
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

async function savePreferences() {
  if (!snapshot.value || savingPreferences.value) return;
  savingPreferences.value = true;
  try {
    const result = await api.updateProjectExecutionPreferences(props.projectId, {
      model: modelSelection.value || null,
      reasoningEffort: reasoningSelection.value || null,
    });
    snapshot.value.thread = result.thread;
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : "模型偏好保存失败";
    ElMessage.error(connectionError.value);
    await load();
  } finally {
    savingPreferences.value = false;
  }
}

function onModelChange() {
  // Effort values are shared by all configured Project model options. If a future
  // provider advertises model-specific capabilities, clear only an unsupported override here.
  void savePreferences();
}

function onReasoningChange() {
  void savePreferences();
}

async function submit() {
  const content = draft.value.trim();
  if (!content || !canSend.value) return;
  sending.value = true;
  connectionError.value = "";
  const clientTurnId = `project-execution-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  draft.value = "";
  try {
    const result = await api.submitProjectExecutionTurn(props.projectId, content, clientTurnId);
    const currentAssistant = messages.value.find((item) => item.id === result.assistant.id);
    const currentUser = messages.value.find((item) => item.id === result.user.id);
    messages.value = [
      ...messages.value.filter((item) => item.turnId !== result.user.turnId),
      currentUser ?? result.user,
      currentAssistant ? { ...result.assistant, ...currentAssistant } : result.assistant,
    ].sort((a, b) => a.sequence - b.sequence);
    await scrollToLatest();
  } catch (error) {
    draft.value = content;
    connectionError.value = error instanceof Error ? error.message : "消息发送失败";
    ElMessage.error(connectionError.value);
  } finally {
    sending.value = false;
  }
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void submit();
}

async function cancelActiveTurn(message: ProjectExecutionMessage) {
  try {
    const response = await api.cancelProjectExecutionTurn(props.projectId, message.id);
    updateMessage(message.id, response.message);
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : "本轮取消失败";
  }
}

function activitiesFor(message: ProjectExecutionMessage) {
  return events.value.filter((event) => event.payload.messageId === message.id);
}

function activityLabel(event: ProjectExecutionEvent): string {
  const kind = event.payload.kind;
  const title = event.payload.title;
  const summary = event.payload.summary;
  if (typeof title === "string" && title) return title;
  if (typeof summary === "string" && summary) return summary;
  if (kind === "input_required") return "模型正在等待输入";
  if (typeof kind === "string" && kind.startsWith("agent.tool.")) return `工具${kind.slice("agent.tool.".length)}`;
  return "执行进度";
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

async function scrollToLatest() {
  await nextTick();
  if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight;
}

watch(() => props.projectId, () => { void load(); });
watch(() => props.project?.settings.models.executor, (config) => {
  if (!config || !snapshot.value) return;
  snapshot.value.defaultModel = config.model;
  snapshot.value.defaultReasoningEffort = config.reasoningEffort ?? null;
  if (!snapshot.value.modelOptions.includes(config.model)) snapshot.value.modelOptions = [...snapshot.value.modelOptions, config.model];
});
onMounted(() => { void load(); void loadModelBackends(); });
onBeforeUnmount(() => { requestGeneration += 1; closeEvents(); });
</script>

<template>
  <section class="project-execution-panel" aria-label="项目执行线程" data-project-execution-panel>
    <header class="project-execution-header">
      <div>
        <p class="project-execution-eyebrow">PROJECT EXECUTION THREAD</p>
        <h1>项目执行线程</h1>
        <p class="project-execution-subtitle">在 {{ project?.repoRoot ?? '项目仓库目录' }} 中直接处理请求，并延续本线程上下文。</p>
      </div>
      <div class="project-execution-connection" role="status">
        <span :class="['project-execution-connection-dot', { connected: streamConnected }]" />
        {{ streamConnected ? '实时连接' : '等待连接' }}
      </div>
    </header>

    <div v-if="connectionError" class="project-execution-error" role="alert"><Warning :size="17" /><span>{{ connectionError }}</span><button type="button" @click="load"><Refresh :size="14" /> 重试</button></div>

    <div ref="timeline" class="project-execution-timeline" aria-live="polite" :aria-busy="loading">
      <div v-if="loading" class="project-execution-empty">正在加载项目执行线程…</div>
      <div v-else-if="!messages.length" class="project-execution-empty">
        <Connection :size="25" />
        <strong>直接开始项目级执行</strong>
        <span>模型会在项目仓库根目录执行请求，后续消息会沿用本线程上下文。</span>
      </div>
      <article v-for="message in messages" :key="message.id" :class="['project-execution-message', `${message.role}-message`, { failed: message.status === 'FAILED' || message.status === 'RECOVERY_REQUIRED' }]" :data-execution-message="message.id">
        <div class="project-execution-message-meta">
          <strong>{{ message.role === 'user' ? '你' : '项目执行助手' }}</strong>
          <time>{{ timeLabel(message.createdAt) }}</time>
          <span v-if="message.role === 'assistant'" :class="['project-execution-status', `status-${message.status.toLowerCase()}`]">{{ message.status === 'QUEUED' ? '排队中' : message.status === 'RUNNING' ? '执行中' : message.status === 'WAITING_FOR_INPUT' ? '等待输入' : message.status === 'COMPLETED' ? '已完成' : message.status === 'CANCELLED' ? '已取消' : message.status === 'RECOVERY_REQUIRED' ? '需要恢复' : '失败' }}</span>
        </div>
        <MarkdownMessage v-if="message.content" :source="message.content" :streaming="message.role === 'assistant' && message.status === 'RUNNING'" />
        <p v-else-if="message.role === 'assistant' && message.status === 'RUNNING'" class="project-execution-placeholder">正在执行…</p>
        <p v-if="message.error" class="project-execution-message-error"><Warning :size="14" /> {{ message.error }}</p>
        <div v-if="message.role === 'assistant' && message.model" class="project-execution-turn-config">{{ message.model }}<span v-if="message.reasoningEffort"> · {{ message.reasoningEffort }}</span></div>
        <div v-if="message.role === 'assistant' && activitiesFor(message).length" class="project-execution-activities" aria-label="执行进度">
          <div v-for="activity in activitiesFor(message)" :key="activity.id" class="project-execution-activity"><span class="project-execution-activity-dot" /><span>{{ activityLabel(activity) }}</span><code v-if="typeof activity.payload.tool === 'string'">{{ activity.payload.tool }}</code></div>
        </div>
        <el-button v-if="message.role === 'assistant' && activeAssistant?.id === message.id" size="small" text type="danger" class="project-execution-cancel" @click="cancelActiveTurn(message)"><CircleClose :size="14" /> 取消本轮</el-button>
      </article>
    </div>

    <footer class="project-execution-composer">
      <textarea v-model="draft" :disabled="project?.status === 'ARCHIVED' || !snapshot || loading" aria-label="项目执行请求" placeholder="描述要在项目中执行的任务…" @keydown="handleComposerKeydown" />
      <div class="project-execution-composer-footer">
        <label class="project-execution-select"><span>Agent</span><output class="project-execution-agent" :title="snapshot?.backend ?? ''">{{ executorBackendLabel }}</output></label>
        <label class="project-execution-select"><span>模型</span><select v-model="modelSelection" :disabled="!snapshot || savingPreferences" aria-label="执行模型" @change="onModelChange"><option value="">跟随项目默认（{{ snapshot?.defaultModel ?? '加载中' }}）</option><option v-for="model in executorModelOptions" :key="model" :value="model">{{ model }}</option></select></label>
        <label class="project-execution-select"><span>推理强度</span><select v-model="reasoningSelection" :disabled="!snapshot || savingPreferences" aria-label="推理强度" @change="onReasoningChange"><option value="">跟随项目默认（{{ snapshot?.defaultReasoningEffort ?? '默认' }}）</option><option v-for="option in executorReasoningOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <span v-if="queuedCount" class="project-execution-queue-status" role="status">{{ queuedCount }} 条请求等待按序执行</span>
        <el-button class="project-execution-send" type="primary" circle :disabled="!canSend" :loading="sending" aria-label="发送执行请求" @click="submit"><ArrowUp :size="17" /></el-button>
      </div>
      <p v-if="project?.status === 'ARCHIVED'" class="project-execution-archived">项目已归档；激活项目后可提交执行请求。</p>
    </footer>
  </section>
</template>

<style scoped>
.project-execution-panel { display:flex; flex:1 1 auto; flex-direction:column; min-width:0; min-height:0; height:100%; background:#fff; color:#1d293b; }
:global(.console-layout.project-execution-mode) { grid-template-columns:minmax(250px,330px) minmax(0,1fr) !important; }
:global(.console-layout.project-execution-mode > .context-panel-shell) { display:none !important; }
.project-execution-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; padding:25px clamp(20px,4vw,48px) 20px; border-bottom:1px solid #e7ecf3; }
.project-execution-eyebrow { margin:0 0 7px; color:#8796ad; font-size:10px; font-weight:800; letter-spacing:.15em; }
.project-execution-header h1 { margin:0; color:#1e2b40; font-size:26px; letter-spacing:-.04em; }
.project-execution-subtitle { margin:8px 0 0; color:#7d8ca3; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
.project-execution-connection { display:flex; align-items:center; gap:8px; padding-top:14px; color:#8694a9; font-size:12px; white-space:nowrap; }
.project-execution-connection-dot,.project-execution-activity-dot { width:7px; height:7px; border-radius:50%; background:#c6d0df; }
.project-execution-connection-dot.connected { background:#47bd88; box-shadow:0 0 0 3px #47bd8820; }
.project-execution-timeline { flex:1 1 auto; min-height:0; overflow:auto; padding:27px clamp(20px,6vw,80px) 34px; scroll-behavior:smooth; }
.project-execution-empty { display:flex; min-height:230px; flex-direction:column; align-items:center; justify-content:center; gap:11px; color:#8c9bb1; text-align:center; }
.project-execution-empty strong { color:#33425a; font-size:17px; }
.project-execution-empty span { max-width:470px; font-size:13px; line-height:1.6; }
.project-execution-message { max-width:860px; margin:0 auto 22px; padding:18px 20px; border:1px solid #e5eaf1; border-radius:12px; background:#fff; box-shadow:0 2px 10px #1f31400a; overflow-wrap:anywhere; }
.project-execution-message.user-message { background:#f6f8fb; }
.project-execution-message.failed { border-color:#f0cccc; background:#fffafa; }
.project-execution-message-meta { display:flex; align-items:center; gap:10px; margin-bottom:12px; color:#8492a7; font-size:11px; }
.project-execution-message-meta strong { color:#52637e; font-size:12px; }
.project-execution-status { margin-left:auto; padding:3px 8px; border-radius:999px; background:#f0f3f7; color:#72839a; font-size:10px; }
.status-running { background:#eaf4ff; color:#387bb7; }.status-completed { background:#eaf8f1; color:#27845b; }.status-failed,.status-recovery_required { background:#fff0f0; color:#b94b53; }
.project-execution-placeholder { color:#93a1b5; font-size:13px; }
.project-execution-message-error { display:flex; align-items:center; gap:7px; color:#b74c55; font-size:12px; white-space:pre-wrap; }
.project-execution-turn-config { margin-top:12px; color:#9aa6b8; font-size:10px; }
.project-execution-activities { display:grid; gap:8px; margin-top:13px; padding-top:12px; border-top:1px solid #eef1f5; }
.project-execution-activity { display:flex; align-items:center; gap:9px; color:#7889a1; font-size:11px; line-height:1.4; }
.project-execution-activity-dot { flex:none; width:6px; height:6px; }
.project-execution-activity code { color:#647794; }
.project-execution-cancel { margin:8px 0 0; }
.project-execution-composer { flex:none; padding:14px clamp(20px,6vw,80px) 13px; border-top:1px solid #e8edf3; background:#fff; }
.project-execution-composer textarea { display:block; width:100%; min-height:88px; max-height:220px; resize:vertical; padding:15px 17px; border:1px solid #dce4ee; border-radius:10px; outline:none; color:#27364d; font:inherit; font-size:14px; line-height:1.55; }
.project-execution-composer textarea:focus { border-color:#5a9ee2; box-shadow:0 0 0 3px #5a9ee21b; }
.project-execution-composer textarea::placeholder { color:#a2afc1; }
.project-execution-composer-footer { display:flex; align-items:center; flex-wrap:wrap; gap:13px; padding-top:11px; }
.project-execution-select { display:flex; align-items:center; gap:7px; color:#96a3b6; font-size:10px; font-weight:800; letter-spacing:.06em; }
.project-execution-select select { max-width:min(220px,28vw); height:30px; padding:0 23px 0 8px; border:1px solid #e2e8f0; border-radius:6px; background:#fff; color:#536681; font:inherit; font-size:11px; letter-spacing:0; }
.project-execution-agent { display:inline-flex; align-items:center; height:30px; max-width:min(180px,24vw); padding:0 9px; overflow:hidden; border:1px dashed #dbe3ee; border-radius:6px; color:#6b7c94; background:#f8fafc; font-size:11px; font-weight:700; letter-spacing:0; text-overflow:ellipsis; white-space:nowrap; }
.project-execution-queue-status { margin-left:auto; color:#8b99ae; font-size:11px; }
.project-execution-send { margin-left:auto; }
.project-execution-queue-status + .project-execution-send { margin-left:0; }
.project-execution-archived { margin:9px 0 0; color:#b76b70; font-size:11px; }
.project-execution-error { display:flex; align-items:center; gap:9px; margin:14px clamp(20px,6vw,80px) 0; padding:10px 12px; border:1px solid #f0cccc; border-radius:8px; background:#fff8f8; color:#ad4c55; font-size:12px; }
.project-execution-error button { display:flex; align-items:center; gap:4px; margin-left:auto; border:0; background:transparent; color:#8e4a50; cursor:pointer; font:inherit; }
@media (max-width:700px) {
  :global(.console-layout.project-execution-mode) { grid-template-columns:168px minmax(0,1fr) !important; }
  .project-execution-header { padding:19px 17px 16px; }
  .project-execution-header h1 { font-size:21px; }
  .project-execution-subtitle { max-width:58vw; font-size:11px; }
  .project-execution-connection { padding-top:8px; font-size:10px; }
  .project-execution-timeline { padding:19px 13px 24px; }
  .project-execution-message { padding:14px; margin-bottom:14px; }
  .project-execution-composer { padding:10px 12px max(10px,env(safe-area-inset-bottom)); }
  .project-execution-composer textarea { min-height:74px; }
  .project-execution-composer-footer { gap:8px; }
  .project-execution-select { align-items:flex-start; flex-direction:column; gap:4px; }
  .project-execution-select select { max-width:40vw; }
  .project-execution-queue-status { width:100%; margin:0; }
}
</style>
