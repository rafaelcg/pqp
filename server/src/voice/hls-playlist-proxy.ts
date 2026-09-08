import { getPool } from "../db.js";
import { signRequest } from "../lib/s3.js";
import { verifyHlsViewerToken } from "./hls-viewer-token.js";
import {
  hlsObjectPrefix,
  hlsUrlTtlSeconds,
  liveHlsStorageConfig,
  internalPlaylistUrl,
  sessionPrefixPattern,
} from "./hls-egress.js";
import {
  buildMasterPlaylist,
  LADDER_RUNGS,
  type MasterVariant,
} from "./hls-ladder.js";
import { HLS_VIEWER_TOKEN_PARAM } from "./hls-viewer-token.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Who is asking for the playlist. The Bearer user wins when the router
 * already resolved one; otherwise the per-viewer query token
 * (`hls-viewer-token.ts`, Safari's native player and iOS carry no header)
 * must verify for exactly this channel and session. Null is a 401: the
 * caller still runs the channel-access check on whichever user comes back,
 * so a token never grants more than the header would.
 */
export function resolveHlsPlaylistViewer(input: {
  bearerUserId: string | null | undefined;
  token: string | null | undefined;
  channelId: string;
  startedAt: number;
  now?: number;
}): { userId: string } | null {
  if (input.bearerUserId) {
    return { userId: input.bearerUserId };
  }
  return verifyHlsViewerToken(
    input.token,
    { channelId: input.channelId, startedAt: input.startedAt },
    input.now,
  );
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
  rung?: string,
): Promise<string> {
  const config = liveHlsStorageConfig();
  if (!config) {
    throw new HlsPlaylistUnavailable("Live HLS storage is not configured");
  }

  const objectPrefix = hlsObjectPrefix(channelId, startedAt, rung);
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
  const playlistUrl = internalPlaylistUrl(channelId, startedAt, rung);

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

/**
 * The rungs one session is serving right now, lowest bitrate first, read
 * from the rows the egress writer recorded. The database rather than the
 * in-process room map on purpose: a request that lands while the room is
 * being reconciled still answers, and the same rule already governs the
 * media playlists this master points at.
 *
 * A row whose `rung` names nothing this build knows (an operator downgraded
 * mid-stream) is dropped rather than guessed at: the master lists what it
 * can describe truthfully, and a viewer plays the rest.
 */
async function sessionRungs(
  channelId: string,
  startedAt: number,
): Promise<string[]> {
  const rows = await getPool().query<{ rung: string | null }>(
    `SELECT rung FROM hls_sessions
     WHERE channel_id = $1
       AND object_prefix LIKE $2
       AND rung IS NOT NULL
       AND cleaned_at IS NULL
     ORDER BY started_at ASC`,
    [channelId, sessionPrefixPattern(channelId, startedAt)],
  );
  return rows.rows
    .map((row) => row.rung)
    .filter((rung): rung is string => Boolean(rung && LADDER_RUNGS[rung]));
}

/**
 * The master playlist a viewer is handed: one variant per rendition that
 * actually started, so hls.js and native players pick per viewer and switch
 * as the link changes.
 *
 * VARIANT URIs ARE ROOT-RELATIVE AND CARRY THE VIEWER'S OWN TOKEN. Both
 * halves matter. Relative resolution against the master's URL drops the
 * MASTER's query string but keeps the variant's own, which is the only way a
 * header-less player (Safari's native HLS, iOS) can authorise the second
 * request; and staying on this API's own origin is what makes hls.js attach
 * the Bearer header through `isOwnHlsPlaylistProxyUrl`. An absolute bucket
 * URL here would do neither.
 *
 * A session with no rung rows at all is a pre-ladder session: its single
 * media playlist is served directly, so an in-flight viewer from before this
 * deploy is not handed a master listing nothing.
 */
export async function buildMasterPlaylistFor(input: {
  channelId: string;
  startedAt: number;
  /** The `?t=` the request arrived with, stamped onto each variant. */
  token?: string | null;
}): Promise<string | null> {
  const rungs = await sessionRungs(input.channelId, input.startedAt);
  if (rungs.length === 0) {
    return null;
  }
  const query = input.token
    ? `?${HLS_VIEWER_TOKEN_PARAM}=${encodeURIComponent(input.token)}`
    : "";
  const variants: MasterVariant[] = rungs.map((rung) => ({
    rung: LADDER_RUNGS[rung]!,
    uri:
      `/api/voice/hls-playlist/${encodeURIComponent(input.channelId)}` +
      `/${input.startedAt}/${encodeURIComponent(rung)}${query}`,
  }));
  return buildMasterPlaylist(variants);
}
