import { useEffect, useState } from "react";
import { cachedAppsLanding, probeAppsLanding } from "@/lib/apps-landing";

/**
 * Whether the pqp Apps pages exist, as the server says it (`apps_landing`).
 * `checking` is only ever the first load: a cached answer is returned in the
 * first render, so moving between the two pages never flashes.
 */
export type AppsLandingState = "checking" | "on" | "off";

export function useAppsLanding(): AppsLandingState {
  const known = cachedAppsLanding();
  const [state, setState] = useState<AppsLandingState>(
    known === null ? "checking" : known ? "on" : "off",
  );
  useEffect(() => {
    let live = true;
    void probeAppsLanding().then((enabled) => {
      if (live) setState(enabled ? "on" : "off");
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
