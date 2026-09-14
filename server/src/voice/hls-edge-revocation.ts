/**
 * Tells the edge Worker's KV denylist (`HLS_REVOKED_USERS`,
 * `PartyPassRevocationGate` in `tools/hls-edge/src/party-pass-revocation.js`)
 * that a viewer's access to a channel was just taken away, so a `?t=` token
 * or `?pp=` party pass minted before the eviction stops being honored by the
 * Worker's shared rendition cache within the gate's 30 s cache window
 * instead of riding out the party pass's full 6 h ceiling. See
 * `tools/hls-edge/README.md` "Enabling in production" for the operator
 * side of this (the KV namespace, the binding, and these env vars) and
 * `hls-revocation.ts` for the eviction seam this hooks into.
 *
 * WHY A DIRECT CLOUDFLARE API CALL, NOT A QUEUE. This fires from the same
 * places `hls-revocation.ts`'s in-memory set already writes to -- a ban, a
 * kick, a role losing VIEW -- rare, human-triggered moderation events, not a
 * hot path. A `fetch` with a short timeout costs nothing the eviction path
 * would notice, and this is never awaited by the eviction functions
 * themselves (`revokeHlsAccess` calls `writeHlsEdgeRevocationForScope`
 * without `await`) -- a Cloudflare outage or a missing config must not slow
 * down, or fail, kicking someone out of a channel view.
 *
 * WHY KEYED BY userId:channelId, NOT userId ALONE. A party pass is scoped
 * to one channel (`mintHlsPartyPass` binds `channelId` into its signed
 * claims), and `hls-revocation.ts`'s own model is per-channel too -- a
 * viewer kicked from one channel keeps a still-valid pass (and an
 * unaffected `?t=`) for any OTHER channel they can legitimately watch.
 * `hlsEdgeRevocationKey` matches exactly what the Worker's gate looks up.
 *
 * WHAT THIS DOES NOT COVER. `revokeHlsAccess` with no scope (a channel
 * deleted, or gone private for EVERYONE, `entry.only` unset) has no fixed
 * list of userIds to write keys for -- there is no per-viewer key to write
 * without tracking every party-pass holder server-side, which nothing does
 * today. That case still relies on the WebSocket-side eviction
 * (`evictChannelViewersLocally` already drops every connected viewer out of
 * the channel view in the same instant) and, for a viewer who is not
 * currently connected but is holding a saved party-pass URL (pasted into an
 * external player, say), the bound is the party pass's own ceiling, same as
 * before this file existed. Documented here rather than silently narrowed.
 */

import { logEvent } from "../lib/log.js";
import { LIVE_HLS_PARTY_PASS_MAX_TTL_MS } from "./hls-viewer-token.js";

const KV_WRITE_TIMEOUT_MS = 4_000;

interface KvConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

/**
 * `HLS_EDGE_KV_ACCOUNT_ID` / `HLS_EDGE_KV_NAMESPACE_ID` / `HLS_EDGE_KV_API_TOKEN`
 * -- see `tools/hls-edge/README.md` "Enabling in production" for where each
 * value comes from. Read live (not cached) since these are set once at
 * process start and reading `process.env` is cheap; nothing here runs on a
 * request hot path.
 */
function kvConfig(): KvConfig | null {
  const accountId = process.env.HLS_EDGE_KV_ACCOUNT_ID;
  const namespaceId = process.env.HLS_EDGE_KV_NAMESPACE_ID;
  const apiToken = process.env.HLS_EDGE_KV_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) {
    return null;
  }
  return { accountId, namespaceId, apiToken };
}

/** The exact key `PartyPassRevocationGate.check` looks up on the Worker side. */
export function hlsEdgeRevocationKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

/** Injectable for tests only; every production caller uses the global `fetch`. */
export type FetchLike = typeof fetch;

/**
 * Writes one KV key. Never throws -- a Cloudflare outage or missing config
 * must not affect the eviction this is attached to. No-ops silently (not
 * even a log line) when unconfigured, which is the expected shape for every
 * deployment that has not provisioned the edge KV namespace -- most of them.
 */
export async function writeHlsEdgeRevocation(
  userId: string,
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const config = kvConfig();
  if (!config) {
    return;
  }
  const key = hlsEdgeRevocationKey(userId, channelId);
  // At least the party pass's own ceiling (see the module doc comment for
  // why this is the CONSTANT ceiling, `LIVE_HLS_PARTY_PASS_MAX_TTL_MS`, and
  // not whatever `LIVE_HLS_PARTY_PASS_TTL_MS` currently says -- a pass
  // minted under a longer-lived setting that was since shortened must not
  // outlive this key the same way `hls-revocation.ts`'s own high-water mark
  // protects against that for its in-memory pruning window).
  const ttlSeconds = Math.ceil(LIVE_HLS_PARTY_PASS_MAX_TTL_MS / 1000);
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(config.namespaceId)}` +
    `/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KV_WRITE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "text/plain",
      },
      body: String(now),
      signal: controller.signal,
    });
    if (!response.ok) {
      logEvent("voice.hlsEdgeRevocationWriteFailed", {
        channelId,
        status: response.status,
      });
    }
  } catch (err) {
    logEvent("voice.hlsEdgeRevocationWriteFailed", {
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Writes one KV entry per user this scope actually names -- see the module
 * doc comment for why an unscoped ("everyone") revocation writes nothing
 * here. Fire-and-forget: `hls-revocation.ts` never awaits this.
 */
export function writeHlsEdgeRevocationForScope(
  channelId: string,
  onlyUserIds: readonly string[] | undefined,
  now = Date.now(),
): void {
  if (!onlyUserIds || onlyUserIds.length === 0) {
    return;
  }
  for (const userId of onlyUserIds) {
    void writeHlsEdgeRevocation(userId, channelId, now);
  }
}
