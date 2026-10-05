import {
  hasPermission,
  Permission,
  type SpeakReason,
  type VoiceAudienceEndReason,
  type VoiceAudienceState,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { flagServerOverrides, isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { isVoiceRegistryEnabled } from "./registry.js";

/**
 * AUDIENCE MODE ("Modo plateia"): the state, the one rule, and the counters.
 * `docs/plans/AUDIENCE_MODE.md` has the decisions; this file is what every
 * path that answers "may this person publish" consults.
 *
 * THE RULE (`applyAudienceMode`) ONLY EVER TAKES AWAY. It is applied on top
 * of SPEAK and STREAM as the channel's permissions already resolved them, so
 * it cannot hand a microphone to somebody the channel denies one. That is
 * what makes it safe to apply everywhere: the worst a bug in the state can do
 * is silence, and silence is announced (the reason travels to the person).
 *
 * THE STATE belongs to the call. With `VOICE_REGISTRY=postgres` it is the
 * `voice_audience_mode` / `voice_audience_speakers` rows, which cascade with
 * the room row, and `rooms` below is this process's cache of them (cleared by
 * `ws/voice.ts` when it holds nobody in the room, refreshed on every join and
 * every `voice.audience` frame). With the registry off, `rooms` IS the state.
 *
 * THE FLAG gates it: with `audience_mode` off for a server, the state reads
 * as absent whatever the rows say, so turning the flag off is also the kill
 * switch (the sweep in `ws/voice.ts` then deletes the rows).
 *
 * No import from `ws/voice.ts`: this module is read by `voice/speak.ts` (the
 * token mint, the permission re-check) as well as by the WebSocket, and must
 * not drag the socket layer in behind it.
 */

/** One room's audience mode, as this process holds it. */
export interface AudienceRoom {
  /** Epoch ms it was turned on (the row's clock with the registry on). */
  since: number;
  byUserId: string;
  /** People a host let speak in this session. */
  speakers: Set<string>;
  /**
   * People the SFU has not confirmed as silenced. Per process and never
   * persisted: it is what the last enforcement pass on THIS instance saw,
   * relayed to the others on the bus so every host sees the same warning.
   */
  unenforced: Set<string>;
}

const rooms = new Map<string, AudienceRoom>();

/**
 * Whether this person runs the stage while audience mode is on: they hold
 * `MUTE_MEMBERS` or `MANAGE_CHANNELS` in the channel. Owner and Administrator
 * resolve to every bit, so they always do; ADMINISTRATOR is checked on its
 * own as well rather than trusting that resolution from a distance.
 */
export function isAudienceStage(permissions: bigint): boolean {
  return (
    hasPermission(permissions, Permission.ADMINISTRATOR) ||
    hasPermission(permissions, Permission.MUTE_MEMBERS) ||
    hasPermission(permissions, Permission.MANAGE_CHANNELS)
  );
}

export interface PublishBits {
  canSpeak: boolean;
  canStream: boolean;
  canShowFace?: boolean;
}

/**
 * THE ONE RULE. `grant` is SPEAK / STREAM as the channel's permissions
 * resolved them; the answer is what this person may publish in this call.
 *
 * | who            | mic                 | camera / screen     |
 * |----------------|---------------------|---------------------|
 * | stage          | unchanged           | unchanged           |
 * | invited        | unchanged           | no                  |
 * | audience       | no                  | no                  |
 *
 * `speakReason` says why the mic is locked when it is: `permission` when the
 * channel would deny it anyway (turning audience mode off would not help, so
 * that is the honest answer), `audience` otherwise.
 */
export function applyAudienceMode<G extends PublishBits>(
  grant: G,
  context: {
    audience: Pick<AudienceRoom, "speakers"> | null;
    permissions: bigint;
    userId: string;
  },
): G & { speakReason: SpeakReason | null } {
  const permissionReason: SpeakReason | null = grant.canSpeak ? null : "permission";
  if (!context.audience || isAudienceStage(context.permissions)) {
    return { ...grant, speakReason: permissionReason };
  }
  const invited = context.audience.speakers.has(context.userId);
  const silenced = {
    ...grant,
    canStream: false,
    ...(grant.canShowFace === undefined ? {} : { canShowFace: false }),
  };
  if (invited) {
    return { ...silenced, speakReason: permissionReason };
  }
  return {
    ...silenced,
    canSpeak: false,
    speakReason: grant.canSpeak ? "audience" : "permission",
  };
}

/** Audience mode exists only in a server's plain voice channel. */
export function audienceModeApplies(
  channel:
    | { kind?: string | null; server_id?: string | null; type?: string | null }
    | null
    | undefined,
): boolean {
  return Boolean(
    channel &&
      channel.kind === "server" &&
      channel.server_id &&
      (channel.type ?? "voice") === "voice",
  );
}

/** The runtime flag for this server (`audience_mode`, per server, default off). */
export function audienceModeEnabledFor(serverId: string | null | undefined): boolean {
  return isEnabled("audience_mode", { serverId: serverId ?? null });
}

/**
 * Whether the flag is on for anybody: globally, or for at least one server.
 * Lets the sweep skip its query entirely on a deployment where nobody can
 * have audience mode on, which is every deployment until an operator says so.
 */
export function audienceModeMayBeOnAnywhere(): boolean {
  if (isEnabled("audience_mode")) {
    return true;
  }
  for (const enabled of flagServerOverrides("audience_mode").values()) {
    if (enabled) {
      return true;
    }
  }
  return false;
}

// --- the cache ---------------------------------------------------------------

/** This process's copy of a room's audience mode, or null. Never reads the database. */
export function cachedAudience(channelId: string): AudienceRoom | null {
  return rooms.get(channelId) ?? null;
}

/** Replace (or clear) this process's copy. Keeps the unenforced set when the session is the same. */
export function cacheAudience(
  channelId: string,
  next: { since: number; byUserId: string; speakers: Iterable<string> } | null,
): AudienceRoom | null {
  if (!next) {
    rooms.delete(channelId);
    return null;
  }
  const previous = rooms.get(channelId);
  const room: AudienceRoom = {
    since: next.since,
    byUserId: next.byUserId,
    speakers: new Set(next.speakers),
    unenforced:
      previous && previous.since === next.since ? previous.unenforced : new Set(),
  };
  rooms.set(channelId, room);
  return room;
}

/** Every room this process holds an audience mode for (the sweep's work list). */
export function cachedAudienceRooms(): string[] {
  return [...rooms.keys()];
}

/** Test seam. */
export function resetAudienceForTests(): void {
  rooms.clear();
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
    counters[key] = 0;
  }
  for (const key of Object.keys(ended) as (keyof typeof ended)[]) {
    ended[key] = 0;
  }
  speakDenied.permission = 0;
  speakDenied.audience = 0;
}

/** The wire shape of a room's state; null when off. */
export function audienceWireState(room: AudienceRoom | null): VoiceAudienceState | null {
  if (!room) {
    return null;
  }
  return {
    since: room.since,
    byUserId: room.byUserId,
    speakerUserIds: [...room.speakers].sort(),
    unenforcedUserIds: [...room.unenforced].sort(),
  };
}

// --- the rows ------------------------------------------------------------------

interface AudienceRowSnapshot {
  since: number;
  byUserId: string;
  speakers: string[];
}

/** The room's audience mode per the rows, or null. Throws when the database does. */
export async function readAudienceRow(
  channelId: string,
): Promise<AudienceRowSnapshot | null> {
  const result = await getPool().query<{
    enabled_by: string;
    enabled_at: Date;
    speakers: string[] | null;
  }>(
    `SELECT m.enabled_by, m.enabled_at,
            COALESCE(
              ARRAY_AGG(s.user_id::text ORDER BY s.user_id)
                FILTER (WHERE s.user_id IS NOT NULL),
              '{}'
            ) AS speakers
       FROM voice_audience_mode m
       LEFT JOIN voice_audience_speakers s ON s.channel_id = m.channel_id
      WHERE m.channel_id = $1
      GROUP BY m.channel_id, m.enabled_by, m.enabled_at`,
    [channelId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    since: row.enabled_at.getTime(),
    byUserId: row.enabled_by,
    speakers: row.speakers ?? [],
  };
}

/**
 * Turn it on in the rows. Idempotent: a second host turning it on keeps the
 * first one's session (and its invitations), and answers `exists`. `missing`
 * means there is no room row, so there is no call to turn it on in.
 */
export async function insertAudienceRow(
  channelId: string,
  byUserId: string,
): Promise<"created" | "exists" | "missing"> {
  try {
    const result = await getPool().query(
      `INSERT INTO voice_audience_mode (channel_id, enabled_by) VALUES ($1, $2)
       ON CONFLICT (channel_id) DO NOTHING`,
      [channelId, byUserId],
    );
    return (result.rowCount ?? 0) > 0 ? "created" : "exists";
  } catch (error) {
    if ((error as { code?: string }).code === "23503") {
      return "missing";
    }
    throw error;
  }
}

/** Turn it off in the rows; the invitations cascade. Returns whether a row went. */
export async function deleteAudienceRow(channelId: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM voice_audience_mode WHERE channel_id = $1`,
    [channelId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Let one person speak, or stop letting them. `off` means audience mode is
 * not on (the insert failed its foreign key), so there is nothing to invite
 * anybody into.
 */
export async function setAudienceSpeakerRow(
  channelId: string,
  userId: string,
  allowed: boolean,
  byUserId: string,
): Promise<"ok" | "off"> {
  if (!allowed) {
    await getPool().query(
      `DELETE FROM voice_audience_speakers WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    );
    return "ok";
  }
  try {
    await getPool().query(
      `INSERT INTO voice_audience_speakers (channel_id, user_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channelId, userId, byUserId],
    );
    return "ok";
  } catch (error) {
    if ((error as { code?: string }).code === "23503") {
      return "off";
    }
    throw error;
  }
}

/** Drop one invitation; whether there was one. The person left the call. */
export async function removeAudienceSpeakerRow(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM voice_audience_speakers WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Invitations held by people with no seat left in the room. The departure
 * path drops them as the person leaves; this is the sweep's backstop for a
 * delete that failed, so an invitation can never outlive its holder's seat by
 * more than a sweep and come back with them on a later rejoin.
 */
export async function pruneDepartedAudienceSpeakers(channelId: string): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM voice_audience_speakers s
      WHERE s.channel_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM voice_peers p
           WHERE p.channel_id = s.channel_id AND p.user_id = s.user_id
        )`,
    [channelId],
  );
  return result.rowCount ?? 0;
}

/** Which of these rooms have audience mode on, per the rows. One query for the sweep. */
export async function listAudienceRooms(channelIds: readonly string[]): Promise<string[]> {
  if (channelIds.length === 0) {
    return [];
  }
  const result = await getPool().query<{ channel_id: string }>(
    `SELECT channel_id FROM voice_audience_mode WHERE channel_id = ANY($1::uuid[])`,
    [channelIds],
  );
  return result.rows.map((row) => row.channel_id);
}

/**
 * The room's audience mode for a decision about who may publish: the join,
 * the token mint, the permission re-check.
 *
 * - Not a plain server voice channel, or the flag is off for the server:
 *   null, without touching the database. The flag is off everywhere by
 *   default, so this costs nothing until an operator turns it on.
 * - Registry on: the rows, which the cache then follows. A read that fails
 *   falls back to the cache when this process holds one, and THROWS when it
 *   does not: the caller refuses (503, a retried join) rather than issue a
 *   grant on a guess.
 * - Registry off: the cache, which is the state.
 */
export async function loadAudience(
  channel:
    | { kind?: string | null; server_id?: string | null; type?: string | null }
    | null
    | undefined,
  channelId: string,
): Promise<AudienceRoom | null> {
  if (!audienceModeApplies(channel) || !audienceModeEnabledFor(channel!.server_id)) {
    return null;
  }
  if (!isVoiceRegistryEnabled()) {
    return cachedAudience(channelId);
  }
  try {
    const row = await readAudienceRow(channelId);
    return cacheAudience(channelId, row);
  } catch (error) {
    logEvent("voice.registryReadFailed", {
      op: "audience",
      error: error instanceof Error ? error.message : String(error),
    });
    // What this process last knew, when it knew anything. With nothing
    // cached it cannot tell "off" from "on and not heard about", so it does
    // not guess: the error goes to the caller, which refuses the way it
    // already refuses when the permission read beside this one fails (the
    // token mint answers 503, a join is retried). Answering "off" here would
    // hand a microphone to somebody the room silenced.
    const cached = cachedAudience(channelId);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

/** The cache, gated by the flag the same way `loadAudience` is. Synchronous. */
export function effectiveCachedAudience(
  channel:
    | { kind?: string | null; server_id?: string | null; type?: string | null }
    | null
    | undefined,
  channelId: string,
): AudienceRoom | null {
  if (!audienceModeApplies(channel) || !audienceModeEnabledFor(channel!.server_id)) {
    return null;
  }
  return cachedAudience(channelId);
}

// --- counters (GET /api/admin/metrics -> voice.audienceMode) ----------------------

const counters = {
  sessionsStarted: 0,
  speakersGranted: 0,
  speakersRevoked: 0,
  enforcePasses: 0,
  enforceUpdates: 0,
  enforceFailures: 0,
  unmuteRefused: 0,
};
const ended: Record<VoiceAudienceEndReason | "room-empty", number> = {
  host: 0,
  "no-host": 0,
  "flag-off": 0,
  "room-empty": 0,
};
const speakDenied: Record<SpeakReason, number> = { permission: 0, audience: 0 };

export function noteAudienceCounter(key: keyof typeof counters, by = 1): void {
  counters[key] += by;
}

export function noteAudienceEnded(reason: VoiceAudienceEndReason | "room-empty"): void {
  ended[reason] += 1;
}

export function noteSpeakDenied(reason: SpeakReason): void {
  speakDenied[reason] += 1;
}

export interface AudienceModeMetrics {
  /** The flag's deployment-wide answer (a server override can differ). */
  enabled: boolean;
  /** Rooms with audience mode on that this process holds a cache for. */
  activeRooms: number;
  sessionsStarted: number;
  sessionsEnded: Record<VoiceAudienceEndReason | "room-empty", number>;
  speakersGranted: number;
  speakersRevoked: number;
  /** SFU passes run, participant permissions rewritten, and failures (per participant or per box). */
  enforcePasses: number;
  enforceUpdates: number;
  enforceFailures: number;
  /** Unmutes refused because the mic is locked, any reason. */
  unmuteRefused: number;
  /** Seats that joined with the mic locked, by why. */
  speakDenied: Record<SpeakReason, number>;
}

export function audienceModeMetrics(): AudienceModeMetrics {
  return {
    enabled: isEnabled("audience_mode"),
    activeRooms: rooms.size,
    ...counters,
    sessionsEnded: { ...ended },
    speakDenied: { ...speakDenied },
  };
}

// --- rate-limited "why" lines (pitfall 16) -------------------------------------

const LINE_WINDOW_MS = 60_000;
const lines = new Map<string, { at: number; suppressed: number }>();
let linesPrunedAt = 0;

/**
 * One line per (event, room) per minute, with `suppressed=N` on the next one.
 * 146 `voice.speakDenied` lines for one movie night said nothing that one
 * line with a count would not, and none of them said why.
 */
export function logPerRoom(
  event: string,
  channelId: string,
  fields: Record<string, unknown>,
  now = Date.now(),
): void {
  const key = `${event}:${channelId}`;
  const entry = lines.get(key);
  if (entry && now - entry.at < LINE_WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  lines.set(key, { at: now, suppressed: 0 });
  // Pruned at most once a window, so a burst of new rooms costs one scan a
  // minute rather than one per insert.
  if (lines.size > 5_000 && now - linesPrunedAt >= LINE_WINDOW_MS) {
    linesPrunedAt = now;
    for (const [stale, value] of lines) {
      if (now - value.at >= LINE_WINDOW_MS) {
        lines.delete(stale);
      }
    }
  }
  logEvent(event, { voiceChannelId: channelId, ...fields, ...(suppressed ? { suppressed } : {}) });
}

/** Test seam for the per-room limiter. */
export function resetAudienceLogLimiterForTests(): void {
  lines.clear();
  linesPrunedAt = 0;
}
