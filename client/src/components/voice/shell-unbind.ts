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
  /**
   * Try again an unbind that ran out of retries, if it is still the latest
   * request. The hook calls this when the window regains focus.
   */
  retryStuck(): void;
  /** Whether an unbind ran out of retries and nothing has superseded it. */
  readonly stuck: boolean;
}

export const UNBIND_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

export function createShellUnbindTracker({
  setTimer = (fn, ms) => {
    setTimeout(fn, ms);
  },
  onGiveUp,
  onRecovered,
  delaysMs = UNBIND_RETRY_DELAYS_MS,
}: {
  setTimer?: (fn: () => void, ms: number) => void;
  /** Every attempt failed: surface it. */
  onGiveUp: (err: unknown) => void;
  /** A stuck unbind went through, or a newer request replaced it. */
  onRecovered?: () => void;
  delaysMs?: readonly number[];
}): ShellUnbindTracker {
  let generation = 0;
  let stuckSend: (() => Promise<unknown>) | null = null;

  function clearStuck(): void {
    if (stuckSend) {
      stuckSend = null;
      onRecovered?.();
    }
  }

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
    pending.then(
      () => {
        if (mine === generation) {
          clearStuck();
        }
      },
      (err: unknown) => {
        if (mine !== generation) {
          // Superseded: a newer request owns the shell now.
          return;
        }
        const delay = delaysMs[tries];
        if (delay === undefined) {
          const first = stuckSend === null;
          stuckSend = send;
          if (first) {
            onGiveUp(err);
          }
          return;
        }
        setTimer(() => {
          if (mine === generation) {
            attempt(send, mine, tries + 1);
          }
        }, delay);
      },
    );
  }

  return {
    nextRequest() {
      generation += 1;
      // A newer request replaces the binding in the shell wholesale.
      clearStuck();
    },
    unbind(send) {
      generation += 1;
      clearStuck();
      attempt(send, generation, 0);
    },
    retryStuck() {
      if (stuckSend) {
        attempt(stuckSend, generation, 0);
      }
    },
    get stuck() {
      return stuckSend !== null;
    },
  };
}

/**
 * The one tracker for this window (one shell, one push-to-talk binding), plus
 * a tiny store so the settings dialog can say so when the desktop app would
 * not let go of the background key. `use-push-to-talk.ts` sends through it;
 * `settings-modal.tsx` reads `usePttReleaseStuck`.
 */
const stuckListeners = new Set<() => void>();
function notifyStuck(): void {
  for (const listener of stuckListeners) {
    listener();
  }
}

export const pttShellUnbind = createShellUnbindTracker({
  onGiveUp: (err) => {
    console.error(
      "[pqp] push-to-talk: the desktop app would not release the background key",
      err,
    );
    notifyStuck();
  },
  onRecovered: notifyStuck,
});

export function subscribePttReleaseStuck(listener: () => void): () => void {
  stuckListeners.add(listener);
  return () => {
    stuckListeners.delete(listener);
  };
}

export function getPttReleaseStuck(): boolean {
  return pttShellUnbind.stuck;
}
