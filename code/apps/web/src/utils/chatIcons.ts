/**
 * 模块职责：过程行的**类型图标**——工具 / 命令 / 文件 / 搜索 / 推理 / 输入卡等各配一个。
 *
 * 为什么需要：过程行不挂角色头像（头像只表示"谁在说"），但一屏里只有文字标签时不容易扫出
 * "这一条在调工具还是在推理"。图标放在头像栏里，既保留统一对齐，又让类型一眼可辨。
 *
 * 维护提示：
 * 1. 映射只决定图标，不决定显隐——显隐仍在 `EXPLORER_DISPLAY_MODES` / `EXECUTION_MESSAGE_WEIGHTS`。
 * 2. 新增一种活动/消息类型时，先在这里给一个能认出来的图标；实在没有合适的就用 `Operation` 兜底，
 *    不要留空——空着与"没有类型"看起来一样。
 * 3. 图标是装饰：行组件把它 `aria-hidden`，可读文案在 meta 标签里。
 */
import {
  ChatDotRound,
  Clock,
  Connection,
  Cpu,
  Document,
  EditPen,
  List,
  Monitor,
  Operation,
  Picture,
  Promotion,
  QuestionFilled,
  RefreshRight,
  Search,
  SwitchButton,
  Tools,
} from "@element-plus/icons-vue";
import type { Component } from "vue";
import type { ExplorerActivityItem } from "../types";
import type { ExecutionMessageType, ExecutionStreamItem } from "./executionStream";

const EXPLORER_ICONS: Partial<Record<ExplorerActivityItem["kind"], Component>> = {
  REASONING: ChatDotRound,
  COMMAND: Monitor,
  FILE_CHANGE: Document,
  TOOL_CALL: Tools,
  MCP_CALL: Connection,
  SUBAGENT: Cpu,
  WEB_SEARCH: Search,
  IMAGE_GENERATION: Picture,
  GATE: SwitchButton,
  TURN_STATUS: Clock,
  UNCLASSIFIED: QuestionFilled,
};

/** 探索侧过程行的图标；未知类型用通用操作图标兜底。 */
export function explorerProcessIcon(kind: ExplorerActivityItem["kind"]): Component {
  return EXPLORER_ICONS[kind] ?? Operation;
}

/** 输入卡不是活动，但有自己明确的行型。 */
export const EXPLORER_INPUT_ICON: Component = EditPen;
/** 兜底行：未识别形态。 */
export const EXPLORER_UNKNOWN_ICON: Component = QuestionFilled;

const EXECUTION_ICONS: Partial<Record<ExecutionMessageType, Component>> = {
  PLAN: Promotion,
  TASK_LIFECYCLE: List,
  RUN_ACTIVITY: Operation,
  RECOVERY: RefreshRight,
  COMMAND: Monitor,
  FILE_CHANGE: Document,
  TOOL_CALL: Tools,
  MCP_CALL: Connection,
  SUBAGENT: Cpu,
  WEB_SEARCH: Search,
  IMAGE_GENERATION: Picture,
  GATE: SwitchButton,
  REASONING: ChatDotRound,
  TURN_STATUS: Clock,
  UNCLASSIFIED: QuestionFilled,
};

/** 执行侧过程行的图标；正文行（用户 / 模型）不走这里（它们有角色头像）。 */
export function executionProcessIcon(item: ExecutionStreamItem): Component {
  if (item.kind === "reasoning") return ChatDotRound;
  if (item.kind === "plan") return Promotion;
  return EXECUTION_ICONS[item.messageType] ?? Tools;
}
