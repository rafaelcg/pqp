import { useCallback, useEffect, useRef, useState } from "react";
import type { BringCrewPhase, DiscordImportArrivals } from "@pqp/shared";
import { ApiError, getImportArrivals } from "@/lib/api";
import { readBringCrewDismissed, writeBringCrewDismissed } from "@/lib/bring-crew";

/** While the strip is up, ask again this often even if nothing else moved. */
const POLL_MS = 30_000;

/**
 * The owner's "N pessoas da tua galera já chegaram" counter for the open
 * server. Asks only somebody who may manage it (the route says 403 to anybody
 * else), and asks again when the member list changes length (a join arrived
 * over the socket), when the tab comes back into focus, and every 30 s
 * while the window is open. A server that was not imported, or the flag being
 * off, answers once and stays quiet until the next server switch.
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
    if (!serverId || !canManage) {
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
        const transient =
          !(error instanceof ApiError) ||
          error.status === 0 ||
          error.status === 429 ||
          error.status >= 500;
        if (!transient) {
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

  // First answer, and again whenever somebody joins or leaves.
  useEffect(() => {
    load();
  }, [load, memberCount]);

  const live =
    retrying ||
    (arrivals?.enabled === true &&
      arrivals.phase !== null &&
      arrivals.phase !== "over");

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
    if (!serverId || !arrivals?.phase || arrivals.phase === "over") {
      return;
    }
    writeBringCrewDismissed(serverId, arrivals.phase);
    setDismissed(arrivals.phase);
  }, [serverId, arrivals?.phase]);

  return { arrivals, dismissed, dismiss };
}
