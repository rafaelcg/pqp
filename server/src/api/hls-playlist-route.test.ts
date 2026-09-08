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
 * `GET /api/voice/hls-playlist/:channelId/:startedAt` through `handleApi`:
 * the Bearer path is unchanged, and a request with NO Authorization header
 * is let through only when `?t=` verifies for that exact channel and
 * session (Safari's native player and iOS cannot send a header). Both paths
 * end in the same channel-access check, so a token minted for someone who
 * is not in the server is still a 403, not a way around membership.
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
const { mintHlsViewerToken } = await import("../voice/hls-viewer-token.js");

const STARTED_AT = 1_700_000_000_000;
const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  `${STARTED_AT}_00000.ts`,
].join("\n");

let server: Server;
let baseUrl: string;

async function get(
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

describeDb("hls playlist route", () => {
  let owner: { id: string; clerk_id: string };
  let stranger: { id: string; clerk_id: string };
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
    process.env.LIVE_HLS_PUBLIC_BASE_URL = "https://live.example.test";
    process.env.LIVE_HLS_S3_BUCKET = "pqp-live-test";
    process.env.LIVE_HLS_S3_ACCESS_KEY_ID = "ak";
    process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY = "sk";
    process.env.LIVE_HLS_S3_ENDPOINT = "https://s3.example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://live.example.test/")) {
          return new Response(PLAYLIST_BODY, { status: 200 });
        }
        return realFetch(input, init);
      }),
    );
    await getPool().query(
      `TRUNCATE users, user_preferences, servers, channels, messages,
                server_members, channel_members, server_invites, server_bans,
                channel_reads, message_mentions, message_reactions,
                message_attachments, user_blocks, dm_pairs, link_embeds,
                hls_sessions
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    stranger = await upsertUser({
      clerkId: "clerk_stranger",
      displayName: "Stranger",
      avatarUrl: null,
    });
    actor = owner;
    const created = await realFetch(`${baseUrl}/api/servers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({ name: "Stream" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      channels: { id: string; type: string }[];
    };
    const voice = body.channels.filter((c) => c.type === "voice");
    channelId = voice[0]!.id;
    otherChannelId =
      voice[1]?.id ?? body.channels.find((c) => c.id !== channelId)!.id;
    for (const id of [channelId, otherChannelId]) {
      await getPool().query(
        `INSERT INTO hls_sessions (channel_id, object_prefix, started_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
        [id, `live/${id}/${STARTED_AT}`, STARTED_AT],
      );
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LIVE_HLS_PUBLIC_BASE_URL;
    delete process.env.LIVE_HLS_S3_BUCKET;
    delete process.env.LIVE_HLS_S3_ACCESS_KEY_ID;
    delete process.env.LIVE_HLS_S3_SECRET_ACCESS_KEY;
    delete process.env.LIVE_HLS_S3_ENDPOINT;
  });

  const realFetch = globalThis.fetch;

  function path(id: string, startedAt = STARTED_AT) {
    return `/api/voice/hls-playlist/${id}/${startedAt}`;
  }

  it("Bearer without a token still works", async () => {
    const r = await get(path(channelId), owner);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/vnd.apple.mpegurl");
    expect(r.text).toContain("https://live.example.test/");
  });

  it("no header and no token is 401", async () => {
    expect((await get(path(channelId), null)).status).toBe(401);
  });

  it("a valid token with no header is allowed", async () => {
    const t = mintHlsViewerToken({
      userId: owner.id,
      channelId,
      startedAt: STARTED_AT,
    });
    const r = await get(`${path(channelId)}?t=${t}`, null);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/vnd.apple.mpegurl");
    expect(r.text.split("\n")[3]).toMatch(/^https:\/\/live\.example\.test\//);
  });

  it("a token for another channel or another session is 401", async () => {
    const t = mintHlsViewerToken({
      userId: owner.id,
      channelId,
      startedAt: STARTED_AT,
    });
    expect((await get(`${path(otherChannelId)}?t=${t}`, null)).status).toBe(
      401,
    );
    expect(
      (await get(`${path(channelId, STARTED_AT + 1)}?t=${t}`, null)).status,
    ).toBe(401);
    expect((await get(`${path(channelId)}?t=${t}x`, null)).status).toBe(401);
  });

  it("a token still runs the channel-access check", async () => {
    const t = mintHlsViewerToken({
      userId: stranger.id,
      channelId,
      startedAt: STARTED_AT,
    });
    const r = await get(`${path(channelId)}?t=${t}`, null);
    expect([403, 404]).toContain(r.status);
  });
});
