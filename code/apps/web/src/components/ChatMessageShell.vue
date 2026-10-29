<!--
  模块职责：聊天区唯一的一行外壳——头像栏 + 内容栏（meta / 正文 / 脚注）。
  探索线程与执行线程共用它，保证"谁在说、什么时候、什么状态"在两处是同一套排版。

  维护提示：
  1. **一行一个根元素**。调用方（ExecutionMessageRow）会把 `data-sequence` / `title` 等属性
     直接挂在 `<ChatMessageShell>` 上，靠 Vue 的属性透传落到根 `<article>`；改根节点会破坏
     `RunDetailView.focusExecutionTask()` 的 `[data-sequence]` 查询。
  2. **锚点归外壳**：`anchorId` / `navKey` 必须落在根节点上，`useTimelineScroll` 按 `[data-nav-key]`
     找行、`jumpToTimelineTarget` 按 id 跳转。
  3. **过程行（推理 / 工具 / 输入卡 / Plan 卡）不传 avatar**：内容仍然从内容栏开始，与正文对齐，
     但不在每一行重复头像。头像只表示"谁在说"，不表示"这是哪一类行"。
  4. 状态文案、时间格式化由调用方传入；这里不认识领域状态，也不读全局 store。
-->
<script setup lang="ts">
import { computed, type Component } from "vue";
import type { StatusTagType } from "../utils/statusTag";

export type ChatAvatar = "explorer" | "executor" | "user";

const props = withDefaults(
  defineProps<{
    side: "assistant" | "user";
    /** 角色头像；过程行留空。 */
    avatar?: ChatAvatar | null;
    /** 过程行的类型图标（工具 / 命令 / 文件 / 推理…）；与 avatar 二选一。 */
    icon?: Component | null;
    /** 说话者名字（助手行 meta 的第一段）。 */
    author?: string | null;
    /** meta 的主标题：活动标签、执行条目标题。 */
    headline?: string | null;
    /** 等宽标识：命令、文件路径、工具名。 */
    name?: string | null;
    statusLabel?: string | null;
    statusType?: StatusTagType | null;
    /** 已格式化好的 HH:MM。 */
    time?: string | null;
    /** `<time datetime>` 用的原始时间串。 */
    datetime?: string | null;
    /** 根节点 id：时间线跳转锚点。 */
    anchorId?: string | null;
    /** 根节点 data-nav-key：激活行判定。 */
    navKey?: string | null;
    /** 过程行：更紧凑的行距，不画大头像位。 */
    compact?: boolean;
    /** 用户气泡。默认用户消息为 true，助手消息为 false；显式传 false 可关掉。 */
    bubble?: boolean | null;
    failed?: boolean;
    running?: boolean;
    ariaLabel?: string | null;
  }>(),
  {
    avatar: null,
    icon: null,
    author: null,
    headline: null,
    name: null,
    statusLabel: null,
    statusType: null,
    time: null,
    datetime: null,
    anchorId: null,
    navKey: null,
    compact: false,
    bubble: null,
    failed: false,
    running: false,
    ariaLabel: null,
  },
);

const AVATAR_GLYPH: Record<ChatAvatar, string> = { explorer: "探", executor: "执", user: "你" };
const AVATAR_LABEL: Record<ChatAvatar, string> = { explorer: "Plan Explorer", executor: "Executor", user: "你" };

const showBubble = computed(() => props.bubble ?? props.side === "user");
const hasMeta = computed(
  () => props.side === "assistant" && Boolean(props.author || props.headline || props.name || props.statusLabel || props.time),
);
const avatarLabel = computed(() => (props.avatar ? AVATAR_LABEL[props.avatar] : null));
</script>

<template>
  <article
    :id="anchorId ?? undefined"
    :data-nav-key="navKey ?? undefined"
    :aria-label="ariaLabel ?? avatarLabel ?? undefined"
    :class="[
      'chat-message',
      `chat-message-${side}`,
      {
        'chat-message-process': compact,
        'chat-message-bubble': showBubble,
        'chat-message-failed': failed,
        'chat-message-running': running,
      },
    ]"
  >
    <div v-if="avatar" class="chat-avatar" :class="`chat-avatar-${avatar}`" aria-hidden="true">
      <slot name="avatar">{{ AVATAR_GLYPH[avatar] }}</slot>
    </div>
    <div v-else-if="icon" class="chat-process-icon" aria-hidden="true"><component :is="icon" /></div>
    <div class="chat-content">
      <header v-if="hasMeta" class="chat-meta">
        <strong v-if="author" class="chat-author">{{ author }}</strong>
        <span v-if="headline" class="chat-headline">{{ headline }}</span>
        <code v-if="name" class="chat-name">{{ name }}</code>
        <el-tag v-if="statusLabel" size="small" effect="light" :type="statusType ?? 'info'">{{ statusLabel }}</el-tag>
        <time v-if="time" class="chat-time" :datetime="datetime ?? undefined" :title="datetime ?? undefined">{{ time }}</time>
        <slot name="meta-actions" />
      </header>
      <div class="chat-body" :class="{ 'chat-bubble': showBubble }"><slot /></div>
      <footer v-if="side === 'user' && (time || $slots['meta-actions'])" class="chat-foot">
        <time v-if="time" :datetime="datetime ?? undefined" :title="datetime ?? undefined">{{ time }}</time>
        <slot name="meta-actions" />
      </footer>
      <footer v-else-if="side === 'assistant' && !hasMeta && $slots['meta-actions']" class="chat-foot">
        <slot name="meta-actions" />
      </footer>
    </div>
  </article>
</template>
