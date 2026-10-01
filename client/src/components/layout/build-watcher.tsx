import { useEffect, useState } from "react";
import { applyUpdate } from "@/lib/apply-update";
import { fetchClientUpdateConfig } from "@/lib/api";
import { RUNNING_BUILD } from "@/lib/build-info";
import { NO_FORCE, parseForceConfig, type ForceConfig } from "@/lib/client-version";
import { useInCall, useWatchingParty } from "@/lib/in-call-state";
import {
  autoReloadAllowed,
  decideUpdateAction,
  maxStaleMsFromEnv,
  recordAutoReload,
} from "@/lib/update-policy";
import { setBuildStaleness, useBuildStaleness } from "@/lib/update-prompt-state";
import {
  idleForMs,
  isTypingNow,
  startActivityTracking,
} from "@/lib/user-activity";
import { startVersionWatch } from "@/lib/version-watch";

/** How often an out-of-date page re-reads "is anyone there", once it knows. */
const RECHECK_MS = 15_000;

async function askServerForForce(): Promise<ForceConfig> {
  try {
    return parseForceConfig(await fetchClientUpdateConfig());
  } catch {
    // Signed out, an older API, offline: the ordinary path, not a failure.
    return NO_FORCE;
  }
}

/**
 * The headless half of "nobody stays on an old bundle". Renders nothing.
 *
 * It does two jobs and keeps them together because each is useless alone:
 *
 *  1. FINDS OUT. `startVersionWatch` compares this bundle to `/version.json` on
 *     start, on focus and every twelve minutes or so, and publishes the answer
 *     to `update-prompt-state`, which is what the card and the forced screen
 *     read. See `lib/version-watch.ts` for why the service worker cannot do it.
 *
 *  2. ACTS, when it is safe and nobody has to be asked. Once the page knows it
 *     is behind, `decideUpdateAction` says whether this is a moment to reload
 *     (nobody has touched the page for three minutes; or it has been out of date
 *     past twelve hours) or only a moment for the card. A reload is never
 *     taken in a call, while somebody is typing, or while they watch a live
 *     party, and never twice in a row for the same build.
 *
 * Mounted in `main.tsx` beside `UpdatePrompt`, outside `App`, because a stale
 * bundle matters on every route and a signed-out landing page is one too.
 */
export function BuildWatcher({
  apply = applyUpdate,
}: {
  /** Test seam: a real apply reloads the page. */
  apply?: (target?: string | null) => Promise<unknown>;
} = {}) {
  const build = useBuildStaleness();
  const inCall = useInCall();
  const watching = useWatchingParty();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // For support and for tests: which build is this tab, read off the page.
    document.documentElement.dataset.pqpBuild = RUNNING_BUILD.build;
    const stopActivity = startActivityTracking();
    const stopWatch = startVersionWatch({
      running: RUNNING_BUILD,
      fetchForceConfig: askServerForForce,
      publish: setBuildStaleness,
    });
    return () => {
      stopWatch();
      stopActivity();
    };
  }, []);

  // Idle time passes without any state changing, so an out-of-date page has to
  // look again on a clock. Not while up to date: nothing to decide.
  useEffect(() => {
    if (!build.stale) {
      return;
    }
    const timer = window.setInterval(() => setTick((n) => n + 1), RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [build.stale]);

  useEffect(() => {
    if (!build.stale) {
      return;
    }
    const now = Date.now();
    const target = build.latestBuild ?? "unknown";
    const action = decideUpdateAction({
      stale: true,
      forced: build.forced,
      staleForMs: build.since === null ? 0 : now - build.since,
      idleMs: idleForMs(now),
      inCall,
      watching,
      typing: isTypingNow(now),
      autoReloadAllowed: autoReloadAllowed(target, now),
      maxStaleMs: maxStaleMsFromEnv(import.meta.env.VITE_UPDATE_MAX_STALE_HOURS),
    });
    if (action !== "auto-reload") {
      return;
    }
    // The guard is written BEFORE the reload: it has to outlive this page.
    if (!recordAutoReload(target, now)) {
      return;
    }
    // A rejection here is not the person's problem: the card is still up, and
    // the loop guard above means this will not be tried again for a while.
    void Promise.resolve(apply(build.latestBuild)).catch(() => {});
  }, [build, inCall, watching, tick, apply]);

  return null;
}
