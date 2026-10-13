import { useEffect, useRef, useState } from "react";
import { applyUpdate } from "@/lib/apply-update";
import { fetchClientUpdateConfig } from "@/lib/api";
import { RUNNING_BUILD } from "@/lib/build-info";
import {
  isAnnounced,
  parseForceConfig,
  type ForceConfig,
} from "@/lib/client-version";
import { isBusyNow, useInCall, useWatchingParty } from "@/lib/in-call-state";
import {
  autoReloadAllowed,
  decideUpdateAction,
  forgetAutoReload,
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

async function askServerForForce(): Promise<ForceConfig | null> {
  try {
    return parseForceConfig(await fetchClientUpdateConfig());
  } catch {
    // Signed out, an older API, offline, a timeout: no answer. The watch keeps
    // whatever it already knew about this build (`lib/version-watch.ts`).
    return null;
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
 *     (the tab is hidden; a call just ended; nobody has touched the page for
 *     three minutes; or it has been out of date past twelve hours) or only a
 *     moment for the card. A reload is never taken in a call (unless the
 *     operator made the update critical), while somebody is typing, or while
 *     they watch a live party, and never twice in a row for the same build.
 *
 * Mounted in `main.tsx` beside `UpdatePrompt`, outside `App`, because a stale
 * bundle matters on every route and a signed-out landing page is one too.
 */
export function BuildWatcher({
  apply = (target, mayReload) => applyUpdate(target, undefined, mayReload),
}: {
  /**
   * Test seam: a real apply reloads the page. `mayReload` is the last-moment
   * check an automatic reload carries (`applyUpdate`); a result of `"aborted"`
   * means it said no.
   */
  apply?: (
    target: string | null,
    mayReload: () => boolean,
  ) => Promise<unknown>;
} = {}) {
  const build = useBuildStaleness();
  const inCall = useInCall();
  const watching = useWatchingParty();
  const [tick, setTick] = useState(0);
  // When this page's last call ended: the in-call banner promises the reload
  // for right after the hangup, and this is how the policy keeps the promise.
  const callEndedAt = useRef<number | null>(null);
  const wasInCall = useRef(inCall);
  if (wasInCall.current !== inCall) {
    if (wasInCall.current && !inCall) {
      callEndedAt.current = Date.now();
    }
    wasInCall.current = inCall;
  }

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
    // A tab going hidden is the safest moment there is: look at once.
    const onVisibility = () => setTick((n) => n + 1);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [build.stale]);

  useEffect(() => {
    if (!build.stale) {
      return;
    }
    const now = Date.now();
    const target = build.latestBuild ?? "unknown";
    const action = decideUpdateAction({
      stale: true,
      // A build held back for the daily announcement is not reloaded into
      // either: the page has not been told, so it has nothing to act on.
      announced: isAnnounced(build.announceAt, now),
      critical: build.critical,
      hidden: document.visibilityState === "hidden",
      sinceCallEndedMs:
        callEndedAt.current === null ? null : now - callEndedAt.current,
      staleForMs: build.since === null ? 0 : now - build.since,
      idleMs: idleForMs(now),
      inCall,
      watching,
      typing: isTypingNow(now),
      autoReloadAllowed: autoReloadAllowed(target),
      maxStaleMs: maxStaleMsFromEnv(import.meta.env.VITE_UPDATE_MAX_STALE_HOURS),
    });
    if (action !== "auto-reload") {
      return;
    }
    // The guard is written BEFORE the reload: it has to outlive this page.
    if (!recordAutoReload(target, now)) {
      return;
    }
    // Asked again at the last moment, after the worker has been brought up (up
    // to fifteen seconds): somebody may have joined a call or started a watch
    // party since this was decided, and an automatic reload never takes either.
    // Only the operator's critical update goes through.
    const mayReload = () => Boolean(build.critical) || !isBusyNow();
    // A rejection here is not the person's problem: the indicator is still up,
    // and the loop guard above means this will not be tried again.
    void Promise.resolve(apply(build.latestBuild, mayReload))
      .then((result) => {
        // It never happened, so it must not use up this build's one reload.
        if (result === "aborted") {
          forgetAutoReload(target);
        }
      })
      .catch(() => {});
  }, [build, inCall, watching, tick, apply]);

  return null;
}
