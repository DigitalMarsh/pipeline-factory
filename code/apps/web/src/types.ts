export type PlanStatus = "DRAFT" | "READY" | "QUEUED" | "IN_PROGRESS" | "VERIFYING" | "MERGE_READY" | "MERGED" | "BLOCKED";

export type ExplorerThread = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  state: "ACTIVE" | "COMPRESSED" | "ARCHIVED";
  messageCount: number;
  summaryRef: string | null;
  lastActivityAt: string;
};

export type ExplorerTurn = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status?: "COMPLETED" | "FAILED" | "CANCELLED";
  error?: string;
  createdAt: string;
  sequence: number;
};

export type Plan = {
  planId?: string;
  id?: string;
  title: string;
  revision: number;
  status: PlanStatus;
  projectId: string;
  sourceExplorerThreadId: string;
  queuedAt: string | null;
  runId: string | null;
  lastEventAt: string;
  attentionReason: string | null;
  goal?: string;
  acceptanceCriteria?: string[];
  include?: string[];
  exclude?: string[];
  tasks?: Array<{ title: string; status: string; dependencies: string[] }>;
  verificationCommands?: string[];
  toolPolicy?: string;
};

export type Run = {
  id: string;
  projectId: string;
  planId: string;
  planRevision: number;
  status: string;
  branch: string;
  workspacePath: string | null;
  baseCommit: string;
  executionThreadId: string;
  createdAt: string;
  startedAt: string | null;
};

export type VerificationRun = {
  id: string;
  runId: string;
  status: "PASSED" | "FAILED" | "BLOCKED";
  repairAttempts: number;
  commandResults: Array<{ commandId: string; result: { exitCode: number | null; stdout: string; stderr: string } }>;
  completedAt: string;
};

export type MergeRequest = {
  id: string;
  runId: string;
  planId: string;
  sourceCommit: string;
  targetBranch: string;
  status: "OPEN" | "MERGED";
  humanConfirmationRequired: true;
  createdAt: string;
  mergedAt: string | null;
};

export type ExecutionThread = {
  id: string;
  runId: string;
  state: string;
  journal: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};
