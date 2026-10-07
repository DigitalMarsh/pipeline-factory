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
 * 顺序按**五类**排（见 `docs/Provider消息格式与消息大类调研.md`）：① 你说的 → ② 模型说的 →
 * ③ 模型做的 → ④ Provider 说的 → ⑤ Factory 说的。四 那一组两边都不进会话正文——
 * 它是"机器在说话"，归宿是各自头部状态卡的一节。
 *
 * `PROVIDER_MESSAGE` / `SESSION` 在探索侧恒为 `hidden`：那两类是"Provider 把你那句话回显一次"
 * 与"Provider 会话重建"，探索时间线里已经有对应的东西（用户消息本身、回合状态），
 * 但它们的**名字**必须共用——名字留在词表里，两边才不会各起一个。
 */
export const SHARED_MESSAGE_TYPES = [
  // ① 你说的
  /** 你发出的那条消息 */
  "USER_MESSAGE",
  // ② 模型说的：正文与推理。**进正文**，但推理是更淡的一档（不是对你说的话）。
  /** 模型正文 */
  "ASSISTANT_MESSAGE",
  /** 模型的推理摘要 */
  "REASONING",
  // ③ 模型做的：对外有副作用的动作。摘要进正文，详情折叠。
  /** 跑了一条命令 */
  "COMMAND",
  /** 改动了文件 */
  "FILE_CHANGE",
  /** 一次工具调用（开始 / 结束 / 被拒是同一条的生命周期，不是三条消息） */
  "TOOL_CALL",
  /** MCP 服务端的调用 */
  "MCP_CALL",
  /** 派生子代理（Codex 的 collabAgentToolCall / subAgentActivity，Claude 的 Task 工具） */
  "SUBAGENT",
  /** 联网搜索（Codex 的 webSearch，Claude 的 WebSearch 工具） */
  "WEB_SEARCH",
  /** 生成图片 */
  "IMAGE_GENERATION",
  // ④ Provider 说的：会话设施在报告自己的状态。**不进会话正文**。
  /**
   * Provider 侧的上下文压缩边界。**这才是真的压缩了上下文**——与 ⑤ 的 `CONTEXT` 是两件事：
   * 那个只是 Factory 打的续跑检查点（`LOOP_CHECKPOINTED`），一个字节都没压。
   */
  "PROVIDER_COMPACTION",
  /** 权限被拒：Codex 的 `declined` 命令，Claude 的 `permission_denied` */
  "PERMISSION_DENIED",
  /** 账号配额告警 */
  "RATE_LIMIT",
  /** Provider 正在自动重试 */
  "PROVIDER_RETRY",
  /** 后台子任务：还有东西在跑 */
  "BACKGROUND_TASK",
  /** 钩子执行 */
  "HOOK",
  /** 命令级告警（配置写错、弃用提示） */
  "PROVIDER_WARNING",
  /** 认不出来的活动：宁可说"未识别"，也不让它伪装成某个已知类别 */
  "UNCLASSIFIED",
  /** Provider 回显你发的消息（不是模型说的话） */
  "PROVIDER_MESSAGE",
  /** Provider 会话重建 */
  "SESSION",
  // ⑤ Factory 说的：工厂自己的判定与生命周期。只有"需要你决策"的进正文。
  /** 终止门禁的判定 */
  "GATE",
  /** 上下文被 Factory 压缩了一轮 */
  "CONTEXT",
  /** 回合 / 模型轮次的状态占位 */
  "TURN_STATUS",
] as const;

export type SharedMessageType = (typeof SHARED_MESSAGE_TYPES)[number];

/**
 * **消息大类**——比"用户 / 模型 / 运行时"三分法更管用的那一层。
 *
 * 三分法有两处会咬到：它把"模型说的"与"模型做的"合成一类（而这两类必须是**两种排版**：
 * 正文铺开读、动作折成一行），也把"Provider 的运行事实"与"Factory 自己的生命周期"合成一类
 * （而它们的**归属层不同**：前者只有适配器能翻译，丢了永久丢；后者与后端无关）。
 *
 * 判据一句话：**`user` 是"我说的"，`model` 是"模型对我说的"，`action` 是"模型对世界做的"，
 * `provider` 是"机器在说话"，`factory` 是"工厂在记账"。**
 *
 * 它有两个直接用途，都不是装饰：
 *   1) `provider` 这一类**不进会话正文**——归宿是头部状态卡的「Provider 运行事实」一节。
 *   2) 上面那句"两种排版"就是 `model` 与 `action` 的分界，呈现表据此给不同的档位。
 */
export type MessageClass = "user" | "model" | "action" | "provider" | "factory";

/** 大类的展示名。文档里清单表的「分类」列用的就是这几个词。 */
export const MESSAGE_CLASS_LABELS: Record<MessageClass, string> = {
  user: "① 你说的",
  model: "② 模型说的",
  action: "③ 模型做的",
  provider: "④ Provider 说的",
  factory: "⑤ Factory 说的",
};

/**
 * 共用词表里每一项属于哪一类。**这是分类的唯一定义处**：两张呈现表都不再各自记一遍，
 * 文档的「分类」列也照它写。
 */
export const SHARED_MESSAGE_CLASSES: Record<SharedMessageType, MessageClass> = {
  USER_MESSAGE: "user",
  ASSISTANT_MESSAGE: "model",
  REASONING: "model",
  COMMAND: "action",
  FILE_CHANGE: "action",
  TOOL_CALL: "action",
  MCP_CALL: "action",
  SUBAGENT: "action",
  WEB_SEARCH: "action",
  IMAGE_GENERATION: "action",
  PROVIDER_COMPACTION: "provider",
  PERMISSION_DENIED: "provider",
  RATE_LIMIT: "provider",
  PROVIDER_RETRY: "provider",
  BACKGROUND_TASK: "provider",
  HOOK: "provider",
  PROVIDER_WARNING: "provider",
  UNCLASSIFIED: "provider",
  PROVIDER_MESSAGE: "provider",
  SESSION: "provider",
  GATE: "factory",
  CONTEXT: "factory",
  TURN_STATUS: "factory",
};
