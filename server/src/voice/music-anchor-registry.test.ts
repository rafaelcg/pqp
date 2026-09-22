import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MUSIC_POSITION_TOLERANCE_MS, type MusicState } from "@pqp/shared";

/**
 * The room's clock across instances, against a real Postgres.
 *
 * The anchor has to travel with the queue or the two machines disagree
 * about where the room is. A manager's seek accepted on `api-a` reaches
 * `api-b` as an absolute state; if `api-b` kept its own anchor it would not
 * know the frame was a manager's, and would then clamp every honest sample
 * on its half of the room back by the size of the seek. This pins the row
 * half of that: the anchor goes in with the queue and comes back out, and a
 * second instance that adopts both does not clamp.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const track = {
  id: "t1",
  provider: "youtube" as const,
  videoId: "dQw4w9WgXcQ",
  title: "Track",
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: 300_000,
  addedByUserId: "11111111-1111-4111-8111-111111111111",
  addedByName: "Ana",
};

const state = (overrides: Partial<MusicState> = {}): MusicState => ({
  current: track,
  queue: [],
  status: "playing",
  positionMs: 0,
  atMs: Date.now(),
  rev: 1,
  actorId: "peer-a",
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
  autoplay: false,
  ...overrides,
});

describeDb("the room's clock in the registry row", () => {
  let channelId: string;

  // The anchor columns are added by `schema.sql`, which runs on boot. The
  // test database gets them the same way.
  beforeAll(async () => {
    const { initDb } = await import("../db.js");
    await initDb();
  }, 60_000);

  beforeEach(async () => {
    const { getPool } = await import("../db.js");
    const { resetMusicForTests } = await import("../ws/music.js");
    resetMusicForTests();
    channelId = randomUUID();
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport) VALUES ($1, 'mesh')
         ON CONFLICT (channel_id) DO NOTHING`,
      [channelId],
    );
  });

  afterAll(async () => {
    const { getPool, closePool } = await import("../db.js");
    await getPool().query(`DELETE FROM voice_rooms WHERE transport = 'mesh'
      AND created_at < NOW() - INTERVAL '1 day'`);
    await closePool();
  });

  it("carries the anchor in with the queue and hands it back", async () => {
    const { persistMusic, readMusicWithAnchor } = await import("./registry.js");
    const at = Date.now();
    const written = await persistMusic(channelId, state({ positionMs: 150_000 }), {
      positionMs: 150_000,
      at,
    });
    expect(written.kind).toBe("updated");

    const row = await readMusicWithAnchor(channelId);
    expect(row?.state?.current?.id).toBe("t1");
    expect(row?.anchor?.positionMs).toBe(150_000);
    // Postgres keeps milliseconds, so this is exact rather than close.
    expect(row?.anchor?.at).toBe(at);
  });

  it("leaves the anchor alone for a write that did not set one", async () => {
    const { persistMusic, readMusicWithAnchor } = await import("./registry.js");
    const at = Date.now();
    await persistMusic(channelId, state({ positionMs: 150_000 }), {
      positionMs: 150_000,
      at,
    });
    await persistMusic(
      channelId,
      state({ positionMs: 151_000, rev: 2, actorId: "peer-b" }),
      null,
    );
    const row = await readMusicWithAnchor(channelId);
    expect(row?.state?.rev).toBe(2);
    expect(row?.anchor?.positionMs).toBe(150_000);
  });

  /*
   * A LOSER IS HANDED THE WINNER'S CLOCK TOO.
   *
   * `persistMusic` answering "stale" is how an instance that missed a frame
   * learns what the cluster holds, and the caller adopts that queue. Reading
   * it back without the anchor left this instance holding the winner's queue
   * and its own pre-seek clock, so the next honest sample was clamped back
   * and, being a higher rev, won the row and undid the seek for everybody.
   */
  it("hands the loser the row's clock with the row's queue", async () => {
    const { persistMusic } = await import("./registry.js");
    const at = Date.now();
    const winner = state({ positionMs: 150_000, rev: 9, actorId: "peer-a" });
    await persistMusic(channelId, winner, { positionMs: 150_000, at });

    const lost = await persistMusic(
      channelId,
      state({ positionMs: 1_000, rev: 4, actorId: "peer-b" }),
      { positionMs: 1_000, at },
    );
    expect(lost.kind).toBe("stale");
    if (lost.kind !== "stale") {
      return;
    }
    expect(lost.held?.rev).toBe(9);
    expect(lost.anchor?.positionMs).toBe(150_000);
    expect(lost.anchor?.at).toBe(at);
  });

  it("does not clamp an honest sample on the instance that adopted the seek", async () => {
    const { persistMusic, readMusicWithAnchor } = await import("./registry.js");
    const {
      adoptMusicAnchor,
      adoptMusicState,
      applyMusicWrite,
      getMusicState,
    } = await import("../ws/music.js");

    // api-a: the manager seeks to 2:30 and the row takes the clock with it.
    const seekAt = Date.now();
    const seeked = state({ positionMs: 150_000, rev: 2, actorId: "peer-a" });
    await persistMusic(channelId, seeked, { positionMs: 150_000, at: seekAt });

    // api-b: a cold cache reads the row, queue and clock together.
    const row = await readMusicWithAnchor(channelId);
    adoptMusicState(channelId, row?.state ?? null);
    adoptMusicAnchor(channelId, row?.anchor ?? null);

    // A listener on api-b samples honestly, a second past the seek.
    const held = getMusicState(channelId) as MusicState;
    const write = applyMusicWrite(
      channelId,
      { ...held, positionMs: 151_000, rev: held.rev + 1, actorId: "peer-z" },
      {
        userId: "u9",
        canManage: false,
        canAdd: false,
        roomSize: 3,
        peerId: "peer-z",
        seatedUserIds: ["u9"],
      },
    );
    expect(write.kind).toBe("accepted");
    const after = getMusicState(channelId) as MusicState;
    expect(after.positionMs).toBe(151_000);
    expect(after.positionMs).toBeGreaterThan(MUSIC_POSITION_TOLERANCE_MS);
  });
});
