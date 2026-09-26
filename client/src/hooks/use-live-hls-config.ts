import { useEffect, useState } from "react";
import { fetchLiveHlsConfig, type LiveHlsConfig } from "@/lib/api";
import { onConfigRefresh } from "@/lib/config-refresh";

/**
 * Per-server HLS availability, from `GET /api/live-hls/config?serverId=`.
 *
 * Cached per server, so the surfaces that ask (the host acknowledgment
 * sheet, the stage, the waitlist teaser) do not re-ask on every channel
 * click. A failed probe caches nothing, so the next mount asks again. Never
 * reads a build flag: whether HLS exists for a server is the server's word
 * alone.
 *
 * NOT for the page's lifetime any more. The answer is operator data and
 * runtime flags now (`servers.live_hls_enabled`, `live_hls_camera_480`,
 * `live_hls_voice_track`, ...), flipped from the dashboard with no deploy, so
 * `lib/config-refresh.ts` re-asks for every answer held here on focus and on
 * a slow timer, and a hook re-renders only when its server's answer actually
 * changed.
 */
const cache = new Map<string, Promise<LiveHlsConfig>>();
/**
 * The same answers once they have ARRIVED, read synchronously. A promise can
 * only be read on a later tick, so a surface that mounted after the answer
 * was already here still drew one frame without it: the "Baixa latência
 * (beta)" switch appeared after the rest of the setup card (production
 * rehearsal C, 2026-09-25, where a scripted toggle ran before it existed).
 */
const settled = new Map<string, LiveHlsConfig>();

/**
 * With no server id: the DEPLOYMENT-wide answer, which is what
 * `GET /api/live-hls/config` with no query gives and what the voice controller
 * asks for (it holds a channel and a transport, never a server id). Cached
 * under its own key, so it never collides with a per-server answer.
 */
export function loadLiveHlsConfig(serverId?: string): Promise<LiveHlsConfig> {
  const key = serverId ?? "";
  let pending = cache.get(key);
  if (!pending) {
    const ticket = ask(key);
    pending = fetchLiveHlsConfig(serverId).then(
      (answer) => {
        apply(key, answer, ticket);
        return answer;
      },
      (error: unknown) => {
        cache.delete(key);
        throw error;
      },
    );
    cache.set(key, pending);
  }
  return pending;
}

/**
 * NEWEST ASKED WINS, whatever order the answers land in. Every request for a
 * key takes the next number; an answer is stored only if nothing asked later
 * has been stored already. So a slow older request can never overwrite a
 * newer answer, and a newer one is never dropped for landing second.
 */
interface Ticket {
  epoch: number;
  seq: number;
}
const asked = new Map<string, number>();
const landed = new Map<string, number>();
let epoch = 0;

function ask(key: string): Ticket {
  const seq = (asked.get(key) ?? 0) + 1;
  asked.set(key, seq);
  return { epoch, seq };
}

/** Store an answer if it is the newest asked so far. Returns whether it changed anything. */
function apply(key: string, answer: LiveHlsConfig, ticket: Ticket): boolean {
  if (ticket.epoch !== epoch || ticket.seq <= (landed.get(key) ?? 0)) {
    return false;
  }
  landed.set(key, ticket.seq);
  const before = settled.get(key);
  settled.set(key, answer);
  cache.set(key, Promise.resolve(answer));
  return before === undefined || JSON.stringify(before) !== JSON.stringify(answer);
}

/** Hooks currently showing a server, by server id: the keys worth re-asking. */
const listeners = new Map<string, Set<() => void>>();
/**
 * Something on screen shows this server's answer: the refresh pass re-asks
 * it and calls `onChange` when it comes back different. Returns the release.
 */
export function watchLiveHlsConfig(serverId: string, onChange: () => void): () => void {
  let forKey = listeners.get(serverId);
  if (!forKey) {
    forKey = new Set();
    listeners.set(serverId, forKey);
  }
  const set = forKey;
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0 && listeners.get(serverId) === set) {
      listeners.delete(serverId);
    }
  };
}

/** Keys with a re-ask in flight: one at a time per key. */
const revalidating = new Set<string>();

/**
 * Re-ask for the answers somebody is looking at right now (every mounted
 * hook's server, plus the deployment-wide answer the voice controller reads)
 * and swap in the ones that changed. Answers for servers nobody is showing
 * are not re-asked; their cached promise is dropped instead, so the next
 * visit asks afresh while still drawing the old answer on its first frame.
 * Bounded by what is on screen, never by browsing history. A failure keeps
 * what was there. `config-refresh.ts` is what calls it in the app.
 */
export function revalidateLiveHlsConfig(): Promise<void> {
  const keys: string[] = [];
  for (const key of settled.keys()) {
    if (key === "" || listeners.has(key)) {
      keys.push(key);
    } else {
      cache.delete(key);
    }
  }
  return Promise.all(
    keys
      .filter((key) => !revalidating.has(key))
      .map((key) => {
        revalidating.add(key);
        const ticket = ask(key);
        const startedEpoch = epoch;
        return fetchLiveHlsConfig(key === "" ? undefined : key)
          .then(
            (answer) => {
              if (apply(key, answer, ticket)) {
                for (const listener of listeners.get(key) ?? []) {
                  listener();
                }
              }
            },
            () => {
              // Stale beats blank.
            },
          )
          .finally(() => {
            if (startedEpoch === epoch) {
              revalidating.delete(key);
            }
          });
      }),
  ).then(() => undefined);
}

onConfigRefresh(() => {
  void revalidateLiveHlsConfig();
});

/** Test seam. */
export function resetLiveHlsConfigCache(): void {
  epoch += 1;
  cache.clear();
  settled.clear();
  asked.clear();
  landed.clear();
  revalidating.clear();
}

/** An answer already in hand for this server, or null. Never fetches. */
export function settledLiveHlsConfig(serverId: string | null): LiveHlsConfig | null {
  return serverId ? (settled.get(serverId) ?? null) : null;
}

/**
 * `null` until the server has answered (or while there is no server: a DM
 * call has no allowlist to consult). Refetches when the server changes.
 */
export function useLiveHlsConfig(serverId: string | null): LiveHlsConfig | null {
  // AN ANSWER ALREADY IN HAND IS USED ON THE FIRST RENDER, and a server
  // change never blanks it back to null for a frame when the new server's
  // answer is in hand too. Both used to cost one render with no config,
  // which is a render with no "Baixa latência (beta)" row.
  const [config, setConfig] = useState<LiveHlsConfig | null>(() =>
    settledLiveHlsConfig(serverId),
  );
  useEffect(() => {
    if (!serverId) {
      return;
    }
    return watchLiveHlsConfig(serverId, () =>
      setConfig(settledLiveHlsConfig(serverId)),
    );
  }, [serverId]);
  useEffect(() => {
    setConfig(settledLiveHlsConfig(serverId));
    if (!serverId) {
      return;
    }
    let cancelled = false;
    loadLiveHlsConfig(serverId)
      .then((answer) => {
        if (!cancelled) {
          // The stored answer, not this response: a newer re-ask may have
          // landed while this one was out.
          setConfig(settledLiveHlsConfig(serverId) ?? answer);
        }
      })
      .catch(() => {
        // Unknown stays unknown; callers treat null as "ask the old way".
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);
  return config;
}
