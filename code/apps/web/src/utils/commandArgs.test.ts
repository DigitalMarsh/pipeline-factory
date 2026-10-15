/**
 * 测试职责：锁住"一行文本 ↔ argv 数组"这两个方向的**往返一致**，以及引号/转义的边界。
 *
 * 设计说明：这是纯函数，不需要挂组件。第一条判据是那个恒等式——它一旦不成立，
 *   设置页"载入 → 保存"就会悄悄改掉用户的命令（此前正是这么坏的）。
 */
import { describe, expect, it } from "vitest";
import { formatCommandArgs, parseCommandArgs } from "./commandArgs";

describe("命令参数的两个方向", () => {
  it("往返一致：parse(format(x)) 恒等于 x", () => {
    const cases: string[][] = [
      ["npm", "run", "build"],
      ["bash", "-lc", "npm --prefix code ci && npm --prefix code run build"],
      ["git", "diff", "--check"],
      ["bash", "-lc", 'for f in code/*.js; do [ -e "$f" ] || continue; node --check "$f" || exit 1; done'],
      ["mvn", "-Dmessage=a b", "-q"],
      [""],
      ["", "second"],
      ["a\\b", 'c"d', "e'f"],
      ["含中文 的参数", "带\t制表符"],
    ];
    for (const argv of cases) {
      expect(parseCommandArgs(formatCommandArgs(argv)), argv.join(" ")).toEqual(argv);
    }
  });

  it("把人写的一行切开：引号里的空白不算分隔符", () => {
    expect(parseCommandArgs('bash -lc "npm run build"')).toEqual(["bash", "-lc", "npm run build"]);
    expect(parseCommandArgs("bash -lc 'npm run build'")).toEqual(["bash", "-lc", "npm run build"]);
    expect(parseCommandArgs("  git   diff   --check  ")).toEqual(["git", "diff", "--check"]);
    expect(parseCommandArgs('sh -c ""')).toEqual(["sh", "-c", ""]);
  });

  it("双引号里的转义还原，单引号里按字面处理", () => {
    expect(parseCommandArgs('bash -lc "echo \\"hi\\""')).toEqual(["bash", "-lc", 'echo "hi"']);
    expect(parseCommandArgs("bash -lc 'echo \"hi\"'")).toEqual(["bash", "-lc", 'echo "hi"']);
    expect(parseCommandArgs("a\\ b")).toEqual(["a b"]);
  });

  it("未闭合的引号按「到行尾」处理，不抛异常（设置页正在被编辑）", () => {
    expect(parseCommandArgs('bash -lc "npm run build')).toEqual(["bash", "-lc", "npm run build"]);
    expect(parseCommandArgs("bash -lc 'unclosed")).toEqual(["bash", "-lc", "unclosed"]);
  });
});
