export type SseReplayGate = {
  ready: boolean;
  accept(eventName: string): boolean;
  markReady(): void;
};

export function createSseReplayGate(): SseReplayGate {
  let ready = false;
  return {
    get ready() { return ready; },
    accept(eventName: string): boolean {
      if (eventName === "stream.ready") {
        ready = true;
        return false;
      }
      return ready;
    },
    markReady() { ready = true; },
  };
}
