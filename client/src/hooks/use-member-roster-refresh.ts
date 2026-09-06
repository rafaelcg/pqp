import { useCallback, useEffect, useRef } from "react";
import { fetchMembers, type ServerMember } from "@/lib/api";

const STATUS_REFRESH_MS = 15_000;

/** How long a burst of frames is allowed to coalesce into one read. */
const NUDGE_DEBOUNCE_MS = 400;

/**
 * Closest together two nudged reads may land. Three seconds keeps "they just
 * came online" feeling immediate while capping a busy server at a third of a
 * request per second — comfortably under what the 15-second poll alone would
 * cost across a handful of readers.
 */
const NUDGE_FLOOR_MS = 3_000;

/**
 * The one members poll / presence nudge for a selected server.
 *
 * Status is pulled (`GET /api/servers/:id/members`). `presence-update` is
 * only a hint that someone started looking at a channel — the caller bumps
 * `refreshNudge` and this hook re-reads, then the shell merges statuses into
 * the shared roster. Paused while the tab is hidden. Does not fetch on
 * mount: the shell's first load already covers that.
 */
export function useMemberRosterRefresh(
  serverId: string | null,
  refreshNudge: number,
  onMembers: (members: ServerMember[]) => void,
): void {
  const onMembersRef = useRef(onMembers);
  onMembersRef.current = onMembers;
  const lastLoadAt = useRef(0);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!serverId) {
        return;
      }
      lastLoadAt.current = Date.now();
      try {
        const res = await fetchMembers(serverId);
        if (!signal.cancelled) {
          onMembersRef.current(res.members);
        }
      } catch {
        // A failed refresh leaves the last known roster: stale, not wrong.
      }
    },
    [serverId],
  );

  useEffect(() => {
    if (!serverId) {
      return;
    }
    // The shell's first fetch for this server counts as the latest read, so
    // a presence frame that lands in the same second does not double-hit.
    lastLoadAt.current = Date.now();
    const signal = { cancelled: false };
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      timer = setInterval(() => void load(signal), STATUS_REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load(signal);
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      signal.cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [serverId, load]);

  const firstNudge = useRef(true);
  useEffect(() => {
    firstNudge.current = true;
  }, [serverId]);

  useEffect(() => {
    if (!serverId) {
      return;
    }
    if (firstNudge.current) {
      firstNudge.current = false;
      return;
    }
    const signal = { cancelled: false };
    const since = Date.now() - lastLoadAt.current;
    const delay = Math.max(NUDGE_DEBOUNCE_MS, NUDGE_FLOOR_MS - since);
    const timer = setTimeout(() => void load(signal), delay);
    return () => {
      signal.cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshNudge, serverId, load]);
}
