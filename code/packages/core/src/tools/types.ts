/**
 * 模块职责：工具层的公共契约 —— 工具角色与名称、一次工具调用的输入与归一化结果、
 *   以及落库的工具调用事实（PersistedToolCall）与它的持久化状态机。
 *
 * 为什么从 index.ts 抽出来（批 E）：这些类型原先夹在 Merge 类型与 Model 类型之间，
 *   与它们真正的邻居（tools/gateway.ts、tools/tool-runtime.ts、
 *   tools/builtin-tool-executor.ts）隔了上千行。搬进 tools/ 之后，
 *   "工具能做什么、被拒绝时怎么表达、落库长什么样"与执行点并排，读一遍 tool-runtime
 *   就能与这里的字段逐条对上。
 *
 * 维护提示：
 *   1) **ToolName 的末尾有 `| string` 兜底，不是笔误**：内置工具只是字面量那 12 个，
 *      MCP / Plugin / 宿主动态注册的工具名是任意字符串。因此**不要对 ToolName 写穷尽
 *      switch 或期待 `never` 分支** —— 它永远不会被收窄完，漏掉一个工具编译器不会报错。
 *      真正的白名单在 tools/gateway.ts 的 READ_ONLY_TOOLS / EXECUTOR_TOOLS 与
 *      BuiltinToolExecutor 的分派表里。
 *   2) **ToolCallResult 的三种"没成功"必须可区分**：allowed:false（策略拒绝，工具没跑）、
 *      status:"FAILED"（跑了且失败）、status:"NEEDS_RECONCILIATION"（可能已产生副作用、
 *      结果不明）。把最后一种并入 FAILED 会让上层认为"没发生过"，于是允许重放 ——
 *      tool-runtime 正是靠这个区分在恢复时拒绝重放的。
 *   3) **DurableToolCallStatus 的 UNKNOWN 与 NEEDS_RECONCILIATION 来路不同**：
 *      UNKNOWN 是 tools/tool-runtime.ts 在 gateway.call 抛错时写下的
 *      （"副作用状态无从得知"）；NEEDS_RECONCILIATION 是"已确认必须人工核对"。
 *      此刻两者对重放的答案相同（tool-runtime 里两个值一起拒绝），但语义不同，
 *      不要合并成一个。
 *   4) PersistedToolCall.result 直接复用 ToolCallResult 而不是另立投影：读回路径必须保留
 *      allowed / status 的区分度，别在读的时候降级成 boolean。
 *   5) 本文件是**纯类型**，不含任何运行时值：工具层的实现在同目录的 gateway.ts /
 *      tool-runtime.ts / builtin-tool-executor.ts / mcp.ts / plugin.ts / computer-use.ts。
 */

/** 工具调用角色；Explorer 和 Executor 使用不同的允许集合。 */
export type ToolRole = "explorer" | "executor";
/** 内置、MCP、Plugin 和宿主工具的统一名称。 */
export type ToolName =
  | "read_file"
  | "list_files"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "search_text"
  | "write_file"
  | "apply_patch"
  | "run_command"
  | "run_registered_command"
  | "run_verification"
  | "git_commit"
  | string;

/** 一次模型发起的工具调用；callId 用于幂等、审计和恢复。 */
export type ToolCall = {
  callId: string;
  tool: ToolName;
  input: Record<string, unknown>;
};

/** 工具调用的归一化结果；禁止、失败和未知副作用必须可区分。 */
export type ToolCallResult = {
  callId: string;
  allowed: boolean;
  status?: "SUCCEEDED" | "DENIED" | "FAILED" | "NEEDS_RECONCILIATION" | undefined;
  reason: string | null;
  result: unknown | null;
  audited: true;
};

/** 持久化工具调用状态；UNKNOWN 不允许静默重放。 */
export type DurableToolCallStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DENIED" | "UNKNOWN" | "NEEDS_RECONCILIATION";
/** SQLite 中保存的工具调用事实和输入 hash。 */
export type PersistedToolCall = {
  callId: string;
  loopId: string;
  role: ToolRole;
  tool: ToolName;
  status: DurableToolCallStatus;
  inputHash: string;
  result: ToolCallResult | null;
  startedAt: string;
  completedAt: string | null;
};
