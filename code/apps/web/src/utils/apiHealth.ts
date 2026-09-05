/** API 健康状态的显示语义，供全局顶栏和通知面板复用。 */
export type ApiHealthState = "checking" | "healthy" | "unavailable";

export type ApiHealthVisual = {
  label: string;
  tooltip: string;
  tone: ApiHealthState;
};

const API_HEALTH_VISUALS: Record<ApiHealthState, ApiHealthVisual> = {
  checking: { label: "Checking API…", tooltip: "Checking API service availability.", tone: "checking" },
  healthy: { label: "API Healthy", tooltip: "API service is reachable. Click to refresh.", tone: "healthy" },
  unavailable: { label: "API Unavailable", tooltip: "API service is unavailable. Click to retry.", tone: "unavailable" },
};

export function classifyApiHealth(response: { status?: string } | null): ApiHealthState {
  return response?.status === "ok" ? "healthy" : "unavailable";
}

export function apiHealthVisual(state: ApiHealthState): ApiHealthVisual {
  return API_HEALTH_VISUALS[state];
}
