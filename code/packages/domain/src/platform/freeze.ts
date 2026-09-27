/**
 * 模块职责：领域记录的深度冻结。PlanRevisionV2 等记录一旦进入 Store 就不再允许原地修改，
 *   冻结把"不可变"从类型上的 Readonly<> 变成运行时保证。
 *
 * 为什么从 index.ts 抽出来：freezeRevision 被 SqlitePipelineStore 的行映射与 index.ts 里的
 *   PlanService / ChangeProposalService 同时使用。若让 store 反向从 index.js 导入，就会形成
 *   新的值级回流边；放到零依赖的叶子模块后两侧都能引用，边被消掉。
 *   这也是计划 P8.3 里"freezeDeep ×2（index.ts 与 project.ts 逐字符相同）"的收敛目标位置——
 *   本轮只搬 index.ts 这一份，project.ts 那份留给 P8.3，避免同时改动两个模块的 diff。
 *
 * 维护提示：
 *   1) 冻结是**浅递归**：会遍历所有可达对象，但对已冻结的对象直接跳过（Object.isFrozen 短路），
 *      所以对同一个记录重复调用是幂等的，不会因为环状引用而无限递归。
 *   2) 泛型签名 `freezeDeep<T>(value: T): T` 保留原类型，不要改成 unknown——调用方依赖返回值
 *      仍是 PlanRevisionV2 才能直接赋给被 Readonly<> 约束的字段。
 */
import type { PlanRevisionV2 } from "../index.js";

/** 递归冻结对象图；已是冻结对象的子树直接跳过（因此幂等，且天然免疫环状引用）。 */
export function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

/** 冻结一个 PlanRevisionV2；Revision 一旦落库就不再允许修改。 */
export function freezeRevision(revision: PlanRevisionV2): PlanRevisionV2 {
  return freezeDeep(revision);
}
