/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
export type PolicySection = {
  title: string;
  items: string[];
};

export const explorerPolicySections: PolicySection[] = [
  {
    title: "Explorer access",
    items: ["Read repository files", "Inspect Git history", "Review project structure"],
  },
  {
    title: "Disabled tools",
    items: ["Write files", "Run shell commands", "Run tests", "Create commits"],
  },
  {
    title: "Execution boundary",
    items: ["Plan Mode remains read only", "Confirm plan freezes the contract", "Enqueue plan starts the execution pipeline"],
  },
];

/** 以纯函数表达 Policy drawer 的打开动作，便于组件和测试复用。 */
export function openPolicyPanel(isOpen: boolean): boolean {
  return isOpen ? isOpen : true;
}

/** 以纯函数表达 Policy drawer 的关闭动作。 */
export function closePolicyPanel(isOpen: boolean): boolean {
  return isOpen ? false : isOpen;
}
