import { useEffect, useState } from "react";
import { fetchLiveHlsConfig, type LiveHlsConfig } from "@/lib/api";

/**
 * Per-server HLS availability, from `GET /api/live-hls/config?serverId=`.
 *
 * Cached per server for the page's lifetime: the answer is an operator
 * allowlist, not something that flips mid-session, and the surfaces that
 * ask (the host acknowledgment sheet, later the stage) would otherwise re-ask
 * on every channel click. A failed probe caches nothing, so the next mount
 * asks again. Never reads a build flag: whether HLS exists for a server is
 * the server's word alone.
 */
const cache = new Map<string, Promise<LiveHlsConfig>>();

export function loadLiveHlsConfig(serverId: string): Promise<LiveHlsConfig> {
  let pending = cache.get(serverId);
  if (!pending) {
    pending = fetchLiveHlsConfig(serverId).catch((error: unknown) => {
      cache.delete(serverId);
      throw error;
    });
    cache.set(serverId, pending);
  }
  return pending;
}

/** Test seam. */
export function resetLiveHlsConfigCache(): void {
  cache.clear();
}

/**
 * `null` until the server has answered (or while there is no server: a DM
 * call has no allowlist to consult). Refetches when the server changes.
 */
export function useLiveHlsConfig(serverId: string | null): LiveHlsConfig | null {
  const [config, setConfig] = useState<LiveHlsConfig | null>(null);
  useEffect(() => {
    setConfig(null);
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
