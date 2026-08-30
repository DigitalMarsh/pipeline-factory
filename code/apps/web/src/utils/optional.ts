/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
/** 对非关键的辅助请求做安全降级；主业务请求不应使用此函数吞掉错误。 */
export async function optional<T>(loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch {
    return null;
  }
}
