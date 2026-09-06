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
const { pinVoiceRoom } = await import("../voice/registry.js");

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
