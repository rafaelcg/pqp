import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * The occupancy sampler, against a real database.
 *
 * Four things here are load-bearing, and each one is a way this could ship
 * looking healthy while recording nothing true:
 *
 *  1. **Where it reads from.** With `VOICE_REGISTRY=postgres` the answer must
 *     come from `voice_peers`, which is every machine, not from one process's
 *     map. A test that only ever runs single-instance cannot tell the two
 *     apart, so the registry cases here write rows for peers no process in
 *     this test holds a socket for, which is exactly the state a second API
 *     machine would produce.
 *  2. **Refusing to invent zeros.** A dedicated worker with the registry off
 *     can see nothing. Recording a zero there would draw a chart saying
 *     nobody was in a call all week, which is the failure mode this repo keeps
 *     hitting: working and silently-not-working looking identical.
 *  3. **Two writers, one row.** During a worker rollout both the API and the
 *     worker run the cold jobs. The minute is the primary key and the upsert
 *     keeps the larger reading, so the overlap costs a duplicate query and
 *     never a duplicated bar.
 *  4. **The daily peak surviving the prune.** Minute rows age out at three
 *     weeks; the daily rollup must not shrink when they do.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  aggregateRooms,
  clampOccupancyDays,
  parseOccupancyDay,
  readVoiceOccupancy,
  recordVoiceOccupancySample,
  rollUpAndPruneVoiceOccupancy,
  voiceOccupancyReport,
  DEFAULT_OCCUPANCY_DAYS,
  MAX_OCCUPANCY_DAYS,
  OCCUPANCY_MINUTE_RETENTION_DAYS,
  OCCUPANCY_TIMEZONE,
} = await import("./voice-occupancy.js");

describe("aggregateRooms", () => {
  it("splits people and rooms by the path the room is on", () => {
    const reading = aggregateRooms([
      { transport: "livekit", participants: 22 },
      { transport: "mesh", participants: 5 },
      { transport: "mesh", participants: 3 },
      { transport: "livekit", participants: 1 },
    ]);
    expect(reading).toEqual({
      participants: 31,
      meshParticipants: 8,
      livekitParticipants: 23,
      rooms: 4,
      meshRooms: 2,
      livekitRooms: 2,
      largestRoom: 22,
    });
  });

  it("does not count a room nobody is in", () => {
    const reading = aggregateRooms([
      { transport: "mesh", participants: 0 },
      { transport: "livekit", participants: 2 },
    ]);
    expect(reading.rooms).toBe(1);
    expect(reading.meshRooms).toBe(0);
    expect(reading.participants).toBe(2);
  });

  it("is all zeros when nobody is anywhere", () => {
    expect(aggregateRooms([]).participants).toBe(0);
    expect(aggregateRooms([]).largestRoom).toBe(0);
  });
});

describe("range parsing", () => {
  it("defaults, floors and caps the day count", () => {
    expect(clampOccupancyDays(null)).toBe(DEFAULT_OCCUPANCY_DAYS);
    expect(clampOccupancyDays("")).toBe(DEFAULT_OCCUPANCY_DAYS);
    expect(clampOccupancyDays("nope")).toBe(DEFAULT_OCCUPANCY_DAYS);
    expect(clampOccupancyDays("0")).toBe(DEFAULT_OCCUPANCY_DAYS);
    expect(clampOccupancyDays("-7")).toBe(DEFAULT_OCCUPANCY_DAYS);
    expect(clampOccupancyDays("7")).toBe(7);
    expect(clampOccupancyDays("99999")).toBe(MAX_OCCUPANCY_DAYS);
  });

  it("takes a day only in the one shape, and never guesses", () => {
    expect(parseOccupancyDay("2026-09-06")).toBe("2026-09-06");
    expect(parseOccupancyDay(null)).toBeNull();
    expect(parseOccupancyDay("2026-9-6")).toBeNull();
    expect(parseOccupancyDay("06/09/2026")).toBeNull();
    expect(parseOccupancyDay("yesterday")).toBeNull();
    expect(parseOccupancyDay("2026-13-45")).toBeNull();
  });
});

describeDb("voice occupancy sampler", () => {
  const roomIds: string[] = [];

  /** A room somebody is in, as the registry would have written it. */
  async function seedRoom(
    transport: "mesh" | "livekit",
    participants: number,
  ): Promise<void> {
    const channelId = randomUUID();
    roomIds.push(channelId);
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, $2)`,
      [channelId, transport],
    );
    for (let i = 0; i < participants; i += 1) {
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), channelId, randomUUID(), randomUUID(), `p${i}`],
      );
    }
  }

  async function seedMinute(
    minutesAgo: number,
    participants: number,
    mesh: number,
    livekit: number,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO voice_occupancy_samples
         (bucket_at, participants, mesh_participants, livekit_participants,
          rooms, mesh_rooms, livekit_rooms, largest_room)
       VALUES (date_trunc('minute', NOW() - ($1 || ' minutes')::interval),
               $2, $3, $4, 1, 1, 1, $2)`,
      [minutesAgo, participants, mesh, livekit],
    );
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    delete process.env.VOICE_REGISTRY;
    delete process.env.WORKER_MODE;
    await closePool();
  });

  beforeEach(async () => {
    roomIds.length = 0;
    await getPool().query(
      `TRUNCATE voice_occupancy_samples, voice_occupancy_daily, voice_peers, voice_rooms CASCADE`,
    );
  });

  afterEach(() => {
    delete process.env.VOICE_REGISTRY;
    delete process.env.WORKER_MODE;
  });

  it("reads the whole cluster from the registry, not one process's map", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    // Peers no process in this test holds a socket for: the state a second
    // API machine produces, and the reason this is not the in-memory map.
    await seedRoom("livekit", 22);
    await seedRoom("mesh", 4);

    const { source, reading } = await readVoiceOccupancy();
    expect(source).toBe("registry");
    expect(reading.participants).toBe(26);
    expect(reading.livekitParticipants).toBe(22);
    expect(reading.meshParticipants).toBe(4);
    expect(reading.rooms).toBe(2);
    expect(reading.largestRoom).toBe(22);
  });

  it("writes exactly one row per minute", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    await seedRoom("mesh", 3);

    const minute = new Date("2026-09-06T22:04:37.812Z");
    const result = await recordVoiceOccupancySample(minute);
    expect(result).toEqual({ source: "registry", written: true });

    const rows = await getPool().query<{ bucket_at: Date; participants: number }>(
      `SELECT bucket_at, participants FROM voice_occupancy_samples`,
    );
    expect(rows.rowCount).toBe(1);
    // Truncated to the minute, so the key is the bucket and not the instant.
    expect(rows.rows[0]!.bucket_at.toISOString()).toBe("2026-09-06T22:04:00.000Z");
    expect(rows.rows[0]!.participants).toBe(3);
  });

  it("does not double-write when two workers overlap, and keeps the busier reading", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    const minute = new Date("2026-09-06T22:04:10.000Z");

    await seedRoom("livekit", 9);
    await recordVoiceOccupancySample(minute);

    // The second runner samples the same minute a few seconds later, with one
    // more person in the room. One row, and it is the larger reading.
    await getPool().query(
      `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
       VALUES ($1, $2, $3, $4, 'late')`,
      [randomUUID(), roomIds[0], randomUUID(), randomUUID()],
    );
    await recordVoiceOccupancySample(new Date("2026-09-06T22:04:58.000Z"));

    const rows = await getPool().query<{ participants: number; livekit_participants: number }>(
      `SELECT participants, livekit_participants FROM voice_occupancy_samples`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.participants).toBe(10);
    expect(rows.rows[0]!.livekit_participants).toBe(10);

    // And the day counted it once as a peak, not twice as a sum.
    const daily = await getPool().query<{ peak_participants: number }>(
      `SELECT peak_participants FROM voice_occupancy_daily`,
    );
    expect(daily.rowCount).toBe(1);
    expect(daily.rows[0]!.peak_participants).toBe(10);
  });

  it("keeps the day's peak rather than its last reading", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    await seedRoom("livekit", 40);
    await recordVoiceOccupancySample(new Date("2026-09-06T23:00:00.000Z"));
    await getPool().query(`TRUNCATE voice_peers, voice_rooms CASCADE`);
    roomIds.length = 0;
    await seedRoom("mesh", 2);
    await recordVoiceOccupancySample(new Date("2026-09-06T23:30:00.000Z"));

    const daily = await getPool().query<{
      day: string;
      peak_participants: number;
      peak_livekit: number;
      peak_mesh: number;
      samples: number;
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, peak_participants, peak_livekit,
              peak_mesh, samples FROM voice_occupancy_daily`,
    );
    expect(daily.rowCount).toBe(1);
    expect(daily.rows[0]!.peak_participants).toBe(40);
    expect(daily.rows[0]!.peak_livekit).toBe(40);
    // Independent maxima: the mesh peak is from the minute the total was 2.
    expect(daily.rows[0]!.peak_mesh).toBe(2);
    expect(daily.rows[0]!.samples).toBe(2);
  });

  it("records nothing at all in a worker that cannot see the calls", async () => {
    // Registry off and no sockets in this process: the local map is empty, and
    // an empty map here means "cannot see", not "nobody is talking".
    delete process.env.VOICE_REGISTRY;
    process.env.WORKER_MODE = "worker";

    const read = await readVoiceOccupancy();
    expect(read.source).toBe("unavailable");

    const result = await recordVoiceOccupancySample(new Date());
    expect(result).toEqual({ source: "unavailable", written: false });
    const rows = await getPool().query(`SELECT 1 FROM voice_occupancy_samples`);
    expect(rows.rowCount).toBe(0);
  });

  it("falls back to the local map in the process that holds the sockets", async () => {
    delete process.env.VOICE_REGISTRY;
    delete process.env.WORKER_MODE;
    const result = await recordVoiceOccupancySample(new Date());
    expect(result.source).toBe("local");
    expect(result.written).toBe(true);
  });

  it("rolls minute rows up before dropping the ones that aged out", async () => {
    const stale = OCCUPANCY_MINUTE_RETENTION_DAYS * 24 * 60 + 60;
    await seedMinute(stale, 55, 10, 45);
    await seedMinute(30, 4, 4, 0);

    const first = await rollUpAndPruneVoiceOccupancy();
    expect(first.minutesPruned).toBe(1);
    const daily = await getPool().query<{ peak_participants: number }>(
      `SELECT peak_participants FROM voice_occupancy_daily ORDER BY day`,
    );
    expect(daily.rows.map((r) => r.peak_participants)).toContain(55);

    const second = await rollUpAndPruneVoiceOccupancy();
    expect(second.minutesPruned).toBe(0);
  });

  it("never lowers a day's peak when its busiest minutes are already gone", async () => {
    // The state at the retention edge: the daily row remembers a 55 whose
    // minute rows have been dropped, and only a quiet 4 from the same day is
    // still on disk. Recomputing from what survives must not walk the peak
    // down to 4, which is the whole reason the rollup is a GREATEST.
    await getPool().query(
      `INSERT INTO voice_occupancy_daily
         (day, peak_participants, peak_mesh, peak_livekit, peak_rooms, peak_largest_room, samples)
       VALUES (date_trunc('minute', NOW() - INTERVAL '1 day') AT TIME ZONE $1,
               55, 10, 45, 7, 30, 1440)`,
      [OCCUPANCY_TIMEZONE],
    );
    await seedMinute(24 * 60, 4, 4, 0);

    await rollUpAndPruneVoiceOccupancy();

    const daily = await getPool().query<{
      peak_participants: number;
      peak_mesh: number;
      peak_livekit: number;
      peak_largest_room: number;
    }>(
      `SELECT peak_participants, peak_mesh, peak_livekit, peak_largest_room
         FROM voice_occupancy_daily
        ORDER BY day DESC LIMIT 1`,
    );
    expect(daily.rows[0]!.peak_participants).toBe(55);
    expect(daily.rows[0]!.peak_livekit).toBe(45);
    expect(daily.rows[0]!.peak_mesh).toBe(10);
    expect(daily.rows[0]!.peak_largest_room).toBe(30);
  });
});

describeDb("voice occupancy report", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE voice_occupancy_samples, voice_occupancy_daily`,
    );
  });

  it("answers with daily peaks by default, and says when it last sampled", async () => {
    await getPool().query(
      `INSERT INTO voice_occupancy_daily
         (day, peak_participants, peak_mesh, peak_livekit, peak_rooms, peak_largest_room, samples)
       VALUES ((NOW() AT TIME ZONE $1)::date - 1, 41, 8, 39, 6, 22, 1440),
              ((NOW() AT TIME ZONE $1)::date, 12, 12, 0, 3, 5, 700)`,
      [OCCUPANCY_TIMEZONE],
    );
    await getPool().query(
      `INSERT INTO voice_occupancy_samples
         (bucket_at, participants, mesh_participants, livekit_participants,
          rooms, mesh_rooms, livekit_rooms, largest_room)
       VALUES (date_trunc('minute', NOW()), 12, 12, 0, 3, 3, 0, 5)`,
    );

    const report = await voiceOccupancyReport({ days: 30, day: null });
    expect(report.granularity).toBe("day");
    expect(report.timezone).toBe(OCCUPANCY_TIMEZONE);
    expect(report.points).toHaveLength(2);
    expect(report.points[0]!.participants).toBe(41);
    expect(report.points[0]!.livekit).toBe(39);
    expect(report.points[0]!.mesh).toBe(8);
    expect(report.lastSampleAt).not.toBeNull();
  });

  it("honours the range instead of returning everything", async () => {
    await getPool().query(
      `INSERT INTO voice_occupancy_daily
         (day, peak_participants, peak_mesh, peak_livekit, peak_rooms, peak_largest_room)
       SELECT ((NOW() AT TIME ZONE $1)::date - g), g, g, 0, 1, g
         FROM generate_series(0, 40) AS g`,
      [OCCUPANCY_TIMEZONE],
    );
    expect((await voiceOccupancyReport({ days: 7, day: null })).points).toHaveLength(7);
    expect((await voiceOccupancyReport({ days: 30, day: null })).points).toHaveLength(30);
  });

  it("drops to minute resolution for one named day", async () => {
    await getPool().query(
      `INSERT INTO voice_occupancy_samples
         (bucket_at, participants, mesh_participants, livekit_participants,
          rooms, mesh_rooms, livekit_rooms, largest_room)
       VALUES ('2026-09-06T23:00:00Z', 30, 2, 28, 4, 1, 3, 20),
              ('2026-09-06T23:01:00Z', 31, 2, 29, 4, 1, 3, 21),
              ('2026-09-08T23:00:00Z', 9, 9, 0, 1, 1, 0, 9)`,
    );
    // 23:00Z on the 6th is 20:00 in the reporting timezone, same calendar day.
    const report = await voiceOccupancyReport({ day: "2026-09-06" });
    expect(report.granularity).toBe("minute");
    expect(report.points).toHaveLength(2);
    expect(report.points[0]!.participants).toBe(30);
    expect(report.points[1]!.livekit).toBe(29);
    expect(report.from).toBe("2026-09-06");
  });

  it("is an empty series, not an error, before the sampler has ever run", async () => {
    const report = await voiceOccupancyReport({ days: 30, day: null });
    expect(report.points).toEqual([]);
    expect(report.lastSampleAt).toBeNull();
  });
});
