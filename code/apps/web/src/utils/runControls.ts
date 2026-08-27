export function canPauseRun(runStatus: string, threadState: string): boolean {
  return runStatus === "IN_PROGRESS" && (threadState === "ACTIVE" || threadState === "PAUSED");
}
