import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import {
  hlsObjectPrefix,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  rawPlaylistUrl,
} from "./hls-egress.js";

const REQUEST_TIMEOUT_MS = 10_000;

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
 * route this backs (`GET /api/voice/hls-playlist/:channelId`) is Bearer-authed
 * like every other route (CLAUDE.md pitfall #8), so the same `hls-playlist`
 * URL itself needs no query signature -- only the objects it points at do.
 *
 * `startedAt` names the exact session (it is the same value `hls-egress.ts`
 * put in the URL it handed the viewer), rather than "whatever is live right
 * now" -- so a stale link from a session that already ended still 404s
 * cleanly instead of silently serving a different session's stream.
 */
export async function buildSignedPlaylist(
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
  const playlistUrl = rawPlaylistUrl(channelId, startedAt);

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
