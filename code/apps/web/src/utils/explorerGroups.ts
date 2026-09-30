/**
 * 模块职责：把探索线程按**创建日**分组（今天 / 昨天 / 具体日期），供左侧导航按天浏览。
 *
 * 为什么按创建日而不是最近活动日：线程的默认标题就是**创建时刻**（见 domain 的
 *   `explorerTimestampTitle`），"9 月 29 日那批探索"是它被命名的依据。按活动日分组会让
 *   昨天开、今天还在用的线程跳到"今天"组，与它显示的名字自相矛盾。
 *
 * 维护提示：
 *   1) **一律用本地日期**（`getFullYear/getMonth/getDate`），不要走 `toISOString().slice(0,10)`——
 *      后者是 UTC 日期，在东八区的晚上会把"今天"算成"昨天"。
 *   2) 分组顺序沿用输入顺序（接口已按最近活动倒序），所以"今天"在最前，且组内顺序不变。
 *   3) 缺时间戳/坏时间戳归到 `unknown` 组并**明确标出来**，不混进"今天"。
 */
import type { ExplorerThread } from "../types";

export type ExplorerDayGroup = { day: string; label: string; explorers: ExplorerThread[] };

/** 本地日历日键（YYYY-MM-DD）；无法解析时为 null。 */
export function explorerDayKey(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 组标题：今天 / 昨天 / 具体日期（标题本身已经是日期，所以"更早"这种模糊说法不必要）。 */
export function explorerDayLabel(dayKey: string, now = new Date()): string {
  if (dayKey === explorerDayKey(now)) return "今天";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey === explorerDayKey(yesterday)) return "昨天";
  return dayKey;
}

/**
 * 按创建日分组。**组按日期倒序**（新的在前，"创建时间未知"永远最后），组内保持传入顺序。
 *
 * 为什么必须排组：线程列表是按**最近活动**倒序来的，而组名是**创建日**——不排的话会出现
 * "9-26、9-25、9-27" 这种看着像坏了的顺序（9-27 那天开的线程只是最近没人动过）。
 */
export function groupExplorersByDay(explorers: ExplorerThread[], now = new Date()): ExplorerDayGroup[] {
  const groups = new Map<string, ExplorerThread[]>();
  for (const explorer of explorers) {
    const day = explorerDayKey(explorer.createdAt) ?? "unknown";
    const bucket = groups.get(day);
    if (bucket) bucket.push(explorer);
    else groups.set(day, [explorer]);
  }
  return [...groups]
    .sort(([left], [right]) => (left === "unknown" ? 1 : right === "unknown" ? -1 : right.localeCompare(left)))
    .map(([day, items]) => ({ day, label: day === "unknown" ? "创建时间未知" : explorerDayLabel(day, now), explorers: items }));
}

/**
 * 分组结果摊平成"日期头 + 线程行"的单一列表，供模板一次 `v-for` 渲染。
 *
 * 为什么摊平而不是嵌套循环：嵌套会把整段行标记再缩进一层，diff 变大且容易看漏；而这一步的
 * 语义也确实是一个有序列表（"这一天的标题，然后是这几行"）。
 * `explorer` 在日期头上是 `undefined`（不是缺字段），模板因此不必做类型收窄。
 */
export type ExplorerListRow =
  | { kind: "day"; key: string; day: string; label: string; count: number; explorer?: undefined }
  | { kind: "explorer"; key: string; day: string; label?: undefined; count?: undefined; explorer: ExplorerThread };

export function explorerListRows(explorers: ExplorerThread[], now = new Date()): ExplorerListRow[] {
  return groupExplorersByDay(explorers, now).flatMap((group) => [
    { kind: "day" as const, key: `day:${group.day}`, day: group.day, label: group.label, count: group.explorers.length },
    ...group.explorers.map((explorer) => ({ kind: "explorer" as const, key: `explorer:${explorer.id}`, day: group.day, explorer })),
  ]);
}
