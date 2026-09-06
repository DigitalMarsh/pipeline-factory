import type { Project } from "./types";

export const LAST_PROJECT_STORAGE_KEY = "pipeline-factory:last-project-id";

export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberProjectId(projectId: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Storage can be unavailable in private browsing or restricted embeds.
  }
}

export function selectDefaultProjectId(projects: Pick<Project, "id" | "status">[], rememberedId: string | null): string | null {
  if (rememberedId && projects.some((project) => project.id === rememberedId)) return rememberedId;
  return projects.find((project) => project.status === "ACTIVE")?.id ?? projects[0]?.id ?? null;
}
