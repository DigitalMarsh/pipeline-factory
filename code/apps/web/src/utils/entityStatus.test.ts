import { describe, expect, it } from "vitest";
import { explorerThreadStateLabel, projectStatusLabel } from "./entityStatus";

describe("左侧栏实体状态的文案", () => {
  it("Project 两档", () => {
    expect(projectStatusLabel("ACTIVE")).toBe("启用中");
    expect(projectStatusLabel("ARCHIVED")).toBe("已归档");
  });

  it("ExplorerThread 四档各说各的，不压成'还在用 / 已归档'两档", () => {
    // 此前非 ACTIVE 非 ARCHIVED 的线程一律显示 `Completed`——`WAITING_FOR_INPUT` 与
    // `COMPRESSED` 都被读成"已完成"，那是一句错话。颜色可以看起来一样，文案不能。
    expect(explorerThreadStateLabel("ACTIVE")).toBe("启用中");
    expect(explorerThreadStateLabel("WAITING_FOR_INPUT")).toBe("等待输入");
    expect(explorerThreadStateLabel("COMPRESSED")).toBe("已压缩");
    expect(explorerThreadStateLabel("ARCHIVED")).toBe("已归档");
  });
});
