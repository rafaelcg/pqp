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
 * The signed-out live preview, over HTTP through `handleApi`, on a real
 * database. Pinned here, with the flag OFF and ON (pitfall 12):
 *
 *  - flag off: the public community and invite bodies are unchanged and the
 *    new routes are not even matched (they 401 like any unknown path);
 *  - flag on: only a community, not suspended, only a watch party channel
 *    @everyone can VIEW, only while a session is live;
 *  - the mint needs the age declaration, hands back a token that expires with
 *    the window, never a party pass, and cannot be renewed past the window;
 *  - the token plays the playlist with no header AND with a dead Bearer
 *    beside it (pitfall 16), is not counted as a viewer, and stops working
 *    the moment the flag goes off or the channel goes private;
 *  - the token opens no other door (replay);
 *  - a garbage Bearer on the start route changes nothing;
 *  - a new window costs from an address bucket that runs out.
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

const viewerNotes = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../voice/hls-viewer-counts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/hls-viewer-counts.js")>();
  return {
    ...actual,
    noteHlsViewer: (...args: Parameters<typeof actual.noteHlsViewer>) => {
      viewerNotes.calls += 1;
      return actual.noteHlsViewer(...args);
    },
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { createInvite } = await import("../services/invites.js");
const flags = await import("../lib/flags.js");
const {
  livePreviewMetrics,
  mintLivePreviewTicket,
  resetLivePreviewForTests,
} = await import("../services/live-preview.js");
const { decodeHlsViewerToken, mintHlsPreviewToken } = await import(
  "../voice/hls-viewer-token.js"
);
const { resetHlsPlaylistCacheForTests } = await import(
  "../voice/hls-playlist-proxy.js"
);

/** Recent, whole seconds: a session row older than 12 hours is not "live". */
const STARTED_AT = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const EDGE = "https://hls.edge.test";
const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-PROGRAM-DATE-TIME:2026-09-12T10:10:39.718Z",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
].join("\n");

let server: Server;
let baseUrl: string;
const realFetch = globalThis.fetch;

interface Res {
  status: number;
  body: unknown;
  text: string;
  cache: string | null;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  actor = null;
  const response = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text, cache: response.headers.get("cache-control") };
}

interface StartBody {
  stream: { hlsUrl: string; startedAt: number; mode?: string };
  channel: { id: string; name: string };
  ticket: string;
  expiresAt: number;
  remainingMs: number;
}

function tokenOf(url: string): string {
  return new URL(url, "http://x").searchParams.get("t")!;
}

/** The API-relative path (and query) of a stamped URL, whatever its host. */
function pathOf(url: string): string {
  const parsed = new URL(url, "http://x");
  return `${parsed.pathname}${parsed.search}`;
}

describeDb("signed-out live preview", () => {
  let ownerId: string;
  let serverId: string;
  let otherServerId: string;
  let liveChannel: string;
  let privateChannel: string;
  let deniedChannel: string;
  let idleChannel: string;
  let voiceChannel: string;
  let otherLiveChannel: string;

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

  async function channel(
    sid: string,
    name: string,
    type: string,
    isPrivate = false,
  ): Promise<string> {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, is_private)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sid, name, type, isPrivate],
    );
    return result.rows[0]!.id;
  }

  async function goLive(channelId: string, rung: string | null = null): Promise<void> {
    await getPool().query(
      `INSERT INTO hls_sessions (channel_id, object_prefix, started_at, presenter_peer_id, rung)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 'peer-1', $4)`,
      [
        channelId,
        `live/${channelId}/${STARTED_AT}${rung ? `-${rung}` : ""}`,
        STARTED_AT,
        rung,
      ],
    );
  }

  beforeEach(async () => {
    resetApiRateLimits();
    resetLivePreviewForTests();
    resetHlsPlaylistCacheForTests();
    flags.resetFeatureFlagsForTests();
    viewerNotes.calls = 0;
    process.env.CLERK_SECRET_KEY = "sk_test_live_preview";
    process.env.COMMUNITIES_ENABLED = "true";
    delete process.env.LIVE_PREVIEW;
    delete process.env.LIVE_PREVIEW_SECONDS;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://live.example.test/") || url.includes("s3.example.test/")) {
          return new Response(PLAYLIST_BODY, { status: 200 });
        }
        return realFetch(input, init);
      }),
    );
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                audit_log, hls_sessions, channel_overwrites, roles,
                feature_flags, feature_flag_overrides, feature_flag_audit
       RESTART IDENTITY CASCADE`,
    );
    const owner = await upsertUser({ clerkId: "clerk_owner", displayName: "Owner", avatarUrl: null });
    ownerId = owner.id;
    const created = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, is_community, community_slug)
       VALUES ('Sala do Rafa', $1, TRUE, 'sala-do-rafa') RETURNING id`,
      [owner.id],
    );
    serverId = created.rows[0]!.id;
    const other = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, is_community, community_slug)
       VALUES ('Outra', $1, TRUE, 'outra-sala') RETURNING id`,
      [owner.id],
    );
    otherServerId = other.rows[0]!.id;
    const { seedDefaultRoles } = await import("../services/permissions.js");
    for (const sid of [serverId, otherServerId]) {
      await seedDefaultRoles(getPool(), sid);
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [sid, owner.id],
      );
    }
    liveChannel = await channel(serverId, "cinema", "watch_party");
    privateChannel = await channel(serverId, "vip", "watch_party", true);
    deniedChannel = await channel(serverId, "staff-only", "watch_party");
    idleChannel = await channel(serverId, "sessao-da-tarde", "watch_party");
    voiceChannel = await channel(serverId, "call", "voice");
    otherLiveChannel = await channel(otherServerId, "telão", "watch_party");
    const everyone = await getPool().query<{ id: string }>(
      `SELECT id FROM roles WHERE server_id = $1 AND is_everyone`,
      [serverId],
    );
    // @everyone denied VIEW on one public-looking channel: not previewable.
    await getPool().query(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'role', $2, 0, 64)`,
      [deniedChannel, everyone.rows[0]!.id],
    );
    for (const id of [liveChannel, privateChannel, deniedChannel, voiceChannel, otherLiveChannel]) {
      await goLive(id);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
    delete process.env.LIVE_PREVIEW;
    delete process.env.LIVE_PREVIEW_SECONDS;
    delete process.env.COMMUNITIES_ENABLED;
  });

  function start(channelId: string, extra: Record<string, unknown> = {}, headers = {}) {
    return call("POST", "/api/public/live-preview/start", {
      body: { channelId, ageConfirmed: true, ...extra },
      headers,
    });
  }

  // ------------------------------------------------------------- flag off

  describe("with the flag off", () => {
    it("leaves the public community and invite bodies exactly as they were", async () => {
      const community = await call("GET", "/api/public/communities/sala-do-rafa");
      expect(community.status).toBe(200);
      expect(Object.keys((community.body as { community: object }).community)).not.toContain(
        "livePreview",
      );
      const code = (await createInvite(serverId, ownerId, {})).code;
      const invite = await call("GET", `/api/public/invites/${code}`);
      expect(invite.status).toBe(200);
      expect(invite.body).toEqual({
        invite: { serverName: "Sala do Rafa", iconUrl: null, memberCount: expect.any(Number) },
      });
    });

    it("does not even match the new routes: they 401 like any unknown path", async () => {
      expect((await call("GET", "/api/public/live-preview/communities/sala-do-rafa")).status).toBe(401);
      const code = (await createInvite(serverId, ownerId, {})).code;
      expect((await call("GET", `/api/public/live-preview/invites/${code}`)).status).toBe(401);
      expect((await start(liveChannel)).status).toBe(401);
    });

    it("is off with the flag on but communities off for the deployment", async () => {
      process.env.LIVE_PREVIEW = "true";
      process.env.COMMUNITIES_ENABLED = "false";
      expect((await start(liveChannel)).status).toBe(401);
    });

    it("an existing live token cannot be swapped for a preview: the preview purpose is opt-in", async () => {
      const token = mintHlsPreviewToken({
        visitorId: "v1",
        channelId: liveChannel,
        startedAt: STARTED_AT,
        expiresAt: Date.now() + 60_000,
      })!;
      expect(decodeHlsViewerToken(token)).toBeNull();
      expect(decodeHlsViewerToken(token, Date.now(), { allowPreview: true })?.purpose).toBe(
        "preview",
      );
    });
  });

  // -------------------------------------------------------------- flag on

  describe("with the flag on", () => {
    beforeEach(() => {
      process.env.LIVE_PREVIEW = "true";
    });

    it("marks the community and its invites, and nothing else changes in those bodies", async () => {
      const community = await call("GET", "/api/public/communities/sala-do-rafa");
      expect((community.body as { community: { livePreview?: boolean } }).community.livePreview).toBe(
        true,
      );
      const code = (await createInvite(serverId, ownerId, {})).code;
      const invite = await call("GET", `/api/public/invites/${code}`);
      expect(invite.body).toEqual({
        invite: {
          serverName: "Sala do Rafa",
          iconUrl: null,
          memberCount: expect.any(Number),
          livePreview: true,
        },
      });
    });

    it("lists only the live watch party channels @everyone can view", async () => {
      const listing = await call("GET", "/api/public/live-preview/communities/sala-do-rafa");
      expect(listing.status).toBe(200);
      expect(listing.cache).toBe("public, max-age=10");
      expect(listing.body).toEqual({
        livePreview: { channels: [{ id: liveChannel, name: "cinema" }], seconds: 300 },
      });
      const code = (await createInvite(serverId, ownerId, {})).code;
      const byInvite = await call("GET", `/api/public/live-preview/invites/${code}`);
      expect(byInvite.body).toEqual(listing.body);
    });

    it("refuses a private server, a suspended community and unknown names with one 404", async () => {
      await getPool().query(`UPDATE servers SET is_community = FALSE WHERE id = $1`, [serverId]);
      expect((await call("GET", "/api/public/live-preview/communities/sala-do-rafa")).status).toBe(404);
      const code = (await createInvite(serverId, ownerId, {})).code;
      expect((await call("GET", `/api/public/live-preview/invites/${code}`)).status).toBe(404);
      expect((await start(liveChannel)).status).toBe(404);

      await getPool().query(
        `UPDATE servers SET is_community = TRUE, is_community_suspended = TRUE WHERE id = $1`,
        [serverId],
      );
      expect((await call("GET", "/api/public/live-preview/communities/sala-do-rafa")).status).toBe(404);
      expect((await start(liveChannel)).status).toBe(404);
      expect((await call("GET", "/api/public/live-preview/communities/nao-existe")).status).toBe(404);
      expect(livePreviewMetrics().refused).toMatchObject({ "not-community": 1, suspended: 1 });
    });

    it("refuses a private channel, an @everyone-denied channel, a voice channel and an idle one", async () => {
      for (const id of [privateChannel, deniedChannel, voiceChannel, idleChannel]) {
        expect((await start(id)).status).toBe(404);
      }
      expect(livePreviewMetrics().refused).toMatchObject({
        "private-channel": 2,
        "not-watch-party": 1,
        "not-live": 1,
      });
    });

    it("needs the age declaration before anything plays", async () => {
      const res = await call("POST", "/api/public/live-preview/start", {
        body: { channelId: liveChannel },
      });
      expect(res.status).toBe(400);
      const refused = await call("POST", "/api/public/live-preview/start", {
        body: { channelId: liveChannel, ageConfirmed: false },
      });
      expect(refused.status).toBe(400);
    });

    it("mints a token that dies with the window, through the edge, with no party pass", async () => {
      process.env.LIVE_HLS_PLAYLIST_BASE_URL = EDGE;
      const before = Date.now();
      const res = await start(liveChannel);
      expect(res.status).toBe(200);
      expect(res.cache).toBe("no-store");
      const body = res.body as StartBody;
      expect(body.channel).toEqual({ id: liveChannel, name: "cinema" });
      expect(body.stream.hlsUrl.startsWith(`${EDGE}/api/voice/hls-playlist/${liveChannel}/`)).toBe(true);
      expect(body.stream.hlsUrl).not.toContain("pp=");
      expect(JSON.stringify(body)).not.toContain("presenter");
      expect(body.remainingMs).toBeLessThanOrEqual(300_000);
      expect(body.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
      expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
      const claims = decodeHlsViewerToken(tokenOf(body.stream.hlsUrl), Date.now(), {
        allowPreview: true,
      })!;
      expect(claims.purpose).toBe("preview");
      expect(claims.userId.startsWith("preview:")).toBe(true);
      expect(livePreviewMetrics().started).toBe(1);
    });

    it("a ticket inside its window re-mints with the SAME end, and past it is refused", async () => {
      const first = (await start(liveChannel)).body as StartBody;
      const again = await start(liveChannel, { ticket: first.ticket });
      expect(again.status).toBe(200);
      expect((again.body as StartBody).expiresAt).toBe(first.expiresAt);
      expect(livePreviewMetrics()).toMatchObject({ started: 1, resumed: 1 });

      process.env.LIVE_PREVIEW_SECONDS = "30";
      const spent = mintLivePreviewTicket({
        channelId: liveChannel,
        startedAt: Date.now() - 31_000,
        visitorId: "visitor-a",
      })!;
      const ended = await start(liveChannel, { ticket: spent });
      expect(ended.status).toBe(403);
      expect(ended.body).toEqual({ error: "preview_ended" });
      expect(livePreviewMetrics().ended).toBe(1);

      // A ticket for another channel is not a ticket for this one: a new
      // window, per channel, as specified.
      const elsewhere = mintLivePreviewTicket({
        channelId: otherLiveChannel,
        startedAt: Date.now() - 31_000,
        visitorId: "visitor-a",
      })!;
      expect((await start(liveChannel, { ticket: elsewhere })).status).toBe(200);
    });

    it("the token plays the playlist with no header and beside a dead Bearer, uncounted", async () => {
      // A ladder session, so the session URL renders a master playlist.
      await goLive(liveChannel, "720p30");
      process.env.LIVE_HLS_PLAYLIST_BASE_URL = EDGE;
      const body = (await start(liveChannel)).body as StartBody;
      const path = pathOf(body.stream.hlsUrl);
      const bare = await call("GET", path);
      expect(bare.status).toBe(200);
      expect(bare.text).toContain("#EXTM3U");
      expect(bare.text).not.toContain("pp=");
      const dead = await call("GET", path, { headers: { Authorization: "Bearer expired.jwt" } });
      expect(dead.status).toBe(200);
      expect(viewerNotes.calls).toBe(0);
      expect(livePreviewMetrics().playlistServed).toBe(2);
    });

    it("an expired preview token is refused", async () => {
      const token = mintHlsPreviewToken({
        visitorId: "late",
        channelId: liveChannel,
        startedAt: STARTED_AT,
        expiresAt: Date.now() - 1_000,
        now: Date.now() - 60_000,
      })!;
      const res = await call(
        "GET",
        `/api/voice/hls-playlist/${liveChannel}/${STARTED_AT}?t=${token}`,
      );
      expect(res.status).toBe(401);
    });

    it("a rendition never gets a preview-only refusal, so a shared edge fetch cannot pass one to members", async () => {
      // The edge Worker coalesces rendition polls into one origin fetch that
      // carries whichever viewer's token missed its cache, and hands the
      // answer to everybody waiting. A 404 or 429 meant for a preview viewer
      // must therefore never come out of a rendition request.
      await goLive(liveChannel, "720p30");
      const body = (await start(liveChannel)).body as StartBody;
      const token = tokenOf(body.stream.hlsUrl);
      const rendition = `/api/voice/hls-playlist/${liveChannel}/${STARTED_AT}/720p30?t=${token}`;
      expect((await call("GET", rendition)).status).toBe(200);
      process.env.LIVE_PREVIEW = "false";
      expect((await call("GET", rendition)).status).toBe(200);
      // The session URL, fetched once per player, is where it is refused.
      expect((await call("GET", pathOf(body.stream.hlsUrl))).status).toBe(404);
    });

    it("refuses new players the moment the flag goes off or the channel goes private", async () => {
      const body = (await start(liveChannel)).body as StartBody;
      const path = pathOf(body.stream.hlsUrl);
      expect((await call("GET", path)).status).toBe(200);
      process.env.LIVE_PREVIEW = "false";
      expect((await call("GET", path)).status).toBe(404);
      process.env.LIVE_PREVIEW = "true";
      expect((await call("GET", path)).status).toBe(200);
      await getPool().query(`UPDATE channels SET is_private = TRUE WHERE id = $1`, [liveChannel]);
      resetLivePreviewForTests(); // drop the 15 s facts cache
      expect((await call("GET", path)).status).toBe(404);
      expect(livePreviewMetrics().playlistRefused).toMatchObject({ "private-channel": 1 });
    });

    it("opens no other door: the replay proxy refuses a preview token", async () => {
      const body = (await start(liveChannel)).body as StartBody;
      const token = tokenOf(body.stream.hlsUrl);
      const replay = await call(
        "GET",
        `/api/voice/hls-replay/${liveChannel}/${STARTED_AT}?t=${token}`,
      );
      expect([401, 404]).toContain(replay.status);
    });

    it("a garbage Bearer on the start route changes nothing", async () => {
      const res = await start(liveChannel, {}, { Authorization: "Bearer garbage" });
      expect(res.status).toBe(200);
    });

    it("a new window costs from an address bucket that runs out; a resume does not", async () => {
      const first = (await start(liveChannel)).body as StartBody;
      for (let i = 1; i < 20; i += 1) {
        expect((await start(liveChannel)).status).toBe(200);
      }
      expect((await start(liveChannel)).status).toBe(429);
      expect((await start(liveChannel, { ticket: first.ticket })).status).toBe(200);
    });
  });

  // -------------------------------------------------------- per server

  describe("as a per-server override", () => {
    beforeEach(async () => {
      await flags.startFeatureFlags();
    });

    it("global off, this community on: only this community previews", async () => {
      await flags.setServerFlagOverride("live_preview", serverId, true, { kind: "dashboard" });
      expect((await start(liveChannel)).status).toBe(200);
      expect((await start(otherLiveChannel)).status).toBe(404);
      expect((await call("GET", "/api/public/live-preview/communities/outra-sala")).status).toBe(404);
    });

    it("global on, this community off: refused here, served elsewhere", async () => {
      process.env.LIVE_PREVIEW = "true";
      await flags.setServerFlagOverride("live_preview", serverId, false, { kind: "dashboard" });
      expect((await start(liveChannel)).status).toBe(404);
      expect((await start(otherLiveChannel)).status).toBe(200);
    });
  });
});
