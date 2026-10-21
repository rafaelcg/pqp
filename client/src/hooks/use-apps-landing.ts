import { useEffect, useState } from "react";
import type { PublicAppsConfig } from "@pqp/shared";
import { cachedPublicAppsConfig, probePublicAppsConfig } from "@/lib/apps-landing";

/**
 * Whether the pqp Apps pages exist, as the server says it (`apps_landing`).
 * `checking` is only ever the first load or the first after the answer went
 * stale: a fresh cached answer is returned in the first render, so moving
 * between the two pages never flashes.
 */
export type AppsLandingState = "checking" | "on" | "off";

/** One more try for a visitor whose first question failed (API blip), then off. */
export const FAILURE_RETRY_MS = 1_500;

/**
 * The public apps config, or null while it is being asked (and after both
 * tries failed, with `failed` true). The same probe as `useAppsLanding`, so
 * the pages share one request.
 */
export function usePublicAppsConfig(): { config: PublicAppsConfig | null; failed: boolean } {
  const [config, setConfig] = useState<PublicAppsConfig | null>(() => cachedPublicAppsConfig());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void probePublicAppsConfig().then((first) => {
      if (!live) return;
      if (first !== null) {
        setConfig(first);
        return;
      }
      // A failure is not a "no": a real page should not bounce a visitor over
      // one blip. Ask once more, forcing past the failure window, then give up.
      timer = setTimeout(() => {
        void probePublicAppsConfig(true).then((second) => {
          if (!live) return;
          if (second) setConfig(second);
          else setFailed(true);
        });
      }, FAILURE_RETRY_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { config, failed };
}

export function useAppsLanding(): AppsLandingState {
  const { config, failed } = usePublicAppsConfig();
  if (config) return config.enabled ? "on" : "off";
  return failed ? "off" : "checking";
}
