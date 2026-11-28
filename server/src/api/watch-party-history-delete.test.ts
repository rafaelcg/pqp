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
 * `DELETE /api/channels/:channelId/watch-party/history/:sessionAt`, "Apagar
 * gravacao": a moderator removes one whole broadcast for everybody.
 *
 * Real Postgres, and an in-memory bucket behind a stubbed `fetch` (list, GET
 * and DELETE), so what is proved is the whole chain: the stamp, every door
 * that must refuse the broadcast afterwards (including the ones that hold
 * caches or a capability token minted BEFORE the delete), and the objects
 * actually leaving the bucket through the retention sweep's guarded path.
 *
 * The property the design rests on: the delete is a database write, and every
 * reader refuses the broadcast from that instant. Storage is cleaned after,
 * and a storage failure must change nothing a user can see
 * ("storage fails" below).
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
const { countDueSessions, resetHlsSweepWarningsForTests, sweepHlsSessions } =
  await import("../voice/hls-cleanup.js");
const { setLiveHlsTestHooks, resetLiveHlsForTests } = await import(
  "../voice/hls-egress.js"
);
const { CAMERA_RUNG_NAME } = await import("../voice/hls-ladder.js");
const { resetHlsReplayCachesForTests, resetWatchPartyDownloadCacheForTests } =
  await import("../voice/hls-history.js");

type Person = { id: string; clerk_id: string };

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;

/** The whole bucket, key -> body, plus a switch that makes DELETE fail. */
const bucket = new Map<string, string>();
let failDeletes = false;

interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  as: Person | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  actor = as;
  const response = await realFetch(`${baseUrl}${path}`, {
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

/** A GET with no Authorization header at all: what hls.js and a browser
 * navigating to a download link actually send. */
async function getNoHeader(
  path: string,
): Promise<{ status: number; text: string }> {
  actor = null;
  const response = await realFetch(`${baseUrl}${path}`);
  return { status: response.status, text: await response.text() };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeDb("DELETE watch party history", () => {
  let owner: Person;
  let moderator: Person;
  let member: Person;
  let outsider: Person;
  let serverId: string;
  let channelId: string;
  let otherChannelId: string;

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
    bucket.clear();
    failDeletes = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes("s3.example.test")) {
          return realFetch(input, init);
        }
        const parsed = new URL(url);
        const method = init?.method ?? "GET";
        if (parsed.searchParams.get("list-type") === "2") {
          const prefix = parsed.searchParams.get("prefix") ?? "";
          const contents = [...bucket]
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
        if (method === "DELETE") {
          if (failDeletes) {
            return new Response("boom", { status: 500 });
          }
          bucket.delete(key);
          return new Response(null, { status: 204 });
        }
        const body = bucket.get(key);
        return body === undefined
          ? new Response("no such key", { status: 404 })
          : new Response(body, { status: 200 });
      }),
    );
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels,
                server_members, channel_sessions, hls_sessions, audit_log
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
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });

    const created = await call<{
      server: { id: string };
      channels: { id: string; type: string }[];
    }>(owner, "POST", "/api/servers", { name: "Delete a recording" });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    const voice = created.body.channels.filter((c) => c.type === "voice");
    channelId = voice[0]!.id;
    const second = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position)
       VALUES ($1, 'outro', 'voice', 9) RETURNING id`,
      [serverId],
    );
    otherChannelId = second.rows[0]!.id;

    for (const person of [moderator, member]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [serverId, person.id],
      );
    }
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
    delete process.env.LIVE_HLS_RETENTION_MINUTES;
    delete process.env.LIVE_HLS_REPLAY_HOURS;
  });

  const historyPath = (id = channelId): string =>
    `/api/channels/${id}/watch-party/history`;

  /** One broadcast: a row per rung, optionally with objects for each. The
   * mic and camera are rows of the same group, as in production. */
  async function seedBroadcast(options: {
    startedAt: number;
    endedMinutesAgo: number | null;
    keepReplay?: boolean;
    rungs?: string[];
    channel?: string;
    /** `egress_id` for the first rung, so its manifest object is swept. */
    egressId?: string;
    /** Rows that stay open (ended_at NULL) whatever `endedMinutesAgo` says. */
    openRungs?: string[];
  }): Promise<string[]> {
    const channel = options.channel ?? channelId;
    const endedAt =
      options.endedMinutesAgo === null
        ? null
        : new Date(Date.now() - options.endedMinutesAgo * 60_000);
    const prefixes: string[] = [];
    let first = true;
    for (const rung of options.rungs ?? ["720p30"]) {
      const prefix = `live/${channel}/${options.startedAt}-${rung}`;
      prefixes.push(prefix);
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung, egress_id)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7)`,
        [
          channel,
          prefix,
          options.startedAt,
          options.openRungs?.includes(rung) ? null : endedAt,
          options.keepReplay ?? false,
          rung,
          first ? (options.egressId ?? null) : null,
        ],
      );
      first = false;
    }
    return prefixes;
  }

  /** A rung's segment, its accumulated playlist, and a restart run. */
  function seedObjects(prefix: string, startedAt: number): void {
    const name = prefix.split("/").pop()!;
    bucket.set(`${prefix}_00000.ts`, "[first]");
    bucket.set(`${prefix}-r999_00000.ts`, "[run-two]");
    bucket.set(`${prefix}-r999-index.m3u8`, "#EXTM3U");
    bucket.set(
      `${prefix}-index.m3u8`,
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXTINF:2.0,",
        `${name}_00000.ts`,
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );
    void startedAt;
  }

  async function stamped(
    startedAt: number,
    channel = channelId,
  ): Promise<{ rung: string | null; deleted: boolean; cleaned: boolean }[]> {
    const rows = await getPool().query<{
      rung: string | null;
      deleted: boolean;
      cleaned: boolean;
    }>(
      `SELECT rung, deleted_at IS NOT NULL AS deleted, cleaned_at IS NOT NULL AS cleaned
       FROM hls_sessions
       WHERE channel_id = $1 AND started_at = to_timestamp($2 / 1000.0)
       ORDER BY rung`,
      [channel, startedAt],
    );
    return rows.rows;
  }

  describe("access", () => {
    it("401s with no session", async () => {
      await seedBroadcast({ startedAt: 1_700_100_000_000, endedMinutesAgo: 5 });
      expect(
        (await call(null, "DELETE", `${historyPath()}/1700100000000`)).status,
      ).toBe(401);
    });

    it("403s a plain member, deletes nothing", async () => {
      await seedBroadcast({ startedAt: 1_700_100_000_000, endedMinutesAgo: 5 });
      const res = await call(member, "DELETE", `${historyPath()}/1700100000000`);
      expect(res.status).toBe(403);
      expect((await stamped(1_700_100_000_000)).every((r) => !r.deleted)).toBe(
        true,
      );
    });

    it("refuses somebody who is not in the server at all", async () => {
      await seedBroadcast({ startedAt: 1_700_100_000_000, endedMinutesAgo: 5 });
      const res = await call(
        outsider,
        "DELETE",
        `${historyPath()}/1700100000000`,
      );
      expect([403, 404]).toContain(res.status);
      expect((await stamped(1_700_100_000_000)).every((r) => !r.deleted)).toBe(
        true,
      );
    });

    it("lets a moderator (START_WATCH_PARTY overwrite) and the owner delete", async () => {
      await seedBroadcast({ startedAt: 1_700_100_001_000, endedMinutesAgo: 5 });
      await seedBroadcast({ startedAt: 1_700_100_002_000, endedMinutesAgo: 5 });
      expect(
        (await call(moderator, "DELETE", `${historyPath()}/1700100001000`))
          .status,
      ).toBe(200);
      expect(
        (await call(owner, "DELETE", `${historyPath()}/1700100002000`)).status,
      ).toBe(200);
    });

    it("404s an unknown broadcast, a malformed id, and a second delete", async () => {
      expect(
        (await call(owner, "DELETE", `${historyPath()}/1700100000000`)).status,
      ).toBe(404);
      expect(
        (await call(owner, "DELETE", `${historyPath()}/not-a-time`)).status,
      ).toBe(404);
      await seedBroadcast({ startedAt: 1_700_100_003_000, endedMinutesAgo: 5 });
      expect(
        (await call(owner, "DELETE", `${historyPath()}/1700100003000`)).status,
      ).toBe(200);
      expect(
        (await call(owner, "DELETE", `${historyPath()}/1700100003000`)).status,
      ).toBe(404);
    });

    it("cannot delete a broadcast through another channel's id", async () => {
      await seedBroadcast({ startedAt: 1_700_100_004_000, endedMinutesAgo: 5 });
      const res = await call(
        owner,
        "DELETE",
        `${historyPath(otherChannelId)}/1700100004000`,
      );
      expect(res.status).toBe(404);
      expect((await stamped(1_700_100_004_000)).every((r) => !r.deleted)).toBe(
        true,
      );
    });
  });

  describe("a live broadcast", () => {
    it("409s while any row of the group is still open, and stamps nothing", async () => {
      // The film ended, the camera pip row never did: the group is on air.
      await seedBroadcast({
        startedAt: 1_700_100_010_000,
        endedMinutesAgo: 5,
        rungs: ["720p30", CAMERA_RUNG_NAME],
        openRungs: [CAMERA_RUNG_NAME],
      });
      const res = await call(owner, "DELETE", `${historyPath()}/1700100010000`);
      expect(res.status).toBe(409);
      expect((await stamped(1_700_100_010_000)).every((r) => !r.deleted)).toBe(
        true,
      );
    });

    it("409s a broadcast with no row ended at all", async () => {
      await seedBroadcast({ startedAt: 1_700_100_011_000, endedMinutesAgo: null });
      expect(
        (await call(owner, "DELETE", `${historyPath()}/1700100011000`)).status,
      ).toBe(409);
    });
  });

  describe("stamping and the list", () => {
    it("stamps EVERY row of the group, leaves other broadcasts alone, and answers the fresh list", async () => {
      const gone = 1_700_100_020_000;
      const kept = 1_700_100_021_000;
      await seedBroadcast({
        startedAt: gone,
        endedMinutesAgo: 5,
        keepReplay: true,
        rungs: ["1080p30", "720p30", CAMERA_RUNG_NAME, "mic"],
      });
      await seedBroadcast({
        startedAt: kept,
        endedMinutesAgo: 5,
        keepReplay: true,
        rungs: ["720p30", "mic"],
      });
      // Same startedAt, another channel: must not be touched either.
      await seedBroadcast({
        startedAt: gone,
        endedMinutesAgo: 5,
        channel: otherChannelId,
      });

      const res = await call<{ broadcasts: { sessionId: string }[] }>(
        owner,
        "DELETE",
        `${historyPath()}/${gone}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.broadcasts.map((b) => b.sessionId)).toEqual([String(kept)]);

      const rows = await stamped(gone);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.deleted)).toBe(true);
      expect((await stamped(kept)).every((r) => !r.deleted)).toBe(true);
      expect((await stamped(gone, otherChannelId)).every((r) => !r.deleted)).toBe(
        true,
      );

      const list = await call<{ broadcasts: { sessionId: string }[] }>(
        owner,
        "GET",
        historyPath(),
      );
      expect(list.body.broadcasts.map((b) => b.sessionId)).toEqual([String(kept)]);
    });

    it("hides the group even if only its camera row carries the stamp", async () => {
      const startedAt = 1_700_100_022_000;
      await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        rungs: ["720p30", CAMERA_RUNG_NAME],
      });
      await getPool().query(
        `UPDATE hls_sessions SET deleted_at = NOW() WHERE rung = $1`,
        [CAMERA_RUNG_NAME],
      );
      const list = await call<{ broadcasts: unknown[] }>(
        owner,
        "GET",
        historyPath(),
      );
      expect(list.body.broadcasts).toEqual([]);
    });

    it("writes who deleted what to the server's audit log", async () => {
      const startedAt = 1_700_100_023_000;
      await seedBroadcast({ startedAt, endedMinutesAgo: 5 });
      await call(moderator, "DELETE", `${historyPath()}/${startedAt}`);
      const rows = await getPool().query<{
        server_id: string;
        actor_id: string;
        action: string;
        target_type: string;
        target_id: string;
        changes: { key: string; new: string }[];
      }>(`SELECT server_id, actor_id, action, target_type, target_id, changes FROM audit_log`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        server_id: serverId,
        actor_id: moderator.id,
        action: "watch_party.recording_delete",
        target_type: "channel",
        target_id: channelId,
      });
      expect(rows.rows[0]!.changes[0]).toEqual({
        key: "startedAt",
        old: null,
        new: new Date(startedAt).toISOString(),
      });
    });

    it("writes no audit row when the delete is refused", async () => {
      await seedBroadcast({
        startedAt: 1_700_100_024_000,
        endedMinutesAgo: null,
      });
      await call(owner, "DELETE", `${historyPath()}/1700100024000`);
      await call(member, "DELETE", `${historyPath()}/1700100024000`);
      const rows = await getPool().query(`SELECT 1 FROM audit_log`);
      expect(rows.rowCount).toBe(0);
    });
  });

  describe("every door refuses a deleted broadcast", () => {
    const startedAt = 1_700_100_030_000;

    async function seedWithObjects(): Promise<void> {
      const prefixes = await seedBroadcast({
        startedAt,
        endedMinutesAgo: 5,
        keepReplay: true,
        rungs: ["720p30", CAMERA_RUNG_NAME, "mic"],
      });
      for (const prefix of prefixes) {
        seedObjects(prefix, startedAt);
      }
    }

    it("replay mint, the replay playlist (header and token doors, cached and not), downloads and PATCH", async () => {
      await seedWithObjects();

      // Everything minted BEFORE the delete, and every cache warmed.
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/${startedAt}/replay`,
      );
      expect(minted.status).toBe(200);
      const master = await getNoHeader(minted.body.hlsUrl);
      expect(master.status).toBe(200);
      const variantUrl = master.text
        .split("\n")
        .find((line) => line.includes("/api/voice/hls-replay/"))!;
      expect((await getNoHeader(variantUrl)).status).toBe(200);
      const downloads = await call<{
        downloads: Record<string, { url: string } | null>;
      }>(owner, "GET", `${historyPath()}/${startedAt}/download`);
      expect(downloads.status).toBe(200);
      const filmUrl = downloads.body.downloads.film!.url;
      const voiceUrl = downloads.body.downloads.voice!.url;
      expect((await getNoHeader(filmUrl)).status).toBe(200);

      const del = await call(owner, "DELETE", `${historyPath()}/${startedAt}`);
      expect(del.status).toBe(200);

      // Mint: 404 for the owner.
      expect(
        (await call(owner, "GET", `${historyPath()}/${startedAt}/replay`)).status,
      ).toBe(404);
      // The playlists, with the capability only (hls.js's real shape) ...
      expect((await getNoHeader(minted.body.hlsUrl)).status).toBe(404);
      expect((await getNoHeader(variantUrl)).status).toBe(404);
      // ... and through the Bearer door, even for the owner, even for a
      // never-cached rung route.
      actor = owner;
      for (const path of [
        `/api/voice/hls-replay/${channelId}/${startedAt}`,
        `/api/voice/hls-replay/${channelId}/${startedAt}/720p30`,
      ]) {
        const r = await realFetch(`${baseUrl}${path}`, {
          headers: { Authorization: "Bearer test" },
        });
        expect(r.status).toBe(404);
      }
      // Download: the sizes endpoint, then the byte route through both doors.
      expect(
        (await call(owner, "GET", `${historyPath()}/${startedAt}/download`))
          .status,
      ).toBe(404);
      expect((await getNoHeader(filmUrl)).status).toBe(404);
      expect((await getNoHeader(voiceUrl)).status).toBe(404);
      actor = owner;
      const bearer = await realFetch(
        `${baseUrl}${historyPath()}/${startedAt}/download/film`,
        { headers: { Authorization: "Bearer test" } },
      );
      expect(bearer.status).toBe(404);
      // And the keep toggle.
      expect(
        (
          await call(owner, "PATCH", `${historyPath()}/${startedAt}`, {
            keepReplay: false,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe("storage cleanup", () => {
    it("removes every object of the broadcast (runs, camera, mic, manifest) and nothing of another", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "1";
      const gone = 1_700_100_040_000;
      const kept = 1_700_100_041_000;
      const prefixes = await seedBroadcast({
        startedAt: gone,
        endedMinutesAgo: 30,
        keepReplay: true,
        rungs: ["1080p30", "720p30", CAMERA_RUNG_NAME, "mic"],
        egressId: "EG_gone",
      });
      const keptPrefixes = await seedBroadcast({
        startedAt: kept,
        endedMinutesAgo: 30,
        keepReplay: true,
      });
      for (const prefix of [...prefixes, ...keptPrefixes]) {
        seedObjects(prefix, gone);
      }
      bucket.set(`live/${channelId}/EG_gone.json`, "{}");
      bucket.set(`live/${channelId}/EG_other.json`, "{}");
      bucket.set(`live/${otherChannelId}/${gone}-720p30_00000.ts`, "[other]");

      expect(
        (await call(owner, "DELETE", `${historyPath()}/${gone}`)).status,
      ).toBe(200);
      await waitFor(
        () =>
          ![...bucket.keys()].some((key) =>
            key.startsWith(`live/${channelId}/${gone}`),
          ),
        "the kicked cleanup to empty the broadcast's prefixes",
      );

      expect(bucket.has(`live/${channelId}/EG_gone.json`)).toBe(false);
      // Untouched: the other broadcast, an unrelated manifest, another channel.
      expect(
        [...bucket.keys()].filter((key) =>
          key.startsWith(`live/${channelId}/${kept}`),
        ),
      ).toHaveLength(keptPrefixes.length * 4);
      expect(bucket.has(`live/${channelId}/EG_other.json`)).toBe(true);
      expect(bucket.has(`live/${otherChannelId}/${gone}-720p30_00000.ts`)).toBe(
        true,
      );
      await waitFor(
        async () => (await stamped(gone)).every((r) => r.cleaned),
        "the rows to be stamped cleaned",
      );
      // Tombstones stay, hidden.
      expect((await stamped(gone)).every((r) => r.deleted)).toBe(true);
    });

    it("covers a low-latency session: its directory prefix, film and playlists", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "1";
      const startedAt = 1_700_100_042_000;
      const prefix = `live/${channelId}/${startedAt}-ll`;
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, mode)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '3 hours', TRUE, 'll')`,
        [channelId, prefix, startedAt],
      );
      for (const name of [
        "master.m3u8",
        "video.m3u8",
        "audio.m3u8",
        "video-init-0.mp4",
        "video-seg-1.m4s",
        "film.mp4",
        "film.json",
      ]) {
        bucket.set(`${prefix}/${name}`, "x");
      }
      bucket.set(`live/${channelId}/${startedAt + 1}-ll/video.m3u8`, "next");

      const res = await call<{ broadcasts: unknown[] }>(
        owner,
        "DELETE",
        `${historyPath()}/${startedAt}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.broadcasts).toEqual([]);
      await waitFor(
        () => ![...bucket.keys()].some((key) => key.startsWith(prefix)),
        "the LL directory to be emptied",
      );
      expect(bucket.has(`live/${channelId}/${startedAt + 1}-ll/video.m3u8`)).toBe(
        true,
      );
      await waitFor(
        async () => (await stamped(startedAt)).every((r) => r.cleaned),
        "the LL row to be cleaned",
      );
    });

    it("keeps sweeping a freshly ended deleted row until a late writer (the LL film, a closing egress) is past", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      const startedAt = 1_700_100_043_000;
      const prefixes = await seedBroadcast({
        startedAt,
        endedMinutesAgo: 2,
        keepReplay: true,
      });
      seedObjects(prefixes[0]!, startedAt);

      expect(
        (await call(owner, "DELETE", `${historyPath()}/${startedAt}`)).status,
      ).toBe(200);
      await waitFor(
        () => ![...bucket.keys()].some((key) => key.startsWith(prefixes[0]!)),
        "objects gone on the first pass",
      );
      // Still due: not stamped cleaned yet.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await stamped(startedAt)).every((r) => !r.cleaned)).toBe(true);
      expect(await countDueSessions()).toBe(1);

      // A late write lands (the film, a last segment) ...
      bucket.set(`${prefixes[0]}_00099.ts`, "[late]");
      expect(await sweepHlsSessions()).toBe(0);
      expect(bucket.has(`${prefixes[0]}_00099.ts`)).toBe(false);

      // ... and once the settle window has passed the row is closed for good.
      await getPool().query(
        `UPDATE hls_sessions SET ended_at = NOW() - interval '20 minutes'
         WHERE channel_id = $1`,
        [channelId],
      );
      expect(await sweepHlsSessions()).toBe(1);
      expect((await stamped(startedAt)).every((r) => r.cleaned)).toBe(true);
      expect(await countDueSessions()).toBe(0);
    });
  });

  describe("the sweep", () => {
    it("takes a deleted + kept row at once, and leaves an undeleted kept one alone", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      process.env.LIVE_HLS_REPLAY_HOURS = "720";
      const gone = 1_700_100_050_000;
      const kept = 1_700_100_051_000;
      const gonePrefixes = await seedBroadcast({
        startedAt: gone,
        endedMinutesAgo: 60 * 24 * 2,
        keepReplay: true,
        rungs: ["720p30", "mic"],
      });
      const keptPrefixes = await seedBroadcast({
        startedAt: kept,
        endedMinutesAgo: 60 * 24 * 2,
        keepReplay: true,
      });
      for (const prefix of [...gonePrefixes, ...keptPrefixes]) {
        seedObjects(prefix, gone);
      }
      // Stamp directly: this is the sweep as the BACKSTOP, no kick involved.
      await getPool().query(
        `UPDATE hls_sessions SET deleted_at = NOW()
         WHERE started_at = to_timestamp($1 / 1000.0)`,
        [gone],
      );
      expect(await countDueSessions()).toBe(2);

      expect(await sweepHlsSessions()).toBe(2);

      for (const prefix of gonePrefixes) {
        expect([...bucket.keys()].some((k) => k.startsWith(prefix))).toBe(false);
      }
      for (const prefix of keptPrefixes) {
        expect([...bucket.keys()].filter((k) => k.startsWith(prefix))).toHaveLength(
          4,
        );
      }
      expect((await stamped(kept)).every((r) => !r.cleaned)).toBe(true);
    });

    it("still refuses a prefix that is not the row's own channel's", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "10";
      const startedAt = 1_700_100_052_000;
      const strangerKey = `live/${otherChannelId}/${startedAt}-720p30_00000.ts`;
      bucket.set(strangerKey, "[stranger]");
      await getPool().query(
        `INSERT INTO hls_sessions
           (channel_id, object_prefix, started_at, ended_at, keep_replay, rung, deleted_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW() - interval '2 days', TRUE, '720p30', NOW())`,
        [channelId, `live/${otherChannelId}/${startedAt}-720p30`, startedAt],
      );
      expect(await sweepHlsSessions()).toBe(0);
      expect(bucket.has(strangerKey)).toBe(true);
      expect((await stamped(startedAt)).every((r) => !r.cleaned)).toBe(true);
    });

    it("does not sweep a deleted row while its egress is still running", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "1";
      const startedAt = 1_700_100_053_000;
      const prefixes = await seedBroadcast({
        startedAt,
        endedMinutesAgo: 30,
        egressId: "EG_alive",
      });
      seedObjects(prefixes[0]!, startedAt);
      setLiveHlsTestHooks({
        egress: {
          startTrackCompositeEgress: async () => ({ egressId: "unused" }),
          stopEgress: async () => {},
          listEgress: async () => [{ egressId: "EG_alive", status: 1 }],
        },
      });
      await call(owner, "DELETE", `${historyPath()}/${startedAt}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await sweepHlsSessions()).toBe(0);
      expect(bucket.size).toBeGreaterThan(0);
    });
  });

  describe("storage fails", () => {
    it("the delete still succeeds and the broadcast is refused everywhere; the sweep finishes once storage is back", async () => {
      process.env.LIVE_HLS_RETENTION_MINUTES = "1";
      const startedAt = 1_700_100_060_000;
      const prefixes = await seedBroadcast({
        startedAt,
        endedMinutesAgo: 30,
        keepReplay: true,
      });
      seedObjects(prefixes[0]!, startedAt);
      const minted = await call<{ hlsUrl: string }>(
        owner,
        "GET",
        `${historyPath()}/${startedAt}/replay`,
      );
      expect(minted.status).toBe(200);

      failDeletes = true;
      const res = await call<{ broadcasts: unknown[] }>(
        owner,
        "DELETE",
        `${historyPath()}/${startedAt}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.broadcasts).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Nothing was removed, yet nothing can reach it.
      expect(bucket.size).toBeGreaterThan(0);
      expect((await getNoHeader(minted.body.hlsUrl)).status).toBe(404);
      expect(
        (await call(owner, "GET", `${historyPath()}/${startedAt}/replay`)).status,
      ).toBe(404);
      expect((await call(owner, "GET", historyPath())).body).toEqual({
        broadcasts: [],
      });
      // And it is owed: due for the sweep, failing quietly while storage is down.
      expect((await stamped(startedAt)).every((r) => !r.cleaned)).toBe(true);
      expect(await countDueSessions()).toBe(1);
      expect(await sweepHlsSessions()).toBe(0);

      failDeletes = false;
      expect(await sweepHlsSessions()).toBe(1);
      expect(bucket.size).toBe(0);
      expect(await countDueSessions()).toBe(0);
    });
  });
});
