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
    pending = fetchLiveHlsConfig(serverId).then(
      (answer) => {
        settled.set(key, answer);
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

/** Hooks to tell when a re-ask brought back a different answer. */
const listeners = new Set<(key: string) => void>();

/**
 * Re-ask for every answer already held, and swap in the ones that changed.
 * A failure keeps what was there. Exported for tests; `config-refresh.ts`
 * is what calls it in the app.
 */
export function revalidateLiveHlsConfig(): Promise<void> {
  const keys = [...settled.keys()];
  return Promise.all(
    keys.map((key) =>
      fetchLiveHlsConfig(key === "" ? undefined : key).then(
        (answer) => {
          const before = settled.get(key);
          if (before !== undefined && JSON.stringify(before) === JSON.stringify(answer)) {
            return;
          }
          settled.set(key, answer);
          cache.set(key, Promise.resolve(answer));
          for (const listener of listeners) {
            listener(key);
          }
        },
        () => {
          // Stale beats blank.
        },
      ),
    ),
  ).then(() => undefined);
}

onConfigRefresh(() => {
  void revalidateLiveHlsConfig();
});

/** Test seam. */
export function resetLiveHlsConfigCache(): void {
  cache.clear();
  settled.clear();
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
    const listener = (key: string) => {
      if (key === serverId) {
        setConfig(settledLiveHlsConfig(serverId));
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
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
          setConfig(answer);
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
