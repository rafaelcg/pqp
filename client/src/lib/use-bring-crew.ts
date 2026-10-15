import { useCallback, useEffect, useRef, useState } from "react";
import type { BringCrewPhase, DiscordImportArrivals } from "@pqp/shared";
import { ApiError, getImportArrivals } from "@/lib/api";
import { readBringCrewDismissed, writeBringCrewDismissed } from "@/lib/bring-crew";

/** While the strip is up, ask again this often even if nothing else moved. */
const POLL_MS = 30_000;

/**
 * A burst of joins (people arriving from the pinned announcement) becomes one
 * request: the member count must hold still this long before we ask. The 30 s
 * poll already bounds how stale the counter can get.
 */
export const MEMBER_COUNT_DEBOUNCE_MS = 2_000;

/**
 * Worth asking again: the network never answered, the server said slow down,
 * the request timed out (408), or the server fell over. Everything else (a
 * permission taken away, an API without the route) is a final answer.
 */
export function isTransientArrivalsError(error: unknown): boolean {
  return (
    !(error instanceof ApiError) ||
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  );
}

/**
 * The owner's "N pessoas da tua galera já chegaram" counter for the open
 * server. Asks only somebody who may manage it (the route says 403 to anybody
 * else), and asks again when the member list changes length (a join arrived
 * over the socket, debounced so a burst is one request), when the tab comes
 * back into focus, and every 30 s while the window is open. Losing Manage
 * Server takes the counter down at once: nothing is returned, so nothing draws
 * and Copy cannot put the permanent invite on the clipboard. A server that
 * was not imported, or the flag being off, answers once and stays quiet until
 * the next server switch.
 */
export function useBringCrew(
  serverId: string | null,
  canManage: boolean,
  memberCount: number,
): {
  arrivals: DiscordImportArrivals | null;
  dismissed: BringCrewPhase | null;
  dismiss: () => void;
} {
  const [arrivals, setArrivals] = useState<DiscordImportArrivals | null>(null);
  const [dismissed, setDismissed] = useState<BringCrewPhase | null>(null);
  /** The last request failed for a reason worth retrying (network, 5xx). */
  const [retrying, setRetrying] = useState(false);
  const forServer = useRef<string | null>(null);
  /** Only the newest request may write: polls and focus can overlap. */
  const latest = useRef(0);

  const load = useCallback(() => {
    if (!serverId) {
      return;
    }
    if (!canManage) {
      // The permission went away: forget the answer, and let a request that
      // is still in flight land on nothing.
      latest.current += 1;
      setArrivals(null);
      setRetrying(false);
      return;
    }
    const asked = serverId;
    const ticket = ++latest.current;
    const current = () => forServer.current === asked && latest.current === ticket;
    getImportArrivals(asked)
      .then((next) => {
        if (current()) {
          setArrivals(next);
          setRetrying(false);
        }
      })
      .catch((error: unknown) => {
        if (!current()) {
          return;
        }
        if (!isTransientArrivalsError(error)) {
          // A permission taken away, an API without the route, any other
          // refusal: nothing to draw, and nothing to retry.
          setArrivals(null);
          setRetrying(false);
          return;
        }
        // A blip: keep what is on screen and keep asking.
        setRetrying(true);
      });
  }, [serverId, canManage]);

  useEffect(() => {
    forServer.current = serverId;
    setArrivals(null);
    setRetrying(false);
    setDismissed(serverId ? readBringCrewDismissed(serverId) : null);
  }, [serverId]);

  // First answer, and again when the server or the permission changes.
  useEffect(() => {
    load();
  }, [load]);

  // Somebody joined or left: ask once the burst settles. Zero means the list
  // has not loaded (it resets on a server switch), and the first load of it is
  // not a change: the effect above already asked.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const lastCount = useRef(memberCount);
  useEffect(() => {
    const before = lastCount.current;
    lastCount.current = memberCount;
    if (memberCount === 0 || before === 0 || before === memberCount) {
      return;
    }
    const timer = window.setTimeout(
      () => loadRef.current(),
      MEMBER_COUNT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [memberCount]);

  // Derived as well as cleared: the render where `canManage` turns false must
  // not draw the strip while the effect that forgets it is still to run.
  const visible = canManage ? arrivals : null;

  const live =
    canManage &&
    (retrying ||
      (arrivals?.enabled === true &&
        arrivals.phase !== null &&
        arrivals.phase !== "over"));

  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = window.setInterval(load, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [live, load]);

  const dismiss = useCallback(() => {
    if (!serverId || !visible?.phase || visible.phase === "over") {
      return;
    }
    writeBringCrewDismissed(serverId, visible.phase);
    setDismissed(visible.phase);
  }, [serverId, visible?.phase]);

  return { arrivals: visible, dismissed, dismiss };
}
