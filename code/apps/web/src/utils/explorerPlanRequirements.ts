/**
 * 模块职责：Web 端 Explorer requirements 的**离线 fallback**。
 *
 * API 正常时，ExplorerView 使用 `/api/v4/explorer-plan-requirements` 的 manifest；API 重启
 * 或旧实例暂时不可用时，页面仍要显示 requirements。这里必须与 domain 的
 * `EXPLORER_PLAN_REQUIREMENTS.areas` 保持一致，domain 是权威，不要在页面里另造字段。
 */
export type ExplorerPlanRequirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] };

export const DEFAULT_EXPLORER_PLAN_REQUIREMENTS: ExplorerPlanRequirement[] = [
  { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal", "objective.audience"], optionalFields: [] },
  { key: "scope", label: "功能范围与排除项", requiredFields: ["objective.outOfScope", "scope.includePaths", "scope.excludePaths"], optionalFields: [] },
  { key: "design", label: "技术方案与关键约束", requiredFields: ["design.technicalConstraints"], optionalFields: [] },
  { key: "safety", label: "数据、安全与异常处理", requiredFields: ["design.dataSecurity", "design.failureHandling"], optionalFields: [] },
  { key: "verification", label: "验收标准与验证命令", requiredFields: ["objective.acceptanceCriteria", "verification.mode"], optionalFields: ["verification.suites"] },
  { key: "delivery", label: "实施任务、依赖与冲突", requiredFields: ["tasks", "dependencies", "conflicts", "execution"], optionalFields: ["execution.maxRepairAttempts"] },
  { key: "merge", label: "合并策略与人工确认", requiredFields: ["merge.strategy", "merge.requireHumanMerge"], optionalFields: [] },
];
