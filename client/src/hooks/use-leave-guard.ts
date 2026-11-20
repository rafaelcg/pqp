import { useEffect } from "react";

/** The studio's phases in which leaving the page loses something the person made. */
export type LeaveGuardPhase = "boot" | "unsupported" | "setup" | "countdown" | "recording" | "review" | "posting" | "done";

/**
 * Does leaving the page now lose work? A take being recorded (the count-in
 * included: the red button was pressed), one recorded and not sent, and one on its
 * way up all live only in this page. Setup and boot hold nothing, and "done" has
 * already sent it.
 *
 * Recording was missing from this list: the guard was armed only once the take
 * stopped, so a reload or a closed tab during ten minutes of playing lost it with
 * no question (jam persona QA, 2026-11-19).
 */
export function phaseHoldsUnsentWork(phase: LeaveGuardPhase): boolean {
  return phase === "countdown" || phase === "recording" || phase === "review" || phase === "posting";
}

/**
 * While `active`, a reload or a closed tab makes the browser ask first (its own
 * words, never ours: a page cannot set them). Leaving through the app has its own
 * question, which the studio asks itself.
 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [active]);
}
