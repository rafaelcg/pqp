/**
 * One in-flight share start, dropped if the call that asked for it is gone.
 *
 * `requestScreenShare` waits on `ensureOsCanExcludeCallAudio()` before it
 * opens a picker. A second click, or leaving the voice channel, must not
 * start a capture for a room that is no longer current.
 */
export function createShareRequestGuard() {
  let generation = 0;
  let inFlight = false;

  return {
    invalidate(): void {
      generation += 1;
      inFlight = false;
    },
    tryBegin(): number | null {
      if (inFlight) {
        return null;
      }
      inFlight = true;
      return generation;
    },
    isCurrent(token: number): boolean {
      return token === generation;
    },
    end(token: number): void {
      if (token === generation) {
        inFlight = false;
      }
    },
  };
}
