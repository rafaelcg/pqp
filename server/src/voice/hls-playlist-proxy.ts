import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import { verifyHlsViewerToken } from "./hls-viewer-token.js";
import {
  hlsObjectPrefix,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  internalPlaylistUrl,
} from "./hls-egress.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long one session's rendered playlist is reused.
 *
 * WHY THIS EXISTS. Every viewer refetches the playlist every 2 s, and each
 * refetch used to cost this API a fresh render: a Postgres lookup, an
 * upstream HTTPS GET of the source playlist from R2, and a SigV4 signature
 * per segment line. That is per viewer, so the audience cost scaled on OUR
 * box rather than on the bucket, which is the opposite of the reason watch
 * mode uses HLS at all. Measured locally on a 30-segment playlist, one render
 * is 2.3 ms of CPU, so 300 viewers (150 req/s) is about a third of a core
 * spent re-deriving a body that is identical for all of them.
 *
 * It is safe to share one body between viewers because the body IS shared:
 * `buildSignedPlaylist` takes no viewer, and the segment URLs it writes are
 * signed with the BUCKET's credentials (`signRequest`), not with anything
 * belonging to the person asking. Two viewers of the same session receive
 * byte-identical playlists.
 *
 * What is NOT cached is permission. `requireChannelAccess` runs in the route
 * on every single request, before this is ever consulted, so a viewer who
 * may not see the channel gets a 401 and never reaches a cached body. The
 * key is the session (channel + startedAt) and nothing else, so it cannot be
 * poisoned by who asked.
 *
 * One second rather than two: a viewer must never be handed a window that is
 * already a full segment stale, or the player sits on the live edge waiting
 * for a segment the playlist has not admitted exists yet.
 */
export const HLS_PLAYLIST_CACHE_TTL_MS = 1_000;

interface CachedPlaylist {
  /** Resolved body, once the render finished. */
  body?: string;
  /** The in-flight render, so concurrent viewers coalesce into one fetch. */
  inflight?: Promise<string>;
  /** When `body` was produced. */
  at: number;
}

const playlistCache = new Map<string, CachedPlaylist>();

/** Session identity, and deliberately nothing about the viewer. */
function cacheKey(channelId: string, startedAt: number): string {
  return `${channelId}/${startedAt}`;
}

export function resetHlsPlaylistCacheForTests(): void {
  playlistCache.clear();
}

/**
 * Who is asking for the playlist, and whether they proved it with something
 * that already carries a permission decision.
 *
 * THE TOKEN IS PREFERRED OVER THE HEADER, which is the opposite of what this
 * did before and is the whole performance fix. A valid `?t=` is signed by us
 * and names this exact user, channel and session, and it was minted only
 * after a real access check. So it IS the capability: the caller may serve it
 * without asking the database anything. The Bearer header proves identity but
 * not access, so a header-only caller still pays for the check.
 *
 * hls.js sends both, so preferring the token is what takes the common case
 * off the database entirely. Null is a 401.
 */
export function resolveHlsPlaylistViewer(input: {
  bearerUserId: string | null | undefined;
  token: string | null | undefined;
  channelId: string;
  startedAt: number;
  now?: number;
}): { userId: string; issuedAt: number | null } | null {
  const fromToken = verifyHlsViewerToken(
    input.token,
    { channelId: input.channelId, startedAt: input.startedAt },
    input.now,
  );
  // A token that verifies but names somebody else than the authenticated
  // caller is not this caller's capability. Fall back to the header.
  if (
    fromToken &&
    (!input.bearerUserId || fromToken.userId === input.bearerUserId)
  ) {
    return fromToken;
  }
  if (input.bearerUserId) {
    return { userId: input.bearerUserId, issuedAt: null };
  }
  return null;
}

/** Playlist proxy could not find a live session for this channel. */
export class HlsPlaylistNotFound extends Error {}

/** Storage is not configured, so there is nothing to fetch or sign. */
export class HlsPlaylistUnavailable extends Error {}

/**
 * The signed alternative to handing a viewer the raw public bucket URL.
 *
 * hls.js (and Safari's native player) resolve a playlist's segment lines
 * relative to the playlist's own URL, and relative resolution drops the base
 * URL's query string -- so presigning only the playlist would leave every
 * segment request unsigned and, once the bucket is not public, a 403. This
 * fetches the live playlist through an internal signed GET (the bucket can
 * be fully private), then rewrites every segment/media line into its own
 * absolute presigned URL before handing the rewritten playlist back. The
 * route this backs (`GET /api/voice/hls-playlist/:channelId/:startedAt`) is
 * Bearer-authed like every other route (CLAUDE.md pitfall #8), or carries the
 * per-viewer `?t=` token for players that cannot send a header (see
 * `resolveHlsPlaylistViewer` above); only the objects it points at need a
 * signature of their own.
 *
 * `startedAt` names the exact session (it is the same value `hls-egress.ts`
 * put in the URL it handed the viewer), rather than "whatever is live right
 * now" -- so a stale link from a session that already ended still 404s
 * cleanly instead of silently serving a different session's stream.
 */
export async function buildSignedPlaylist(
  channelId: string,
  startedAt: number,
  now = Date.now(),
): Promise<string> {
  const key = cacheKey(channelId, startedAt);
  const cached = playlistCache.get(key);
  if (cached) {
    if (cached.body !== undefined && now - cached.at < HLS_PLAYLIST_CACHE_TTL_MS) {
      return cached.body;
    }
    if (cached.inflight) {
      // Someone else is already doing the expensive part. Wait for theirs
      // rather than starting a second identical fetch: a room joining at
      // once is exactly when this matters most.
      return cached.inflight;
    }
  }
  const inflight = renderSignedPlaylist(channelId, startedAt)
    .then((body) => {
      // Stamped with the caller's clock, not a fresh read, so a test (and a
      // slow render) measure the TTL from the same instant the caller did.
      playlistCache.set(key, { body, at: now });
      return body;
    })
    .catch((error: unknown) => {
      // A failed render is not cached: the next viewer should retry rather
      // than inherit a 404 from a session that was mid-cleanup.
      playlistCache.delete(key);
      throw error;
    });
  playlistCache.set(key, { ...cached, inflight, at: cached?.at ?? 0 });
  return inflight;
}

async function renderSignedPlaylist(
  channelId: string,
  startedAt: number,
): Promise<string> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }

  const objectPrefix = hlsObjectPrefix(channelId, startedAt);
  const session = await getPool().query(
    `SELECT 1 FROM hls_sessions
     WHERE channel_id = $1 AND object_prefix = $2 AND cleaned_at IS NULL`,
    [channelId, objectPrefix],
  );
  if (session.rowCount === 0) {
    throw new HlsPlaylistNotFound(
      `No live HLS session ${objectPrefix} for channel ${channelId}`,
    );
  }
  // A presigned endpoint-form GET: the bucket can be fully private and no
  // public base is needed (production runs that way).
  const playlistUrl = internalPlaylistUrl(channelId, startedAt);

  let response: Response;
  try {
    response = await fetch(playlistUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HlsPlaylistUnavailable(
      error instanceof Error ? error.message : "Storage unreachable",
    );
  }
  if (!response.ok) {
    throw new HlsPlaylistUnavailable(
      `Storage returned HTTP ${response.status} for the playlist`,
    );
  }
  const body = await response.text();
  const ttl = hlsUrlTtlSeconds();
  const prefixDir = `${objectPrefix.split("/").slice(0, -1).join("/")}/`;

  const rewritten = body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        return line;
      }
      // Segment/media lines in this playlist are always a bare filename in
      // the same "directory" as the playlist itself (LiveKit's
      // `filenamePrefix` is a file prefix, not a real directory, but every
      // sibling object it writes shares the playlist's own prefix path).
      const key = trimmed.includes("/") ? trimmed : `${prefixDir}${trimmed}`;
      return signRequest({
        method: "GET",
        key,
        ttlSeconds: ttl,
        forRead: true,
        config,
      }).url;
    })
    .join("\n");

  return rewritten;
}
