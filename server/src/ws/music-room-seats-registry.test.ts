import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * WHO IS SEATED, WITH `VOICE_REGISTRY=postgres`, WHICH IS HOW PRODUCTION RUNS.
 *
 * A skip vote is counted against the people still in the room, and a room
 * can span two machines. This instance's own peer map is not that room, so
 * with the registry on the seats come from `voice_peers` and only fall back
 * to the local map when the read fails. Nothing pinned that, which is the
 * shape of pitfall 12: the flag that changes the code path was not the flag
 * the tests exercised.
 *
 * Skips without a database.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

describeDb("the seats a skip vote is counted against", () => {
  let channelId: string;
  const previousMode = process.env.VOICE_REGISTRY;

  beforeAll(async () => {
    const { initDb } = await import("../db.js");
    await initDb();
  }, 60_000);

  beforeEach(async () => {
    const { getPool } = await import("../db.js");
    channelId = randomUUID();
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, 'mesh')
         ON CONFLICT (channel_id) DO NOTHING`,
      [channelId],
    );
  });

  afterAll(async () => {
    const { closePool } = await import("../db.js");
    if (previousMode === undefined) {
      delete process.env.VOICE_REGISTRY;
    } else {
      process.env.VOICE_REGISTRY = previousMode;
    }
    await closePool();
  });

  async function seat(userId: string) {
    const { getPool } = await import("../db.js");
    await getPool().query(
      `INSERT INTO voice_peers
         (peer_id, channel_id, user_id, instance_id, display_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), channelId, userId, randomUUID(), `User ${userId.slice(0, 4)}`],
    );
  }

  it("reads the cluster's seats, not this instance's empty map", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    const { musicRoomSeats } = await import("./voice.js");
    const ana = randomUUID();
    const bia = randomUUID();
    await seat(ana);
    await seat(bia);

    const seats = await musicRoomSeats(channelId);
    expect(seats.roomSize).toBe(2);
    expect([...seats.seatedUserIds].sort()).toEqual([ana, bia].sort());
  });

  it("answers from this instance alone when the flag is off", async () => {
    process.env.VOICE_REGISTRY = "";
    const { musicRoomSeats } = await import("./voice.js");
    await seat(randomUUID());
    const seats = await musicRoomSeats(channelId);
    // Nobody is connected to THIS process, so the row above is not its room.
    expect(seats.roomSize).toBe(0);
    expect(seats.seatedUserIds).toEqual([]);
  });
});
