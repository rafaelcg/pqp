import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adminBlockJamPublisherSchema,
  adminListJamPublicQuerySchema,
  adminRemoveJamPartSchema,
  adminReviewJamSchema,
  adminUnpublishJamSchema,
  createPublicJamSchema,
  hasPermission,
  JAM_PUBLIC_ERRORS,
  JAM_PUBLIC_REASON_MAX,
  Permission,
  publicJamListQuerySchema,
  publishJamSongSchema,
  reportPublicJamSchema,
  setJamPublicConsentSchema,
  updateJamPublicationSchema,
  type JamPublicationResponse,
} from "@pqp/shared";
import { DatabaseUnavailableError, getPool } from "../db.js";
import {
  corsHeaders,
  HttpError,
  readJsonBody,
  SECURITY_HEADERS,
  sendDatabaseUnavailable,
  sendError,
} from "../lib/http.js";
import { jamPublicEnabled } from "../lib/jam-public-config.js";
import { clientAddress, createRateLimiter } from "../lib/rate-limit.js";
import { Created, NoContent } from "../lib/route-results.js";
import type { Router } from "../lib/router.js";
import { getJamSongRow, JAM_NOT_FOUND, type JamSongRow } from "../services/jam.js";
import {
  adminBlockJamPublisher,
  adminJamPublicQueue,
  adminListPublicJams,
  adminRemoveJamPart,
  adminReviewJam,
  adminUnpublishJam,
  createPublicJam,
  getPublication,
  getPublicJam,
  getPublicJamForViewer,
  jamPublicConfigFor,
  jamPublicInboxFor,
  listPublicJams,
  myPublicJams,
  noteJamPublicAddressRefusal,
  pendingJamConsentsFor,
  publishJamSong,
  reportPublicJam,
  requireJamPublicOn,
  setJamPublicConsent,
  setJamPublicLike,
  unpublishJamSong,
  updateJamPublicSettings,
  type JamPublicActor,
} from "../services/jam-public.js";
import { jamPlays, jamPlayViewer } from "../services/jam-public-plays.js";
import { computeMemberPermissions } from "../services/permissions.js";
import { isInstanceModerator } from "../services/reports.js";
import { canAccessChannel } from "../services/users.js";

/**
 * PUBLIC JAMS' ROUTES (packages/shared/src/jam-public.ts has the contract and
 * the table of every route; docs/JAM_PUBLIC.md the operator's side).
 *
 * Three groups:
 *
 *  1. THE PUBLIC ROUTES, `/api/public/jams*`, handled in `handleApi` BEFORE the
 *     Bearer resolution (CLAUDE.md pitfall 8), so a header of any quality
 *     changes nothing about them (pitfall 16). `config` always answers (200
 *     `{ enabled: false }` while off, the `/api/public/communities/config`
 *     pattern). Every other one is NOT MATCHED while `jam_public` is off: it
 *     falls through to the 401 an unknown path gets. Each has its own
 *     address-keyed bucket under `anonLimiter`, which `handleApi` takes first
 *     for every request. Answers are the same for every caller and carry
 *     `Cache-Control: public, max-age` of 60 s (the list), 30 s (a song), so a
 *     shared cache in front bounds how late an unpublish shows.
 *  2. THE AUTHENTICATED ROUTES (`registerJamPublicRoutes`), on the router.
 *  3. THE OPERATOR'S ROUTES: the session half here (an instance moderator),
 *     the machine-token half in `ADMIN_MACHINE_ROUTES` (`api/index.ts`), both
 *     calling the same handlers below.
 */

// ------------------------------------------------------------ public routes

const PREFIX = "/api/public/jams";
const CONFIG_PATH = "/api/public/jams/config";
const SONG_PATH = /^\/api\/public\/jams\/([0-9a-fA-F-]{36})$/;
const PLAY_PATH = /^\/api\/public\/jams\/([0-9a-fA-F-]{36})\/play$/;

const configLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
/** A page of the public site, scrolled: generous. */
const listLimiter = createRateLimiter({ capacity: 60, refillPerSecond: 2 });
/** A song opened, and its media re-read when the URLs age. */
const songLimiter = createRateLimiter({ capacity: 120, refillPerSecond: 4 });
/**
 * A play noted. A person presses play a few times a minute at most; a loop
 * that rotates nothing is refused here, and one that does is deduped per hour
 * by `jam-public-plays.ts` anyway.
 */
const playLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 0.5 });

export function resetJamPublicRateLimits(): void {
  configLimiter.reset();
  listLimiter.reset();
  songLimiter.reset();
  playLimiter.reset();
}

function take(
  limiter: ReturnType<typeof createRateLimiter>,
  kind: "config" | "list" | "song" | "play",
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const key = `jam-public-${kind}:${clientAddress(req as never)}`;
  if (limiter.take(key)) {
    return true;
  }
  noteJamPublicAddressRefusal(kind);
  res.setHeader("Retry-After", String(limiter.retryAfter(key)));
  sendError(res, 429, "Too many requests", req);
  return false;
}

function sendPublic(req: IncomingMessage, res: ServerResponse, body: unknown, maxAge: number): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
    "Cache-Control": `public, max-age=${maxAge}`,
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  res.setHeader("Allow", `${allow}, OPTIONS`);
  sendError(res, 405, "Method not allowed", req);
}

/** Returns true when it answered the request. */
export async function handleJamPublicPublicRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
    return false;
  }
  const reads = req.method === "GET" || req.method === "HEAD";
  if (pathname === CONFIG_PATH) {
    if (!reads) {
      methodNotAllowed(req, res, "GET, HEAD");
      return true;
    }
    if (take(configLimiter, "config", req, res)) {
      sendPublic(req, res, { enabled: jamPublicEnabled() }, 60);
    }
    return true;
  }
  // Not matched at all while the flag is off: the 401 of an unknown path.
  if (!jamPublicEnabled()) {
    return false;
  }
  try {
    if (pathname === PREFIX) {
      if (!reads) {
        methodNotAllowed(req, res, "GET, HEAD");
        return true;
      }
      if (!take(listLimiter, "list", req, res)) {
        return true;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const parsed = publicJamListQuerySchema.safeParse({
        needs: url.searchParams.get("needs") ?? undefined,
        sort: url.searchParams.get("sort") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!parsed.success) {
        sendError(res, 400, "Invalid query", req);
        return true;
      }
      sendPublic(req, res, await listPublicJams(parsed.data), 60);
      return true;
    }
    const play = PLAY_PATH.exec(pathname);
    if (play) {
      if (req.method !== "POST") {
        methodNotAllowed(req, res, "POST");
        return true;
      }
      if (!take(playLimiter, "play", req, res)) {
        return true;
      }
      jamPlays.note(play[1]!, jamPlayViewer("address", clientAddress(req as never)));
      res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders(req) });
      res.end();
      return true;
    }
    const song = SONG_PATH.exec(pathname);
    if (song) {
      if (!reads) {
        methodNotAllowed(req, res, "GET, HEAD");
        return true;
      }
      if (!take(songLimiter, "song", req, res)) {
        return true;
      }
      const detail = await getPublicJam(song[1]!.toLowerCase());
      if (!detail) {
        sendError(res, 404, "Not found", req);
        return true;
      }
      sendPublic(req, res, detail, 30);
      return true;
    }
    // Anything else under the prefix is not a route.
    sendError(res, 404, "Not found", req);
    return true;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      sendDatabaseUnavailable(res, req);
      return true;
    }
    console.error("[jam-public] public route failed:", error);
    sendError(res, 503, "Temporarily unavailable", req);
    return true;
  }
}

// ----------------------------------------------------- authenticated routes

/**
 * The song a publication route names, for its starter, a participant, or a
 * moderator of its channel. Answers 404 for anybody who cannot see the song
 * through its channel and did not start it, which is the private routes' one
 * answer (`jam-routes.ts`).
 */
/**
 * What a caller who is neither the starter nor a member of the song's channel
 * (somebody whose take is in it through public access) may see of a
 * publication: their own parts, never the names of the channel's people.
 */
function forCaller(
  publication: JamPublicationResponse["publication"],
  place: { isStarter: boolean; member: boolean },
  userId: string,
): JamPublicationResponse {
  if (!publication || place.isStarter || place.member) {
    return { publication };
  }
  return {
    publication: { ...publication, parts: publication.parts.filter((part) => part.authorId === userId) },
  };
}

async function songForPublication(
  songId: string,
  userId: string,
): Promise<{ song: JamSongRow; isStarter: boolean; isModerator: boolean; member: boolean }> {
  const song = await getJamSongRow(songId);
  if (!song) {
    throw new HttpError(404, JAM_NOT_FOUND);
  }
  const isStarter = song.author_id !== null && song.author_id === userId;
  let member = false;
  let isModerator = false;
  if (song.channel_id && song.server_id && (await canAccessChannel(song.channel_id, userId))) {
    member = true;
    const perms = await computeMemberPermissions(song.server_id, userId, song.channel_id);
    isModerator =
      hasPermission(perms, Permission.MANAGE_MESSAGES) || hasPermission(perms, Permission.MANAGE_CHANNELS);
  }
  if (!isStarter && !member) {
    // A standalone song's participant (a part of theirs in it) may read and
    // answer for it too.
    const part = await getPool().query(
      `SELECT 1 FROM jam_tracks WHERE song_id = $1 AND author_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [song.id, userId],
    );
    if ((part.rowCount ?? 0) === 0) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
  }
  return { song, isStarter, isModerator, member };
}

export function registerJamPublicRoutes(router: Router): void {
  router.get("/api/jam-public/config", async ({ user }) => jamPublicConfigFor(user.id));

  // A standalone public jam. 201, or 200 for a nonce retry.
  router.post("/api/jam-public/songs", async ({ req, user }) => {
    requireJamPublicOn();
    const request = createPublicJamSchema.parse(await readJsonBody(req));
    const result = await createPublicJam({ userId: user.id, request });
    const body = { song: result.song, publication: result.publication };
    return result.created ? new Created(body) : body;
  });

  router.get("/api/jam-public/songs/:songId", async ({ user }, { songId }) => {
    if (!jamPublicEnabled()) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    const song = await getPublicJamForViewer(songId!, user.id);
    if (!song) {
      throw new HttpError(404, JAM_NOT_FOUND);
    }
    return song;
  });

  router.put("/api/jam-public/songs/:songId/like", async ({ user }, { songId }) =>
    setJamPublicLike(songId!, user.id, true),
  );
  // Taking a like back works with the flag off: it is the person's own.
  router.delete("/api/jam-public/songs/:songId/like", async ({ user }, { songId }) =>
    setJamPublicLike(songId!, user.id, false),
  );

  router.post("/api/jam-public/songs/:songId/play", async ({ user }, { songId }) => {
    if (jamPublicEnabled()) {
      jamPlays.note(songId!, jamPlayViewer("account", user.id));
    }
    return new NoContent();
  });

  router.post("/api/jam-public/reports", async ({ req, user }) => {
    const request = reportPublicJamSchema.parse(await readJsonBody(req));
    const result = await reportPublicJam({ reporterId: user.id, request });
    return result.duplicate ? result : new Created(result);
  });

  router.get("/api/jam-public/consents", async ({ user }) => ({
    pending: await pendingJamConsentsFor(user.id),
  }));

  router.get("/api/jam-public/inbox", async ({ user }) => ({
    takes: await jamPublicInboxFor(user.id),
  }));

  router.get("/api/jam-public/mine", async ({ user }) => ({
    songs: await myPublicJams(user.id),
  }));

  // ---- a song's publication

  router.get("/api/jam-songs/:songId/public", async ({ user }, { songId }) => {
    const place = await songForPublication(songId!, user.id);
    return forCaller(await getPublication(place.song.id), place, user.id);
  });

  router.put("/api/jam-songs/:songId/public", async ({ req, user }, { songId }) => {
    const { song, isStarter } = await songForPublication(songId!, user.id);
    requireJamPublicOn();
    if (!isStarter) {
      throw new HttpError(403, JAM_PUBLIC_ERRORS.notStarter);
    }
    const body = publishJamSongSchema.parse(await readJsonBody(req));
    const publication = await publishJamSong({ song, userId: user.id, showOrigin: body.showOrigin });
    return { publication } satisfies JamPublicationResponse;
  });

  router.patch("/api/jam-songs/:songId/public", async ({ req, user }, { songId }) => {
    const { song, isStarter } = await songForPublication(songId!, user.id);
    requireJamPublicOn();
    if (!isStarter) {
      throw new HttpError(403, JAM_PUBLIC_ERRORS.notStarter);
    }
    const body = updateJamPublicationSchema.parse(await readJsonBody(req));
    return {
      publication: await updateJamPublicSettings({
        song,
        userId: user.id,
        showOrigin: body.showOrigin,
        autoAcceptOutside: body.autoAcceptOutside,
      }),
    } satisfies JamPublicationResponse;
  });

  // Unpublish: the starter, or a moderator of the origin channel (with an
  // optional `?reason=` the starter is shown). Works with the flag off.
  router.delete("/api/jam-songs/:songId/public", async ({ url, user }, { songId }) => {
    const { song, isStarter, isModerator } = await songForPublication(songId!, user.id);
    if (!isStarter && !isModerator) {
      throw new HttpError(403, JAM_PUBLIC_ERRORS.notStarter);
    }
    const reason = url.searchParams.get("reason")?.trim().slice(0, JAM_PUBLIC_REASON_MAX) || null;
    const actor: JamPublicActor = isStarter
      ? { kind: "starter", userId: user.id }
      : { kind: "moderator", userId: user.id };
    return {
      publication: await unpublishJamSong({ song, actor, reason: isStarter ? null : reason }),
    } satisfies JamPublicationResponse;
  });

  // My answer for all my parts in a song. `no` works with the flag off.
  router.put("/api/jam-songs/:songId/public-consent", async ({ req, user }, { songId }) => {
    const place = await songForPublication(songId!, user.id);
    const body = setJamPublicConsentSchema.parse(await readJsonBody(req));
    return forCaller(
      await setJamPublicConsent({ song: place.song, userId: user.id, choice: body.choice }),
      place,
      user.id,
    );
  });

  // ---- the operator's session half (the machine-token half is in index.ts)

  const gate = (user: Parameters<typeof isInstanceModerator>[0]) => {
    if (!isInstanceModerator(user)) {
      throw new HttpError(404, "Not found");
    }
  };
  router.get(ADMIN_JAM_PUBLIC_SONGS_PATH, async ({ url, user }) => {
    gate(user);
    return adminJamPublicSongs(url.searchParams);
  });
  router.get(ADMIN_JAM_PUBLIC_QUEUE_PATH, async ({ user }) => {
    gate(user);
    return adminJamPublicQueue();
  });
  router.put(ADMIN_JAM_PUBLIC_UNPUBLISH_PATH, async ({ req, user }) => {
    gate(user);
    return adminJamPublicUnpublish(req, { kind: "operator", userId: user.id });
  });
  router.put(ADMIN_JAM_PUBLIC_REVIEW_PATH, async ({ req, user }) => {
    gate(user);
    return adminJamPublicReview(req, { kind: "operator", userId: user.id });
  });
  router.put(ADMIN_JAM_PUBLIC_REMOVE_PART_PATH, async ({ req, user }) => {
    gate(user);
    return adminJamPublicRemovePart(req, { kind: "operator", userId: user.id });
  });
  router.put(ADMIN_JAM_PUBLIC_BLOCK_PATH, async ({ req, user }) => {
    gate(user);
    return adminJamPublicBlock(req, { kind: "operator", userId: user.id });
  });
}

// ------------------------------------------------------------ operator

export const ADMIN_JAM_PUBLIC_SONGS_PATH = "/api/admin/jam-public/songs";
export const ADMIN_JAM_PUBLIC_QUEUE_PATH = "/api/admin/jam-public/queue";
export const ADMIN_JAM_PUBLIC_UNPUBLISH_PATH = "/api/admin/jam-public/unpublish";
export const ADMIN_JAM_PUBLIC_REVIEW_PATH = "/api/admin/jam-public/review";
export const ADMIN_JAM_PUBLIC_REMOVE_PART_PATH = "/api/admin/jam-public/remove-part";
export const ADMIN_JAM_PUBLIC_BLOCK_PATH = "/api/admin/jam-public/block";

export async function adminJamPublicSongs(query: URLSearchParams) {
  const parsed = adminListJamPublicQuerySchema.parse({
    status: query.get("status") ?? undefined,
    cursor: query.get("cursor") ?? undefined,
  });
  return adminListPublicJams(parsed);
}

export async function adminJamPublicUnpublish(req: IncomingMessage, actor: JamPublicActor) {
  return adminUnpublishJam(adminUnpublishJamSchema.parse(await readJsonBody(req)), actor);
}

export async function adminJamPublicReview(req: IncomingMessage, actor: JamPublicActor) {
  return adminReviewJam(adminReviewJamSchema.parse(await readJsonBody(req)), actor);
}

export async function adminJamPublicRemovePart(req: IncomingMessage, actor: JamPublicActor) {
  return adminRemoveJamPart(adminRemoveJamPartSchema.parse(await readJsonBody(req)), actor);
}

export async function adminJamPublicBlock(req: IncomingMessage, actor: JamPublicActor) {
  return adminBlockJamPublisher(adminBlockJamPublisherSchema.parse(await readJsonBody(req)), actor);
}

export { adminJamPublicQueue };
