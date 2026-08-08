import { useEffect, useState } from "react";
import { fetchCommunityConfig } from "@/lib/api";

/**
 * Whether this deployment has the Communities directory.
 *
 * ASKED ONCE PER PAGE LOAD AND CACHED AT MODULE SCOPE. The answer is an
 * operator's environment variable, so it cannot change while the tab is open,
 * and re-asking on every mount would put a request on the critical path of a
 * sidebar that re-renders constantly. `main.tsx` already treats the initial
 * load as a budget.
 *
 * STARTS AT `false`, NOT `null`, and that is the whole safety property: the nav
 * entry and the view are absent until the server has affirmatively said the
 * feature exists. A hook that started "unknown" and rendered optimistically
 * would flash a Communities row on every deployment that does not have one —
 * including production, where the flag is off — and a flash of a public
 * directory is not a cosmetic bug.
 *
 * A FAILED REQUEST IS `false`. Same reason: this is the one config in the app
 * whose "off" answer is the legally conservative one (see the header of
 * `services/communities.ts`), so a network blip must fail towards hiding the
 * surface rather than towards showing it.
 */
let cached: boolean | null = null;
let inflight: Promise<void> | null = null;

/** Test seam: forget the cached answer so a spec can assert both branches. */
export function resetCommunitiesConfigCache(): void {
  cached = null;
  inflight = null;
}

/**
 * @param ready Whether the app has installed its API token provider yet.
 *
 * THE GATE IS NOT OPTIONAL AT THE APP SHELL. `setAuthTokenProvider` runs in an
 * effect, so a fetch fired from a component that mounts in the same pass sends
 * no Authorization header and takes a 401 — which is a console error on every
 * cold boot, and the theme suite asserts there are none. `useFriendsStore` is
 * gated on the identical flag for the identical reason; its comment in App.tsx
 * says so. Defaults to true for callers that can only render long after
 * bootstrap (the server-settings dialog), where threading the flag down would
 * be ceremony.
 */
export function useCommunitiesEnabled(ready = true): boolean {
  const [enabled, setEnabled] = useState(cached ?? false);

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (cached !== null) {
      setEnabled(cached);
      return;
    }
    let active = true;
    inflight ??= fetchCommunityConfig()
      .then((config) => {
        cached = config.enabled;
      })
      .catch(() => {
        // Fail closed, and remember it: a deployment without the feature should
        // not be asked again every time this hook mounts.
        cached = false;
      })
      .finally(() => {
        inflight = null;
      });
    void inflight.then(() => {
      if (active) {
        setEnabled(cached ?? false);
      }
    });
    return () => {
      active = false;
    };
  }, [ready]);

  return enabled;
}
