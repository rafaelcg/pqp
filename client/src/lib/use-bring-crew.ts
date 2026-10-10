import { useCallback, useEffect, useRef, useState } from "react";
import type { BringCrewPhase, DiscordImportArrivals } from "@pqp/shared";
import { getImportArrivals } from "@/lib/api";
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
  const forServer = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!serverId || !canManage) {
      return;
    }
    const asked = serverId;
    getImportArrivals(asked)
      .then((next) => {
        if (forServer.current === asked) {
          setArrivals(next);
        }
      })
      .catch(() => {
        // A 403 after a permission change, or the API without the route:
        // nothing to draw.
        if (forServer.current === asked) {
          setArrivals(null);
        }
      });
  }, [serverId, canManage]);

  useEffect(() => {
    forServer.current = serverId;
    setArrivals(null);
    setDismissed(serverId ? readBringCrewDismissed(serverId) : null);
  }, [serverId]);

  // First answer, and again whenever somebody joins or leaves.
  useEffect(() => {
    load();
  }, [load, memberCount]);

  const live =
    arrivals?.enabled === true &&
    arrivals.phase !== null &&
    arrivals.phase !== "over";

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
