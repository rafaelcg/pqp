/**
 * Handing the push-to-talk binding back to the desktop shell, and what to do
 * when the shell refuses.
 *
 * The IPC call is the only door to the main process, which holds the native
 * hook, so a refused unbind is retried (with backoff, a bounded number of
 * times) rather than assumed done. A retry only runs while its request is
 * still the latest one sent to the shell: a retry landing after a newer bind
 * (the setting switched back on, the binding changed) would silently undo it.
 * A newer request supersedes the old binding in the shell anyway
 * (`setNativePushToTalkBinding` replaces it wholesale).
 *
 * If every attempt fails, it is reported through `onGiveUp` (an error in the
 * console at the call site) instead of vanishing. The mic still cannot stay
 * open because of it: the main process stops and force-releases the hook the
 * moment the window regains focus, and every release in the renderer is
 * unconditional.
 */

export interface ShellUnbindTracker {
  /** Call before every bind or unbind sent to the shell. */
  nextRequest(): void;
  /** Send an unbind, retrying on rejection while it is still the latest request. */
  unbind(send: () => Promise<unknown>): void;
}

export const UNBIND_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

export function createShellUnbindTracker({
  setTimer = (fn, ms) => {
    setTimeout(fn, ms);
  },
  onGiveUp,
  delaysMs = UNBIND_RETRY_DELAYS_MS,
}: {
  setTimer?: (fn: () => void, ms: number) => void;
  onGiveUp: (err: unknown) => void;
  delaysMs?: readonly number[];
}): ShellUnbindTracker {
  let generation = 0;

  function attempt(
    send: () => Promise<unknown>,
    mine: number,
    tries: number,
  ): void {
    let pending: Promise<unknown>;
    try {
      pending = send();
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.catch((err: unknown) => {
      if (mine !== generation) {
        // Superseded: a newer request owns the shell now.
        return;
      }
      const delay = delaysMs[tries];
      if (delay === undefined) {
        onGiveUp(err);
        return;
      }
      setTimer(() => {
        if (mine === generation) {
          attempt(send, mine, tries + 1);
        }
      }, delay);
    });
  }

  return {
    nextRequest() {
      generation += 1;
    },
    unbind(send) {
      generation += 1;
      attempt(send, generation, 0);
    },
  };
}
