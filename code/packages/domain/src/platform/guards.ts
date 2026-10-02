/**
 * 模块职责：反序列化外部输入（Provider 返回值、Plan 协议块、SQLite 行、HTTP body）时的最小类型守卫。
 *
 * 为什么从 index.ts 抽出来：plan/completion.ts 需要 isRecord / isStringArray / isNonEmptyStringArray，
 *   而它们原先只存在于 index.ts。若让 completion.ts 反过来从 index.ts 取值导入，"index → completion"
 *   与"completion → index"会立刻构成一条新的双模块值级环，S4 想切断的回流边只是换了个名字。
 *   这三个守卫只吃 unknown、**零 import**，搬到这里后 completion.ts 对 index.ts 就不再有任何值依赖。
 *
 * 维护提示：
 *   1) 本文件**只放守卫，不放业务校验**。像 validateGeneratedPlanSpec
 *      这类会抛错、带业务规则的校验器归各域自己的模块（plan/contract.ts、plan-spec.ts），
 *      放进来会把"零依赖叶子"这个性质破坏掉，解环就白做了。
 *   2) 仓库里另外还有 4 份同义的 isRecord（project.ts、plan-spec.ts、explorer-activity.ts、redaction.ts
 *      各一份，web 侧另有一份）。本轮**不动它们**——收敛它们会同时改动 4 个模块的 diff，
 *      与解环这一步的可归因性冲突；P8.3 统一处理。
 */
/** 非 null 且非数组的对象。数组要单独判，因为 typeof [] === "object"。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 元素全为 string 的数组（空数组合法）。 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 元素全为非空（trim 后长度 > 0）string 的非空数组。 */
export function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((item) => item.trim().length > 0);
}
