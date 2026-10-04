/**
 * 模块职责：**两条对话线共用的消息词表** —— 探索线程与执行线程里"同一件事"必须同一个名字。
 *
 * 为什么单独一个模块：这两条线本质是同一件事（人和模型来回说话、中间夹着工具与判定），
 * 但它们各自演化出了一套类型名——同一个"你发的消息"，探索侧叫 `USER_MESSAGE`、执行侧叫 `guidance`；
 * 同一次工具调用，探索侧按生命周期拆成 `TOOL_STARTED` / `TOOL_COMPLETED` / `TOOL_DENIED`，
 * 执行侧合成一个 `tool`。于是"两边到底一不一致"只能靠人肉对照，改一边漏一边没人拦得住。
 * 共用项集中到这里之后，两张呈现表（`explorerPresentation.EXPLORER_DISPLAY_MODES` 与
 * `executionStream.EXECUTION_DISPLAY_MODES`）都必须为其中每一项给出一行——
 * `conversationTypes.test.ts` 会拦住漏掉的那一项。
 *
 * 维护提示：
 *   1) **新增消息类型时先回答"它是两条线共用的吗"**：共用就加进 `SHARED_MESSAGE_TYPES`，
 *      只在一条线上出现就加进那条线自己的联合类型（见 `explorerPresentation.ts` 与
 *      `executionStream.ts` 的文件注释，那里逐条写了独有项的理由）。
 *   2) 命名一律**大写下划线**，因为它同时是领域枚举（`ExplorerActivityKind`）的取值形态——
 *      两类符号长得一样，读代码时不必再问"这个串是哪一边的"。
 *   3) 这里**只有名字**：呈现方式、文案、状态机都属于各自的线，不往这里放。
 */

/**
 * 两条对话线共用的消息类型。**逐项两边都要有一行呈现方式**。
 *
 * `PROVIDER_MESSAGE` / `SESSION` 在探索侧恒为 `hidden`：那两类是"Provider 把你那句话回显一次"
 * 与"Provider 会话重建"，探索时间线里已经有对应的东西（用户消息本身、回合状态），
 * 但它们的**名字**必须共用——名字留在词表里，两边才不会各起一个。
 */
export const SHARED_MESSAGE_TYPES = [
  /** 你发出的那条消息 */
  "USER_MESSAGE",
  /** 模型正文 */
  "ASSISTANT_MESSAGE",
  /** 模型的推理摘要 */
  "REASONING",
  /** 跑了一条命令 */
  "COMMAND",
  /** 改动了文件 */
  "FILE_CHANGE",
  /** 一次工具调用（开始 / 结束 / 被拒是同一条的生命周期，不是三条消息） */
  "TOOL_CALL",
  /** MCP 服务端的调用 */
  "MCP_CALL",
  /** 终止门禁的判定 */
  "GATE",
  /** 上下文被压缩了一轮 */
  "CONTEXT",
  /** 回合 / 模型轮次的状态占位 */
  "TURN_STATUS",
  /** 认不出来的活动：宁可说"未识别"，也不让它伪装成某个已知类别 */
  "UNCLASSIFIED",
  /** Provider 回显你发的消息（不是模型说的话） */
  "PROVIDER_MESSAGE",
  /** Provider 会话重建 */
  "SESSION",
] as const;

export type SharedMessageType = (typeof SHARED_MESSAGE_TYPES)[number];
