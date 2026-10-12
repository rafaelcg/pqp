import { useEffect, useState } from "react";
import { fetchForumConfig, type ForumConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Forum channels for one server, from `GET /api/forum/config?serverId=`: the
 * runtime flag `forum_channels` (per server, default off; see
 * `server/src/lib/forum-config.ts` and `docs/FEATURE_FLAGS.md`).
 *
 * WHAT OFF MEANS ON THIS SIDE. Off only stops CREATING: the "+" menu in the
 * Texto section offers no "Fórum", and an existing forum shows "Novos posts
 * estão pausados neste fórum." instead of "Novo post". Nothing that exists is
 * hidden, so reading and replying keep working whatever this says.
 *
 * `loaded` exists for that paused line. Before the answer lands the honest
 * state is "do not know", and drawing "pausados" for a frame on a forum that
 * is on would be a lie the reader sees. So a surface that SAYS something
 * about the flag waits for `loaded`, and one that only OFFERS something
 * (the "+" menu) treats unknown as off.
 *
 * Operator data flipped with no deploy, so every answer held here is re-asked
 * on focus and on a slow timer by `lib/config-refresh.ts`, and a hook
 * re-renders when its server's answer changes. A failed ask keeps what was
 * there (stale beats blank); an API that predates the route answers 404,
 * which reads as off.
 */
export interface ForumConfigState {
  enabled: boolean;
  /** The server has answered at least once for this server. */
  loaded: boolean;
}

const OFF_UNKNOWN: ForumConfigState = { enabled: false, loaded: false };
/** One more ask after a failed first one (not after a 404, which is an answer). */
export const FORUM_CONFIG_RETRY_MS = 5_000;

const settled = new Map<string, ForumConfig>();
const inflight = new Map<string, Promise<ForumConfig>>();
const listeners = new Map<string, Set<() => void>>();
let refreshRegistered = false;

function stateFor(serverId: string | null | undefined): ForumConfigState {
  if (!serverId) {
    return OFF_UNKNOWN;
  }
  const answer = settled.get(serverId);
  return answer === undefined
    ? OFF_UNKNOWN
    : { enabled: answer.enabled === true, loaded: true };
}

function notify(serverId: string): void {
  for (const listener of listeners.get(serverId) ?? []) {
    listener();
  }
}

/** Ask (once at a time per server) and store the answer. */
export function loadForumConfig(serverId: string): Promise<ForumConfig> {
  let pending = inflight.get(serverId);
  if (!pending) {
    pending = fetchForumConfig(serverId)
      .then((answer) => {
        const before = settled.get(serverId);
        settled.set(serverId, answer);
        if (before === undefined || before.enabled !== answer.enabled) {
          notify(serverId);
        }
        return answer;
      })
      .catch((error: unknown) => {
        // A 404 is an API that does not serve forums (an older or rolled-back
        // build): a real answer, and it is off, even over an "on" held from
        // before. Anything else (a blip) keeps what was there and stays
        // unknown when nothing was.
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 404 && settled.get(serverId)?.enabled !== false) {
          settled.set(serverId, { enabled: false });
          notify(serverId);
        }
        throw error;
      })
      .finally(() => {
        inflight.delete(serverId);
      });
    inflight.set(serverId, pending);
  }
  return pending;
}

function registerRefresh(): void {
  if (refreshRegistered) {
    return;
  }
  refreshRegistered = true;
  onConfigRefresh(() => {
    for (const serverId of listeners.keys()) {
      void loadForumConfig(serverId).catch(() => {
        // Stale beats blank.
      });
    }
  });
}

/** The answer in hand for this server, never fetching. */
export function settledForumConfig(
  serverId: string | null | undefined,
): ForumConfigState {
  return stateFor(serverId);
}

export function useForumConfig(
  serverId: string | null | undefined,
): ForumConfigState {
  // An answer already in hand is used on the first render, so switching back
  // to a server never blinks its "Fórum" entry or its paused line. The state
  // carries the server it answers for: on the render where the server id
  // changes, the effect below has not run yet, and the previous server's
  // answer must not be read as this one's.
  const [held, setHeld] = useState(() => ({
    serverId: serverId ?? null,
    config: stateFor(serverId),
  }));
  const config =
    held.serverId === (serverId ?? null) ? held.config : stateFor(serverId);
  useEffect(() => {
    if (!serverId) {
      setHeld({ serverId: null, config: OFF_UNKNOWN });
      return;
    }
    registerRefresh();
    const update = () => setHeld({ serverId, config: stateFor(serverId) });
    let forKey = listeners.get(serverId);
    if (!forKey) {
      forKey = new Set();
      listeners.set(serverId, forKey);
    }
    const set = forKey;
    set.add(update);
    update();
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    if (!settled.has(serverId)) {
      void loadForumConfig(serverId).catch(() => {
        // A blip, not an answer: ask once more shortly rather than leave
        // "Fórum" missing from the "+" until the next refresh pass. Not if
        // the surface asking has already gone.
        if (disposed) {
          return;
        }
        retry = setTimeout(() => {
          retry = null;
          if (!settled.has(serverId)) {
            void loadForumConfig(serverId).catch(() => {
              // Off until the next refresh.
            });
          }
        }, FORUM_CONFIG_RETRY_MS);
      });
    }
    return () => {
      disposed = true;
      if (retry !== null) {
        clearTimeout(retry);
      }
      set.delete(update);
      if (set.size === 0 && listeners.get(serverId) === set) {
        listeners.delete(serverId);
      }
    };
  }, [serverId]);
  return config;
}

/** Test seam. */
export function resetForumConfigForTests(): void {
  settled.clear();
  inflight.clear();
  listeners.clear();
  refreshRegistered = false;
}
