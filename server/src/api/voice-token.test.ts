import { randomUUID } from "node:crypto";
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
 * `POST /api/voice/token` on an instance whose peer map is empty.
 *
 * HTTP is balanced per request, so with two API machines the mint lands on
 * the one that never saw the join about half the time. Before this, that was
 * a 403 for a perfectly good peer. The resume HMAC `welcome` hands out binds
 * user, peer and channel already, so it is the proof that works from
 * anywhere; the peer map and the registry row remain as the fallbacks for
 * clients that do not send it.
 *
 * Real routes, real SQL. Only the identity layer is faked; the LiveKit token
 * is minted with the real `AccessToken` against a dummy key.
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
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { resetVoicePeers, resetVoiceRoomTransports } = await import(
  "../ws/voice.js"
);
const { mintVoiceResumeToken } = await import("../ws/voice-resume-token.js");
const { claimVoiceRoomTransport, pinVoiceRoom } = await import(
  "../voice/registry.js"
);

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
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
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const previousFlag = process.env.VOICE_REGISTRY;

describeDb("POST /api/voice/token with an empty peer map", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let other: { id: string; clerk_id: string };
  let voiceChannelId: string;

  beforeAll(async () => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";

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
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });

  beforeEach(async () => {
    delete process.env.VOICE_REGISTRY;
    resetApiRateLimits();
    resetVoicePeers();
    resetVoiceRoomTransports();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members,
                voice_rooms, voice_peers
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_token_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_token_member",
      displayName: "Member",
      avatarUrl: null,
    });
    other = await upsertUser({
      clerkId: "clerk_token_other",
      displayName: "Other",
      avatarUrl: null,
    });

    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Token test" });
    expect(created.status).toBe(201);
    for (const user of [member, other]) {
      await getPool().query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [created.body.server.id, user.id],
      );
    }
    voiceChannelId = created.body.channels.find((c) => c.type === "voice")!.id;
    await getPool().query(
      `UPDATE channels SET voice_transport = 'livekit' WHERE id = $1`,
      [voiceChannelId],
    );
  });

  afterEach(() => {
    process.env.VOICE_REGISTRY = previousFlag;
    vi.restoreAllMocks();
  });

  function tokenFor(userId: string, peerId: string, channel = voiceChannelId) {
    return mintVoiceResumeToken({
      userId,
      peerId,
      voiceChannelId: channel,
      transport: "livekit",
    })!;
  }

  it("mints against a valid resume HMAC with no peer anywhere", async () => {
    const peerId = randomUUID();
    const minted = await call<{ identity: string; room: string }>(
      member,
      "POST",
      "/api/voice/token",
      { voiceChannelId, peerId, resumeToken: tokenFor(member.id, peerId) },
    );

    expect(minted.status).toBe(200);
    expect(minted.body.identity).toBe(peerId);
    expect(minted.body.room).toBe(voiceChannelId);
  });

  it("still 403s without the field, as it always did", async () => {
    const refused = await call(member, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId: randomUUID(),
    });
    expect(refused.status).toBe(403);
  });

  it("refuses somebody else's token, and a token for another channel", async () => {
    const peerId = randomUUID();
    const stolen = await call(other, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
      resumeToken: tokenFor(member.id, peerId),
    });
    expect(stolen.status).toBe(403);

    const elsewhere = await call(member, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
      resumeToken: tokenFor(member.id, peerId, randomUUID()),
    });
    expect(elsewhere.status).toBe(403);
  });

  it("falls back to the registry row when the flag is on", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    const peerId = randomUUID();
    await pinVoiceRoom(voiceChannelId, "livekit");
    await getPool().query(
      `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
       VALUES ($1, $2, $3, $4, 'Member')`,
      [peerId, voiceChannelId, member.id, randomUUID()],
    );

    const minted = await call<{ identity: string }>(
      member,
      "POST",
      "/api/voice/token",
      { voiceChannelId, peerId },
    );
    expect(minted.status).toBe(200);
    expect(minted.body.identity).toBe(peerId);

    // The row proves ownership, not merely existence.
    const stolen = await call(other, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
    });
    expect(stolen.status).toBe(403);
  });

  describe("SFU regions", () => {
    function jwtIssuer(token: string): string {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
      ) as { iss: string };
      return payload.iss;
    }

    beforeEach(() => {
      process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.example.test";
      process.env.LIVEKIT_API_KEY_MIA = "mia-key";
      process.env.LIVEKIT_API_SECRET_MIA = "mia-secret";
    });

    afterEach(() => {
      delete process.env.LIVEKIT_REGIONS;
      delete process.env.LIVEKIT_API_KEY_MIA;
      delete process.env.LIVEKIT_API_SECRET_MIA;
    });

    async function seatElsewhere(region: string | null): Promise<string> {
      process.env.VOICE_REGISTRY = "postgres";
      const peerId = randomUUID();
      await claimVoiceRoomTransport(voiceChannelId, "livekit", region);
      await getPool().query(
        `INSERT INTO voice_peers (peer_id, channel_id, user_id, instance_id, display_name)
         VALUES ($1, $2, $3, $4, 'Member')`,
        [peerId, voiceChannelId, member.id, randomUUID()],
      );
      return peerId;
    }

    it("mints for the box the room row names, with that box's key pair (the other replica)", async () => {
      const peerId = await seatElsewhere("mia");
      const minted = await call<{ url: string; token: string; region: string }>(
        member,
        "POST",
        "/api/voice/token",
        { voiceChannelId, peerId },
      );
      expect(minted.status).toBe(200);
      expect(minted.body.url).toBe("wss://sfu-mia.example.test");
      expect(minted.body.region).toBe("mia");
      expect(jwtIssuer(minted.body.token)).toBe("mia-key");
    });

    it("a room row with no region is home", async () => {
      const peerId = await seatElsewhere(null);
      const minted = await call<{ url: string; token: string; region: string }>(
        member,
        "POST",
        "/api/voice/token",
        { voiceChannelId, peerId },
      );
      expect(minted.status).toBe(200);
      expect(minted.body.url).toBe("wss://sfu.example.test");
      expect(minted.body.region).toBe("sao");
      expect(jwtIssuer(minted.body.token)).toBe("key");
    });

    it("falls back to the region the caller's resume token remembers, registry off", async () => {
      const peerId = randomUUID();
      const minted = await call<{ url: string; region: string }>(
        member,
        "POST",
        "/api/voice/token",
        {
          voiceChannelId,
          peerId,
          resumeToken: mintVoiceResumeToken({
            userId: member.id,
            peerId,
            voiceChannelId,
            transport: "livekit",
            region: "mia",
          })!,
        },
      );
      expect(minted.status).toBe(200);
      expect(minted.body.url).toBe("wss://sfu-mia.example.test");
      expect(minted.body.region).toBe("mia");
    });
  });

  it("adds no region field without LIVEKIT_REGIONS, and names the one box", async () => {
    const peerId = randomUUID();
    const minted = await call<Record<string, unknown>>(
      member,
      "POST",
      "/api/voice/token",
      { voiceChannelId, peerId, resumeToken: tokenFor(member.id, peerId) },
    );
    expect(minted.status).toBe(200);
    expect(minted.body.url).toBe("wss://sfu.example.test");
    expect(minted.body).not.toHaveProperty("region");
  });

  it("answers 409 for a room another instance pinned to mesh", async () => {
    process.env.VOICE_REGISTRY = "postgres";
    const peerId = randomUUID();
    await pinVoiceRoom(voiceChannelId, "mesh");

    const refused = await call(member, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
      resumeToken: tokenFor(member.id, peerId),
    });
    expect(refused.status).toBe(409);
  });
});

/**
 * FAIL CLOSED, EXPLICITLY. On a watch-party channel `resolveVoicePublish`
 * reads the watch-party seat cache for `canShowFace` (whether this caller is
 * an accepted guest) whenever they do not already carry STREAM outright. A
 * database hiccup on that one lookup used to propagate uncaught out of this
 * route and land wherever `handleApi`'s generic catch happened to put it --
 * correct in that no token was minted either way, but a plain "Internal
 * server error" 500 tells the caller nothing about whether trying again is
 * the right move. This pins the explicit local catch: every failure of this
 * specific, security-sensitive resolution is a clean, retryable 503, and
 * nothing downstream of it ever runs.
 */
describeDb("POST /api/voice/token on a watch-party channel, seat lookup fails", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let watchPartyChannelId: string;

  beforeAll(async () => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";

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
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });

  beforeEach(async () => {
    delete process.env.VOICE_REGISTRY;
    resetApiRateLimits();
    resetVoicePeers();
    resetVoiceRoomTransports();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members,
                voice_rooms, voice_peers, channel_sessions
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_seatfail_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_seatfail_member",
      displayName: "Member",
      avatarUrl: null,
    });

    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Seat lookup test" });
    expect(created.status).toBe(201);
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [created.body.server.id, member.id],
    );
    // A plain member on a `watch_party` channel: no STREAM, so
    // `resolveVoicePublish` takes the `canShowFace` branch and reads the
    // watch-party seat cache -- the exact path this describe block is about.
    watchPartyChannelId = created.body.channels.find(
      (c) => c.type === "voice",
    )!.id;
    await getPool().query(
      `UPDATE channels SET type = 'watch_party', voice_transport = 'livekit' WHERE id = $1`,
      [watchPartyChannelId],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tokenFor(userId: string, peerId: string) {
    return mintVoiceResumeToken({
      userId,
      peerId,
      voiceChannelId: watchPartyChannelId,
      transport: "livekit",
    })!;
  }

  it("returns a clean, retryable 503 and mints no token when the seat lookup query fails", async () => {
    const pool = getPool();
    const realQuery = pool.query.bind(pool) as typeof pool.query;
    const querySpy = vi
      .spyOn(pool, "query")
      .mockImplementation(((...args: Parameters<typeof pool.query>) => {
        const text = args[0];
        // The watch-party seat snapshot query, and only that one: every
        // other query on this request (auth, permissions, the peer proof)
        // must keep working normally, or this would not isolate the one
        // failure it claims to.
        if (typeof text === "string" && text.includes("accepted_guest_ids")) {
          return Promise.reject(new Error("simulated seat-cache failure"));
        }
        return realQuery(...args);
      }) as typeof pool.query);

    try {
      const peerId = randomUUID();
      const minted = await call<{ identity?: string }>(
        member,
        "POST",
        "/api/voice/token",
        {
          voiceChannelId: watchPartyChannelId,
          peerId,
          resumeToken: tokenFor(member.id, peerId),
        },
      );
      expect(minted.status).toBe(503);
      expect(minted.body.identity).toBeUndefined();
    } finally {
      querySpy.mockRestore();
    }
  });

  it("mints normally once the seat lookup succeeds -- proves the 503 above was the simulated failure, not a broken setup", async () => {
    const peerId = randomUUID();
    const minted = await call<{ identity: string }>(
      member,
      "POST",
      "/api/voice/token",
      {
        voiceChannelId: watchPartyChannelId,
        peerId,
        resumeToken: tokenFor(member.id, peerId),
      },
    );
    expect(minted.status).toBe(200);
    expect(minted.body.identity).toBe(peerId);
  });
});
