type RevisionNumber = { revision: number };

export function resolvePlanVersionHistory(
  candidateVersions: ReadonlyArray<RevisionNumber>,
  confirmedRevisions: ReadonlyArray<RevisionNumber>,
): { revisions: number[]; confirmedRevisions: number[] } {
  const confirmed = [...new Set(confirmedRevisions.map((item) => item.revision))].sort((a, b) => a - b);
  const revisions = [...new Set([...candidateVersions, ...confirmedRevisions].map((item) => item.revision))].sort((a, b) => a - b);
  return { revisions, confirmedRevisions: confirmed };
}

export function isConfirmedPlanRevision(revision: number, confirmedRevisions: ReadonlyArray<number>): boolean {
  return confirmedRevisions.includes(revision);
}
