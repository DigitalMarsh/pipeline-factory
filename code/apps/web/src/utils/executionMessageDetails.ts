/**
 * 模块职责：执行消息的**诊断细节**怎么摆 —— 哪些字段默认不露面、hover 时给什么。
 *
 * 为什么单独一个纯函数模块：执行对话里每条消息原本把 `Turn #1`、`Call xxx`、`Provider item msg_xxx`、
 *   `Provider session linked` 全摊在标题行上，几屏下来像日志而不是对话——这是"内容结构混乱"的
 *   主要来源。收进"详情"之后，**哪些字段值得收、hover 里写什么**就成了会被反复调整的展示规则，
 *   值得有单测钉住，而不是散在模板里。
 *
 * 维护提示：这里只做**已有字段的排版**，不新增暴露面。`utils/executionStream.ts` 的项目定下过
 *   边界：不得输出工具参数、成功结果或模型私有思维链——真要看那些，改的是投影与它的评审结论，
 *   不是这里的字符串拼接。
 */
export type ExecutionMessageDetailSource = {
  modelStep?: number | undefined;
  callId?: string | undefined;
  providerItemId?: string | undefined;
  providerThreadId?: string | undefined;
  providerTurnId?: string | undefined;
};

/** 默认收进"详情"的诊断字段，按关心程度排序（谁在执行 → 哪一次调用 → 哪个 provider 会话）。 */
export function executionMessageDetails(item: ExecutionMessageDetailSource): string[] {
  return [
    item.modelStep === undefined ? null : `Turn #${item.modelStep}`,
    item.callId ? `Call ${item.callId}` : item.providerItemId ? `Provider item ${item.providerItemId}` : null,
    item.providerThreadId || item.providerTurnId ? "Provider session linked" : null,
  ].filter((detail): detail is string => detail !== null);
}

/** hover 提示：把诊断字段合成一行，鼠标停在这条消息上就能看到，不用先展开。 */
export function executionMessageDiagnosticsTitle(item: ExecutionMessageDetailSource): string | undefined {
  const details = executionMessageDetails(item);
  return details.length ? details.join(" · ") : undefined;
}
