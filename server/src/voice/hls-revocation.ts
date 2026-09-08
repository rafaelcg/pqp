/**
 * Who may no longer watch a channel's live stream, held in memory.
 *
 * WHY THIS EXISTS. The playlist proxy used to re-ask the database on every
 * single request whether the caller may see the channel. Every viewer
 * refetches the playlist every 2 s, so at 300 viewers that was 150 access
 * checks a second, each of them two queries, drawn from the same connection
 * pool the rest of the app shares. On a properly sized database that is not
 * an outage (200 viewers leaves the pool at zero to one busy connection with
 * 2 to 3 ms queries); it is simply per-viewer cost on a shared resource,
 * growing with the audience, for a question whose answer we already had.
 *
 * The `?t=` token already answers the question. It is signed by us and names
 * the user, the channel and the session, and it is minted only after a real
 * access check (`stampViewerStream`, on the `voice-stream` / `channel-live`
 * frame and on `GET /api/channels/:id/live`), which happens once per viewer
 * per session rather than every two seconds. So the proxy trusts the token,
 * and the only thing left to answer is "has this person's access been taken
 * away SINCE it was minted".
 *
 * That is what this file is: a memory lookup instead of a query. It is
 * written by the same eviction calls that already drop a revoked viewer out
 * of the channel view (`evictChannelViewers`, `evictUserFromChannels` in
 * `ws/chat.ts`), which is deliberate on two counts. Those calls are already
 * made at every seam that matters, a ban, a kick, a channel going private, a
 * role losing VIEW, so there is no separate list of places to keep in step.
 * And they are already replicated to every instance over the existing
 * `chat.evict` bus topic, whose remote handler calls the same local function,
 * so revocation crosses machines without a second topic that could disagree
 * with the first.
 *
 * WORST-CASE WINDOW. A revoked viewer keeps the picture until their player
 * asks for the next playlist, which is one segment, about 2 s, and they were
 * already thrown out of the channel view and the voice room in the same
 * instant. It is seconds, not minutes, and it does not depend on the token's
 * lifetime.
 *
 * A revocation only invalidates tokens minted BEFORE it. Someone banned and
 * then unbanned gets a fresh token, and that one is not caught by the old
 * entry, so a rejoin works without waiting anything out.
 */

import { HLS_VIEWER_TOKEN_TTL_MS } from "./hls-viewer-token.js";

interface Revocation {
  /** When access was taken away. Tokens minted at or after this survive. */
  at: number;
  /** Only these users lost access. */
  only?: Set<string>;
  /** Everyone EXCEPT these users lost access (the "who may still see it" list). */
  except?: Set<string>;
}

/**
 * Nothing older than a token's own lifetime can matter: any token it could
 * still catch has expired on its own by then. So the map is bounded by the
 * number of channels that had an eviction in the last token lifetime.
 */
const byChannel = new Map<string, Revocation[]>();

function prune(channelId: string, now: number): Revocation[] {
  const entries = byChannel.get(channelId);
  if (!entries) {
    return [];
  }
  const kept = entries.filter((entry) => now - entry.at < HLS_VIEWER_TOKEN_TTL_MS);
  if (kept.length === 0) {
    byChannel.delete(channelId);
  } else if (kept.length !== entries.length) {
    byChannel.set(channelId, kept);
  }
  return kept;
}

export interface HlsRevocationScope {
  onlyUserIds?: string[];
  exceptUserIds?: string[];
}

/**
 * Record that access to this channel was taken away. No scope means everyone
 * (a deleted channel, or one that just went private to all).
 */
export function revokeHlsAccess(
  channelId: string,
  scope?: HlsRevocationScope,
  now = Date.now(),
): void {
  const entry: Revocation = { at: now };
  if (scope?.onlyUserIds && scope.onlyUserIds.length > 0) {
    entry.only = new Set(scope.onlyUserIds);
  }
  if (scope?.exceptUserIds) {
    entry.except = new Set(scope.exceptUserIds);
  }
  const entries = prune(channelId, now);
  entries.push(entry);
  byChannel.set(channelId, entries);
}

/** Convenience for the "this user lost these channels" eviction shape. */
export function revokeHlsAccessForUser(
  userId: string,
  channelIds: Iterable<string>,
  now = Date.now(),
): void {
  for (const channelId of channelIds) {
    revokeHlsAccess(channelId, { onlyUserIds: [userId] }, now);
  }
}

/**
 * Was this viewer's access taken away after their token was minted? A memory
 * lookup, which is the whole point: it runs on every playlist request.
 */
export function isHlsAccessRevoked(
  userId: string,
  channelId: string,
  tokenIssuedAt: number,
  now = Date.now(),
): boolean {
  for (const entry of prune(channelId, now)) {
    if (entry.at <= tokenIssuedAt) {
      // Minted after the revocation: this is a fresh grant, not a stale one.
      continue;
    }
    if (entry.only && !entry.only.has(userId)) {
      continue;
    }
    if (entry.except?.has(userId)) {
      // Named as someone who KEEPS access.
      continue;
    }
    return true;
  }
  return false;
}

export function resetHlsRevocationsForTests(): void {
  byChannel.clear();
}
