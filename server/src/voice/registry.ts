import { createHash } from "node:crypto";
import type { VoiceRoomTransport, WatchPartyState } from "@pqp/shared";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import {
  VOICE_RESUME_TOKEN_TTL_MS,
  VOICE_RESUME_TTL_MS,
} from "../ws/voice-resume-token.js";

/**
 * The voice registry: `ws/voice.ts`'s peer map and transport pin, written to
 * Postgres so more than one API instance can agree on a room.
 *
 * WHY POSTGRES AND NOT THE BUS. The cluster bus (`lib/bus.ts`) is fan-out, not
 * state. Two things voice needs cannot be gossiped: an *atomic* decision (which
 * transport a room runs on, decided by whoever pins first) and a *lookup from
 * an HTTP request on any instance* (the SFU token mint, a moderator's target).
 * Both are ordinary SQL against tables the deployment already pays for. See
 * `docs/plans/MULTI_INSTANCE_VOICE.md`, sections 3 and 4.
 *
 * DEFAULT IS OFF, AND OFF MEANS OFF. `VOICE_REGISTRY` unset (or `off`) makes
 * `isVoiceRegistryEnabled()` false, and every caller in `ws/voice.ts` checks
 * it before doing anything, so the single-instance path stays byte-for-byte
 * what it was before this file existed. The tables sit empty.
 *
 * M1 MADE IT WRITE-THROUGH, M2 MADE THE ROWS THE ROSTER. Every change to the
 * in-process map (join, state change, socket loss, leave) is copied here, and
 * the transport pin is the one decision that goes *through* the table rather
 * than beside it. With the flag on, `broadcastRoster` and `sendAllVoiceRosters`
 * in `ws/voice.ts` read `listVoiceRoster` / `listVoiceRosters` instead of the
 * map, the watch party lives in `voice_rooms.watch_party`, and the bus frames
 * (`voice.room`, `voice.identity`, `voice.watch`) are *hints* that tell the
 * other instance to re-read: a dropped frame costs latency, never a ghost.
 *
 * M3 MADE THE ROWS SURVIVE THEIR INSTANCE. A resume that lands on the other
 * machine adopts the row (`adoptVoicePeer`, one conditional UPDATE), the
 * instance lease gets its consequences (`reconcileVoiceRegistry`: rows of a
 * dead instance are orphaned, then deleted after the resume window, and
 * room rows nobody is in are swept), and `voice_retired_peers` is the only
 * retired store while the flag is on.
 *
 * WRITES NEVER THROW INTO THE HANDLER. A failed registry write is logged and
 * otherwise ignored: the local map has already been updated and the sockets
 * already served, and a database blip must degrade this instance to
 * single-instance behaviour, not eject people from calls. The pin is the one
 * exception, and even it falls back to the local decision on failure.
 */

export type VoiceRegistryMode = "postgres" | "off";

/** Anything but `postgres` is off; the boot wiring in index.ts warns once about an unknown value. */
export function voiceRegistryMode(): VoiceRegistryMode {
  return process.env.VOICE_REGISTRY === "postgres" ? "postgres" : "off";
}

/** Read per call, never cached: tests flip it, and a restart is the only other way it changes. */
export function isVoiceRegistryEnabled(): boolean {
  return voiceRegistryMode() === "postgres";
}

/** How often this instance proves it is alive, and how long silence means dead. */
export const INSTANCE_HEARTBEAT_MS = 15_000;
export const INSTANCE_TTL_MS = 45_000;

/**
 * Digest of the SFU configuration, for drift detection. Two instances that
 * read different `LIVEKIT_*` secrets would pin the same channel differently;
 * the atomic pin makes that harmless (the room follows the first joiner) and
 * this hash makes it *visible*, in `voice_instances.config_hash` and on the
 * `voice.hello` bus frame. The secret itself never leaves the process: only
 * the URL and the key id are hashed, and the digest is truncated.
 */
export function voiceConfigHash(): string {
  const url = process.env.LIVEKIT_URL ?? "";
  const key = process.env.LIVEKIT_API_KEY ?? "";
  if (!url || !key) {
    return "mesh";
  }
  return createHash("sha256")
    .update(`${url}\n${key}`)
    .digest("hex")
    .slice(0, 16);
}

// --- in-flight tracking -----------------------------------------------------
//
// Every write from the voice handler is fire-and-forget. Tests (and only
// tests) need to know when the rows have landed, the same way `voice/admin.ts`
// exposes `settleSfuEvictions`.

const inFlight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>, event: string): Promise<T | null> {
  const guarded = work
    .catch((error: unknown) => {
      logEvent("voice.registryWriteFailed", {
        op: event,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    })
    .finally(() => {
      inFlight.delete(guarded);
    });
  inFlight.add(guarded);
  return guarded;
}

/** Test seam: resolves once every registry write started so far has settled. */
export async function settleVoiceRegistryWrites(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

// --- rooms ------------------------------------------------------------------

/**
 * Pin a room's transport, atomically across instances. Whoever inserts first
 * decides; everyone else adopts what is stored. Returns the transport the
 * room is running on, which may differ from `wanted`.
 */
export async function pinVoiceRoom(
  channelId: string,
  wanted: VoiceRoomTransport,
): Promise<VoiceRoomTransport> {
  return (await claimVoiceRoomTransport(channelId, wanted)).transport;
}

/**
 * `pinVoiceRoom` with the outcome attached: `won` is true when this call
 * inserted the row, false when the room was already pinned (by another
 * instance, or by a row the sweep has not reached yet) and the stored
 * transport is what came back. The join path logs an adopted mesh pin from
 * it, so the number that used to be a refusal has a line in the log without
 * a second read.
 */
export async function claimVoiceRoomTransport(
  channelId: string,
  wanted: VoiceRoomTransport,
): Promise<{ transport: VoiceRoomTransport; won: boolean }> {
  const pool = getPool();
  const inserted = await pool.query<{ transport: VoiceRoomTransport }>(
    `INSERT INTO voice_rooms (channel_id, transport)
     VALUES ($1, $2)
     ON CONFLICT (channel_id) DO NOTHING
     RETURNING transport`,
    [channelId, wanted],
  );
  const won = inserted.rows[0]?.transport;
  if (won) {
    return { transport: won, won: true };
  }
  const existing = await readVoiceRoomTransport(channelId);
  if (existing) {
    return { transport: existing, won: false };
  }
  // The row was deleted between the two statements (the room's last peer
  // left at the same moment). Rare; one more attempt is enough, because a
  // second conflict means somebody else pinned it and the read will succeed.
  const retry = await pool.query<{ transport: VoiceRoomTransport }>(
    `INSERT INTO voice_rooms (channel_id, transport)
     VALUES ($1, $2)
     ON CONFLICT (channel_id) DO NOTHING
     RETURNING transport`,
    [channelId, wanted],
  );
  if (retry.rows[0]) {
    return { transport: retry.rows[0].transport, won: true };
  }
  const stored = await readVoiceRoomTransport(channelId);
  return stored ? { transport: stored, won: false } : { transport: wanted, won: true };
}

export async function readVoiceRoomTransport(
  channelId: string,
): Promise<VoiceRoomTransport | null> {
  const result = await getPool().query<{ transport: VoiceRoomTransport }>(
    `SELECT transport FROM voice_rooms WHERE channel_id = $1`,
    [channelId],
  );
  return result.rows[0]?.transport ?? null;
}

/**
 * Drop a room row that has no peers. Used when a join pinned the room and
 * then refused the client (capability mismatch, mesh full), so a row is not
 * left describing a room nobody is in. A no-op for an occupied room.
 */
export function unpinVoiceRoomIfEmpty(channelId: string): Promise<unknown> {
  return track(
    getPool().query(
      `DELETE FROM voice_rooms r
        WHERE r.channel_id = $1
          AND NOT EXISTS (SELECT 1 FROM voice_peers p WHERE p.channel_id = r.channel_id)`,
      [channelId],
    ),
    "unpinIfEmpty",
  );
}

// --- peers ------------------------------------------------------------------

export interface VoicePeerRow {
  peerId: string;
  channelId: string;
  userId: string;
  instanceId: string;
  displayName: string;
  avatarUrl: string | null;
  muted: boolean;
  deafened: boolean;
  sharingScreen: boolean;
  cameraStreamId: string | null;
  screenAudioStreamId: string | null;
  canSpeak: boolean;
  canStream: boolean;
  canResume: boolean;
  orphanedAt: Date | null;
}

export type VoicePeerWrite = Omit<VoicePeerRow, "instanceId"> & {
  /** What the room runs on, so a missing room row can be recreated. */
  transport: VoiceRoomTransport;
};

interface VoicePeerDbRow {
  peer_id: string;
  channel_id: string;
  user_id: string;
  instance_id: string;
  display_name: string;
  avatar_url: string | null;
  muted: boolean;
  deafened: boolean;
  sharing_screen: boolean;
  camera_stream_id: string | null;
  screen_audio_stream_id: string | null;
  can_speak: boolean;
  can_stream: boolean;
  can_resume: boolean;
  orphaned_at: Date | null;
}

function mapRow(row: VoicePeerDbRow): VoicePeerRow {
  return {
    peerId: row.peer_id,
    channelId: row.channel_id,
    userId: row.user_id,
    instanceId: row.instance_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    muted: row.muted,
    deafened: row.deafened,
    sharingScreen: row.sharing_screen,
    cameraStreamId: row.camera_stream_id,
    screenAudioStreamId: row.screen_audio_stream_id,
    canSpeak: row.can_speak,
    canStream: row.can_stream,
    canResume: row.can_resume,
    orphanedAt: row.orphaned_at,
  };
}

const PEER_COLUMNS = `peer_id, channel_id, user_id, instance_id, display_name, avatar_url,
       muted, deafened, sharing_screen, camera_stream_id, screen_audio_stream_id,
       can_speak, can_stream, can_resume, orphaned_at`;
/** The same list qualified as `p.<column>`, for statements that join `voice_peers p`. */
const PEER_COLUMNS_OF_P = PEER_COLUMNS.split(",")
  .map((column) => `p.${column.trim()}`)
  .join(", ");

/**
 * Write a peer's whole row, creating it on join and replacing it on every
 * state change. Idempotent, so a reattach after a socket blip is the same
 * call as a mute toggle.
 *
 * The room row is (re)asserted first because the peer's foreign key needs it,
 * and the last peer of a room can leave while this join is in flight (its
 * delete takes the room row with it). `ON CONFLICT DO NOTHING` keeps whatever
 * transport is already pinned; the insert only lands on a genuinely empty
 * room, where `transport` is the decision this join already adopted.
 */
export function upsertVoicePeer(peer: VoicePeerWrite): Promise<unknown> {
  return track(writePeer(peer), "upsertPeer");
}

async function writePeer(peer: VoicePeerWrite): Promise<void> {
  const pool = getPool();
  for (let attempt = 0; attempt < 2; attempt++) {
    await pool.query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, $2)
       ON CONFLICT (channel_id) DO NOTHING`,
      [peer.channelId, peer.transport],
    );
    try {
      await pool.query(
        `INSERT INTO voice_peers (
           peer_id, channel_id, user_id, instance_id, display_name, avatar_url,
           muted, deafened, sharing_screen, camera_stream_id,
           screen_audio_stream_id, can_speak, can_stream, can_resume, orphaned_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (peer_id) DO UPDATE SET
           channel_id = EXCLUDED.channel_id,
           user_id = EXCLUDED.user_id,
           instance_id = EXCLUDED.instance_id,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           muted = EXCLUDED.muted,
           deafened = EXCLUDED.deafened,
           sharing_screen = EXCLUDED.sharing_screen,
           camera_stream_id = EXCLUDED.camera_stream_id,
           screen_audio_stream_id = EXCLUDED.screen_audio_stream_id,
           can_speak = EXCLUDED.can_speak,
           can_stream = EXCLUDED.can_stream,
           can_resume = EXCLUDED.can_resume,
           orphaned_at = EXCLUDED.orphaned_at,
           updated_at = NOW()`,
        [
          peer.peerId,
          peer.channelId,
          peer.userId,
          INSTANCE_ID,
          peer.displayName,
          peer.avatarUrl,
          peer.muted,
          peer.deafened,
          peer.sharingScreen,
          peer.cameraStreamId,
          peer.screenAudioStreamId,
          peer.canSpeak,
          peer.canStream,
          peer.canResume,
          peer.orphanedAt,
        ],
      );
      return;
    } catch (error) {
      // 23503 = foreign_key_violation: the room row vanished between the two
      // statements. Re-assert it and try once more.
      if ((error as { code?: string }).code === "23503" && attempt === 0) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Remove a peer and, if it was the room's last, the room row with it, in one
 * statement. The CTE's delete is not visible to the `NOT EXISTS` (every part
 * of a data-modifying statement runs on the same snapshot), hence the explicit
 * `peer_id <> $1`. Two *exactly* concurrent last-leaves can each still see the
 * other's row and leave the room row behind; the M3 reconcile sweeps rooms
 * with no peers, and until then `pinVoiceRoom` treats such a row as a pin the
 * next joiner adopts, which is the same transport the room just had.
 */
export function deleteVoicePeer(peerId: string): Promise<unknown> {
  return track(
    getPool().query(
      `WITH gone AS (
         DELETE FROM voice_peers WHERE peer_id = $1 RETURNING channel_id
       )
       DELETE FROM voice_rooms r
        USING gone
        WHERE r.channel_id = gone.channel_id
          AND NOT EXISTS (
            SELECT 1 FROM voice_peers p
             WHERE p.channel_id = gone.channel_id AND p.peer_id <> $1
          )`,
      [peerId],
    ),
    "deletePeer",
  );
}

/** Socket gone, seat held (or the reverse on resume). */
export function markVoicePeerOrphaned(
  peerId: string,
  orphanedAt: Date | null,
): Promise<unknown> {
  return track(
    getPool().query(
      `UPDATE voice_peers
          SET orphaned_at = $2, instance_id = $3, updated_at = NOW()
        WHERE peer_id = $1`,
      [peerId, orphanedAt, INSTANCE_ID],
    ),
    "markOrphaned",
  );
}

export async function getVoicePeerRow(
  peerId: string,
): Promise<VoicePeerRow | null> {
  const result = await getPool().query<VoicePeerDbRow>(
    `SELECT ${PEER_COLUMNS} FROM voice_peers WHERE peer_id = $1`,
    [peerId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export async function listVoicePeersForUser(
  userId: string,
): Promise<VoicePeerRow[]> {
  const result = await getPool().query<VoicePeerDbRow>(
    `SELECT ${PEER_COLUMNS} FROM voice_peers WHERE user_id = $1 ORDER BY joined_at`,
    [userId],
  );
  return result.rows.map(mapRow);
}

export async function listVoicePeersInRoom(
  channelId: string,
): Promise<VoicePeerRow[]> {
  const result = await getPool().query<VoicePeerDbRow>(
    `SELECT ${PEER_COLUMNS} FROM voice_peers WHERE channel_id = $1 ORDER BY joined_at`,
    [channelId],
  );
  return result.rows.map(mapRow);
}

/** Every occupied room in the cluster, largest first. For the operator snapshot. */
export async function listVoiceRoomOccupancy(): Promise<
  { voiceChannelId: string; participants: number; sharingScreen: number }[]
> {
  const result = await getPool().query<{
    channel_id: string;
    participants: string;
    sharing_screen: string;
  }>(
    `SELECT channel_id,
            COUNT(*)::text AS participants,
            COUNT(*) FILTER (WHERE sharing_screen)::text AS sharing_screen
       FROM voice_peers
      GROUP BY channel_id
      ORDER BY COUNT(*) DESC, channel_id`,
  );
  return result.rows.map((row) => ({
    voiceChannelId: row.channel_id,
    participants: Number(row.participants),
    sharingScreen: Number(row.sharing_screen),
  }));
}

// --- rosters ----------------------------------------------------------------
//
// What `broadcastRoster` and `sendAllVoiceRosters` read with the flag on.
// One query each, on the channel index; the room row rides along so the
// roster states the transport the room is pinned to even when this instance
// never pinned it.

/** A peer row as a roster reads it: with the moderator's mute on the person. */
export type VoiceRosterPeerRow = VoicePeerRow & {
  /** `voice_server_mutes` has a row for this (room, user): see `setVoiceServerMute`. */
  serverMuted: boolean;
};

export interface VoiceRoomRoster {
  channelId: string;
  transport: VoiceRoomTransport;
  peers: VoiceRosterPeerRow[];
}

interface RosterDbRow extends VoicePeerDbRow {
  room_channel_id: string;
  transport: VoiceRoomTransport;
  server_muted: boolean;
}

const ROSTER_SELECT = `SELECT r.channel_id AS room_channel_id, r.transport,
       p.peer_id, p.channel_id, p.user_id, p.instance_id, p.display_name,
       p.avatar_url, p.muted, p.deafened, p.sharing_screen, p.camera_stream_id,
       p.screen_audio_stream_id, p.can_speak, p.can_stream, p.can_resume, p.orphaned_at,
       EXISTS (
         SELECT 1 FROM voice_server_mutes m
          WHERE m.channel_id = p.channel_id AND m.user_id = p.user_id
       ) AS server_muted
  FROM voice_rooms r
  LEFT JOIN voice_peers p ON p.channel_id = r.channel_id`;

function groupRosters(rows: RosterDbRow[]): VoiceRoomRoster[] {
  const byRoom = new Map<string, VoiceRoomRoster>();
  for (const row of rows) {
    let room = byRoom.get(row.room_channel_id);
    if (!room) {
      room = {
        channelId: row.room_channel_id,
        transport: row.transport,
        peers: [],
      };
      byRoom.set(row.room_channel_id, room);
    }
    // A room row with no peers (the LEFT JOIN's null side) is still a room.
    if (row.peer_id) {
      room.peers.push({ ...mapRow(row), serverMuted: row.server_muted });
    }
  }
  return [...byRoom.values()];
}

/** One room's roster, or null when no room row exists (nobody is in it anywhere). */
export async function listVoiceRoster(
  channelId: string,
): Promise<VoiceRoomRoster | null> {
  const result = await getPool().query<RosterDbRow>(
    `${ROSTER_SELECT} WHERE r.channel_id = $1 ORDER BY p.joined_at`,
    [channelId],
  );
  return groupRosters(result.rows)[0] ?? null;
}

/** Every occupied room in the cluster, for the rosters a fresh socket is sent. */
export async function listVoiceRosters(): Promise<VoiceRoomRoster[]> {
  const result = await getPool().query<RosterDbRow>(
    `${ROSTER_SELECT} ORDER BY r.channel_id, p.joined_at`,
  );
  return groupRosters(result.rows).filter((room) => room.peers.length > 0);
}

// --- moderator mutes --------------------------------------------------------
//
// The cluster's copy of `roomServerMutes` (ws/voice.ts): one row per (room,
// user) a moderator has muted for everyone. Written by the instance the
// moderation request landed on before it publishes `voice.serverMute`, read
// by a join (so a seat minted on any instance, or after a restart, comes back
// muted) and by every roster (`server_muted` above). The row cascades away
// with the room row, which is the in-process map's lifetime too.

/**
 * Set or clear the moderator's mute on one person in one room. Idempotent.
 * A room that has no row any more (everybody left while the request was in
 * flight) has nothing to mute: the insert fails its foreign key and is
 * treated as done, since the sanction's lifetime was the room's anyway.
 */
export function setVoiceServerMute(
  channelId: string,
  userId: string,
  muted: boolean,
): Promise<unknown> {
  const pool = getPool();
  const work = muted
    ? pool
        .query(
          `INSERT INTO voice_server_mutes (channel_id, user_id) VALUES ($1, $2)
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channelId, userId],
        )
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === "23503") {
            return;
          }
          throw error;
        })
    : pool.query(
        `DELETE FROM voice_server_mutes WHERE channel_id = $1 AND user_id = $2`,
        [channelId, userId],
      );
  return track(work, "serverMute");
}

/** Whether a moderator's mute stands on this person in this room, per the rows. */
export async function isVoiceServerMuted(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM voice_server_mutes WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

// --- watch party ------------------------------------------------------------
//
// `voice_rooms.watch_party` is the room's party with the flag on; the map in
// `ws/watch-party.ts` becomes a per-instance cache of it. The contract's own
// ordering (higher `rev` wins, ties break on `actorId`) is the WHERE clause,
// so the write is the coalescing point across instances: a row not updated
// is a write that lost, and the caller hands the loser what the row holds.

export type WatchPartyPersist =
  | { kind: "updated" }
  | { kind: "stale"; held: WatchPartyState | null }
  /** No room row: the room emptied under the writer. Nothing to hold. */
  | { kind: "missing" };

export async function persistWatchParty(
  channelId: string,
  state: WatchPartyState | null,
): Promise<WatchPartyPersist> {
  const pool = getPool();
  if (state === null) {
    // A teardown is structural and last-wins, exactly as in memory: the held
    // state is forgotten and the clock restarts, so the next party's first
    // write (rev 1 from a client that has heard nothing) is not refused.
    const result = await pool.query(
      `UPDATE voice_rooms SET watch_party = NULL, watch_party_rev = 0
        WHERE channel_id = $1`,
      [channelId],
    );
    return (result.rowCount ?? 0) > 0
      ? { kind: "updated" }
      : { kind: "missing" };
  }
  const result = await pool.query(
    `UPDATE voice_rooms
        SET watch_party = $2::jsonb, watch_party_rev = $3
      WHERE channel_id = $1
        AND (watch_party_rev < $3
             OR (watch_party_rev = $3 AND (watch_party->>'actorId') <= $4))`,
    [channelId, JSON.stringify(state), state.rev, state.actorId],
  );
  if ((result.rowCount ?? 0) > 0) {
    return { kind: "updated" };
  }
  const held = await readWatchParty(channelId);
  if (held === undefined) {
    return { kind: "missing" };
  }
  return { kind: "stale", held };
}

/** The row's party: null when the room has none, undefined when there is no room. */
export async function readWatchParty(
  channelId: string,
): Promise<WatchPartyState | null | undefined> {
  const result = await getPool().query<{
    watch_party: WatchPartyState | null;
  }>(`SELECT watch_party FROM voice_rooms WHERE channel_id = $1`, [channelId]);
  if (result.rows.length === 0) {
    return undefined;
  }
  return result.rows[0]?.watch_party ?? null;
}

/**
 * Forget a room's party once nobody is in it anywhere. Normally moot, since
 * the last peer's delete takes the room row with it; this covers the row the
 * concurrent-last-leave race in `deleteVoicePeer` can leave behind, so the
 * next call in the channel does not inherit a film nobody is watching.
 */
export function clearWatchPartyIfEmpty(channelId: string): Promise<unknown> {
  return track(
    getPool().query(
      `UPDATE voice_rooms r
          SET watch_party = NULL, watch_party_rev = 0
        WHERE r.channel_id = $1
          AND r.watch_party IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM voice_peers p WHERE p.channel_id = r.channel_id)`,
      [channelId],
    ),
    "clearWatchParty",
  );
}

// --- adopt ------------------------------------------------------------------

export interface VoicePeerAdoption {
  /** The row as it now stands: this instance's, no longer orphaned. */
  row: VoicePeerRow;
  /** Who held it before, and whether their lease was still good. */
  previousInstanceId: string;
  previousOrphanedAt: Date | null;
  previousOwnerAlive: boolean;
}

/**
 * Take over a peer row held by another instance: the third resume plan
 * (`docs/plans/MULTI_INSTANCE_VOICE.md` 5.2). One conditional UPDATE, so a
 * row that was deleted or re-owned in the meantime is a null, never a seat
 * stolen back. The proof of ownership is the caller's (the resume HMAC);
 * the `user_id` / `channel_id` clauses only make a forged claim a no-op.
 *
 * The previous owner's liveness rides along so the caller can log which
 * case it was; the treatment is the same either way (adopt, publish
 * `voice.room adopted` so the old owner drops its local entry without a
 * `peer-left`). A dead owner is simply one that is not listening.
 */
export async function adoptVoicePeer(
  peerId: string,
  userId: string,
  channelId: string,
  ttlMs = INSTANCE_TTL_MS,
): Promise<VoicePeerAdoption | null> {
  const result = await getPool().query<
    VoicePeerDbRow & {
      previous_instance_id: string;
      previous_orphaned_at: Date | null;
      previous_owner_alive: boolean;
    }
  >(
    `WITH before AS (
       SELECT p.peer_id, p.instance_id, p.orphaned_at,
              EXISTS (
                SELECT 1 FROM voice_instances i
                 WHERE i.instance_id = p.instance_id
                   AND i.heartbeat_at > NOW() - ($5::bigint * INTERVAL '1 millisecond')
              ) AS owner_alive
         FROM voice_peers p
        WHERE p.peer_id = $1 AND p.user_id = $2 AND p.channel_id = $3
          FOR UPDATE
     )
     UPDATE voice_peers p
        SET instance_id = $4, orphaned_at = NULL, updated_at = NOW()
       FROM before
      WHERE p.peer_id = before.peer_id
      RETURNING ${PEER_COLUMNS_OF_P},
                before.instance_id AS previous_instance_id,
                before.orphaned_at AS previous_orphaned_at,
                before.owner_alive AS previous_owner_alive`,
    [peerId, userId, channelId, INSTANCE_ID, ttlMs],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    row: mapRow(row),
    previousInstanceId: row.previous_instance_id,
    previousOrphanedAt: row.previous_orphaned_at,
    previousOwnerAlive: row.previous_owner_alive,
  };
}

// --- reconcile --------------------------------------------------------------

export interface VoiceReconcileResult {
  /** Rows whose instance's lease expired this pass: seat held, socket gone. */
  orphaned: { peerId: string; channelId: string }[];
  /** Orphans of a dead instance past the resume window: gone, and retired. */
  removed: { peerId: string; channelId: string }[];
  /** Room rows with no peer row left. */
  roomsSwept: number;
  /** Lease rows of dead instances, dropped once their peers were orphaned. */
  instancesSwept: number;
}

/**
 * The instance lease's consequences. Every instance runs this after its own
 * heartbeat, and every statement is written so two instances running it in
 * the same second do no harm: each row is orphaned once (the `IS NULL`
 * guard), deleted once (`RETURNING` names the deleter), and the room sweep
 * and the retired sweep are plain idempotent deletes.
 *
 * A dead instance is one whose heartbeat is older than `ttlMs`, or one with
 * no lease row at all (a clean shutdown withdraws its row, and any peer row
 * it left behind is an orphan its own close handlers already stamped). This
 * instance's own rows are never touched: it is alive by definition, and its
 * own orphan timers are the authority on its own seats.
 *
 * `orphaned_at` is set to the dead lease's last heartbeat, not to now, so the
 * resume window is measured from the moment the instance stopped answering:
 * a client that comes back within `VOICE_RESUME_TTL_MS` of its machine dying
 * keeps its seat, one that does not is cleaned up by whoever is alive.
 *
 * Room rows are swept only once they are older than `roomGraceMs`, so a
 * room another instance pinned a moment ago and is about to write its first
 * peer into is left alone (`writePeer` re-asserts the row anyway).
 */
export async function reconcileVoiceRegistry(options: {
  instanceId?: string;
  ttlMs?: number;
  resumeTtlMs?: number;
  roomGraceMs?: number;
} = {}): Promise<VoiceReconcileResult> {
  const me = options.instanceId ?? INSTANCE_ID;
  const ttlMs = options.ttlMs ?? INSTANCE_TTL_MS;
  const resumeTtlMs = options.resumeTtlMs ?? VOICE_RESUME_TTL_MS;
  const roomGraceMs = options.roomGraceMs ?? 30_000;
  const pool = getPool();

  const orphaned = await pool.query<{ peer_id: string; channel_id: string }>(
    `UPDATE voice_peers p
        SET orphaned_at = COALESCE(i.heartbeat_at, NOW()), updated_at = NOW()
       FROM voice_peers q
       LEFT JOIN voice_instances i ON i.instance_id = q.instance_id
      WHERE q.peer_id = p.peer_id
        AND p.orphaned_at IS NULL
        AND p.instance_id <> $1
        AND (i.instance_id IS NULL
             OR i.heartbeat_at < NOW() - ($2::bigint * INTERVAL '1 millisecond'))
      RETURNING p.peer_id, p.channel_id`,
    [me, ttlMs],
  );

  // Delete, retire and unpin in one statement, so a resume racing this
  // pass either adopts the row (and the delete sees nothing) or finds it
  // gone *and* retired (and cold-joins). The room row goes with the last
  // peer exactly as in `deleteVoicePeer`.
  const removed = await pool.query<{ peer_id: string; channel_id: string }>(
    `WITH gone AS (
       DELETE FROM voice_peers p
        USING voice_peers q
        LEFT JOIN voice_instances i ON i.instance_id = q.instance_id
        WHERE q.peer_id = p.peer_id
          AND p.instance_id <> $1
          AND p.orphaned_at IS NOT NULL
          AND p.orphaned_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
          AND (i.instance_id IS NULL
               OR i.heartbeat_at < NOW() - ($2::bigint * INTERVAL '1 millisecond'))
        RETURNING p.peer_id, p.channel_id
     ),
     retired AS (
       INSERT INTO voice_retired_peers (peer_id)
       SELECT peer_id FROM gone
       ON CONFLICT (peer_id) DO UPDATE SET retired_at = NOW()
     ),
     unpinned AS (
       DELETE FROM voice_rooms r
        USING gone
        WHERE r.channel_id = gone.channel_id
          AND NOT EXISTS (
            SELECT 1 FROM voice_peers p
             WHERE p.channel_id = gone.channel_id
               AND p.peer_id <> ALL (SELECT peer_id FROM gone)
          )
     )
     SELECT peer_id, channel_id FROM gone`,
    [me, ttlMs, resumeTtlMs],
  );

  const rooms = await pool.query(
    `DELETE FROM voice_rooms r
      WHERE r.created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM voice_peers p WHERE p.channel_id = r.channel_id)`,
    [roomGraceMs],
  );

  // After the orphaning above, which is what needed the dead lease's
  // timestamp. Its peers are stamped; the lease itself is noise now.
  const instances = await pool.query(
    `DELETE FROM voice_instances
      WHERE instance_id <> $1
        AND heartbeat_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
    [me, ttlMs],
  );

  await sweepRetiredVoicePeerIds();

  const asPeer = (row: { peer_id: string; channel_id: string }) => ({
    peerId: row.peer_id,
    channelId: row.channel_id,
  });
  return {
    orphaned: orphaned.rows.map(asPeer),
    removed: removed.rows.map(asPeer),
    roomsSwept: rooms.rowCount ?? 0,
    instancesSwept: instances.rowCount ?? 0,
  };
}

// --- retired ids ------------------------------------------------------------

/** Block reconstruct of a hung-up id cluster-wide for the token's life. */
export function retireVoicePeerId(peerId: string): Promise<unknown> {
  return track(
    getPool().query(
      `INSERT INTO voice_retired_peers (peer_id) VALUES ($1)
       ON CONFLICT (peer_id) DO UPDATE SET retired_at = NOW()`,
      [peerId],
    ),
    "retirePeer",
  );
}

export async function isVoicePeerRetired(peerId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM voice_retired_peers
      WHERE peer_id = $1
        AND retired_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
    [peerId, VOICE_RESUME_TOKEN_TTL_MS],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Retired ids older than the token TTL can never be replayed; drop them. */
export async function sweepRetiredVoicePeerIds(): Promise<void> {
  await getPool().query(
    `DELETE FROM voice_retired_peers
      WHERE retired_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [VOICE_RESUME_TOKEN_TTL_MS],
  );
}

// --- instances --------------------------------------------------------------

export async function heartbeatVoiceInstance(
  instanceId = INSTANCE_ID,
  configHash = voiceConfigHash(),
): Promise<void> {
  await getPool().query(
    `INSERT INTO voice_instances (instance_id, config_hash, heartbeat_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (instance_id) DO UPDATE
       SET config_hash = EXCLUDED.config_hash, heartbeat_at = NOW()`,
    [instanceId, configHash],
  );
}

export async function withdrawVoiceInstance(
  instanceId = INSTANCE_ID,
): Promise<void> {
  await getPool().query(`DELETE FROM voice_instances WHERE instance_id = $1`, [
    instanceId,
  ]);
}

/** Instances whose heartbeat is within the TTL. */
export async function listLiveVoiceInstances(
  ttlMs = INSTANCE_TTL_MS,
): Promise<{ instanceId: string; configHash: string; heartbeatAt: Date }[]> {
  const result = await getPool().query<{
    instance_id: string;
    config_hash: string;
    heartbeat_at: Date;
  }>(
    `SELECT instance_id, config_hash, heartbeat_at
       FROM voice_instances
      WHERE heartbeat_at > NOW() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY heartbeat_at DESC`,
    [ttlMs],
  );
  return result.rows.map((row) => ({
    instanceId: row.instance_id,
    configHash: row.config_hash,
    heartbeatAt: row.heartbeat_at,
  }));
}

/**
 * Announce this instance every `INSTANCE_HEARTBEAT_MS`, then run `afterBeat`
 * (the reconcile in `ws/voice.ts`, which also sweeps expired retired ids).
 * The beat comes first so this instance is never dead by its own clock when
 * the reconcile reads the leases. Returns a stop function that withdraws
 * the row, so a clean shutdown is not mistaken for a crash for the next 45
 * seconds. One beat at a time: a slow database must not stack them.
 */
export function startVoiceInstanceHeartbeat(
  intervalMs = INSTANCE_HEARTBEAT_MS,
  afterBeat: () => Promise<unknown> = sweepRetiredVoicePeerIds,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  const beat = () => {
    if (running) {
      return running;
    }
    running = heartbeatVoiceInstance()
      .then(() => afterBeat())
      .then(
        () => undefined,
        (error: unknown) => {
          logEvent("voice.heartbeatFailed", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
  void beat();
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await running?.catch(() => {});
    await withdrawVoiceInstance().catch(() => {});
  };
}

// --- SFU re-sweep claims (M4) ------------------------------------------------
//
// `voice/admin.ts` re-runs an SFU eviction every few seconds for the token
// TTL, because a self-hosted LiveKit admits a removed participant again on
// the token they already hold. With one process that was a `setInterval`
// per key. With two, both would sweep the same room, and a deploy inside
// the window used to drop the remaining sweeps. So the sweep is a row, and
// a tick on any instance claims what is unclaimed: `UPDATE ... WHERE
// claimed_until < NOW() ... RETURNING *` is the whole election. At most one
// sweeper per key per claim window, no leader, and a row outlives the
// process that wrote it.

/** Cleared and re-set on every claim; slightly shorter than the tick so a stalled sweeper hands over within one interval. */
export const RESWEEP_CLAIM_MS = 4_000;

export interface VoiceResweepRow {
  key: string;
  scope: unknown;
  evictedAt: Date;
  until: Date;
}

/**
 * Register (or restart) a re-sweep. A second eviction under the same key
 * replaces the scope and pushes `until` out, exactly as the in-process timer
 * restarted its window. The writer has just run the first pass itself, so
 * the row starts claimed for one window: nobody else re-sweeps a room that
 * was swept a moment ago.
 */
export async function upsertVoiceResweep(
  key: string,
  scope: unknown,
  evictedAt: Date,
  until: Date,
): Promise<void> {
  await getPool().query(
    `INSERT INTO voice_resweeps (key, scope, evicted_at, until, claimed_until)
     VALUES ($1, $2::jsonb, $3, $4, NOW() + ($5::bigint * INTERVAL '1 millisecond'))
     ON CONFLICT (key) DO UPDATE
       SET scope = EXCLUDED.scope,
           evicted_at = EXCLUDED.evicted_at,
           until = EXCLUDED.until,
           claimed_until = EXCLUDED.claimed_until`,
    [key, JSON.stringify(scope), evictedAt, until, RESWEEP_CLAIM_MS],
  );
}

/**
 * One tick: delete what has expired, then claim every live row nobody holds.
 * The rows returned are this instance's to sweep, once, now. Two instances
 * ticking in the same instant cannot both get a row: the `UPDATE` takes the
 * row lock, and the second one re-evaluates `claimed_until < NOW()` against
 * the first one's write and skips it.
 */
export async function claimVoiceResweeps(): Promise<VoiceResweepRow[]> {
  const pool = getPool();
  await pool.query(`DELETE FROM voice_resweeps WHERE until <= NOW()`);
  const result = await pool.query<{
    key: string;
    scope: unknown;
    evicted_at: Date;
    until: Date;
  }>(
    `UPDATE voice_resweeps
        SET claimed_until = NOW() + ($1::bigint * INTERVAL '1 millisecond')
      WHERE claimed_until < NOW() AND until > NOW()
      RETURNING key, scope, evicted_at, until`,
    [RESWEEP_CLAIM_MS],
  );
  return result.rows.map((row) => ({
    key: row.key,
    scope: row.scope,
    evictedAt: row.evicted_at,
    until: row.until,
  }));
}

/** Whether any re-sweep is still inside its window (the process ticker stops when none is). */
export async function hasLiveVoiceResweeps(): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM voice_resweeps WHERE until > NOW() LIMIT 1`,
  );
  return result.rows.length > 0;
}
