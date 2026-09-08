import { getPool } from "../db.js";
import { logEvent } from "../lib/log.js";
import { processRole, servesTraffic } from "../lib/process-role.js";
import {
  isVoiceRegistryEnabled,
  listVoiceRoomsByTransport,
} from "../voice/registry.js";
import type { VoiceRoomTransport } from "@pqp/shared";

/**
 * How many people were in calls, minute by minute, split by media path.
 *
 * WHY THIS EXISTS
 * `GET /api/admin/metrics` is instantaneous. Its voice block is the peer map
 * as it stands at the moment of the request, its peak counter is per process,
 * and every deploy resets it, so after the evening a spike happened there was
 * nothing left to look at. This module is the persistence: one sampler, one
 * row a minute, two rollup peaks a day, and one authenticated read.
 *
 * WHERE IT READS FROM, AND WHY THAT ORDER
 *  1. `VOICE_REGISTRY=postgres`: `voice_rooms` joined to `voice_peers`, which
 *     is the whole cluster and carries the transport pin on the room row. This
 *     is the answer we want, and it is the only one a dedicated worker can
 *     give, because a worker holds no sockets.
 *  2. Registry off, and this process serves traffic: the in-process peer map,
 *     via `ws/voice.ts`. That is exact on a single machine, which is what a
 *     self-host and today's production are.
 *  3. Registry off, and this process is a dedicated worker: NOTHING IS
 *     RECORDED. The local map is empty there, and an empty map is
 *     indistinguishable from an empty building. Writing zeros would be the
 *     failure mode this repo keeps hitting: working and silently-not-working
 *     looking identical. It logs instead, and the endpoint reports the reason.
 *
 * DOUBLE WRITES
 * `bucket_at` is the truncated minute and the primary key, so the two
 * processes that briefly both run the cold jobs during a worker rollout write
 * the same row. The upsert keeps the larger reading rather than the later one:
 * with no lock and no leader election, two samplers converge on the busiest
 * observation of that minute instead of racing.
 */

export const ADMIN_VOICE_OCCUPANCY_PATH = "/api/admin/voice-occupancy";

/** One sampler tick a minute. Matches the status sampler next door. */
export const OCCUPANCY_SAMPLE_INTERVAL_MS = 60_000;

/**
 * Minute rows are kept for three weeks, then only the daily peaks survive.
 *
 * Three weeks is "long enough to look back at the last few weekends", which is
 * the only thing anybody has ever wanted the minute resolution for. A row is
 * about 60 bytes, so the minute table settles near 2 MB and the daily table
 * grows by 365 rows a year; the retention is not about disk, it is about the
 * table staying small enough that a full-day query never needs an index plan
 * anybody has to think about.
 */
export const OCCUPANCY_MINUTE_RETENTION_DAYS = 21;

/**
 * The timezone a "day" means on this dashboard.
 *
 * Not UTC, deliberately. The instance is Brazilian and voice peaks between
 * 21:00 and 01:00 BRT, which straddles UTC midnight. A UTC day would cut
 * every single peak in half and report two mediocre days instead of one busy
 * night. A self-host in another country changes this one constant.
 */
export const OCCUPANCY_TIMEZONE = "America/Sao_Paulo";

export type OccupancySource = "registry" | "local" | "unavailable";

export interface VoiceOccupancyReading {
  participants: number;
  meshParticipants: number;
  livekitParticipants: number;
  rooms: number;
  meshRooms: number;
  livekitRooms: number;
  /** The single busiest room at this instant, whichever path it is on. */
  largestRoom: number;
}

export const EMPTY_READING: VoiceOccupancyReading = {
  participants: 0,
  meshParticipants: 0,
  livekitParticipants: 0,
  rooms: 0,
  meshRooms: 0,
  livekitRooms: 0,
  largestRoom: 0,
};

/**
 * Fold one room-per-entry list into the row that gets stored.
 *
 * Pure, and shared by both read paths on purpose: the registry query and the
 * in-process map disagree about where the rooms come from and about nothing
 * else, so the arithmetic is tested once.
 */
export function aggregateRooms(
  rooms: { transport: VoiceRoomTransport; participants: number }[],
): VoiceOccupancyReading {
  const reading: VoiceOccupancyReading = { ...EMPTY_READING };
  for (const room of rooms) {
    if (room.participants <= 0) {
      // An empty room is not a room. The registry deletes the row with the
      // last peer, but a race can still hand us a zero.
      continue;
    }
    reading.participants += room.participants;
    reading.rooms += 1;
    if (room.transport === "livekit") {
      reading.livekitParticipants += room.participants;
      reading.livekitRooms += 1;
    } else {
      reading.meshParticipants += room.participants;
      reading.meshRooms += 1;
    }
    if (room.participants > reading.largestRoom) {
      reading.largestRoom = room.participants;
    }
  }
  return reading;
}

/**
 * The in-process peer map, with each room's pinned transport.
 *
 * Imported lazily so that `worker.ts`, which pulls in `jobs.ts`, never loads
 * the WebSocket module it has no sockets for.
 */
async function readLocalRooms(): Promise<
  { transport: VoiceRoomTransport; participants: number }[]
> {
  const { getVoiceActivitySnapshot, getRoomTransport } = await import(
    "../ws/voice.js"
  );
  const snapshot = await getVoiceActivitySnapshot();
  return snapshot.rooms.map((room) => ({
    transport: getRoomTransport(room.voiceChannelId),
    participants: room.participants,
  }));
}

/**
 * Read occupancy from the best source this process has, or say it has none.
 *
 * Never throws: a sampler that can bring the process down is worse than a gap
 * in a chart.
 */
export async function readVoiceOccupancy(): Promise<{
  source: OccupancySource;
  reading: VoiceOccupancyReading;
}> {
  if (isVoiceRegistryEnabled()) {
    try {
      const rooms = await listVoiceRoomsByTransport();
      return { source: "registry", reading: aggregateRooms(rooms) };
    } catch (error) {
      logEvent("voice.occupancy.readFailed", {
        source: "registry",
        error: error instanceof Error ? error.message : String(error),
      });
      return { source: "unavailable", reading: { ...EMPTY_READING } };
    }
  }
  if (!servesTraffic(processRole())) {
    // A dedicated worker with the registry off has no truth to report, and
    // zeros here would read as "nobody was in a call all week".
    return { source: "unavailable", reading: { ...EMPTY_READING } };
  }
  try {
    const rooms = await readLocalRooms();
    return { source: "local", reading: aggregateRooms(rooms) };
  } catch (error) {
    logEvent("voice.occupancy.readFailed", {
      source: "local",
      error: error instanceof Error ? error.message : String(error),
    });
    return { source: "unavailable", reading: { ...EMPTY_READING } };
  }
}

/**
 * Sample once and persist.
 *
 * Returns the source so a caller (and the tests) can tell "nobody was in a
 * call" from "this process cannot see who is in a call". Only the first of
 * those writes a row.
 */
let lastBlindWarningAt = 0;

/** An hour between warnings: loud enough to find, quiet enough to keep. */
const BLIND_WARNING_INTERVAL_MS = 60 * 60_000;

export async function recordVoiceOccupancySample(
  now: Date = new Date(),
): Promise<{ source: OccupancySource; written: boolean }> {
  const { source, reading } = await readVoiceOccupancy();
  if (source === "unavailable") {
    // The chart being empty and the sampler being blind look identical from
    // the dashboard, so the blind case says so out loud. The shape that gets
    // here on purpose is `WORKER_MODE=api` on the API plus a worker, with
    // `VOICE_REGISTRY` still off: nothing is wrong with either process, and
    // between them nobody can see a call.
    if (now.getTime() - lastBlindWarningAt > BLIND_WARNING_INTERVAL_MS) {
      lastBlindWarningAt = now.getTime();
      logEvent("voice.occupancy.blind", {
        role: processRole(),
        registry: isVoiceRegistryEnabled() ? "postgres" : "off",
      });
    }
    return { source, written: false };
  }
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const values = [
    bucket.toISOString(),
    reading.participants,
    reading.meshParticipants,
    reading.livekitParticipants,
    reading.rooms,
    reading.meshRooms,
    reading.livekitRooms,
    reading.largestRoom,
  ];
  const pool = getPool();
  await pool.query(
    `INSERT INTO voice_occupancy_samples
       (bucket_at, participants, mesh_participants, livekit_participants,
        rooms, mesh_rooms, livekit_rooms, largest_room)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (bucket_at) DO UPDATE SET
       participants         = GREATEST(voice_occupancy_samples.participants, EXCLUDED.participants),
       mesh_participants    = GREATEST(voice_occupancy_samples.mesh_participants, EXCLUDED.mesh_participants),
       livekit_participants = GREATEST(voice_occupancy_samples.livekit_participants, EXCLUDED.livekit_participants),
       rooms                = GREATEST(voice_occupancy_samples.rooms, EXCLUDED.rooms),
       mesh_rooms           = GREATEST(voice_occupancy_samples.mesh_rooms, EXCLUDED.mesh_rooms),
       livekit_rooms        = GREATEST(voice_occupancy_samples.livekit_rooms, EXCLUDED.livekit_rooms),
       largest_room         = GREATEST(voice_occupancy_samples.largest_room, EXCLUDED.largest_room)`,
    values,
  );
  // The daily peak is maintained here rather than by a nightly scan: it is one
  // GREATEST upsert on one row, it keeps today's bar correct on a dashboard
  // that is being watched *during* the spike, and it means the daily table is
  // never behind the minute table by more than a tick.
  await pool.query(
    `INSERT INTO voice_occupancy_daily
       (day, peak_participants, peak_mesh, peak_livekit, peak_rooms,
        peak_largest_room, samples)
     VALUES ((($1::timestamptz) AT TIME ZONE $7)::date, $2, $3, $4, $5, $6, 1)
     ON CONFLICT (day) DO UPDATE SET
       peak_participants = GREATEST(voice_occupancy_daily.peak_participants, EXCLUDED.peak_participants),
       peak_mesh         = GREATEST(voice_occupancy_daily.peak_mesh, EXCLUDED.peak_mesh),
       peak_livekit      = GREATEST(voice_occupancy_daily.peak_livekit, EXCLUDED.peak_livekit),
       peak_rooms        = GREATEST(voice_occupancy_daily.peak_rooms, EXCLUDED.peak_rooms),
       peak_largest_room = GREATEST(voice_occupancy_daily.peak_largest_room, EXCLUDED.peak_largest_room),
       samples           = voice_occupancy_daily.samples + 1`,
    [
      bucket.toISOString(),
      reading.participants,
      reading.meshParticipants,
      reading.livekitParticipants,
      reading.rooms,
      reading.largestRoom,
      OCCUPANCY_TIMEZONE,
    ],
  );
  return { source, written: true };
}

/**
 * Recompute the daily peaks from the minute rows still on disk, then drop the
 * ones that have aged out.
 *
 * The per-tick upsert above is exact while the sampler is running; this is
 * what heals the days it was not. Recomputing is a `GREATEST` against what is
 * already there, never an overwrite, because the minute rows for a day may
 * already have been pruned while the daily row remembers a bigger peak.
 */
export async function rollUpAndPruneVoiceOccupancy(): Promise<{
  daysRolledUp: number;
  minutesPruned: number;
}> {
  const pool = getPool();
  const rolled = await pool.query(
    `INSERT INTO voice_occupancy_daily
       (day, peak_participants, peak_mesh, peak_livekit, peak_rooms,
        peak_largest_room, samples)
     SELECT (bucket_at AT TIME ZONE $1)::date,
            MAX(participants), MAX(mesh_participants), MAX(livekit_participants),
            MAX(rooms), MAX(largest_room), COUNT(*)
       FROM voice_occupancy_samples
      GROUP BY 1
     ON CONFLICT (day) DO UPDATE SET
       peak_participants = GREATEST(voice_occupancy_daily.peak_participants, EXCLUDED.peak_participants),
       peak_mesh         = GREATEST(voice_occupancy_daily.peak_mesh, EXCLUDED.peak_mesh),
       peak_livekit      = GREATEST(voice_occupancy_daily.peak_livekit, EXCLUDED.peak_livekit),
       peak_rooms        = GREATEST(voice_occupancy_daily.peak_rooms, EXCLUDED.peak_rooms),
       peak_largest_room = GREATEST(voice_occupancy_daily.peak_largest_room, EXCLUDED.peak_largest_room),
       samples           = GREATEST(voice_occupancy_daily.samples, EXCLUDED.samples)`,
    [OCCUPANCY_TIMEZONE],
  );
  const pruned = await pool.query(
    `DELETE FROM voice_occupancy_samples
      WHERE bucket_at < NOW() - ($1 || ' days')::interval`,
    [OCCUPANCY_MINUTE_RETENTION_DAYS],
  );
  return {
    daysRolledUp: rolled.rowCount ?? 0,
    minutesPruned: pruned.rowCount ?? 0,
  };
}

export interface VoiceOccupancyPoint {
  /** `YYYY-MM-DD` for a daily point, an ISO timestamp for a minute point. */
  at: string;
  participants: number;
  mesh: number;
  livekit: number;
  rooms: number;
  meshRooms: number;
  livekitRooms: number;
  largestRoom: number;
}

export interface VoiceOccupancyReport {
  generatedAt: string;
  timezone: string;
  /** `day` points are peaks over that day; `minute` points are instantaneous. */
  granularity: "day" | "minute";
  sampleIntervalSeconds: number;
  minuteRetentionDays: number;
  /**
   * Proof the sampler is running. A chart of flat zeros and a chart of a
   * sampler that has been dead since the last deploy look the same, so the
   * dashboard is given the last sample's timestamp rather than left to guess.
   */
  lastSampleAt: string | null;
  from: string;
  to: string;
  points: VoiceOccupancyPoint[];
}

export const MAX_OCCUPANCY_DAYS = 365;
export const DEFAULT_OCCUPANCY_DAYS = 30;

export function clampOccupancyDays(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_OCCUPANCY_DAYS;
  }
  return Math.min(parsed, MAX_OCCUPANCY_DAYS);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` only. Anything else is not a day and is not guessed at. */
export function parseOccupancyDay(raw: string | null): string | null {
  if (!raw || !DAY_PATTERN.test(raw)) {
    return null;
  }
  const asDate = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(asDate.getTime()) ? null : raw;
}

async function readLastSampleAt(): Promise<string | null> {
  const result = await getPool().query<{ bucket_at: Date }>(
    `SELECT bucket_at FROM voice_occupancy_samples ORDER BY bucket_at DESC LIMIT 1`,
  );
  return result.rows[0]?.bucket_at?.toISOString() ?? null;
}

/**
 * The dashboard's read. Two shapes, one endpoint:
 *  - no `day`: one point per reporting day, each the peak of that day;
 *  - a `day`: one point per minute of that day, as sampled.
 */
export async function voiceOccupancyReport(options: {
  days?: number;
  day?: string | null;
}): Promise<VoiceOccupancyReport> {
  const lastSampleAt = await readLastSampleAt();
  const base = {
    generatedAt: new Date().toISOString(),
    timezone: OCCUPANCY_TIMEZONE,
    sampleIntervalSeconds: OCCUPANCY_SAMPLE_INTERVAL_MS / 1000,
    minuteRetentionDays: OCCUPANCY_MINUTE_RETENTION_DAYS,
    lastSampleAt,
  };

  if (options.day) {
    const result = await getPool().query<{
      bucket_at: Date;
      participants: number;
      mesh_participants: number;
      livekit_participants: number;
      rooms: number;
      mesh_rooms: number;
      livekit_rooms: number;
      largest_room: number;
    }>(
      `SELECT * FROM voice_occupancy_samples
        WHERE (bucket_at AT TIME ZONE $1)::date = $2::date
        ORDER BY bucket_at`,
      [OCCUPANCY_TIMEZONE, options.day],
    );
    return {
      ...base,
      granularity: "minute",
      from: options.day,
      to: options.day,
      points: result.rows.map((row) => ({
        at: row.bucket_at.toISOString(),
        participants: row.participants,
        mesh: row.mesh_participants,
        livekit: row.livekit_participants,
        rooms: row.rooms,
        meshRooms: row.mesh_rooms,
        livekitRooms: row.livekit_rooms,
        largestRoom: row.largest_room,
      })),
    };
  }

  const days = options.days ?? DEFAULT_OCCUPANCY_DAYS;
  const result = await getPool().query<{
    day: string;
    peak_participants: number;
    peak_mesh: number;
    peak_livekit: number;
    peak_rooms: number;
    peak_largest_room: number;
  }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day,
            peak_participants, peak_mesh, peak_livekit, peak_rooms, peak_largest_room
       FROM voice_occupancy_daily
      WHERE day > ((NOW() AT TIME ZONE $1)::date - $2::int)
      ORDER BY day`,
    [OCCUPANCY_TIMEZONE, days],
  );
  return {
    ...base,
    granularity: "day",
    from: result.rows[0]?.day ?? "",
    to: result.rows[result.rows.length - 1]?.day ?? "",
    points: result.rows.map((row) => ({
      at: row.day,
      participants: row.peak_participants,
      mesh: row.peak_mesh,
      livekit: row.peak_livekit,
      rooms: row.peak_rooms,
      // A daily rollup has no "rooms of each kind at the peak minute": the
      // peaks are independent maxima and splitting the room count that way
      // would invent a minute that never happened. The minute view has it.
      meshRooms: 0,
      livekitRooms: 0,
      largestRoom: row.peak_largest_room,
    })),
  };
}
