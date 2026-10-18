/**
 * 模块职责：当前存储结构版本的**唯一定义**。SQLite 把它写进 `PRAGMA user_version`，
 *   内存实现（测试/临时实例）返回同一个值，`/health` 对外展示。
 *
 * 维护提示：新增不兼容的结构变更时 +1，并在 `sqlite-store.ts` 的迁移区补一条
 *   `if (from < N)` 的步骤；只改数字不写迁移会让旧库"声称是新版却没有新列"。
 */
export const CURRENT_SCHEMA_VERSION = 1;
