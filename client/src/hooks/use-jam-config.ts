import { useEffect, useState } from "react";
import { onConfigRefresh } from "@/lib/config-refresh";
import { fetchJamConfig } from "@/lib/jam-api";

/**
 * Jam for one server, from `GET /api/jam/config?serverId=`: the runtime flag
 * `jam_channels` (per server, default off) and whether object storage is
 * configured here.
 *
 * WHAT OFF MEANS ON THIS SIDE. Off only stops CREATING and CHANGING: the add
 * menus offer no Jam, a wall shows "paused" where its Gravar buttons were, and
 * a song panel loses "Gravar por cima". Reading is never gated, so every song
 * that exists stays on the wall and plays. `uploads: false` means a song can be
 * started but no track can be added, and the screens say so instead of failing
 * after a recording.
 *
 * Operator data flipped with no deploy, so every answer held here is asked
 * again on focus and on a slow timer by `lib/config-refresh.ts`. A failed ask
 * keeps what was there; an API that predates the route (404) reads as off.
 * Anything that only OFFERS something treats "not loaded" as off; a surface
 * that SAYS something about the flag waits for `loaded`.
 */
export interface JamConfigState {
  enabled: boolean;
  uploads: boolean;
  loaded: boolean;
}

const UNKNOWN: JamConfigState = { enabled: false, uploads: false, loaded: false };

const settled = new Map<string, JamConfigState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
let refreshRegistered = false;

function stateFor(serverId: string | null | undefined): JamConfigState {
  return (serverId ? settled.get(serverId) : undefined) ?? UNKNOWN;
}

function load(serverId: string): Promise<void> {
  let pending = inflight.get(serverId);
  if (!pending) {
    pending = fetchJamConfig(serverId)
      .then((answer) => {
        const next = { enabled: answer.enabled === true, uploads: answer.uploads === true, loaded: true };
        const before = settled.get(serverId);
        settled.set(serverId, next);
        if (!before || before.enabled !== next.enabled || before.uploads !== next.uploads) {
          for (const listener of listeners.get(serverId) ?? []) listener();
        }
      })
      .catch((error: unknown) => {
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 404) {
          settled.set(serverId, { enabled: false, uploads: false, loaded: true });
          for (const listener of listeners.get(serverId) ?? []) listener();
        }
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
      void load(serverId);
    }
  });
}

/**
 * The answer for one server, asked once if nobody has asked yet. For code that is not a
 * component (a chat card deciding whether it may draw). A failed ask reads as off.
 */
export async function ensureJamConfig(serverId: string): Promise<JamConfigState> {
  if (!settled.has(serverId)) {
    await load(serverId);
  }
  return stateFor(serverId);
}

export function useJamConfig(serverId: string | null | undefined): JamConfigState {
  const [held, setHeld] = useState(() => ({ serverId: serverId ?? null, config: stateFor(serverId) }));
  const config = held.serverId === (serverId ?? null) ? held.config : stateFor(serverId);
  useEffect(() => {
    if (!serverId) {
      setHeld({ serverId: null, config: UNKNOWN });
      return;
    }
    registerRefresh();
    const update = () => setHeld({ serverId, config: stateFor(serverId) });
    let forServer = listeners.get(serverId);
    if (!forServer) {
      forServer = new Set();
      listeners.set(serverId, forServer);
    }
    const set = forServer;
    set.add(update);
    update();
    if (!settled.has(serverId)) {
      void load(serverId);
    }
    return () => {
      set.delete(update);
      if (set.size === 0 && listeners.get(serverId) === set) {
        listeners.delete(serverId);
      }
    };
  }, [serverId]);
  return config;
}
