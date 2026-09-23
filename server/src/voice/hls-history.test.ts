import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The concurrency property `setWatchPartyKeepReplay`'s comment argues for:
 * a `SELECT ... FOR UPDATE` transaction, not a single CTE, because a CTE
 * referenced more than once is materialised once against the statement's
 * starting snapshot and is NOT re-evaluated by Postgres's lock-conflict
 * re-check (EvalPlanQual) after waiting on a row another transaction is
 * writing. This file proves the property directly: hold a row lock exactly
 * the way `sweepHlsSessions` would while it marks a row cleaned, and confirm
 * `setWatchPartyKeepReplay` -- called concurrently -- blocks on it and then
 * reports "unavailable" once the lock is released with the row cleaned,
 * rather than racing ahead on stale data.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { setWatchPartyKeepReplay } = await import("./hls-history.js");

const STARTED_AT = 1_700_000_020_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeDb("setWatchPartyKeepReplay concurrency", () => {
  let channelId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_hls_history_concurrency",
      displayName: "Concurrency Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'watch', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '3 minutes', FALSE, '720p30')`,
      [channelId, `live/${channelId}/${STARTED_AT}-720p30`, STARTED_AT],
    );
  });

  it("blocks behind a concurrent cleanup holding the row lock, then sees the cleaned result", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    const cleaner = await getPool().connect();
    try {
      // Simulate `sweepHlsSessions` mid-cleanup: it has already decided this
      // row is due and is holding its lock, but has not committed yet.
      await cleaner.query("BEGIN");
      await cleaner.query(
        `SELECT id FROM hls_sessions WHERE channel_id = $1 FOR UPDATE`,
        [channelId],
      );

      const keepReplayCall = setWatchPartyKeepReplay(
        channelId,
        STARTED_AT,
        true,
      );

      // Give the call a moment to reach its own `FOR UPDATE` and block on
      // the cleaner's lock -- if it did NOT block, this proves nothing, so
      // the assertion after the release is what actually matters.
      await sleep(150);

      await cleaner.query(`UPDATE hls_sessions SET cleaned_at = NOW()`);
      await cleaner.query("COMMIT");

      const result = await keepReplayCall;
      expect(result).toBe("unavailable");

      const row = await getPool().query<{
        cleaned_at: Date | null;
        keep_replay: boolean;
      }>(`SELECT cleaned_at, keep_replay FROM hls_sessions WHERE channel_id = $1`, [
        channelId,
      ]);
      // The row stays cleaned AND keep_replay is untouched -- the write
      // never happened, which is the whole point.
      expect(row.rows[0]!.cleaned_at).not.toBeNull();
      expect(row.rows[0]!.keep_replay).toBe(false);
    } finally {
      cleaner.release();
    }
  });

  it("succeeds normally once the concurrent transaction rolls back instead", async () => {
    process.env.LIVE_HLS_RETENTION_MINUTES = "10";
    const other = await getPool().connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `SELECT id FROM hls_sessions WHERE channel_id = $1 FOR UPDATE`,
        [channelId],
      );
      const keepReplayCall = setWatchPartyKeepReplay(
        channelId,
        STARTED_AT,
        true,
      );
      await sleep(150);
      // The other transaction changes its mind and never touches the row.
      await other.query("ROLLBACK");

      const result = await keepReplayCall;
      expect(result).toBe("ok");
    } finally {
      other.release();
    }
  });
});

/**
 * Replaying a low-latency broadcast (`mode = 'll'`): the box's own
 * `master.m3u8` / `video.m3u8` / `audio.m3u8`, read from under the ROW's
 * `object_prefix` and rewritten so every object they name is signed.
 */
const {
  buildReplayMasterPlaylist,
  buildReplaySignedPlaylist,
  resetHlsReplayCachesForTests,
  watchPartyDownloadSizes,
  buildWatchPartyDownloadPlan,
  resetWatchPartyDownloadCacheForTests,
} = await import("./hls-history.js");

const LL_STARTED_AT = 1_790_029_937_773;

describeDb("LL replay", () => {
  let channelId: string;
  /** Where the box actually wrote: 24 ms off `started_at`, as it was on
   * 2026-09-21 before the reconcile script repointed the row. */
  let boxPrefix: string;
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  let objects: Record<string, string>;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    resetHlsReplayCachesForTests();
    resetWatchPartyDownloadCacheForTests();
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    // Path-style, so every key is `/pqp-live-test/<key>` on one host.
    process.env.LIVE_HLS_S3_FORCE_PATH_STYLE = "true";
    await getPool().query(
      `TRUNCATE users, servers, channels, hls_sessions RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_hls_history_ll",
      displayName: "LL Tester",
      avatarUrl: null,
    });
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('test', $1) RETURNING id`,
      [user.id],
    );
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'watch', 'voice', 0) RETURNING id`,
      [server.rows[0]!.id],
    );
    channelId = channel.rows[0]!.id;
    boxPrefix = `live/${channelId}/${LL_STARTED_AT + 24}-ll`;
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, mode)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '1 hour', TRUE, 'll')`,
      [channelId, boxPrefix, LL_STARTED_AT],
    );
    objects = {
      [`${boxPrefix}/master.m3u8`]: [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2131072,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"',
        "video.m3u8",
        "",
      ].join("\n"),
      // Left open, as a box that died before its last write leaves it.
      [`${boxPrefix}/video.m3u8`]: [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:6",
        "#EXT-X-PLAYLIST-TYPE:EVENT",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MAP:URI="video-init.mp4"',
        "#EXTINF:4.000,",
        "video-seg-0.m4s",
        "#EXT-X-DISCONTINUITY",
        '#EXT-X-MAP:URI="video-init-2.mp4"',
        "#EXTINF:5.200,",
        "video-seg-1.m4s",
        "",
      ].join("\n"),
      [`${boxPrefix}/audio.m3u8`]: [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MAP:URI="audio-init.mp4"',
        "#EXTINF:4.000,",
        "audio-seg-0.m4s",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    };
    fetched.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.host !== "s3.example.test") {
          return realFetch(input, init);
        }
        const key = decodeURIComponent(url.pathname.replace(/^\/pqp-live-test\//, ""));
        fetched.push(key);
        if (url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const contents = Object.keys(objects)
            .filter((name) => name.startsWith(prefix))
            .map((name) => `<Contents><Key>${name}</Key><Size>${objects[name]!.length}</Size></Contents>`)
            .join("");
          return new Response(
            `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
            { status: 200 },
          );
        }
        const body = objects[key];
        return body === undefined
          ? new Response("NoSuchKey", { status: 404 })
          : new Response(body, { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
    delete process.env.LIVE_HLS_S3_FORCE_PATH_STYLE;
  });

  it("serves the box's master with both playlists pointed at the replay route", async () => {
    const master = await buildReplayMasterPlaylist({
      channelId,
      startedAt: LL_STARTED_AT,
      token: "tok",
    });
    const route = `/api/voice/hls-replay/${channelId}/${LL_STARTED_AT}`;
    expect(master).toContain(`URI="${route}/llaudio?t=tok"`);
    expect(master).toContain(`\n${route}/llvideo?t=tok\n`);
    // The attributes the box wrote survive: a player needs CODECS to pick it.
    expect(master).toContain('CODECS="avc1.42c01f,mp4a.40.2",AUDIO="audio"');
    // Read from the ROW's prefix, never one rebuilt from started_at.
    expect(fetched).toContain(`${boxPrefix}/master.m3u8`);
  });

  it("signs every segment AND every EXT-X-MAP, keeps DISCONTINUITY, and closes an open playlist", async () => {
    const video = await buildReplaySignedPlaylist(channelId, LL_STARTED_AT, "llvideo");
    const lines = video.split("\n");
    const maps = lines.filter((line) => line.startsWith("#EXT-X-MAP:"));
    expect(maps).toHaveLength(2);
    expect(maps[0]).toMatch(
      new RegExp(`^#EXT-X-MAP:URI="https://s3\\.example\\.test/pqp-live-test/${boxPrefix}/video-init\\.mp4\\?X-Amz-`),
    );
    expect(maps[1]).toContain(`${boxPrefix}/video-init-2.mp4?X-Amz-`);
    const segments = lines.filter((line) => line.includes(".m4s"));
    expect(segments).toHaveLength(2);
    expect(segments.every((line) => line.startsWith("https://s3.example.test/"))).toBe(true);
    // The DISCONTINUITY sits exactly where the box put it, ahead of the new MAP.
    const discontinuity = lines.indexOf("#EXT-X-DISCONTINUITY");
    expect(discontinuity).toBeGreaterThan(-1);
    expect(lines[discontinuity + 1]).toBe(maps[1]);
    // A replay is finished, whatever the last write managed to say.
    expect(video).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(video).not.toContain("EVENT");
    expect(video.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);

    const audio = await buildReplaySignedPlaylist(channelId, LL_STARTED_AT, "llaudio");
    expect(audio.match(/#EXT-X-ENDLIST/g)).toHaveLength(1);
    expect(audio).toContain(`${boxPrefix}/audio-init.mp4?X-Amz-`);
  });

  it("reads the box's master once for an audience, not once per viewer", async () => {
    for (const token of ["a", "b", "c"]) {
      expect(
        await buildReplayMasterPlaylist({ channelId, startedAt: LL_STARTED_AT, token }),
      ).toContain(`llvideo?t=${token}`);
    }
    expect(fetched.filter((key) => key.endsWith("/master.m3u8"))).toHaveLength(1);
  });

  it("coalesces an audience that misses the cache at the same moment", async () => {
    // A slow bucket, so every viewer is still waiting when the next arrives.
    const stubbed = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("master.m3u8")) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return stubbed(input, init);
      }),
    );
    const masters = await Promise.all(
      ["a", "b", "c"].map((token) =>
        buildReplayMasterPlaylist({ channelId, startedAt: LL_STARTED_AT, token }),
      ),
    );
    expect(masters.every((m) => m?.includes("/llvideo?t="))).toBe(true);
    expect(fetched.filter((key) => key.endsWith("/master.m3u8"))).toHaveLength(1);
  });

  it("answers no master for a broadcast the box never wrote playlists for", async () => {
    delete objects[`${boxPrefix}/master.m3u8`];
    expect(
      await buildReplayMasterPlaylist({ channelId, startedAt: LL_STARTED_AT }),
    ).toBeNull();
  });

  it("refuses once the row is past its window", async () => {
    await getPool().query(
      `UPDATE hls_sessions SET keep_replay = FALSE WHERE channel_id = $1`,
      [channelId],
    );
    expect(
      await buildReplayMasterPlaylist({ channelId, startedAt: LL_STARTED_AT }),
    ).toBeNull();
    await expect(
      buildReplaySignedPlaylist(channelId, LL_STARTED_AT, "llvideo"),
    ).rejects.toThrow(/No LL replay/);
  });

  it("offers the camera and the voice of an LL broadcast, and no film", async () => {
    for (const rung of ["cam360p30", "mic"]) {
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '1 hour', TRUE, $4)`,
        [channelId, `live/${channelId}/${LL_STARTED_AT}-${rung}`, LL_STARTED_AT, rung],
      );
    }
    objects[`live/${channelId}/${LL_STARTED_AT}-cam360p30_00000.ts`] = "x".repeat(1000);
    objects[`live/${channelId}/${LL_STARTED_AT}-mic.ogg`] = "o".repeat(500);
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    // No film.mp4, no film.json, and the show ended an hour ago: the box
    // never made one (every LL show before it knew how).
    expect(sizes).toEqual({ film: null, camera: 1000, voice: 500, preparing: [] });
  });

  it("offers the box's film.mp4 as the LL film, one object under the ROW's prefix", async () => {
    objects[`${boxPrefix}/film.mp4`] = "m".repeat(4321);
    objects[`${boxPrefix}/film.json`] = JSON.stringify({
      state: "ready",
      updatedAt: new Date().toISOString(),
    });
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    expect(sizes.film).toBe(4321);
    expect(sizes.preparing).toEqual([]);
    const plan = await buildWatchPartyDownloadPlan(channelId, LL_STARTED_AT, "film");
    expect(plan).toEqual({
      kind: "film",
      contentType: "video/mp4",
      extension: "mp4",
      keys: [`${boxPrefix}/film.mp4`],
      bytes: 4321,
    });
  });

  it("says the LL film is being prepared while the box's job is alive", async () => {
    objects[`${boxPrefix}/film.json`] = JSON.stringify({
      state: "processing",
      updatedAt: new Date(Date.now() - 20_000).toISOString(),
    });
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    expect(sizes.film).toBeNull();
    expect(sizes.preparing).toEqual(["film"]);
    // Not downloadable until it exists.
    expect(
      await buildWatchPartyDownloadPlan(channelId, LL_STARTED_AT, "film"),
    ).toBeNull();
  });

  it("does not claim a film is being prepared once the job stopped heartbeating", async () => {
    objects[`${boxPrefix}/film.json`] = JSON.stringify({
      state: "processing",
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    expect(sizes.film).toBeNull();
    expect(sizes.preparing).toEqual([]);
  });

  it("reads a failed job as no film", async () => {
    objects[`${boxPrefix}/film.json`] = JSON.stringify({
      state: "failed",
      updatedAt: new Date().toISOString(),
      error: "boom",
    });
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    expect(sizes).toMatchObject({ film: null, preparing: [] });
  });

  it("says preparing in the moments between the show ending and the box's first status", async () => {
    await getPool().query(
      `UPDATE hls_sessions SET ended_at = NOW() - interval '30 seconds' WHERE channel_id = $1`,
      [channelId],
    );
    const sizes = await watchPartyDownloadSizes(channelId, LL_STARTED_AT);
    expect(sizes.preparing).toEqual(["film"]);
  });

  it("sees a film that appeared after the panel first looked", async () => {
    objects[`${boxPrefix}/film.json`] = JSON.stringify({
      state: "processing",
      updatedAt: new Date().toISOString(),
    });
    expect((await watchPartyDownloadSizes(channelId, LL_STARTED_AT)).preparing).toEqual(["film"]);
    objects[`${boxPrefix}/film.mp4`] = "m".repeat(10);
    // Inside the 30 s listing memo: a missing film is asked about again.
    expect((await watchPartyDownloadSizes(channelId, LL_STARTED_AT)).film).toBe(10);
  });

  it("leaves a conventional rung's playlist as it always was", async () => {
    const prefix = `live/${channelId}/${LL_STARTED_AT + 1}-720p30`;
    await getPool().query(
      `INSERT INTO hls_sessions
         (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '1 hour', TRUE, '720p30')`,
      [channelId, prefix, LL_STARTED_AT + 1],
    );
    objects[`${prefix}-index.m3u8`] = [
      "#EXTM3U",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXTINF:2.0,",
      `${LL_STARTED_AT + 1}-720p30_00000.ts`,
      "",
    ].join("\n");
    const body = await buildReplaySignedPlaylist(channelId, LL_STARTED_AT + 1, "720p30");
    // Signed, but NOT closed: only an LL playlist is rewritten to VOD here.
    expect(body).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(body).not.toContain("#EXT-X-ENDLIST");
    expect(body).toContain(`https://s3.example.test/pqp-live-test/live/${channelId}/${LL_STARTED_AT + 1}-720p30_00000.ts?X-Amz-`);
  });
});
