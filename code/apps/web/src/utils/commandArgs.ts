/**
 * 模块职责：命令参数（`argv: string[]`）与"人写的一行文本"之间的**两个方向**的转换。
 *
 * 为什么单独成模块：项目设置里那一栏是**一行文本**，落库的是**数组**。此前只做了一半
 * ——载入时 `join(" ")`、保存时 `split(/\s+/)`——于是**任何带引号的命令存一次就坏一次**：
 * `bash -lc "npm run build"` 会变成 `["bash","-lc","\"npm","run","build\""]`。
 * （实测：给 project4/project3 登记的两条验证命令是绕开界面、用接口写的，就是因为这个。）
 *
 * 两个方向必须成对：`formatCommandArgs` 给需要引号的参数加引号，`parseCommandArgs` 按同一套规则
 * 切回来，且 **`parseCommandArgs(formatCommandArgs(x))` 恒等于 `x`**（单测钉住）。
 */

/** 不加引号就会被切开的参数。空串也算——否则它在往返里会消失。 */
function needsQuotes(argument: string): boolean {
  return argument === "" || /[\s"'\\]/.test(argument);
}

/** `argv` → 一行文本。含空白或引号的参数加双引号，内部的 `\` 与 `"` 转义。 */
export function formatCommandArgs(argv: readonly string[]): string {
  return argv
    .map((argument) => (needsQuotes(argument) ? `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : argument))
    .join(" ");
}

/**
 * 一行文本 → `argv`。支持单引号、双引号与反斜杠转义。
 *
 * 未闭合的引号**不报错**：按"一直到行尾"处理。设置页正在被编辑，任何一个中间状态都不该让
 * 整个对话框失效——用户把引号补上就对了。
 */
export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  /** 区分"一个空参数"（`""`）与"一个参数都还没开始"——只看 `current` 分不出这两者。 */
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index];
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) args.push(current);
  return args;
}
