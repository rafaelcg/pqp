import { createHash } from "node:crypto";
import type { VoiceRoomTransport, WatchPartyState } from "@pqp/shared";
import { getPool } from "../db.js";
import { INSTANCE_ID } from "../lib/bus.js";
import { logEvent } from "../lib/log.js";
import { VOICE_RESUME_TOKEN_TTL_MS } from "../ws/voice-resume-token.js";

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
 * Cross-instance resume and the dead-instance reconcile are M3.
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
    return won;
  }
  const existing = await readVoiceRoomTransport(channelId);
  if (existing) {
    return existing;
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
  return retry.rows[0]?.transport ?? (await readVoiceRoomTransport(channelId)) ?? wanted;
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
    canResume: row.can_resume,
    orphanedAt: row.orphaned_at,
  };
}

const PEER_COLUMNS = `peer_id, channel_id, user_id, instance_id, display_name, avatar_url,
       muted, deafened, sharing_screen, camera_stream_id, screen_audio_stream_id,
       can_speak, can_resume, orphaned_at`;

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
           screen_audio_stream_id, can_speak, can_resume, orphaned_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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

export interface VoiceRoomRoster {
  channelId: string;
  transport: VoiceRoomTransport;
  peers: VoicePeerRow[];
}

interface RosterDbRow extends VoicePeerDbRow {
  room_channel_id: string;
  transport: VoiceRoomTransport;
}

const ROSTER_SELECT = `SELECT r.channel_id AS room_channel_id, r.transport,
       p.peer_id, p.channel_id, p.user_id, p.instance_id, p.display_name,
       p.avatar_url, p.muted, p.deafened, p.sharing_screen, p.camera_stream_id,
       p.screen_audio_stream_id, p.can_speak, p.can_resume, p.orphaned_at
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
      room.peers.push(mapRow(row));
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
async function sweepRetiredVoicePeerIds(): Promise<void> {
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
 * Announce this instance every `INSTANCE_HEARTBEAT_MS`, and take the chance
 * to sweep expired retired ids (cheap, indexed on the primary key only, and
 * it has to run somewhere). Dead instance rows are left for M3's reconcile,
 * which is where "this instance is dead" gets its consequences. Returns a
 * stop function that withdraws the row, so a clean shutdown is not mistaken
 * for a crash for the next 45 seconds.
 */
export function startVoiceInstanceHeartbeat(
  intervalMs = INSTANCE_HEARTBEAT_MS,
): () => Promise<void> {
  const beat = () =>
    heartbeatVoiceInstance()
      .then(() => sweepRetiredVoicePeerIds())
      .catch((error: unknown) => {
        logEvent("voice.heartbeatFailed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  void beat();
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await withdrawVoiceInstance().catch(() => {});
  };
}
