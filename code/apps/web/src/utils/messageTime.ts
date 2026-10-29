/**
 * 模块职责：聊天行里唯一的时间格式——探索与执行两条线共用一套，避免一处 HH:MM、一处 HH:MM:SS。
 *
 * 维护提示：
 * 1. 行内只显示到分钟（`HH:MM`）；完整时间在 `<time>` 的 `datetime`/`title` 上，需要精确到秒时看悬停。
 * 2. 非法时间串原样返回，不抛错、不显示 NaN——历史数据里出现过空串。
 */
export function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** `<time title>`：本地完整日期 + 时间，秒级。 */
export function messageTimeTitle(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}
