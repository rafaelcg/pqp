import { useEffect, useState } from "react";
import { cachedAppsLanding, probeAppsLandingDetailed } from "@/lib/apps-landing";

/**
 * Whether the pqp Apps pages exist, as the server says it (`apps_landing`).
 * `checking` is only ever the first load or the first after the answer went
 * stale: a fresh cached answer is returned in the first render, so moving
 * between the two pages never flashes.
 */
export type AppsLandingState = "checking" | "on" | "off";

/** One more try for a visitor whose first question failed (API blip), then off. */
export const FAILURE_RETRY_MS = 1_500;

export function useAppsLanding(): AppsLandingState {
  const known = cachedAppsLanding();
  const [state, setState] = useState<AppsLandingState>(
    known === null ? "checking" : known ? "on" : "off",
  );
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (enabled: boolean) => {
      if (live) setState(enabled ? "on" : "off");
    };
    void probeAppsLandingDetailed().then((first) => {
      if (first !== null) {
        settle(first);
        return;
      }
      // A failure is not a "no": a real page should not bounce a visitor over
      // one blip. Ask once more, forcing past the failure window, then give up.
      timer = setTimeout(() => {
        void probeAppsLandingDetailed(true).then((second) => settle(second === true));
      }, FAILURE_RETRY_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return state;
}
