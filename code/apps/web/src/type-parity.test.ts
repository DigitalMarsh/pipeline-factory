/**
 * 测试职责：锁住两条对话线共用的**消息词表**在 Web 侧完整覆盖。
 *
 * 历史：本文件曾经还维护 32 个 DTO 的 `Expect<Equal<DomainX, WebX>>`，因为那些类型在
 * domain 与 web 各手抄了一遍，只能靠编译期断言发现漂移。重构后 Web 从
 * `@pipeline-factory/contracts` 再导出这些类型，而 contracts 直接 `export type … from domain`，
 * 同一份定义只有一处——**parity 由包结构保证，不再需要逐类型断言**（重复定义会因
 * "export 冲突"直接编译失败）。
 *
 * 维护提示：新增跨端类型时放进 `packages/contracts/src/index.ts` 的再导出清单，
 * 不要回到 web 里手抄。这里只保留消息词表那一类**不是 DTO** 的编译期约束。
 */
import { describe, expect, it } from "vitest";
import type { SharedMessageType } from "./utils/conversationTypes";
import type { ExecutionSharedMessageType } from "./utils/executionStream";
import type { ExplorerSharedMessageType } from "./utils/explorerPresentation";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;
type Expect<T extends true> = T;

/**
 * 两条对话线共用的消息词表：`Extract<…, SharedMessageType>` 等于全表，
 * 就说明这一侧把每一项都列出来了（少一项这里就不是 `SharedMessageType` 了）。
 */
type SharedVocabularyParity = [
  Expect<Equal<ExplorerSharedMessageType, SharedMessageType>>,
  Expect<Equal<ExecutionSharedMessageType, SharedMessageType>>,
];

const sharedVocabularyChecks: SharedVocabularyParity | null = null;
void sharedVocabularyChecks;

describe("shared conversation vocabulary", () => {
  it("is checked at compile time; runtime only keeps the file in the test graph", () => {
    expect(true).toBe(true);
  });
});
