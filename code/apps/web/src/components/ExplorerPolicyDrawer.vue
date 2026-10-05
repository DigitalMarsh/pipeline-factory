<!--
  模块职责：展示 Explorer 的只读策略和能力边界。
  维护提示：交互状态和数据流变化时，应同步更新组件边界说明。
-->
<script setup lang="ts">
import { Close, DocumentChecked, Lock, Right } from "@element-plus/icons-vue";
import { explorerPolicySections } from "../utils/policyPanel";

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    size="min(430px, 92vw)"
    :with-header="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="policy-drawer-shell">
      <div class="drawer-header">
        <div>
          <div class="eyebrow">Plan 模式 · 工具策略</div>
          <h2>探索策略</h2>
        </div>
        <el-button text circle aria-label="关闭策略" @click="emit('update:modelValue', false)">
          <Close />
        </el-button>
      </div>

      <div class="policy-hero">
        <div class="policy-hero-icon"><DocumentChecked :size="22" /></div>
        <div>
          <strong>只读探索</strong>
          <p>在授权任何改动之前，先让探索线程把仓库读懂。</p>
        </div>
      </div>

      <section v-for="(section, index) in explorerPolicySections" :key="section.title" class="policy-section">
        <div class="section-heading"><span>{{ String(index + 1).padStart(2, "0") }}</span><strong>{{ section.title }}</strong></div>
        <ul class="policy-list">
          <li v-for="item in section.items" :key="item"><span class="policy-check">✓</span>{{ item }}</li>
        </ul>
      </section>

      <div class="policy-boundary">
        <Lock :size="16" />
        <div>
          <strong>授权边界</strong>
          <p>只有「确认方案」与「入队方案」能把工作从探索推进到执行；探索线程自己做不到这一步。</p>
        </div>
      </div>

      <div class="policy-drawer-actions">
        <el-button type="primary" @click="emit('update:modelValue', false)">知道了 <Right /></el-button>
      </div>
    </div>
  </el-drawer>
</template>
