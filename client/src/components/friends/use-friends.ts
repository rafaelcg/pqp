import { useCallback, useEffect, useRef, useState } from "react";
import type { FriendsResponse, PublicUser } from "@pqp/shared";
import { translateMessage } from "@/lib/i18n/catalogue";
import {
  acceptFriendRequest,
  fetchFriends,
  removeFriend,
  sendFriendRequest,
} from "./friends-api";

/**
 * The friends view's data: one snapshot of `GET /api/friends`, re-read on a
 * timer while the view is mounted.
 *
 * POLLING IS THE DESIGN, NOT A SHORTCUT. Status is a pull surface on the
 * server (see ws/status.ts): there is no status-update frame to subscribe to,
 * so the dots can only be as fresh as the last read — exactly how the members
 * panel behaves, and the same 15s cadence. The cost is one bounded query per
 * open view, and zero when nobody is looking, which is the entire argument
 * for pull.
 */
const REFRESH_MS = 15_000;

const EMPTY: FriendsResponse = { friends: [], incoming: [], outgoing: [] };

export interface FriendsState {
  data: FriendsResponse;
  /** True only before the first snapshot — refreshes are silent. */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Resolves to the result state so the caller can word its confirmation. */
  send: (user: PublicUser) => Promise<"pending" | "accepted">;
  accept: (userId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
}

export function useFriends(): FriendsState {
  const [data, setData] = useState<FriendsResponse>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The poll must not resurrect state after unmount, and a slow response must
  // not overwrite the result of an action taken while it was in flight — the
  // generation counter drops any read that is no longer the newest.
  const aliveRef = useRef(true);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const response = await fetchFriends();
      if (!aliveRef.current || generation !== generationRef.current) {
        return;
      }
      setData(response);
      setError(null);
    } catch {
      if (!aliveRef.current || generation !== generationRef.current) {
        return;
      }
      // The stale list stays on screen — a friends list that blanks itself on
      // one failed poll reads as everyone leaving.
      setError(translateMessage("friends.loadFailed"));
    } finally {
      if (aliveRef.current && generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const send = useCallback(
    async (user: PublicUser) => {
      const result = await sendFriendRequest(user.id);
      await refresh();
      return result.state;
    },
    [refresh],
  );

  const accept = useCallback(
    async (userId: string) => {
      await acceptFriendRequest(userId);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (userId: string) => {
      await removeFriend(userId);
      await refresh();
    },
    [refresh],
  );

  return { data, loading, error, refresh, send, accept, remove };
}
