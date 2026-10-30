/**
 * 模块职责：把探索时间线的扁平条目按**回合**分组，供聊天区渲染「Plan Explorer · 时间 · 状态」的回合块。
 *
 * 层级：需求 → 回合（ExplorerTurn）→ 文字 / 推理 / 工具调用等活动。此前所有活动平铺成一行行，
 * 看起来像三个平级的发言者；分组后正文在前、过程行收进「过程 N 步」，层级和回合边界都能看见。
 *
 * 维护提示：
 * 1. **用户消息、分隔行不分组**：它们是回合之间的边界，直接返回成独立条目。
 * 2. **失败与运行中的过程行永远可见**，只有已完成 / 已取消 / 未知的过程行可以折进「过程 N 步」
 *    （与执行侧折叠过程记录同一套规则：失败不被折叠吃掉，live 内容留在外面）。
 * 3. 输入卡按 `request.localTurnId` 归到对应回合；对不上（历史数据 / 回合不在当前页）就独立成卡。
 * 4. 回合状态与时间优先取 `ExplorerTurn` 记录；没有记录时由活动状态推导（RUNNING > FAILED > CANCELLED > WAITING > COMPLETED）。
 */
import type { ExplorerActivityItem, ExplorerTurn } from "../types";
import type { ExplorerTimelineItem } from "./explorerTimeline";

export type ExplorerTimelineEntry = { item: ExplorerTimelineItem; index: number };

export type ExplorerTurnBlock = {
  kind: "turn";
  /** 稳定 key：同一回合如果被其他条目打断，会以 `:n` 区分。 */
  key: string;
  turnId: string;
  status: ExplorerActivityItem["status"];
  occurredAt: string;
  /** 正文、输入卡、运行中 / 失败的过程行：始终可见。 */
  visible: ExplorerTimelineEntry[];
  /** 已完成 / 已取消 / 未知的过程行：收在「过程 N 步」里。 */
  folded: ExplorerTimelineEntry[];
};

export type ExplorerItemBlock = { kind: "item"; key: string; entry: ExplorerTimelineEntry };

export type ExplorerTimelineBlock = ExplorerTurnBlock | ExplorerItemBlock;

/** `ExplorerTurn.status` → 聊天行使用的活动状态词。 */
export function explorerTurnActivityStatus(status: ExplorerTurn["status"]): ExplorerActivityItem["status"] {
  switch (status) {
    case "RUNNING":
      return "RUNNING";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    case "WAITING_FOR_INPUT":
    case "QUEUED":
    case "PAUSED":
      return "WAITING";
    default:
      return "COMPLETED";
  }
}

function isAssistantActivity(activity: ExplorerActivityItem): boolean {
  return activity.kind !== "USER_MESSAGE" && activity.kind !== "CONTEXT";
}

/** 只有正文永远可见；其它助手活动属于"过程"。 */
function isProcess(activity: ExplorerActivityItem): boolean {
  return isAssistantActivity(activity) && activity.kind !== "ASSISTANT_MESSAGE";
}

/** 失败、运行中、等待中的过程行留在外面；完成态才折。 */
function isFoldable(activity: ExplorerActivityItem): boolean {
  return isProcess(activity) && activity.status !== "RUNNING" && activity.status !== "WAITING" && activity.status !== "FAILED";
}

function deriveStatus(entries: ExplorerTimelineEntry[]): ExplorerActivityItem["status"] {
  const statuses = entries
    .filter((entry) => entry.item.kind === "activity")
    .map((entry) => (entry.item.kind === "activity" ? entry.item.activity.status : "COMPLETED"));
  if (statuses.includes("RUNNING")) return "RUNNING";
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("CANCELLED")) return "CANCELLED";
  if (statuses.includes("WAITING")) return "WAITING";
  return "COMPLETED";
}

export function groupExplorerTimeline(entries: ExplorerTimelineEntry[], turns: ExplorerTurn[]): ExplorerTimelineBlock[] {
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const blocks: ExplorerTimelineBlock[] = [];
  // 用对象持有"当前回合"，避免闭包赋值让 TS 把局部变量收窄成 never。
  const state: { current: ExplorerTurnBlock | null } = { current: null };

  const flush = () => {
    if (state.current) blocks.push(state.current);
    state.current = null;
  };
  const startTurn = (turnId: string, occurredAt: string): ExplorerTurnBlock => {
    flush();
    const block: ExplorerTurnBlock = {
      kind: "turn",
      key: `turn:${turnId}:${blocks.length}`,
      turnId,
      status: "COMPLETED",
      occurredAt,
      visible: [],
      folded: [],
    };
    state.current = block;
    return block;
  };

  for (const entry of entries) {
    if (entry.item.kind === "input") {
      const current = state.current;
      if (current && current.turnId === entry.item.request.localTurnId) current.visible.push(entry);
      else {
        flush();
        blocks.push({ kind: "item", key: `item:${entry.item.key}`, entry });
      }
      continue;
    }
    const activity = entry.item.activity;
    // 用户消息与分隔行是回合边界：不并入任何回合块。
    if (activity.kind === "USER_MESSAGE" || activity.kind === "CONTEXT") {
      flush();
      blocks.push({ kind: "item", key: `item:${entry.item.key}`, entry });
      continue;
    }
    let group = state.current;
    if (!group || group.turnId !== activity.turnId) group = startTurn(activity.turnId, activity.occurredAt);
    if (isFoldable(activity)) group.folded.push(entry);
    else group.visible.push(entry);
  }
  flush();

  // 回合状态 / 起始时间优先取 turn 记录；没有记录时再从活动推导。
  for (const block of blocks) {
    if (block.kind !== "turn") continue;
    const turn = turnById.get(block.turnId);
    if (turn) {
      block.status = explorerTurnActivityStatus(turn.status);
      block.occurredAt = turn.createdAt;
    } else {
      block.status = deriveStatus([...block.visible, ...block.folded]);
    }
  }
  return blocks;
}
