/**
 * 测试职责：验证探索线程按创建日分组、跨时区安全的日键计算，以及脏数据的归类。
 * 维护提示：日期一律按本地时区断言（构造 Date 而不是写 UTC 字符串），否则测试会在 CI 的
 *   UTC 环境与本地环境给出不同结论。
 */
import { describe, expect, it } from "vitest";
import { explorerDayKey, explorerDayLabel, explorerListRows, groupExplorersByDay } from "./explorerGroups";
import type { ExplorerThread } from "../types";

function thread(id: string, createdAt: string): ExplorerThread {
  return { id, title: id, createdAt, state: "ACTIVE" } as ExplorerThread;
}

describe("explorer day grouping", () => {
  it("labels today and yesterday in local time", () => {
    const now = new Date(2026, 9, 1, 23, 30); // 本地 2026-10-01 23:30
    expect(explorerDayKey(now)).toBe("2026-10-01");
    expect(explorerDayLabel("2026-10-01", now)).toBe("今天");
    expect(explorerDayLabel("2026-09-30", now)).toBe("昨天");
    // 更早的日子直接显示日期——标题本身就是日期，模糊的"更早"没有信息量。
    expect(explorerDayLabel("2026-09-20", now)).toBe("2026-09-20");
  });

  it("uses the local date, not the UTC date, near midnight", () => {
    // 本地 2026-10-01 00:30 在 UTC 还是 09-30：按 UTC 取日键会把"今天"算成"昨天"。
    const nearMidnight = new Date(2026, 9, 1, 0, 30);
    expect(explorerDayKey(nearMidnight)).toBe("2026-10-01");
    expect(explorerDayKey("2026-10-01T00:30:00")).toBe("2026-10-01");
  });

  it("orders day groups newest first and keeps unknown timestamps last", () => {
    const now = new Date(2026, 9, 1, 12, 0);
    // 输入是"最近活动倒序"，组名却是创建日：不排组就会出现 9-26、9-25、9-27 这种看着像坏了的顺序。
    const groups = groupExplorersByDay(
      [
        thread("sep26", new Date(2026, 8, 26, 9, 0).toISOString()),
        thread("sep25", new Date(2026, 8, 25, 9, 0).toISOString()),
        thread("sep27", new Date(2026, 8, 27, 9, 0).toISOString()),
        thread("broken", "nope"),
      ],
      now,
    );
    expect(groups.map((group) => group.day)).toEqual(["2026-09-27", "2026-09-26", "2026-09-25", "unknown"]);
  });

  it("groups by creation day, keeping the incoming order and flagging unknown timestamps", () => {
    const now = new Date(2026, 9, 1, 12, 0);
    const groups = groupExplorersByDay(
      [
        thread("today-a", new Date(2026, 9, 1, 9, 5).toISOString()),
        thread("today-b", new Date(2026, 9, 1, 8, 0).toISOString()),
        thread("yesterday", new Date(2026, 8, 30, 21, 0).toISOString()),
        thread("broken", "not-a-date"),
        thread("missing", ""),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "创建时间未知"]);
    expect(groups[0]?.explorers.map((explorer) => explorer.id)).toEqual(["today-a", "today-b"]);
    expect(groups[1]?.explorers.map((explorer) => explorer.id)).toEqual(["yesterday"]);
    // 坏时间戳与空值不该混进"今天"：它们集中在一组里显式暴露，而不是给出一个看似正确的日期。
    expect(groups[2]?.explorers.map((explorer) => explorer.id)).toEqual(["broken", "missing"]);
  });

  it("returns nothing for an empty list instead of an empty group", () => {
    expect(groupExplorersByDay([], new Date(2026, 9, 1))).toEqual([]);
  });

  it("flattens groups into day headers followed by their rows", () => {
    const rows = explorerListRows(
      [thread("today", new Date(2026, 9, 1, 9, 0).toISOString()), thread("older", new Date(2026, 8, 28, 9, 0).toISOString())],
      new Date(2026, 9, 1, 12, 0),
    );

    expect(rows.map((row) => [row.kind, row.label ?? row.explorer?.id])).toEqual([
      ["day", "今天"],
      ["explorer", "today"],
      ["day", "2026-09-28"],
      ["explorer", "older"],
    ]);
    // 组内的行紧跟在自己的日期头后面（摊平不改变从属关系）。
    // 日期头上没有 explorer：模板据此渲染标题分支，不需要类型收窄。
    expect(rows[0]?.explorer).toBeUndefined();
    expect(rows[1]).toMatchObject({ day: "2026-10-01" });
  });
});
