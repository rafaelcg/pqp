import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FriendActivity, FriendsResponse, PublicUser } from "@pqp/shared";
import { translateMessage } from "@/lib/i18n/catalogue";
import {
  acceptFriendRequest,
  fetchFriends,
  removeFriend,
  sendFriendRequest,
} from "./friends-api";

/**
 * The friends snapshot: `GET /api/friends`, held ONCE for the whole app.
 *
 * WHY ONCE, WHEN IT USED TO BE PER-VIEW. Two things changed. The first is that
 * a pending request now has to be visible from *outside* the friends view —
 * badged on the app's front door — and a hook mounted only by that view cannot
 * badge the door to itself. The second is the profile card, which mounted a
 * second independent copy: opening a card refetched the entire list and started
 * a second timer, so two surfaces showing the same relationship could disagree
 * about it for fifteen seconds.
 *
 * PUSH FOR REQUESTS, PULL FOR PRESENCE. These are two different facts with two
 * different cadences, and conflating them is what made the old design feel
 * broken:
 *
 *  - A REQUEST is an event, and events belong on the socket. `friend-activity`
 *    is that frame (see `friendActivitySchema`); `applyNudge` below is where it
 *    lands. Requests are therefore live everywhere, including on a screen that
 *    has never heard of the friends view.
 *
 *  - PRESENCE is a soft, continuous fact, and stays pulled for exactly the
 *    reasons `use-friends`'s predecessor and the members panel both argue at
 *    length: a pushed status has to reach everybody who shares any surface with
 *    the changing person, and nearly all of those clients have nothing on
 *    screen that draws it.
 *
 * So the timer survives, but it now runs only while something is actually
 * DRAWING presence. `useFriends()` registers as such a consumer; the badge's
 * `useFriendRequestCount()` does not, because a number does not go stale when
 * somebody steps away from their desk. Nobody looking at a friend still means
 * zero polling — the property pull was chosen for — while the badge stays
 * correct anyway, because the nudge tells it when to care.
 */
const REFRESH_MS = 15_000;

const EMPTY: FriendsResponse = { friends: [], incoming: [], outgoing: [] };

/** The last nudge, once, for a view that wants to say something about it. */
export interface FriendNudge {
  kind: FriendActivity["kind"];
  /** Distinguishes two identical nudges, so a second one re-shows the line. */
  at: number;
}

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
  /**
   * A `friend-activity` frame arrived. Called by the app's socket handler, not
   * by a view — the shell owns the connection, the same way it owns
   * `profile-update`.
   */
  applyNudge: (kind: FriendActivity["kind"]) => void;
  /** Set by `applyNudge`, cleared by whoever showed it. */
  nudge: FriendNudge | null;
  clearNudge: () => void;
  /**
   * Count this caller as somebody drawing presence, for as long as it is
   * mounted. Returns the unsubscribe. Used by `useFriends`; not by the badge.
   */
  retainLive: () => () => void;
}

/**
 * The store, instantiated exactly once — by the app shell, which then publishes
 * it through `FriendsContext` and feeds it socket frames.
 *
 * `enabled` is the shell's "you may talk to the API now", and it is not
 * optional politeness. `setAuthTokenProvider` is installed by an EFFECT in the
 * shell, and effects run in the order their hooks were declared: a fetch fired
 * from this store's own mount effect goes out before that provider exists, gets
 * no `Authorization` header, and comes back 401 — and because the provider is
 * still the null default, even the refresh-and-retry path cannot rescue it. The
 * visible symptom is a console error on every cold boot, which is exactly what
 * `theme-tokens.spec.ts` asserts the absence of.
 *
 * Gating on the shell's bootstrap instead also gets the age gate for free: an
 * account that has not answered it has no business reading a friends list.
 */
export function useFriendsStore(enabled: boolean): FriendsState {
  const [data, setData] = useState<FriendsResponse>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<FriendNudge | null>(null);
  const [liveConsumers, setLiveConsumers] = useState(0);

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

  // One read as soon as the shell says the API is reachable, whether or not
  // anybody is looking at a friend: the badge on the front door has to be right
  // the moment the door is drawn.
  useEffect(() => {
    aliveRef.current = true;
    if (enabled) {
      void refresh();
    }
    return () => {
      aliveRef.current = false;
    };
  }, [enabled, refresh]);

  // The presence timer, alive only while something draws presence. See above.
  useEffect(() => {
    if (!enabled || liveConsumers === 0) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, liveConsumers, refresh]);

  const retainLive = useCallback(() => {
    setLiveConsumers((count) => count + 1);
    return () => setLiveConsumers((count) => Math.max(0, count - 1));
  }, []);

  const applyNudge = useCallback(
    (kind: FriendActivity["kind"]) => {
      // The frame is content-free by design, so the refetch IS the payload —
      // and it is the same read every other path here takes, which is why one
      // extra frame cannot put the list into a shape nothing else produces.
      setNudge({ kind, at: Date.now() });
      void refresh();
    },
    [refresh],
  );

  const clearNudge = useCallback(() => setNudge(null), []);

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

  return {
    data,
    loading,
    error,
    refresh,
    send,
    accept,
    remove,
    applyNudge,
    nudge,
    clearNudge,
    retainLive,
  };
}

// ------------------------------------------------------------------ context

export const FriendsContext = createContext<FriendsState | null>(null);

/**
 * The snapshot, plus a declaration that this caller draws presence and wants
 * the timer running while it is mounted.
 *
 * Outside a provider it returns an inert store rather than throwing, matching
 * `useProfilePopover`: a component tree under test renders without the shell,
 * and losing a friends list is not worth crashing a render over.
 */
export function useFriends(): FriendsState {
  const store = useContext(FriendsContext);
  const retainLive = store?.retainLive;
  useEffect(() => retainLive?.(), [retainLive]);
  return store ?? INERT;
}

/**
 * Requests waiting on you, for a badge — deliberately WITHOUT retaining the
 * presence timer. A count does not go stale when somebody steps away, and the
 * nudge already tells it when it does.
 */
export function useFriendRequestCount(): number {
  return useContext(FriendsContext)?.data.incoming.length ?? 0;
}

const INERT: FriendsState = {
  data: EMPTY,
  loading: false,
  error: null,
  refresh: async () => {},
  send: async () => "pending",
  accept: async () => {},
  remove: async () => {},
  applyNudge: () => {},
  nudge: null,
  clearNudge: () => {},
  retainLive: () => () => {},
};
