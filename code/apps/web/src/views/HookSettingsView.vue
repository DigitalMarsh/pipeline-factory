<!--
  模块职责：编辑 Project Hook 配置并反馈持久化状态。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ArrowLeft, CircleCheck, InfoFilled, Setting } from "@element-plus/icons-vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";

const route = useRoute();
const router = useRouter();
const saving = ref(false);
const saved = ref(false);
const error = ref<string | null>(null);
const form = reactive({ startEnabled: false, startCommandId: "", startTimeoutMs: 120000, cleanupEnabled: false, cleanupCommandId: "", cleanupTimeoutMs: 120000 });
/** 读取 Project 持久化 Hook；API 不可用时只显示可编辑草稿，不冒充已保存配置。 */
async function load() { error.value = null; try { const response = await api.getProjectHooks(String(route.params.projectId)); if (response.lifecycle.start) { form.startEnabled = response.lifecycle.start.enabled !== false; form.startCommandId = response.lifecycle.start.commandId; form.startTimeoutMs = response.lifecycle.start.timeoutMs ?? 120000; } if (response.lifecycle.cleanup) { form.cleanupEnabled = response.lifecycle.cleanup.enabled !== false; form.cleanupCommandId = response.lifecycle.cleanup.commandId; form.cleanupTimeoutMs = response.lifecycle.cleanup.timeoutMs ?? 120000; } } catch { error.value = "API 未连接，当前显示可编辑的本地配置"; } }
/** 保存 Hook 配置并让 ProjectService 负责版本冲突和活动 Run 保护。 */
async function save() { saving.value = true; saved.value = false; error.value = null; const lifecycle: Record<string, unknown> = {}; if (form.startCommandId) lifecycle.start = { commandId: form.startCommandId, enabled: form.startEnabled, timeoutMs: form.startTimeoutMs }; if (form.cleanupCommandId) lifecycle.cleanup = { commandId: form.cleanupCommandId, enabled: form.cleanupEnabled, timeoutMs: form.cleanupTimeoutMs }; try { await api.saveProjectHooks(String(route.params.projectId), lifecycle); saved.value = true; } catch { error.value = "保存失败，请检查 API 状态和命令配置"; } finally { saving.value = false; } }
onMounted(load);
</script>

<template>
  <div class="settings-page"><div class="detail-top"><el-button text @click="router.back()"><ArrowLeft :size="15" /> 返回</el-button><span class="eyebrow">项目设置</span></div><div class="settings-heading"><div class="settings-icon"><Setting :size="20" /></div><div><div class="eyebrow">生命周期钩子</div><h1>项目的启动与清理</h1><p>已登记命令 run through ToolGateway with fixed argv, timeout and HookContext.</p></div></div><div class="settings-notice"><InfoFilled :size="16" /><div><strong>执行顺序是强制的</strong><p>启动钩子在 Worktree 创建后、Executor 第一个回合之前执行；清理钩子只在 Worktree 移除后执行，清理失败会进入「需要处理」。</p></div></div><div v-if="error" class="demo-notice"><InfoFilled :size="14" /> {{ error }}</div><section class="hook-form"><div class="hook-form-heading"><div><h2>启动钩子</h2><p>代码执行前先把新 Worktree 初始化好。</p></div><el-switch v-model="form.startEnabled" active-text="Enabled" /></div><div class="form-grid"><label>命令 ID<input v-model="form.startCommandId" placeholder="project.start" /></label><label>超时（毫秒）<input v-model.number="form.startTimeoutMs" type="number" min="1000" /></label></div></section><section class="hook-form"><div class="hook-form-heading"><div><h2>清理钩子</h2><p>Worktree 移除后，从稳定的项目目录执行。</p></div><el-switch v-model="form.cleanupEnabled" active-text="Enabled" /></div><div class="form-grid"><label>命令 ID<input v-model="form.cleanupCommandId" placeholder="project.cleanup" /></label><label>超时（毫秒）<input v-model.number="form.cleanupTimeoutMs" type="number" min="1000" /></label></div></section><div class="settings-actions"><span v-if="saved" class="saved-note"><CircleCheck :size="15" /> 已保存</span><el-button type="primary" :loading="saving" @click="save">保存钩子配置</el-button></div></div>
</template>
