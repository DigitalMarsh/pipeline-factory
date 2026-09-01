/**
 * Returns a usable Project identifier for project-scoped routes.
 * During the first render the Project is not loaded yet; returning null keeps
 * RouterLink from creating an invalid `/projects//...` destination.
 */
export function normalizeProjectId(projectId: string | null | undefined): string | null {
  const normalized = projectId?.trim();
  return normalized || null;
}
