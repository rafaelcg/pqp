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

/** Rosters past this size are read on the poll cadence, not the fast one. */
const LARGE_ROSTER = 40;

/**
 * Closest together two nudged reads may land for a roster this big. In a
 * watch party joins and leaves never stop, so the 3 s floor was saturated for
 * every viewer at once: 20 full-roster reads a minute each, on top of the
 * poll, for a status pip that the 15 s poll already keeps fresh enough.
 */
const LARGE_ROSTER_NUDGE_FLOOR_MS = STATUS_REFRESH_MS;

export function nudgeFloorMs(rosterSize: number): number {
  return rosterSize > LARGE_ROSTER ? LARGE_ROSTER_NUDGE_FLOOR_MS : NUDGE_FLOOR_MS;
}

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
  rosterSize = 0,
): () => Promise<ReadonlySet<string> | null> {
  const rosterSizeRef = useRef(rosterSize);
  rosterSizeRef.current = rosterSize;
  const onMembersRef = useRef(onMembers);
  onMembersRef.current = onMembers;
  const lastLoadAt = useRef(0);

  /** The members of a fresh roster that was read and handed on, else null. */
  const load = useCallback(
    async (signal: { cancelled: boolean }): Promise<ServerMember[] | null> => {
      if (!serverId) {
        return null;
      }
      lastLoadAt.current = Date.now();
      try {
        const res = await fetchMembers(serverId);
        if (signal.cancelled) {
          return null;
        }
        onMembersRef.current(res.members);
        return res.members;
      } catch {
        // A failed refresh leaves the last known roster: stale, not wrong.
        return null;
      }
    },
    [serverId],
  );

  // A read for a server the shell has since left must not land on the new one.
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  /**
   * One read now, outside the poll and the nudge floor. For a caller that needs
   * to know the roster is no older than this call (somebody posted who is not
   * in it: either they just joined or they are gone). Resolves with the ids of
   * the members that read returned, so the caller can tell who it still lacks,
   * or null when the read failed or the server changed meanwhile.
   */
  const refreshNow = useCallback(async (): Promise<ReadonlySet<string> | null> => {
    const asked = serverId;
    const signal = {
      get cancelled() {
        return serverIdRef.current !== asked;
      },
    };
    const members = await load(signal);
    return members ? new Set(members.map((member) => member.id)) : null;
  }, [serverId, load]);

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
      timer = setInterval(() => {
        // A nudged read that landed a moment ago already answered this tick.
        if (Date.now() - lastLoadAt.current < STATUS_REFRESH_MS - 1_000) {
          return;
        }
        void load(signal);
      }, STATUS_REFRESH_MS);
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
    // Nobody is looking: the visibility handler reads once on return.
    if (document.visibilityState !== "visible") {
      return;
    }
    const signal = { cancelled: false };
    const since = Date.now() - lastLoadAt.current;
    const delay = Math.max(
      NUDGE_DEBOUNCE_MS,
      nudgeFloorMs(rosterSizeRef.current) - since,
    );
    const timer = setTimeout(() => {
      // The poll may have read in the same instant this was scheduled for.
      if (Date.now() - lastLoadAt.current < NUDGE_DEBOUNCE_MS) {
        return;
      }
      void load(signal);
    }, delay);
    return () => {
      signal.cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshNudge, serverId, load]);

  return refreshNow;
}
