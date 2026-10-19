import { PqpAppError } from "@pqp/app-sdk";

export type UiState = "connecting" | "online" | "reconnecting" | "ended" | "outside";

/**
 * The one place the screen's state changes once connected. Ending is terminal: a
 * `connection` event that arrives after `ended` (a reconnect that lands late) must
 * never put the buttons back on, so the flag lives here and not in the DOM.
 */
export function createSessionView(apply: (state: UiState) => void) {
  let over = false;
  return {
    connection(status: "online" | "reconnecting"): boolean {
      if (over) return false;
      apply(status);
      return true;
    },
    end() {
      if (over) return;
      over = true;
      apply("ended");
    },
    get ended() {
      return over;
    },
  };
}

/**
 * Runs the initial reads independently, so one that fails does not skip the
 * other, and reports a failure only when it means something: a read refused
 * because the session ended is not a failure, and nothing is reported once the
 * session is over (the ended message owns the screen then).
 */
export async function loadInitial(
  reads: ReadonlyArray<() => Promise<void>>,
  isEnded: () => boolean,
  onFailed: () => void,
): Promise<void> {
  let failed = false;
  await Promise.all(
    reads.map((read) =>
      read().catch((error: unknown) => {
        if (error instanceof PqpAppError && error.code === "ended") return;
        failed = true;
      }),
    ),
  );
  if (failed && !isEnded()) onFailed();
}
