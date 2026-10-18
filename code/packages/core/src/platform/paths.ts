/**
 * 模块职责：路径归属判定——"这个路径是否落在那个根目录之内"。
 *
 * 为什么单独成模块：这条判定此前至少有 4 处各写一份（git/worktree-snapshot.ts 的 isInside、
 *   tools/executor-working-directory.ts 的范围推导、plan 的路径安全校验、以及各处内联的
 *   `startsWith(root + sep)`）。各写一份的代价不在长度，而在**边界结论会不一致**：
 *   根目录自身算不算"之内"、前缀相似的兄弟目录（`/a/bc` vs `/a/b`）算不算，写法稍有差别结论就反了。
 *   这里只回答一个问题，需要它的人都用同一份答案。
 *
 * 维护提示：**先 resolve 再比较**，不要用字符串前缀直接比——`/a/b/../c` 与 `/a/c` 是同一个位置，
 *   而 `startsWith` 会给出相反结论。
 */
import { resolve, sep } from "node:path";

/** target 是否等于 root 或落在 root 之内。两侧都按绝对路径归一后再比较。 */
export function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep);
}
