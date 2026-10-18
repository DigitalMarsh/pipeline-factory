/**
 * 模块职责：HTTP 输入 schema 的汇总出口。
 *
 * 为什么集中 re-export：路由文件只该关心"这个端点读什么字段"，不关心 schema 被拆在哪个文件。
 *   各 schema 文件之间没有依赖（除 execution-threads / runs / explorers 复用 attachments 的
 *   `attachmentIds`），导出名也已确认不冲突；将来出现重名时再改成子路径导入。
 */
export * from "./agent-loops.js";
export * from "./attachments.js";
export * from "./common.js";
export * from "./execution-threads.js";
export * from "./explorers.js";
export * from "./merge-requests.js";
export * from "./plans.js";
export * from "./projects.js";
export * from "./runs.js";
export * from "./worktrees.js";
