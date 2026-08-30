export function canPauseRun(runStatus: string, threadState: string): boolean {
  return runStatus === "IN_PROGRESS" && (threadState === "ACTIVE" || threadState === "PAUSED");
}

export function canTerminateRun(runStatus: string): boolean {
  return ["STARTING", "IN_PROGRESS", "READY_FOR_VERIFY", "VERIFYING", "RECOVERING"].includes(runStatus);
}
