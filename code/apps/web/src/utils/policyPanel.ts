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

export function openPolicyPanel(isOpen: boolean): boolean {
  return isOpen ? isOpen : true;
}

export function closePolicyPanel(isOpen: boolean): boolean {
  return isOpen ? false : isOpen;
}
