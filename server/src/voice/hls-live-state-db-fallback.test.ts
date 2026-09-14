import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `GET /api/channels/:channelId/live` across two instances, the M6 gap this
 * file exists to close.
 *
 * `getChannelLiveState` (`server/src/ws/voice.ts`) answers from three
 * in-process maps -- `liveHlsStreamFor` (`rooms` in `hls-egress.ts`),
 * `llStreamFor`, `hlsAudience.stream` -- every one of them populated only on
 * the instance that started or adopted the session. None of them are shared
 * over `CLUSTER_BUS` the way chat and roster are, so on two machines a
 * viewer whose request lands on the OTHER instance from the one running the
 * egress read `stream: null` for a party that was, in fact, live: found live
 * on staging on 2026-09-14 while closing the M6 rehearsal's named gaps
 * (`docs/plans/M6_REHEARSAL_2026-09-14b.md`, "Gap closure (evening)").
 *
 * The fix, `liveHlsStreamFromDb`, is a fourth and LAST resort: one query
 * against `hls_sessions`, the one piece of this feature that was already
 * durable and shared (`adoptLiveHlsSession` already reads it after a
 * restart, for the identical reason). This file proves the fallback fires
 * exactly when the other three do not, and stays silent when any of them
 * already has an answer -- a session this same process is running must never
 * pay a Postgres round trip to answer a question its own memory already
 * knows.
 *
 * Real Postgres, no mocked egress module: skips without one, like
 * `voice-roster-delta-registry.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const {
  liveHlsStreamFromDb,
  viewerPlaylistUrl,
  resetLiveHlsForTests,
  setLiveHlsTestHooks,
} = await import("./hls-egress.js");
const { getChannelLiveState, resetHlsAudience } = await import("../ws/voice.js");

async function insertChannel(id: string): Promise<void> {
  await getPool().query(
    `INSERT INTO channels (id, server_id, name, type, kind)
     VALUES ($1, NULL, 'gap-test', 'watch_party', 'dm')`,
    [id],
  );
}

async function insertSession(
  channelId: string,
  overrides: Partial<{
    startedAt: Date;
    endedAt: Date | null;
    presenterPeerId: string | null;
    mode: string;
  }> = {},
): Promise<void> {
  const startedAt = overrides.startedAt ?? new Date();
  await getPool().query(
    `INSERT INTO hls_sessions
       (channel_id, object_prefix, started_at, ended_at, presenter_peer_id, mode)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      channelId,
      `live/${channelId}/${startedAt.getTime()}-720p30-${randomUUID()}`,
      startedAt,
      overrides.endedAt === undefined ? null : overrides.endedAt,
      overrides.presenterPeerId === undefined
        ? randomUUID()
        : overrides.presenterPeerId,
      overrides.mode ?? "conventional",
    ],
  );
}

describeDb("live HLS state, a second instance's fallback to hls_sessions", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(() => {
    resetLiveHlsForTests();
    resetHlsAudience();
  });

  afterEach(async () => {
    setLiveHlsTestHooks({ egress: null, findTracks: null, playlistProbe: null });
    await getPool().query(`TRUNCATE hls_sessions, channels CASCADE`);
  });

  it("liveHlsStreamFromDb answers null for a channel with no session row", async () => {
    const channelId = randomUUID();
    await insertChannel(channelId);
    expect(await liveHlsStreamFromDb(channelId)).toBeNull();
  });

  it("liveHlsStreamFromDb answers null once the session has ended", async () => {
    const channelId = randomUUID();
    await insertChannel(channelId);
    await insertSession(channelId, { endedAt: new Date() });
    expect(await liveHlsStreamFromDb(channelId)).toBeNull();
  });

  it("liveHlsStreamFromDb reconstructs hlsUrl/startedAt/presenterPeerId for a live row", async () => {
    const channelId = randomUUID();
    const presenterPeerId = randomUUID();
    const startedAt = new Date("2026-09-14T12:00:00.000Z");
    await insertChannel(channelId);
    await insertSession(channelId, { startedAt, presenterPeerId });

    const stream = await liveHlsStreamFromDb(channelId);
    expect(stream).not.toBeNull();
    expect(stream!.presenterPeerId).toBe(presenterPeerId);
    expect(stream!.startedAt).toBe(startedAt.getTime());
    expect(stream!.hlsUrl).toBe(
      viewerPlaylistUrl(channelId, startedAt.getTime()),
    );
  });

  it("liveHlsStreamFromDb picks the most recent live row when more than one exists (a restart mid-party)", async () => {
    const channelId = randomUUID();
    const olderPeer = randomUUID();
    const newerPeer = randomUUID();
    await insertChannel(channelId);
    await insertSession(channelId, {
      startedAt: new Date("2026-09-14T11:00:00.000Z"),
      endedAt: new Date("2026-09-14T11:05:00.000Z"),
      presenterPeerId: olderPeer,
    });
    await insertSession(channelId, {
      startedAt: new Date("2026-09-14T12:00:00.000Z"),
      presenterPeerId: newerPeer,
    });

    const stream = await liveHlsStreamFromDb(channelId);
    expect(stream!.presenterPeerId).toBe(newerPeer);
  });

  it("getChannelLiveState falls back to the DB when this process's own maps know nothing", async () => {
    const channelId = randomUUID();
    const presenterPeerId = randomUUID();
    await insertChannel(channelId);
    await insertSession(channelId, { presenterPeerId });

    // This process never ran or adopted the egress: `rooms`, `llStreamFor`
    // and `hlsAudience` are all empty for this channel, exactly the shape of
    // the OTHER instance in a two-machine deployment.
    const state = await getChannelLiveState(channelId);
    expect(state.stream).not.toBeNull();
    expect(state.stream!.presenterPeerId).toBe(presenterPeerId);
  });

  it("getChannelLiveState answers null, and does not throw, for a channel with no session row at all", async () => {
    // No `channels` row either: the fallback query has no FK-dependent join,
    // so an id nothing in this database has ever heard of is exactly what a
    // channel that has never run a watch party looks like, and it must not
    // be distinguishable from a network or query failure by throwing.
    const channelId = randomUUID();
    const state = await getChannelLiveState(channelId);
    expect(state.stream).toBeNull();
    expect(state.watching).toBe(0);
    expect(state.participants).toBe(0);
  });
});
