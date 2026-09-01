import { ApiRequestError } from "../api";

export type RunLoadStage = "run" | "agent-loop";

export function describeRunLoadError(error: unknown, stage: RunLoadStage): string {
  if (stage === "run" && error instanceof ApiRequestError && error.status === 404) return "Run 不存在，请从 Runs 列表重新打开";
  if (isApiUnavailableError(error)) return "API 未连接，请启动 API 服务后重试";
  if (stage === "agent-loop") return "Run 已加载，但 Agent Loop 详情暂时不可用";
  return error instanceof Error && error.message ? `加载 Run 失败：${error.message}` : "加载 Run 失败，请稍后重试";
}

function isApiUnavailableError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch|network|connect|econnrefused/i.test(error.message));
}
