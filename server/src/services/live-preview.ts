import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  computePermissions,
  hasPermission,
  LIVE_PREVIEW_DEFAULT_SECONDS,
  parsePermissions,
  Permission,
  type LivePreviewChannel,
  type LivePreviewStartResponse,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { liveHlsStreamFor, liveHlsStreamFromDb } from "../voice/hls-egress.js";
import { stampPreviewStream } from "../voice/hls-viewer-token.js";
import { isCommunitiesEnabled } from "./communities.js";

/**
 * THE SIGNED-OUT LIVE PREVIEW ("prévia ao vivo").
 *
 * Somebody with no account opens a community's link while a watch party is
 * live. They confirm their age, watch the film in the browser for a few
 * minutes, and are then asked to sign up. Everything here answers one question
 * in several places: may a person with no account see this channel's stream
 * right now, and for how much longer.
 *
 * WHO MAY BE SHOWN WHAT. All of these, every time, or nothing:
 *
 *  - `COMMUNITIES_ENABLED` is on for the deployment, and `live_preview` is on
 *    for the server (a per-server runtime flag, default off).
 *  - The server is a community (`is_community`) and is not suspended.
 *  - The channel is a server channel of type `watch_party`, not private, and
 *    the server's @everyone role can VIEW it after the channel's @everyone
 *    overwrite. A signed-out visitor gets at most what a fresh member gets.
 *  - A live HLS session is open on it. A screen share in an ordinary voice
 *    channel has no HLS transcode (the room gate in `docs/WATCH_PARTY.md`), so
 *    there is nothing to preview there without starting an egress for a
 *    stranger, which this deliberately does not do.
 *
 * WHAT THEY GET. The film's playlist through the existing proxy, stamped with
 * a viewer token of purpose `"preview"` (`hls-viewer-token.ts`) whose expiry
 * is the end of their window. No seat, no voice room, no LiveKit grant, no
 * socket, no chat, no camera, no presenter identity, and no party pass.
 *
 * THE WINDOW, AND WHY IT IS NOT KEYED ON AN ADDRESS. Brazilian phones sit
 * behind carrier NAT, and without `TRUST_PROXY` every caller can look like one
 * address, so "five minutes per IP" would hand one visitor's window to a whole
 * carrier. The window is a signed ticket instead: a random visitor id, the
 * channel, and the instant the window started, HMACed by this server and kept
 * in the visitor's own storage. Every mint reads the start from the ticket, so
 * the window keeps running across reloads, sessions restarting and both API
 * machines, with no server state at all. The capability minted from it expires
 * at the end of the window and cannot be renewed past it.
 *
 * WHAT THAT DOES NOT STOP. Clearing site data, or a private window, gets a new
 * ticket and so a new window. Issuing a fresh ticket is rate limited per
 * address (the route's own bucket, under the anon backstop), which bounds how
 * fast that can be repeated. The preview is a nudge towards an account, which
 * is free; the hard limits are the ones above, and they hold for everybody.
 *
 * NOTHING PERSONAL IS STORED. The visitor's date of birth never leaves their
 * device (the client checks it against `MINIMUM_AGE_YEARS` with the shared
 * `isAtLeastYearsOld`); this side only refuses a request that does not say
 * the check passed. No address, ticket or token is written to a log or a row.
 */

// ---------------------------------------------------------------- settings

/** Bounds for `LIVE_PREVIEW_SECONDS`: long enough to see something, short enough to stay a preview. */
const MIN_PREVIEW_SECONDS = 30;
const MAX_PREVIEW_SECONDS = 60 * 60;

/**
 * The window per visitor per channel. `LIVE_PREVIEW_SECONDS`, read per call so
 * an operator can move it without a restart; out of range or unset is the
 * default. Not a runtime flag: `docs/FEATURE_FLAGS.md` keeps numbers in the
 * environment.
 */
export function livePreviewSeconds(): number {
  const raw = Number(process.env.LIVE_PREVIEW_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return LIVE_PREVIEW_DEFAULT_SECONDS;
  }
  return Math.min(Math.max(Math.floor(raw), MIN_PREVIEW_SECONDS), MAX_PREVIEW_SECONDS);
}

/**
 * How long after a window ends the same ticket keeps being refused, rather
 * than traded for a fresh window. `LIVE_PREVIEW_RESET_HOURS`, default 24.
 */
export function livePreviewResetMs(): number {
  const raw = Number(process.env.LIVE_PREVIEW_RESET_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return Math.floor(hours * 60 * 60 * 1000);
}

/**
 * Could the flag be on for ANY server? With it off globally and no server
 * overridden on, the public routes are not even matched, so they fall through
 * to the same 401 an unknown path gets today: flag off is byte for byte the
 * old behaviour, routes included.
 */
export function livePreviewMaybeOn(): boolean {
  if (!isCommunitiesEnabled()) {
    return false;
  }
  if (isEnabled("live_preview")) {
    return true;
  }
  for (const on of flagServerOverrides("live_preview").values()) {
    if (on) {
      return true;
    }
  }
  return false;
}

/** The flag for one server, with the deployment-wide communities switch above it. */
export function livePreviewOnFor(serverId: string): boolean {
  return isCommunitiesEnabled() && isEnabled("live_preview", { serverId });
}

// ---------------------------------------------------------------- metrics

export type LivePreviewRefusal =
  | "not-found"
  | "flag-off"
  | "not-community"
  | "suspended"
  | "not-watch-party"
  | "private-channel"
  | "not-live"
  | "unsigned"
  | "window-used"
  | "rate-limited"
  | "unavailable";

const counters = {
  /** A fresh ticket: somebody's window started. */
  started: 0,
  /** A ticket that was still inside its window: a reload, a new session. */
  resumed: 0,
  /** A ticket past its window: the visitor was sent to sign up. */
  ended: 0,
  refused: {} as Record<string, number>,
  /** Playlist answers served to a preview token. */
  playlistServed: 0,
  /** Preview tokens refused at the proxy because the channel stopped qualifying. */
  playlistRefused: {} as Record<string, number>,
};

/** For `GET /api/admin/metrics` -> `livePreview`. Per process, since boot. */
export function livePreviewMetrics(): {
  seconds: number;
  started: number;
  resumed: number;
  ended: number;
  refused: Record<string, number>;
  playlistServed: number;
  playlistRefused: Record<string, number>;
} {
  return {
    seconds: livePreviewSeconds(),
    started: counters.started,
    resumed: counters.resumed,
    ended: counters.ended,
    refused: { ...counters.refused },
    playlistServed: counters.playlistServed,
    playlistRefused: { ...counters.playlistRefused },
  };
}

export function resetLivePreviewForTests(): void {
  counters.started = 0;
  counters.resumed = 0;
  counters.ended = 0;
  counters.refused = {};
  counters.playlistServed = 0;
  counters.playlistRefused = {};
  eligibilityCache.clear();
  refusalLog.clear();
}

/**
 * A REFUSAL SAYS WHY (pitfall 16): one line per channel per reason per 30 s,
 * with a count of what was suppressed. Never the ticket, the token or the
 * address.
 */
const REFUSAL_LOG_WINDOW_MS = 30_000;
const REFUSAL_LOG_MAX = 1_000;
const refusalLog = new Map<string, { at: number; suppressed: number }>();

function noteRefusal(
  where: "start" | "playlist",
  channelId: string,
  reason: LivePreviewRefusal,
): void {
  const bucket = where === "start" ? counters.refused : counters.playlistRefused;
  bucket[reason] = (bucket[reason] ?? 0) + 1;
  const key = `${where}:${channelId}:${reason}`;
  const now = Date.now();
  const seen = refusalLog.get(key);
  if (seen && now - seen.at < REFUSAL_LOG_WINDOW_MS) {
    seen.suppressed += 1;
    return;
  }
  if (!seen && refusalLog.size >= REFUSAL_LOG_MAX) {
    const oldest = refusalLog.keys().next().value;
    if (oldest !== undefined) {
      refusalLog.delete(oldest);
    }
  }
  logEvent("livePreview.refused", {
    where,
    channelId,
    reason,
    suppressed: seen?.suppressed ?? 0,
  });
  refusalLog.set(key, { at: now, suppressed: 0 });
}

export function noteLivePreviewPlaylistServed(): void {
  counters.playlistServed += 1;
}

// ------------------------------------------------------------- eligibility

interface ChannelFacts {
  channelId: string;
  serverId: string;
  name: string;
  type: string;
  kind: string;
  isPrivate: boolean;
  isCommunity: boolean;
  suspended: boolean;
  everyoneCanView: boolean;
}

/**
 * Whether @everyone may VIEW each of `channelIds` in `serverId`, through the
 * same `computePermissions` every member check uses: the @everyone role's bits
 * and the channel's @everyone overwrite, with no other role and no member
 * overwrite. A channel with no @everyone role row (should not exist) is false.
 */
async function everyoneCanView(
  serverId: string,
  channelIds: string[],
): Promise<Map<string, boolean>> {
  const answer = new Map<string, boolean>();
  if (channelIds.length === 0) {
    return answer;
  }
  const pool = getPool();
  const role = await pool.query<{ id: string; permissions: string }>(
    `SELECT id, permissions::text AS permissions
       FROM roles
      WHERE server_id = $1 AND is_everyone
      LIMIT 1`,
    [serverId],
  );
  const everyone = role.rows[0];
  if (!everyone) {
    for (const id of channelIds) {
      answer.set(id, false);
    }
    return answer;
  }
  const overwrites = await pool.query<{ channel_id: string; allow: string; deny: string }>(
    `SELECT channel_id, allow::text AS allow, deny::text AS deny
       FROM channel_overwrites
      WHERE channel_id = ANY($1::uuid[])
        AND target_type = 'role'
        AND target_id = $2`,
    [channelIds, everyone.id],
  );
  const byChannel = new Map(overwrites.rows.map((row) => [row.channel_id, row]));
  for (const id of channelIds) {
    const overwrite = byChannel.get(id);
    const perms = computePermissions({
      isOwner: false,
      everyonePermissions: parsePermissions(everyone.permissions),
      rolePermissions: [],
      everyoneOverwrite: overwrite
        ? { allow: parsePermissions(overwrite.allow), deny: parsePermissions(overwrite.deny) }
        : null,
      roleOverwrites: [],
    });
    answer.set(id, hasPermission(perms, Permission.VIEW_CHANNEL));
  }
  return answer;
}

async function loadChannelFacts(channelId: string): Promise<ChannelFacts | null> {
  const result = await getPool().query<{
    id: string;
    name: string;
    server_id: string | null;
    type: string;
    kind: string;
    is_private: boolean;
    is_community: boolean | null;
    is_community_suspended: boolean | null;
  }>(
    `SELECT c.id, c.name, c.server_id, c.type, c.kind, c.is_private,
            s.is_community, s.is_community_suspended
       FROM channels c
       LEFT JOIN servers s ON s.id = c.server_id
      WHERE c.id = $1`,
    [channelId],
  );
  const row = result.rows[0];
  if (!row || !row.server_id) {
    return null;
  }
  const view = await everyoneCanView(row.server_id, [row.id]);
  return {
    channelId: row.id,
    serverId: row.server_id,
    name: row.name,
    type: row.type,
    kind: row.kind,
    isPrivate: row.is_private,
    isCommunity: row.is_community === true,
    suspended: row.is_community_suspended === true,
    everyoneCanView: view.get(row.id) === true,
  };
}

/**
 * The verdict on facts already read. The flag is asked here, on every call,
 * so a cached fact never outlives an operator switching the flag off: a flip
 * reaches the next playlist request, not the next cache expiry.
 */
function judge(facts: ChannelFacts | null): LivePreviewRefusal | null {
  if (!facts || facts.kind !== "server") {
    return "not-found";
  }
  if (!livePreviewOnFor(facts.serverId)) {
    return "flag-off";
  }
  if (!facts.isCommunity) {
    return "not-community";
  }
  if (facts.suspended) {
    return "suspended";
  }
  if (facts.type !== "watch_party") {
    return "not-watch-party";
  }
  if (facts.isPrivate || !facts.everyoneCanView) {
    return "private-channel";
  }
  return null;
}

export type LivePreviewEligibility =
  | { ok: true; serverId: string; channel: LivePreviewChannel }
  | { ok: false; reason: LivePreviewRefusal };

/** A fresh read, for the start route. */
export async function livePreviewEligibility(
  channelId: string,
): Promise<LivePreviewEligibility> {
  const facts = await loadChannelFacts(channelId);
  const reason = judge(facts);
  if (reason || !facts) {
    return { ok: false, reason: reason ?? "not-found" };
  }
  return {
    ok: true,
    serverId: facts.serverId,
    channel: { id: facts.channelId, name: facts.name },
  };
}

/**
 * The same verdict for the playlist proxy's session URL (the master playlist,
 * once per player; renditions are deliberately not re-checked, see the
 * preview branch of `tryHlsCapabilityDoor`). A reconnect herd can still bring
 * many at once, so the FACTS are cached per channel for `ELIGIBILITY_TTL_MS`;
 * the flag is judged live on every request. A read that fails falls back to the
 * last facts it had (a database blip must not cut a preview off any more than
 * it cuts off a member), and with none at all it refuses.
 */
const ELIGIBILITY_TTL_MS = 15_000;
const ELIGIBILITY_CACHE_MAX = 2_000;
const eligibilityCache = new Map<string, { at: number; facts: ChannelFacts | null }>();

export async function livePreviewPlaylistAllowed(
  channelId: string,
  now = Date.now(),
): Promise<boolean> {
  const cached = eligibilityCache.get(channelId);
  let facts: ChannelFacts | null;
  if (cached && now - cached.at < ELIGIBILITY_TTL_MS) {
    facts = cached.facts;
  } else {
    try {
      facts = await loadChannelFacts(channelId);
      if (!cached && eligibilityCache.size >= ELIGIBILITY_CACHE_MAX) {
        const oldest = eligibilityCache.keys().next().value;
        if (oldest !== undefined) {
          eligibilityCache.delete(oldest);
        }
      }
      eligibilityCache.set(channelId, { at: now, facts });
    } catch {
      if (!cached) {
        noteRefusal("playlist", channelId, "unavailable");
        return false;
      }
      facts = cached.facts;
    }
  }
  const reason = judge(facts);
  if (reason) {
    noteRefusal("playlist", channelId, reason);
    return false;
  }
  return true;
}

// ----------------------------------------------------------------- listing

/**
 * The community a public slug names, when it may offer a preview at all. Null
 * for every other answer, identically, so the listing route cannot sort
 * communities into kinds.
 */
export async function previewServerForSlug(slug: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM servers
      WHERE community_slug = $1
        AND is_community
        AND NOT is_community_suspended`,
    [slug],
  );
  const id = result.rows[0]?.id ?? null;
  return id && livePreviewOnFor(id) ? id : null;
}

/** The same for a live invite code, with the invite's own validity rules. */
export async function previewServerForInvite(code: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT s.id
       FROM server_invites i
       JOIN servers s ON s.id = i.server_id
      WHERE i.code = $1
        AND (i.expires_at IS NULL OR i.expires_at > now())
        AND (i.max_uses IS NULL OR i.uses < i.max_uses)
        AND s.is_community
        AND NOT s.is_community_suspended`,
    [code],
  );
  const id = result.rows[0]?.id ?? null;
  return id && livePreviewOnFor(id) ? id : null;
}

/** How long a session row may claim to be live, the watch party sweep's own bound. */
const LIVE_ROW_MAX_AGE_HOURS = 12;

/**
 * The previewable channels of `serverId` with a live HLS session on them,
 * name and id only, in channel order. Empty when nothing qualifies.
 */
export async function listLivePreviewChannels(
  serverId: string,
): Promise<LivePreviewChannel[]> {
  const result = await getPool().query<{ id: string; name: string; position: number }>(
    `SELECT DISTINCT c.id, c.name, c.position
       FROM channels c
       JOIN hls_sessions h ON h.channel_id = c.id
      WHERE c.server_id = $1
        AND c.kind = 'server'
        AND c.type = 'watch_party'
        AND NOT c.is_private
        AND h.ended_at IS NULL
        AND h.cleaned_at IS NULL
        AND h.presenter_peer_id IS NOT NULL
        AND h.started_at > NOW() - ($2 || ' hours')::interval
      ORDER BY c.position, c.id`,
    [serverId, String(LIVE_ROW_MAX_AGE_HOURS)],
  );
  const view = await everyoneCanView(
    serverId,
    result.rows.map((row) => row.id),
  );
  return result.rows
    .filter((row) => view.get(row.id) === true)
    .map((row) => ({ id: row.id, name: row.name }));
}

// ------------------------------------------------------------------ ticket

/**
 * The window, carried by the visitor. `g` is a random visitor id, `c` the
 * channel, `f` the instant the window started. Signed with a key derived for
 * this purpose alone, so no other token kind verifies as a ticket and a ticket
 * opens nothing by itself: it only says when somebody's window began.
 */
interface TicketClaims {
  v: 1;
  k: "lpt";
  g: string;
  c: string;
  f: number;
}

function ticketSecret(): string | null {
  const raw = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_SECRET_KEY
    : process.env.DEV_AUTH_BYPASS === "true"
      ? "pqp-dev-live-preview"
      : null;
  if (!raw) {
    return null;
  }
  return createHmac("sha256", raw).update("pqp-live-preview-ticket").digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintLivePreviewTicket(input: {
  channelId: string;
  startedAt: number;
  visitorId?: string;
}): string | null {
  const secret = ticketSecret();
  if (!secret) {
    return null;
  }
  const claims: TicketClaims = {
    v: 1,
    k: "lpt",
    g: input.visitorId ?? randomBytes(12).toString("base64url"),
    c: input.channelId,
    f: input.startedAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The ticket's visitor and window start, or null for anything that is not a valid ticket for this channel. */
export function readLivePreviewTicket(
  ticket: string | null | undefined,
  channelId: string,
  now = Date.now(),
): { visitorId: string; windowStart: number } | null {
  if (!ticket) {
    return null;
  }
  const secret = ticketSecret();
  if (!secret) {
    return null;
  }
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const payload = ticket.slice(0, dot);
  if (!equal(ticket.slice(dot + 1), sign(payload, secret))) {
    return null;
  }
  let claims: Partial<TicketClaims> | null;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TicketClaims>;
  } catch {
    return null;
  }
  if (
    !claims ||
    claims.v !== 1 ||
    claims.k !== "lpt" ||
    typeof claims.g !== "string" ||
    claims.c !== channelId ||
    typeof claims.f !== "number" ||
    // A window that starts in the future is not one this server issued.
    claims.f > now + 60_000
  ) {
    return null;
  }
  return { visitorId: claims.g, windowStart: claims.f };
}

// ------------------------------------------------------------------- start

export type LivePreviewStartResult =
  | { kind: "ok"; body: LivePreviewStartResponse }
  | { kind: "ended" }
  | { kind: "refused"; status: 404 | 429; reason: LivePreviewRefusal };

/**
 * Mint (or re-mint) a visitor's preview of one channel.
 *
 * `takeFreshTicket` is asked only when a NEW window would start, and is the
 * route's address-keyed bucket: re-minting inside a window (a reload, the
 * presenter restarting) never spends it.
 */
export async function startLivePreview(input: {
  channelId: string;
  ticket?: string | null;
  takeFreshTicket: () => boolean;
  now?: number;
}): Promise<LivePreviewStartResult> {
  const now = input.now ?? Date.now();
  const refuse = (
    reason: LivePreviewRefusal,
    status: 404 | 429 = 404,
  ): LivePreviewStartResult => {
    noteRefusal("start", input.channelId, reason);
    return { kind: "refused", status, reason };
  };

  const eligibility = await livePreviewEligibility(input.channelId);
  if (!eligibility.ok) {
    return refuse(eligibility.reason);
  }
  const live =
    liveHlsStreamFor(input.channelId) ?? (await liveHlsStreamFromDb(input.channelId));
  // The listing's own bound, so the two never disagree: a row this old that
  // never ended is a leftover, not a show.
  if (!live || live.startedAt < now - LIVE_ROW_MAX_AGE_HOURS * 60 * 60 * 1000) {
    return refuse("not-live");
  }

  const windowMs = livePreviewSeconds() * 1000;
  const held = readLivePreviewTicket(input.ticket, input.channelId, now);
  let visitorId: string;
  let windowStart: number;
  let fresh = false;
  if (held && now < held.windowStart + windowMs) {
    visitorId = held.visitorId;
    windowStart = held.windowStart;
  } else if (held && now < held.windowStart + windowMs + livePreviewResetMs()) {
    counters.ended += 1;
    return { kind: "ended" };
  } else {
    if (!input.takeFreshTicket()) {
      return refuse("rate-limited", 429);
    }
    visitorId = randomBytes(12).toString("base64url");
    windowStart = now;
    fresh = true;
  }

  const ticket = mintLivePreviewTicket({
    channelId: input.channelId,
    startedAt: windowStart,
    visitorId,
  });
  const expiresAt = windowStart + windowMs;
  const stream = stampPreviewStream(live, visitorId, expiresAt, now);
  if (!ticket || !stream) {
    return refuse("unsigned");
  }
  if (fresh) {
    counters.started += 1;
  } else {
    counters.resumed += 1;
  }
  return {
    kind: "ok",
    body: {
      stream,
      channel: eligibility.channel,
      ticket,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - now),
    },
  };
}
