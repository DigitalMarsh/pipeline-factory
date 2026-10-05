/** API 健康状态的显示语义，供全局顶栏和通知面板复用。 */
export type ApiHealthState = "checking" | "healthy" | "unavailable";

export type ApiHealthVisual = {
  label: string;
  tooltip: string;
  tone: ApiHealthState;
};

const API_HEALTH_VISUALS: Record<ApiHealthState, ApiHealthVisual> = {
  checking: { label: "Checking API…", tooltip: "正在检查 API 可用性。", tone: "checking" },
  healthy: { label: "API Healthy", tooltip: "API 可用，点击刷新。", tone: "healthy" },
  unavailable: { label: "API Unavailable", tooltip: "API 不可用，点击重试。", tone: "unavailable" },
};

export function classifyApiHealth(response: { status?: string } | null): ApiHealthState {
  return response?.status === "ok" ? "healthy" : "unavailable";
}

export function apiHealthVisual(state: ApiHealthState): ApiHealthVisual {
  return API_HEALTH_VISUALS[state];
}
