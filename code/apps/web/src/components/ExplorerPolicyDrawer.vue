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
          <div class="eyebrow">PLAN MODE · TOOL POLICY</div>
          <h2>Explorer policy</h2>
        </div>
        <el-button text circle aria-label="Close policy" @click="emit('update:modelValue', false)">
          <Close />
        </el-button>
      </div>

      <div class="policy-hero">
        <div class="policy-hero-icon"><DocumentChecked :size="22" /></div>
        <div>
          <strong>Read-only exploration</strong>
          <p>ExplorerThread can understand the repository before any change is authorized.</p>
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
          <strong>Authorization boundary</strong>
          <p>Only Confirm plan and Enqueue plan can move work from exploration into execution. The ExplorerThread cannot perform that transition by itself.</p>
        </div>
      </div>

      <div class="policy-drawer-actions">
        <el-button type="primary" @click="emit('update:modelValue', false)">Got it <Right /></el-button>
      </div>
    </div>
  </el-drawer>
</template>
