import { useEffect, useState } from "react";
import type { AppsConfig } from "@pqp/shared";
import { fetchAppsConfig } from "@/lib/apps/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Apps for one server, from `GET /api/apps/config?serverId=`: the runtime flag
 * `apps` (per server, default off) and the list the launcher draws.
 *
 * Everything that draws an app asks this first, and everything renders
 * nothing and requests nothing else while `enabled` is false OR the answer has
 * not landed yet: "do not know" is off, the same rule the forum config follows.
 *
 * Operator data flipped with no deploy, so every answer held here is re-asked
 * on focus and on a slow timer by `lib/config-refresh.ts`. A failed ask keeps
 * what was there (stale beats blank); an API that predates the route answers
 * 404, which reads as off.
 */
export interface AppsConfigState {
  enabled: boolean;
  /** The server has answered at least once for this server. */
  loaded: boolean;
  /** The apps origin, or null while this deployment has none. */
  origin: string | null;
  apps: AppsConfig["apps"];
}

const NO_APPS: AppsConfig["apps"] = [];
const OFF_UNKNOWN: AppsConfigState = {
  enabled: false,
  loaded: false,
  origin: null,
  apps: NO_APPS,
};
const OFF_ANSWERED: AppsConfigState = { ...OFF_UNKNOWN, loaded: true };

/** One more ask after a failed first one (not after a 404, which is an answer). */
export const APPS_CONFIG_RETRY_MS = 5_000;

const settled = new Map<string, AppsConfigState>();
const inflight = new Map<string, Promise<AppsConfigState>>();
const listeners = new Map<string, Set<() => void>>();
let refreshRegistered = false;

function stateFor(serverId: string | null | undefined): AppsConfigState {
  if (!serverId) {
    return OFF_UNKNOWN;
  }
  return settled.get(serverId) ?? OFF_UNKNOWN;
}

function notify(serverId: string): void {
  for (const listener of listeners.get(serverId) ?? []) {
    listener();
  }
}

function sameAnswer(a: AppsConfigState, b: AppsConfigState): boolean {
  return (
    a.enabled === b.enabled &&
    a.origin === b.origin &&
    JSON.stringify(a.apps) === JSON.stringify(b.apps)
  );
}

/** Ask (once at a time per server) and store the answer. */
export function loadAppsConfig(serverId: string): Promise<AppsConfigState> {
  let pending = inflight.get(serverId);
  if (!pending) {
    pending = fetchAppsConfig(serverId)
      .then((answer) => {
        const next: AppsConfigState = {
          enabled: answer.enabled === true,
          loaded: true,
          origin: answer.origin,
          apps: answer.enabled ? answer.apps : NO_APPS,
        };
        const before = settled.get(serverId);
        settled.set(serverId, next);
        if (!before || !sameAnswer(before, next)) {
          notify(serverId);
        }
        return next;
      })
      .catch((error: unknown) => {
        // A 404 is an API that does not serve apps (an older or rolled-back
        // build): a real answer, and it is off. Anything else (a blip) keeps
        // what was there and stays unknown when nothing was.
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 404 && settled.get(serverId)?.enabled !== false) {
          settled.set(serverId, OFF_ANSWERED);
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
      void loadAppsConfig(serverId).catch(() => {
        // Stale beats blank.
      });
    }
  });
}

/** The answer in hand for this server, never fetching. */
export function settledAppsConfig(
  serverId: string | null | undefined,
): AppsConfigState {
  return stateFor(serverId);
}

export function useAppsConfig(
  serverId: string | null | undefined,
): AppsConfigState {
  // The state carries the server it answers for: on the render where the
  // server id changes the effect below has not run yet, and the previous
  // server's answer must not be read as this one's.
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
      void loadAppsConfig(serverId).catch(() => {
        if (disposed) {
          return;
        }
        retry = setTimeout(() => {
          retry = null;
          if (!settled.has(serverId)) {
            void loadAppsConfig(serverId).catch(() => {
              // Off until the next refresh.
            });
          }
        }, APPS_CONFIG_RETRY_MS);
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
export function resetAppsConfigForTests(): void {
  settled.clear();
  inflight.clear();
  listeners.clear();
  refreshRegistered = false;
}
