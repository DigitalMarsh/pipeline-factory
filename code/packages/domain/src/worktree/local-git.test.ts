/**
 * 测试职责：Worktree Git 端口的**纯解析函数** —— porcelain、分支详情、ahead/behind、
 *   name-status、merge-tree 冲突输出、git 版本，以及分支名的安全校验。
 *
 * 设计说明：这些函数的输入都是 git 的**固定文本格式**，用样例字符串断言比造仓库更快、更精确；
 *   端到端行为由 service.test.ts 的真仓库用例覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  assertSafeRef,
  parseAheadBehind,
  parseBranchDetails,
  parseGitVersion,
  parseMergeTreeConflicts,
  parseNameStatus,
  parseWorktreePorcelain,
} from "./local-git.js";

describe("parseWorktreePorcelain", () => {
  it("解析分支、detached 与 bare 条目", () => {
    const input = [
      "worktree /repo",
      "HEAD 1234567890abcdef1234567890abcdef12345678",
      "branch refs/heads/main",
      "",
      "worktree /repo/.wt/detached",
      "HEAD abcdef1234567890abcdef1234567890abcdef12",
      "detached",
      "",
      "worktree /repo/bare.git",
      "bare",
      "",
    ].join("\n");

    const entries = parseWorktreePorcelain(input);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: "/repo", branch: "main", detached: false });
    expect(entries[1]).toMatchObject({ path: "/repo/.wt/detached", branch: null, detached: true });
    expect(entries[2]?.bare).toBe(true);
  });
});

describe("parseBranchDetails", () => {
  it("按 NUL 分隔解析并按名称排序", () => {
    const details = parseBranchDetails("feature/b\u0000bbb\u00001799999999\nmain\u0000aaa\u00002000000000\n");

    expect(details.map((entry) => entry.name)).toEqual(["feature/b", "main"]);
    expect(details[0]).toMatchObject({ head: "bbb", committedAt: 1799999999 });
  });
});

describe("parseAheadBehind", () => {
  it("左列是 behind、右列是 ahead", () => {
    expect(parseAheadBehind("3\t5\n")).toEqual({ ahead: 5, behind: 3 });
    expect(parseAheadBehind("0\t0")).toEqual({ ahead: 0, behind: 0 });
  });
});

describe("parseNameStatus", () => {
  it("rename 取原路径与新路径，其余只有新路径", () => {
    const changes = parseNameStatus("A\tsrc/new.ts\nM\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/renamed.ts\n");

    expect(changes).toEqual([
      { status: "A", path: "src/new.ts", previousPath: null },
      { status: "M", path: "src/a.ts", previousPath: null },
      { status: "R100", path: "src/renamed.ts", previousPath: "src/old.ts" },
    ]);
  });
});

describe("parseMergeTreeConflicts", () => {
  it("跳过首行树 OID，读到空行为止", () => {
    const output = ["ceaad1a65a0d4304429ffc5d126acde626d0785c", "README.md", "src/b.ts", "", "自动合并 README.md", "冲突（内容）"].join(
      "\n",
    );

    expect(parseMergeTreeConflicts(output)).toEqual(["README.md", "src/b.ts"]);
  });

  it("没有树 OID 时把第一行当文件（老格式）", () => {
    expect(parseMergeTreeConflicts("a.txt\nb.txt\n\n说明")).toEqual(["a.txt", "b.txt"]);
  });

  it("空输出返回空数组（说明不是冲突，而是没预测出来）", () => {
    expect(parseMergeTreeConflicts("")).toEqual([]);
  });
});

describe("parseGitVersion", () => {
  it("从 git version 输出里取主次版本", () => {
    expect(parseGitVersion("git version 2.55.0 (Apple Git-155)\n")).toEqual({ major: 2, minor: 55 });
    expect(parseGitVersion("not a version")).toBeNull();
  });
});

describe("assertSafeRef", () => {
  it("拒绝空值、以 - 开头、含 .. 与空白", () => {
    expect(() => assertSafeRef("", "分支")).toThrow();
    expect(() => assertSafeRef("--help", "分支")).toThrow();
    expect(() => assertSafeRef("a..b", "分支")).toThrow();
    expect(() => assertSafeRef("a b", "分支")).toThrow();
  });

  it("放行正常分支名与提交号", () => {
    expect(assertSafeRef("feature/a-b_c.d", "分支")).toBe("feature/a-b_c.d");
    expect(assertSafeRef("0123456789abcdef", "提交")).toBe("0123456789abcdef");
  });
});
