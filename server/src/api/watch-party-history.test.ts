import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
 * `GET/PATCH /api/channels/:channelId/watch-party/history[/:sessionId]` and
 * the replay it mints (`GET .../replay`, served by
 * `/api/voice/hls-replay/...`).
 *
 * Three things this file exists to pin, beyond the ordinary route shape:
 *
 *  - Only START_WATCH_PARTY or MANAGE_CHANNELS may see or touch the list --
 *    an ordinary member with VIEW_CHANNEL gets 403/404, never a peek at who
 *    presented.
 *  - `keepReplay` on `PATCH` writes EVERY row of the broadcast (every ladder
 *    rung, not just one), so a companion rendition is not silently dropped
 *    from retention while the "primary" one survives.
 *  - The retention interaction: setting `keepReplay: true` on a session that
 *    is past the plain retention window but still holds `cleaned_at IS
 *    NULL` rows is what stops `sweepHlsSessions` from deleting it on the
 *    very next tick.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async (header: string | undefined) =>
    header && actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { Permission } = await import("@pqp/shared");
const { sweepHlsSessions, resetHlsSweepWarningsForTests } = await import(
  "../voice/hls-cleanup.js"
);
const { setLiveHlsTestHooks, resetLiveHlsForTests } = await import(
  "../voice/hls-egress.js"
);
const { mintHlsViewerToken } = await import("../voice/hls-viewer-token.js");
const { CAMERA_RUNG_NAME } = await import("../voice/hls-ladder.js");
const {
  resetHlsReplayCachesForTests,
  resetWatchPartyDownloadCacheForTests,
} = await import("../voice/hls-history.js");

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function getRaw(
  path: string,
  as: { id: string; clerk_id: string } | null,
): Promise<{ status: number; text: string; contentType: string | null }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: as ? { Authorization: "Bearer test" } : {},
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

describeDb("watch party history", () => {
  let owner: { id: string; clerk_id: string };
  let moderator: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let serverId: string;
  let channelId: string;

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetHlsSweepWarningsForTests();
    resetLiveHlsForTests();
    resetHlsReplayCachesForTests();
    resetWatchPartyDownloadCacheForTests();
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    setLiveHlsTestHooks({
      egress: {
        startTrackCompositeEgress: async () => ({ egressId: "unused" }),
        stopEgress: async () => {},
        listEgress: async () => [],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("s3.example.test/")) {
          return new Response(
            ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXTINF:2.0,", "seg_00000.ts", "#EXT-X-ENDLIST"].join("\n"),
            { status: 200 },
          );
        }
        return realFetch(input, init);
      }),
    );
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels,
                server_members, channel_sessions, hls_sessions
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    moderator = await upsertUser({
      clerkId: "clerk_mod",
      displayName: "Mod",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_member",
      displayName: "Member",
      avatarUrl: null,
    });

    actor = owner;
    const created = await call<{
      server: { id: string };
      channels: { id: string; type: string }[];
    }>(owner, "POST", "/api/servers", { name: "Watch party history" });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    channelId = created.body.channels.find((c) => c.type === "voice")!.id;

    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, moderator.id],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    // A moderator here is a plain member granted the channel's
    // START_WATCH_PARTY bit through an overwrite, the same shape a real
    // "Manage Server" role assignment produces -- not the `admin` role,
    // which would also pass via ADMINISTRATOR and prove nothing about the
    // OR of the two bits this route actually checks.
    await getPool().query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'member', $2, $3, 0)`,
      [channelId, moderator.id, Permission.START_WATCH_PARTY.toString()],
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
  });

  function historyPath(id = channelId) {
    return `/api/channels/${id}/watch-party/history`;
  }

  async function seedBroadcast(options: {
    startedAt: number;
    endedMinutesAgo: number | null;
    keepReplay?: boolean;
    rungs?: string[];
    presenterId?: string;
    wentLiveMinutesBeforeStart?: number;
  }): Promise<void> {
    const startedAt = options.startedAt;
    const endedAt =
      options.endedMinutesAgo === null
        ? null
        : new Date(Date.now() - options.endedMinutesAgo * 60_000);
    for (const rung of options.rungs ?? ["720p30"]) {
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6)`,
        [
          channelId,
          `live/${channelId}/${startedAt}-${rung}`,
          startedAt,
          endedAt,
          options.keepReplay ?? false,
          rung,
        ],
      );
    }
    if (options.presenterId) {
      const wentLiveAt = new Date(
        startedAt - (options.wentLiveMinutesBeforeStart ?? 1) * 60_000,
      );
      await getPool().query(
        `INSERT INTO channel_sessions
           (channel_id, server_id, title, starts_at, status, created_by,
            host_user_id, went_live_at, ended_at)
         VALUES ($1, $2, 'Party', $3, 'ended', $4, $4, $3, $5)`,
        [
          channelId,
          serverId,
          wentLiveAt,
          options.presenterId,
          endedAt,
        ],
      );
    }
  }

  describe("GET history", () => {
    it("403s a plain member", async () => {
      await seedBroadcast({ startedAt: 1_700_000_000_000, endedMinutesAgo: 5 });
      const res = await call(member, "GET", historyPath());
      expect(res.status).toBe(403);
    });

    it("401s with no session at all", async () => {
      const res = await call(null, "GET", historyPath());
      expect(res.status).toBe(401);
    });

    it("lists broadcasts for the owner and for a moderator via an overwrite", async () => {
      await seedBroadcast({
        startedAt: 1_700_000_000_000,
        endedMinutesAgo: 5,
        presenterId: member.id,
        rungs: ["1080p30", "720p30"],
      });
      for (const as of [owner, moderator]) {
        const res = await call<{
          broadcasts: Array<Record<string, unknown>>;
        }>(as, "GET", historyPath());
        expect(res.status).toBe(200);
        expect(res.body.broadcasts).toHaveLength(1);
        const entry = res.body.broadcasts[0]!;
        expect(entry.sessionId).toBe("1700000000000");
        expect(entry.endedAt).not.toBeNull();
        expect(entry.durationSeconds).toBeGreaterThanOrEqual(0);
        expect(entry.replayAvailable).toBe(true);
        expect(entry.keepReplay).toBe(false);
        expect(entry.presenter).toMatchObject({
          userId: member.id,
          displayName: "Member",
        });
        // One entry per BROADCAST, not one per rung.
        expect(res.body.broadcasts).toHaveLength(1);
      }
    });

    it("omits a peak-viewer field entirely (nothing durable to report)", async () => {
      await seedBroadcast({ startedAt: 1_700_000_000_000, endedMinutesAgo: 5 });
      const res = await call<{ broadcasts: Array<Record<string, unknown>> }>(
        owner,
        "GET",
        historyPath(),
      );
      expect("peakViewers" in res.body.broadcasts[0]!).toBe(false);
    });

    it("a still-live broadcast has endedAt null and is not replayable", async () => {
      await seedBroadcast({ startedAt: 1_700_000_001_000, endedMinutesAgo: null });
      const res = await call<{ broadcasts: Array<Record<string, unknown>> }>(
        owner,
        "GET",
        historyPath(),
      );
      const entry = res.body.broadcasts[0]!;
      expect(entry.endedAt).toBeNull();
      expect(entry.durationSeconds).toBeNull();
      expect(entry.replayAvailable).toBe(false);
    });

    it("a broadcast past the retention window with no keepReplay is not replayable", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({
        startedAt: 1_700_000_002_000,
        endedMinutesAgo: 20,
      });
      const res = await call<{ broadcasts: Array<Record<string, unknown>> }>(
        owner,
        "GET",
        historyPath(),
      );
      expect(res.body.broadcasts[0]!.replayAvailable).toBe(false);
    });

    it("with keepReplay it survives past the plain retention window", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      process.env.LIVE_HLS_REPLAY_HOURS = "24";
      await seedBroadcast({
        startedAt: 1_700_000_003_000,
        endedMinutesAgo: 30,
        keepReplay: true,
      });
      const res = await call<{ broadcasts: Array<Record<string, unknown>> }>(
        owner,
        "GET",
        historyPath(),
      );
      expect(res.body.broadcasts[0]!.keepReplay).toBe(true);
      expect(res.body.broadcasts[0]!.replayAvailable).toBe(true);
    });

    it("newest first, across several broadcasts", async () => {
      await seedBroadcast({ startedAt: 1_700_000_000_000, endedMinutesAgo: 5 });
      await seedBroadcast({ startedAt: 1_700_000_100_000, endedMinutesAgo: 3 });
      const res = await call<{ broadcasts: Array<{ sessionId: string }> }>(
        owner,
        "GET",
        historyPath(),
      );
      expect(res.body.broadcasts.map((b) => b.sessionId)).toEqual([
        "1700000100000",
        "1700000000000",
      ]);
    });

    /**
     * `title` is `channel_sessions.title` at the time of the broadcast when a
     * party row matches (the same lateral join the presenter already uses),
     * falling back to the channel's own name when it does not -- a broadcast
     * pre-dating scheduled parties, or started without one.
     */
    it("uses the party's title when one matches, and falls back to the channel name otherwise", async () => {
      // Well BEFORE the party's own `went_live_at` (started_at - 1 minute,
      // `seedBroadcast`'s default), so the presenter/title lateral join --
      // "the most recent channel_sessions row whose went_live_at is at or
      // before this broadcast's started_at" -- has nothing in range and
      // genuinely falls through to the channel name, rather than picking up
      // the other broadcast's party the way an adjacent timestamp would.
      await seedBroadcast({
        startedAt: 1_700_000_000_000,
        endedMinutesAgo: 5,
      });
      await seedBroadcast({
        startedAt: 1_700_000_100_000,
        endedMinutesAgo: 5,
        presenterId: member.id,
      });
      const channelName = (
        await getPool().query<{ name: string }>(
          `SELECT name FROM channels WHERE id = $1`,
          [channelId],
        )
      ).rows[0]!.name;

      const res = await call<{
        broadcasts: Array<{ sessionId: string; title: string }>;
      }>(owner, "GET", historyPath());
      const withoutParty = res.body.broadcasts.find(
        (b) => b.sessionId === "1700000000000",
      )!;
      const withParty = res.body.broadcasts.find(
        (b) => b.sessionId === "1700000100000",
      )!;
      expect(withParty.title).toBe("Party");
      expect(withoutParty.title).toBe(channelName);
    });
  });

  describe("PATCH history/:sessionId", () => {
    it("403s a plain member", async () => {
      await seedBroadcast({ startedAt: 1_700_000_000_000, endedMinutesAgo: 5 });
      const res = await call(member, "PATCH", `${historyPath()}/1700000000000`, {
        keepReplay: true,
      });
      expect(res.status).toBe(403);
    });

    it("404s an unknown session id", async () => {
      const res = await call(owner, "PATCH", `${historyPath()}/1700000000000`, {
        keepReplay: true,
      });
      expect(res.status).toBe(404);
    });

    it("409s once the segments are already gone", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({
        startedAt: 1_700_000_004_000,
        endedMinutesAgo: 20,
      });
      const res = await call(owner, "PATCH", `${historyPath()}/1700000004000`, {
        keepReplay: true,
      });
      expect(res.status).toBe(409);
    });

    it("flips keep_replay on EVERY rung of the broadcast, not just one", async () => {
      await seedBroadcast({
        startedAt: 1_700_000_005_000,
        endedMinutesAgo: 5,
        rungs: ["1080p30", "720p30", "mic"],
      });
      const res = await call<{
        broadcasts: Array<{ keepReplay: boolean }>;
      }>(owner, "PATCH", `${historyPath()}/1700000005000`, {
        keepReplay: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.broadcasts[0]!.keepReplay).toBe(true);
      const rows = await getPool().query<{ keep_replay: boolean; rung: string }>(
        `SELECT keep_replay, rung FROM hls_sessions
         WHERE channel_id = $1 AND started_at = to_timestamp(1700000005000 / 1000.0)`,
        [channelId],
      );
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.every((r) => r.keep_replay === true)).toBe(true);
    });

    /**
     * THE RETENTION INTERACTION. A broadcast old enough to be swept under
     * the plain window must NOT be swept once `keepReplay` is set, on the
     * very next sweep tick -- this is the whole point of the feature.
     */
    it("stops the retention sweep from deleting the broadcast", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      process.env.LIVE_HLS_REPLAY_HOURS = "24";
      // Seeded fresh -- still inside the default 10-minute window, which is
      // the realistic moment a moderator acts: shortly after the broadcast
      // ends, before it would otherwise be swept.
      await seedBroadcast({
        startedAt: 1_700_000_006_000,
        endedMinutesAgo: 3,
      });

      const patched = await call(
        owner,
        "PATCH",
        `${historyPath()}/1700000006000`,
        { keepReplay: true },
      );
      expect(patched.status).toBe(200);

      // Time passes: now well past the PLAIN 10-minute window, still inside
      // the 24h replay one `keepReplay` unlocked.
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW() - interval '30 minutes'
         WHERE channel_id = $1 AND started_at = to_timestamp(1700000006000 / 1000.0)`,
        [channelId],
      );

      const cleaned = await sweepHlsSessions();
      expect(cleaned).toBe(0);
      const rows = await getPool().query<{ cleaned_at: Date | null }>(
        `SELECT cleaned_at FROM hls_sessions
         WHERE channel_id = $1 AND started_at = to_timestamp(1700000006000 / 1000.0)`,
        [channelId],
      );
      expect(rows.rows[0]!.cleaned_at).toBeNull();
    });

    it("turning it back off makes it due again on the next sweep", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      process.env.LIVE_HLS_REPLAY_HOURS = "24";
      await seedBroadcast({
        startedAt: 1_700_000_007_000,
        endedMinutesAgo: 30,
        keepReplay: true,
      });
      const off = await call(owner, "PATCH", `${historyPath()}/1700000007000`, {
        keepReplay: false,
      });
      expect(off.status).toBe(200);
      const cleaned = await sweepHlsSessions();
      expect(cleaned).toBe(1);
    });
  });

  describe("GET history/:sessionId/replay", () => {
    it("403s a plain member", async () => {
      await seedBroadcast({ startedAt: 1_700_000_000_000, endedMinutesAgo: 5 });
      const res = await call(
        member,
        "GET",
        `${historyPath()}/1700000000000/replay`,
      );
      expect(res.status).toBe(403);
    });

    it("404s an unknown session id", async () => {
      const res = await call(
        owner,
        "GET",
        `${historyPath()}/1700000000000/replay`,
      );
      expect(res.status).toBe(404);
    });

    it("409s once the segments are already gone", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({ startedAt: 1_700_000_008_000, endedMinutesAgo: 20 });
      const res = await call(
        owner,
        "GET",
        `${historyPath()}/1700000008000/replay`,
      );
      expect(res.status).toBe(409);
    });

    it("mints a playable master playlist URL, carrying a viewer token", async () => {
      await seedBroadcast({ startedAt: 1_700_000_009_000, endedMinutesAgo: 5 });
      const res = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/1700000009000/replay`,
      );
      expect(res.status).toBe(200);
      expect(res.body.hlsUrl).toMatch(
        /^\/api\/voice\/hls-replay\/[^/]+\/1700000009000\?t=/,
      );

      const playlist = await getRaw(res.body.hlsUrl, owner);
      expect(playlist.status).toBe(200);
      expect(playlist.contentType).toBe("application/vnd.apple.mpegurl");
      expect(playlist.text).toContain("#EXT-X-STREAM-INF");
      expect(playlist.text).toContain("/api/voice/hls-replay/");
    });

    /**
     * ONE EXPIRED RUNG MAKES THE WHOLE BROADCAST UNAVAILABLE, not just that
     * rendition -- a partial ladder is an incomplete broadcast, not a lower-
     * quality one, so `replayAvailable` (and the mint route) has to say no
     * rather than hand the master playlist a ladder missing a rung.
     */
    it("409s once even ONE ladder rung has fallen out of its retention window", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({
        startedAt: 1_700_000_016_000,
        endedMinutesAgo: 5,
        rungs: ["1080p30"],
      });
      // A second rung of the SAME broadcast, already past the window.
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '20 minutes', FALSE, '720p30')`,
        [channelId, `live/${channelId}/1700000016000-720p30`, 1_700_000_016_000],
      );
      const list = await call<{
        broadcasts: Array<{ replayAvailable: boolean }>;
      }>(owner, "GET", historyPath());
      expect(list.body.broadcasts[0]!.replayAvailable).toBe(false);

      const res = await call(
        owner,
        "GET",
        `${historyPath()}/1700000016000/replay`,
      );
      expect(res.status).toBe(409);
    });
  });

  describe("GET /api/voice/hls-replay/:channelId/:startedAt(/:rung)", () => {
    it("a valid token with NO Authorization header is served (hls.js's real shape)", async () => {
      await seedBroadcast({ startedAt: 1_700_000_010_000, endedMinutesAgo: 5 });
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/1700000010000/replay`,
      );
      expect(minted.status).toBe(200);
      const r = await getRaw(minted.body.hlsUrl, null);
      expect(r.status).toBe(200);

      // Follow the master into one rendition, still with no header.
      const variantLine = r.text
        .split("\n")
        .find((line) => line.includes("/api/voice/hls-replay/"))!;
      const rendition = await getRaw(variantLine, null);
      expect(rendition.status).toBe(200);
      expect(rendition.text).toContain("#EXTM3U");
      expect(rendition.text).toContain("s3.example.test");
    });

    /**
     * REPLAY IS VOD, NOT THE LIVE SLIDING WINDOW. The rendition is built
     * from the accumulated `<startedAt>-<rung>-index.m3u8` object -- the one
     * LiveKit's `SegmentedFileOutput.playlistName` keeps growing for the
     * whole run and terminates with `#EXT-X-ENDLIST` when the egress ends
     * (`hls-egress.ts`'s `segmentOutput`) -- never the rolling
     * `livePlaylistName` the live proxy serves. The upstream fixture
     * (`beforeEach` above) already returns a fixed, ended playlist; this
     * pins that the replay path passes that shape straight through rather
     * than routing through anything that strips it, so a player attaching
     * to it sees a finished VOD manifest and never the live watchdog's
     * "still going" read of the same bytes.
     */
    it("serves a VOD playlist -- every segment, ending in #EXT-X-ENDLIST", async () => {
      await seedBroadcast({ startedAt: 1_700_000_019_000, endedMinutesAgo: 5 });
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/1700000019000/replay`,
      );
      const master = await getRaw(minted.body.hlsUrl, null);
      const variantLine = master.text
        .split("\n")
        .find((line) => line.includes("/api/voice/hls-replay/"))!;
      const rendition = await getRaw(variantLine, null);
      expect(rendition.status).toBe(200);
      expect(rendition.text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
      // The one segment the upstream fixture carries survived the rewrite
      // as a presigned bucket URL, not our own live playlist proxy.
      expect(rendition.text).toContain("s3.example.test");
      expect(rendition.text).not.toContain("/api/voice/hls-playlist/");
    });

    it("a still-live session is not servable as a replay", async () => {
      await seedBroadcast({
        startedAt: 1_700_000_011_000,
        endedMinutesAgo: null,
      });
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt: 1_700_000_011_000,
        purpose: "replay",
      });
      const r = await getRaw(
        `/api/voice/hls-replay/${channelId}/1700000011000?t=${t}`,
        null,
      );
      expect(r.status).toBe(404);
    });

    /**
     * A LIVE-PURPOSE TOKEN MUST NOT OPEN THE REPLAY DOOR. The claims
     * otherwise name only a user, a channel and a `startedAt`, identical for
     * a live viewer's token (minted by `GET /api/channels/:id/live`, gated
     * only on ordinary channel access) and a moderator's replay token on the
     * same broadcast. Without the purpose claim an ordinary audience member
     * could reuse their live token to reach the moderator-only replay.
     */
    it("a live-purpose token is refused on the replay proxy", async () => {
      await seedBroadcast({ startedAt: 1_700_000_014_000, endedMinutesAgo: 5 });
      const liveToken = mintHlsViewerToken({
        userId: member.id,
        channelId,
        startedAt: 1_700_000_014_000,
      });
      const r = await getRaw(
        `/api/voice/hls-replay/${channelId}/1700000014000?t=${liveToken}`,
        null,
      );
      expect(r.status).toBe(401);
    });

    /**
     * A BEARER FALLBACK MUST NOT WIDEN THE DOOR EITHER. An authenticated
     * member with ordinary channel access, but none of START_WATCH_PARTY /
     * MANAGE_CHANNELS, must not reach the replay bytes just by knowing the
     * channel and the broadcast's `startedAt`, even with a valid session and
     * no token at all.
     */
    it("a plain member's own Bearer session cannot reach the replay bytes", async () => {
      await seedBroadcast({ startedAt: 1_700_000_015_000, endedMinutesAgo: 5 });
      const r = await getRaw(
        `/api/voice/hls-replay/${channelId}/1700000015000`,
        member,
      );
      expect(r.status).toBe(403);
    });

    /**
     * A TOKEN MINTED WHILE AVAILABLE MUST STILL 404 ONCE THE RETENTION
     * WINDOW HAS PASSED, even with time left on its own (60-minute) TTL and
     * even before the sweep has run. `buildReplayMasterPlaylist` and
     * `buildReplaySignedPlaylist` re-check the full availability predicate on
     * every request rather than trusting `cleaned_at IS NULL` alone.
     */
    it("stops serving once the retention window passes, before any sweep runs", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({ startedAt: 1_700_000_017_000, endedMinutesAgo: 3 });
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/1700000017000/replay`,
      );
      expect(minted.status).toBe(200);
      const stillGood = await getRaw(minted.body.hlsUrl, null);
      expect(stillGood.status).toBe(200);

      // Time passes past the 10-minute window. `cleaned_at` is still NULL --
      // no sweep has run -- so a check against `ended_at`/`cleaned_at` alone
      // would still serve this.
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW() - interval '20 minutes'
         WHERE channel_id = $1 AND started_at = to_timestamp(1700000017000 / 1000.0)`,
        [channelId],
      );
      // Without this, the in-process 30s replay cache (not the database)
      // would answer the next request and the test would prove nothing.
      resetHlsReplayCachesForTests();

      const stale = await getRaw(minted.body.hlsUrl, null);
      expect(stale.status).toBe(404);
    });

    it("no header and no token is 401", async () => {
      await seedBroadcast({ startedAt: 1_700_000_012_000, endedMinutesAgo: 5 });
      const r = await getRaw(
        `/api/voice/hls-replay/${channelId}/1700000012000`,
        null,
      );
      expect(r.status).toBe(401);
    });

    /**
     * ALL-OR-NOTHING AT THE SERVING BOUNDARY TOO, not just at mint time. A
     * token minted while the whole broadcast was available must stop
     * advertising a master playlist the moment ANY one of its ladder rungs
     * falls out of its own window, rather than quietly serving a master
     * missing that rendition while claiming the party is fine.
     */
    it("the master 404s once one sibling rung falls out of its window, even with a valid token", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      await seedBroadcast({
        startedAt: 1_700_000_018_000,
        endedMinutesAgo: 3,
        rungs: ["1080p30"],
      });
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/1700000018000/replay`,
      );
      expect(minted.status).toBe(200);
      const stillGood = await getRaw(minted.body.hlsUrl, null);
      expect(stillGood.status).toBe(200);

      // A second rung of the SAME broadcast falls out of its window on its
      // own -- an uneven `ended_at`, which LiveKit can genuinely produce
      // (a stalled rendition stopped early; see docs/WATCH_PARTY.md).
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '20 minutes', FALSE, '720p30')`,
        [channelId, `live/${channelId}/1700000018000-720p30`, 1_700_000_018_000],
      );
      resetHlsReplayCachesForTests();

      const nowBroken = await getRaw(minted.body.hlsUrl, null);
      expect(nowBroken.status).toBe(404);
    });

    it("a token for a different channel is refused", async () => {
      await seedBroadcast({ startedAt: 1_700_000_013_000, endedMinutesAgo: 5 });
      const t = mintHlsViewerToken({
        userId: owner.id,
        channelId: "00000000-0000-4000-8000-000000000000",
        startedAt: 1_700_000_013_000,
        purpose: "replay",
      });
      const r = await getRaw(
        `/api/voice/hls-replay/${channelId}/1700000013000?t=${t}`,
        null,
      );
      expect(r.status).toBe(401);
    });
  });

  /**
   * `GET .../download` and `GET .../download/:kind`.
   *
   * The two things worth pinning beyond the route shape:
   *
   *  - The film is the segments of the TOP available rung, concatenated in
   *    PLAYLIST order. The fixture's playlist deliberately lists its segments
   *    out of lexicographic order, because that is the difference between
   *    reading the playlist (right) and trusting the bucket listing (wrong,
   *    and wrong in a way that still plays for the first few seconds).
   *  - A kind the broadcast never wrote is a 404, not an empty file: no
   *    camera, or the voice archive switched off.
   */
  describe("download", () => {
    /** The whole bucket, key -> body. Sizes are the bodies' lengths. */
    let objects: Map<string, string>;

    beforeEach(() => {
      objects = new Map();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          if (!url.includes("s3.example.test")) {
            return realFetch(input, init);
          }
          const parsed = new URL(url);
          if (parsed.searchParams.get("list-type") === "2") {
            const prefix = parsed.searchParams.get("prefix") ?? "";
            const contents = [...objects]
              .filter(([key]) => key.startsWith(prefix))
              .map(
                ([key, body]) =>
                  `<Contents><Key>${key}</Key><Size>${body.length}</Size></Contents>`,
              )
              .join("");
            return new Response(
              `<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`,
              { status: 200 },
            );
          }
          const key = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
          const body = objects.get(key);
          return body === undefined
            ? new Response("no such key", { status: 404 })
            : new Response(body, { status: 200 });
        }),
      );
    });

    /** A rung's two segments plus the accumulated playlist that names them,
     * deliberately NOT in lexicographic order. */
    function seedRungObjects(startedAt: number, rung: string): string {
      const prefix = `live/${channelId}/${startedAt}-${rung}`;
      objects.set(`${prefix}_00001.ts`, `[${rung}-second]`);
      objects.set(`${prefix}_00000.ts`, `[${rung}-first]`);
      objects.set(
        `${prefix}-index.m3u8`,
        [
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:2",
          "#EXTINF:2.0,",
          `${startedAt}-${rung}_00001.ts`,
          "#EXTINF:2.0,",
          `${startedAt}-${rung}_00000.ts`,
          "#EXT-X-ENDLIST",
        ].join("\n"),
      );
      return prefix;
    }

    function downloadPath(startedAt: number, kind: string): string {
      return `${historyPath()}/${startedAt}/download/${kind}`;
    }

    /** The whole `Response`, for the tests that read headers off it. */
    async function download(
      path: string,
      as: { id: string; clerk_id: string } | null,
    ): Promise<Response> {
      actor = as;
      return realFetch(`${baseUrl}${path}`, {
        headers: as ? { Authorization: "Bearer test" } : {},
      });
    }

    it("lists what exists, with sizes, and hides what does not", async () => {
      const startedAt = 1_700_000_030_000;
      await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        rungs: ["480p30", "1080p30", CAMERA_RUNG_NAME],
      });
      seedRungObjects(startedAt, "1080p30");
      seedRungObjects(startedAt, "480p30");
      seedRungObjects(startedAt, CAMERA_RUNG_NAME);

      const res = await call<{
        downloads: Record<string, { bytes: number; url: string } | null>;
        preparing: string[];
      }>(owner, "GET", `${historyPath()}/${startedAt}/download`);
      expect(res.status).toBe(200);
      expect(res.body.downloads.film?.bytes).toBe(
        "[1080p30-first]".length + "[1080p30-second]".length,
      );
      // A conventional film exists the moment the show ends.
      expect(res.body.preparing).toEqual([]);
      expect(res.body.downloads.camera?.bytes).toBeGreaterThan(0);
      // No mic row was seeded, so the voice archive is simply not there.
      expect(res.body.downloads.voice).toBeNull();
      // The URL carries the capability, because the browser navigates to it.
      expect(res.body.downloads.film?.url).toContain("t=");
    });

    it("403s a plain member", async () => {
      const startedAt = 1_700_000_031_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      seedRungObjects(startedAt, "720p30");
      expect(
        (await call(member, "GET", `${historyPath()}/${startedAt}/download`))
          .status,
      ).toBe(403);
      expect((await getRaw(downloadPath(startedAt, "film"), member)).status).toBe(
        403,
      );
    });

    it("409s once the recording is gone", async () => {
      const startedAt = 1_700_000_032_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      seedRungObjects(startedAt, "720p30");
      await getPool().query(
        `UPDATE hls_sessions SET cleaned_at = NOW() WHERE channel_id = $1`,
        [channelId],
      );
      resetHlsReplayCachesForTests();
      resetWatchPartyDownloadCacheForTests();
      expect(
        (await call(owner, "GET", `${historyPath()}/${startedAt}/download`))
          .status,
      ).toBe(409);
      expect((await getRaw(downloadPath(startedAt, "film"), owner)).status).toBe(
        409,
      );
    });

    it("concatenates the TOP rung's segments in playlist order", async () => {
      const startedAt = 1_700_000_033_000;
      await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        rungs: ["480p30", "1080p30"],
      });
      seedRungObjects(startedAt, "1080p30");
      seedRungObjects(startedAt, "480p30");

      const res = await download(downloadPath(startedAt, "film"), owner);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp2t");
      expect(res.headers.get("content-disposition")).toMatch(
        /^attachment; filename="[a-z0-9-]+\.ts"$/,
      );
      // Playlist order, which is the REVERSE of the key order here.
      expect(await res.text()).toBe("[1080p30-second][1080p30-first]");
    });

    it("serves the camera pip and the voice archive as their own files", async () => {
      const startedAt = 1_700_000_034_000;
      await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        rungs: ["720p30", CAMERA_RUNG_NAME, "mic"],
      });
      seedRungObjects(startedAt, "720p30");
      seedRungObjects(startedAt, CAMERA_RUNG_NAME);
      objects.set(`live/${channelId}/${startedAt}-mic.ogg`, "[opus]");

      const camera = await getRaw(downloadPath(startedAt, "camera"), owner);
      expect(camera.status).toBe(200);
      expect(camera.text).toBe(
        `[${CAMERA_RUNG_NAME}-second][${CAMERA_RUNG_NAME}-first]`,
      );

      const voice = await download(downloadPath(startedAt, "voice"), owner);
      expect(voice.status).toBe(200);
      expect(voice.headers.get("content-type")).toBe("audio/ogg");
      expect(voice.headers.get("content-disposition")).toContain("-voice.ogg");
      expect(await voice.text()).toBe("[opus]");
    });

    it("404s a kind this broadcast never wrote", async () => {
      const startedAt = 1_700_000_035_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      seedRungObjects(startedAt, "720p30");
      expect(
        (await getRaw(downloadPath(startedAt, "voice"), owner)).status,
      ).toBe(404);
      expect(
        (await getRaw(downloadPath(startedAt, "camera"), owner)).status,
      ).toBe(404);
      expect((await getRaw(downloadPath(startedAt, "banana"), owner)).status)
        .toBe(404);
    });

    it("503s when storage will not answer, rather than saying the files are not there", async () => {
      const startedAt = 1_700_000_037_000;
      await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        rungs: ["720p30", CAMERA_RUNG_NAME],
      });
      seedRungObjects(startedAt, "720p30");
      seedRungObjects(startedAt, CAMERA_RUNG_NAME);
      // The bucket is up enough to answer, and answers 500.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          return url.includes("s3.example.test")
            ? new Response("boom", { status: 500 })
            : realFetch(input, init);
        }),
      );
      // "Could not list" is not "camera not used": the dialog has to be able
      // to tell an outage from a fact about the night.
      expect(
        (await call(owner, "GET", `${historyPath()}/${startedAt}/download`))
          .status,
      ).toBe(503);
    });

    it("409s a half-swept recording instead of streaming a truncated file", async () => {
      const startedAt = 1_700_000_038_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      seedRungObjects(startedAt, "720p30");
      // The playlist still names both segments; one of the objects is gone.
      objects.delete(`live/${channelId}/${startedAt}-720p30_00000.ts`);
      const res = await download(downloadPath(startedAt, "film"), owner);
      expect(res.status).toBe(409);
      // And nothing of the file was written before the refusal.
      expect(res.headers.get("content-disposition")).toBeNull();
    });

    it("serves a header-less request carrying only the capability", async () => {
      const startedAt = 1_700_000_036_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      seedRungObjects(startedAt, "720p30");
      const token = mintHlsViewerToken({
        userId: owner.id,
        channelId,
        startedAt,
        purpose: "replay",
      });
      const res = await getRaw(
        `${downloadPath(startedAt, "film")}?t=${token}`,
        null,
      );
      expect(res.status).toBe(200);
      expect(res.text).toBe("[720p30-second][720p30-first]");

      // A token minted for another channel is nobody's capability here.
      const wrong = mintHlsViewerToken({
        userId: owner.id,
        channelId: "00000000-0000-4000-8000-000000000000",
        startedAt,
        purpose: "replay",
      });
      expect(
        (await getRaw(`${downloadPath(startedAt, "film")}?t=${wrong}`, null))
          .status,
      ).toBe(401);
    });
  });
});
