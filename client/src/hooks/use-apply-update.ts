import { useCallback, useEffect, useRef, useState } from "react";
import { runUpdateLadder } from "@/lib/update-ladder";

export type ApplyState =
  | { status: "idle" }
  | { status: "updating" }
  | { status: "error"; reason: "offline" | "failed" };

/**
 * Nothing the ladder does may keep a button disabled for longer than this. The
 * ladder bounds itself (a few rungs, each with a budget), so this is the belt
 * for the day that stops being true: the person is given the button back.
 */
export const UPDATING_HARD_CAP_MS = 120_000;

function failureOf(result: unknown): "offline" | "failed" | null {
  if (
    result &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === false
  ) {
    return (result as { reason?: unknown }).reason === "offline"
      ? "offline"
      : "failed";
  }
  return null;
}

/**
 * Taking an update from a button, with the failure handled. A promise that
 * rejects, throws, answers "failed" or "offline", or never settles all end the
 * same way: `error`, and the button is the person's again. A result that is not
 * a failure (the page is already leaving) keeps `updating`.
 *
 * `run` is injectable: the default is the real ladder, which navigates away.
 */
export function useApplyUpdate(
  run: (target: string | null) => Promise<unknown> = runUpdateLadder,
): { state: ApplyState; start: (target: string | null) => void } {
  const [state, setState] = useState<ApplyState>({ status: "idle" });
  const mounted = useRef(true);
  const cap = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (cap.current) {
        clearTimeout(cap.current);
      }
    };
  }, []);

  const start = useCallback(
    (target: string | null) => {
      const fail = (reason: "offline" | "failed") => {
        if (cap.current) {
          clearTimeout(cap.current);
        }
        if (mounted.current) {
          setState({ status: "error", reason });
        }
      };
      setState({ status: "updating" });
      if (cap.current) {
        clearTimeout(cap.current);
      }
      cap.current = setTimeout(() => fail("failed"), UPDATING_HARD_CAP_MS);
      // Called synchronously, so a click starts the work in the same tick; a
      // throw is turned into a rejection like any other failure.
      let work: Promise<unknown>;
      try {
        work = Promise.resolve(run(target));
      } catch (error) {
        work = Promise.reject(error);
      }
      work.then(
          (result) => {
            const reason = failureOf(result);
            if (reason) {
              fail(reason);
            }
          },
          () => fail("failed"),
        );
    },
    [run],
  );

  return { state, start };
}
