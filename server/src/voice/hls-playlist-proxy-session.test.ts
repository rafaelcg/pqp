import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHICH SESSION THE PLAYLIST PROXY WILL SERVE, against a real Postgres.
 *
 * Real, and not the mocked pool the rest of `hls-playlist-proxy.test.ts` uses,
 * for the reason `hls-cleanup.test.ts` gives for the same choice: **the SQL
 * predicate itself is the thing being proved**, and a mock that returns a
 * fixed `rowCount` cannot tell one predicate from another. The clause under
 * test was wrong for the whole life of the feature and a mocked pool would
 * have passed either way.
 *
 * THE FAILURE THIS PINS, read from the production bucket on 2026-09-09. A
 * watch party's session was superseded at 14:23:40 and the earlier session's
 * live playlist still had a LastModified one second old at 14:27:50, with its
 * newest entry seven minutes stale: a LiveKit egress whose input track is gone
 * keeps rewriting its playlist and produces no new segments. The proxy asked
 * only `cleaned_at IS NULL`, which after retention was raised to 180 minutes
 * means "these objects have not been deleted in the last three hours", so it
 * served that corpse as if it were live. A player on it polls a file whose
 * mtime keeps moving, concludes the stream is live, drains its buffer, retries
 * every ten to twenty seconds, and on iOS never recovers, because there is
 * nothing to recover to.
 *
 * The bucket is faked (the signing is proved in `lib/s3.test.ts`); the rows
 * and the query are real.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";

const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "seg_00000.ts",
].join("\n");

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  buildMasterPlaylistFor,
  buildSignedPlaylist,
  HlsPlaylistNotFound,
  resetHlsPlaylistCacheForTests,
} = await import("./hls-playlist-proxy.js");

const STARTED_AT = 1_788_962_552_321;

describeDb("the playlist proxy only serves a session that is still live", () => {
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    resetHlsPlaylistCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(PLAYLIST_BODY, { status: 200 })),
    );
    const user = await upsertUser({
      clerkId: "clerk_hls_proxy_session",
      displayName: "Proxy Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'cinema', 'watch_party', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function session(options: {
    rung: string;
    ended: boolean;
    cleaned?: boolean;
    startedAt?: number;
  }): Promise<void> {
    const startedAt = options.startedAt ?? STARTED_AT;
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, rung, started_at, ended_at, cleaned_at)
       VALUES ($1, $2, $3, NOW(), $4, $5)`,
      [
        channelId,
        `live/${channelId}/${startedAt}-${options.rung}`,
        options.rung,
        options.ended ? new Date() : null,
        options.cleaned ? new Date() : null,
      ],
    );
  }

  it("serves a rung of a session that is still open", async () => {
    await session({ rung: "720p30", ended: false });
    await expect(
      buildSignedPlaylist(channelId, STARTED_AT, "720p30"),
    ).resolves.toContain("#EXTM3U");
  });

  /**
   * THE ONE. An ended session's objects live on for the whole retention
   * window, and its playlist goes on being rewritten by an egress that has
   * nothing left to encode, so "the objects are still there" is not remotely
   * the same question as "this stream is live".
   */
  it("refuses a rung of a session that has ended, objects or no objects", async () => {
    await session({ rung: "720p30", ended: true });
    await expect(
      buildSignedPlaylist(channelId, STARTED_AT, "720p30"),
    ).rejects.toBeInstanceOf(HlsPlaylistNotFound);
  });

  it("refuses a session whose objects have already been swept", async () => {
    await session({ rung: "720p30", ended: true, cleaned: true });
    await expect(
      buildSignedPlaylist(channelId, STARTED_AT, "720p30"),
    ).rejects.toBeInstanceOf(HlsPlaylistNotFound);
  });

  /**
   * The master is the other half and it is the half a viewer lands on first.
   * Left out, a finished session goes on advertising its variants and a
   * player that never hears about the new session follows them into nothing.
   */
  it("lists the variants of an open session and none of an ended one", async () => {
    await session({ rung: "720p30", ended: false });
    await session({ rung: "1080p30", ended: false });
    const master = await buildMasterPlaylistFor({
      channelId,
      startedAt: STARTED_AT,
    });
    expect(master).toContain("720p30");
    expect(master).toContain("1080p30");

    await getPool().query(`UPDATE hls_sessions SET ended_at = NOW()`);
    resetHlsPlaylistCacheForTests();
    expect(
      await buildMasterPlaylistFor({ channelId, startedAt: STARTED_AT }),
    ).toBeNull();
  });

  /**
   * The shape the incident actually had: two sessions on one channel, the
   * older one superseded and still holding objects. The viewer's recovery is
   * a 404 on the old one, because that is what makes their watchdog refetch
   * `GET /api/channels/:id/live` and follow the new session.
   */
  it("keeps serving the newer session while refusing the superseded one", async () => {
    const older = STARTED_AT;
    const newer = STARTED_AT + 1_262_386;
    await session({ rung: "720p30", ended: true, startedAt: older });
    await session({ rung: "720p30", ended: false, startedAt: newer });

    await expect(
      buildSignedPlaylist(channelId, older, "720p30"),
    ).rejects.toBeInstanceOf(HlsPlaylistNotFound);
    await expect(
      buildSignedPlaylist(channelId, newer, "720p30"),
    ).resolves.toContain("#EXTM3U");
  });
});
